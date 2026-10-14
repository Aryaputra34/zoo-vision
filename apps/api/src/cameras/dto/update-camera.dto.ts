import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';
import { SourceType } from '../../generated/prisma/enums';
import { CameraFieldsDto, Optional } from './camera-fields.dto';

/** Any create field except id, useCase, settings and note. */
export class UpdateCameraDto extends CameraFieldsDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @Optional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ enum: SourceType, enumName: 'SourceType' })
  @Optional()
  @IsEnum(SourceType)
  sourceType?: SourceType;

  @ApiPropertyOptional({ maxLength: 2000 })
  @Optional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  mainStreamUrl?: string;
}
