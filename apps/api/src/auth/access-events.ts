import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

/** Why a user's WebSocket connections must end. */
export type AccessEnded = {
  userId: string;
  reason: 'logout' | 'revoked' | 'disabled' | 'role_changed';
  /** Only the sockets of this session (a logout). */
  sessionHash?: string;
  /** Every socket of the user except those of this session (a password change keeps its own). */
  keepSessionHash?: string;
};

/** In-process: the services that end sessions say so here, the WebSocket gateway listens. */
@Injectable()
export class AccessEvents {
  readonly ended$ = new Subject<AccessEnded>();
}
