import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CamerasModule } from '../cameras/cameras.module';
import { LiveGateway } from './live.gateway';
import { StatusBroadcaster } from './status-broadcaster';

/** The `/ws` gateway and what feeds it. Tasks 16 and 17 add the ingest push and audit notices. */
@Module({
  imports: [AuthModule, CamerasModule],
  providers: [LiveGateway, StatusBroadcaster],
  exports: [LiveGateway],
})
export class LiveModule {}
