import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Body,
  UseGuards,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import {
  parseConversionReport,
  parseValidationReport,
} from '../models/dto/model.dto';
import { ModelsService } from '../models/models.service';
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
  constructor(
    private readonly cameras: EngineCamerasService,
    private readonly models: ModelsService,
  ) {}

  @Get('cameras')
  async list(
    @Query('group') group?: string,
  ): Promise<{ cameras: EngineCamera[] }> {
    if (typeof group !== 'string' || !GROUP.test(group)) {
      throw new BadRequestException('group must match ^[a-z0-9_-]{1,32}$');
    }
    return { cameras: await this.cameras.snapshot(group) };
  }

  @Post('models/:id/validation')
  @HttpCode(204)
  async validation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.models.reportValidation(id, parseValidationReport(body));
  }

  @Post('models/:id/conversion')
  @HttpCode(204)
  async conversion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.models.reportConversion(id, parseConversionReport(body));
  }
}
