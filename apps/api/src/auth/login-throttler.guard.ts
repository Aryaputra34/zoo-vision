import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { requestMeta } from './request-meta';

/** 10 login requests a minute per IP (see AuthModule). A refused attempt is logged RATE_LIMITED. */
@Injectable()
export class LoginThrottlerGuard extends ThrottlerGuard {
  private readonly log = new Logger(LoginThrottlerGuard.name);

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly auth: AuthService,
  ) {
    super(options, storage, reflector);
  }

  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const req = context.switchToHttp().getRequest<Request>();
    const body = req.body as { username?: unknown } | undefined;
    const typed = typeof body?.username === 'string' ? body.username : '';
    try {
      await this.auth.record(
        'RATE_LIMITED',
        typed,
        undefined,
        requestMeta(req),
      );
    } catch (err) {
      // the 429 must still be sent when the log write fails
      this.log.error(`could not write the RATE_LIMITED log: ${String(err)}`);
    }
    return super.throwThrottlingException(context, detail);
  }
}
