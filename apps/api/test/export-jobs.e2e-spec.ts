import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PdfJob } from '../src/exports/pdf.job';
import { createTestApp } from './app';
import { addCamera, addEvent } from './helpers/analytics';
import { asRole } from './helpers/auth';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

const PDF = '%PDF-1.4 fake';

describe('PDF export jobs', () => {
  let app: INestApplication<App>;
  let dir: string;
  let gotenberg: http.Server;
  let answer = 200;
  let posted: string[] = [];
  let a: string;
  let b: string;

  const api = () => request(app.getHttpServer());
  const job = async (id: string) =>
    (
      (await ownerQuery(
        `SELECT "status", "attempts", "error", "filePath", "runAt" FROM "ExportJob" WHERE "id" = $1`,
        id,
      )) as {
        status: string;
        attempts: number;
        error: string | null;
        filePath: string | null;
        runAt: Date;
      }[]
    )[0];
  const create = async (cookie = a) => {
    const res = await api()
      .post('/api/v1/exports/jobs')
      .set('Cookie', cookie)
      .send({ period: 'day', date: '2026-10-14', cameraIds: ['cam1'] })
      .expect(202);
    return (res.body as { id: string }).id;
  };

  beforeAll(async () => {
    gotenberg = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        posted.push(Buffer.concat(chunks).toString('utf8'));
        res.statusCode = answer;
        res.end(answer === 200 ? PDF : 'nope');
      });
    });
    await new Promise<void>((r) => gotenberg.listen(0, '127.0.0.1', r));
  });
  afterAll(() => new Promise((r) => gotenberg.close(r)));

  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    answer = 200;
    posted = [];
    dir = await mkdtemp(join(tmpdir(), 'zoo-exports-'));
    const port = (gotenberg.address() as AddressInfo).port;
    app = await createTestApp({
      EXPORTS_DIR: dir,
      GOTENBERG_URL: `http://127.0.0.1:${port}`,
    });
    a = (await asRole(app, 'MANAGER')).cookie;
    b = (await asRole(app, 'MANAGER')).cookie;
    await addCamera('cam1', { name: '<script>alert(1)</script>' });
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('user B → 404 on A’s file; /exports/jobs/not-a-uuid/file → 404 NOT_FOUND, not 500', async () => {
    const id = await create();
    await writeFile(join(dir, `${id}.pdf`), PDF);
    await ownerQuery(
      `UPDATE "ExportJob" SET "status" = 'DONE', "filePath" = $2 WHERE "id" = $1`,
      id,
      `${id}.pdf`,
    );
    const file = (path: string, cookie: string) =>
      api().get(`/api/v1/exports/jobs/${path}/file`).set('Cookie', cookie);

    const own = await file(id, a).expect(200);
    expect(own.headers['content-type']).toBe('application/pdf');
    expect(own.headers['content-disposition']).toBe(
      'attachment; filename="report-day-2026-10-14.pdf"',
    );
    expect(own.headers['cache-control']).toBe('no-store');

    const other = await file(id, b).expect(404);
    expect((other.body as { code: string }).code).toBe('NOT_FOUND');
    const bad = await file('not-a-uuid', a).expect(404);
    expect((bad.body as { code: string }).code).toBe('NOT_FOUND');
    await file('00000000-0000-0000-0000-000000000000', a).expect(404);
    expect(
      (await api().get('/api/v1/exports/jobs').set('Cookie', b)).body,
    ).toEqual([]);
  });

  it('a queued job is printed, escaped, and its file is the finished PDF, never a .part', async () => {
    await addEvent({
      time: '2026-10-14T03:00:00.000Z',
      cameraId: 'cam1',
      useCase: 'cashier_presence',
      type: 'cashier_unattended',
    });
    const id = await create();
    await app.get(PdfJob).tick();

    expect((await job(id)).status).toBe('DONE');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(posted[0]).not.toContain('<script');
    expect(await readdir(dir)).toEqual([`${id}.pdf`]);
    const res = await api()
      .get(`/api/v1/exports/jobs/${id}/file`)
      .set('Cookie', a)
      .buffer(true)
      .parse((r, done) => {
        let text = '';
        r.on('data', (c: Buffer) => (text += c.toString()));
        r.on('end', () => done(null, text));
      })
      .expect(200);
    expect(res.body).toBe(PDF);
    const listed = (await api().get('/api/v1/exports/jobs').set('Cookie', a))
      .body as { status: string; fileUrl: string; sizeBytes: number }[];
    expect(listed[0]).toMatchObject({
      status: 'DONE',
      fileUrl: `/api/v1/exports/jobs/${id}/file`,
      sizeBytes: PDF.length,
    });
  });

  it('Gotenberg 5xx: retried after 1, 2, 4 minutes, then FAILED; a 4xx fails at once; no file is left', async () => {
    const id = await create();
    answer = 500;
    let now = new Date(Date.now() + 1000);
    const tick = () => app.get(PdfJob).tick(now);
    for (const minutes of [1, 2, 4]) {
      await tick();
      const row = await job(id);
      expect(row.status).toBe('QUEUED');
      expect(row.runAt.getTime()).toBe(now.getTime() + minutes * 60_000);
      now = new Date(now.getTime() + minutes * 60_000);
    }
    await tick();
    expect(await job(id)).toMatchObject({
      status: 'FAILED',
      attempts: 4,
      error: 'PDF service unavailable',
    });

    answer = 422;
    const two = await create();
    await app.get(PdfJob).tick(new Date(Date.now() + 1000));
    expect(await job(two)).toMatchObject({
      status: 'FAILED',
      error: 'PDF conversion failed (422)',
    });
    expect(await readdir(dir)).toEqual([]);
    const file = await api()
      .get(`/api/v1/exports/jobs/${two}/file`)
      .set('Cookie', a);
    expect(file.status).toBe(404);
  });
});
