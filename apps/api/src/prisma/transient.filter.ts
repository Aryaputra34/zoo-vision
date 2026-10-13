import { ArgumentsHost, Catch, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { isTransient } from './transient';

/**
 * Spec section 8: with Postgres down (or unusable), reads answer 503. The body never carries the
 * driver's text. Every other error goes through Nest's default handling.
 */
@Catch()
export class TransientDbFilter extends BaseExceptionFilter {
  private readonly dbLogger = new Logger(TransientDbFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (!isTransient(exception)) {
      super.catch(exception, host);
      return;
    }
    // the body hides the driver's text, so the log is the only place an operator sees it
    this.dbLogger.error(
      `database unavailable (${errorCode(exception)}): ${errorText(exception)}`,
    );
    const adapter = this.applicationRef ?? this.httpAdapterHost?.httpAdapter;
    adapter?.reply(
      host.switchToHttp().getResponse(),
      { statusCode: 503, message: 'Service unavailable' },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
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
