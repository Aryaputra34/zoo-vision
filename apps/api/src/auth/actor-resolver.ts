import { Injectable } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import { ApiTokensService } from '../api-tokens/api-tokens.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Actor } from './actor';
import { sha256hex } from './hash';
import { SessionService } from './session.service';

export const SESSION_COOKIE = 'zoo_session';

/** `Bearer zv_...`, length-bounded before anything is hashed. */
const BEARER = /^Bearer (zv_[A-Za-z0-9_-]{1,124})$/;

/** What the resolver reads: a request, or a WebSocket handshake. */
export type ResolveRequest = {
  headers: IncomingHttpHeaders;
  cookies?: Record<string, unknown>;
};

/**
 * Turns a session cookie or a Bearer API token into an {@link Actor}. The auth guard, the
 * superadmin-only Swagger check and the WebSocket handshake all use it. The user is read from
 * Postgres every time, so disabling a user or changing a role applies at once.
 */
@Injectable()
export class ActorResolver {
  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    private readonly apiTokens: ApiTokensService,
  ) {}

  async resolve(req: ResolveRequest): Promise<Actor | null> {
    return (await this.resolveWithSession(req))?.actor ?? null;
  }

  /** As {@link resolve}, plus the session's hash for cookie actors (null for API tokens). */
  async resolveWithSession(
    req: ResolveRequest,
  ): Promise<{ actor: Actor; sessionHash: string | null } | null> {
    // An Authorization header decides alone: a bad one is null even beside a valid cookie.
    const header = req.headers.authorization;
    if (header !== undefined) {
      const match = BEARER.exec(header);
      const actor = match ? await this.apiTokens.resolve(match[1]) : null;
      return actor ? { actor, sessionHash: null } : null;
    }

    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string') return null;

    const session = await this.sessions.resolve(token);
    if (!session) return null;

    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
    });
    if (!user || !user.active) {
      await this.sessions.destroy(token);
      return null;
    }
    return {
      actor: { type: 'user', id: user.id, name: user.name, role: user.role },
      sessionHash: sha256hex(token),
    };
  }
}
