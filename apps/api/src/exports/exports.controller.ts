import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiProduces } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { Actor } from '../auth/actor';
import { CurrentActor } from '../auth/decorators';
import { AuditService } from '../audit/audit.service';
import { EventFilterDto, IntervalFilterDto } from '../reports/dto/list.dto';
import { RangeQueryDto } from '../reports/report-query';
import { streamCsv } from './csv';
import { SummaryQueryDto } from './dto/summary-query.dto';
import { type CsvExport, ExportsService } from './exports.service';

const CSV = {
  description: 'A UTF-8 CSV (with a BOM), local times in the site time zone',
  content: { 'text/csv': { schema: { type: 'string' } } },
} as const;

/** CSV downloads, streamed. Any logged-in role; each one writes an audit row. */
@Controller('exports')
export class ExportsController {
  constructor(
    private readonly exports: ExportsService,
    private readonly audit: AuditService,
  ) {}

  @Get('events.csv')
  @ApiProduces('text/csv')
  @ApiOkResponse(CSV)
  async events(
    @Query() q: EventFilterDto,
    @CurrentActor() actor: Actor,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.send(this.exports.events(q), actor, req, res);
  }

  @Get('intervals.csv')
  @ApiProduces('text/csv')
  @ApiOkResponse(CSV)
  async intervals(
    @Query() q: IntervalFilterDto,
    @CurrentActor() actor: Actor,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.send(this.exports.intervals(q), actor, req, res);
  }

  @Get('metrics.csv')
  @ApiProduces('text/csv')
  @ApiOkResponse(CSV)
  async metrics(
    @Query() q: RangeQueryDto,
    @CurrentActor() actor: Actor,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.send(this.exports.metrics(q), actor, req, res);
  }

  @Get('summary.csv')
  @ApiProduces('text/csv')
  @ApiOkResponse(CSV)
  async summary(
    @Query() q: SummaryQueryDto,
    @CurrentActor() actor: Actor,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.send(this.exports.summary(q), actor, req, res);
  }

  /** The filters are valid by now: audit first (no data leaves without a record), then stream. */
  private async send(
    csv: CsvExport,
    actor: Actor,
    req: Request,
    res: Response,
  ): Promise<void> {
    // the interceptor only audits writes, so an export records itself
    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: 'export.csv',
      entity: 'export',
      after: { kind: csv.kind, filters: csv.filters },
      ip: req.ip,
    });

    // the client closing the tab ends the response: stop reading batches at once
    const gone = new AbortController();
    res.once('close', () => gone.abort());

    await streamCsv(res, csv.header, csv.batches, gone.signal, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csv.filename}"`,
      'Cache-Control': 'no-store',
    });
  }
}
