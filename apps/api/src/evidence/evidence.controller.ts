import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { setAudit } from '../audit/audit-context';
import { MinRole } from '../auth/decorators';
import { ApiErrorBody } from '../common/errors';
import { EvidenceDto } from './dto/evidence.dto';
import { EvidenceService } from './evidence.service';

@Controller('events')
export class EvidenceController {
  constructor(private readonly evidence: EvidenceService) {}

  /** Keeps the clip of an event past the continuous recording. Already kept: the same row again. */
  @MinRole('MANAGER')
  @Post(':id/evidence')
  @HttpCode(200)
  @ApiOkResponse({ type: EvidenceDto })
  @ApiNotFoundResponse({
    type: ApiErrorBody,
    description:
      'NOT_FOUND: no such event. RECORDING_NOT_AVAILABLE: a system event has no camera',
  })
  async keep(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<EvidenceDto> {
    const row = await this.evidence.keep(id);
    setAudit(req, { action: 'evidence.keep', entity: 'event', entityId: id });
    return row;
  }
}
