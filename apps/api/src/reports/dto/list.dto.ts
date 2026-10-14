import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { RangeQueryDto } from '../report-query';

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

const SEVERITIES = ['info', 'warning', 'critical'] as const;

/** The filters of the event list, shared with the CSV export. */
export class EventFilterDto extends RangeQueryDto {
  @ApiPropertyOptional({
    description: 'Event types, comma separated. Needed with `where`',
  })
  @IsOptional()
  @IsString()
  types?: string;

  @ApiPropertyOptional({
    example: 'warning,critical',
    description: 'Severities, comma separated: info, warning, critical',
  })
  @IsOptional()
  @IsString()
  severity?: string;

  @ApiPropertyOptional({
    example: 'data.direction:ENTRY,data.vehicleType:bus',
    description:
      'At most two `data.<field>:<value>` equality filters, comma separated, on string or enum fields the requested types declare. A value can not contain a comma',
  })
  @IsOptional()
  @IsString()
  where?: string;
}

export class EventListQueryDto extends EventFilterDto {
  @ApiPropertyOptional({
    description: 'The `nextCursor` of the previous page; opaque',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    type: Number,
    default: DEFAULT_LIMIT,
    maximum: MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit?: number;
}

/** The filters of the interval list (the range applies to `start`), shared with the CSV export. */
export class IntervalFilterDto extends RangeQueryDto {
  @ApiPropertyOptional({ description: 'One interval kind' })
  @IsOptional()
  @IsString()
  kind?: string;
}

export class IntervalListQueryDto extends IntervalFilterDto {
  @ApiPropertyOptional({
    description: 'The `nextCursor` of the previous page; opaque',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    type: Number,
    default: DEFAULT_LIMIT,
    maximum: MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit?: number;
}

export class EventRowDto {
  id!: string;

  @ApiProperty({ description: 'UTC' })
  time!: string;

  @ApiProperty({ type: String, nullable: true })
  cameraId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  cameraName!: string | null;

  useCase!: string;
  type!: string;

  @ApiProperty({ enum: SEVERITIES, enumName: 'Severity' })
  severity!: 'info' | 'warning' | 'critical';

  @ApiProperty({ type: Number, nullable: true })
  configVersion!: number | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: "The event's `data` (see its type's schema in /usecases)",
  })
  data!: object;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A /media/snapshots URL; null without a snapshot',
  })
  snapshotUrl!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'A /media/clips URL; null when the camera has no recording path or recording is off. The clip itself can still be gone',
  })
  clipUrl!: string | null;
}

export class IntervalRowDto {
  id!: string;
  cameraId!: string;
  cameraName!: string;
  useCase!: string;
  kind!: string;

  @ApiProperty({ type: String, nullable: true })
  subjectId!: string | null;

  @ApiProperty({ description: 'UTC' })
  start!: string;

  @ApiProperty({ type: String, nullable: true, description: 'null while open' })
  end!: string | null;

  @ApiProperty({ type: String, nullable: true })
  endReason!: string | null;

  @ApiProperty({ type: Number, nullable: true, description: 'null while open' })
  durationSec!: number | null;

  @ApiProperty({ type: 'object', additionalProperties: true })
  data!: object;
}

export class EventPageDto {
  @ApiProperty({ type: [EventRowDto], description: 'Newest first' })
  rows!: EventRowDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Pass as `cursor` for the next page; null on the last',
  })
  nextCursor!: string | null;
}

export class IntervalPageDto {
  @ApiProperty({ type: [IntervalRowDto], description: 'Newest start first' })
  rows!: IntervalRowDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Pass as `cursor` for the next page; null on the last',
  })
  nextCursor!: string | null;
}
