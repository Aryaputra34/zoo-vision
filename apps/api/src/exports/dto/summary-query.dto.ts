import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { RangeQueryDto } from '../../reports/report-query';

/** `summary.csv`: one row per camera and bucket. Range limits are those of the bucket. */
export class SummaryQueryDto extends RangeQueryDto {
  @ApiProperty({ enum: ['hour', 'day'] })
  @IsIn(['hour', 'day'])
  bucket!: 'hour' | 'day';
}
