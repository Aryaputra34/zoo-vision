import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { AiModel } from '../../generated/prisma/client';

/** The text fields of the multipart upload; the `file` part is read by multer. */
export class UploadModelDto {
  @ApiPropertyOptional({ description: 'Defaults to the file name' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  version?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

/** An AiModel row as the API returns it: `sizeBytes` is a number. */
export type ModelView = Omit<AiModel, 'sizeBytes'> & {
  sizeBytes: number | null;
};

export function toModelView(row: AiModel): ModelView {
  return {
    ...row,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
  };
}

export type RescanResult = {
  added: ModelView[];
  skipped: { file: string; reason: string }[];
};
