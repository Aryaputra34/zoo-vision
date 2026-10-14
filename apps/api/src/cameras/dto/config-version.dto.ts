import { ApiProperty } from '@nestjs/swagger';

export class ConfigAuthorDto {
  /** `user`, `token` or `system`. */
  type!: string;
  name!: string;
}

/** A config version without its settings. The author's id is never exposed. */
export class ConfigVersionSummaryDto {
  version!: number;
  useCase!: string;
  schemaVersion!: number;
  note!: string | null;
  createdAt!: Date;
  author!: ConfigAuthorDto;
}

export class ConfigVersionDto extends ConfigVersionSummaryDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: "Validated against the use case's settings schema",
  })
  settings!: Record<string, unknown>;
}

/** One difference between a version and the one before it. */
export class ConfigChangeDto {
  /** JSON pointer into the settings; `/useCase` for a use case switch. */
  path!: string;
  @ApiProperty({ required: false }) before?: unknown;
  @ApiProperty({ required: false }) after?: unknown;
}

export class ConfigVersionDetailDto extends ConfigVersionDto {
  @ApiProperty({ type: [ConfigChangeDto] }) changes!: ConfigChangeDto[];
}

/** The version a save or a rollback created. */
export class SavedConfigDto {
  version!: number;
}
