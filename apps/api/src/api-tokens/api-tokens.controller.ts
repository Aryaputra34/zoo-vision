import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { setAudit } from '../audit/audit-context';
import type { Actor } from '../auth/actor';
import { CurrentActor, MinRole } from '../auth/decorators';
import { ApiTokensService } from './api-tokens.service';
import { ApiTokenDto, CreatedApiTokenDto } from './dto/api-token.dto';
import { CreateApiTokenDto } from './dto/create-api-token.dto';

@MinRole('SUPERADMIN')
@Controller('api-tokens')
export class ApiTokensController {
  constructor(private readonly tokens: ApiTokensService) {}

  /** The only response that ever carries the raw token. */
  @Post()
  @ApiCreatedResponse({ type: CreatedApiTokenDto })
  async create(
    @CurrentActor() actor: Actor,
    @Body() dto: CreateApiTokenDto,
    @Req() req: Request,
  ): Promise<CreatedApiTokenDto> {
    if (actor.type !== 'user') {
      throw new ForbiddenException('API tokens cannot create API tokens');
    }
    const created = await this.tokens.create(actor.id, dto.name, dto.role);
    setAudit(req, {
      action: 'api_token.create',
      entity: 'api_token',
      entityId: created.id,
      after: {
        id: created.id,
        name: created.name,
        role: created.role,
        prefix: created.prefix,
      },
    });
    return created;
  }

  @Get()
  @ApiOkResponse({ type: [ApiTokenDto] })
  list(): Promise<ApiTokenDto[]> {
    return this.tokens.list();
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    const before = await this.tokens.revoke(id);
    setAudit(req, {
      action: 'api_token.revoke',
      entity: 'api_token',
      entityId: id,
      before,
    });
  }
}
