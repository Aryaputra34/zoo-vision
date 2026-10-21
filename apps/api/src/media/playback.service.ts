import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import type { Camera } from '../generated/prisma/client';
import { mediamtxPaths } from '../mediamtx/paths';

/** How long playback may take to start answering before the clip is called unavailable. */
const HEADERS_TIMEOUT_MS = 10_000;

/** What a failed fetch says about itself, without its message (that can carry the URL's credentials). */
const reason = (err: unknown): string =>
  (err as { cause?: { code?: string } }).cause?.code ??
  (err as { name?: string }).name ??
  'error';

export type ClipCamera = { id: string } & Pick<
  Camera,
  | 'sourceType'
  | 'subStreamUrlEnc'
  | 'recordingEnabled'
  | 'recordingStream'
  | 'inferenceStream'
  | 'clipBeforeSec'
  | 'clipAfterSec'
>;

export type Playback =
  | { ok: true; body: ReadableStream<Uint8Array> }
  // UNAVAILABLE: unreachable, timeout, 5xx, any other answer
  | { ok: false; reason: 'NO_PATH' | 'NOT_FOUND' | 'UNAVAILABLE' };

/**
 * The one request for the MP4 around an event, from MediaMTX's playback server: from the event
 * time minus the camera's `clipBeforeSec`, for `before + after` seconds. The live clip route and
 * the pin tick both use it, so a live clip and a kept clip can not differ.
 */
@Injectable()
export class PlaybackService {
  private readonly log = new Logger(PlaybackService.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  /**
   * Opens the clip; the body is the caller's to read. `signal` aborts the request and the body
   * (the client left, or the caller's own deadline). Nothing here throws.
   */
  async open(
    camera: ClipCamera,
    eventTime: Date,
    signal: AbortSignal,
  ): Promise<Playback> {
    const base = this.env.MEDIAMTX_PLAYBACK_URL;
    const path = mediamtxPaths(camera)?.recorded;
    if (!base || !path) return { ok: false, reason: 'NO_PATH' };

    const first = await this.fetchClip(base, path, camera, eventTime, signal);
    if (first.ok || first.reason !== 'NOT_FOUND') return first;
    // The camera may have switched between MAIN and SUB recording since the event: the old
    // recording sits under the other path. By name, not by the camera's current sub URL: the sub
    // URL may be gone since.
    const other = path.endsWith('_sub') ? path.slice(0, -4) : `${path}_sub`;
    return this.fetchClip(base, other, camera, eventTime, signal);
  }

  private async fetchClip(
    base: string,
    path: string,
    camera: ClipCamera,
    eventTime: Date,
    signal: AbortSignal,
  ): Promise<Playback> {
    const before = camera.clipBeforeSec;
    const after = camera.clipAfterSec;
    // URLSearchParams encodes the recording path as one value: it can not add or change a parameter
    const url = new URL('get', base.endsWith('/') ? base : `${base}/`);
    url.search = new URLSearchParams({
      path,
      start: new Date(eventTime.getTime() - before * 1000).toISOString(),
      duration: String(before + after),
      format: 'mp4',
    }).toString();

    const request = new AbortController();
    const onAbort = () => request.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      request.abort();
    }, HEADERS_TIMEOUT_MS);
    // `host` has no credentials, `url.search` (the recording path) is never logged
    const { host } = url;
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(url, {
        signal: request.signal,
        redirect: 'error',
        // MediaMTX's playback needs the service password (user `zoo`)
        headers: this.env.MEDIAMTX_PASSWORD
          ? {
              Authorization: `Basic ${Buffer.from(`zoo:${this.env.MEDIAMTX_PASSWORD}`).toString('base64')}`,
            }
          : undefined,
      });
    } catch (err) {
      signal.removeEventListener('abort', onAbort);
      // a client that left is not a fault; a refused connection or a silent server is, and it
      // looks exactly like "no recordings" to the user, so the log is the only place to see it
      if (!signal.aborted) {
        this.log.warn(
          timedOut
            ? `playback ${host} gave no answer in ${HEADERS_TIMEOUT_MS / 1000} s`
            : `playback ${host} not reachable (${reason(err)})`,
        );
      }
      return { ok: false, reason: 'UNAVAILABLE' };
    } finally {
      clearTimeout(timer);
    }
    if (!upstream.ok || !upstream.body) {
      signal.removeEventListener('abort', onAbort);
      await upstream.body?.cancel().catch(() => undefined);
      // 404 is how MediaMTX says "nothing recorded for that time": normal, not a fault. So is 400 for a
      // path that was never recorded ("not configured", no folder): our own parameters are always valid
      // (found on the laptop run: the other of MAIN/SUB answered 400, and a pin retried it for hours)
      if (upstream.status === 404 || upstream.status === 400) {
        // a 400 is quiet but not invisible: a MediaMTX that starts refusing a parameter shows here
        if (upstream.status === 400) {
          this.log.debug(
            `playback ${host} answered 400 (treated as not recorded)`,
          );
        }
        return { ok: false, reason: 'NOT_FOUND' };
      }
      this.log.warn(`playback ${host} answered ${upstream.status}`);
      return { ok: false, reason: 'UNAVAILABLE' };
    }
    return { ok: true, body: upstream.body };
  }
}
