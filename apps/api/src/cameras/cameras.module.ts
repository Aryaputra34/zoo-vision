import { Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { CamerasController } from './cameras.controller';
import { CamerasService } from './cameras.service';
import { ConfigNotifier } from './config-notifier';
import { UrlCipher } from './url-cipher';

@Module({
  controllers: [CamerasController],
  providers: [
    CamerasService,
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
