import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { OfflineJob } from './offline.job';

/** Background jobs. Each one only schedules itself when JOBS=on; tests call tick() directly. */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [OfflineJob],
})
export class JobsModule {}
