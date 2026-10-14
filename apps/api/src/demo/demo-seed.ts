import type { INestApplicationContext } from '@nestjs/common';
import type { Actor } from '../auth/actor';
import { CamerasService } from '../cameras/cameras.service';
import type { CreateCameraDto } from '../cameras/dto/create-camera.dto';
import { createSuperadmin } from '../cli';
import { SourceType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { DEMO_CAMERAS, DEMO_GROUP, DEMO_USERS } from './demo-cameras';

/**
 * Creates the demo cameras and users through the real services (so their rules, config versions and
 * `cfg:changed` notices are the real ones). The superadmin is created first and is the actor for the
 * rest. Idempotent: an existing username or camera id is skipped, never changed. Returns what it created.
 */
export async function seedDemo(
  app: INestApplicationContext,
  password: string,
): Promise<{ cameras: string[]; users: string[] }> {
  const prisma = app.get(PrismaService, { strict: false });
  const users = app.get(UsersService, { strict: false });
  const cameras = app.get(CamerasService, { strict: false });
  const created: { cameras: string[]; users: string[] } = {
    cameras: [],
    users: [],
  };

  const [adminSpec, ...others] = DEMO_USERS;
  let admin = await prisma.user.findUnique({
    where: { username: adminSpec.username },
  });
  if (!admin) {
    const id = await createSuperadmin(prisma, {
      username: adminSpec.username,
      name: adminSpec.name,
      password,
    });
    created.users.push(adminSpec.username);
    admin = await prisma.user.findUniqueOrThrow({ where: { id } });
  }
  const actor: Actor = {
    type: 'user',
    id: admin.id,
    name: admin.name,
    role: 'SUPERADMIN',
  };

  for (const spec of others) {
    const exists = await prisma.user.findUnique({
      where: { username: spec.username },
    });
    if (exists) continue;
    await users.create(actor, {
      username: spec.username,
      name: spec.name,
      role: spec.role,
      password,
    });
    created.users.push(spec.username);
  }

  for (const camera of DEMO_CAMERAS) {
    const exists = await prisma.camera.findUnique({
      where: { id: camera.id },
    });
    if (exists) continue;
    const dto: CreateCameraDto = {
      id: camera.id,
      name: camera.name,
      useCase: camera.useCase,
      sourceType: SourceType.FILE,
      mainStreamUrl: `demo/${camera.useCase}.mp4`,
      settings: camera.settings as Record<string, unknown>,
      note: 'demo seed',
      targetFps: 5,
      engineGroup: DEMO_GROUP,
      enabled: true,
      recordingPath: camera.recordingPath,
    };
    await cameras.create(actor, dto);
    created.cameras.push(camera.id);
  }
  return created;
}
