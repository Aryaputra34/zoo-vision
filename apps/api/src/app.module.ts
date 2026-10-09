import { DynamicModule, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { ApiTokensModule } from './api-tokens/api-tokens.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ENV, type Env } from './config/env';
import { CamerasModule } from './cameras/cameras.module';
import { ContractsModule } from './contracts/contracts.module';
import { HealthController } from './health/health.controller';
import { IngestModule } from './ingest/ingest.module';
import { PrismaModule } from './prisma/prisma.module';
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
        IngestModule,
      ],
      controllers: [HealthController],
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}
