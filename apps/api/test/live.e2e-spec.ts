import { INestApplication, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import { io, type Socket } from 'socket.io-client';
import { ContractsService } from '../src/contracts/contracts.service';
import { CameraStatusService } from '../src/cameras/camera-status.service';
import { LiveGateway } from '../src/live/live.gateway';
import { StatusBroadcaster } from '../src/live/status-broadcaster';
import { PrismaService } from '../src/prisma/prisma.service';
import { ActorResolver } from '../src/auth/actor-resolver';
import { SessionService } from '../src/auth/session.service';
import { sha256hex } from '../src/auth/hash';
import { REDIS } from '../src/redis/redis.module';
import { createTestApp, listenTestApp } from './app';
import { asRole, seedUser } from './helpers/auth';
import { addCamera } from './helpers/analytics';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

type Message = { name: string; payload: unknown };
type Ack = { ok: boolean; code?: string };

describe('WebSocket gateway at /ws', () => {
  let app: INestApplication<App>;
  let base: string;
  let redis: Redis;
  let gateway: LiveGateway;
  let sockets: Socket[] = [];
  let received: Message[];

  /** Connects with a cookie (and any extra header); resolves when connected, rejects with the refusal. */
  const connect = (
    headers: Record<string, string> = {},
    recordAs?: string,
  ): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = io(base, {
        path: '/ws',
        transports: ['websocket'],
        reconnection: false,
        extraHeaders: headers,
      });
      sockets.push(socket);
      for (const name of ['session.ended', 'status.snapshot']) {
        socket.on(name, (payload: unknown) =>
          received.push({ name: `${recordAs ?? 'socket'}:${name}`, payload }),
        );
      }
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', (err) => reject(err));
    });
  const refusal = async (headers: Record<string, string>) => {
    try {
      await connect(headers);
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error('the socket was accepted');
  };
  const next = <T>(socket: Socket, name: string, ms = 5000): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no ${name} within ${ms} ms`)),
        ms,
      );
      socket.once(name, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  const ack = (socket: Socket, name: string, body: unknown) =>
    new Promise<Ack>((resolve) => socket.emit(name, body, resolve));
  const closed = (socket: Socket, ms = 5000) =>
    new Promise<string>((resolve, reject) => {
      if (socket.disconnected) return resolve('already');
      const timer = setTimeout(() => reject(new Error('still connected')), ms);
      socket.once('disconnect', (reason) => {
        clearTimeout(timer);
        resolve(reason);
      });
    });
  const members = async (room: string) =>
    (await gateway.server.in(room).fetchSockets()).map(
      (s) => (s.data as { userId: string }).userId,
    );
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    await resetDb();
    await flushRedis();
    app = await createTestApp();
    base = await listenTestApp(app);
    redis = app.get<Redis>(REDIS);
    gateway = app.get(LiveGateway);
    await addCamera('cam_a');
    await addCamera('cam_b');
    await addCamera('cam_c');
    await redis.hset('cam:cam_a:status', {
      state: 'running',
      fps: '4.5',
      lastFrameAt: '1760000000000',
      appliedVersion: '3',
      configError: '',
      restarts: '1',
      live: JSON.stringify({ vehicles: 2 }),
      updatedAt: '1760000000500',
    });
  });

  beforeEach(() => {
    received = [];
  });

  afterEach(() => {
    for (const socket of sockets) socket.close();
    sockets = [];
  });

  afterAll(async () => {
    await app.close();
  });

  it('no cookie, a dead session, or only a Bearer token → connect_error UNAUTHENTICATED', async () => {
    expect(await refusal({})).toBe('UNAUTHENTICATED');
    expect(await refusal({ Cookie: 'zoo_session=not-a-session' })).toBe(
      'UNAUTHENTICATED',
    );
    expect(await refusal({ Authorization: 'Bearer zv_abcdef' })).toBe(
      'UNAUTHENTICATED',
    );
  });

  it('an Authorization header next to a good cookie is ignored: the cookie session connects as itself', async () => {
    const { cookie, user } = await asRole(app, 'USER');
    const socket = await connect({
      Cookie: cookie,
      Authorization: 'Bearer zv_abcdef',
    });
    expect(socket.connected).toBe(true);
    expect(await members('alerts')).toContain(user.id);
  });

  it('an Origin from another host is refused with FORBIDDEN_ORIGIN, the same host is allowed', async () => {
    const { cookie } = await asRole(app, 'USER');
    expect(await refusal({ Cookie: cookie, Origin: 'http://evil.test' })).toBe(
      'FORBIDDEN_ORIGIN',
    );
    const host = new URL(base).host;
    const socket = await connect({ Cookie: cookie, Origin: `http://${host}` });
    expect(socket.connected).toBe(true);
  });

  it('a USER joins alerts but not managers; a MANAGER joins both', async () => {
    const user = await asRole(app, 'USER');
    const manager = await asRole(app, 'MANAGER');
    await connect({ Cookie: user.cookie });
    await connect({ Cookie: manager.cookie });

    expect((await members('alerts')).sort()).toEqual(
      [user.user.id, manager.user.id].sort(),
    );
    expect(await members('managers')).toEqual([manager.user.id]);
    expect(await members(`user:${user.user.id}`)).toEqual([user.user.id]);
    expect(await members('status')).toEqual([]);
  });

  it('subscribe status → status.snapshot within 3 s listing every camera; one with a status hash is parsed, the others null', async () => {
    const { cookie } = await asRole(app, 'USER');
    const socket = await connect({ Cookie: cookie });
    const snapshot = next<{ at: string; cameras: Record<string, unknown> }>(
      socket,
      'status.snapshot',
      3000,
    );

    expect(await ack(socket, 'subscribe', { rooms: ['status'] })).toEqual({
      ok: true,
    });
    const { at, cameras } = await snapshot;

    expect(new Date(at).toISOString()).toBe(at);
    expect(Object.keys(cameras).sort()).toEqual(['cam_a', 'cam_b', 'cam_c']);
    expect(cameras.cam_a).toEqual({
      state: 'running',
      fps: 4.5,
      lastFrameAt: 1760000000000,
      appliedVersion: 3,
      configError: null,
      restarts: 1,
      live: { vehicles: 2 },
      updatedAt: 1760000000500,
    });
    expect(cameras.cam_b).toBeNull();
    expect(cameras.cam_c).toBeNull();
  });

  it('nothing is sent to a socket that has not subscribed; unsubscribe stops the snapshots', async () => {
    const { cookie } = await asRole(app, 'USER');
    const socket = await connect({ Cookie: cookie }, 'quiet');
    await wait(2600);
    expect(received.filter((m) => m.name === 'quiet:status.snapshot')).toEqual(
      [],
    );

    await ack(socket, 'subscribe', { rooms: ['status'] });
    await next(socket, 'status.snapshot', 3000);
    expect(await ack(socket, 'unsubscribe', { rooms: ['status'] })).toEqual({
      ok: true,
    });
    expect(await members('status')).toEqual([]);
  });

  it('subscribe {rooms: ["managers"]} → ack {ok: false, code: "VALIDATION_FAILED"}', async () => {
    const { cookie } = await asRole(app, 'USER');
    const socket = await connect({ Cookie: cookie });
    for (const body of [
      { rooms: ['managers'] },
      { rooms: ['alerts'] },
      { rooms: [] },
      { rooms: 'status' },
      {},
      null,
      'status',
    ]) {
      expect([body, await ack(socket, 'subscribe', body)]).toEqual([
        body,
        { ok: false, code: 'VALIDATION_FAILED' },
      ]);
    }
    expect(await members('managers')).toEqual([]);
    expect(socket.connected).toBe(true);
  });

  it('logging out in one tab ends both sockets of that session with session.ended logout', async () => {
    const { cookie, user } = await asRole(app, 'USER');
    const first = await connect({ Cookie: cookie }, 'tab1');
    const second = await connect({ Cookie: cookie }, 'tab2');
    // the same user on another device, and another user
    const sibling = await connect(
      {
        Cookie: `zoo_session=${await app.get(SessionService).create(user.id, {})}`,
      },
      'sibling',
    );
    const other = await asRole(app, 'USER');
    const bystander = await connect({ Cookie: other.cookie }, 'other');

    const ended = [
      next(first, 'session.ended'),
      next(second, 'session.ended'),
      closed(first),
      closed(second),
    ];
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', cookie)
      .expect(204);

    const [a, b] = await Promise.all(ended);
    expect(a).toEqual({ reason: 'logout' });
    expect(b).toEqual({ reason: 'logout' });
    // neither the user's other session nor another user's socket is touched
    await wait(300);
    expect(sibling.connected).toBe(true);
    expect(bystander.connected).toBe(true);
  });

  it("changing the password ends the user's other sessions' sockets, not this session's", async () => {
    const user = await seedUser(app, 'USER');
    const sessions = app.get(SessionService);
    const here = `zoo_session=${await sessions.create(user.id, {})}`;
    const elsewhere = `zoo_session=${await sessions.create(user.id, {})}`;
    const mine = await connect({ Cookie: here }, 'mine');
    const theirs = await connect({ Cookie: elsewhere }, 'theirs');

    const ended = next(theirs, 'session.ended');
    await request(app.getHttpServer())
      .put('/api/v1/auth/password')
      .set('Cookie', here)
      .send({ currentPassword: user.password, newPassword: 'a-new-password-1' })
      .expect(204);

    expect(await ended).toEqual({ reason: 'revoked' });
    await closed(theirs);
    await wait(300);
    expect(mine.connected).toBe(true);
    expect(received.some((m) => m.name === 'mine:session.ended')).toBe(false);
  });

  it('disabling the user → session.ended disabled; changing the role → session.ended role_changed', async () => {
    const admin = await asRole(app, 'SUPERADMIN');
    const patch = (id: string, body: object) =>
      request(app.getHttpServer())
        .patch(`/api/v1/users/${id}`)
        .set('Cookie', admin.cookie)
        .send(body);

    const demoted = await asRole(app, 'MANAGER');
    const roleSocket = await connect({ Cookie: demoted.cookie }, 'role');
    const roleEnded = next(roleSocket, 'session.ended');
    await patch(demoted.user.id, { role: 'USER' }).expect(200);
    expect(await roleEnded).toEqual({ reason: 'role_changed' });
    await closed(roleSocket);
    // the session itself is still good: the client reconnects with it and lands in the right rooms
    const again = await connect({ Cookie: demoted.cookie }, 'role2');
    expect(await members('managers')).not.toContain(demoted.user.id);
    expect(again.connected).toBe(true);

    const gone = await asRole(app, 'USER');
    const goneSocket = await connect({ Cookie: gone.cookie }, 'gone');
    const goneEnded = next(goneSocket, 'session.ended');
    await patch(gone.user.id, { active: false }).expect(200);
    expect(await goneEnded).toEqual({ reason: 'disabled' });
    await closed(goneSocket);
    // and its next REST call is refused
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', gone.cookie)
      .expect(401);
  });

  it('recheck() ends a socket whose session has expired, with reason expired', async () => {
    const live = await asRole(app, 'USER');
    const expired = await asRole(app, 'USER');
    const keeps = await connect({ Cookie: live.cookie }, 'live');
    const loses = await connect({ Cookie: expired.cookie }, 'expired');

    // the session is gone from Redis (its 7 days or 12 idle hours ran out)
    await redis.del(`sess:${sha256hex(expired.cookie.split('=')[1])}`);
    const ended = next(loses, 'session.ended');
    await gateway.recheck();

    expect(await ended).toEqual({ reason: 'expired' });
    await closed(loses);
    expect(keeps.connected).toBe(true);
  });

  it("recheck() ends sockets whose user was demoted or disabled behind the gateway's back", async () => {
    const demoted = await asRole(app, 'MANAGER');
    const disabled = await asRole(app, 'USER');
    const fine = await asRole(app, 'MANAGER');
    const a = await connect({ Cookie: demoted.cookie }, 'demoted');
    const b = await connect({ Cookie: disabled.cookie }, 'disabled');
    const c = await connect({ Cookie: fine.cookie }, 'fine');

    // a change that never went through UsersService (no AccessEvents), e.g. a race at connect time
    await ownerQuery(
      `UPDATE "User" SET "role" = 'USER' WHERE "id" = $1`,
      demoted.user.id,
    );
    await ownerQuery(
      `UPDATE "User" SET "active" = false WHERE "id" = $1`,
      disabled.user.id,
    );
    const endedA = next(a, 'session.ended');
    const endedB = next(b, 'session.ended');
    await gateway.recheck();

    expect(await endedA).toEqual({ reason: 'role_changed' });
    expect(await endedB).toEqual({ reason: 'disabled' });
    await Promise.all([closed(a), closed(b)]);
    expect(c.connected).toBe(true);
  });

  it('a handshake that could not check the session (Redis or Postgres down) is refused with UNAVAILABLE', async () => {
    const { cookie } = await asRole(app, 'USER');
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const down = jest
      .spyOn(app.get(ActorResolver), 'resolveWithSession')
      .mockRejectedValueOnce(new Error('Connection is closed.'));
    try {
      expect(await refusal({ Cookie: cookie })).toBe('UNAVAILABLE');
      expect(
        (warn.mock.calls as unknown[][]).some((c) =>
          String(c[0]).includes('Connection is closed'),
        ),
      ).toBe(true);
    } finally {
      down.mockRestore();
      warn.mockRestore();
    }
    // and the same cookie connects once the dependency is back
    expect((await connect({ Cookie: cookie })).connected).toBe(true);
  });

  it('recheck() does not slide the session it checks', async () => {
    const { cookie } = await asRole(app, 'USER');
    await connect({ Cookie: cookie });
    const key = `sess:${sha256hex(cookie.split('=')[1])}`;
    await redis.pexpire(key, 60_000);

    await gateway.recheck();

    expect(await redis.pttl(key)).toBeLessThanOrEqual(60_000);
  });

  it('a Redis error during a status tick is logged once and the next tick sends a snapshot', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const read = jest
      .spyOn(app.get(CameraStatusService), 'read')
      .mockRejectedValue(new Error('Connection is closed.'));
    try {
      const { cookie } = await asRole(app, 'USER');
      const socket = await connect({ Cookie: cookie }, 'redis');
      await ack(socket, 'subscribe', { rooms: ['status'] });

      // three failing ticks (2 s apart) produce one log line, and no snapshot
      await wait(5200);
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
      const lines = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('status'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('Connection is closed');
      expect(
        received.filter((m) => m.name === 'redis:status.snapshot'),
      ).toEqual([]);

      // Redis is back: the next tick sends one
      read.mockRestore();
      const snapshot = await next<{ cameras: object }>(
        socket,
        'status.snapshot',
        3500,
      );
      expect(Object.keys(snapshot.cameras)).toHaveLength(3);
    } finally {
      read.mockRestore();
      warn.mockRestore();
    }
  });

  it('a Postgres that does not answer does not stop the snapshots: the cached camera ids are used', async () => {
    const { cookie } = await asRole(app, 'USER');
    const socket = await connect({ Cookie: cookie }, 'slowpg');
    await ack(socket, 'subscribe', { rooms: ['status'] });
    await next(socket, 'status.snapshot', 3000); // the ids are cached now

    // the cache is old, and the refresh never returns
    const broadcaster = app.get<StatusBroadcaster>(
      StatusBroadcaster,
    ) as unknown as {
      ids: { at: number; list: string[] } | null;
    };
    expect(broadcaster.ids).not.toBeNull();
    broadcaster.ids!.at = 0;
    const hang = jest
      .spyOn(app.get(PrismaService).camera, 'findMany')
      .mockImplementation(() => new Promise(() => undefined) as never);
    try {
      const snapshot = await next<{ cameras: object }>(
        socket,
        'status.snapshot',
        5000,
      );
      expect(Object.keys(snapshot.cameras)).toHaveLength(3);
    } finally {
      hang.mockRestore();
    }
  });

  it('every message the gateway sends validates with validateWsMessage', async () => {
    const { validator } = app.get(ContractsService);
    const user = await asRole(app, 'USER');
    const socket = await connect({ Cookie: user.cookie }, 'v');
    await ack(socket, 'subscribe', { rooms: ['status'] });
    await next(socket, 'status.snapshot', 3000);
    const ended = next(socket, 'session.ended');
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', user.cookie)
      .expect(204);
    await ended;

    const messages = received.filter((m) => m.name.startsWith('v:'));
    expect(messages.map((m) => m.name.slice(2))).toEqual(
      expect.arrayContaining(['status.snapshot', 'session.ended']),
    );
    for (const m of messages) {
      const name = m.name.slice(2);
      expect([name, validator.validateWsMessage(name, m.payload)]).toEqual([
        name,
        { ok: true },
      ]);
    }
  });
});
