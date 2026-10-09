import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsObject,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class SaveConfigDto {
  @ApiProperty({ description: 'The version this edit started from' })
  @IsInt()
  @Min(1)
  baseVersion!: number;

  @ApiPropertyOptional({ description: 'Changing it needs SUPERADMIN' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  useCase?: string;

  @ApiProperty({
    description: 'Validated against the use case settings schema',
  })
  @IsObject()
  settings!: Record<string, unknown>;

  @ApiPropertyOptional({ maxLength: 500 })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RollbackConfigDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  baseVersion!: number;

  @ApiProperty({ description: 'The version to restore' })
  @IsInt()
  @Min(1)
  version!: number;
}
