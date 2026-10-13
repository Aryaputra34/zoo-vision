import { ArgumentsHost, Catch, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { isTransient } from './transient';

/**
 * Spec section 8: with Postgres down (or unusable), reads answer 503. The body never carries the
 * driver's text. Every other error goes through Nest's default handling.
 */
@Catch()
export class TransientDbFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (!isTransient(exception)) {
      super.catch(exception, host);
      return;
    }
    const adapter = this.applicationRef ?? this.httpAdapterHost?.httpAdapter;
    adapter?.reply(
      host.switchToHttp().getResponse(),
      { statusCode: 503, message: 'Service unavailable' },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
