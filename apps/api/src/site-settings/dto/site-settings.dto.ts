import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
  buildMessage,
} from 'class-validator';
import { isTimeZone } from '../../config/env';
import { Optional } from '../../cameras/dto/camera-fields.dto';

const DAYS = { type: Number, minimum: 1, maximum: 3650 } as const;

const IsTimeZone = () =>
  ValidateBy({
    name: 'isTimeZone',
    validator: {
      validate: (v: unknown) => typeof v === 'string' && isTimeZone(v),
      defaultMessage: buildMessage(
        (each) =>
          `${each}$property must be an IANA time zone, such as Asia/Jakarta`,
      ),
    },
  });

export class SiteSettingsDto {
  @ApiProperty() siteName!: string;
  @ApiProperty({ example: 'Asia/Jakarta', description: 'IANA zone' })
  timeZone!: string;
  @ApiProperty(DAYS) recordingRetentionDays!: number;
  @ApiProperty(DAYS) snapshotRetentionDays!: number;
  @ApiProperty(DAYS) auditSnapshotRetentionDays!: number;
  @ApiProperty(DAYS) evidenceRetentionDays!: number;
}

export class UpdateSiteSettingsDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @Optional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  siteName?: string;

  @ApiPropertyOptional({ example: 'Asia/Jakarta' })
  @Optional()
  @IsTimeZone()
  timeZone?: string;

  @ApiPropertyOptional(DAYS)
  @Optional()
  @IsInt()
  @Min(1)
  @Max(3650)
  recordingRetentionDays?: number;

  @ApiPropertyOptional(DAYS)
  @Optional()
  @IsInt()
  @Min(1)
  @Max(3650)
  snapshotRetentionDays?: number;

  @ApiPropertyOptional(DAYS)
  @Optional()
  @IsInt()
  @Min(1)
  @Max(3650)
  auditSnapshotRetentionDays?: number;

  @ApiPropertyOptional(DAYS)
  @Optional()
  @IsInt()
  @Min(1)
  @Max(3650)
  evidenceRetentionDays?: number;
}
