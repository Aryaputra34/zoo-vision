import { Module } from '@nestjs/common';
import { EventStatsService } from './event-stats.service';
import { ReportsController } from './reports.controller';

@Module({
  controllers: [ReportsController],
  providers: [EventStatsService],
})
export class ReportsModule {}
