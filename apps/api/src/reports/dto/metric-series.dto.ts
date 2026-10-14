import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { BUCKETS, type Bucket } from '../buckets';
import { BucketQueryDto } from './event-stats.dto';

export const METRIC_AGGS = ['avg', 'max', 'min'] as const;

export class MetricSeriesQueryDto extends BucketQueryDto {
  @ApiProperty({ example: 'occupancy', description: 'The metric name' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    enum: METRIC_AGGS,
    description: 'The aggregate per bucket. Give this or `above`, not both',
  })
  @IsOptional()
  @IsIn(METRIC_AGGS)
  agg?: (typeof METRIC_AGGS)[number];

  @ApiPropertyOptional({
    type: Number,
    description:
      'Instead of an aggregate: the minutes per bucket with a value at or above this',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === '' ? NaN : Number(value),
  )
  @IsNumber()
  above?: number;
}

export class MetricSeriesRowDto {
  @ApiProperty({
    description: 'UTC, the start of the bucket in the site time zone',
  })
  bucketStart!: string;

  cameraId!: string;

  @ApiProperty({
    description: 'The aggregate, or with `above` the number of minutes',
  })
  value!: number;
}

export class MetricSeriesDto {
  @ApiProperty({ enum: BUCKETS, enumName: 'Bucket' })
  bucket!: Bucket;

  @ApiProperty({
    type: [MetricSeriesRowDto],
    description:
      'Buckets with a value only, ordered by bucketStart, then camera',
  })
  rows!: MetricSeriesRowDto[];
}
