import { Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { CameraConfigController } from './camera-config.controller';
import { CamerasController } from './cameras.controller';
import { CamerasService } from './cameras.service';
import { ConfigNotifier } from './config-notifier';
import { ConfigVersionsService } from './config-versions.service';
import { UrlCipher } from './url-cipher';

@Module({
  controllers: [CamerasController, CameraConfigController],
  providers: [
    CamerasService,
    ConfigVersionsService,
    ConfigNotifier,
    {
      provide: UrlCipher,
      inject: [ENV],
      useFactory: (env: Env) => new UrlCipher(env.CAMERA_URL_KEY),
    },
  ],
  exports: [CamerasService, ConfigNotifier, UrlCipher],
})
export class CamerasModule {}
