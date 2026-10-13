import { randomBytes } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Actor } from '../auth/actor';
import { sha256hex } from '../auth/hash';
import type { Role } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { ApiTokenDto, CreatedApiTokenDto } from './dto/api-token.dto';

export const TOKEN_PREFIX = 'zv_';
/** 32 random bytes as base64url is 43 characters; anything much longer is not ours. */
export const MAX_TOKEN_LENGTH = 128;
const LAST_USED_REFRESH_MS = 60_000;

@Injectable()
export class ApiTokensService {
  private readonly logger = new Logger(ApiTokensService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(
    creatorId: string,
    name: string,
    role: Role,
  ): Promise<CreatedApiTokenDto> {
    const raw = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const row = await this.prisma.apiToken.create({
      data: {
        name,
        role,
        prefix: raw.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 8),
        tokenHash: sha256hex(raw),
        createdById: creatorId,
      },
    });
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      prefix: row.prefix,
      createdAt: row.createdAt,
      token: raw,
    };
  }

  async list(): Promise<ApiTokenDto[]> {
    const rows = await this.prisma.apiToken.findMany({
      orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { username: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      prefix: r.prefix,
      createdBy: r.createdBy.username,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      revokedAt: r.revokedAt,
    }));
  }

  /** Sets `revokedAt` once; revoking again changes nothing. 404 for an unknown id. */
  async revoke(
    id: string,
  ): Promise<{ id: string; name: string; prefix: string }> {
    const row = await this.prisma.apiToken.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('API token not found');
    if (!row.revokedAt) {
      await this.prisma.apiToken.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return { id: row.id, name: row.name, prefix: row.prefix };
  }

  /** The actor for a raw token; null when it is unknown or revoked. */
  async resolve(raw: string): Promise<Actor | null> {
    if (raw.length > MAX_TOKEN_LENGTH || !raw.startsWith(TOKEN_PREFIX)) {
      return null;
    }
    const token = await this.prisma.apiToken.findUnique({
      where: { tokenHash: sha256hex(raw) },
    });
    if (!token || token.revokedAt) return null;

    const now = Date.now();
    if (
      !token.lastUsedAt ||
      now - token.lastUsedAt.getTime() > LAST_USED_REFRESH_MS
    ) {
      try {
        await this.prisma.apiToken.update({
          where: { id: token.id },
          data: { lastUsedAt: new Date(now) },
        });
      } catch (err) {
        this.logger.warn(
          `Could not update lastUsedAt for API token ${token.id}: ${(err as Error).message}`,
        );
      }
    }
    return { type: 'token', id: token.id, name: token.name, role: token.role };
  }
}
