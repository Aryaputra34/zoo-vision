import http from 'node:http';
import v8 from 'node:v8';
import vm from 'node:vm';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, listenTestApp } from './app';
import { asRole } from './helpers/auth';
import {
  addCamera,
  addEvent,
  addInterval,
  addMetric,
} from './helpers/analytics';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

const BOM = '\uFEFF';

// a major GC on demand, without --expose-gc: heapUsed then counts what is alive, not garbage
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const BIG_ROWS = 200_000;
const DAY = {
  from: '2026-10-14T00:00:00+07:00',
  to: '2026-10-15T00:00:00+07:00',
};

type Streamed = {
  status: number;
  headers: http.IncomingHttpHeaders;
  bytes: number;
  chunks: number;
  text: string;
  /** false when the connection broke before the body ended */
  complete: boolean;
  peakHeap: number;
};

describe('GET /api/v1/exports/*.csv', () => {
  let app: INestApplication<App>;
  let base: string;
  let cookie: string;
  let prisma: PrismaService;

  const csv = async (path: string, query: Record<string, string> = {}) => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/exports/${path}`)
      .set('Cookie', cookie)
      .query(query)
      .buffer(true)
      .parse((r, done) => {
        let text = '';
        r.setEncoding('utf8');
        r.on('data', (chunk: string) => (text += chunk));
        r.on('end', () => done(null, text));
      });
    return { res, text: res.body as string };
  };
  const lines = (text: string) =>
    text.replace(BOM, '').split('\r\n').slice(0, -1);
  const auditRows = async () =>
    (await ownerQuery(
      `SELECT "actorName", "action", "entity", "after", "ip" FROM "AuditLog"
        WHERE "action" = 'export.csv' ORDER BY "id"`,
    )) as {
      actorName: string;
      action: string;
      entity: string;
      after: { kind: string; filters: Record<string, string> };
      ip: string | null;
    }[];

  /** Opens the export over a real socket; `onChunk` can pause or abort the client. */
  const stream = (
    path: string,
    query: Record<string, string>,
    onChunk?: (
      res: http.IncomingMessage,
      req: http.ClientRequest,
      n: number,
    ) => void,
    measureHeap = false,
  ) =>
    new Promise<Streamed>((resolve, reject) => {
      const url = new URL(`${base}/api/v1/exports/${path}`);
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
      const out: Streamed = {
        status: 0,
        headers: {},
        bytes: 0,
        chunks: 0,
        text: '',
        complete: false,
        peakHeap: 0,
      };
      const timer = measureHeap
        ? setInterval(() => {
            gc();
            out.peakHeap = Math.max(
              out.peakHeap,
              process.memoryUsage().heapUsed,
            );
          }, 100)
        : undefined;
      const finish = () => {
        if (timer) clearInterval(timer);
        resolve(out);
      };
      const req = http.get(url, { headers: { Cookie: cookie } }, (res) => {
        out.status = res.statusCode ?? 0;
        out.headers = res.headers;
        res.on('data', (chunk: Buffer) => {
          out.bytes += chunk.length;
          out.chunks += 1;
          // keep the text of small answers only: the big one is counted, not stored
          if (out.bytes < 1_000_000) out.text += chunk.toString('utf8');
          onChunk?.(res, req, out.chunks);
        });
        res.on('end', () => {
          out.complete = res.complete;
          finish();
        });
        res.on('aborted', finish);
        res.on('error', finish);
        res.on('close', finish);
      });
      req.on('error', (err) => {
        if (timer) clearInterval(timer);
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') resolve(out);
        else reject(err);
      });
    });

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    await resetDb();
    await flushRedis();
    app = await createTestApp();
    base = await listenTestApp(app);
    cookie = (await asRole(app, 'USER')).cookie;
    prisma = app.get(PrismaService);

    await addCamera('pony', {
      name: 'Pony, "north" ride',
      useCase: 'horse_riding',
    });
    await addCamera('gate', { useCase: 'vehicle_gate' });
    await addCamera('desk', { useCase: 'cashier_presence' });
    await addCamera('desk2', { useCase: 'cashier_presence' });
    await addCamera('ivdesk', { useCase: 'cashier_presence' });
    await addCamera('big', { useCase: 'restaurant_counter' });

    // 23:30Z = 06:30 local; a name with a comma and quotes; a data value that is a formula
    await addEvent({
      id: 'evt_x1',
      time: '2026-10-13T23:30:00Z',
      cameraId: 'pony',
      useCase: 'horse_riding',
      type: 'horse_crossing',
      data: { direction: 'DEPARTURE', trackerId: 7 },
      snapshotPath: 'pony/2026-10-14/evt_x1.jpg',
      configVersion: 3,
    });
    await addEvent({
      id: 'evt_x2',
      time: '2026-10-14T02:00:00Z',
      cameraId: 'gate',
      useCase: 'vehicle_gate',
      type: 'vehicle_crossing',
      data: {
        direction: 'ENTRY',
        vehicleType: '=HYPERLINK("http://x")',
        trackerId: 1,
      },
    });
    await addEvent({
      id: 'evt_sys',
      time: '2026-10-14T01:00:00Z',
      cameraId: null,
      useCase: 'system',
      type: 'engine_started',
      data: { bootId: 'c'.repeat(32), engineGroup: 'default' },
    });

    // one closed and one open interval on a camera of their own: an open one depends on `now`
    await addInterval({
      id: 'ses_c1',
      cameraId: 'ivdesk',
      useCase: 'cashier_presence',
      kind: 'desk_unattended',
      start: '2026-10-14T03:00:00Z',
      end: '2026-10-14T03:10:00Z',
      endReason: 'returned',
    });
    await addInterval({
      id: 'ses_c2',
      cameraId: 'ivdesk',
      useCase: 'cashier_presence',
      kind: 'desk_unattended',
      start: '2026-10-14T04:00:00Z',
    });

    // summary.csv seeds: two cashier cameras over two local days (10-14 and 10-15, WIB)
    const waiting = (id: string, cameraId: string, time: string, sec: number) =>
      addEvent({
        id,
        time,
        cameraId,
        useCase: 'cashier_presence',
        type: 'customer_waiting',
        severity: 'warning',
        data: { waitingSec: sec },
      });
    await waiting('evt_s1', 'desk', '2026-10-14T05:00:00Z', 30);
    await waiting('evt_s2', 'desk', '2026-10-14T06:00:00Z', 90);
    await waiting('evt_s3', 'desk2', '2026-10-15T05:00:00Z', 45);
    // desk: 10 minutes, and 16:50-17:10Z, which crosses local midnight (10 minutes each side)
    await addInterval({
      cameraId: 'desk',
      useCase: 'cashier_presence',
      kind: 'desk_unattended',
      start: '2026-10-14T03:00:00Z',
      end: '2026-10-14T03:10:00Z',
    });
    await addInterval({
      cameraId: 'desk',
      useCase: 'cashier_presence',
      kind: 'desk_unattended',
      start: '2026-10-14T16:50:00Z',
      end: '2026-10-14T17:10:00Z',
    });
    await addInterval({
      cameraId: 'desk2',
      useCase: 'cashier_presence',
      kind: 'desk_unattended',
      start: '2026-10-15T02:00:00Z',
      end: '2026-10-15T02:20:00Z',
    });
    for (const [i, v] of [3, 5, 4].entries()) {
      await addMetric({
        cameraId: 'desk',
        useCase: 'cashier_presence',
        name: 'queue_length',
        minute: new Date(Date.UTC(2026, 9, 14, 7, i)).toISOString(),
        value: v,
      });
    }

    // the big table: BIG_ROWS minutes of one metric in one statement
    await ownerQuery(
      `INSERT INTO "Metric" ("cameraId", "useCase", "name", "minute", "value")
       SELECT 'big', 'restaurant_counter', 'occupancy',
              timestamptz '2026-01-01 00:00:00+00' + n * interval '1 minute', n % 60
         FROM generate_series(0, ${BIG_ROWS - 1}) AS n`,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('events.csv starts with the BOM and the header; lines end in CRLF', async () => {
    const { res, text } = await csv('events.csv', DAY);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="events-2026-10-14-2026-10-15.csv"',
    );
    expect(
      text.startsWith(`${BOM}time_local,event_id,camera_id,camera_name,`),
    ).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '').includes('\n')).toBe(false);
    const rows = lines(text);
    expect(rows[0]).toBe(
      'time_local,event_id,camera_id,camera_name,use_case,type,severity,config_version,data,snapshot_url',
    );
    // the four events of that day; the system event is left out
    expect(rows.some((r) => r.includes('evt_sys'))).toBe(false);
    expect(rows.length).toBe(1 + 4);
  });

  it('horse_riding events.csv has data.direction and data.trackerId columns', async () => {
    const { text } = await csv('events.csv', {
      ...DAY,
      useCase: 'horse_riding',
    });
    expect(lines(text)).toEqual([
      'time_local,event_id,camera_id,camera_name,use_case,type,severity,config_version,data.direction,data.trackerId,snapshot_url',
      '2026-10-14 06:30:00,evt_x1,pony,"Pony, ""north"" ride",horse_riding,horse_crossing,info,3,DEPARTURE,7,/media/snapshots/pony/2026-10-14/evt_x1.jpg',
    ]);
  });

  it('2026-10-13T23:30:00Z is written as 2026-10-14 06:30:00', async () => {
    const { text } = await csv('events.csv', {
      ...DAY,
      types: 'horse_crossing',
    });
    expect(lines(text)[1].startsWith('2026-10-14 06:30:00,evt_x1,')).toBe(true);
  });

  it('a text a spreadsheet would run as a formula is defused', async () => {
    const { text } = await csv('events.csv', {
      ...DAY,
      useCase: 'vehicle_gate',
    });
    expect(lines(text)[1]).toContain(`'=HYPERLINK(""http://x"")`);
    expect(lines(text)[0]).toContain('data.vehicleType');
  });

  it('events.csv takes the where filter of the list', async () => {
    const { text } = await csv('events.csv', {
      ...DAY,
      types: 'vehicle_crossing',
      where: 'data.direction:EXIT',
    });
    expect(lines(text)).toHaveLength(1);
  });

  it('intervals.csv: local times, an open interval has empty end and duration', async () => {
    const { res, text } = await csv('intervals.csv', {
      ...DAY,
      kind: 'desk_unattended',
      cameraIds: 'ivdesk',
    });
    expect(res.headers['content-disposition']).toContain(
      'intervals-2026-10-14-2026-10-15.csv',
    );
    expect(lines(text)).toEqual([
      'start_local,end_local,duration_sec,interval_id,camera_id,camera_name,use_case,kind,subject_id,end_reason,data',
      '2026-10-14 10:00:00,2026-10-14 10:10:00,600,ses_c1,ivdesk,ivdesk,cashier_presence,desk_unattended,,returned,{}',
      '2026-10-14 11:00:00,,,ses_c2,ivdesk,ivdesk,cashier_presence,desk_unattended,,,{}',
    ]);
  });

  it('metrics.csv: minute_local, camera, name and value, in camera, name, minute order', async () => {
    const { text } = await csv('metrics.csv', { ...DAY, cameraIds: 'desk' });
    expect(lines(text)).toEqual([
      'minute_local,camera_id,camera_name,use_case,name,value',
      '2026-10-14 14:00:00,desk,desk,cashier_presence,queue_length,3',
      '2026-10-14 14:01:00,desk,desk,cashier_presence,queue_length,5',
      '2026-10-14 14:02:00,desk,desk,cashier_presence,queue_length,4',
    ]);
  });

  it('summary.csv per day for 2 cameras: the seeded counts and totals', async () => {
    const { res, text } = await csv('summary.csv', {
      from: '2026-10-14T00:00:00+07:00',
      to: '2026-10-16T00:00:00+07:00',
      bucket: 'day',
      useCase: 'cashier_presence',
      cameraIds: 'desk,desk2',
    });
    expect(res.headers['content-disposition']).toContain(
      'summary-2026-10-14-2026-10-16.csv',
    );
    expect(lines(text)).toEqual([
      'bucket_local,camera_id,camera_name,use_case,events.cashier_unattended.count,events.customer_waiting.count,intervals.desk_unattended.total_sec,metrics.clerk_count.avg,metrics.clerk_count.max,metrics.queue_length.avg,metrics.queue_length.max',
      // desk, day 1: two waits; 600 s + the 10 minutes of the midnight interval before 00:00
      '2026-10-14 00:00:00,desk,desk,cashier_presence,0,2,1200,,,4,5',
      // day 2: only the other 10 minutes of the midnight interval (a row without events)
      '2026-10-15 00:00:00,desk,desk,cashier_presence,0,0,600,,,,',
      '2026-10-15 00:00:00,desk2,desk2,cashier_presence,0,1,1200,,,,',
    ]);
  });

  it('summary.csv takes the range limits of its bucket', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/exports/summary.csv')
      .set('Cookie', cookie)
      .query({
        from: '2026-01-01T00:00:00+07:00',
        to: '2026-06-01T00:00:00+07:00',
        bucket: 'hour',
      })
      .expect(400);
    expect(res.body).toMatchObject({ code: 'RANGE_TOO_LONG' });
    const noBucket = await request(app.getHttpServer())
      .get('/api/v1/exports/summary.csv')
      .set('Cookie', cookie)
      .query({ ...DAY, bucket: '5m' })
      .expect(400);
    expect(noBucket.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('200,000 seeded metric rows stream while the API heap grows less than 10 MB (the plan allows 50)', async () => {
    gc();
    const before = process.memoryUsage().heapUsed;

    const out = await stream(
      'metrics.csv',
      {
        from: '2026-01-01T00:00:00Z',
        to: '2026-07-01T00:00:00Z',
        cameraIds: 'big',
      },
      undefined,
      true,
    );

    expect(out.status).toBe(200);
    expect(out.complete).toBe(true);
    expect(out.chunks).toBeGreaterThan(10); // many writes, not one string at the end
    // header + one line per row, about 75 bytes each
    expect(out.bytes).toBeGreaterThan(BIG_ROWS * 50);
    // live heap, GC forced: one batch is about 4 MB here; the 12 MB of text alone would show
    expect(out.peakHeap - before).toBeLessThan(10 * 1024 * 1024);
  });

  it('the whole table arrives: 200,000 rows, in time order, ending with a complete line', async () => {
    let lineCount = 0;
    let tail = '';
    let first = '';
    await new Promise<void>((resolve, reject) => {
      http
        .get(
          `${base}/api/v1/exports/metrics.csv?from=2026-01-01T00:00:00Z&to=2026-07-01T00:00:00Z&cameraIds=big`,
          { headers: { Cookie: cookie } },
          (res) => {
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              if (!first) first = chunk.slice(0, 200);
              for (
                let i = chunk.indexOf('\r\n');
                i >= 0;
                i = chunk.indexOf('\r\n', i + 2)
              )
                lineCount++;
              tail = (tail + chunk).slice(-300);
            });
            res.on('end', resolve);
            res.on('error', reject);
          },
        )
        .on('error', reject);
    });
    expect(lineCount).toBe(BIG_ROWS + 1);
    expect(first.startsWith(`${BOM}minute_local,camera_id,`)).toBe(true);
    // minute 199,999 after 2026-01-01T00:00Z is 2026-05-19T21:19Z = 2026-05-20 04:19 local; 199999 % 60 = 19
    expect(
      tail.endsWith(
        '2026-05-20 04:19:00,big,big,restaurant_counter,occupancy,19\r\n',
      ),
    ).toBe(true);
  });

  it('a client that aborts after the first chunk stops the batch reads', async () => {
    const spy = jest.spyOn(prisma, '$queryRaw');
    try {
      const out = await stream(
        'metrics.csv',
        {
          from: '2026-01-01T00:00:00Z',
          to: '2026-07-01T00:00:00Z',
          cameraIds: 'big',
        },
        (_res, req, n) => {
          if (n === 1) req.destroy();
        },
      );
      expect(out.complete).toBe(false);
      await wait(400);
      const afterAbort = spy.mock.calls.length;
      await wait(600);
      // 200,000 rows are 40 batches: it read the first, maybe one in flight, and then no more
      expect(spy.mock.calls.length).toBe(afterAbort);
      expect(afterAbort).toBeLessThanOrEqual(3);
    } finally {
      spy.mockRestore();
    }
  });

  it('a reader that stops reading does not make the server read ahead', async () => {
    const spy = jest.spyOn(prisma, '$queryRaw');
    try {
      let resumed: (() => void) | undefined;
      const done = stream(
        'metrics.csv',
        {
          from: '2026-01-01T00:00:00Z',
          to: '2026-07-01T00:00:00Z',
          cameraIds: 'big',
        },
        (res, _req, n) => {
          if (n === 1) {
            res.pause();
            resumed = () => res.resume();
          }
        },
      );
      // wait until the batch reads stop on their own: a server that honours backpressure stalls
      // with the socket buffers full; one that does not keeps reading until the table is done
      let last = -1;
      let since = Date.now();
      const deadline = Date.now() + 30_000;
      while (Date.now() - since < 800 && Date.now() < deadline) {
        await wait(100);
        if (spy.mock.calls.length !== last) {
          last = spy.mock.calls.length;
          since = Date.now();
        }
      }
      const stalledAt = last;
      resumed?.();
      const out = await done;
      expect(out.complete).toBe(true);
      // 200,000 rows are 40 batches; the kernel buffers hold only a few of them
      expect(stalledAt).toBeLessThan(25);
      // and it went on once the reader came back
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(40);
    } finally {
      spy.mockRestore();
    }
  });

  it('a read failing on the first batch is a JSON 503, not a file', async () => {
    const spy = jest
      .spyOn(prisma, '$queryRaw')
      .mockRejectedValueOnce(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'P1001' }),
      );
    try {
      const res = await request(app.getHttpServer())
        .get('/api/v1/exports/metrics.csv')
        .set('Cookie', cookie)
        .query({ ...DAY, cameraIds: 'big' });
      expect(res.status).toBe(503);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.body).toMatchObject({ code: 'UNAVAILABLE' });
    } finally {
      spy.mockRestore();
    }
  });

  it('a read failing mid-way breaks the connection: the file never looks complete', async () => {
    const real = prisma.$queryRaw.bind(prisma) as (
      ...a: unknown[]
    ) => Promise<unknown>;
    let calls = 0;
    const spy = jest.spyOn(prisma, '$queryRaw').mockImplementation(((
      ...args: unknown[]
    ) => {
      calls++;
      return calls === 2
        ? Promise.reject(new Error('connection terminated'))
        : real(...args);
    }) as never);
    try {
      const out = await stream('metrics.csv', {
        from: '2026-01-01T00:00:00Z',
        to: '2026-07-01T00:00:00Z',
        cameraIds: 'big',
      });
      expect(out.status).toBe(200);
      expect(out.complete).toBe(false);
      expect(out.bytes).toBeGreaterThan(0);
      expect(out.bytes).toBeLessThan(BIG_ROWS * 10);
    } finally {
      spy.mockRestore();
    }
  });

  it('each export writes one audit row with its filters', async () => {
    const before = (await auditRows()).length;
    await csv('events.csv', {
      ...DAY,
      useCase: 'horse_riding',
      types: 'horse_crossing',
    });
    await csv('intervals.csv', { ...DAY, kind: 'desk_unattended' });
    await csv('metrics.csv', { ...DAY, cameraIds: 'desk' });
    await csv('summary.csv', { ...DAY, bucket: 'hour' });

    const rows = (await auditRows()).slice(before);
    expect(rows.map((r) => [r.action, r.entity, r.after.kind])).toEqual([
      ['export.csv', 'export', 'events'],
      ['export.csv', 'export', 'intervals'],
      ['export.csv', 'export', 'metrics'],
      ['export.csv', 'export', 'summary'],
    ]);
    expect(rows[0].after.filters).toMatchObject({
      useCase: 'horse_riding',
      types: 'horse_crossing',
      from: DAY.from,
      to: DAY.to,
    });
    expect(rows[3].after.filters).toMatchObject({ bucket: 'hour' });
    expect(rows[0].actorName).toBe('Test USER');
  });

  it('a request that fails validation writes no audit row and no file', async () => {
    const before = (await auditRows()).length;
    for (const query of [
      { ...DAY, types: 'horse_crossing', where: 'data.nope:1' },
      { ...DAY, severity: 'fatal' },
      { from: DAY.from },
    ]) {
      const res = await request(app.getHttpServer())
        .get('/api/v1/exports/events.csv')
        .set('Cookie', cookie)
        .query(query)
        .expect(400);
      expect(res.headers['content-disposition']).toBeUndefined();
    }
    expect((await auditRows()).length).toBe(before);
  });

  it('without a session → 401, and nothing is audited', async () => {
    const before = (await auditRows()).length;
    for (const path of ['events', 'intervals', 'metrics', 'summary']) {
      await request(app.getHttpServer())
        .get(`/api/v1/exports/${path}.csv`)
        .query({ ...DAY, bucket: 'day' })
        .expect(401);
    }
    expect((await auditRows()).length).toBe(before);
  });
});
