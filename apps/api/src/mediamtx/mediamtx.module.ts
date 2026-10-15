import { Module } from '@nestjs/common';
import { UrlCipher } from '../cameras/url-cipher';
import { ENV, type Env } from '../config/env';
import { MEDIAMTX, MediamtxClient } from './mediamtx-client';
import { PathSync } from './path-sync.service';

/**
 * MediaMTX's Control API: the client (null without MEDIAMTX_API_URL) and the path sync. It builds
 * its own UrlCipher from the same key: CamerasModule imports this module, so this one cannot
 * import CamerasModule back.
 */
@Module({
  providers: [
    {
      provide: MEDIAMTX,
      inject: [ENV],
      useFactory: (env: Env) =>
        env.MEDIAMTX_API_URL && env.MEDIAMTX_PASSWORD
          ? new MediamtxClient(env.MEDIAMTX_API_URL, env.MEDIAMTX_PASSWORD)
          : null,
    },
    {
      provide: UrlCipher,
      inject: [ENV],
      useFactory: (env: Env) => new UrlCipher(env.CAMERA_URL_KEY),
    },
    PathSync,
  ],
  exports: [MEDIAMTX, PathSync],
})
export class MediamtxModule {}
