import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { streamCsv } from './csv';
import type { CsvExport } from './exports.service';

/** Audits a CSV export and streams it: shared by the reports exports and the system log. */
@Injectable()
export class CsvResponder {
  constructor(private readonly audit: AuditService) {}

  /** The filters are valid by now: audit first (no data leaves without a record), then stream. */
  async send(
    csv: CsvExport,
    actor: Actor,
    req: Request,
    res: Response,
  ): Promise<void> {
    // before the audit await: a client that leaves meanwhile must not miss its close event
    const gone = new AbortController();
    res.once('close', () => gone.abort());

    // the interceptor only audits writes, so an export records itself
    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: 'export.csv',
      entity: 'export',
      after: { kind: csv.kind, filters: csv.filters },
      ip: req.ip,
    });

    await streamCsv(res, csv.header, csv.batches, gone.signal, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csv.filename}"`,
      'Cache-Control': 'no-store',
    });
  }
}
