import { Module } from '@nestjs/common';
import { EventStatsService } from './event-stats.service';
import { IntervalStatsService } from './interval-stats.service';
import { MetricSeriesService } from './metric-series.service';
import { ReportsController } from './reports.controller';

@Module({
  controllers: [ReportsController],
  providers: [EventStatsService, IntervalStatsService, MetricSeriesService],
})
export class ReportsModule {}
