/**
 * `npm run smoke -- <baseUrl>`: checks the stack through Caddy, from the outside.
 *   1. GET /api/health answers 200
 *   2. GET /internal/engine/cameras?group=default answers 404 (Caddy never routes the engine's paths)
 *   3. /api/health carries the three security headers
 * Exits 1 on the first failure and says which check failed.
 */
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

async function main(): Promise<void> {
  if (!/^https?:\/\//.test(baseUrl)) {
    console.error('usage: npm run smoke -- <baseUrl>   e.g. http://localhost:8080');
    process.exit(2);
  }

  const health = await get('/api/health');
  if (health.status !== 200) {
    fail('GET /api/health through Caddy', `status ${health.status}, expected 200`);
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
      fail(`header ${name} on /api/health`, `got ${got ?? 'nothing'}, expected ${value}`);
    }
  }
  console.log('ok   security headers on /api/health');
  console.log('smoke: all checks passed');
}

void main();
