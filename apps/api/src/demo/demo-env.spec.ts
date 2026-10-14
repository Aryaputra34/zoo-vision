import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const deploy = join(__dirname, '..', '..', '..', '..', 'deploy');
const read = (file: string) => readFileSync(join(deploy, file), 'utf8');

describe('the demo stack is not on the LAN by default', () => {
  it('Caddy publishes its ports on ZOO_BIND_ADDR', () => {
    const compose = read('docker-compose.yml');
    expect(compose).toContain(
      '"${ZOO_BIND_ADDR:-0.0.0.0}:${ZOO_HTTP_PORT:-80}:${ZOO_HTTP_PORT:-80}"',
    );
    expect(compose).toContain(
      '"${ZOO_BIND_ADDR:-0.0.0.0}:${ZOO_HTTPS_PORT:-443}:${ZOO_HTTPS_PORT:-443}"',
    );
  });

  it('.env.demo.example binds to 127.0.0.1: its superadmin password is public', () => {
    expect(read('.env.demo.example')).toMatch(/^ZOO_BIND_ADDR=127\.0\.0\.1$/m);
  });

  it('.env.example documents ZOO_BIND_ADDR', () => {
    expect(read('.env.example')).toContain('ZOO_BIND_ADDR');
  });
});
