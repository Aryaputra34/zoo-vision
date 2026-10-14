import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccessEvents } from '../auth/access-events';
import type { Actor } from '../auth/actor';
import { hashPassword } from '../auth/password';
import { SessionService } from '../auth/session.service';
import { apiError } from '../common/errors';
import { Role } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateUserDto } from './dto/create-user.dto';
import type { UpdateUserDto } from './dto/update-user.dto';
import { UserDto } from './dto/user.dto';

const isSuperadmin = (actor: Actor) => actor.role === Role.SUPERADMIN;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly access: AccessEvents,
  ) {}

  /** A manager sees USER and MANAGER accounts; a superadmin sees everyone. */
  async list(actor: Actor): Promise<UserDto[]> {
    const users = await this.prisma.user.findMany({
      where: isSuperadmin(actor)
        ? undefined
        : { role: { in: [Role.USER, Role.MANAGER] } },
      orderBy: [{ createdAt: 'asc' }, { username: 'asc' }],
    });
    return users.map((u) => UserDto.from(u));
  }

  async create(actor: Actor, dto: CreateUserDto): Promise<UserDto> {
    if (dto.role === Role.SUPERADMIN && !isSuperadmin(actor)) {
      throw new ForbiddenException('Only a superadmin can create a superadmin');
    }
    const passwordHash = await hashPassword(dto.password);
    try {
      const user = await this.prisma.user.create({
        data: {
          username: dto.username,
          name: dto.name,
          role: dto.role,
          passwordHash,
        },
      });
      return UserDto.from(user);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw apiError(409, 'USERNAME_TAKEN', 'Username already exists');
      }
      throw err;
    }
  }

  async update(
    actor: Actor,
    id: string,
    dto: UpdateUserDto,
  ): Promise<{ before: UserDto; after: UserDto }> {
    if (dto.role === Role.SUPERADMIN && !isSuperadmin(actor)) {
      throw new ForbiddenException('Only a superadmin can grant SUPERADMIN');
    }
    const passwordHash = dto.password
      ? await hashPassword(dto.password)
      : undefined;

    const { before, after } = await this.prisma.$transaction(async (tx) => {
      const current = await tx.user.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('User not found');
      if (current.role === Role.SUPERADMIN && !isSuperadmin(actor)) {
        throw new ForbiddenException(
          'Only a superadmin can change a superadmin',
        );
      }

      const stopsBeingActiveSuperadmin =
        current.role === Role.SUPERADMIN &&
        current.active &&
        (dto.active === false ||
          (dto.role !== undefined && dto.role !== Role.SUPERADMIN));
      if (stopsBeingActiveSuperadmin) {
        // Lock every active superadmin row: a concurrent demotion waits here and then counts
        // only the rows that are still active.
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "User" WHERE role = 'SUPERADMIN' AND active = true FOR UPDATE`;
        if (locked.length <= 1) {
          throw apiError(
            409,
            'LAST_SUPERADMIN',
            'Cannot remove the last active superadmin',
          );
        }
      }

      const updated = await tx.user.update({
        where: { id },
        data: {
          name: dto.name,
          role: dto.role,
          active: dto.active,
          passwordHash,
        },
      });
      return { before: current, after: updated };
    });

    if (dto.active === false || passwordHash) {
      // the sockets of a disabled user are told "disabled"; after a password reset, "revoked"
      await this.sessions.revokeAllForUser(
        id,
        undefined,
        dto.active === false ? 'disabled' : 'revoked',
      );
    }
    if (before.role !== after.role) {
      // the session stays valid: the client reconnects and lands in the rooms of its new role
      this.access.ended$.next({ userId: id, reason: 'role_changed' });
    }
    return { before: UserDto.from(before), after: UserDto.from(after) };
  }
}
