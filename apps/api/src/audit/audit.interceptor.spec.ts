import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, throwError } from 'rxjs';
import type { AuditService } from './audit.service';
import { AuditInterceptor } from './audit.interceptor';
import { setAudit } from './audit-context';

function makeContext(method: string, path: string) {
  const req: Record<string, unknown> = {
    method,
    route: { path },
    ip: '10.0.0.9',
    actor: { type: 'user', id: 'u1', name: 'Una', role: 'MANAGER' },
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => function handler() {},
    getClass: () => class Ctl {},
  } as unknown as ExecutionContext;
  return { ctx, req };
}

describe('AuditInterceptor', () => {
  let record: jest.Mock;
  let interceptor: AuditInterceptor;

  beforeEach(() => {
    record = jest.fn().mockResolvedValue(undefined);
    interceptor = new AuditInterceptor(new Reflector(), {
      record,
    } as unknown as AuditService);
  });

  const run = (ctx: ExecutionContext, next: CallHandler) =>
    lastValueFrom(interceptor.intercept(ctx, next), {
      defaultValue: undefined,
    });

  it('writes a default entry when the handler sets none', async () => {
    const { ctx } = makeContext('POST', '/api/v1/things');
    await run(ctx, { handle: () => of({ ok: true }) });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'POST /api/v1/things',
        entity: 'things',
        actorType: 'user',
        actorId: 'u1',
        actorName: 'Una',
        ip: '10.0.0.9',
      }),
    );
  });

  it('uses the entry set by the handler, redacted', async () => {
    const { ctx, req } = makeContext('PATCH', '/api/v1/users/:id');
    await run(ctx, {
      handle: () => {
        setAudit(req as never, {
          action: 'user.update',
          entity: 'user',
          entityId: 'x',
          after: { password: 'secret', name: 'n' },
        });
        return of(1);
      },
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.update',
        entity: 'user',
        entityId: 'x',
        after: { password: '[redacted]', name: 'n' },
      }),
    );
  });

  it('writes nothing for a GET', async () => {
    const { ctx } = makeContext('GET', '/api/v1/things');
    await run(ctx, { handle: () => of(1) });
    expect(record).not.toHaveBeenCalled();
  });

  it('writes nothing when the handler throws', async () => {
    const { ctx } = makeContext('POST', '/api/v1/things');
    await expect(
      run(ctx, { handle: () => throwError(() => new Error('boom')) }),
    ).rejects.toThrow('boom');
    expect(record).not.toHaveBeenCalled();
  });
});
