import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { apiError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { PlaybackService } from './playback.service';

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
    private readonly playback: PlaybackService,
  ) {}

  /**
   * Streams the MP4 around an event from MediaMTX's playback server (see PlaybackService). Everything that can be answered
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
    if (!camera || !event.cameraId) throw unavailable();
    const clip = await this.playback.open(
      { ...camera, id: event.cameraId },
      event.time,
      gone.signal,
    );
    if (!clip.ok) throw unavailable();
    const after = camera.clipAfterSec;

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
        Readable.fromWeb(clip.body as WebReadableStream<Uint8Array>),
        res,
      );
    } catch {
      // the client left, or playback died mid-clip: pipeline has cut the response, so the
      // download fails and is never taken for a whole clip
    }
  }
}
