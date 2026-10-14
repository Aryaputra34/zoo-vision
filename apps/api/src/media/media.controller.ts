import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import {
  Controller,
  Get,
  Inject,
  Param,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiOkResponse, ApiParam, ApiProduces } from '@nestjs/swagger';
import type { Response } from 'express';
import { apiError } from '../common/errors';
import { ENV, type Env } from '../config/env';
import { ClipsService } from './clips.service';
import { resolveSnapshot } from './snapshot-path';

/**
 * Event snapshots and clips, for any logged-in role. Outside the `api` prefix and the URI version,
 * so the URLs in event rows (`/media/...`) never change with the API version.
 */
@Controller({ path: 'media', version: VERSION_NEUTRAL })
export class MediaController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly clips: ClipsService,
  ) {}

  @Get('snapshots/*path')
  @ApiParam({
    name: 'path',
    type: String,
    description:
      '`<camera>/<date>/<event>.jpg`. Use the `snapshotUrl` of an event as it is: it is built for the browser',
  })
  @ApiProduces('image/jpeg')
  @ApiOkResponse({
    description: 'The JPEG the engine wrote for the event',
    content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } },
  })
  async snapshot(
    @Param('path') path: string | string[],
    @Res() res: Response,
  ): Promise<void> {
    const rel = Array.isArray(path) ? path.join('/') : path;
    const file = await resolveSnapshot(this.env.SNAPSHOT_DIR, rel);
    // open first, then answer from the handle: nothing is set on `res` that a failure must undo
    const handle = file ? await open(file, 'r').catch(() => null) : null;
    if (!handle) throw apiError(404, 'NOT_FOUND', 'Snapshot not found');

    try {
      const { size } = await handle.stat();
      res.set({
        'Content-Type': 'image/jpeg',
        'Content-Length': String(size),
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      });
      await pipeline(handle.createReadStream(), res);
    } catch {
      // the client left mid-file
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  @Get('clips/:eventId')
  @ApiProduces('video/mp4')
  @ApiOkResponse({
    description:
      'The MP4 around the event; 404 RECORDING_NOT_AVAILABLE when there is none',
    content: { 'video/mp4': { schema: { type: 'string', format: 'binary' } } },
  })
  async clip(
    @Param('eventId') eventId: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.clips.stream(eventId, res);
  }
}
