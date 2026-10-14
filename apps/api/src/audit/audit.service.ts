import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type AuditRecord = {
  actorType: string;
  actorId: string;
  actorName: string;
  action: string;
  entity: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  /** Flags the row; with `entity: 'camera'` it also emits {@link AuditService.auditCamera$}. */
  auditCamera?: boolean;
};

/** An audit-camera change that was just written, for the `audit.notice` push. */
export type AuditCameraNotice = {
  auditId: string;
  cameraId: string;
  actorName: string;
  action: string;
  time: string;
};

@Injectable()
export class AuditService {
  /** Emitted after a flagged camera row is written. Subscribers must not throw. */
  readonly auditCamera$ = new Subject<AuditCameraNotice>();

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditRecord): Promise<{ id: bigint }> {
    const row = await this.prisma.auditLog.create({
      data: {
        actorType: entry.actorType,
        actorId: entry.actorId,
        actorName: entry.actorName,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        before: toJson(entry.before),
        after: toJson(entry.after),
        ip: entry.ip,
        auditCamera: entry.auditCamera ?? false,
      },
    });
    if (entry.auditCamera && entry.entity === 'camera' && entry.entityId) {
      try {
        this.auditCamera$.next({
          auditId: String(row.id),
          cameraId: entry.entityId,
          actorName: entry.actorName,
          action: entry.action,
          time: row.time.toISOString(),
        });
      } catch {
        // a push that fails must never fail the change that was just recorded
      }
    }
    return { id: row.id };
  }
}

/** JSON columns take plain JSON: dates become ISO strings, undefined stays absent. */
function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
