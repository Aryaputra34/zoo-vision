import type { Request } from 'express';
import type { Role } from '../generated/prisma/enums';

/** Who is making a request. Set on `req.actor` by AuthGuard (a user session, later an API token). */
export type Actor = {
  type: 'user' | 'token';
  id: string;
  name: string;
  role: Role;
};

export type ActorRequest = Request & { actor?: Actor };

const RANK: Record<Role, number> = { USER: 0, MANAGER: 1, SUPERADMIN: 2 };

export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}
