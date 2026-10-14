import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { bucketsBetween } from './buckets';
import type {
  IntervalStatsDto,
  IntervalStatsQueryDto,
} from './dto/interval-stats.dto';
import { assertRange, parseRange, scopeFilters } from './report-query';

type Row = {
  bucketStart: Date;
  cameraId?: string;
  subjectId?: string | null;
  count: number;
  totalSec: number;
  avgSec: number | null;
  maxSec: number | null;
};

@Injectable()
export class IntervalStatsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Splits every interval of the kind that overlaps [from, to) over the buckets it touches.
   * `totalSec` is what lies inside bucket and range; `count`, `avgSec` and `maxSec` come from the
   * piece in the bucket where the interval starts (and only if it starts at or after `from`).
   */
  async stats(q: IntervalStatsQueryDto): Promise<IntervalStatsDto> {
    const range = parseRange(q);
    assertRange(range, q.bucket);
    const from = Prisma.sql`${range.from.toISOString()}::timestamptz`;
    const to = Prisma.sql`${range.to.toISOString()}::timestamptz`;

    const where: Prisma.Sql[] = [
      Prisma.sql`i."kind" = ${q.kind}`,
      Prisma.sql`i."start" < ${to}`,
      ...scopeFilters('i', range),
    ];
    const keys =
      q.groupBy === 'camera'
        ? ['cameraId']
        : q.groupBy === 'subject'
          ? ['cameraId', 'subjectId']
          : [];
    // `keys` is one of the fixed lists above, so it is safe as SQL text
    const keyColumns = Prisma.raw(keys.map((k) => `p."${k}", `).join(''));
    // ordinals, so the SELECT list and GROUP BY are the same expressions
    const ordinals = Prisma.raw(
      Array.from({ length: 1 + keys.length }, (_, i) => i + 1).join(', '),
    );
    const buckets = bucketsBetween(
      q.bucket,
      this.env.SITE_TIMEZONE,
      Prisma.sql`c."lo"`,
      // the last instant inside the piece, so an interval ending on an edge opens no extra bucket
      Prisma.sql`GREATEST(c."hi" - INTERVAL '1 microsecond', c."lo")`,
    );

    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      WITH iv AS (
        SELECT i."cameraId", i."subjectId", i."start",
               COALESCE(i."end", LEAST(now(), ${to})) AS "finish"
          FROM "Interval" i
         WHERE ${Prisma.join(where, ' AND ')}
      ), clipped AS (
        SELECT iv.*,
               GREATEST(iv."start", ${from}) AS "lo",
               GREATEST(LEAST(iv."finish", ${to}), iv."start") AS "hi"
          FROM iv
         WHERE iv."start" >= ${from} OR iv."finish" > ${from}
      ), pieces AS (
        SELECT b."bstart", c."cameraId", c."subjectId",
               (c."start" >= ${from} AND c."start" >= b."bstart" AND c."start" < b."bend") AS "startsHere",
               EXTRACT(EPOCH FROM LEAST(c."hi", b."bend") - GREATEST(c."lo", b."bstart")) AS "insideSec",
               EXTRACT(EPOCH FROM GREATEST(c."finish" - c."start", INTERVAL '0')) AS "wholeSec"
          FROM clipped c
         CROSS JOIN LATERAL (${buckets}) b
      )
      SELECT p."bstart" AS "bucketStart", ${keyColumns}
             count(*) FILTER (WHERE p."startsHere")::int AS "count",
             COALESCE(sum(p."insideSec"), 0)::double precision AS "totalSec",
             (avg(p."wholeSec") FILTER (WHERE p."startsHere"))::double precision AS "avgSec",
             (max(p."wholeSec") FILTER (WHERE p."startsHere"))::double precision AS "maxSec"
        FROM pieces p
       GROUP BY ${ordinals}
       ORDER BY ${ordinals}`);

    return {
      bucket: q.bucket,
      rows: rows.map((r) => ({
        bucketStart: r.bucketStart.toISOString(),
        ...(keys.includes('cameraId') ? { cameraId: r.cameraId } : {}),
        ...(keys.includes('subjectId')
          ? { subjectId: r.subjectId ?? null }
          : {}),
        count: r.count,
        totalSec: r.totalSec,
        avgSec: r.avgSec,
        maxSec: r.maxSec,
      })),
    };
  }
}
