import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type Actor, roleAtLeast } from '../auth/actor';
import { apiError, needsSuperadmin } from '../common/errors';
import { ContractsService } from '../contracts/contracts.service';
import type { CameraConfigVersion, Prisma } from '../generated/prisma/client';
import { ModelsService } from '../models/models.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigNotifier } from './config-notifier';
import { diffJson, type JsonChange } from './json-diff';
import { restrictedChanges } from './restricted-changes';

export type ConfigSnapshot = {
  version: number;
  useCase: string;
  settings: unknown;
};

export type SaveResult = {
  version: number;
  before: ConfigSnapshot;
  after: ConfigSnapshot;
  /** The camera has `auditCamera` set: the change is an audit-camera change. */
  auditCamera: boolean;
};

type SaveInput = {
  baseVersion: number;
  useCase?: string;
  settings: Record<string, unknown>;
  note?: string;
};

/** A version without settings; the author id is never exposed. */
const summary = (v: CameraConfigVersion) => ({
  version: v.version,
  useCase: v.useCase,
  schemaVersion: v.schemaVersion,
  note: v.note,
  createdAt: v.createdAt,
  author: { type: v.authorType, name: v.authorName },
});

const full = (v: CameraConfigVersion) => ({
  ...summary(v),
  settings: v.settings,
});

const byPath = (a: JsonChange, b: JsonChange) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

@Injectable()
export class ConfigVersionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: ContractsService,
    private readonly notifier: ConfigNotifier,
    private readonly models: ModelsService,
  ) {}

  async active(cameraId: string) {
    const camera = await this.camera(cameraId);
    const version = await this.prisma.cameraConfigVersion.findUnique({
      where: {
        cameraId_version: { cameraId, version: camera.activeVersion },
      },
    });
    if (!version) throw new NotFoundException('Config version not found');
    return full(version);
  }

  async list(cameraId: string) {
    await this.camera(cameraId);
    const rows = await this.prisma.cameraConfigVersion.findMany({
      where: { cameraId },
      orderBy: { version: 'desc' },
    });
    return rows.map(summary);
  }

  async get(cameraId: string, version: number) {
    await this.camera(cameraId);
    const [row, previous] = await Promise.all([
      this.prisma.cameraConfigVersion.findUnique({
        where: { cameraId_version: { cameraId, version } },
      }),
      this.prisma.cameraConfigVersion.findUnique({
        where: { cameraId_version: { cameraId, version: version - 1 } },
      }),
    ]);
    if (!row) throw new NotFoundException('Config version not found');
    const changes: JsonChange[] = [];
    if (previous) {
      changes.push(...diffJson(previous.settings, row.settings));
      if (previous.useCase !== row.useCase) {
        changes.push({
          path: '/useCase',
          before: previous.useCase,
          after: row.useCase,
        });
      }
      changes.sort(byPath);
    }
    return { ...full(row), changes };
  }

  async save(
    actor: Actor,
    cameraId: string,
    input: SaveInput,
  ): Promise<SaveResult> {
    const { validator, registry } = this.contracts;
    let result: SaveResult;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const camera = await tx.camera.findUnique({ where: { id: cameraId } });
        if (!camera) throw new NotFoundException('Camera not found');
        if (input.baseVersion !== camera.activeVersion) {
          throw apiError(
            409,
            'STALE_VERSION',
            `The config is at version ${camera.activeVersion}; reload and retry`,
          );
        }
        const current = await tx.cameraConfigVersion.findUnique({
          where: {
            cameraId_version: { cameraId, version: camera.activeVersion },
          },
        });
        const useCase = input.useCase ?? camera.useCase;
        const useCaseChanged = useCase !== camera.useCase;
        if (useCaseChanged && !roleAtLeast(actor.role, 'SUPERADMIN')) {
          throw needsSuperadmin('Only a superadmin can change the use case', [
            '/useCase',
          ]);
        }
        const contract = registry.useCases.get(useCase);
        if (!validator.assignableUseCases().includes(useCase) || !contract) {
          throw new BadRequestException('Unknown or unassignable use case');
        }
        const valid = validator.validateSettings(useCase, input.settings);
        if (!valid.ok) {
          throw apiError(
            400,
            'SETTINGS_INVALID',
            'Settings are invalid',
            valid.errors,
          );
        }
        // Across use cases the restricted fields are not comparable; a superadmin made the switch.
        if (!useCaseChanged) {
          const restricted = restrictedChanges(
            validator,
            useCase,
            (current?.settings as object | null) ?? null,
            input.settings,
            actor.role,
          );
          if (restricted.length > 0) {
            throw needsSuperadmin(
              `Only a superadmin can change: ${restricted.join(', ')}`,
              restricted,
            );
          }
        }
        await this.models.assertSelectable(
          (input.settings as { model_id?: string }).model_id,
          (current?.settings as { model_id?: string } | null)?.model_id,
        );
        const version = camera.activeVersion + 1;
        await tx.cameraConfigVersion.create({
          data: {
            cameraId,
            version,
            useCase,
            settings: input.settings as Prisma.InputJsonObject,
            schemaVersion: contract.schemaVersion,
            authorType: actor.type,
            authorId: actor.id,
            authorName: actor.name,
            note: input.note ?? null,
          },
        });
        await tx.camera.update({
          where: { id: cameraId },
          data: { activeVersion: version, useCase },
        });
        return {
          version,
          before: {
            version: camera.activeVersion,
            useCase: camera.useCase,
            settings: current?.settings ?? null,
          },
          after: { version, useCase, settings: input.settings },
          auditCamera: camera.auditCamera,
        };
      });
    } catch (err) {
      // The primary key (cameraId, version) is the guard against a concurrent save.
      if ((err as { code?: string }).code === 'P2002') {
        throw apiError(
          409,
          'STALE_VERSION',
          'The config changed meanwhile; reload and retry',
        );
      }
      throw err;
    }
    await this.notifier.notify(cameraId, result.version);
    return result;
  }

  /** Saves an earlier version's use case and settings as a new version, through the same checks. */
  async rollback(
    actor: Actor,
    cameraId: string,
    input: { baseVersion: number; version: number },
  ): Promise<SaveResult> {
    await this.camera(cameraId);
    const target = await this.prisma.cameraConfigVersion.findUnique({
      where: { cameraId_version: { cameraId, version: input.version } },
    });
    if (!target) throw new NotFoundException('Config version not found');
    return this.save(actor, cameraId, {
      baseVersion: input.baseVersion,
      useCase: target.useCase,
      settings: target.settings as Record<string, unknown>,
      note: `rollback to v${target.version}`,
    });
  }

  private async camera(id: string) {
    const camera = await this.prisma.camera.findUnique({ where: { id } });
    if (!camera) throw new NotFoundException('Camera not found');
    return camera;
  }
}
