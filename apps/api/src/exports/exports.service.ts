import { Injectable } from '@nestjs/common';
import { ContractsService } from '../contracts/contracts.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SiteSettingsService } from '../site-settings/site-settings.service';
import type {
  EventFilterDto,
  IntervalFilterDto,
} from '../reports/dto/list.dto';
import { EventStatsService } from '../reports/event-stats.service';
import { IntervalStatsService } from '../reports/interval-stats.service';
import { keysetAfter } from '../reports/keyset';
import { ListsService } from '../reports/lists.service';
import { MetricSeriesService } from '../reports/metric-series.service';
import {
  assertRange,
  parseRange,
  scopeFilters,
  splitList,
  type Range,
  type RangeQueryDto,
} from '../reports/report-query';
import {
  EVENT_INCLUDE,
  eventRow,
  INTERVAL_CAMERA,
  intervalRow,
  type EventWithCamera,
  type IntervalWithCamera,
} from '../reports/rows';
import {
  dataFields,
  eventColumns,
  INTERVAL_COLUMNS,
  METRIC_COLUMNS,
  summaryColumns,
} from './csv-columns';
import { localDateTime } from './csv';
import type { SummaryQueryDto } from './dto/summary-query.dto';

/** Rows read from the database, and written to the socket, at a time. */
export const BATCH = 5000;

export type CsvExport = {
  kind: string;
  /** The `Content-Disposition` file name. */
  filename: string;
  header: string[];
  /** What the audit row records: the request's own parameters. */
  filters: Record<string, string>;
  batches: AsyncIterable<unknown[][]>;
};

type MetricRow = {
  cameraId: string;
  cameraName: string;
  useCase: string;
  name: string;
  minute: Date;
  value: number;
};

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Prepares the four CSV exports. Each method validates its filters at once (so a bad request is
 * a 400 before anything is audited or sent) and returns the header and a lazy source of row
 * batches read by keyset, so nothing but one batch is in memory.
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lists: ListsService,
    private readonly contracts: ContractsService,
    private readonly eventStats: EventStatsService,
    private readonly intervalStats: IntervalStatsService,
    private readonly metricSeries: MetricSeriesService,
    private readonly settings: SiteSettingsService,
  ) {}

  events(q: EventFilterDto): CsvExport {
    const where = this.lists.eventWhere(q);
    const range = parseRange(q);
    const types = splitList(q.types, '/types');
    const registry = this.contracts.registry;
    const fields = dataFields(registry, range.useCase, types);
    return {
      kind: 'events',
      filename: this.filename('events', range),
      header: eventColumns(registry, range.useCase, types),
      filters: filtersOf(q),
      batches: this.eventBatches(where, fields),
    };
  }

  intervals(q: IntervalFilterDto): CsvExport {
    const where = this.lists.intervalWhere(q);
    return {
      kind: 'intervals',
      filename: this.filename('intervals', parseRange(q)),
      header: INTERVAL_COLUMNS,
      filters: filtersOf(q),
      batches: this.intervalBatches(where),
    };
  }

  metrics(q: RangeQueryDto): CsvExport {
    const range = parseRange(q);
    return {
      kind: 'metrics',
      filename: this.filename('metrics', range),
      header: METRIC_COLUMNS,
      filters: filtersOf(q),
      batches: this.metricBatches(range),
    };
  }

  summary(q: SummaryQueryDto): CsvExport {
    const range = parseRange(q);
    assertRange(range, q.bucket);
    const header = summaryColumns(this.contracts.registry, range.useCase);
    return {
      kind: 'summary',
      filename: this.filename('summary', range),
      header,
      filters: filtersOf(q),
      batches: this.summaryBatches(q, header),
    };
  }

  /** `<kind>-<from date>-<to date>.csv`, the dates on the site's wall clock. */
  filename(kind: string, range: Range): string {
    const local = localDateTime(this.settings.timeZone);
    const day = (at: Date) => local(at).slice(0, 10);
    return `${kind}-${day(range.from)}-${day(range.to)}.csv`;
  }

  private async *eventBatches(
    where: Prisma.EventWhereInput,
    fields: string[] | null,
  ): AsyncGenerator<unknown[][]> {
    const local = localDateTime(this.settings.timeZone);
    let after: { time: Date; id: string } | undefined;
    for (;;) {
      const rows: EventWithCamera[] = await this.prisma.event.findMany({
        where: after
          ? {
              AND: [
                where,
                keysetAfter<Prisma.EventWhereInput>(
                  'time',
                  { value: after.time, id: after.id },
                  'asc',
                ),
              ],
            }
          : where,
        orderBy: [{ time: 'asc' }, { id: 'asc' }],
        take: BATCH,
        include: EVENT_INCLUDE,
      });
      if (rows.length > 0)
        yield rows.map((e) => this.eventCells(e, fields, local));
      if (rows.length < BATCH) return;
      const last = rows[rows.length - 1];
      after = { time: last.time, id: last.id };
    }
  }

  private eventCells(
    e: EventWithCamera,
    fields: string[] | null,
    local: (at: Date) => string,
  ): unknown[] {
    const row = eventRow(e);
    const data = e.data as Record<string, unknown>;
    return [
      local(e.time),
      e.id,
      e.cameraId,
      row.cameraName,
      e.useCase,
      e.type,
      e.severity,
      e.configVersion,
      ...(fields ? fields.map((f) => data[f]) : [data]),
      row.snapshotUrl,
    ];
  }

  private async *intervalBatches(
    where: Prisma.IntervalWhereInput,
  ): AsyncGenerator<unknown[][]> {
    const local = localDateTime(this.settings.timeZone);
    let after: { start: Date; id: string } | undefined;
    for (;;) {
      const rows: IntervalWithCamera[] = await this.prisma.interval.findMany({
        where: after
          ? {
              AND: [
                where,
                keysetAfter<Prisma.IntervalWhereInput>(
                  'start',
                  { value: after.start, id: after.id },
                  'asc',
                ),
              ],
            }
          : where,
        orderBy: [{ start: 'asc' }, { id: 'asc' }],
        take: BATCH,
        include: INTERVAL_CAMERA,
      });
      if (rows.length > 0) {
        yield rows.map((i) => {
          const row = intervalRow(i);
          return [
            local(i.start),
            i.end ? local(i.end) : null,
            row.durationSec,
            i.id,
            i.cameraId,
            row.cameraName,
            i.useCase,
            i.kind,
            i.subjectId,
            i.endReason,
            i.data,
          ];
        });
      }
      if (rows.length < BATCH) return;
      const last = rows[rows.length - 1];
      after = { start: last.start, id: last.id };
    }
  }

  /** In primary key order (camera, name, minute), so every batch is an index range scan. */
  private async *metricBatches(range: Range): AsyncGenerator<unknown[][]> {
    const local = localDateTime(this.settings.timeZone);
    const base = [
      Prisma.sql`m."minute" >= ${range.from.toISOString()}::timestamptz`,
      Prisma.sql`m."minute" < ${range.to.toISOString()}::timestamptz`,
      ...scopeFilters('m', range),
    ];
    let after: MetricRow | undefined;
    for (;;) {
      const where = after
        ? [
            ...base,
            Prisma.sql`(m."cameraId", m."name", m."minute") >
              (${after.cameraId}, ${after.name}, ${after.minute.toISOString()}::timestamptz)`,
          ]
        : base;
      const rows = await this.prisma.$queryRaw<MetricRow[]>(Prisma.sql`
        SELECT m."cameraId", c."name" AS "cameraName", m."useCase", m."name", m."minute", m."value"
          FROM "Metric" m
          JOIN "Camera" c ON c."id" = m."cameraId"
         WHERE ${Prisma.join(where, ' AND ')}
         ORDER BY m."cameraId", m."name", m."minute"
         LIMIT ${BATCH}`);
      if (rows.length > 0) {
        yield rows.map((r) => [
          local(r.minute),
          r.cameraId,
          r.cameraName,
          r.useCase,
          r.name,
          r.value,
        ]);
      }
      if (rows.length < BATCH) return;
      after = rows[rows.length - 1];
    }
  }

  /**
   * One row per camera and bucket that has any data. The numbers come from the same services as
   * the report endpoints, so a CSV and a chart agree; the range limits keep it to a few thousand
   * rows, so it is built in memory and only written in batches.
   */
  private async *summaryBatches(
    q: SummaryQueryDto,
    header: string[],
  ): AsyncGenerator<unknown[][]> {
    const local = localDateTime(this.settings.timeZone);
    const base = {
      from: q.from,
      to: q.to,
      bucket: q.bucket,
      cameraIds: q.cameraIds,
      useCase: q.useCase,
    };
    const column = new Map(header.map((name, i) => [name, i]));
    const rows = new Map<string, unknown[]>();
    const cameras = new Set<string>();
    const put = (
      bucketStart: string,
      cameraId: string | null | undefined,
      name: string,
      value: number,
    ) => {
      const index = column.get(name);
      if (index === undefined || !cameraId) return;
      const key = `${bucketStart}|${cameraId}`;
      let row = rows.get(key);
      if (!row) {
        row = header.map((h, i) =>
          i < 4 ? null : h.startsWith('metrics.') ? null : 0,
        );
        row[0] = bucketStart;
        row[1] = cameraId;
        rows.set(key, row);
        cameras.add(cameraId);
      }
      row[index] = round3(value);
    };

    const events = await this.eventStats.stats({
      ...base,
      groupBy: 'camera,type',
    });
    for (const r of events.rows) {
      put(
        r.bucketStart,
        r.group.camera,
        `events.${r.group.type}.count`,
        r.count,
      );
    }
    for (const name of header) {
      const kind = /^intervals\.(.+)\.total_sec$/.exec(name)?.[1];
      if (kind) {
        const stats = await this.intervalStats.stats({
          ...base,
          kind,
          groupBy: 'camera',
        });
        for (const r of stats.rows) {
          put(r.bucketStart, r.cameraId, name, r.totalSec);
        }
      }
      const metric = /^metrics\.(.+)\.(avg|max)$/.exec(name);
      if (metric) {
        const series = await this.metricSeries.series({
          ...base,
          name: metric[1],
          agg: metric[2] as 'avg' | 'max',
        });
        for (const r of series.rows) {
          put(r.bucketStart, r.cameraId, name, r.value);
        }
      }
    }

    const found = await this.prisma.camera.findMany({
      where: { id: { in: [...cameras] } },
      select: { id: true, name: true, useCase: true },
    });
    const byId = new Map(found.map((c) => [c.id, c]));
    const out = [...rows.values()]
      .sort(
        (a, b) =>
          String(a[0]).localeCompare(String(b[0])) ||
          String(a[1]).localeCompare(String(b[1])),
      )
      .map((row) => {
        const camera = byId.get(row[1] as string);
        const bucketStart = row[0] as string;
        row[0] = local(new Date(bucketStart));
        row[2] = camera?.name ?? null;
        row[3] = camera?.useCase ?? null;
        return row;
      });
    for (let i = 0; i < out.length; i += BATCH) yield out.slice(i, i + BATCH);
  }
}

/** The request's parameters as given, without the empty ones. */
function filtersOf(q: object): Record<string, string> {
  return Object.fromEntries(
    Object.entries(q).filter(([, v]) => typeof v === 'string' && v !== '') as [
      string,
      string,
    ][],
  );
}
