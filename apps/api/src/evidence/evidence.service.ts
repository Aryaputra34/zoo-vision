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
    // one statement each, so two requests at once end in one row
    await this.prisma.$executeRaw`
      INSERT INTO "Evidence" ("eventId", "cameraId", "eventTime", "reason", "runAt")
      VALUES (${eventId}, ${event.cameraId}, ${event.time}, 'USER', now())
      ON CONFLICT DO NOTHING`;
    await this.prisma.evidence.updateMany({
      where: { eventId, status: { in: ['FAILED', 'NO_RECORDING'] } },
      data: { status: 'QUEUED', attempts: 0, error: null, runAt: new Date() },
    });
    const { status, reason } = await this.prisma.evidence.findUniqueOrThrow({
      where: { eventId },
    });
    return { eventId, status, reason };
  }
}
