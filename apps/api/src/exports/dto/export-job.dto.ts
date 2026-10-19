import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsString,
  Matches,
  ValidateBy,
  buildMessage,
} from 'class-validator';
import { Optional } from '../../cameras/dto/camera-fields.dto';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const IsRealDate = () =>
  ValidateBy({
    name: 'isRealDate',
    validator: {
      validate: (v: unknown) =>
        typeof v === 'string' &&
        DATE.test(v) &&
        new Date(`${v}T00:00:00Z`).toISOString().startsWith(v),
      defaultMessage: buildMessage(
        (each) => `${each}$property must be a real date, YYYY-MM-DD`,
      ),
    },
  });

export const EXPORT_MAX_CAMERAS = 50;

export class CreateExportJobDto {
  @ApiProperty({ enum: ['day', 'week', 'month'] })
  @IsIn(['day', 'week', 'month'])
  period!: 'day' | 'week' | 'month';

  @ApiProperty({
    example: '2026-10-14',
    description:
      'Local date on the site time zone: the day, the first day of the week, or any day of the month',
  })
  @Matches(DATE)
  @IsRealDate()
  date!: string;

  @ApiPropertyOptional({ type: [String], maxItems: EXPORT_MAX_CAMERAS })
  @Optional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(EXPORT_MAX_CAMERAS)
  @IsString({ each: true })
  cameraIds?: string[];

  @ApiPropertyOptional()
  @Optional()
  @IsString()
  useCase?: string;
}

export class ExportJobParamsDto {
  @ApiProperty({ enum: ['day', 'week', 'month'] }) period!:
    'day' | 'week' | 'month';
  @ApiProperty() date!: string;
  @ApiPropertyOptional({ type: [String] }) cameraIds?: string[];
  @ApiPropertyOptional() useCase?: string;
}

export class ExportJobDto {
  @ApiProperty() id!: string;
  @ApiProperty({ type: ExportJobParamsDto }) params!: ExportJobParamsDto;
  @ApiProperty({ enum: ['QUEUED', 'DONE', 'FAILED', 'EXPIRED'] })
  status!: 'QUEUED' | 'DONE' | 'FAILED' | 'EXPIRED';
  @ApiProperty({ type: String, nullable: true }) error!: string | null;
  @ApiProperty({ type: Number, nullable: true }) sizeBytes!: number | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: String, nullable: true }) finishedAt!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Set when DONE: /api/v1/exports/jobs/<id>/file',
  })
  fileUrl!: string | null;
}
