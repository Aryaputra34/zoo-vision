import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { EventStatsDto, EventStatsQueryDto } from './dto/event-stats.dto';
import { EventStatsService } from './event-stats.service';

/** Aggregates for the dashboard pages. Any logged-in role. Rows are sparse: empty buckets are left out. */
@Controller('reports')
export class ReportsController {
  constructor(private readonly events: EventStatsService) {}

  @Get('events/stats')
  @ApiOkResponse({ type: EventStatsDto })
  eventStats(@Query() q: EventStatsQueryDto): Promise<EventStatsDto> {
    return this.events.stats(q);
  }
}
