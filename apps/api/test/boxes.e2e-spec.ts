import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import { App } from 'supertest/types';
import type { BoxesMessage } from '@zoo-vision/contracts';
import { ContractsService } from '../src/contracts/contracts.service';
import { REDIS } from '../src/redis/redis.constants';
import { createTestApp, listenTestApp } from './app';
import { addCamera } from './helpers/analytics';
import { asRole } from './helpers/auth';
import { flushRedis, resetDb } from './setup/db';

type Ack = { ok: boolean; code?: string };

describe('Boxes relay via WebSocket room camera:<id>', () => {
  let app: INestApplication<App>;
  let base: string;
  let redis: Redis;
  let pubClient: Redis;
  let contracts: ContractsService;
  let sockets: Socket[] = [];
  let userCookie: Record<string, string>;

  const connect = (headers: Record<string, string> = {}): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = io(base, {
        path: '/ws',
        transports: ['websocket'],
        reconnection: false,
        extraHeaders: headers,
      });
      sockets.push(socket);
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', (err) => reject(err));
    });

  const ack = (socket: Socket, name: string, body: unknown) =>
    new Promise<Ack>((resolve) => socket.emit(name, body, resolve));

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const numsub = async (channel: string): Promise<number> => {
    const res = (await redis.call('PUBSUB', 'NUMSUB', channel)) as [
      string,
      number,
    ];
    return Number(res[1]);
  };

  beforeAll(async () => {
    await resetDb();
    await flushRedis();
    app = await createTestApp();
    base = await listenTestApp(app);
    redis = app.get<Redis>(REDIS);
    pubClient = redis.duplicate();
    contracts = app.get(ContractsService);

    userCookie = await asRole(app, 'USER');
    await addCamera('cam_box_1');
    await addCamera('cam_box_2');
  });

  afterEach(() => {
    for (const s of sockets) s.disconnect();
    sockets = [];
  });

  afterAll(async () => {
    if (pubClient) {
      pubClient.disconnect();
    }
    await app.close();
  });

  it('subscribe camera:<unknown> → {ok: false, code: "NOT_FOUND"}; camera:<id> → ok', async () => {
    const s = await connect(userCookie);

    const resUnknown = await ack(s, 'subscribe', {
      rooms: ['camera:cam_nonexistent'],
    });
    assertAck(resUnknown, false, 'NOT_FOUND');

    const resKnown = await ack(s, 'subscribe', {
      rooms: ['camera:cam_box_1'],
    });
    assertAck(resKnown, true);
  });

  it('a published box set reaches the room as `boxes` with sentAt and validates against ws/server/boxes', async () => {
    const s = await connect(userCookie);
    await ack(s, 'subscribe', { rooms: ['camera:cam_box_1'] });

    // Wait slightly for socket to join and create-room event to subscribe to Redis
    await wait(50);

    const boxPayload = {
      cameraId: 'cam_box_1',
      t: Date.now() - 50,
      boxes: [
        {
          trackId: 101,
          cls: 0,
          label: 'person',
          x1: 0.1,
          y1: 0.2,
          x2: 0.3,
          y2: 0.4,
        },
      ],
    };

    const receivedPromise = new Promise<BoxesMessage>((resolve) => {
      s.once('boxes', (payload: unknown) => resolve(payload as BoxesMessage));
    });

    await pubClient.publish('cam:cam_box_1:boxes', JSON.stringify(boxPayload));

    const msg = await receivedPromise;
    expect(msg.cameraId).toBe('cam_box_1');
    expect(msg.t).toBe(boxPayload.t);
    expect(typeof msg.sentAt).toBe('number');
    expect(msg.sentAt).toBeGreaterThanOrEqual(boxPayload.t);
    expect(msg.boxes).toHaveLength(1);
    expect(msg.boxes[0].trackId).toBe(101);

    // Validates against contracts ws/server/boxes
    const validation = contracts.validator.validateWsMessage('boxes', msg);
    expect(validation).toEqual({ ok: true });
  });

  it('no member → PUBSUB NUMSUB cam:<id>:boxes is 0; one member → 1', async () => {
    const channel = 'cam:cam_box_2:boxes';
    expect(await numsub(channel)).toBe(0);

    const s = await connect(userCookie);
    await ack(s, 'subscribe', { rooms: ['camera:cam_box_2'] });

    // Wait for room subscription to take effect
    await wait(100);
    expect(await numsub(channel)).toBe(1);

    await ack(s, 'unsubscribe', { rooms: ['camera:cam_box_2'] });
    await wait(100);
    expect(await numsub(channel)).toBe(0);
  });

  it('two sockets in the room, one disconnects → the other still receives; both gone → NUMSUB 0', async () => {
    const channel = 'cam:cam_box_1:boxes';
    const s1 = await connect(userCookie);
    const s2 = await connect(userCookie);

    await ack(s1, 'subscribe', { rooms: ['camera:cam_box_1'] });
    await ack(s2, 'subscribe', { rooms: ['camera:cam_box_1'] });
    await wait(100);

    expect(await numsub(channel)).toBe(1);

    // Disconnect s1
    s1.disconnect();
    await wait(100);

    // s2 should still receive
    const s2Received = new Promise<BoxesMessage>((resolve) => {
      s2.once('boxes', (payload: unknown) => resolve(payload as BoxesMessage));
    });

    await pubClient.publish(
      channel,
      JSON.stringify({
        cameraId: 'cam_box_1',
        t: Date.now(),
        boxes: [],
      }),
    );

    const msg = await s2Received;
    expect(msg.cameraId).toBe('cam_box_1');
    expect(await numsub(channel)).toBe(1);

    // Disconnect s2
    s2.disconnect();
    await wait(150);

    expect(await numsub(channel)).toBe(0);
  });

  it('20 publishes within 1 s → at most 10 boxes messages', async () => {
    const s = await connect(userCookie);
    await ack(s, 'subscribe', { rooms: ['camera:cam_box_1'] });
    await wait(50);

    let messageCount = 0;
    s.on('boxes', () => {
      messageCount++;
    });

    // Publish 20 messages with 40ms interval (total ~800ms)
    for (let i = 0; i < 20; i++) {
      await pubClient.publish(
        'cam:cam_box_1:boxes',
        JSON.stringify({
          cameraId: 'cam_box_1',
          t: Date.now(),
          boxes: [],
        }),
      );
      await wait(40);
    }

    await wait(100);
    // Because messages < 100 ms apart are dropped, at most 10 messages should be received
    expect(messageCount).toBeLessThanOrEqual(10);
    expect(messageCount).toBeGreaterThan(0);
  });

  it('a socket that disconnects mid-subscribe does not leave a leaked room or subscription', async () => {
    const channel = 'cam:cam_box_2:boxes';
    expect(await numsub(channel)).toBe(0);

    const s = await connect(userCookie);
    // Send subscribe and disconnect immediately
    void ack(s, 'subscribe', { rooms: ['camera:cam_box_2'] });
    s.disconnect();

    await wait(150);
    expect(await numsub(channel)).toBe(0);
  });
});

function assertAck(res: Ack, ok: boolean, code?: string) {
  expect(res.ok).toBe(ok);
  if (code) expect(res.code).toBe(code);
}
