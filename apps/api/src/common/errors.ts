import { HttpException } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ValidationError } from 'class-validator';

/** Stable, machine-readable error codes: the frontend switches on these (docs/fe-contract.md). */
export const ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'SETTINGS_INVALID',
  'FIELD_NOT_ALLOWED',
  'RANGE_TOO_LONG',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'ROLE_REQUIRED',
  'FORBIDDEN_ORIGIN',
  'NOT_FOUND',
  'RECORDING_NOT_AVAILABLE',
  'CONFLICT',
  'STALE_VERSION',
  'USERNAME_TAKEN',
  'LAST_SUPERADMIN',
  'CAMERA_HAS_DATA',
  'MODEL_IN_USE',
  'ACCOUNT_LOCKED',
  'TOO_LARGE',
  'RATE_LIMITED',
  'UNAVAILABLE',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** One problem with one field. `path` is a JSON pointer into the request body (or the settings). */
export class FieldError {
  @ApiProperty({ example: '/clerk_zone/0' }) path!: string;
  @ApiProperty() message!: string;
}

/** The body of every error response. */
export class ApiErrorBody {
  @ApiProperty() statusCode!: number;
  @ApiProperty({ enum: ERROR_CODES, enumName: 'ErrorCode' }) code!: ErrorCode;
  @ApiProperty() message!: string;
  @ApiPropertyOptional({ type: [FieldError] }) errors?: FieldError[];
}

/** An HttpException whose body is already the API's error shape; ErrorFilter sends it as is. */
export function apiError(
  status: number,
  code: ErrorCode,
  message: string,
  errors?: FieldError[],
): HttpException {
  const body: ApiErrorBody = {
    statusCode: status,
    code,
    message,
    ...(errors ? { errors } : {}),
  };
  return new HttpException(body, status);
}

/** 403 ROLE_REQUIRED naming each field (a settings pointer or a camera field) that needs SUPERADMIN. */
export function needsSuperadmin(
  message: string,
  fields: string[],
): HttpException {
  return apiError(
    403,
    'ROLE_REQUIRED',
    message,
    fields.map((f) => ({
      path: f.startsWith('/') ? f : `/${f}`,
      message: 'needs SUPERADMIN',
    })),
  );
}

/** ValidationPipe's `exceptionFactory`: 400 VALIDATION_FAILED, one entry per violated constraint. */
export function validationException(errors: ValidationError[]): HttpException {
  return apiError(
    400,
    'VALIDATION_FAILED',
    'Request validation failed',
    flatten(errors, ''),
  );
}

function flatten(errors: ValidationError[], prefix: string): FieldError[] {
  const out: FieldError[] = [];
  for (const e of errors) {
    const path = `${prefix}/${escapePointer(e.property)}`;
    for (const message of Object.values(e.constraints ?? {})) {
      out.push({ path, message });
    }
    if (e.children?.length) out.push(...flatten(e.children, path));
  }
  return out;
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}
