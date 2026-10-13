import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ENV, type Env } from '../config/env';

const BEARER = /^Bearer (\S{1,512})$/;
const sha256 = (value: string) => createHash('sha256').update(value).digest();

/**
 * Guards /internal/engine/*: `Authorization: Bearer <ENGINE_TOKEN>`. Both sides are hashed first,
 * so the comparison is constant-time whatever the lengths. A user session is not enough.
 */
@Injectable()
export class EngineTokenGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(@Inject(ENV) env: Env) {
    this.expected = sha256(env.ENGINE_TOKEN);
  }

  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest<Request>()
      .headers.authorization;
    const match = header === undefined ? null : BEARER.exec(header);
    if (!match || !timingSafeEqual(sha256(match[1]), this.expected)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
