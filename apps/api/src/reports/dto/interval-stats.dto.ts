import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { BUCKETS, type Bucket } from '../buckets';
import { BucketQueryDto } from './event-stats.dto';

export const INTERVAL_GROUPS = ['camera', 'subject'] as const;

export class IntervalStatsQueryDto extends BucketQueryDto {
  @ApiProperty({ example: 'desk_unattended', description: 'The interval kind' })
  @IsString()
  @IsNotEmpty()
  kind!: string;

  @ApiPropertyOptional({
    enum: INTERVAL_GROUPS,
    description:
      '`camera`, or `subject` (a table id; rows then carry `cameraId` too, because an id is only unique within its camera)',
  })
  @IsOptional()
  @IsIn(INTERVAL_GROUPS)
  groupBy?: (typeof INTERVAL_GROUPS)[number];
}

export class IntervalStatsRowDto {
  @ApiProperty({
    description: 'UTC, the start of the bucket in the site time zone',
  })
  bucketStart!: string;

  @ApiPropertyOptional({ description: 'With groupBy camera or subject' })
  cameraId?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'With groupBy subject; null for intervals without a subject',
  })
  subjectId?: string | null;

  @ApiProperty({ description: 'Intervals that start in the bucket' })
  count!: number;

  @ApiProperty({
    description:
      'Seconds inside the bucket and the range: an interval crossing an edge is split. An open interval counts up to now, or `to` if earlier',
  })
  totalSec!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Mean whole duration of the intervals that start in the bucket; null when none does',
  })
  avgSec!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Longest whole duration of those; null when none starts here',
  })
  maxSec!: number | null;
}

export class IntervalStatsDto {
  @ApiProperty({ enum: BUCKETS, enumName: 'Bucket' })
  bucket!: Bucket;

  @ApiProperty({
    type: [IntervalStatsRowDto],
    description:
      'Non-empty buckets only, ordered by bucketStart, then camera, then subject',
  })
  rows!: IntervalStatsRowDto[];
}
