import { Module } from '@nestjs/common';
import { EventStatsService } from './event-stats.service';
import { EventsController } from './events.controller';
import { IntervalStatsService } from './interval-stats.service';
import { IntervalsController } from './intervals.controller';
import { ListsService } from './lists.service';
import { MetricSeriesService } from './metric-series.service';
import { ReportsController } from './reports.controller';

@Module({
  controllers: [ReportsController, EventsController, IntervalsController],
  providers: [
    EventStatsService,
    IntervalStatsService,
    MetricSeriesService,
    ListsService,
  ],
  exports: [ListsService],
})
export class ReportsModule {}
