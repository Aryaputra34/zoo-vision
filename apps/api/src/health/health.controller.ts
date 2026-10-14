import {
  Controller,
  Get,
  HttpException,
  Inject,
  Logger,
  VERSION_NEUTRAL,
} from '@nestjs/common';
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
  private readonly log = new Logger(HealthController.name);

  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService,
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** 503 keeps terminus's per-dependency map next to the standard error fields. */
  @Get()
  @HealthCheck()
  async check() {
    try {
      return await this.health.check([
        () => this.probe('database', () => this.prisma.$queryRaw`SELECT 1`),
        () => this.probe('redis', () => this.redis.ping()),
      ]);
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() === 503) {
        const result = err.getResponse();
        throw new HttpException(
          {
            ...(typeof result === 'object' ? result : {}),
            statusCode: 503,
            code: 'UNAVAILABLE',
            message: 'A dependency is down',
          },
          503,
        );
      }
      throw err;
    }
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
      // the body only says "down"; the reason is for the operator's log
      this.log.warn(`${key} probe failed: ${(err as Error).message}`);
      return indicator.down();
    } finally {
      clearTimeout(timer);
    }
  }
}
