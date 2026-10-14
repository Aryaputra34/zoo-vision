import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { isTransient } from '../prisma/transient';
import type { ApiErrorBody, ErrorCode } from './errors';

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'TOO_LARGE',
  423: 'ACCOUNT_LOCKED',
  429: 'RATE_LIMITED',
  503: 'UNAVAILABLE',
};

/** Fixed texts for errors raised by Express and body-parser: their own text is parser detail. */
const HTTP_ERROR_MESSAGE: Record<number, string> = {
  400: 'Malformed request body',
  413: 'Request body too large',
};

/**
 * Every error leaves the API in one shape, `{statusCode, code, message, errors?}`. An
 * HttpException built by `apiError()` is sent as is; any other HttpException gets the code of
 * its status; a transient database error is 503 UNAVAILABLE; everything else is 500 INTERNAL and
 * its text only goes to the log.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger(ErrorFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const body = this.toBody(exception, host);
    this.adapterHost.httpAdapter.reply(
      host.switchToHttp().getResponse(),
      body,
      body.statusCode,
    );
  }

  private toBody(exception: unknown, host: ArgumentsHost): ApiErrorBody {
    if (exception instanceof HttpException) return fromHttpException(exception);

    if (isTransient(exception)) {
      // the body hides the driver's text, so the log is the only place an operator sees it
      this.log.error(
        `database unavailable (${errorCode(exception)}): ${errorText(exception)}`,
      );
      return {
        statusCode: 503,
        code: 'UNAVAILABLE',
        message: 'Service temporarily unavailable',
      };
    }

    const status = httpErrorStatus(exception);
    if (status !== null) {
      return {
        statusCode: status,
        code: CODE_BY_STATUS[status] ?? 'BAD_REQUEST',
        message: HTTP_ERROR_MESSAGE[status] ?? 'Bad request',
      };
    }

    const req = host
      .switchToHttp()
      .getRequest<{ method?: string; url?: string } | undefined>();
    this.log.error(
      `${req?.method ?? '?'} ${(req?.url ?? '?').split('?')[0]} failed: ${errorText(exception)}`,
      exception instanceof Error ? exception.stack : undefined,
    );
    return { statusCode: 500, code: 'INTERNAL', message: 'Internal error' };
  }
}

function fromHttpException(exception: HttpException): ApiErrorBody {
  const statusCode = exception.getStatus();
  const response = exception.getResponse();
  if (typeof response === 'object' && response !== null) {
    const r = response as Partial<ApiErrorBody> & { message?: unknown };
    if (typeof r.code === 'string') {
      return {
        statusCode,
        code: r.code,
        message: firstMessage(r.message) ?? exception.message,
        ...(r.errors ? { errors: r.errors } : {}),
      };
    }
    return plain(statusCode, firstMessage(r.message) ?? exception.message);
  }
  return plain(statusCode, firstMessage(response) ?? exception.message);
}

function plain(statusCode: number, message: string): ApiErrorBody {
  const code =
    CODE_BY_STATUS[statusCode] ??
    (statusCode >= 500 ? 'INTERNAL' : 'BAD_REQUEST');
  return { statusCode, code, message };
}

function firstMessage(message: unknown): string | undefined {
  if (typeof message === 'string') return message;
  if (Array.isArray(message) && typeof message[0] === 'string')
    return message[0];
  return undefined;
}

/** The 4xx status of an http-errors style error (body-parser, Express), else null. */
function httpErrorStatus(err: unknown): number | null {
  const e = err as { status?: unknown; statusCode?: unknown } | null;
  const status = e?.status ?? e?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500
    ? status
    : null;
}

/** The SQLSTATE of a failed query when Prisma carries one, else the error's own (Prisma) code. */
function errorCode(err: unknown): string {
  const e = err as {
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  const state = e.meta?.driverAdapterError?.cause?.originalCode;
  if (typeof state === 'string') return state;
  return typeof e.code === 'string' ? e.code : 'unknown';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
