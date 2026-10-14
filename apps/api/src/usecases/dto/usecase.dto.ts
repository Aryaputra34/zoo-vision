import { ApiProperty } from '@nestjs/swagger';

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  description: 'A JSON Schema (draft 2020-12)',
} as const;

export class UseCaseEventDto {
  /** The `type` of an `event` message. */
  type!: string;
  @ApiProperty(JSON_SCHEMA) schema!: object;
}

export class UseCaseIntervalDto {
  /** The `kind` of an `interval_open` message. */
  kind!: string;
  @ApiProperty(JSON_SCHEMA) schema!: object;
}

export class UseCaseMetricDto {
  name!: string;
  label!: string;
  unit!: string;
}

/** One use case: what a camera can be assigned to do, and what it reports. */
export class UseCaseDto {
  id!: string;
  label!: string;
  schemaVersion!: number;
  /** False for `system`, which has no settings and cannot be given to a camera. */
  assignable!: boolean;
  @ApiProperty({
    ...JSON_SCHEMA,
    nullable: true,
    description:
      'The camera settings schema, dereferenced, with defaults, x-geometry ("polygon", "line", "polygon-list") and x-minRole',
  })
  settingsSchema!: object | null;
  @ApiProperty({
    ...JSON_SCHEMA,
    nullable: true,
    description: 'The shape of `live` in the camera status',
  })
  liveSchema!: object | null;
  @ApiProperty({ type: [UseCaseEventDto] }) events!: UseCaseEventDto[];
  @ApiProperty({ type: [UseCaseIntervalDto] })
  intervals!: UseCaseIntervalDto[];
  @ApiProperty({ type: [UseCaseMetricDto] }) metrics!: UseCaseMetricDto[];
}
