import { Injectable } from '@nestjs/common';
import { apiError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import type { EvidenceDto } from './dto/evidence.dto';

@Injectable()
export class EvidenceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Keeps the clip of an event by hand. An event with a row already answers with it; a `FAILED`
   * or `NO_RECORDING` row is queued again (a manual retry). The pin tick does the copying.
   */
  async keep(eventId: string): Promise<EvidenceDto> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { cameraId: true, time: true },
    });
    if (!event) throw apiError(404, 'NOT_FOUND', 'Event not found');
    if (!event.cameraId) {
      throw apiError(
        404,
        'RECORDING_NOT_AVAILABLE',
        'The recording of this event is not available',
      );
    }
    // one statement each, so two requests at once end in one row. Never earlier than ingest would
    // have copied it (event time + clipAfterSec + 60 s): a clip of an event that has just happened
    // is not recorded yet, and a cut-short copy would be stored as KEPT for good
    await this.prisma.$executeRaw`
      INSERT INTO "Evidence" ("eventId", "cameraId", "eventTime", "reason", "runAt")
      SELECT e."id", e."cameraId", e."time", 'USER',
             GREATEST(now(), e."time" + make_interval(secs => c."clipAfterSec" + 60))
        FROM "Event" e JOIN "Camera" c ON c."id" = e."cameraId"
       WHERE e."id" = ${eventId}
      ON CONFLICT DO NOTHING`;
    await this.prisma.$executeRaw`
      UPDATE "Evidence" ev
         SET "status" = 'QUEUED', "attempts" = 0, "error" = NULL,
             "runAt" = GREATEST(now(), ev."eventTime" + make_interval(secs => c."clipAfterSec" + 60))
        FROM "Camera" c
       WHERE ev."eventId" = ${eventId} AND c."id" = ev."cameraId"
         AND ev."status" IN ('FAILED', 'NO_RECORDING')`;
    const { status, reason } = await this.prisma.evidence.findUniqueOrThrow({
      where: { eventId },
    });
    return { eventId, status, reason };
  }
}
