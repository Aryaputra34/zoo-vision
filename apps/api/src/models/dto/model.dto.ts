import { BadRequestException } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { AiModel } from '../../generated/prisma/client';
import {
  ModelFormat,
  ModelSource,
  ModelStatus,
} from '../../generated/prisma/enums';

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
export class ModelViewDto {
  id!: string;
  name!: string;
  version!: string | null;
  @ApiProperty({ enum: ModelFormat, enumName: 'ModelFormat' })
  format!: ModelFormat;
  @ApiProperty({ enum: ModelSource, enumName: 'ModelSource' })
  source!: ModelSource;
  @ApiProperty({ enum: ModelStatus, enumName: 'ModelStatus' })
  status!: ModelStatus;
  /** Relative to the models folder, "/" separators. */
  filePath!: string;
  originalName!: string;
  sha256!: string | null;
  sizeBytes!: number | null;
  @ApiProperty({ type: [String], nullable: true })
  classNames!: string[] | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: '{ ok, latencyMs?, device?, error?, at } after a validation',
  })
  validation!: Record<string, unknown> | null;
  convertedFromId!: string | null;
  createdById!: string | null;
  notes!: string | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export class RescanSkippedDto {
  file!: string;
  reason!: string;
}

export class RescanResultDto {
  @ApiProperty({ type: [ModelViewDto] }) added!: ModelViewDto[];
  @ApiProperty({ type: [RescanSkippedDto] }) skipped!: RescanSkippedDto[];
}

export class ConvertResultDto {
  source!: ModelViewDto;
  target!: ModelViewDto;
}

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

const REASON_MAX = 500;
const SHA256 = /^[0-9a-f]{64}$/i;
const IMGSZ_DEFAULT = 640;

export type ValidationReport =
  | { ok: true; classNames: string[]; latencyMs: number; device: string }
  | { ok: false; error: string };

export type ConversionReport =
  { ok: true; path: string; sha256: string } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const reason = (v: unknown): string => {
  if (typeof v !== 'string' || v.length === 0) {
    throw new BadRequestException('error must be a non-empty string');
  }
  return v.slice(0, REASON_MAX);
};

/** Parses the engine's validation report; a reason is cut to 500 characters. */
export function parseValidationReport(body: unknown): ValidationReport {
  if (!isObject(body) || typeof body.ok !== 'boolean') {
    throw new BadRequestException('ok must be a boolean');
  }
  if (!body.ok) return { ok: false, error: reason(body.error) };
  const { classNames, latencyMs, device } = body;
  if (
    !Array.isArray(classNames) ||
    !classNames.every((c) => typeof c === 'string') ||
    typeof latencyMs !== 'number' ||
    !Number.isFinite(latencyMs) ||
    typeof device !== 'string'
  ) {
    throw new BadRequestException(
      'classNames (string[]), latencyMs (number) and device (string) are required',
    );
  }
  return { ok: true, classNames, latencyMs, device };
}

/** Parses the engine's conversion report. */
export function parseConversionReport(body: unknown): ConversionReport {
  if (!isObject(body) || typeof body.ok !== 'boolean') {
    throw new BadRequestException('ok must be a boolean');
  }
  if (!body.ok) return { ok: false, error: reason(body.error) };
  if (typeof body.path !== 'string' || typeof body.sha256 !== 'string') {
    throw new BadRequestException('path and sha256 are required');
  }
  if (!SHA256.test(body.sha256)) {
    throw new BadRequestException('sha256 must be 64 hex digits');
  }
  return { ok: true, path: body.path, sha256: body.sha256.toLowerCase() };
}

const validSide = (n: unknown): n is number =>
  typeof n === 'number' &&
  Number.isInteger(n) &&
  n >= 32 &&
  n <= 4096 &&
  n % 32 === 0;

/** The `imgsz` of a convert request: a size or [h, w], multiples of 32 in 32..4096; default 640. */
export function parseImgsz(body: unknown): number | [number, number] {
  if (body === undefined || body === null) return IMGSZ_DEFAULT;
  if (!isObject(body)) throw new BadRequestException('Body must be an object');
  const { imgsz } = body;
  if (imgsz === undefined) return IMGSZ_DEFAULT;
  if (validSide(imgsz)) return imgsz;
  if (Array.isArray(imgsz) && imgsz.length === 2 && imgsz.every(validSide)) {
    return [imgsz[0], imgsz[1]];
  }
  throw new BadRequestException(
    'imgsz must be a number or [number, number], each a multiple of 32 between 32 and 4096',
  );
}
