import { Logger, OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { Subscription } from 'rxjs';
import { type AccessEnded, AccessEvents } from '../auth/access-events';
import { ActorResolver } from '../auth/actor-resolver';
import { SessionService } from '../auth/session.service';
import { PrismaService } from '../prisma/prisma.service';
import { ContractsService } from '../contracts/contracts.service';
import { authorizeHandshake, type SocketUser } from './handshake';

const RECHECK_MS = 60_000;

type Ack = { ok: true } | { ok: false; code: 'VALIDATION_FAILED' };

/**
 * The dashboard's socket.io endpoint at `/ws` (WebSocket transport only). It says "something
 * changed" or carries small live values; REST stays the source of truth.
 *
 * Rooms: `alerts` (everyone), `managers` (MANAGER and SUPERADMIN), `user:<id>` (to end a user's
 * sockets) and `status` (on request).
 */
@WebSocketGateway({
  path: '/ws',
  transports: ['websocket'],
  serveClient: false,
})
export class LiveGateway
  implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy
{
  @WebSocketServer() server!: Server;

  private readonly log = new Logger(LiveGateway.name);
  private ended?: Subscription;
  private timer?: NodeJS.Timeout;
  private recheckWarnedAt = 0;
  private rechecking = false;

  constructor(
    private readonly resolver: ActorResolver,
    private readonly sessions: SessionService,
    private readonly access: AccessEvents,
    private readonly contracts: ContractsService,
    private readonly prisma: PrismaService,
  ) {}

  afterInit(server: Server): void {
    // the handshake: no cookie session, no socket
    server.use((socket, next) => {
      authorizeHandshake(socket.request, this.resolver).then(
        (result) => {
          if ('error' in result) return next(new Error(result.error));
          socket.data = result;
          next();
        },
        (err: unknown) => {
          // Redis or Postgres is down: refuse. socket.io does NOT retry a refused handshake: the
          // client must call socket.connect() again (docs/fe-contract.md, section 12)
          this.log.warn(`handshake failed: ${errorText(err)}`);
          next(new Error('UNAVAILABLE'));
        },
      );
    });

    this.ended = this.access.ended$.subscribe((e) => {
      this.end(e).catch((err: unknown) =>
        this.log.warn(`ending sockets failed: ${errorText(err)}`),
      );
    });
    this.timer = setInterval(() => {
      this.recheck().catch((err: unknown) =>
        this.log.warn(`session recheck failed: ${errorText(err)}`),
      );
    }, RECHECK_MS);
    this.timer.unref();
  }

  handleConnection(socket: Socket): void {
    const user = socket.data as SocketUser;
    void socket.join(['alerts', `user:${user.userId}`]);
    if (user.role === 'MANAGER' || user.role === 'SUPERADMIN') {
      void socket.join('managers');
    }
  }

  onModuleDestroy(): void {
    this.ended?.unsubscribe();
    if (this.timer) clearInterval(this.timer);
  }

  @SubscribeMessage('subscribe')
  async subscribe(
    @MessageBody() body: unknown,
    @ConnectedSocket() socket: Socket,
  ): Promise<Ack> {
    const rooms = this.rooms('subscribe', body);
    if (!rooms) return { ok: false, code: 'VALIDATION_FAILED' };
    await socket.join(rooms);
    return { ok: true };
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(
    @MessageBody() body: unknown,
    @ConnectedSocket() socket: Socket,
  ): Promise<Ack> {
    const rooms = this.rooms('unsubscribe', body);
    if (!rooms) return { ok: false, code: 'VALIDATION_FAILED' };
    for (const room of rooms) await socket.leave(room);
    return { ok: true };
  }

  /** To everyone connected. */
  toAlerts(name: string, payload: unknown): void {
    this.server.to('alerts').emit(name, payload);
  }

  /** To MANAGER and SUPERADMIN sockets only. */
  toManagers(name: string, payload: unknown): void {
    this.server.to('managers').emit(name, payload);
  }

  /**
   * Every 60 s: ends the sockets whose session no longer exists (its 12 idle hours or 7 days ran
   * out), and the sockets whose user was disabled or got another role without an access event
   * reaching them (a change racing a connect, or a revoke that failed after the commit). A Redis or
   * Postgres error leaves the sockets alone: a blip must not log everybody out.
   */
  async recheck(): Promise<void> {
    if (this.rechecking) return;
    this.rechecking = true;
    try {
      const sockets = await this.server.fetchSockets();
      const users = await this.prisma.user.findMany({
        where: {
          id: {
            in: [...new Set(sockets.map((s) => (s.data as SocketUser).userId))],
          },
        },
        select: { id: true, role: true, active: true },
      });
      const byId = new Map(users.map((u) => [u.id, u]));
      const live = new Map<string, boolean>();
      for (const socket of sockets) {
        const { sessionHash, userId, role } = socket.data as SocketUser;
        let alive = live.get(sessionHash);
        if (alive === undefined) {
          alive = await this.sessions.isLive(sessionHash);
          live.set(sessionHash, alive);
        }
        const user = byId.get(userId);
        const reason = !alive
          ? 'expired'
          : !user || !user.active
            ? 'disabled'
            : user.role !== role
              ? 'role_changed'
              : null;
        if (reason) {
          socket.emit('session.ended', { reason });
          socket.disconnect(true);
        }
      }
    } catch (err) {
      this.warnRecheck(err);
    } finally {
      this.rechecking = false;
    }
  }

  private async end(e: AccessEnded): Promise<void> {
    const sockets = await this.server.in(`user:${e.userId}`).fetchSockets();
    for (const socket of sockets) {
      const { sessionHash } = socket.data as SocketUser;
      if (e.sessionHash !== undefined && sessionHash !== e.sessionHash)
        continue;
      if (
        e.keepSessionHash !== undefined &&
        sessionHash === e.keepSessionHash
      ) {
        continue;
      }
      socket.emit('session.ended', { reason: e.reason });
      socket.disconnect(true);
    }
  }

  /** The rooms of a valid subscribe/unsubscribe message, or null (only `status` may be named). */
  private rooms(name: string, body: unknown): string[] | null {
    if (!this.contracts.validator.validateWsMessage(name, body).ok) return null;
    return (body as { rooms: string[] }).rooms;
  }

  private warnRecheck(err: unknown): void {
    if (Date.now() - this.recheckWarnedAt < 60_000) return;
    this.recheckWarnedAt = Date.now();
    this.log.warn(`session recheck skipped: ${errorText(err)}`);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
