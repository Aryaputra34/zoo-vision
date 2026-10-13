import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { request as rawRequest, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import { ENV, type Env } from '../src/config/env';
import { createTestApp, TEST_ENGINE_TOKEN } from './app';
import { asRole } from './helpers/auth';
import { validSettings } from './helpers/settings';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

const ONNX = Buffer.from([0x08, 0x07, 0x12, 0x00]);
const ONNX_B = Buffer.from([0x08, 0x07, 0x12, 0x01]);
const MAX = 1024;

type ModelBody = {
  id: string;
  name: string;
  format: string;
  source: string;
  status: string;
  filePath: string;
  sizeBytes: number;
  sha256: string;
  originalName: string;
};

describe('AI model registry', () => {
  let app: INestApplication<App>;
  let redis: Redis;
  let dir: string;
  let sa: string;
  let saId: string;
  let manager: string;
  let user: string;

  const http = () => request(app.getHttpServer());
  const upload = (name: string, bytes: Buffer, cookie = sa) =>
    http()
      .post('/api/v1/models')
      .set('Cookie', cookie)
      .attach('file', bytes, name);
  const rescan = () =>
    http().post('/api/v1/models/rescan').set('Cookie', sa).expect(201);
  const rows = () => ownerQuery(`SELECT * FROM "AiModel" ORDER BY "createdAt"`);
  const registryFiles = () => readdir(join(dir, 'registry'));
  const sha = (bytes: Buffer) =>
    createHash('sha256').update(bytes).digest('hex');
  const camera = (id: string, settings: Record<string, unknown>) =>
    http()
      .post('/api/v1/cameras')
      .set('Cookie', sa)
      .send({
        id,
        name: id,
        useCase: 'cashier_presence',
        sourceType: 'FILE',
        mainStreamUrl: 'file:///tmp/x.mp4',
        settings,
      })
      .expect(201);

  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    redis = new Redis(process.env.REDIS_URL as string);
    app = await createTestApp({ MODEL_UPLOAD_MAX_BYTES: String(MAX) });
    dir = app.get<Env>(ENV).MODELS_DIR;
    const s = await asRole(app, 'SUPERADMIN');
    sa = s.cookie;
    saId = s.user.id;
    manager = (await asRole(app, 'MANAGER')).cookie;
    user = (await asRole(app, 'USER')).cookie;
  });

  afterEach(async () => {
    await app.close();
    await redis.quit();
  });

  it('SUPERADMIN uploads x.onnx → 201 VALIDATING; registry/<id>.onnx holds the bytes; model:jobs has the validate job; audit model.upload', async () => {
    const res = await upload('x.onnx', ONNX)
      .field('name', 'Yolo X')
      .field('version', '1')
      .expect(201);
    const body = res.body as ModelBody;
    expect(body).toMatchObject({
      name: 'Yolo X',
      format: 'ONNX',
      source: 'UPLOAD',
      status: 'VALIDATING',
      filePath: `registry/${body.id}.onnx`,
      originalName: 'x.onnx',
      sizeBytes: ONNX.length,
      sha256: sha(ONNX),
    });
    expect(await readFile(join(dir, body.filePath))).toEqual(ONNX);
    expect(await registryFiles()).toEqual([`${body.id}.onnx`]);

    const jobs = (await redis.lrange('model:jobs', 0, -1)).map(
      (j) => JSON.parse(j) as unknown,
    );
    expect(jobs).toEqual([
      { type: 'validate', modelId: body.id, path: body.filePath },
    ]);

    const audit = (await ownerQuery(
      `SELECT * FROM "AuditLog" WHERE action = 'model.upload'`,
    )) as { entityId: string; actorId: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityId: body.id, actorId: saId });
  });

  it('x.pt → 400 with the inbox hint; no row; registry/ holds no file', async () => {
    const res = await upload('x.pt', ONNX).expect(400);
    expect((res.body as { message: string }).message).toBe(
      'Only ONNX models can be uploaded. Copy .pt or .engine files into the inbox folder on the server and press Rescan.',
    );
    expect(await rows()).toHaveLength(0);
    expect(await registryFiles()).toEqual([]);
  });

  it('x.onnx starting with PK\\x03\\x04 → 400; the temp file is gone', async () => {
    const res = await upload(
      'x.onnx',
      Buffer.from('PK\x03\x04rest', 'latin1'),
    ).expect(400);
    expect((res.body as { message: string }).message).toContain(
      'Only ONNX models can be uploaded',
    );
    await upload('empty.onnx', Buffer.alloc(0)).expect(400);
    expect(await rows()).toHaveLength(0);
    expect(await registryFiles()).toEqual([]);
  });

  it('a file over MODEL_UPLOAD_MAX_BYTES (set to 1024 for this app) → 413; registry/ holds no file; no row', async () => {
    const big = Buffer.concat([ONNX, Buffer.alloc(MAX * 4, 1)]);
    await upload('big.onnx', big).expect(413);
    expect(await rows()).toHaveLength(0);
    expect(await registryFiles()).toEqual([]);

    // exactly at the limit is accepted
    await upload(
      'ok.onnx',
      Buffer.concat([ONNX, Buffer.alloc(MAX - ONNX.length, 2)]),
    ).expect(201);
    expect(await rows()).toHaveLength(1);
    expect(await registryFiles()).toHaveLength(1);
  });

  it('a request that breaks off mid-file leaves no file and no row', async () => {
    const server = app.getHttpServer() as unknown as Server;
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const boundary = '----zoo';
    await new Promise<void>((resolve) => {
      const req = rawRequest({
        port,
        method: 'POST',
        path: '/api/v1/models',
        headers: {
          cookie: sa,
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': '100000',
        },
      });
      req.on('error', () => undefined);
      req.write(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.onnx"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      );
      req.write(Buffer.concat([ONNX, Buffer.alloc(100)]));
      setTimeout(() => {
        req.destroy();
        setTimeout(resolve, 500);
      }, 300);
    });
    expect(await rows()).toHaveLength(0);
    expect(await registryFiles()).toEqual([]);
  });

  it('a client file name cannot choose the path', async () => {
    const res = await upload('../../evil.onnx', ONNX).expect(201);
    const body = res.body as ModelBody;
    expect(body.filePath).toBe(`registry/${body.id}.onnx`);
    expect(body.originalName).toBe('evil.onnx');
    expect(existsSync(join(dir, '..', 'evil.onnx'))).toBe(false);
    expect(await registryFiles()).toEqual([`${body.id}.onnx`]);
  });

  it('the same bytes twice → 409 naming the first model', async () => {
    const first = (await upload('x.onnx', ONNX).expect(201)).body as ModelBody;
    const res = await upload('copy.onnx', ONNX).expect(409);
    expect((res.body as { message: string }).message).toContain(first.name);
    expect(await rows()).toHaveLength(1);
    expect(await registryFiles()).toEqual([`${first.id}.onnx`]);
  });

  it('an invalid form field → 400 and no file is left', async () => {
    await upload('x.onnx', ONNX).field('name', 'n'.repeat(500)).expect(400);
    expect(await rows()).toHaveLength(0);
    expect(await registryFiles()).toEqual([]);
  });

  it('MANAGER POST → 403; MANAGER GET /models → 200; USER GET → 403', async () => {
    await upload('x.onnx', ONNX, manager).expect(403);
    await http().get('/api/v1/models').set('Cookie', manager).expect(200);
    await http().get('/api/v1/models').set('Cookie', user).expect(403);
    await http()
      .post('/api/v1/models/rescan')
      .set('Cookie', manager)
      .expect(403);
    expect(await registryFiles()).toEqual([]);
  });

  it('lists newest first and gets one by id', async () => {
    const a = (await upload('a.onnx', ONNX).expect(201)).body as ModelBody;
    const b = (await upload('b.onnx', ONNX_B).expect(201)).body as ModelBody;
    const list = await http()
      .get('/api/v1/models')
      .set('Cookie', manager)
      .expect(200);
    expect((list.body as ModelBody[]).map((m) => m.id)).toEqual([b.id, a.id]);
    const one = await http()
      .get(`/api/v1/models/${a.id}`)
      .set('Cookie', manager)
      .expect(200);
    expect((one.body as ModelBody).sizeBytes).toBe(ONNX.length);
    await http()
      .get('/api/v1/models/5f0e2a4c-1d3b-4c6e-8a7f-9b0c1d2e3f40')
      .set('Cookie', manager)
      .expect(404);
  });

  it('rescan: inbox a.pt, b.onnx, notes.txt and top-level yolo11s.onnx → 3 added (PT/FILESYSTEM, ONNX/FILESYSTEM, ONNX/BUILTIN); inbox keeps only notes.txt', async () => {
    await writeFile(join(dir, 'inbox', 'a.pt'), Buffer.from([0x80, 0x02, 1]));
    await writeFile(join(dir, 'inbox', 'b.onnx'), ONNX);
    await writeFile(join(dir, 'inbox', 'notes.txt'), 'hello');
    await writeFile(join(dir, 'yolo11s.onnx'), ONNX_B);

    const { added, skipped } = (await rescan()).body as {
      added: ModelBody[];
      skipped: unknown[];
    };
    expect(skipped).toEqual([]);
    expect(
      added.map((m) => `${m.name}:${m.format}/${m.source}/${m.status}`).sort(),
    ).toEqual([
      'a.pt:PT/FILESYSTEM/VALIDATING',
      'b.onnx:ONNX/FILESYSTEM/VALIDATING',
      'yolo11s.onnx:ONNX/BUILTIN/VALIDATING',
    ]);
    expect(await readdir(join(dir, 'inbox'))).toEqual(['notes.txt']);
    const builtin = added.find((m) => m.source === 'BUILTIN')!;
    expect(builtin.filePath).toBe('yolo11s.onnx');
    expect(existsSync(join(dir, 'yolo11s.onnx'))).toBe(true);
    for (const m of added.filter((m) => m.source === 'FILESYSTEM')) {
      expect(m.filePath).toBe(
        `registry/${m.id}.${m.format === 'PT' ? 'pt' : 'onnx'}`,
      );
      expect(existsSync(join(dir, m.filePath))).toBe(true);
    }
    expect(await redis.llen('model:jobs')).toBe(3);

    const audit = (await ownerQuery(
      `SELECT "after" FROM "AuditLog" WHERE action = 'model.rescan'`,
    )) as { after: unknown }[];
    expect(JSON.stringify(audit[0].after)).toContain('a.pt');
  });

  it('rescan again adds nothing; a copy of a.pt dropped in the inbox is skipped with "same file as a.pt"', async () => {
    const pt = Buffer.from([0x80, 0x02, 1]);
    await writeFile(join(dir, 'inbox', 'a.pt'), pt);
    await rescan();

    expect((await rescan()).body).toEqual({ added: [], skipped: [] });

    await writeFile(join(dir, 'inbox', 'a-copy.pt'), pt);
    expect((await rescan()).body).toEqual({
      added: [],
      skipped: [{ file: 'inbox/a-copy.pt', reason: 'same file as a.pt' }],
    });
    expect(await readdir(join(dir, 'inbox'))).toEqual(['a-copy.pt']);
    expect(await rows()).toHaveLength(1);
  });

  it('delete while a camera has model_name "yolo11s.onnx" → 409; an unused model → 204 and its file is gone', async () => {
    await writeFile(join(dir, 'yolo11s.onnx'), ONNX);
    const builtin = ((await rescan()).body as { added: ModelBody[] }).added[0];
    await camera('cam_m', {
      ...validSettings('cashier_presence'),
      model_name: 'yolo11s.onnx',
    });

    await http()
      .delete(`/api/v1/models/${builtin.id}`)
      .set('Cookie', sa)
      .expect(409);
    expect(existsSync(join(dir, 'yolo11s.onnx'))).toBe(true);
    expect(await rows()).toHaveLength(1);

    const free = (await upload('free.onnx', ONNX_B).expect(201))
      .body as ModelBody;
    await http()
      .delete(`/api/v1/models/${free.id}`)
      .set('Cookie', sa)
      .expect(204);
    expect(existsSync(join(dir, free.filePath))).toBe(false);
    await http()
      .delete(`/api/v1/models/${free.id}`)
      .set('Cookie', sa)
      .expect(404);

    const audit = (await ownerQuery(
      `SELECT entity, "entityId" FROM "AuditLog" WHERE action = 'model.delete'`,
    )) as { entityId: string }[];
    expect(audit.map((a) => a.entityId)).toEqual([free.id]);
  });

  it('a model named by a camera model_id cannot be deleted either', async () => {
    const m = (await upload('m.onnx', ONNX).expect(201)).body as ModelBody;
    await ownerQuery(
      `UPDATE "AiModel" SET status = 'READY' WHERE id = $1`,
      m.id,
    );
    await camera('cam_i', {
      ...validSettings('cashier_presence'),
      model_id: m.id,
    });
    await http().delete(`/api/v1/models/${m.id}`).set('Cookie', sa).expect(409);
    expect(await registryFiles()).toEqual([`${m.id}.onnx`]);
  });

  describe('engine reports', () => {
    const bearer = `Bearer ${TEST_ENGINE_TOKEN}`;
    const report = (
      id: string,
      kind: 'validation' | 'conversion',
      body: object,
    ) =>
      http()
        .post(`/internal/engine/models/${id}/${kind}`)
        .set('Authorization', bearer)
        .send(body);
    const jobs = async () =>
      (await redis.lrange('model:jobs', 0, -1)).map(
        (j) => JSON.parse(j) as Record<string, unknown>,
      );
    const row = async (id: string) =>
      (
        (await ownerQuery(
          `SELECT * FROM "AiModel" WHERE id = $1`,
          id,
        )) as Record<string, unknown>[]
      )[0];
    const ok = {
      ok: true,
      classNames: ['person', 'horse'],
      latencyMs: 41,
      device: 'cpu',
    };
    const readyPt = async () => {
      await writeFile(join(dir, 'inbox', 'a.pt'), Buffer.from([0x80, 0x02, 1]));
      const m = ((await rescan()).body as { added: ModelBody[] }).added[0];
      await report(m.id, 'validation', ok).expect(204);
      return m;
    };
    const convert = (id: string, body: object = {}, cookie = sa) =>
      http()
        .post(`/api/v1/models/${id}/convert`)
        .set('Cookie', cookie)
        .send(body);

    it('engine report routes need the engine token', async () => {
      const m = (await upload('x.onnx', ONNX).expect(201)).body as ModelBody;
      for (const kind of ['validation', 'conversion'] as const) {
        const url = `/internal/engine/models/${m.id}/${kind}`;
        await http().post(url).send(ok).expect(401);
        await http()
          .post(url)
          .set('Authorization', 'Bearer wrong')
          .send(ok)
          .expect(401);
        await http().post(url).set('Cookie', sa).send(ok).expect(401);
      }
      expect((await row(m.id)).status).toBe('VALIDATING');
    });

    it('a validation report {ok: true} makes the model READY with classNames; a second report → 409 and nothing changes', async () => {
      const m = (await upload('x.onnx', ONNX).expect(201)).body as ModelBody;
      await report(m.id, 'validation', ok).expect(204);
      const after = await row(m.id);
      expect(after).toMatchObject({
        status: 'READY',
        classNames: ['person', 'horse'],
      });
      expect(after.validation).toMatchObject({
        ok: true,
        latencyMs: 41,
        device: 'cpu',
      });
      expect((after.validation as { at: string }).at).toEqual(
        expect.any(String),
      );

      await report(m.id, 'validation', { ok: false, error: 'late' }).expect(
        409,
      );
      const again = await row(m.id);
      expect(again).toMatchObject({
        status: 'READY',
        classNames: ['person', 'horse'],
      });
      expect(again.validation).toEqual(after.validation);
    });

    it('a validation report {ok: false} makes it FAILED with the error', async () => {
      const m = (await upload('x.onnx', ONNX).expect(201)).body as ModelBody;
      await report(m.id, 'validation', { ok: 'yes' }).expect(400);
      await report(
        '5f0e2a4c-1d3b-4c6e-8a7f-9b0c1d2e3f40',
        'validation',
        ok,
      ).expect(404);
      await report(m.id, 'validation', {
        ok: false,
        error: 'bad opset',
      }).expect(204);
      const after = await row(m.id);
      expect(after.status).toBe('FAILED');
      expect(after.validation).toMatchObject({ ok: false, error: 'bad opset' });
    });

    it('POST validate queues a job and sets VALIDATING; MANAGER → 403; 409 while CONVERTING', async () => {
      const m = (await upload('x.onnx', ONNX).expect(201)).body as ModelBody;
      await report(m.id, 'validation', { ok: false, error: 'x' }).expect(204);
      await redis.del('model:jobs');
      await http()
        .post(`/api/v1/models/${m.id}/validate`)
        .set('Cookie', manager)
        .expect(403);
      const res = await http()
        .post(`/api/v1/models/${m.id}/validate`)
        .set('Cookie', sa)
        .expect(202);
      expect((res.body as ModelBody).status).toBe('VALIDATING');
      expect(await jobs()).toEqual([
        { type: 'validate', modelId: m.id, path: m.filePath },
      ]);
      await ownerQuery(
        `UPDATE "AiModel" SET status = 'CONVERTING' WHERE id = $1`,
        m.id,
      );
      await http()
        .post(`/api/v1/models/${m.id}/validate`)
        .set('Cookie', sa)
        .expect(409);
    });

    it('convert: a READY .pt (rescanned, then reported valid) → target CONVERTING and a convert job; a conversion report (file written at outPath first) → target VALIDATING and a validate job', async () => {
      const src = await readyPt();
      await redis.del('model:jobs');
      const res = await convert(src.id, { imgsz: [640, 480] }).expect(202);
      const { source, target } = res.body as {
        source: ModelBody;
        target: ModelBody & { convertedFromId: string };
      };
      expect(source).toMatchObject({ id: src.id, status: 'READY' });
      expect(target).toMatchObject({
        format: 'ONNX',
        source: 'CONVERTED',
        status: 'CONVERTING',
        filePath: `registry/${target.id}.onnx`,
        convertedFromId: src.id,
        name: 'a.pt (ONNX)',
      });
      expect(await jobs()).toEqual([
        {
          type: 'convert',
          modelId: src.id,
          targetId: target.id,
          path: src.filePath,
          outPath: target.filePath,
          imgsz: [640, 480],
        },
      ]);
      await redis.del('model:jobs');

      // the reported path must be the row's own; the row stays CONVERTING
      await report(target.id, 'conversion', {
        ok: true,
        path: '../../etc/x.onnx',
        sha256: sha(ONNX_B),
      }).expect(400);
      expect((await row(target.id)).status).toBe('CONVERTING');

      await writeFile(join(dir, target.filePath), ONNX_B);
      await report(target.id, 'conversion', {
        ok: true,
        path: target.filePath,
        sha256: sha(ONNX_B),
      }).expect(204);
      expect(await row(target.id)).toMatchObject({
        status: 'VALIDATING',
        sha256: sha(ONNX_B),
        sizeBytes: String(ONNX_B.length),
      });
      expect(await jobs()).toEqual([
        { type: 'validate', modelId: target.id, path: target.filePath },
      ]);
      await report(target.id, 'conversion', {
        ok: true,
        path: target.filePath,
        sha256: sha(ONNX_B),
      }).expect(409);
    });

    it('a conversion that claims success without writing the file → FAILED; default imgsz is 640', async () => {
      const src = await readyPt();
      await redis.del('model:jobs');
      const target = (
        (await convert(src.id).expect(202)).body as { target: ModelBody }
      ).target;
      expect(await jobs()).toEqual([
        expect.objectContaining({ imgsz: 640, targetId: target.id }),
      ]);
      await report(target.id, 'conversion', {
        ok: true,
        path: target.filePath,
        sha256: sha(ONNX_B),
      }).expect(204);
      expect((await row(target.id)).status).toBe('FAILED');
    });

    it('a conversion whose sha256 is already registered → FAILED "duplicate of <name>"', async () => {
      const src = await readyPt();
      const dup = (await upload('same.onnx', ONNX).expect(201))
        .body as ModelBody;
      const target = (
        (await convert(src.id).expect(202)).body as { target: ModelBody }
      ).target;
      await writeFile(join(dir, target.filePath), ONNX);
      await report(target.id, 'conversion', {
        ok: true,
        path: target.filePath,
        sha256: sha(ONNX),
      }).expect(204);
      const after = await row(target.id);
      expect(after.status).toBe('FAILED');
      expect(after.validation).toMatchObject({
        ok: false,
        error: `duplicate of ${dup.name}`,
      });
    });

    it('convert on an ONNX model → 409; MANAGER → 403; a failed conversion → target FAILED', async () => {
      const onnx = (await upload('x.onnx', ONNX).expect(201)).body as ModelBody;
      await report(onnx.id, 'validation', ok).expect(204);
      await convert(onnx.id).expect(409);
      const src = await readyPt();
      await convert(src.id, {}, manager).expect(403);
      await convert(src.id, { imgsz: 100 }).expect(400);
      await convert(src.id, { imgsz: 8192 }).expect(400);
      await convert(src.id, { imgsz: [640] }).expect(400);
      const target = (
        (await convert(src.id, { imgsz: 320 }).expect(202)).body as {
          target: ModelBody;
        }
      ).target;
      await report(target.id, 'conversion', {
        ok: false,
        error: 'export blew up',
      }).expect(204);
      const after = await row(target.id);
      expect(after.status).toBe('FAILED');
      expect(after.validation).toMatchObject({
        ok: false,
        error: 'export blew up',
      });
      await ownerQuery(
        `UPDATE "AiModel" SET status = 'FAILED' WHERE id = $1`,
        src.id,
      );
      await convert(src.id).expect(409);
    });
  });
});
