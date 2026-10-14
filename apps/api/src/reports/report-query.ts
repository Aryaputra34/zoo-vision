import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { apiError } from '../common/errors';
import { type Bucket, MAX_RANGE_MS } from './buckets';

/** An ISO 8601 instant that carries its offset (`Z` or `+07:00`): a date alone is ambiguous. */
const INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** The most camera ids, types or `where` items one request may name. */
export const MAX_LIST_ITEMS = 50;

/** `from`, `to` and the camera filter every report, list and export takes. */
export class RangeQueryDto {
  @ApiProperty({
    example: '2026-10-14T00:00:00+07:00',
    description:
      'ISO 8601 with an offset, inclusive. Encode `+` as `%2B` in a URL.',
  })
  @IsString()
  from!: string;

  @ApiProperty({
    example: '2026-10-15T00:00:00+07:00',
    description: 'ISO 8601 with an offset, exclusive',
  })
  @IsString()
  to!: string;

  @ApiPropertyOptional({
    description: `Camera ids, comma separated, at most ${MAX_LIST_ITEMS}`,
  })
  @IsOptional()
  @IsString()
  cameraIds?: string;

  @ApiPropertyOptional({ description: 'One use case id' })
  @IsOptional()
  @IsString()
  useCase?: string;
}

export type Range = {
  from: Date;
  to: Date;
  cameraIds?: string[];
  useCase?: string;
};

function invalid(path: string, message: string) {
  return apiError(400, 'VALIDATION_FAILED', 'Request validation failed', [
    { path, message },
  ]);
}

function instant(value: string, path: string): Date {
  const date = INSTANT.test(value) ? new Date(value) : new Date(NaN);
  if (Number.isNaN(date.getTime())) {
    throw invalid(
      path,
      'must be an ISO 8601 date and time with an offset, e.g. 2026-10-14T00:00:00+07:00 (encode + as %2B)',
    );
  }
  return date;
}

/**
 * A comma separated query value as a list: trimmed, no empty items, at most `max` of them.
 * `undefined` or an empty string is no filter.
 */
export function splitList(
  value: string | undefined,
  path: string,
  max = MAX_LIST_ITEMS,
): string[] | undefined {
  if (value === undefined || value === '') return undefined;
  const items = value.split(',').map((s) => s.trim());
  if (items.some((s) => s === '')) {
    throw invalid(path, 'must not contain an empty item');
  }
  if (items.length > max) throw invalid(path, `at most ${max} items`);
  return [...new Set(items)];
}

/** Turns the query into instants and lists; 400 VALIDATION_FAILED for a bad date, from >= to or a bad list. */
export function parseRange(q: RangeQueryDto): Range {
  const from = instant(q.from, '/from');
  const to = instant(q.to, '/to');
  if (from.getTime() >= to.getTime()) {
    throw invalid('/to', 'must be after from');
  }
  return {
    from,
    to,
    cameraIds: splitList(q.cameraIds, '/cameraIds'),
    useCase: q.useCase || undefined,
  };
}

/** 400 RANGE_TOO_LONG when `to - from` exceeds what the bucket size allows. */
export function assertRange(
  range: { from: Date; to: Date },
  bucket: Bucket,
): void {
  const max = MAX_RANGE_MS[bucket];
  if (range.to.getTime() - range.from.getTime() > max) {
    throw apiError(
      400,
      'RANGE_TOO_LONG',
      `A ${bucket} bucket takes a range of at most ${max / 86_400_000} days`,
    );
  }
}
