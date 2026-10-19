import { Injectable } from '@nestjs/common';
import { apiError } from '../common/errors';
import { ContractsService } from '../contracts/contracts.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decodeCursor, encodeCursor } from './cursor';
import {
  DEFAULT_LIMIT,
  type EventFilterDto,
  type EventListQueryDto,
  type IntervalFilterDto,
  type IntervalListQueryDto,
} from './dto/list.dto';
import { parseWhere, wantsSystem } from './fields';
import { keysetAfter } from './keyset';
import { parseRange, splitList } from './report-query';
import {
  EVENT_INCLUDE,
  eventRow,
  INTERVAL_CAMERA,
  intervalRow,
  type EventRow,
  type IntervalRow,
  type Page,
} from './rows';

const SEVERITIES = ['info', 'warning', 'critical'] as const;
type Severity = (typeof SEVERITIES)[number];

@Injectable()
export class ListsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: ContractsService,
  ) {}

  /** The event filters as a Prisma `where`, shared by the list and the CSV export. */
  eventWhere(q: EventFilterDto): Prisma.EventWhereInput {
    const range = parseRange(q);
    const registry = this.contracts.registry;
    const types = splitList(q.types, '/types');
    const severities = splitList(q.severity, '/severity');
    const bad = severities?.find((s) => !SEVERITIES.includes(s as Severity));
    if (bad !== undefined) {
      throw apiError(400, 'VALIDATION_FAILED', 'Request validation failed', [
        {
          path: '/severity',
          message: `"${bad}" is not info, warning or critical`,
        },
      ]);
    }
    const filters = parseWhere(registry, types, q.where);

    return {
      AND: [
        { time: { gte: range.from, lt: range.to } },
        ...(range.cameraIds ? [{ cameraId: { in: range.cameraIds } }] : []),
        ...(range.useCase ? [{ useCase: range.useCase }] : []),
        ...(types ? [{ type: { in: types } }] : []),
        ...(severities ? [{ severity: { in: severities as Severity[] } }] : []),
        // system events are left out unless asked for, as in the reports
        ...(wantsSystem(registry, range.useCase, types, 'events')
          ? []
          : [{ useCase: { not: 'system' } }]),
        // a field name and a value are parameters to Prisma, never SQL text
        ...filters.map((f) => ({
          data: { path: [f.field], equals: f.value },
        })),
      ],
    };
  }

  /** The interval filters (the range is on `start`) as a Prisma `where`. */
  intervalWhere(q: IntervalFilterDto): Prisma.IntervalWhereInput {
    const range = parseRange(q);
    return {
      AND: [
        { start: { gte: range.from, lt: range.to } },
        ...(range.cameraIds ? [{ cameraId: { in: range.cameraIds } }] : []),
        ...(range.useCase ? [{ useCase: range.useCase }] : []),
        ...(q.kind ? [{ kind: q.kind }] : []),
        ...(wantsSystem(
          this.contracts.registry,
          range.useCase,
          q.kind ? [q.kind] : undefined,
          'intervals',
        )
          ? []
          : [{ useCase: { not: 'system' } }]),
      ],
    };
  }

  async events(q: EventListQueryDto): Promise<Page<EventRow>> {
    const where = this.eventWhere(q);
    const limit = q.limit ?? DEFAULT_LIMIT;
    const after = q.cursor ? decodeCursor(q.cursor) : undefined;
    const found = await this.prisma.event.findMany({
      where: after
        ? {
            AND: [
              where,
              keysetAfter<Prisma.EventWhereInput>(
                'time',
                { value: new Date(after.t), id: after.id },
                'desc',
              ),
            ],
          }
        : where,
      orderBy: [{ time: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: EVENT_INCLUDE,
    });
    const page = found.slice(0, limit);
    const last = page[page.length - 1];
    return {
      rows: page.map(eventRow),
      nextCursor:
        found.length > limit
          ? encodeCursor({ t: last.time.toISOString(), id: last.id })
          : null,
    };
  }

  async intervals(q: IntervalListQueryDto): Promise<Page<IntervalRow>> {
    const where = this.intervalWhere(q);
    const limit = q.limit ?? DEFAULT_LIMIT;
    const after = q.cursor ? decodeCursor(q.cursor) : undefined;
    const found = await this.prisma.interval.findMany({
      where: after
        ? {
            AND: [
              where,
              keysetAfter<Prisma.IntervalWhereInput>(
                'start',
                { value: new Date(after.t), id: after.id },
                'desc',
              ),
            ],
          }
        : where,
      orderBy: [{ start: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: INTERVAL_CAMERA,
    });
    const page = found.slice(0, limit);
    const last = page[page.length - 1];
    return {
      rows: page.map(intervalRow),
      nextCursor:
        found.length > limit
          ? encodeCursor({ t: last.start.toISOString(), id: last.id })
          : null,
    };
  }
}
