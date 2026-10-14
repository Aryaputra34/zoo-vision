import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { RangeQueryDto } from '../../reports/report-query';
import {
  DEFAULT_LIMIT,
  EventRowDto,
  MAX_LIMIT,
} from '../../reports/dto/list.dto';

/** The time range every system-log route takes. */
export class TimeRangeDto extends PickType(RangeQueryDto, [
  'from',
  'to',
] as const) {}

/** Paging by row id: the `nextCursor` of the last page is the id to continue below. */
export class IdPageDto extends TimeRangeDto {
  @ApiPropertyOptional({ description: 'The `nextCursor` of the previous page' })
  @IsOptional()
  @Matches(/^\d{1,18}$/)
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

export class AuditFilterDto extends TimeRangeDto {
  @ApiPropertyOptional({ description: 'Part of the actor name, any case' })
  @IsOptional()
  @IsString()
  actor?: string;

  @ApiPropertyOptional({
    example: 'camera',
    description: 'The entity, exactly',
  })
  @IsOptional()
  @IsString()
  entity?: string;

  @ApiPropertyOptional({
    example: 'camera_config.save',
    description: 'The action, exactly',
  })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description: 'Only rows about audit cameras (true), or only the others',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  auditCamera?: 'true' | 'false';
}

export class AuditQueryDto extends AuditFilterDto {
  @ApiPropertyOptional({ description: 'The `nextCursor` of the previous page' })
  @IsOptional()
  @Matches(/^\d{1,18}$/)
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

export const LOGIN_RESULTS = [
  'SUCCESS',
  'WRONG_PASSWORD',
  'DISABLED',
  'LOCKED',
  'RATE_LIMITED',
  'LOGOUT',
] as const;

export class LoginFilterDto extends TimeRangeDto {
  @ApiPropertyOptional({
    description: 'Part of the username as typed, any case',
  })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({ enum: LOGIN_RESULTS })
  @IsOptional()
  @IsIn(LOGIN_RESULTS)
  result?: (typeof LOGIN_RESULTS)[number];
}

export class LoginQueryDto extends LoginFilterDto {
  @ApiPropertyOptional({ description: 'The `nextCursor` of the previous page' })
  @IsOptional()
  @Matches(/^\d{1,18}$/)
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

export class SystemEventsFilterDto extends TimeRangeDto {
  @ApiPropertyOptional({
    description: 'System event types, comma separated',
    example: 'engine_started,config_rejected',
  })
  @IsOptional()
  @IsString()
  types?: string;
}

export class SystemEventsQueryDto extends SystemEventsFilterDto {
  @ApiPropertyOptional({ description: 'The `nextCursor` of the previous page' })
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

export class AuditRowDto {
  @ApiProperty({ description: 'A number as a string (64-bit)' })
  id!: string;
  @ApiProperty({ description: 'UTC' }) time!: string;
  @ApiProperty({ description: 'user or token' }) actorType!: string;
  actorName!: string;
  action!: string;
  entity!: string;
  @ApiProperty({ type: String, nullable: true }) entityId!: string | null;
  @ApiProperty({
    nullable: true,
    description: 'What the entity was, secrets redacted',
  })
  before!: unknown;
  @ApiProperty({
    nullable: true,
    description: 'What it became, secrets redacted',
  })
  after!: unknown;
  @ApiProperty({ type: String, nullable: true }) ip!: string | null;
  @ApiProperty({ description: 'A change to a camera with auditCamera set' })
  auditCamera!: boolean;
}

export class AuditPageDto {
  @ApiProperty({ type: [AuditRowDto], description: 'Newest first' })
  rows!: AuditRowDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class LoginRowDto {
  @ApiProperty({ description: 'A number as a string (64-bit)' })
  id!: string;
  @ApiProperty({ description: 'UTC' }) time!: string;
  @ApiProperty({ description: 'As typed at the login' }) username!: string;
  @ApiProperty({ type: String, nullable: true }) userId!: string | null;
  @ApiProperty({ enum: LOGIN_RESULTS, enumName: 'LoginResult' })
  result!: (typeof LOGIN_RESULTS)[number];
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The client address',
  })
  ip!: string | null;
  @ApiProperty({ type: String, nullable: true }) userAgent!: string | null;
}

export class LoginPageDto {
  @ApiProperty({ type: [LoginRowDto], description: 'Newest first' })
  rows!: LoginRowDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class SystemEventsPageDto {
  @ApiProperty({ type: [EventRowDto], description: 'Newest first' })
  rows!: EventRowDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
