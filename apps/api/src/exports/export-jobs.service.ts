import { resolve, sep } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { Actor } from '../auth/actor';
import { apiError } from '../common/errors';
import { ENV, type Env } from '../config/env';
import { ContractsService } from '../contracts/contracts.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ExportJob } from '../generated/prisma/client';
import {
  type CreateExportJobDto,
  type ExportJobDto,
} from './dto/export-job.dto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_MAX = 50;

type Params = ExportJobDto['params'];

export function exportJobDto(row: ExportJob): ExportJobDto {
  return {
    id: row.id,
    params: row.params as unknown as Params,
    status: row.status,
    error: row.error,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    fileUrl:
      row.status === 'DONE' ? `/api/v1/exports/jobs/${row.id}/file` : null,
  };
}

/** PDF jobs: queued here, printed by {@link PdfJob}. Every read is limited to the caller's own rows. */
@Injectable()
export class ExportJobsService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly contracts: ContractsService,
  ) {}

  async create(dto: CreateExportJobDto, actor: Actor): Promise<ExportJobDto> {
    if (!this.env.GOTENBERG_URL) {
      throw apiError(503, 'UNAVAILABLE', 'PDF export is not configured');
    }
    const cameraIds = dto.cameraIds ? [...new Set(dto.cameraIds)] : undefined;
    if (cameraIds) {
      const found = await this.prisma.camera.findMany({
        where: { id: { in: cameraIds } },
        select: { id: true },
      });
      const have = new Set(found.map((c) => c.id));
      const at = cameraIds.findIndex((id) => !have.has(id));
      if (at >= 0) {
        throw apiError(400, 'VALIDATION_FAILED', 'Request validation failed', [
          { path: `/cameraIds/${at}`, message: 'no such camera' },
        ]);
      }
    }
    if (dto.useCase && !this.contracts.registry.useCases.has(dto.useCase)) {
      throw apiError(400, 'VALIDATION_FAILED', 'Request validation failed', [
        { path: '/useCase', message: 'unknown use case' },
      ]);
    }
    const params: Params = {
      period: dto.period,
      date: dto.date,
      ...(cameraIds ? { cameraIds } : {}),
      ...(dto.useCase ? { useCase: dto.useCase } : {}),
    };
    const row = await this.prisma.exportJob.create({
      data: {
        params: { ...params },
        createdById: actor.id,
        createdByName: actor.name,
      },
    });
    return exportJobDto(row);
  }

  async list(actor: Actor): Promise<ExportJobDto[]> {
    const rows = await this.prisma.exportJob.findMany({
      where: { createdById: actor.id },
      orderBy: { createdAt: 'desc' },
      take: LIST_MAX,
    });
    return rows.map(exportJobDto);
  }

  /** The finished file of the caller's own job: another owner, an unfinished job or a malformed id are all 404. */
  async file(
    id: string,
    actor: Actor,
  ): Promise<{ root: string; file: string; filename: string }> {
    const row = UUID.test(id)
      ? await this.prisma.exportJob.findFirst({
          where: { id, createdById: actor.id, status: 'DONE' },
        })
      : null;
    const root = resolve(this.env.EXPORTS_DIR);
    const file = row?.filePath;
    // the path comes from a row the API wrote, but nothing leaves the exports folder anyway
    if (!row || !file || !resolve(root, file).startsWith(root + sep)) {
      throw apiError(404, 'NOT_FOUND', 'No such export');
    }
    const { period, date } = row.params as unknown as Params;
    return { root, file, filename: `report-${period}-${date}.pdf` };
  }
}
