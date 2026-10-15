import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiProperty,
  ApiResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import type { CookieOptions, Request, Response } from 'express';
import { setAudit, SkipAudit } from '../audit/audit-context';
import { ApiErrorBody } from '../common/errors';
import { ENV, type Env } from '../config/env';
import type { Actor, ActorRequest } from './actor';
import { SESSION_COOKIE } from './auth.guard';
import { AuthService, type LoginUser } from './auth.service';
import { ChangePasswordDto } from './change-password.dto';
import { ActorDto, LoginUserDto } from './dto/auth-response.dto';
import { CurrentActor, Public } from './decorators';
import { LocalAuthGuard } from './local-auth.guard';
import { LoginThrottlerGuard } from './login-throttler.guard';
import { PasswordThrottlerGuard } from './password-throttler.guard';
import { requestMeta } from './request-meta';
import { SESSION_MAX_MS } from './session-ttl';

export class LoginDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  username!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  password!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: this.env.COOKIE_SECURE,
    };
  }

  /** The credentials are checked by LocalAuthGuard (LocalStrategy), which leaves the result on req.user. */
  @Public()
  @SkipAudit()
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({ type: LoginUserDto })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'Invalid credentials or account disabled',
  })
  @ApiResponse({
    status: 423,
    type: ApiErrorBody,
    description: 'The account is temporarily locked (ACCOUNT_LOCKED)',
  })
  @ApiResponse({
    status: 429,
    type: ApiErrorBody,
    description: 'Too many login attempts (RATE_LIMITED)',
  })
  @UseGuards(LoginThrottlerGuard, LocalAuthGuard)
  @HttpCode(200)
  @Post('login')
  login(
    @Req() req: Request & { user: { user: LoginUser; token: string } },
    @Body() _body: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): LoginUser {
    const { user, token } = req.user;
    res.cookie(SESSION_COOKIE, token, {
      ...this.cookieOptions(),
      maxAge: SESSION_MAX_MS,
    });
    return user;
  }

  @SkipAudit()
  @HttpCode(204)
  @Post('logout')
  async logout(
    @CurrentActor() actor: Actor,
    @Req() req: ActorRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    // A Bearer actor has no session to end.
    if (actor.type === 'token') return;
    const token = (req.cookies as Record<string, string>)[SESSION_COOKIE];
    await this.auth.logout(actor.id, token, requestMeta(req));
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }

  /**
   * Caddy's forward_auth asks this before it lets a WHEP call through to MediaMTX: 204 with a
   * session or an API token, 401 (the global guard) without. No body.
   */
  @Get('check')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'A valid session or API token' })
  check(): void {
    // the global AuthGuard has done the work
  }

  @Get('me')
  @ApiOkResponse({ type: ActorDto })
  me(@CurrentActor() actor: Actor): Actor {
    return actor;
  }

  /** Session users only; an API token cannot change a password. Other sessions end, this one stays. */
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Password changed' })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'Invalid body or wrong current password (WRONG_PASSWORD)',
  })
  @ApiResponse({
    status: 429,
    type: ApiErrorBody,
    description: 'Too many password change attempts (RATE_LIMITED)',
  })
  @UseGuards(PasswordThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 15 * 60_000 } })
  @Put('password')
  async changePassword(
    @CurrentActor() actor: Actor,
    @Req() req: ActorRequest,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    if (actor.type === 'token') {
      throw new ForbiddenException('API tokens cannot change passwords');
    }
    const token = (req.cookies as Record<string, string>)[SESSION_COOKIE];
    await this.auth.changePassword(
      actor.id,
      dto.currentPassword,
      dto.newPassword,
      token,
    );
    setAudit(req, {
      action: 'user.password',
      entity: 'user',
      entityId: actor.id,
    });
  }
}
