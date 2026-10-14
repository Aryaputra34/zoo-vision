import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';
import { ApiTokensModule } from '../api-tokens/api-tokens.module';
import { ActorResolver } from './actor-resolver';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { LocalAuthGuard } from './local-auth.guard';
import { LocalStrategy } from './local.strategy';
import { LockoutService } from './lockout.service';
import { LoginThrottlerGuard } from './login-throttler.guard';
import { PasswordThrottlerGuard } from './password-throttler.guard';
import { RolesGuard } from './roles.guard';
import { SessionService } from './session.service';

@Module({
  imports: [
    ApiTokensModule,
    PassportModule,
    // Used only by LoginThrottlerGuard (10 requests per minute per IP, the default here) and
    // PasswordThrottlerGuard (5 per 15 minutes per actor, set on the route), counted in memory.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }]),
  ],
  controllers: [AuthController],
  providers: [
    ActorResolver,
    AuthService,
    SessionService,
    LockoutService,
    LocalStrategy,
    LocalAuthGuard,
    LoginThrottlerGuard,
    PasswordThrottlerGuard,
    // Order matters: authenticate first, then check the role.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [ActorResolver, SessionService, LockoutService],
})
export class AuthModule {}
