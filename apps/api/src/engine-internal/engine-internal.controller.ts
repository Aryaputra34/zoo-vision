import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import {
  type EngineCamera,
  EngineCamerasService,
} from './engine-cameras.service';
import { EngineTokenGuard } from './engine-token.guard';

const GROUP = /^[a-z0-9_-]{1,32}$/;

/** The Python engine's routes: outside the `api` prefix, behind the shared ENGINE_TOKEN. */
@Controller({ path: 'internal/engine', version: VERSION_NEUTRAL })
@Public()
@UseGuards(EngineTokenGuard)
@ApiExcludeController()
export class EngineInternalController {
  constructor(private readonly cameras: EngineCamerasService) {}

  @Get('cameras')
  async list(
    @Query('group') group?: string,
  ): Promise<{ cameras: EngineCamera[] }> {
    if (typeof group !== 'string' || !GROUP.test(group)) {
      throw new BadRequestException('group must match ^[a-z0-9_-]{1,32}$');
    }
    return { cameras: await this.cameras.snapshot(group) };
  }
}
