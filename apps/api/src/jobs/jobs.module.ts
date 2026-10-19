import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { LiveModule } from '../live/live.module';
import { DiskJob } from './disk.job';
import { OfflineJob } from './offline.job';
import { RetentionJob } from './retention.job';

/** Background jobs. Each one only schedules itself when JOBS=on; tests call tick() directly. */
@Module({
  imports: [ScheduleModule.forRoot(), LiveModule],
  providers: [OfflineJob, RetentionJob, DiskJob],
})
export class JobsModule {}
