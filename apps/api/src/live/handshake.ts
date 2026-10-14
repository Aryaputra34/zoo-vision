import type { IncomingHttpHeaders } from 'node:http';
import type { ActorResolver } from '../auth/actor-resolver';
import { SESSION_COOKIE } from '../auth/actor-resolver';
import type { Role } from '../generated/prisma/enums';

/** What the gateway keeps in `socket.data` for the life of a connection. */
export type SocketUser = {
  userId: string;
  name: string;
  role: Role;
  sessionHash: string;
};

export type HandshakeError = { error: 'UNAUTHENTICATED' | 'FORBIDDEN_ORIGIN' };

function sessionCookie(header: string | undefined): string | null {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Decides whether a WebSocket handshake may connect, and as whom.
 *
 * - An `Origin` header whose host differs from `Host` is refused (FORBIDDEN_ORIGIN): another web
 *   app on the same machine and a different port counts as same-site for cookies, and would
 *   otherwise open a socket with the user's session. A request without `Origin` (not a browser) passes.
 * - Only the session cookie is accepted. The Authorization header is never read: API tokens are
 *   for scripts, this socket is for the dashboard.
 */
export async function authorizeHandshake(
  req: { headers: IncomingHttpHeaders },
  resolver: Pick<ActorResolver, 'resolveWithSession'>,
): Promise<SocketUser | HandshakeError> {
  const { origin, host, cookie } = req.headers;
  if (origin !== undefined) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // "null" (a sandboxed frame) and anything unreadable
    }
    if (originHost === null || originHost !== host) {
      return { error: 'FORBIDDEN_ORIGIN' };
    }
  }

  const token = sessionCookie(cookie);
  if (token === null) return { error: 'UNAUTHENTICATED' };

  const found = await resolver.resolveWithSession({
    headers: {},
    cookies: { [SESSION_COOKIE]: token },
  });
  if (!found || found.sessionHash === null) return { error: 'UNAUTHENTICATED' };
  return {
    userId: found.actor.id,
    name: found.actor.name,
    role: found.actor.role,
    sessionHash: found.sessionHash,
  };
}
