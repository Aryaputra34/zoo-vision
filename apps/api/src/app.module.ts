import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TerminusModule } from '@nestjs/terminus';
import { ApiTokensModule } from './api-tokens/api-tokens.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ENV, type Env } from './config/env';
import { CamerasModule } from './cameras/cameras.module';
import { ContractsModule } from './contracts/contracts.module';
import { EngineInternalModule } from './engine-internal/engine-internal.module';
import { HealthController } from './health/health.controller';
import { IngestModule } from './ingest/ingest.module';
import { JobsModule } from './jobs/jobs.module';
import { PrismaModule } from './prisma/prisma.module';
import { TransientDbFilter } from './prisma/transient.filter';
import { RedisModule } from './redis/redis.module';
import { UsersModule } from './users/users.module';

@Module({})
export class AppModule {
  /** `env` comes from loadEnv(); ENV is global, so every module can inject it. */
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        PrismaModule,
        RedisModule,
        ContractsModule,
        TerminusModule,
        AuthModule,
        AuditModule,
        UsersModule,
        ApiTokensModule,
        CamerasModule,
        EngineInternalModule,
        IngestModule,
        JobsModule,
      ],
      controllers: [HealthController],
      providers: [
        { provide: ENV, useValue: env },
        { provide: APP_FILTER, useClass: TransientDbFilter },
      ],
      exports: [ENV],
    };
  }
}
