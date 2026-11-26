import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
  ValidateIf,
  buildMessage,
} from 'class-validator';
import { isTimeZone } from '../../config/env';
import { Optional } from '../../cameras/dto/camera-fields.dto';

const DAYS = { type: Number, minimum: 1, maximum: 3650 } as const;
const Nullable = () => ValidateIf((_o, v) => v !== undefined && v !== null);

function isBrandLogoUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length < 1 || value.length > 500) {
    return false;
  }
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const IsBrandLogoUrl = () =>
  ValidateBy({
    name: 'isBrandLogoUrl',
    validator: {
      validate: (v: unknown) => isBrandLogoUrl(v),
      defaultMessage: buildMessage(
        (each) =>
          `${each}$property must be an http(s) URL or a relative path starting with /`,
      ),
    },
  });

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

export class SiteBrandingDto {
  @ApiProperty() siteName!: string;
  @ApiProperty({ type: String, nullable: true })
  brandSubtitle!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Relative path (/...) or http(s) URL to the site logo',
  })
  brandLogoUrl!: string | null;
}

export class SiteSettingsDto extends SiteBrandingDto {
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

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 160 })
  @Nullable()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  brandSubtitle?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 500,
    description: 'Relative path (/...) or http(s) URL; null clears the logo',
  })
  @Nullable()
  @IsBrandLogoUrl()
  brandLogoUrl?: string | null;

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
