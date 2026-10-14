import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { BUCKETS, type Bucket } from '../buckets';
import { RangeQueryDto } from '../report-query';

/** The range and `bucket` every report takes. */
export class BucketQueryDto extends RangeQueryDto {
  @ApiProperty({ enum: BUCKETS, enumName: 'Bucket' })
  @IsIn(BUCKETS)
  bucket!: Bucket;
}

export class EventStatsQueryDto extends BucketQueryDto {
  @ApiPropertyOptional({
    description:
      'Event types, comma separated. Needed with `data.<field>` and `max`',
  })
  @IsOptional()
  @IsString()
  types?: string;

  @ApiPropertyOptional({
    example: 'camera,data.direction',
    description:
      'Comma separated: `camera`, `type`, `severity` and at most two `data.<field>` that a requested type declares as a string or enum',
  })
  @IsOptional()
  @IsString()
  groupBy?: string;

  @ApiPropertyOptional({
    example: 'waitingSec',
    description:
      'A `data` field a requested type declares as a number: its largest value per bucket',
  })
  @IsOptional()
  @IsString()
  max?: string;
}

export class EventStatsRowDto {
  @ApiProperty({
    description: 'UTC, the start of the bucket in the site time zone',
  })
  bucketStart!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string', nullable: true },
    description:
      'One key per `groupBy` item, spelled as requested (`camera`, `data.direction`); null where the event has no value. `{}` without `groupBy`.',
  })
  group!: Record<string, string | null>;

  count!: number;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Only with `max`',
  })
  max?: number | null;
}

export class EventStatsDto {
  @ApiProperty({ enum: BUCKETS, enumName: 'Bucket' })
  bucket!: Bucket;

  @ApiProperty({
    type: [EventStatsRowDto],
    description:
      'Non-empty buckets only, ordered by bucketStart and then the group values',
  })
  rows!: EventStatsRowDto[];
}
