import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiProduces,
  ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { setAudit } from '../audit/audit-context';
import type { Actor } from '../auth/actor';
import { CurrentActor } from '../auth/decorators';
import { ApiErrorBody, apiError } from '../common/errors';
import { CreateExportJobDto, ExportJobDto } from './dto/export-job.dto';
import { ExportJobsService } from './export-jobs.service';

/** PDF summaries, made in the background. Any logged-in role; a job is visible to its creator only. */
@Controller('exports/jobs')
export class ExportJobsController {
  constructor(private readonly jobs: ExportJobsService) {}

  @Post()
  @HttpCode(202)
  @ApiAcceptedResponse({ type: ExportJobDto })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'UNAVAILABLE: no PDF service is configured',
  })
  async create(
    @Body() dto: CreateExportJobDto,
    @CurrentActor() actor: Actor,
    @Req() req: Request,
  ): Promise<ExportJobDto> {
    const job = await this.jobs.create(dto, actor);
    setAudit(req, {
      action: 'export.pdf',
      entity: 'export',
      entityId: job.id,
      after: job.params,
    });
    return job;
  }

  @Get()
  @ApiOkResponse({ type: [ExportJobDto] })
  list(@CurrentActor() actor: Actor): Promise<ExportJobDto[]> {
    return this.jobs.list(actor);
  }

  @Get(':id/file')
  @ApiProduces('application/pdf')
  @ApiOkResponse({
    description: 'The PDF as an attachment',
    content: {
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiNotFoundResponse({
    type: ApiErrorBody,
    description: 'NOT_FOUND: no such job, not yours, or not finished',
  })
  async file(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
    @Res() res: Response,
  ): Promise<void> {
    const { root, file, filename } = await this.jobs.file(id, actor);
    await new Promise<void>((resolve, reject) => {
      res.sendFile(
        file,
        {
          root,
          dotfiles: 'deny',
          cacheControl: false,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        },
        // the file is gone (the retention job or a person): the same 404; later errors are a client that left
        (err) =>
          err && !res.headersSent
            ? reject(apiError(404, 'NOT_FOUND', 'No such export'))
            : resolve(),
      );
    });
  }
}
