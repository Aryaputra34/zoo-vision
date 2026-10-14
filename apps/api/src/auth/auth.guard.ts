import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ActorRequest } from './actor';
import { ActorResolver } from './actor-resolver';
import { IS_PUBLIC_KEY } from './decorators';

export { SESSION_COOKIE } from './actor-resolver';

/**
 * Global guard. Public routes pass; otherwise {@link ActorResolver} must turn the session
 * cookie or the Bearer API token into an actor, which is left on `req.actor`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: ActorResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<ActorRequest>();
    const actor = await this.resolver.resolve(req);
    if (!actor) throw new UnauthorizedException();
    req.actor = actor;
    return true;
  }
}
