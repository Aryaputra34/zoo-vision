import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  StreamableFile,
} from '@nestjs/common';
import { ApiOkResponse, ApiProduces } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import {
  type CameraStatus,
  CameraStatusService,
} from './camera-status.service';
import { CameraOnlineDto, CameraStatusEntryDto } from './dto/camera-status.dto';

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
  @ApiOkResponse({
    type: [CameraStatusEntryDto],
    description: 'Every camera, by id',
  })
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
  @ApiOkResponse({ type: CameraOnlineDto })
  async get(@Param('id') id: string): Promise<CameraOnline> {
    await this.assertCamera(id);
    return toOnline((await this.statuses.read([id])).get(id) ?? null);
  }

  @Get('cameras/:id/frame')
  @Header('Cache-Control', 'no-store')
  @ApiProduces('image/jpeg')
  @ApiOkResponse({
    description: "The engine's latest frame (404 until it has sent one)",
    content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } },
  })
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
