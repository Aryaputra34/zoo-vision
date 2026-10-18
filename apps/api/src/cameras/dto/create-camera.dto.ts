import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsObject,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { SourceType } from '../../generated/prisma/enums';
import {
  CAMERA_ID_NOT_SUB,
  CAMERA_ID_PATTERN,
  CameraFieldsDto,
} from './camera-fields.dto';

export class CreateCameraDto extends CameraFieldsDto {
  @ApiProperty({ pattern: CAMERA_ID_PATTERN.source })
  @IsString()
  @Matches(CAMERA_ID_PATTERN)
  @Matches(CAMERA_ID_NOT_SUB, { message: 'id must not end with _sub' })
  id!: string;

  @ApiProperty({ minLength: 1, maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ description: 'An assignable use case (not "system")' })
  @IsString()
  useCase!: string;

  @ApiProperty({ enum: SourceType, enumName: 'SourceType' })
  @IsEnum(SourceType)
  sourceType!: SourceType;

  @ApiProperty({
    description:
      'rtsp:// or rtsps:// unless sourceType is FILE. Stored encrypted.',
    maxLength: 2000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  mainStreamUrl!: string;

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
