import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { IngestService, type IngestCommit } from '../ingest/ingest.service';
import { eventRow } from '../reports/rows';
import { ChangeMerger } from './change-merger';
import { LiveGateway } from './live.gateway';

/** More new events than this in one commit are announced as `data.changed` only. */
const MAX_EVENT_PUSHES = 50;
const DATA_CHANGED_WINDOW_MS = 5000;

/**
 * Turns what ingest committed into messages for the `alerts` room: one `event.created` per new
 * event (small commits only), and `data.changed` at most every 5 s. Runs after the commit and
 * the XACK, so a browser never sees an event that is not in the database. Whatever goes wrong
 * here is logged and swallowed: ingest must not notice.
 */
@Injectable()
export class IngestPush implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(IngestPush.name);
  private subscription?: Subscription;
  private readonly merger = new ChangeMerger(DATA_CHANGED_WINDOW_MS, (change) =>
    this.gateway.toAlerts('data.changed', change),
  );

  constructor(
    private readonly ingest: IngestService,
    private readonly gateway: LiveGateway,
  ) {}

  onModuleInit(): void {
    this.subscription = this.ingest.committed$.subscribe((commit) => {
      try {
        this.push(commit);
      } catch (err) {
        this.log.warn(
          `push failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    this.merger.close();
  }

  private push(commit: IngestCommit): void {
    if (commit.events.length <= MAX_EVENT_PUSHES) {
      for (const m of commit.events) {
        // the same URL building as the REST rows; the message has no camera name or clip link
        const row = eventRow({
          id: m.id,
          time: new Date(m.time),
          cameraId: m.cameraId,
          useCase: m.useCase,
          type: m.type,
          severity: m.severity,
          configVersion: m.configVersion,
          schemaVersion: m.schemaVersion,
          snapshotPath: m.snapshotPath,
          data: m.data,
          ingestedAt: new Date(),
          camera: null,
        });
        this.gateway.toAlerts('event.created', {
          id: row.id,
          time: row.time,
          cameraId: row.cameraId,
          useCase: row.useCase,
          type: row.type,
          severity: row.severity,
          data: row.data,
          snapshotUrl: row.snapshotUrl,
        });
      }
    }
    this.merger.add({
      cameraIds: commit.cameraIds,
      useCases: commit.useCases,
      shapes: commit.shapes,
    });
  }
}
