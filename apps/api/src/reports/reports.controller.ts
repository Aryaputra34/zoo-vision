import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { EventStatsDto, EventStatsQueryDto } from './dto/event-stats.dto';
import {
  IntervalStatsDto,
  IntervalStatsQueryDto,
} from './dto/interval-stats.dto';
import { MetricSeriesDto, MetricSeriesQueryDto } from './dto/metric-series.dto';
import { EventStatsService } from './event-stats.service';
import { IntervalStatsService } from './interval-stats.service';
import { MetricSeriesService } from './metric-series.service';

/** Aggregates for the dashboard pages. Any logged-in role. Rows are sparse: empty buckets are left out. */
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly events: EventStatsService,
    private readonly intervals: IntervalStatsService,
    private readonly metrics: MetricSeriesService,
  ) {}

  @Get('events/stats')
  @ApiOkResponse({ type: EventStatsDto })
  eventStats(@Query() q: EventStatsQueryDto): Promise<EventStatsDto> {
    return this.events.stats(q);
  }

  @Get('intervals/stats')
  @ApiOkResponse({ type: IntervalStatsDto })
  intervalStats(@Query() q: IntervalStatsQueryDto): Promise<IntervalStatsDto> {
    return this.intervals.stats(q);
  }

  @Get('metrics/series')
  @ApiOkResponse({ type: MetricSeriesDto })
  metricSeries(@Query() q: MetricSeriesQueryDto): Promise<MetricSeriesDto> {
    return this.metrics.series(q);
  }
}
