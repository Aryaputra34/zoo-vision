import { Injectable } from '@nestjs/common';
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
};

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditRecord): Promise<void> {
    await this.prisma.auditLog.create({
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
      },
    });
  }
}

/** JSON columns take plain JSON: dates become ISO strings, undefined stays absent. */
function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
