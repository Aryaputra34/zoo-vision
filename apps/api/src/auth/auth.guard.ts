import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiTokensService } from '../api-tokens/api-tokens.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ActorRequest } from './actor';
import { IS_PUBLIC_KEY } from './decorators';
import { SessionService } from './session.service';

export const SESSION_COOKIE = 'zoo_session';

/** `Bearer zv_...`, length-bounded before anything is hashed. */
const BEARER = /^Bearer (zv_[A-Za-z0-9_-]{1,124})$/;

/**
 * Global guard. Public routes pass; otherwise the `zoo_session` cookie must name a live session
 * whose user is still active; or an `Authorization: Bearer zv_...` header must name a live API token. The user is read from Postgres on every request, so disabling a
 * user or changing a role applies at once.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    private readonly apiTokens: ApiTokensService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<ActorRequest>();
    // An Authorization header decides alone: a bad one is a 401 even beside a valid cookie.
    const header = req.headers.authorization;
    if (header !== undefined) {
      const match = BEARER.exec(header);
      const actor = match ? await this.apiTokens.resolve(match[1]) : null;
      if (!actor) throw new UnauthorizedException();
      req.actor = actor;
      return true;
    }

    const cookies = req.cookies as Record<string, unknown> | undefined;
    const token = cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string') throw new UnauthorizedException();

    const session = await this.sessions.resolve(token);
    if (!session) throw new UnauthorizedException();

    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
    });
    if (!user || !user.active) {
      await this.sessions.destroy(token);
      throw new UnauthorizedException();
    }
    req.actor = { type: 'user', id: user.id, name: user.name, role: user.role };
    return true;
  }
}
