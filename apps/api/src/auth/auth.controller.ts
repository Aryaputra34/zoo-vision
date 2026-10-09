import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import type { CookieOptions, Request, Response } from 'express';
import { ENV, type Env } from '../config/env';
import type { Actor, ActorRequest } from './actor';
import { SESSION_COOKIE } from './auth.guard';
import { AuthService, type LoginUser } from './auth.service';
import { CurrentActor, Public } from './decorators';
import { LocalAuthGuard } from './local-auth.guard';
import { LoginThrottlerGuard } from './login-throttler.guard';
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
  @ApiBody({ type: LoginDto })
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

  @HttpCode(204)
  @Post('logout')
  async logout(
    @CurrentActor() actor: Actor,
    @Req() req: ActorRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = (req.cookies as Record<string, string>)[SESSION_COOKIE];
    await this.auth.logout(actor.id, token, requestMeta(req));
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }

  @Get('me')
  me(@CurrentActor() actor: Actor): Actor {
    return actor;
  }
}
