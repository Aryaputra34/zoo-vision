import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { StreamChoice } from '../../generated/prisma/enums';

/** Absent (undefined) skips validation. */
export const Optional = () => ValidateIf((_o, v) => v !== undefined);
/** Absent (undefined) or null skips validation; null means "clear". */
const Nullable = () => ValidateIf((_o, v) => v !== undefined && v !== null);

export const CAMERA_ID_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

export class RecordingDto {
  @ApiPropertyOptional()
  @Optional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ enum: StreamChoice, enumName: 'StreamChoice' })
  @Optional()
  @IsEnum(StreamChoice)
  stream?: StreamChoice;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 3650,
    description: 'null = site default',
  })
  @Nullable()
  @IsInt()
  @Min(1)
  @Max(3650)
  retentionDays?: number | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 300 })
  @Optional()
  @IsInt()
  @Min(0)
  @Max(300)
  clipBeforeSec?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 300 })
  @Optional()
  @IsInt()
  @Min(0)
  @Max(300)
  clipAfterSec?: number;
}

/** Fields that are optional on both create and update. null clears the nullable ones. */
export class CameraFieldsDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 100 })
  @Nullable()
  @IsString()
  @MaxLength(100)
  area?: string | null;

  @ApiPropertyOptional()
  @Optional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @Nullable()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  subStreamUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @Nullable()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  recordingPath?: string | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 30 })
  @Optional()
  @IsInt()
  @Min(1)
  @Max(30)
  targetFps?: number;

  @ApiPropertyOptional({ pattern: '^[a-z0-9_-]{1,32}$' })
  @Optional()
  @IsString()
  @Matches(/^[a-z0-9_-]{1,32}$/)
  engineGroup?: string;

  @ApiPropertyOptional()
  @Optional()
  @IsBoolean()
  auditCamera?: boolean;

  @ApiPropertyOptional({
    enum: StreamChoice,
    enumName: 'StreamChoice',
    description:
      'Stream the engine decodes. SUB falls back to the main URL without a sub URL. SUPERADMIN only.',
  })
  @Optional()
  @IsEnum(StreamChoice)
  inferenceStream?: StreamChoice;

  @ApiPropertyOptional({ type: RecordingDto })
  @Optional()
  @IsObject()
  @ValidateNested()
  @Type(() => RecordingDto)
  recording?: RecordingDto;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 })
  @Nullable()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nxCameraId?: string | null;
}
