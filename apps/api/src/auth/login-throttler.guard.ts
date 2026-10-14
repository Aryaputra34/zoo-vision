import { ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request } from 'express';
import Redis from 'ioredis';
import { apiError } from '../common/errors';
import { REDIS } from '../redis/redis.module';
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
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    super(options, storage, reflector);
  }

  protected override async throwThrottlingException(
    context: ExecutionContext,
  ): Promise<void> {
    const req = context.switchToHttp().getRequest<Request>();
    const body = req.body as { username?: unknown } | undefined;
    const typed = typeof body?.username === 'string' ? body.username : '';
    try {
      // One row per IP per block window: the rest of the flood still gets 429 but no row.
      const first = await this.redis.set(
        `ratelog:${req.ip ?? 'unknown'}`,
        '1',
        'PX',
        60_000,
        'NX',
      );
      if (first === 'OK') {
        await this.auth.record(
          'RATE_LIMITED',
          typed.slice(0, 200),
          undefined,
          requestMeta(req),
        );
      }
    } catch (err) {
      // the 429 must still be sent when the log write fails
      this.log.error(`could not write the RATE_LIMITED log: ${String(err)}`);
    }
    throw apiError(
      429,
      'RATE_LIMITED',
      'Too many attempts; try again in a minute',
    );
  }
}
