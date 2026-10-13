import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { setAudit } from '../audit/audit-context';
import type { Actor } from '../auth/actor';
import { CurrentActor, MinRole } from '../auth/decorators';
import { auditView, CamerasService } from './cameras.service';
import type { CameraView } from './camera-view';
import { CreateCameraDto } from './dto/create-camera.dto';
import { UpdateCameraDto } from './dto/update-camera.dto';

@Controller('cameras')
export class CamerasController {
  constructor(private readonly cameras: CamerasService) {}

  /** Any role. What each role sees of a camera is decided by toCameraView. */
  @Get()
  @ApiOkResponse({ description: 'CameraView[], sorted by id' })
  list(@CurrentActor() actor: Actor): Promise<CameraView[]> {
    return this.cameras.list(actor);
  }

  @Get(':id')
  get(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
  ): Promise<CameraView> {
    return this.cameras.get(actor, id);
  }

  @MinRole('SUPERADMIN')
  @Post()
  @ApiCreatedResponse({ description: 'The SUPERADMIN CameraView' })
  async create(
    @CurrentActor() actor: Actor,
    @Body() dto: CreateCameraDto,
    @Req() req: Request,
  ): Promise<CameraView> {
    const { camera, view } = await this.cameras.create(actor, dto);
    setAudit(req, {
      action: 'camera.create',
      entity: 'camera',
      entityId: camera.id,
      after: auditView(camera, this.cameras.cipher),
    });
    return view;
  }

  /** MANAGER may change name, area and enabled; any other changed field needs SUPERADMIN. */
  @MinRole('MANAGER')
  @Patch(':id')
  async update(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() dto: UpdateCameraDto,
    @Req() req: Request,
  ): Promise<CameraView> {
    const { before, after, streamUrlsChanged, view } =
      await this.cameras.update(actor, id, dto);
    setAudit(req, {
      action: 'camera.update',
      entity: 'camera',
      entityId: id,
      before: auditView(before, this.cameras.cipher),
      after: {
        ...auditView(after, this.cameras.cipher),
        streamUrlsChanged,
      },
    });
    return view;
  }

  @MinRole('SUPERADMIN')
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Req() req: Request): Promise<void> {
    const before = await this.cameras.remove(id);
    setAudit(req, {
      action: 'camera.delete',
      entity: 'camera',
      entityId: id,
      before: auditView(before, this.cameras.cipher),
    });
  }
}
