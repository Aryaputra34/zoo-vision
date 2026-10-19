import { Injectable } from '@nestjs/common';
import type { Actor } from '../auth/actor';
import { localDateTime } from '../exports/csv';
import { SiteSettingsService } from '../site-settings/site-settings.service';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly lists: ListsService,
    private readonly exports: ExportsService,
    private readonly settings: SiteSettingsService,
  ) {}

  /**
   * The ids a MANAGER may not read about: SUPERADMIN users and SUPERADMIN API tokens (what they
   * did, what was done to their accounts, their logins), as the users list hides superadmins from
   * managers. A SUPERADMIN has none. A user who is no longer a superadmin is no longer hidden.
   */
  private async hiddenIds(actor: Actor): Promise<string[]> {
    if (actor.role === 'SUPERADMIN') return [];
    const [users, tokens] = await Promise.all([
      this.prisma.user.findMany({
        where: { role: 'SUPERADMIN' },
        select: { id: true },
      }),
      this.prisma.apiToken.findMany({
        where: { role: 'SUPERADMIN' },
        select: { id: true },
      }),
    ]);
    return [...users, ...tokens].map((r) => r.id);
  }

  private auditWhere(
    q: AuditFilterDto,
    hidden: string[],
  ): Prisma.AuditLogWhereInput {
    const range = parseRange(q);
    return {
      AND: [
        { time: { gte: range.from, lt: range.to } },
        ...(hidden.length > 0
          ? [
              { actorId: { notIn: hidden } },
              {
                OR: [
                  { entity: { notIn: ['user', 'api_token'] } },
                  { entityId: null },
                  { entityId: { notIn: hidden } },
                ],
              },
            ]
          : []),
        ...(q.actor
          ? [{ actorName: { contains: q.actor, mode: 'insensitive' as const } }]
          : []),
        ...(q.entity ? [{ entity: q.entity }] : []),
        ...(q.action ? [{ action: q.action }] : []),
        ...(q.auditCamera ? [{ auditCamera: q.auditCamera === 'true' }] : []),
      ],
    };
  }

  private loginWhere(
    q: LoginFilterDto,
    hidden: string[],
  ): Prisma.LoginLogWhereInput {
    const range = parseRange(q);
    return {
      AND: [
        { time: { gte: range.from, lt: range.to } },
        ...(hidden.length > 0
          ? [{ OR: [{ userId: null }, { userId: { notIn: hidden } }] }]
          : []),
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
    actor: Actor,
    q: AuditQueryDto,
  ): Promise<{ rows: AuditRowDto[]; nextCursor: string | null }> {
    const limit = q.limit ?? DEFAULT_LIMIT;
    const found = await this.prisma.auditLog.findMany({
      where: {
        AND: [
          this.auditWhere(q, await this.hiddenIds(actor)),
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
    actor: Actor,
    q: LoginQueryDto,
  ): Promise<{ rows: LoginRowDto[]; nextCursor: string | null }> {
    const limit = q.limit ?? DEFAULT_LIMIT;
    const found = await this.prisma.loginLog.findMany({
      where: {
        AND: [
          this.loginWhere(q, await this.hiddenIds(actor)),
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

  async auditCsv(actor: Actor, q: AuditFilterDto): Promise<CsvExport> {
    const where = this.auditWhere(q, await this.hiddenIds(actor));
    const local = localDateTime(this.settings.timeZone);
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
          local(r.time),
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

  async loginsCsv(actor: Actor, q: LoginFilterDto): Promise<CsvExport> {
    const where = this.loginWhere(q, await this.hiddenIds(actor));
    const local = localDateTime(this.settings.timeZone);
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
          local(r.time),
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
