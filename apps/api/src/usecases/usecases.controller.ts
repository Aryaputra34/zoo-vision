import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { ContractsService } from '../contracts/contracts.service';
import { UseCaseDto } from './dto/usecase.dto';

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** What the zone editor and the generated forms are built from. Any logged-in role. */
@Controller('usecases')
export class UsecasesController {
  constructor(private readonly contracts: ContractsService) {}

  @Get()
  @ApiOkResponse({ type: [UseCaseDto], description: 'Sorted by id' })
  list(): UseCaseDto[] {
    return [...this.contracts.registry.useCases]
      .sort(([a], [b]) => byName(a, b))
      .map(([id, c]) => ({
        id,
        label: c.label,
        schemaVersion: c.schemaVersion,
        assignable: c.settings !== null,
        settingsSchema: c.settings,
        liveSchema: c.live,
        events: Object.keys(c.events)
          .sort(byName)
          .map((type) => ({ type, schema: c.events[type] })),
        intervals: Object.keys(c.intervals)
          .sort(byName)
          .map((kind) => ({ kind, schema: c.intervals[kind] })),
        metrics: Object.keys(c.metrics)
          .sort(byName)
          .map((name) => ({ name, ...c.metrics[name] })),
      }));
  }
}
