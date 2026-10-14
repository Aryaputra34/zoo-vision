import { Inject, Injectable } from '@nestjs/common';
import { localDateTime } from '../exports/csv';
import { ENV, type Env } from '../config/env';
import {
  type CsvExport,
  BATCH,
  ExportsService,
} from '../exports/exports.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_LIMIT } from '../reports/dto/list.dto';
import { ListsService } from '../reports/lists.service';
import { parseRange } from '../reports/report-query';
import type { EventRow, Page } from '../reports/rows';
import type {
  AuditFilterDto,
  AuditQueryDto,
  AuditRowDto,
  LoginFilterDto,
  LoginQueryDto,
  LoginRowDto,
  SystemEventsFilterDto,
  SystemEventsQueryDto,
} from './dto/system-log.dto';

type AuditRow = Prisma.AuditLogGetPayload<object>;
type LoginRow = Prisma.LoginLogGetPayload<object>;

const auditRow = (r: AuditRow): AuditRowDto => ({
  id: String(r.id),
  time: r.time.toISOString(),
  actorType: r.actorType,
  actorName: r.actorName,
  action: r.action,
  entity: r.entity,
  entityId: r.entityId,
  before: r.before,
  after: r.after,
  ip: r.ip,
  auditCamera: r.auditCamera,
});

const loginRow = (r: LoginRow): LoginRowDto => ({
  id: String(r.id),
  time: r.time.toISOString(),
  username: r.username,
  userId: r.userId,
  result: r.result,
  ip: r.ip,
  userAgent: r.userAgent,
});

/** The filters as given, without the empty ones, for the audit row of an export. */
function filtersOf(q: object): Record<string, string> {
  return Object.fromEntries(
    Object.entries(q).filter(([, v]) => typeof v === 'string' && v !== '') as [
      string,
      string,
    ][],
  );
}

/**
 * The system log for MANAGER and up: who changed what, who tried to log in, and what the system
 * itself reported. Paged newest first; audit and login rows by their id.
 */
@Injectable()
export class SystemLogService {
  private readonly local: (at: Date) => string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lists: ListsService,
    private readonly exports: ExportsService,
    @Inject(ENV) env: Env,
  ) {
    this.local = localDateTime(env.SITE_TIMEZONE);
  }

  private auditWhere(q: AuditFilterDto): Prisma.AuditLogWhereInput {
    const range = parseRange(q);
    return {
      AND: [
        { time: { gte: range.from, lt: range.to } },
        ...(q.actor
          ? [{ actorName: { contains: q.actor, mode: 'insensitive' as const } }]
          : []),
        ...(q.entity ? [{ entity: q.entity }] : []),
        ...(q.action ? [{ action: q.action }] : []),
        ...(q.auditCamera ? [{ auditCamera: q.auditCamera === 'true' }] : []),
      ],
    };
  }

  private loginWhere(q: LoginFilterDto): Prisma.LoginLogWhereInput {
    const range = parseRange(q);
    return {
      AND: [
        { time: { gte: range.from, lt: range.to } },
        ...(q.username
          ? [
              {
                username: {
                  contains: q.username,
                  mode: 'insensitive' as const,
                },
              },
            ]
          : []),
        ...(q.result ? [{ result: q.result }] : []),
      ],
    };
  }

  async audit(
    q: AuditQueryDto,
  ): Promise<{ rows: AuditRowDto[]; nextCursor: string | null }> {
    const limit = q.limit ?? DEFAULT_LIMIT;
    const found = await this.prisma.auditLog.findMany({
      where: {
        AND: [
          this.auditWhere(q),
          ...(q.cursor ? [{ id: { lt: BigInt(q.cursor) } }] : []),
        ],
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const page = found.slice(0, limit);
    return {
      rows: page.map(auditRow),
      nextCursor:
        found.length > limit ? String(page[page.length - 1].id) : null,
    };
  }

  async logins(
    q: LoginQueryDto,
  ): Promise<{ rows: LoginRowDto[]; nextCursor: string | null }> {
    const limit = q.limit ?? DEFAULT_LIMIT;
    const found = await this.prisma.loginLog.findMany({
      where: {
        AND: [
          this.loginWhere(q),
          ...(q.cursor ? [{ id: { lt: BigInt(q.cursor) } }] : []),
        ],
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const page = found.slice(0, limit);
    return {
      rows: page.map(loginRow),
      nextCursor:
        found.length > limit ? String(page[page.length - 1].id) : null,
    };
  }

  /** System events are `Event` rows of use case `system`, paged like the event list. */
  systemEvents(q: SystemEventsQueryDto): Promise<Page<EventRow>> {
    return this.lists.events({ ...q, useCase: 'system' });
  }

  auditCsv(q: AuditFilterDto): CsvExport {
    const where = this.auditWhere(q);
    return {
      kind: 'audit',
      filename: this.exports.filename('audit', parseRange(q)),
      header: [
        'id',
        'time_local',
        'actor_type',
        'actor_name',
        'action',
        'entity',
        'entity_id',
        'audit_camera',
        'ip',
        'before',
        'after',
      ],
      filters: filtersOf(q),
      batches: this.byId(
        (after) =>
          this.prisma.auditLog.findMany({
            where: { AND: [where, ...(after ? [{ id: { gt: after } }] : [])] },
            orderBy: { id: 'asc' },
            take: BATCH,
          }),
        (r: AuditRow) => [
          String(r.id),
          this.local(r.time),
          r.actorType,
          r.actorName,
          r.action,
          r.entity,
          r.entityId,
          r.auditCamera,
          r.ip,
          r.before,
          r.after,
        ],
      ),
    };
  }

  loginsCsv(q: LoginFilterDto): CsvExport {
    const where = this.loginWhere(q);
    return {
      kind: 'logins',
      filename: this.exports.filename('logins', parseRange(q)),
      header: [
        'id',
        'time_local',
        'username',
        'user_id',
        'result',
        'ip',
        'user_agent',
      ],
      filters: filtersOf(q),
      batches: this.byId(
        (after) =>
          this.prisma.loginLog.findMany({
            where: { AND: [where, ...(after ? [{ id: { gt: after } }] : [])] },
            orderBy: { id: 'asc' },
            take: BATCH,
          }),
        (r: LoginRow) => [
          String(r.id),
          this.local(r.time),
          r.username,
          r.userId,
          r.result,
          r.ip,
          r.userAgent,
        ],
      ),
    };
  }

  systemEventsCsv(q: SystemEventsFilterDto): CsvExport {
    return {
      ...this.exports.events({ ...q, useCase: 'system' }),
      kind: 'system-events',
      filename: this.exports.filename('system-events', parseRange(q)),
    };
  }

  /** Keyset batches by ascending id, as arrays of cells, one `read` per batch. */
  private async *byId<T extends { id: bigint }>(
    read: (after: bigint | undefined) => Promise<T[]>,
    cells: (row: T) => unknown[],
  ): AsyncGenerator<unknown[][]> {
    let after: bigint | undefined;
    for (;;) {
      const rows = await read(after);
      if (rows.length > 0) yield rows.map(cells);
      if (rows.length < BATCH) return;
      after = rows[rows.length - 1].id;
    }
  }
}
