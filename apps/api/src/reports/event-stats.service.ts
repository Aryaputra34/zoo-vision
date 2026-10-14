import { Inject, Injectable } from '@nestjs/common';
import { apiError } from '../common/errors';
import { ENV, type Env } from '../config/env';
import { ContractsService } from '../contracts/contracts.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { bucketStart } from './buckets';
import type { EventStatsDto, EventStatsQueryDto } from './dto/event-stats.dto';
import { allowedDataField } from './fields';
import {
  assertRange,
  parseRange,
  scopeFilters,
  splitList,
} from './report-query';

/** At most this many `data.<field>` items in `groupBy`. */
const MAX_DATA_GROUPS = 2;

type Group = { key: string; expr: Prisma.Sql };

const COLUMN_GROUPS: Record<string, Prisma.Sql> = {
  camera: Prisma.sql`e."cameraId"`,
  type: Prisma.sql`e."type"`,
  severity: Prisma.sql`e."severity"::text`,
};

function notAllowed(path: string, message: string) {
  return apiError(400, 'FIELD_NOT_ALLOWED', message, [{ path, message }]);
}

/** `data->>field` with the field name as a bound parameter, never as SQL text. */
const dataText = (field: string) => Prisma.sql`e."data"->>(${field}::text)`;

type StatsRow = {
  bucketStart: Date;
  count: number;
  max?: number | null;
} & Record<string, unknown>;

@Injectable()
export class EventStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: ContractsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async stats(q: EventStatsQueryDto): Promise<EventStatsDto> {
    const range = parseRange(q);
    assertRange(range, q.bucket);
    const types = splitList(q.types, '/types');
    const registry = this.contracts.registry;

    const groups: Group[] = [];
    let dataGroups = 0;
    for (const item of splitList(q.groupBy, '/groupBy') ?? []) {
      if (Object.hasOwn(COLUMN_GROUPS, item)) {
        groups.push({ key: item, expr: COLUMN_GROUPS[item] });
        continue;
      }
      const field = item.startsWith('data.') ? item.slice(5) : null;
      if (field === null) {
        throw notAllowed(
          '/groupBy',
          `can not group by "${item}": use camera, type, severity or data.<field>`,
        );
      }
      if (++dataGroups > MAX_DATA_GROUPS) {
        throw notAllowed(
          '/groupBy',
          `at most ${MAX_DATA_GROUPS} data fields can be grouped on`,
        );
      }
      if (!types || !allowedDataField(registry, types, field, 'group')) {
        throw notAllowed(
          '/groupBy',
          `data.${field} is not a string or enum field of the requested types (types is required)`,
        );
      }
      groups.push({ key: item, expr: dataText(field) });
    }

    if (
      q.max !== undefined &&
      (!types || !allowedDataField(registry, types, q.max, 'number'))
    ) {
      throw notAllowed(
        '/max',
        `data.${q.max} is not a number field of the requested types (types is required)`,
      );
    }

    // system events (engine_started, ...) are not park data: only when asked for by name
    const systemTypes = Object.keys(
      registry.useCases.get('system')?.events ?? {},
    );
    const wantsSystem =
      range.useCase === 'system' ||
      !!types?.some((t) => systemTypes.includes(t));

    const where: Prisma.Sql[] = [
      Prisma.sql`e."time" >= ${range.from.toISOString()}::timestamptz`,
      Prisma.sql`e."time" < ${range.to.toISOString()}::timestamptz`,
    ];
    where.push(...scopeFilters('e', range));
    if (types) where.push(Prisma.sql`e."type" IN (${Prisma.join(types)})`);
    if (!wantsSystem) where.push(Prisma.sql`e."useCase" <> 'system'`);

    const columns: Prisma.Sql[] = [
      Prisma.sql`${bucketStart(q.bucket, this.env.SITE_TIMEZONE, Prisma.sql`e."time"`)} AS "bucketStart"`,
      ...groups.map(
        (g, i) => Prisma.sql`${g.expr} AS ${Prisma.raw(`"g${i}"`)}`,
      ),
      Prisma.sql`count(*)::int AS "count"`,
    ];
    if (q.max !== undefined) {
      // a value that is not a JSON number (a null, or data from before a contract change) is skipped
      columns.push(
        Prisma.sql`max(CASE WHEN jsonb_typeof(e."data"->(${q.max}::text)) = 'number'
                            THEN (e."data"->>(${q.max}::text))::double precision END) AS "max"`,
      );
    }
    // ordinals: the same expression twice would carry two different bound parameters
    const ordinals = Prisma.raw(
      Array.from({ length: 1 + groups.length }, (_, i) => i + 1).join(', '),
    );

    const rows = await this.prisma.$queryRaw<StatsRow[]>(Prisma.sql`
      SELECT ${Prisma.join(columns)}
        FROM "Event" e
       WHERE ${Prisma.join(where, ' AND ')}
       GROUP BY ${ordinals}
       ORDER BY ${ordinals}`);

    return {
      bucket: q.bucket,
      rows: rows.map((r) => ({
        bucketStart: r.bucketStart.toISOString(),
        group: Object.fromEntries(
          groups.map((g, i) => [g.key, (r[`g${i}`] as string | null) ?? null]),
        ),
        count: r.count,
        ...(q.max !== undefined ? { max: r.max ?? null } : {}),
      })),
    };
  }
}
