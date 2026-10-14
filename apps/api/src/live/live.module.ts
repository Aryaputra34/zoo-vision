import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CamerasModule } from '../cameras/cameras.module';
import { IngestModule } from '../ingest/ingest.module';
import { AuditPush } from './audit-push';
import { IngestPush } from './ingest-push';
import { LiveGateway } from './live.gateway';
import { StatusBroadcaster } from './status-broadcaster';

/** The `/ws` gateway and what feeds it: status ticks, and the push after each ingest commit. */
@Module({
  imports: [AuthModule, CamerasModule, IngestModule],
  providers: [LiveGateway, StatusBroadcaster, IngestPush, AuditPush],
  exports: [LiveGateway],
})
export class LiveModule {}
