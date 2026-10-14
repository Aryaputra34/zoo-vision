import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiProduces } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { Actor } from '../auth/actor';
import { CurrentActor, MinRole } from '../auth/decorators';
import { CsvResponder } from '../exports/csv-responder';
import {
  AuditFilterDto,
  AuditPageDto,
  AuditQueryDto,
  LoginFilterDto,
  LoginPageDto,
  LoginQueryDto,
  SystemEventsFilterDto,
  SystemEventsPageDto,
  SystemEventsQueryDto,
} from './dto/system-log.dto';
import { SystemLogService } from './system-log.service';

const CSV = {
  description: 'A UTF-8 CSV (with a BOM), local times in the site time zone',
  content: { 'text/csv': { schema: { type: 'string' } } },
} as const;

/** What happened, for MANAGER and SUPERADMIN: audit, logins, and the system's own events. */
@MinRole('MANAGER')
@Controller('system-log')
export class SystemLogController {
  constructor(
    private readonly log: SystemLogService,
    private readonly responder: CsvResponder,
  ) {}

  @Get('audit')
  @ApiOkResponse({ type: AuditPageDto })
  audit(
    @CurrentActor() actor: Actor,
    @Query() q: AuditQueryDto,
  ): Promise<AuditPageDto> {
    return this.log.audit(actor, q);
  }

  @Get('logins')
  @ApiOkResponse({ type: LoginPageDto })
  logins(
    @CurrentActor() actor: Actor,
    @Query() q: LoginQueryDto,
  ): Promise<LoginPageDto> {
    return this.log.logins(actor, q);
  }

  @Get('system-events')
  @ApiOkResponse({ type: SystemEventsPageDto })
  systemEvents(@Query() q: SystemEventsQueryDto): Promise<SystemEventsPageDto> {
    return this.log.systemEvents(q);
  }

  @Get('audit.csv')
  @ApiProduces('text/csv')
  @ApiOkResponse(CSV)
  async auditCsv(
    @Query() q: AuditFilterDto,
    @CurrentActor() actor: Actor,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.responder.send(
      await this.log.auditCsv(actor, q),
      actor,
      req,
      res,
    );
  }

  @Get('logins.csv')
  @ApiProduces('text/csv')
  @ApiOkResponse(CSV)
  async loginsCsv(
    @Query() q: LoginFilterDto,
    @CurrentActor() actor: Actor,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.responder.send(
      await this.log.loginsCsv(actor, q),
      actor,
      req,
      res,
    );
  }

  @Get('system-events.csv')
  @ApiProduces('text/csv')
  @ApiOkResponse(CSV)
  async systemEventsCsv(
    @Query() q: SystemEventsFilterDto,
    @CurrentActor() actor: Actor,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.responder.send(this.log.systemEventsCsv(q), actor, req, res);
  }
}
