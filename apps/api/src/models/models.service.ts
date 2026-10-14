import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type Redis from 'ioredis';
import type { Actor } from '../auth/actor';
import { apiError } from '../common/errors';
import { ENV, type Env } from '../config/env';
import { ContractsService } from '../contracts/contracts.service';
import type { AiModel, Prisma } from '../generated/prisma/client';
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
  type ConversionReport,
  type ModelView,
  type RescanResult,
  toModelView,
  type UploadModelDto,
  type ValidationReport,
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

  /**
   * Marks the model VALIDATING (guarded: only from its current status) and then queues the validate
   * job, so no engine report can arrive before VALIDATING. A refused push reverts the row to
   * `revert` (its prior status by default) and rethrows.
   */
  async enqueueValidation(id: string): Promise<void> {
    const row = await this.getRow(id);
    await this.startValidation(id, row.filePath, row.status);
  }

  private async startValidation(
    id: string,
    filePath: string,
    from: AiModel['status'],
    data: Prisma.AiModelUpdateManyMutationInput = {},
    revert: Prisma.AiModelUpdateManyMutationInput = { status: from },
  ): Promise<void> {
    const { count } = await this.prisma.aiModel.updateMany({
      where: { id, status: from },
      data: { ...data, status: 'VALIDATING' },
    });
    if (count !== 1) {
      throw new ConflictException('The model changed meanwhile; retry');
    }
    try {
      await this.redis.lpush(
        MODEL_JOBS_KEY,
        JSON.stringify({ type: 'validate', modelId: id, path: filePath }),
      );
    } catch (err) {
      await this.prisma.aiModel.updateMany({
        where: { id, status: 'VALIDATING' },
        data: revert,
      });
      throw err;
    }
  }

  /** Re-runs the validation. A model that is being converted has no complete file yet. */
  async validate(id: string): Promise<ModelView> {
    const row = await this.getRow(id);
    if (row.status === 'CONVERTING') {
      throw new ConflictException('The model is being converted');
    }
    await this.enqueueValidation(id);
    return this.get(id);
  }

  /** Queues the export of a READY .pt model and creates the CONVERTING ONNX row it will fill. */
  async convert(
    actor: Actor,
    id: string,
    imgsz: number | [number, number],
  ): Promise<{ source: ModelView; target: ModelView }> {
    const source = await this.getRow(id);
    if (source.format !== 'PT' || source.status !== 'READY') {
      throw new ConflictException(
        'Only a PT model with status READY can be converted',
      );
    }
    const targetId = randomUUID();
    const outPath = registryPath(targetId, 'onnx');
    const stem = source.originalName.replace(/\.[^.]+$/, '');
    const target = await this.prisma.aiModel.create({
      data: {
        id: targetId,
        name: `${source.name} (ONNX)`,
        version: source.version,
        format: 'ONNX',
        source: 'CONVERTED',
        status: 'CONVERTING',
        filePath: outPath,
        originalName: `${stem}.onnx`,
        convertedFromId: source.id,
        createdById: actor.id,
      },
    });
    try {
      await this.redis.lpush(
        MODEL_JOBS_KEY,
        JSON.stringify({
          type: 'convert',
          modelId: source.id,
          targetId,
          path: source.filePath,
          outPath,
          imgsz,
        }),
      );
    } catch (err) {
      await this.prisma.aiModel.delete({ where: { id: targetId } });
      throw err;
    }
    return { source: toModelView(source), target: toModelView(target) };
  }

  /** The engine's validation result. Only a VALIDATING model takes it; the update is atomic. */
  async reportValidation(id: string, report: ValidationReport): Promise<void> {
    const at = new Date().toISOString();
    const data: Prisma.AiModelUpdateManyMutationInput = report.ok
      ? {
          status: 'READY',
          classNames: report.classNames,
          validation: {
            ok: true,
            latencyMs: report.latencyMs,
            device: report.device,
            at,
          },
        }
      : {
          status: 'FAILED',
          validation: { ok: false, error: report.error, at },
        };
    await this.applyReport(id, 'VALIDATING', data);
  }

  /**
   * The engine's conversion result for the target row. The reported path must be the row's own and
   * is resolved inside the models folder. The file is hashed here; the reported hash must match. A
   * good file moves the row to VALIDATING before the job is queued.
   */
  async reportConversion(id: string, report: ConversionReport): Promise<void> {
    const at = new Date().toISOString();
    const failed = (error: string): Prisma.AiModelUpdateManyMutationInput => ({
      status: 'FAILED',
      validation: { ok: false, error: error.slice(0, 500), at },
    });
    const row = await this.getRow(id);
    if (row.status !== 'CONVERTING') {
      throw new ConflictException(`The model is ${row.status}`);
    }
    if (!report.ok) {
      await this.applyReport(id, 'CONVERTING', failed(report.error));
      return;
    }
    if (report.path !== row.filePath) {
      await this.applyReport(
        id,
        'CONVERTING',
        failed('reported path mismatch'),
      );
      throw new BadRequestException('path is not the conversion target');
    }
    let size: number;
    let sha256: string;
    try {
      const file = resolveInside(this.env.MODELS_DIR, row.filePath);
      size = (await stat(file)).size;
      sha256 = await sha256File(file);
    } catch {
      await this.applyReport(
        id,
        'CONVERTING',
        failed('The converted file was not found'),
      );
      return;
    }
    if (sha256 !== report.sha256) {
      await this.applyReport(id, 'CONVERTING', failed('sha256 mismatch'));
      return;
    }
    const duplicate = await this.prisma.aiModel.findUnique({
      where: { sha256 },
    });
    if (duplicate && duplicate.id !== id) {
      await this.applyReport(
        id,
        'CONVERTING',
        failed(`duplicate of ${duplicate.name}`),
      );
      return;
    }
    try {
      await this.startValidation(
        id,
        row.filePath,
        'CONVERTING',
        { sha256, sizeBytes: BigInt(size) },
        failed('The validation could not be queued'),
      );
    } catch (err) {
      if (code(err) !== 'P2002') throw err;
      const other = await this.prisma.aiModel.findUnique({
        where: { sha256 },
      });
      await this.applyReport(
        id,
        'CONVERTING',
        failed(`duplicate of ${other?.name ?? 'another model'}`),
      );
    }
  }

  /** Applies `data` only if the row still has `from`; 404 for no such row, 409 for another status. */
  private async applyReport(
    id: string,
    from: AiModel['status'],
    data: Prisma.AiModelUpdateManyMutationInput,
  ): Promise<void> {
    const { count } = await this.prisma.aiModel.updateMany({
      where: { id, status: from },
      data,
    });
    if (count === 1) return;
    const row = await this.getRow(id);
    throw new ConflictException(`The model is ${row.status}`);
  }

  /** Cameras may select a READY model; keeping the model they already have is always allowed. */
  async assertSelectable(
    modelId: string | undefined,
    previousModelId: string | undefined,
  ): Promise<void> {
    if (modelId === undefined || modelId === previousModelId) return;
    const row = await this.prisma.aiModel.findUnique({
      where: { id: modelId },
      select: { status: true },
    });
    if (row?.status !== 'READY') {
      const message = row
        ? `The model is ${row.status}, not READY`
        : 'No such model';
      throw apiError(400, 'SETTINGS_INVALID', 'Settings are invalid', [
        { path: '/model_id', message },
      ]);
    }
  }

  /** The registry path of a model, whatever its status; null for an unknown id. */
  async resolvePath(modelId: string): Promise<string | null> {
    const row = await this.prisma.aiModel.findUnique({
      where: { id: modelId },
      select: { filePath: true },
    });
    return row?.filePath ?? null;
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
      throw apiError(
        409,
        'MODEL_IN_USE',
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
