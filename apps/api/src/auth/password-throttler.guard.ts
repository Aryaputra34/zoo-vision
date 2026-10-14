import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { apiError } from '../common/errors';
import type { ActorRequest } from './actor';

/**
 * Counts `PUT /auth/password` per actor (AuthGuard runs first and sets `req.actor`), so a stolen
 * session cannot guess the current password at login speed. The limit sits on the route
 * (`@Throttle`): 5 requests per 15 minutes, counted in memory like the login throttle.
 */
@Injectable()
export class PasswordThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const { actor, ip } = req as unknown as ActorRequest;
    return Promise.resolve(actor?.id ?? ip ?? 'unknown');
  }

  protected override throwThrottlingException(): Promise<void> {
    throw apiError(
      429,
      'RATE_LIMITED',
      'Too many password change attempts; try again later',
    );
  }
}
