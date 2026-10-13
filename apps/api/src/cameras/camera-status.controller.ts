import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  StreamableFile,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  type CameraStatus,
  CameraStatusService,
} from './camera-status.service';

export type CameraOnline = { online: boolean; status: CameraStatus | null };

const toOnline = (status: CameraStatus | null): CameraOnline => ({
  online: status !== null,
  status,
});

/** Live state from Redis, for any role: the engine's status hash and its latest frame. */
@Controller()
export class CameraStatusController {
  constructor(
    private readonly statuses: CameraStatusService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('camera-status')
  async list(): Promise<({ cameraId: string } & CameraOnline)[]> {
    const cameras = await this.prisma.camera.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const statuses = await this.statuses.read(cameras.map((c) => c.id));
    return cameras.map(({ id }) => ({
      cameraId: id,
      ...toOnline(statuses.get(id) ?? null),
    }));
  }

  @Get('cameras/:id/status')
  async get(@Param('id') id: string): Promise<CameraOnline> {
    await this.assertCamera(id);
    return toOnline((await this.statuses.read([id])).get(id) ?? null);
  }

  @Get('cameras/:id/frame')
  @Header('Cache-Control', 'no-store')
  async frame(@Param('id') id: string): Promise<StreamableFile> {
    await this.assertCamera(id);
    const jpeg = await this.statuses.frame(id);
    if (!jpeg) throw new NotFoundException('No frame yet');
    return new StreamableFile(jpeg, { type: 'image/jpeg' });
  }

  private async assertCamera(id: string): Promise<void> {
    const found = await this.prisma.camera.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Camera not found');
  }
}
