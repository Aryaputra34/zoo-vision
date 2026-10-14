import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { EventListQueryDto, EventPageDto } from './dto/list.dto';
import { ListsService } from './lists.service';
import type { EventRow, Page } from './rows';

/** Events, newest first. Any logged-in role. */
@Controller('events')
export class EventsController {
  constructor(private readonly lists: ListsService) {}

  @Get()
  @ApiOkResponse({ type: EventPageDto })
  list(@Query() q: EventListQueryDto): Promise<Page<EventRow>> {
    return this.lists.events(q);
  }
}
