import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { IntervalListQueryDto, IntervalPageDto } from './dto/list.dto';
import { ListsService } from './lists.service';
import type { IntervalRow, Page } from './rows';

/** Intervals by start, newest first. Any logged-in role. */
@Controller('intervals')
export class IntervalsController {
  constructor(private readonly lists: ListsService) {}

  @Get()
  @ApiOkResponse({ type: IntervalPageDto })
  list(@Query() q: IntervalListQueryDto): Promise<Page<IntervalRow>> {
    return this.lists.intervals(q);
  }
}
