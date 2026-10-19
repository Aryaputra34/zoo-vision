import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ContractsService } from '../contracts/contracts.service';
import { ENV, type Env } from '../config/env';
import { localDate } from '../demo/demo-generators';
import { PrismaService } from '../prisma/prisma.service';
import { SiteSettingsService } from '../site-settings/site-settings.service';
import { localDateTime } from './csv';
import type { ExportJobDto } from './dto/export-job.dto';
import { ExportsService } from './exports.service';
import { columnLabels, reportHtml } from './pdf/report-html';
import { reportRange } from './pdf/report-range';

const INTERVAL_NAME = 'pdf-job';
const TICK_MS = 5_000;
/** One Gotenberg call, from the request to the last byte of the PDF. */
const GOTENBERG_MS = 60_000;
/** The 4th failure gives up: retries wait 1, 2 and 4 minutes. */
const MAX_ATTEMPTS = 4;

/** Gotenberg answered, and the answer is final (a 4xx): retrying the same HTML cannot help. */
class Refused extends Error {
  constructor(readonly status: number) {
    super(`PDF conversion failed (${status})`);
  }
}

/**
 * Prints the due `ExportJob` through Gotenberg, one at a time. The PDF is written to
 * `<id>.pdf.part` and renamed, so a half-written file is never `filePath` of a `DONE` row.
 */
@Injectable()
export class PdfJob implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PdfJob.name);
  private running = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly exports: ExportsService,
    private readonly contracts: ContractsService,
    private readonly settings: SiteSettingsService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    if (this.env.JOBS !== 'on') return;
    this.scheduler.addInterval(
      INTERVAL_NAME,
      setInterval(() => void this.tick(), TICK_MS),
    );
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  /** One pass over the oldest due job. Skipped while the previous pass runs; never throws. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const [job] = await this.prisma.$queryRaw<
        {
          id: string;
          params: ExportJobDto['params'];
          attempts: number;
          createdByName: string;
        }[]
      >`
        SELECT "id", "params", "attempts", "createdByName" FROM "ExportJob"
         WHERE "status" = 'QUEUED' AND "runAt" <= ${now}::timestamptz
         ORDER BY "runAt" LIMIT 1`;
      if (job) await this.run(job, now);
    } catch (err) {
      this.log.warn(`pdf tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async run(
    job: {
      id: string;
      params: ExportJobDto['params'];
      attempts: number;
      createdByName: string;
    },
    now: Date,
  ): Promise<void> {
    try {
      const html = await this.page(job.params, job.createdByName, now);
      const sizeBytes = await this.print(job.id, html);
      await this.prisma.exportJob.update({
        where: { id: job.id },
        data: {
          status: 'DONE',
          filePath: `${job.id}.pdf`,
          sizeBytes,
          error: null,
          finishedAt: new Date(),
        },
      });
    } catch (err) {
      // never the HTML, the URL or the response body: the status or the reason class only
      this.log.warn(
        `pdf ${job.id} attempt ${job.attempts + 1} failed: ${(err as Error).message}`,
      );
      await this.fail(job.id, job.attempts + 1, err, now).catch(
        () => undefined, // Postgres is down: the row stays due and is tried again
      );
    }
  }

  private async page(
    params: ExportJobDto['params'],
    by: string,
    now: Date,
  ): Promise<string> {
    const site = await this.settings.loaded();
    const { from, to, bucket } = reportRange(
      params.period,
      params.date,
      site.timeZone,
    );
    const table = await this.exports.summaryTable({
      from: from.toISOString(),
      to: to.toISOString(),
      bucket,
      cameraIds: params.cameraIds?.join(','),
      useCase: params.useCase,
    });
    const first = localDate(from.getTime(), site.timeZone);
    const last = localDate(to.getTime() - 1, site.timeZone);
    return reportHtml({
      siteName: site.siteName,
      period: params.period,
      rangeLabel: first === last ? first : `${first} – ${last}`,
      generatedAt: localDateTime(site.timeZone)(now),
      generatedBy: by,
      ...table,
      labels: columnLabels(this.contracts.registry, table.header),
    });
  }

  /** Gotenberg's PDF into `<id>.pdf.part`, then renamed; returns its size. */
  private async print(id: string, html: string): Promise<number> {
    const form = new FormData();
    form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
    form.append('paperWidth', '8.27');
    form.append('paperHeight', '11.7');
    for (const side of ['Top', 'Bottom', 'Left', 'Right']) {
      form.append(`margin${side}`, '0.4');
    }
    form.append('printBackground', 'true');
    const res = await fetch(
      `${this.env.GOTENBERG_URL}/forms/chromium/convert/html`,
      {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(GOTENBERG_MS),
      },
    );
    if (res.status >= 400 && res.status < 500) throw new Refused(res.status);
    if (!res.ok || !res.body) {
      throw new Error(`Gotenberg answered ${res.status}`);
    }
    await mkdir(this.env.EXPORTS_DIR, { recursive: true });
    const part = join(this.env.EXPORTS_DIR, `${id}.pdf.part`);
    const target = join(this.env.EXPORTS_DIR, `${id}.pdf`);
    try {
      await pipeline(
        Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
        createWriteStream(part),
      );
    } catch (err) {
      await rm(part, { force: true }); // never keep half a PDF
      throw err;
    }
    await rename(part, target);
    return (await stat(target)).size;
  }

  private async fail(
    id: string,
    attempts: number,
    err: unknown,
    now: Date,
  ): Promise<void> {
    if (err instanceof Refused) {
      return void (await this.prisma.exportJob.update({
        where: { id },
        data: {
          status: 'FAILED',
          attempts,
          error: err.message,
          finishedAt: now,
        },
      }));
    }
    if (attempts >= MAX_ATTEMPTS) {
      return void (await this.prisma.exportJob.update({
        where: { id },
        data: {
          status: 'FAILED',
          attempts,
          error: 'PDF service unavailable',
          finishedAt: now,
        },
      }));
    }
    await this.prisma.exportJob.update({
      where: { id },
      data: {
        attempts,
        runAt: new Date(now.getTime() + 2 ** (attempts - 1) * 60_000),
      },
    });
  }
}
