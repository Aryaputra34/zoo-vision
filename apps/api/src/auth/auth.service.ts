import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { apiError } from '../common/errors';
import { LoginResult, Role } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { LockoutService } from './lockout.service';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password';
import { SessionService } from './session.service';

export type RequestMeta = { ip?: string; userAgent?: string };
export type LoginUser = {
  id: string;
  username: string;
  name: string;
  role: Role;
};

const MAX_LOGGED_USERNAME = 200;

export const normalizeUsername = (raw: string) => raw.trim().toLowerCase();

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly lockout: LockoutService,
  ) {}

  /**
   * Checks the credentials, writes exactly one LoginLog row for the outcome and, on success,
   * starts a session. Throws 401 (wrong password or unknown user), 403 (disabled), 423 (locked).
   */
  async login(
    typed: string,
    password: string,
    meta: RequestMeta,
  ): Promise<{ user: LoginUser; token: string }> {
    const username = normalizeUsername(typed);
    const user = await this.prisma.user.findUnique({ where: { username } });

    const lockedSec = await this.lockout.reserve(username);
    if (lockedSec > 0) {
      await this.record('LOCKED', typed, user?.id, meta);
      throw apiError(
        423,
        'ACCOUNT_LOCKED',
        `Account locked. Try again in ${Math.ceil(lockedSec / 60)} minutes.`,
      );
    }

    // Unknown users are compared against a dummy hash so the response time does not reveal them.
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      await this.record('WRONG_PASSWORD', typed, user?.id, meta);
      throw new UnauthorizedException('Invalid username or password');
    }
    await this.lockout.reset(username);
    if (!user.active) {
      await this.record('DISABLED', typed, user.id, meta);
      throw new ForbiddenException('Account disabled');
    }

    const token = await this.sessions.create(user.id, meta);
    await this.record('SUCCESS', typed, user.id, meta);
    return {
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
      },
      token,
    };
  }

  async logout(userId: string, token: string, meta: RequestMeta) {
    await this.sessions.destroy(token);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    await this.record('LOGOUT', user?.username ?? userId, userId, meta);
  }

  /**
   * Sets a new password after checking the current one (400 when it is wrong) and ends the
   * user's other sessions; the one named by `keepToken` stays.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    keepToken: string | undefined,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw apiError(400, 'WRONG_PASSWORD', 'Current password is wrong');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(newPassword) },
    });
    await this.sessions.revokeAllForUser(userId, keepToken);
  }

  /** Appends a LoginLog row (the API role can insert into it but never update it). */
  async record(
    result: LoginResult,
    typedUsername: string,
    userId: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    await this.prisma.loginLog.create({
      data: {
        result,
        username: typedUsername.slice(0, MAX_LOGGED_USERNAME),
        userId: userId ?? null,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      },
    });
  }
}
