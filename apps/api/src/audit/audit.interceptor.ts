import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { mergeMap, Observable } from 'rxjs';
import type { ActorRequest } from '../auth/actor';
import { SKIP_AUDIT_KEY, takeAudit } from './audit-context';
import { AuditService } from './audit.service';
import { redactSecrets } from './redact';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The first path segment after /api/v<n>/, e.g. "users" for /api/v1/users/:id. */
const entityOf = (path: string) =>
  path.replace(/^\/api\/v\d+\//, '').split('/')[0];

/**
 * Global. After a POST/PUT/PATCH/DELETE handler succeeds, writes one AuditLog row. Failed
 * requests (guards, validation, exceptions) and GETs write nothing.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<ActorRequest>();
    const skip = this.reflector.getAllAndOverride<boolean | undefined>(
      SKIP_AUDIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (skip || !WRITE_METHODS.has(req.method)) return next.handle();

    return next.handle().pipe(
      mergeMap(async (value: unknown) => {
        await this.write(req);
        return value;
      }),
    );
  }

  private async write(req: ActorRequest): Promise<void> {
    const actor = req.actor;
    if (!actor) return;
    const path = (req.route as { path?: string } | undefined)?.path ?? req.path;
    const entry = takeAudit(req as Request) ?? {
      action: `${req.method} ${path}`,
      entity: entityOf(path),
    };
    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      before: redactSecrets(entry.before),
      after: redactSecrets(entry.after),
      ip: req.ip,
    });
  }
}
