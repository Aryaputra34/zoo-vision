import { Controller, Get, Inject, VERSION_NEUTRAL } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
} from '@nestjs/terminus';
import Redis from 'ioredis';
import { Public } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.module';

const PROBE_TIMEOUT_MS = 2000;

/** GET /api/health: Postgres (`SELECT 1` as zoo_api) and Redis (`PING`). 503 when either is down. */
@Public()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService,
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.probe('database', () => this.prisma.$queryRaw`SELECT 1`),
      () => this.probe('redis', () => this.redis.ping()),
    ]);
  }

  private async probe<Key extends string>(
    key: Key,
    run: () => Promise<unknown>,
  ) {
    const indicator = this.indicators.check(key);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer within ${PROBE_TIMEOUT_MS} ms`)),
        PROBE_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([run(), timeout]);
      return indicator.up();
    } catch (err) {
      return indicator.down({ message: (err as Error).message });
    } finally {
      clearTimeout(timer);
    }
  }
}
