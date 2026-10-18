import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { apiError } from '../common/errors';
import { ENV, type Env } from '../config/env';
import { mediamtxPaths } from '../mediamtx/paths';
import { PrismaService } from '../prisma/prisma.service';

/** How long playback may take to start answering before the clip is called unavailable. */
const HEADERS_TIMEOUT_MS = 10_000;

/** What a failed fetch says about itself, without its message (that can carry the URL's credentials). */
const reason = (err: unknown): string =>
  (err as { cause?: { code?: string } }).cause?.code ??
  (err as { name?: string }).name ??
  'error';

const unavailable = () =>
  apiError(
    404,
    'RECORDING_NOT_AVAILABLE',
    'The recording of this event is not available',
  );

@Injectable()
export class ClipsService {
  private readonly log = new Logger(ClipsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Streams the MP4 around an event from MediaMTX's playback server: from the event time minus
   * the camera's `clipBeforeSec`, for `before + after` seconds. Everything that can be answered
   * before the first byte is a JSON error; `res` is untouched until playback has answered 2xx.
   * The request to playback is aborted when the client goes away.
   */
  async stream(eventId: string, res: Response): Promise<void> {
    // before the first await: a client that leaves while the event is looked up aborts the fetch too
    const gone = new AbortController();
    res.once('close', () => gone.abort());
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: {
        camera: {
          select: {
            sourceType: true,
            subStreamUrlEnc: true,
            recordingEnabled: true,
            recordingStream: true,
            inferenceStream: true,
            clipBeforeSec: true,
            clipAfterSec: true,
          },
        },
      },
    });
    if (!event) throw apiError(404, 'NOT_FOUND', 'Event not found');

    const { camera } = event;
    const base = this.env.MEDIAMTX_PLAYBACK_URL;
    const path =
      camera && event.cameraId
        ? mediamtxPaths({ ...camera, id: event.cameraId })?.recorded
        : null;
    if (!base || !camera || !path) throw unavailable();

    const before = camera.clipBeforeSec;
    const after = camera.clipAfterSec;
    // URLSearchParams encodes the recording path as one value: it can not add or change a parameter
    const url = new URL('get', base.endsWith('/') ? base : `${base}/`);
    url.search = new URLSearchParams({
      path,
      start: new Date(event.time.getTime() - before * 1000).toISOString(),
      duration: String(before + after),
      format: 'mp4',
    }).toString();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      gone.abort();
    }, HEADERS_TIMEOUT_MS);
    // `host` has no credentials, `url.search` (the recording path) is never logged
    const { host } = url;
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(url, {
        signal: gone.signal,
        redirect: 'error',
        // MediaMTX's playback needs the service password (user `zoo`)
        headers: this.env.MEDIAMTX_PASSWORD
          ? {
              Authorization: `Basic ${Buffer.from(`zoo:${this.env.MEDIAMTX_PASSWORD}`).toString('base64')}`,
            }
          : undefined,
      });
    } catch (err) {
      // a client that left is not a fault; a refused connection or a silent server is, and it
      // looks exactly like "no recordings" to the user, so the log is the only place to see it
      if (!res.destroyed) {
        this.log.warn(
          timedOut
            ? `playback ${host} gave no answer in ${HEADERS_TIMEOUT_MS / 1000} s`
            : `playback ${host} not reachable (${reason(err)})`,
        );
      }
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel().catch(() => undefined);
      // 404 is how MediaMTX says "nothing recorded for that time": normal, not a fault
      if (upstream.status !== 404) {
        this.log.warn(`playback ${host} answered ${upstream.status}`);
      }
      throw unavailable();
    }

    // a clip that is still being recorded changes: the browser must not keep it
    const clipEnd = event.time.getTime() + after * 1000;
    res.set({
      'Content-Type': 'video/mp4',
      'Cache-Control':
        Date.now() < clipEnd ? 'no-store' : 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    try {
      await pipeline(
        Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>),
        res,
      );
    } catch {
      // the client left, or playback died mid-clip: pipeline has cut the response, so the
      // download fails and is never taken for a whole clip
    }
  }
}
