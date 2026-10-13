import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type Redis from 'ioredis';
import type { Actor } from '../auth/actor';
import { ENV, type Env } from '../config/env';
import { ContractsService } from '../contracts/contracts.service';
import type { AiModel } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.module';
import {
  type ModelExtension,
  modelExtension,
  registryPath,
  resolveInside,
  safeOriginalName,
  sha256File,
  type StoredUpload,
} from './model-files';
import {
  type ModelView,
  type RescanResult,
  toModelView,
  type UploadModelDto,
} from './dto/model.dto';

export const MODEL_JOBS_KEY = 'model:jobs';

const FORMAT = { onnx: 'ONNX', pt: 'PT', engine: 'ENGINE' } as const;
const code = (err: unknown) => (err as { code?: string }).code;

@Injectable()
export class ModelsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ModelsService.name);
  private rescanning: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly contracts: ContractsService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Creates the folders and rescans. Errors are logged, never fatal. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.rescan();
    } catch (err) {
      this.logger.warn(`Start-up rescan failed: ${(err as Error).message}`);
    }
  }

  async list(): Promise<ModelView[]> {
    const rows = await this.prisma.aiModel.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return rows.map(toModelView);
  }

  async getRow(id: string): Promise<AiModel> {
    const row = await this.prisma.aiModel.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Model not found');
    return row;
  }

  async get(id: string): Promise<ModelView> {
    return toModelView(await this.getRow(id));
  }

  /**
   * Registers an uploaded temp file (already hashed and checked by the storage engine): moves it to
   * `registry/<id>.onnx`, writes the row and queues the validation. On any failure the temp file
   * and the moved file are removed and no row is left.
   */
  async registerUpload(
    actor: Actor,
    file: Express.Multer.File & StoredUpload,
    dto: UploadModelDto,
  ): Promise<ModelView> {
    const id = randomUUID();
    const filePath = registryPath(id, 'onnx');
    const target = resolveInside(this.env.MODELS_DIR, filePath);
    const originalName = safeOriginalName(file.originalname);
    try {
      const duplicate = await this.prisma.aiModel.findUnique({
        where: { sha256: file.sha256 },
      });
      if (duplicate) throw this.sameFile(duplicate.name);
      await rename(file.path, target);
      try {
        await this.prisma.aiModel.create({
          data: {
            id,
            name: dto.name ?? originalName,
            version: dto.version ?? null,
            format: 'ONNX',
            source: 'UPLOAD',
            status: 'UPLOADED',
            filePath,
            originalName,
            sha256: file.sha256,
            sizeBytes: BigInt(file.size),
            createdById: actor.id,
            notes: dto.notes ?? null,
          },
        });
      } catch (err) {
        if (code(err) === 'P2002') {
          const other = await this.prisma.aiModel.findUnique({
            where: { sha256: file.sha256 },
          });
          if (other) throw this.sameFile(other.name);
        }
        throw err;
      }
    } catch (err) {
      await rm(file.path, { force: true }).catch(() => undefined);
      await rm(target, { force: true }).catch(() => undefined);
      throw err;
    }
    await this.tryEnqueue(id);
    return this.get(id);
  }

  /** Queues a validate job and then marks the model VALIDATING. Throws when Redis refuses. */
  async enqueueValidation(id: string): Promise<void> {
    const row = await this.getRow(id);
    await this.redis.lpush(
      MODEL_JOBS_KEY,
      JSON.stringify({ type: 'validate', modelId: id, path: row.filePath }),
    );
    await this.prisma.aiModel.update({
      where: { id },
      data: { status: 'VALIDATING' },
    });
  }

  /** The model stays UPLOADED when the job cannot be queued; the registry still has the file. */
  private async tryEnqueue(id: string): Promise<void> {
    try {
      await this.enqueueValidation(id);
    } catch (err) {
      this.logger.warn(
        `Validation of model ${id} not queued: ${(err as Error).message}`,
      );
    }
  }

  /** Runs one at a time, so two overlapping rescans cannot register the same file twice. */
  rescan(): Promise<RescanResult> {
    const run = this.rescanning.then(() => this.scan());
    this.rescanning = run.catch(() => undefined);
    return run;
  }

  private async scan(): Promise<RescanResult> {
    const root = this.env.MODELS_DIR;
    const added: AiModel[] = [];
    const skipped: RescanResult['skipped'] = [];

    const files = async (dir: string, prefix: string) => {
      const entries = await readdir(join(root, dir), { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, ext: modelExtension(e.name) }))
        .filter((e): e is { name: string; ext: ModelExtension } => !!e.ext)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => ({ ...e, rel: `${prefix}${e.name}` }));
    };

    const attempt = async (
      rel: string,
      fn: () => Promise<AiModel | string>,
    ) => {
      try {
        const result = await fn();
        if (typeof result === 'string')
          skipped.push({ file: rel, reason: result });
        else added.push(result);
      } catch (err) {
        this.logger.warn(`Rescan skipped ${rel}: ${(err as Error).message}`);
        skipped.push({ file: rel, reason: `error: ${(err as Error).message}` });
      }
    };

    await mkdir(join(root, 'inbox'), { recursive: true });
    await mkdir(join(root, 'registry'), { recursive: true });

    for (const f of await files('inbox', 'inbox/')) {
      await attempt(f.rel, () => this.adoptInboxFile(f.name, f.ext));
    }

    const known = new Set(
      (await this.prisma.aiModel.findMany({ select: { filePath: true } })).map(
        (m) => m.filePath,
      ),
    );
    for (const f of await files('.', '')) {
      if (known.has(f.name)) continue;
      await attempt(f.rel, () => this.adoptBuiltin(f.name, f.ext));
    }

    for (const m of added) await this.tryEnqueue(m.id);
    const fresh = await this.prisma.aiModel.findMany({
      where: { id: { in: added.map((m) => m.id) } },
    });
    const order = new Map(added.map((m, i) => [m.id, i]));
    fresh.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    return { added: fresh.map(toModelView), skipped };
  }

  /** Moves `inbox/<name>` into the registry. Returns the skip reason for a known file. */
  private async adoptInboxFile(
    name: string,
    ext: ModelExtension,
  ): Promise<AiModel | string> {
    const source = join(this.env.MODELS_DIR, 'inbox', name);
    const sha256 = await sha256File(source);
    const duplicate = await this.prisma.aiModel.findUnique({
      where: { sha256 },
    });
    if (duplicate) return `same file as ${duplicate.name}`;

    const id = randomUUID();
    const filePath = registryPath(id, ext);
    const target = resolveInside(this.env.MODELS_DIR, filePath);
    const { size } = await stat(source);
    await rename(source, target);
    try {
      return await this.prisma.aiModel.create({
        data: {
          id,
          name,
          format: FORMAT[ext],
          source: 'FILESYSTEM',
          status: 'UPLOADED',
          filePath,
          originalName: name,
          sha256,
          sizeBytes: BigInt(size),
        },
      });
    } catch (err) {
      await rename(target, source).catch(() => undefined); // put it back in the inbox
      throw err;
    }
  }

  /** Registers a top-level file in place. Returns the skip reason for a known file. */
  private async adoptBuiltin(
    name: string,
    ext: ModelExtension,
  ): Promise<AiModel | string> {
    const source = resolveInside(this.env.MODELS_DIR, name);
    const sha256 = await sha256File(source);
    const duplicate = await this.prisma.aiModel.findUnique({
      where: { sha256 },
    });
    if (duplicate) return `same file as ${duplicate.name}`;
    const { size } = await stat(source);
    return this.prisma.aiModel.create({
      data: {
        name,
        format: FORMAT[ext],
        source: 'BUILTIN',
        status: 'UPLOADED',
        filePath: name,
        originalName: name,
        sha256,
        sizeBytes: BigInt(size),
      },
    });
  }

  /** Ids of the cameras whose active settings use the model. */
  async camerasUsing(model: AiModel): Promise<string[]> {
    const cameras = await this.prisma.camera.findMany({
      select: { id: true, useCase: true, activeVersion: true },
      orderBy: { id: 'asc' },
    });
    if (cameras.length === 0) return [];
    const versions = await this.prisma.cameraConfigVersion.findMany({
      where: {
        OR: cameras.map((c) => ({ cameraId: c.id, version: c.activeVersion })),
      },
    });
    const settingsOf = new Map(versions.map((v) => [v.cameraId, v.settings]));
    const topLevel = !model.filePath.includes('/');
    const using: string[] = [];
    for (const camera of cameras) {
      const raw = settingsOf.get(camera.id);
      if (!raw) continue;
      const settings = this.contracts.validator.withDefaults(
        camera.useCase,
        raw as object,
      ) as { model_id?: string; model_name?: string };
      if (
        settings.model_id === model.id ||
        (topLevel && settings.model_name === model.filePath)
      ) {
        using.push(camera.id);
      }
    }
    return using;
  }

  /** Deletes the row, then the file. Returns the deleted row. */
  async remove(id: string): Promise<AiModel> {
    const row = await this.getRow(id);
    const using = await this.camerasUsing(row);
    if (using.length > 0) {
      throw new ConflictException(
        `The model is used by camera ${using.join(', ')}`,
      );
    }
    try {
      await this.prisma.aiModel.delete({ where: { id } });
    } catch (err) {
      if (code(err) === 'P2025') throw new NotFoundException('Model not found');
      throw err;
    }
    try {
      await rm(resolveInside(this.env.MODELS_DIR, row.filePath), {
        force: true,
      });
    } catch (err) {
      this.logger.warn(
        `Model ${id} deleted, but its file ${row.filePath} was not removed: ${(err as Error).message}`,
      );
    }
    return row;
  }

  private sameFile(name: string): ConflictException {
    return new ConflictException(
      `This file is already registered as "${name}"`,
    );
  }
}
