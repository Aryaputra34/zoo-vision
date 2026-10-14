import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiProduces } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { Actor } from '../auth/actor';
import { CurrentActor } from '../auth/decorators';
import { EventFilterDto, IntervalFilterDto } from '../reports/dto/list.dto';
import { RangeQueryDto } from '../reports/report-query';
import { CsvResponder } from './csv-responder';
import { SummaryQueryDto } from './dto/summary-query.dto';
import { ExportsService } from './exports.service';

const CSV = {
  description: 'A UTF-8 CSV (with a BOM), local times in the site time zone',
  content: { 'text/csv': { schema: { type: 'string' } } },
} as const;

/** CSV downloads, streamed. Any logged-in role; each one writes an audit row. */
@Controller('exports')
export class ExportsController {
  constructor(
    private readonly exports: ExportsService,
    private readonly responder: CsvResponder,
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
    await this.responder.send(this.exports.events(q), actor, req, res);
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
    await this.responder.send(this.exports.intervals(q), actor, req, res);
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
    await this.responder.send(this.exports.metrics(q), actor, req, res);
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
    await this.responder.send(this.exports.summary(q), actor, req, res);
  }
}
