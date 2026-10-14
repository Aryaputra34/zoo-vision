import type { Actor } from '../auth/actor';
import { authorizeHandshake } from './handshake';

type Resolved = { actor: Actor; sessionHash: string | null } | null;

const actor: Actor = { type: 'user', id: 'u1', name: 'Mira', role: 'MANAGER' };

/** A resolver that answers `answer` and remembers what it was asked. */
function resolver(answer: Resolved) {
  const seen: { headers: unknown; cookies: unknown }[] = [];
  return {
    seen,
    resolveWithSession: (req: { headers: unknown; cookies?: unknown }) => {
      seen.push({ headers: req.headers, cookies: req.cookies });
      return Promise.resolve(answer);
    },
  };
}

const live = (): Resolved => ({ actor, sessionHash: 'h'.repeat(64) });

describe('authorizeHandshake', () => {
  it('Origin http://evil.test with Host localhost:8080 → FORBIDDEN_ORIGIN; same host or no Origin → allowed', async () => {
    const headers = { host: 'localhost:8080', cookie: 'zoo_session=tok' };

    expect(
      await authorizeHandshake(
        { headers: { ...headers, origin: 'http://evil.test' } },
        resolver(live()),
      ),
    ).toEqual({ error: 'FORBIDDEN_ORIGIN' });

    // another port on the same machine is another origin
    expect(
      await authorizeHandshake(
        { headers: { ...headers, origin: 'http://localhost:3000' } },
        resolver(live()),
      ),
    ).toEqual({ error: 'FORBIDDEN_ORIGIN' });

    const allowed = {
      userId: 'u1',
      name: 'Mira',
      role: 'MANAGER',
      sessionHash: 'h'.repeat(64),
    };
    expect(
      await authorizeHandshake(
        { headers: { ...headers, origin: 'http://localhost:8080' } },
        resolver(live()),
      ),
    ).toEqual(allowed);
    // a non-browser client sends no Origin
    expect(await authorizeHandshake({ headers }, resolver(live()))).toEqual(
      allowed,
    );
  });

  it('an unreadable Origin, such as the string "null", is refused', async () => {
    for (const origin of ['null', 'not a url', '']) {
      expect(
        await authorizeHandshake(
          {
            headers: {
              host: 'localhost:8080',
              cookie: 'zoo_session=t',
              origin,
            },
          },
          resolver(live()),
        ),
      ).toEqual({ error: 'FORBIDDEN_ORIGIN' });
    }
  });

  it('a wrong origin is refused before the session is looked at', async () => {
    const r = resolver(live());
    await authorizeHandshake(
      {
        headers: {
          host: 'localhost:8080',
          cookie: 'zoo_session=t',
          origin: 'http://evil.test',
        },
      },
      r,
    );
    expect(r.seen).toHaveLength(0);
  });

  it('passes only the zoo_session cookie on, and never an Authorization header', async () => {
    const r = resolver(live());
    await authorizeHandshake(
      {
        headers: {
          host: 'h',
          cookie: 'a=1; zoo_session=abc%2Fdef; b=2',
          authorization: 'Bearer zv_sometoken',
        },
      },
      r,
    );
    expect(r.seen).toEqual([
      { headers: {}, cookies: { zoo_session: 'abc/def' } },
    ]);
  });

  it('no cookie, only a Bearer token, or a session the resolver does not know → UNAUTHENTICATED', async () => {
    const r = resolver(live());
    expect(await authorizeHandshake({ headers: { host: 'h' } }, r)).toEqual({
      error: 'UNAUTHENTICATED',
    });
    expect(
      await authorizeHandshake(
        { headers: { host: 'h', authorization: 'Bearer zv_x' } },
        r,
      ),
    ).toEqual({ error: 'UNAUTHENTICATED' });
    expect(
      await authorizeHandshake(
        { headers: { host: 'h', cookie: 'other=1; zoo_session' } },
        r,
      ),
    ).toEqual({ error: 'UNAUTHENTICATED' });
    expect(r.seen).toHaveLength(0); // nothing to look up

    expect(
      await authorizeHandshake(
        { headers: { host: 'h', cookie: 'zoo_session=dead' } },
        resolver(null),
      ),
    ).toEqual({ error: 'UNAUTHENTICATED' });
  });

  it('an actor without a session hash (an API token) is not accepted', async () => {
    expect(
      await authorizeHandshake(
        { headers: { host: 'h', cookie: 'zoo_session=t' } },
        resolver({ actor, sessionHash: null }),
      ),
    ).toEqual({ error: 'UNAUTHENTICATED' });
  });
});
