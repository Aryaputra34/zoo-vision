import { DynamicModule, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { ENV, type Env } from './config/env';
import { ContractsModule } from './contracts/contracts.module';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';

@Module({})
export class AppModule {
  /** `env` comes from loadEnv(); ENV is global, so every module can inject it. */
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [PrismaModule, RedisModule, ContractsModule, TerminusModule],
      controllers: [HealthController],
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}
