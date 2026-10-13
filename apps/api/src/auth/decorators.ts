import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Role } from '../generated/prisma/enums';
import type { Actor, ActorRequest } from './actor';

export const IS_PUBLIC_KEY = 'auth:public';
export const MIN_ROLE_KEY = 'auth:minRole';

/** The route needs no login. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** The route needs a logged-in actor of at least this role (default: any actor). */
export const MinRole = (role: Role) => SetMetadata(MIN_ROLE_KEY, role);

/** The authenticated {@link Actor} of this request. */
export const CurrentActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Actor | undefined =>
    ctx.switchToHttp().getRequest<ActorRequest>().actor,
);
