import { Prisma } from '../generated/prisma/client';

export const BUCKETS = ['5m', '15m', 'hour', 'day'] as const;
export type Bucket = (typeof BUCKETS)[number];

const DAY_MS = 24 * 3600_000;

/** The longest `to - from` a bucket size accepts (a longer range would return too many rows). */
export const MAX_RANGE_MS: Record<Bucket, number> = {
  '5m': 2 * DAY_MS,
  '15m': 7 * DAY_MS,
  hour: 31 * DAY_MS,
  day: 400 * DAY_MS,
};

const STEP: Record<Exclude<Bucket, 'day'>, string> = {
  '5m': '5 minutes',
  '15m': '15 minutes',
  hour: '1 hour',
};

/**
 * SQL for the start (a timestamptz) of the bucket `column` falls in, with buckets aligned to the
 * wall clock of `tz`: a `day` bucket starts at local midnight, an `hour` at local :00, 5m/15m at
 * local multiples of 5/15 minutes. `tz` reaches SQL as a bound parameter; the unit comes from the
 * closed {@link Bucket} set.
 *
 * Hours and minutes are cut by subtracting "time since the local bucket start" from the instant,
 * not by truncating the wall clock and converting it back: that conversion is ambiguous in the
 * repeated hour of a DST fall-back and would merge two real hours into one bucket.
 */
export function bucketStart(
  bucket: Bucket,
  tz: string,
  column: Prisma.Sql,
): Prisma.Sql {
  const local = Prisma.sql`((${column}) AT TIME ZONE ${tz}::text)`;
  switch (bucket) {
    case 'day':
      return Prisma.sql`(date_trunc('day', ${local}) AT TIME ZONE ${tz}::text)`;
    case 'hour':
      return Prisma.sql`((${column}) - (${local} - date_trunc('hour', ${local})))`;
    default:
      return Prisma.sql`((${column}) - (${local} - date_bin(${Prisma.raw(`INTERVAL '${STEP[bucket]}'`)}, ${local}, TIMESTAMP '2000-01-01')))`;
  }
}

/**
 * SQL rows `("bstart", "bend")`, one per bucket from the one holding `first` to the one holding
 * `last` (both timestamptz expressions, `first <= last`). A day bucket ends at the next local
 * midnight, so it is 23 or 25 hours long across a DST change.
 */
export function bucketsBetween(
  bucket: Bucket,
  tz: string,
  first: Prisma.Sql,
  last: Prisma.Sql,
): Prisma.Sql {
  if (bucket === 'day') {
    return Prisma.sql`
      SELECT (d AT TIME ZONE ${tz}::text) AS "bstart",
             ((d + INTERVAL '1 day') AT TIME ZONE ${tz}::text) AS "bend"
        FROM generate_series(date_trunc('day', (${first}) AT TIME ZONE ${tz}::text),
                             date_trunc('day', (${last}) AT TIME ZONE ${tz}::text),
                             INTERVAL '1 day') AS d`;
  }
  const step = Prisma.raw(`INTERVAL '${STEP[bucket]}'`);
  return Prisma.sql`
    SELECT s AS "bstart", s + ${step} AS "bend"
      FROM generate_series(${bucketStart(bucket, tz, first)}, ${bucketStart(bucket, tz, last)}, ${step}) AS s`;
}
