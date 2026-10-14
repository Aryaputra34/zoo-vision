/**
 * `npm run smoke -- <baseUrl>`: checks the stack through Caddy, from the outside.
 *   1. GET /api/health answers 200
 *   2. GET /internal/engine/cameras?group=default answers 404 (Caddy never routes the engine's paths)
 *   3. /api/health carries the three security headers
 *   4. (with DEMO_PASSWORD set) a demo-user login, then a socket.io client at /ws subscribes to
 *      `status` and gets a `status.snapshot` within 5 s: the upgrade works through Caddy
 * Exits 1 on the first failure and says which check failed.
 */
import { io } from 'socket.io-client';

const baseUrl = (process.argv[2] ?? '').replace(/\/+$/, '');

function fail(check: string, detail: string): never {
  console.error(`smoke: FAILED ${check}: ${detail}`);
  process.exit(1);
}

async function get(path: string): Promise<Response> {
  try {
    return await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
  } catch (err) {
    return fail(`GET ${path}`, `no answer (${(err as Error).message})`);
  }
}

/** Logs in as the demo user and waits for one status.snapshot over /ws. Skipped without DEMO_PASSWORD. */
async function checkSocket(): Promise<void> {
  const password = process.env.DEMO_PASSWORD;
  if (!password) {
    console.log(
      'skip WebSocket /ws (set DEMO_PASSWORD of the demo stack to check it)',
    );
    return;
  }
  const username = process.env.SMOKE_USERNAME ?? 'demo-user';
  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (login.status !== 200) {
    fail(`login as ${username}`, `status ${login.status}, expected 200`);
  }
  const cookie = (login.headers.getSetCookie() ?? [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('zoo_session='));
  if (!cookie) fail(`login as ${username}`, 'no zoo_session cookie');

  const snapshot = await new Promise<string>((resolve) => {
    const socket = io(baseUrl, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { Cookie: cookie },
    });
    const done = (result: string) => {
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => done('no status.snapshot within 5 s'), 5000);
    socket.on('connect_error', (err) => done(`refused: ${err.message}`));
    socket.on('status.snapshot', () => done('ok'));
    socket.on('connect', () => {
      socket.emit(
        'subscribe',
        { rooms: ['status'] },
        (ack: { ok: boolean }) => {
          if (!ack?.ok) done('subscribe was not acknowledged');
        },
      );
    });
  });
  if (snapshot !== 'ok') fail('WebSocket /ws through Caddy', snapshot);
  console.log('ok   WebSocket /ws → status.snapshot');
}

async function main(): Promise<void> {
  if (!/^https?:\/\//.test(baseUrl)) {
    console.error(
      'usage: npm run smoke -- <baseUrl>   e.g. http://localhost:8080',
    );
    process.exit(2);
  }

  const health = await get('/api/health');
  if (health.status !== 200) {
    fail(
      'GET /api/health through Caddy',
      `status ${health.status}, expected 200`,
    );
  }
  console.log('ok   GET /api/health → 200');

  const engine = await get('/internal/engine/cameras?group=default');
  if (engine.status !== 404) {
    fail(
      'GET /internal/engine/cameras is not routed',
      `status ${engine.status}, expected 404`,
    );
  }
  console.log('ok   GET /internal/engine/cameras → 404');

  const headers: [string, string][] = [
    ['x-content-type-options', 'nosniff'],
    ['x-frame-options', 'DENY'],
    ['referrer-policy', 'strict-origin-when-cross-origin'],
  ];
  for (const [name, value] of headers) {
    const got = health.headers.get(name);
    if (got !== value) {
      fail(
        `header ${name} on /api/health`,
        `got ${got ?? 'nothing'}, expected ${value}`,
      );
    }
  }
  console.log('ok   security headers on /api/health');

  await checkSocket();
  console.log('smoke: all checks passed');
}

void main();
