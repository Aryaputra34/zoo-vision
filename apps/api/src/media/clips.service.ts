import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { apiError } from '../common/errors';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

/** How long playback may take to start answering before the clip is called unavailable. */
const HEADERS_TIMEOUT_MS = 10_000;

const unavailable = () =>
  apiError(
    404,
    'RECORDING_NOT_AVAILABLE',
    'The recording of this event is not available',
  );

@Injectable()
export class ClipsService {
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
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: {
        camera: {
          select: {
            recordingPath: true,
            recordingEnabled: true,
            clipBeforeSec: true,
            clipAfterSec: true,
          },
        },
      },
    });
    if (!event) throw apiError(404, 'NOT_FOUND', 'Event not found');

    const { camera } = event;
    const base = this.env.MEDIAMTX_PLAYBACK_URL;
    if (!base || !camera?.recordingPath || !camera.recordingEnabled) {
      throw unavailable();
    }

    const before = camera.clipBeforeSec;
    const after = camera.clipAfterSec;
    // URLSearchParams encodes the recording path as one value: it can not add or change a parameter
    const url = new URL('get', base.endsWith('/') ? base : `${base}/`);
    url.search = new URLSearchParams({
      path: camera.recordingPath,
      start: new Date(event.time.getTime() - before * 1000).toISOString(),
      duration: String(before + after),
      format: 'mp4',
    }).toString();

    const gone = new AbortController();
    res.once('close', () => gone.abort());
    const timer = setTimeout(() => gone.abort(), HEADERS_TIMEOUT_MS);
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(url, {
        signal: gone.signal,
        redirect: 'error',
      });
    } catch {
      throw unavailable(); // not reachable, or too slow to answer
    } finally {
      clearTimeout(timer);
    }
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel().catch(() => undefined);
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
