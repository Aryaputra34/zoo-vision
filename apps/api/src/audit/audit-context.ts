import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

export type AuditEntry = {
  action: string;
  entity: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
};

export const SKIP_AUDIT_KEY = 'audit:skip';
const ENTRY = Symbol('audit:entry');

/** The route writes no audit row (login and logout have their own LoginLog). */
export const SkipAudit = () => SetMetadata(SKIP_AUDIT_KEY, true);

/**
 * A handler describes what it did; the AuditInterceptor writes the row once the handler succeeds.
 * Without a call, the row is `"<METHOD> <route path>"`.
 */
export function setAudit(req: Request, entry: AuditEntry): void {
  (req as unknown as Record<symbol, AuditEntry>)[ENTRY] = entry;
}

export function takeAudit(req: Request): AuditEntry | undefined {
  return (req as unknown as Record<symbol, AuditEntry | undefined>)[ENTRY];
}
