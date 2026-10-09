import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { LocalAuthGuard } from './local-auth.guard';
import { LocalStrategy } from './local.strategy';
import { LockoutService } from './lockout.service';
import { LoginThrottlerGuard } from './login-throttler.guard';
import { RolesGuard } from './roles.guard';
import { SessionService } from './session.service';

@Module({
  imports: [
    PassportModule,
    // Used only by LoginThrottlerGuard: 10 requests per minute per IP, counted in memory.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }]),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    LockoutService,
    LocalStrategy,
    LocalAuthGuard,
    LoginThrottlerGuard,
    // Order matters: authenticate first, then check the role.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [SessionService, LockoutService],
})
export class AuthModule {}
