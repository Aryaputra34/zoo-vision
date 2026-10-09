import { Injectable, UnauthorizedException } from '@nestjs/common';
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

  async validate(
    req: Request,
    username: unknown,
    password: unknown,
  ): Promise<{ user: LoginUser; token: string }> {
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new UnauthorizedException('Invalid username or password');
    }
    return this.auth.login(username, password, requestMeta(req));
  }
}
