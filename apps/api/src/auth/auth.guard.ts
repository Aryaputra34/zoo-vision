import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import type { ActorRequest } from './actor';
import { IS_PUBLIC_KEY } from './decorators';
import { SessionService } from './session.service';

export const SESSION_COOKIE = 'zoo_session';

/**
 * Global guard. Public routes pass; otherwise the `zoo_session` cookie must name a live session
 * whose user is still active. The user is read from Postgres on every request, so disabling a
 * user or changing a role applies at once.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<ActorRequest>();
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
