import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { setAudit } from '../audit/audit-context';
import type { Actor } from '../auth/actor';
import { CurrentActor, MinRole } from '../auth/decorators';
import { ApiErrorBody } from '../common/errors';
import { ConfigVersionsService } from './config-versions.service';
import {
  ConfigVersionDetailDto,
  ConfigVersionDto,
  ConfigVersionSummaryDto,
  SavedConfigDto,
} from './dto/config-version.dto';
import { RollbackConfigDto, SaveConfigDto } from './dto/save-config.dto';

@Controller('cameras/:id/config')
export class CameraConfigController {
  constructor(private readonly versions: ConfigVersionsService) {}

  /** Any role. */
  @Get()
  @ApiOkResponse({ type: ConfigVersionDto })
  active(@Param('id') id: string) {
    return this.versions.active(id);
  }

  @MinRole('MANAGER')
  @Get('versions')
  @ApiOkResponse({
    type: [ConfigVersionSummaryDto],
    description: 'Newest first',
  })
  list(@Param('id') id: string) {
    return this.versions.list(id);
  }

  @MinRole('MANAGER')
  @Get('versions/:version')
  @ApiOkResponse({ type: ConfigVersionDetailDto })
  get(
    @Param('id') id: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.versions.get(id, version);
  }

  @MinRole('MANAGER')
  @Post()
  @ApiCreatedResponse({ type: SavedConfigDto })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'baseVersion is not the active version (STALE_VERSION)',
  })
  async save(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() dto: SaveConfigDto,
    @Req() req: Request,
  ): Promise<{ version: number }> {
    const { version, before, after } = await this.versions.save(actor, id, dto);
    setAudit(req, {
      action: 'camera_config.save',
      entity: 'camera',
      entityId: id,
      before,
      after,
    });
    return { version };
  }

  @MinRole('MANAGER')
  @Post('rollback')
  @ApiCreatedResponse({ type: SavedConfigDto })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'baseVersion is not the active version (STALE_VERSION)',
  })
  async rollback(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() dto: RollbackConfigDto,
    @Req() req: Request,
  ): Promise<{ version: number }> {
    const { version, before, after } = await this.versions.rollback(
      actor,
      id,
      dto,
    );
    setAudit(req, {
      action: 'camera_config.rollback',
      entity: 'camera',
      entityId: id,
      before,
      after,
    });
    return { version };
  }
}
