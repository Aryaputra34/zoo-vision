import { Inject, Injectable, Logger } from '@nestjs/common';
import { statfs } from 'node:fs/promises';
import { apiError } from '../common/errors';
import { ENV, type Env } from '../config/env';
import type { Camera } from '../generated/prisma/client';
import type { StreamInfoDto, StreamPathInfoDto } from './dto/stream-info.dto';
import {
  MEDIAMTX,
  type MediamtxClient,
  MediamtxError,
} from './mediamtx-client';
import { SiteSettingsService } from '../site-settings/site-settings.service';
import { mediamtxPaths } from './paths';

const MIN_GAP_MS = 1000;
const MAX_GAP_MS = 120_000;
const DAY_SECONDS = 86400;

type Reading = { at: number; bytes: number; bps: number | null };

/** The codec names of a MediaMTX path status: `tracks2[].codec`, else the `tracks` strings. */
function codecsOf(status: Record<string, unknown> | null): string[] {
  const tracks2 = status?.tracks2;
  if (Array.isArray(tracks2)) {
    return tracks2.map((t: { codec?: unknown }) => String(t.codec));
  }
  const tracks = status?.tracks;
  return Array.isArray(tracks) ? tracks.map(String) : [];
}

/** What a camera's MediaMTX paths are doing: are they up, which codec, how much they cost on disk. */
@Injectable()
export class StreamInfoService {
  private readonly log = new Logger(StreamInfoService.name);
  /** The last reading per path, for the bitrate. In memory: a restart only delays it by one call. */
  private readonly readings = new Map<string, Reading>();
  /** The clock, replaceable in tests. */
  now: () => number = Date.now;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly settings: SiteSettingsService,
    @Inject(MEDIAMTX) private readonly client: MediamtxClient | null,
  ) {}

  async info(camera: Camera): Promise<StreamInfoDto> {
    const disk = await this.disk();
    const names = mediamtxPaths(camera);
    if (!names) return { paths: [], disk }; // FILE: the engine reads the file itself
    if (!this.client) {
      throw apiError(503, 'UNAVAILABLE', 'MediaMTX is not configured');
    }

    const wanted: [string, 'MAIN' | 'SUB'][] = [[names.main, 'MAIN']];
    if (names.sub) wanted.push([names.sub, 'SUB']);
    const paths: StreamPathInfoDto[] = [];
    for (const [name, stream] of wanted) {
      let status: Record<string, unknown> | null;
      try {
        status = await this.client.pathStatus(name);
      } catch (err) {
        // MediamtxError.message holds the path name and status only
        this.log.warn(
          err instanceof MediamtxError ? err.message : `path ${name}: failed`,
        );
        throw apiError(503, 'UNAVAILABLE', 'MediaMTX is not reachable');
      }
      const codecs = codecsOf(status);
      const recorded = names.recorded === name;
      const bitrateBps = this.bitrate(name, status);
      paths.push({
        name,
        stream,
        ready: status?.ready === true,
        recorded,
        codecs,
        codecWarning: codecs.some((c) => /^(H265|HEVC)$/i.test(c))
          ? 'H265_BROWSER'
          : null,
        bitrateBps,
        estimatedBytes:
          recorded && bitrateBps !== null
            ? Math.round(
                (bitrateBps / 8) *
                  DAY_SECONDS *
                  (camera.retentionDays ??
                    this.settings.current.recordingRetentionDays),
              )
            : null,
      });
    }
    return { paths, disk };
  }

  /** bits/s from this `bytesReceived` and the last one, 1-120 s apart; else null. */
  private bitrate(
    name: string,
    status: Record<string, unknown> | null,
  ): number | null {
    const bytes = status?.bytesReceived;
    if (typeof bytes !== 'number') return null;
    const at = this.now();
    const last = this.readings.get(name);
    if (last && at - last.at < MIN_GAP_MS) return last.bps; // polled again at once: keep the last answer
    const gap = last ? at - last.at : Infinity;
    const bps =
      last && gap <= MAX_GAP_MS && bytes >= last.bytes
        ? Math.round(((bytes - last.bytes) * 8 * 1000) / gap)
        : null;
    this.readings.set(name, { at, bytes, bps });
    return bps;
  }

  private async disk(): Promise<{
    freeBytes: number;
    totalBytes: number;
  } | null> {
    try {
      const s = await statfs(this.env.RECORDINGS_DIR);
      return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
    } catch {
      return null;
    }
  }
}
