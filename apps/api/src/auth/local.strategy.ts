import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { Strategy } from 'passport-local';
import { AuthService, type LoginUser } from './auth.service';
import { requestMeta } from './request-meta';

/** passport-local: reads `username` and `password` from the JSON body. */
@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly auth: AuthService) {
    super({ passReqToCallback: true });
  }

  /**
   * Runs inside the guard, before the ValidationPipe, so the body is checked here before any
   * side effect (session, lockout, LoginLog). Credentials come from the body only: passport-local
   * also reads the query string, so the arguments it passes are ignored.
   */
  async validate(req: Request): Promise<{ user: LoginUser; token: string }> {
    const body = req.body as Record<string, unknown> | undefined;
    const { username, password } = checkLoginBody(body);
    return this.auth.login(username, password, requestMeta(req));
  }
}

export const MAX_CREDENTIAL_LENGTH = 200;

function checkLoginBody(body: Record<string, unknown> | undefined): {
  username: string;
  password: string;
} {
  const keys = body && typeof body === 'object' ? Object.keys(body) : [];
  const { username, password } = body ?? {};
  if (
    keys.some((k) => k !== 'username' && k !== 'password') ||
    typeof username !== 'string' ||
    typeof password !== 'string'
  ) {
    throw new BadRequestException('Invalid login request');
  }
  if (
    username.length > MAX_CREDENTIAL_LENGTH ||
    password.length > MAX_CREDENTIAL_LENGTH
  ) {
    throw new BadRequestException('Invalid login request');
  }
  if (!username || !password) {
    throw new UnauthorizedException('Invalid username or password');
  }
  return { username, password };
}
