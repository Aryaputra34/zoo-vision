import { Module } from '@nestjs/common';
import { CamerasModule } from '../cameras/cameras.module';
import { EngineCamerasService } from './engine-cameras.service';
import { EngineInternalController } from './engine-internal.controller';
import { EngineTokenGuard } from './engine-token.guard';

/** Routes for the Python engine under /internal/engine/*. */
@Module({
  imports: [CamerasModule],
  controllers: [EngineInternalController],
  providers: [EngineCamerasService, EngineTokenGuard],
})
export class EngineInternalModule {}
