import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Actor } from '../auth/actor';
import { ContractsService } from '../contracts/contracts.service';
import type { Camera, Prisma } from '../generated/prisma/client';
import type { SourceType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { type CameraView, toCameraView } from './camera-view';
import { ConfigNotifier } from './config-notifier';
import type { CreateCameraDto } from './dto/create-camera.dto';
import type { UpdateCameraDto } from './dto/update-camera.dto';
import { UrlCipher } from './url-cipher';

const RTSP_URL = /^rtsps?:\/\//;
const MANAGER_FIELDS = new Set(['name', 'area', 'enabled']);
const REDACTED = '[redacted]';

const code = (err: unknown) => (err as { code?: string }).code;

/** Audit snapshot: the SUPERADMIN view with both stream URLs redacted (never decrypted). */
export function auditView(
  camera: Camera,
  cipher: UrlCipher,
): Record<string, unknown> {
  return {
    ...toCameraView(camera, 'MANAGER', cipher),
    mainStreamUrl: REDACTED,
    subStreamUrl: REDACTED,
  };
}

export type CameraUpdate = {
  before: Camera;
  after: Camera;
  streamUrlsChanged: boolean;
  view: CameraView;
};

@Injectable()
export class CamerasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: ContractsService,
    private readonly notifier: ConfigNotifier,
    readonly cipher: UrlCipher,
  ) {}

  async list(actor: Actor): Promise<CameraView[]> {
    const cameras = await this.prisma.camera.findMany({
      orderBy: { id: 'asc' },
    });
    return cameras.map((c) => toCameraView(c, actor.role, this.cipher));
  }

  async get(actor: Actor, id: string): Promise<CameraView> {
    return toCameraView(await this.find(id), actor.role, this.cipher);
  }

  async find(id: string): Promise<Camera> {
    const camera = await this.prisma.camera.findUnique({ where: { id } });
    if (!camera) throw new NotFoundException('Camera not found');
    return camera;
  }

  async create(
    actor: Actor,
    dto: CreateCameraDto,
  ): Promise<{ camera: Camera; view: CameraView }> {
    const { validator, registry } = this.contracts;
    if (!validator.assignableUseCases().includes(dto.useCase)) {
      throw new BadRequestException('Unknown or unassignable use case');
    }
    this.checkStreamUrl(dto.sourceType, dto.mainStreamUrl);
    const result = validator.validateSettings(dto.useCase, dto.settings);
    if (!result.ok) {
      throw new BadRequestException({
        message: 'Settings are invalid',
        errors: result.errors,
      });
    }
    const schemaVersion = registry.useCases.get(dto.useCase)?.schemaVersion;
    if (schemaVersion === undefined) {
      throw new BadRequestException('Unknown or unassignable use case');
    }

    let camera: Camera;
    try {
      camera = await this.prisma.camera.create({
        data: {
          id: dto.id,
          name: dto.name,
          area: dto.area ?? null,
          useCase: dto.useCase,
          enabled: dto.enabled ?? true,
          sourceType: dto.sourceType,
          mainStreamUrlEnc: this.cipher.encrypt(dto.mainStreamUrl),
          subStreamUrlEnc: dto.subStreamUrl
            ? this.cipher.encrypt(dto.subStreamUrl)
            : null,
          recordingPath: dto.recordingPath ?? null,
          ...(dto.targetFps !== undefined && { targetFps: dto.targetFps }),
          ...(dto.engineGroup !== undefined && {
            engineGroup: dto.engineGroup,
          }),
          ...(dto.auditCamera !== undefined && {
            auditCamera: dto.auditCamera,
          }),
          ...(dto.recording?.enabled !== undefined && {
            recordingEnabled: dto.recording.enabled,
          }),
          ...(dto.recording?.stream !== undefined && {
            recordingStream: dto.recording.stream,
          }),
          retentionDays: dto.recording?.retentionDays ?? null,
          ...(dto.recording?.clipBeforeSec !== undefined && {
            clipBeforeSec: dto.recording.clipBeforeSec,
          }),
          ...(dto.recording?.clipAfterSec !== undefined && {
            clipAfterSec: dto.recording.clipAfterSec,
          }),
          nxCameraId: dto.nxCameraId ?? null,
          activeVersion: 1,
          versions: {
            create: {
              version: 1,
              useCase: dto.useCase,
              settings: dto.settings as Prisma.InputJsonObject,
              schemaVersion,
              authorType: actor.type,
              authorId: actor.id,
              authorName: actor.name,
              note: dto.note ?? null,
            },
          },
        },
      });
    } catch (err) {
      if (code(err) === 'P2002') {
        throw new ConflictException('Camera id already exists');
      }
      throw err;
    }
    await this.notifier.notify(camera.id, 1);
    return { camera, view: toCameraView(camera, actor.role, this.cipher) };
  }

  async update(
    actor: Actor,
    id: string,
    dto: UpdateCameraDto,
  ): Promise<CameraUpdate> {
    const before = await this.find(id);
    const data: Prisma.CameraUpdateInput = {};
    const changed: string[] = [];
    let streamUrlsChanged = false;

    const set = <K extends keyof Prisma.CameraUpdateInput>(
      field: string,
      key: K,
      next: Prisma.CameraUpdateInput[K],
      current: unknown,
    ) => {
      if (next === current) return;
      data[key] = next;
      changed.push(field);
    };

    if (dto.name !== undefined) set('name', 'name', dto.name, before.name);
    if (dto.area !== undefined) set('area', 'area', dto.area, before.area);
    if (dto.enabled !== undefined) {
      set('enabled', 'enabled', dto.enabled, before.enabled);
    }
    if (dto.sourceType !== undefined) {
      set('sourceType', 'sourceType', dto.sourceType, before.sourceType);
    }
    if (dto.recordingPath !== undefined) {
      set(
        'recordingPath',
        'recordingPath',
        dto.recordingPath,
        before.recordingPath,
      );
    }
    if (dto.targetFps !== undefined) {
      set('targetFps', 'targetFps', dto.targetFps, before.targetFps);
    }
    if (dto.engineGroup !== undefined) {
      set('engineGroup', 'engineGroup', dto.engineGroup, before.engineGroup);
    }
    if (dto.auditCamera !== undefined) {
      set('auditCamera', 'auditCamera', dto.auditCamera, before.auditCamera);
    }
    if (dto.nxCameraId !== undefined) {
      set('nxCameraId', 'nxCameraId', dto.nxCameraId, before.nxCameraId);
    }
    const rec = dto.recording;
    if (rec) {
      if (rec.enabled !== undefined) {
        set(
          'recording.enabled',
          'recordingEnabled',
          rec.enabled,
          before.recordingEnabled,
        );
      }
      if (rec.stream !== undefined) {
        set(
          'recording.stream',
          'recordingStream',
          rec.stream,
          before.recordingStream,
        );
      }
      if (rec.retentionDays !== undefined) {
        set(
          'recording.retentionDays',
          'retentionDays',
          rec.retentionDays,
          before.retentionDays,
        );
      }
      if (rec.clipBeforeSec !== undefined) {
        set(
          'recording.clipBeforeSec',
          'clipBeforeSec',
          rec.clipBeforeSec,
          before.clipBeforeSec,
        );
      }
      if (rec.clipAfterSec !== undefined) {
        set(
          'recording.clipAfterSec',
          'clipAfterSec',
          rec.clipAfterSec,
          before.clipAfterSec,
        );
      }
    }

    // A non-superadmin sending a URL (any value, null too) is refused without decrypting or
    // comparing: a 200/403 split on equality would confirm guesses of the stored credentials.
    if (actor.role !== 'SUPERADMIN') {
      const urlFields = (['mainStreamUrl', 'subStreamUrl'] as const).filter(
        (f) => dto[f] !== undefined,
      );
      if (urlFields.length > 0) {
        throw new ForbiddenException({
          message: 'Changing these fields needs the SUPERADMIN role',
          fields: [
            ...changed.filter((f) => !MANAGER_FIELDS.has(f)),
            ...urlFields,
          ],
        });
      }
    }

    // URLs: compare decrypted, store a new ciphertext only on a real change.
    const nextMain = dto.mainStreamUrl;
    const mainChanged =
      nextMain !== undefined &&
      nextMain !== this.cipher.decrypt(before.mainStreamUrlEnc);
    if (mainChanged) {
      data.mainStreamUrlEnc = this.cipher.encrypt(nextMain);
      changed.push('mainStreamUrl');
    }
    const nextSub = dto.subStreamUrl;
    const subChanged =
      nextSub !== undefined &&
      nextSub !==
        (before.subStreamUrlEnc
          ? this.cipher.decrypt(before.subStreamUrlEnc)
          : null);
    if (subChanged) {
      data.subStreamUrlEnc = nextSub ? this.cipher.encrypt(nextSub) : null;
      changed.push('subStreamUrl');
    }
    streamUrlsChanged = mainChanged || subChanged;

    const restricted = changed.filter((f) => !MANAGER_FIELDS.has(f));
    if (restricted.length > 0 && actor.role !== 'SUPERADMIN') {
      throw new ForbiddenException({
        message: 'Changing these fields needs the SUPERADMIN role',
        fields: restricted,
      });
    }

    // The scheme check needs the plaintext URL only when the URL or the source type changes.
    const sourceType = data.sourceType
      ? (data.sourceType as SourceType)
      : before.sourceType;
    if (mainChanged || data.sourceType) {
      this.checkStreamUrl(
        sourceType,
        mainChanged ? nextMain : this.cipher.decrypt(before.mainStreamUrlEnc),
      );
    }

    const after =
      changed.length > 0
        ? await this.prisma.camera.update({ where: { id }, data })
        : before;
    await this.notifier.notify(id, after.activeVersion);
    return {
      before,
      after,
      streamUrlsChanged,
      view: toCameraView(after, actor.role, this.cipher),
    };
  }

  async remove(id: string): Promise<Camera> {
    const camera = await this.find(id);
    const [events, intervals, metrics] = await Promise.all([
      this.prisma.event.count({ where: { cameraId: id } }),
      this.prisma.interval.count({ where: { cameraId: id } }),
      this.prisma.metric.count({ where: { cameraId: id } }),
    ]);
    if (events + intervals + metrics > 0) {
      throw new ConflictException(
        'Camera has analytics data; disable it instead',
      );
    }
    try {
      await this.prisma.camera.delete({ where: { id } });
    } catch (err) {
      if (code(err) === 'P2003') {
        throw new ConflictException(
          'Camera has analytics data; disable it instead',
        );
      }
      if (code(err) === 'P2025')
        throw new NotFoundException('Camera not found');
      throw err;
    }
    await this.notifier.notify(id, null);
    return camera;
  }

  /** Never echoes the URL: it may carry credentials. */
  private checkStreamUrl(sourceType: SourceType, url: string): void {
    if (sourceType !== 'FILE' && !RTSP_URL.test(url)) {
      throw new BadRequestException(
        'mainStreamUrl must start with rtsp:// or rtsps:// unless sourceType is FILE',
      );
    }
  }
}
