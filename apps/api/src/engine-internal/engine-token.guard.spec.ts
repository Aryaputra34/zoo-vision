import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import type { Env } from '../config/env';
import { EngineTokenGuard } from './engine-token.guard';

const TOKEN = 'a'.repeat(40);
const guard = new EngineTokenGuard({ ENGINE_TOKEN: TOKEN } as Env);

const ctx = (authorization?: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  }) as unknown as ExecutionContext;

describe('EngineTokenGuard', () => {
  it('lets the right token through', () => {
    expect(guard.canActivate(ctx(`Bearer ${TOKEN}`))).toBe(true);
  });

  it.each([
    ['a wrong token of the same length', `Bearer ${'b'.repeat(40)}`],
    ['a prefix of the token', `Bearer ${TOKEN.slice(0, 39)}`],
    ['another scheme', `Basic ${TOKEN}`],
    ['no header', undefined],
  ])('rejects %s with 401', (_label, header) => {
    expect(() => guard.canActivate(ctx(header))).toThrow(UnauthorizedException);
  });
});
