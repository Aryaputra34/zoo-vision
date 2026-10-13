import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../generated/prisma/enums';
import { roleAtLeast, type ActorRequest } from './actor';
import { IS_PUBLIC_KEY, MIN_ROLE_KEY } from './decorators';

/** Global guard, after AuthGuard: enforces `@MinRole`. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(
        IS_PUBLIC_KEY,
        targets,
      )
    ) {
      return true;
    }
    const min = this.reflector.getAllAndOverride<Role | undefined>(
      MIN_ROLE_KEY,
      targets,
    );
    if (!min) return true;
    const actor = context.switchToHttp().getRequest<ActorRequest>().actor;
    if (!actor || !roleAtLeast(actor.role, min)) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
