import { Injectable } from '@nestjs/common';
import { apiError } from '../common/errors';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SiteSettingsService } from '../site-settings/site-settings.service';
import { bucketStart } from './buckets';
import type {
  MetricSeriesDto,
  MetricSeriesQueryDto,
} from './dto/metric-series.dto';
import { assertRange, parseRange, scopeFilters } from './report-query';

type Row = { bucketStart: Date; cameraId: string; value: number };

@Injectable()
export class MetricSeriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SiteSettingsService,
  ) {}

  /** One value per camera and bucket: an aggregate of the minute rows, or the minutes at or above a threshold. */
  async series(q: MetricSeriesQueryDto): Promise<MetricSeriesDto> {
    if ((q.agg === undefined) === (q.above === undefined)) {
      throw apiError(400, 'VALIDATION_FAILED', 'Request validation failed', [
        { path: '/agg', message: 'give exactly one of agg and above' },
      ]);
    }
    const range = parseRange(q);
    assertRange(range, q.bucket);

    // `agg` is one of the closed METRIC_AGGS (validated), so it is safe as SQL text
    const value =
      q.agg !== undefined
        ? Prisma.sql`${Prisma.raw(q.agg)}(m."value")::double precision`
        : Prisma.sql`count(*) FILTER (WHERE m."value" >= ${q.above}::double precision)::double precision`;
    const where: Prisma.Sql[] = [
      Prisma.sql`m."name" = ${q.name}`,
      Prisma.sql`m."minute" >= ${range.from.toISOString()}::timestamptz`,
      Prisma.sql`m."minute" < ${range.to.toISOString()}::timestamptz`,
      ...scopeFilters('m', range),
    ];

    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT ${bucketStart(q.bucket, this.settings.timeZone, Prisma.sql`m."minute"`)} AS "bucketStart",
             m."cameraId", ${value} AS "value"
        FROM "Metric" m
       WHERE ${Prisma.join(where, ' AND ')}
       GROUP BY 1, 2
       ORDER BY 1, 2`);

    return {
      bucket: q.bucket,
      rows: rows.map((r) => ({
        bucketStart: r.bucketStart.toISOString(),
        cameraId: r.cameraId,
        value: r.value,
      })),
    };
  }
}
