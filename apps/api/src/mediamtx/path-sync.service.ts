import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { UrlCipher } from '../cameras/url-cipher';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { SiteSettingsService } from '../site-settings/site-settings.service';
import { MEDIAMTX, MediamtxClient, MediamtxError } from './mediamtx-client';
import {
  durationSeconds,
  isManaged,
  type PathConf,
  wantedPaths,
} from './paths';

const RECONCILE_MS = 30_000;

/** Whether MediaMTX's stored config already is `want`. Durations compare as seconds, not text. */
function same(have: Record<string, unknown>, want: PathConf): boolean {
  return (
    have.source === want.source &&
    have.rtspTransport === want.rtspTransport &&
    have.record === want.record &&
    have.sourceOnDemand === want.sourceOnDemand &&
    durationSeconds(have.recordDeleteAfter) ===
      durationSeconds(want.recordDeleteAfter)
  );
}

/**
 * Keeps MediaMTX's `zv_*` paths equal to what the cameras say: add what is missing, patch what
 * differs, delete the managed paths nobody wants. Every sync is one whole pass; a pass asked for
 * while one runs makes it run once more. A failed call is logged (path name and status only: a
 * path's `source` holds the camera's credentials) and the pass goes on. Paths that are not `zv_*`
 * are never touched.
 */
@Injectable()
export class PathSync implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(PathSync.name);
  private pass: Promise<void> | null = null;
  private rerun = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly cipher: UrlCipher,
    private readonly settings: SiteSettingsService,
    @Inject(MEDIAMTX) private readonly client: MediamtxClient | null,
  ) {}

  onApplicationBootstrap(): void {
    this.request();
    // Paths added through the Control API live in MediaMTX's memory only: after its restart this
    // puts them back
    if (this.client && this.env.JOBS === 'on') {
      this.timer = setInterval(() => this.request(), RECONCILE_MS);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Asks for a sync. Never throws, never waits. */
  request(): void {
    void this.reconcile();
  }

  /** One sync, resolved when it (and a rerun asked for meanwhile) is done. Never rejects. */
  reconcile(): Promise<void> {
    if (!this.client) return Promise.resolve();
    if (this.pass) {
      this.rerun = true;
      return this.pass;
    }
    this.pass = this.run(this.client).finally(() => {
      this.pass = null;
    });
    return this.pass;
  }

  private async run(client: MediamtxClient): Promise<void> {
    do {
      this.rerun = false;
      try {
        await this.once(client);
      } catch (err) {
        this.log.warn(
          err instanceof MediamtxError
            ? err.message
            : `MediaMTX sync failed: ${(err as Error).name}`,
        );
      }
    } while (this.rerun);
  }

  private async once(client: MediamtxClient): Promise<void> {
    // List MediaMTX first so anything committed in the DB while listing is seen in wanted
    const existing = await client.listConfigs();
    const failedCameras = new Set<string>();
    const wanted = wantedPaths(
      await this.prisma.camera.findMany(),
      this.cipher,
      this.settings.current.recordingRetentionDays,
      (cameraId, err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(
          `Cannot decrypt stream URL for camera ${cameraId}: ${msg}; skipping sync for this camera`,
        );
        failedCameras.add(cameraId);
      },
    );

    for (const [name, want] of wanted) {
      const have = existing.get(name);
      if (have && same(have, want)) continue;
      await this.try(name, () =>
        have ? client.patch(name, want) : client.add(name, want),
      );
    }
    for (const name of existing.keys()) {
      if (isManaged(name) && !wanted.has(name)) {
        const isFromFailedCamera = [...failedCameras].some(
          (id) => name === `zv_${id}` || name === `zv_${id}_sub`,
        );
        if (isFromFailedCamera) continue;
        await this.try(name, () => client.remove(name));
      }
    }
  }

  /** Logs a failed call as "path <name>: <op> failed (<status>)" and goes on. */
  private async try(name: string, call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch (err) {
      this.log.warn(
        err instanceof MediamtxError
          ? err.message
          : `path ${name}: call failed`,
      );
    }
  }
}
