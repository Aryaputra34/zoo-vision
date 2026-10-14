import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserDto } from './dto/user.dto';
import { UsersService } from './users.service';

@MinRole('MANAGER')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOkResponse({ type: [UserDto] })
  list(@CurrentActor() actor: Actor): Promise<UserDto[]> {
    return this.users.list(actor);
  }

  @Post()
  @ApiCreatedResponse({ type: UserDto })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'The username is taken (USERNAME_TAKEN)',
  })
  async create(
    @CurrentActor() actor: Actor,
    @Body() dto: CreateUserDto,
    @Req() req: Request,
  ): Promise<UserDto> {
    const user = await this.users.create(actor, dto);
    setAudit(req, {
      action: 'user.create',
      entity: 'user',
      entityId: user.id,
      after: user,
    });
    return user;
  }

  @Patch(':id')
  @ApiOkResponse({ type: UserDto })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'The last active superadmin cannot be removed (LAST_SUPERADMIN)',
  })
  async update(
    @CurrentActor() actor: Actor,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateUserDto,
    @Req() req: Request,
  ): Promise<UserDto> {
    const { before, after } = await this.users.update(actor, id, dto);
    setAudit(req, {
      action: 'user.update',
      entity: 'user',
      entityId: id,
      before,
      after: dto.password ? { ...after, passwordChanged: true } : after,
    });
    return after;
  }
}
