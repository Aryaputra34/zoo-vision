import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './app';
import { asRole } from './helpers/auth';
import { flushRedis, resetDb } from './setup/db';

type Schema = {
  properties?: Record<string, Record<string, unknown>>;
};
type UseCase = {
  id: string;
  label: string;
  schemaVersion: number;
  assignable: boolean;
  settingsSchema: Schema | null;
  liveSchema: Schema | null;
  events: { type: string; schema: object }[];
  intervals: { kind: string; schema: object }[];
  metrics: { name: string; label: string; unit: string }[];
};

describe('GET /api/v1/usecases', () => {
  let app: INestApplication<App>;
  let all: UseCase[];

  beforeAll(async () => {
    await resetDb();
    await flushRedis();
    app = await createTestApp();
    const { cookie } = await asRole(app, 'USER');
    const res = await request(app.getHttpServer())
      .get('/api/v1/usecases')
      .set('Cookie', cookie)
      .expect(200);
    all = res.body as UseCase[];
  });

  afterAll(async () => {
    await app.close();
  });

  const byId = (id: string) => {
    const found = all.find((u) => u.id === id);
    if (!found) throw new Error(`no use case ${id}`);
    return found;
  };

  it('as USER returns six use cases sorted by id; system has assignable false and settingsSchema null', () => {
    expect(all.map((u) => u.id)).toEqual([
      'cashier_presence',
      'horse_riding',
      'restaurant_counter',
      'restaurant_table',
      'system',
      'vehicle_gate',
    ]);
    expect(byId('system')).toMatchObject({
      assignable: false,
      settingsSchema: null,
      liveSchema: null,
    });
    expect(byId('vehicle_gate')).toMatchObject({
      assignable: true,
      label: expect.any(String) as string,
      schemaVersion: expect.any(Number) as number,
    });
  });

  it('horse_riding has a property with x-geometry "line", and model_id with x-minRole "SUPERADMIN"', () => {
    const props = byId('horse_riding').settingsSchema?.properties ?? {};
    expect(props.tripwire?.['x-geometry']).toBe('line');
    expect(props.model_id?.['x-minRole']).toBe('SUPERADMIN');
    // defaults are filled in for the form
    expect(Object.values(props).some((p) => 'default' in p)).toBe(true);
  });

  it('restaurant_counter lists metric occupancy (unit persons) and interval kind table_session', () => {
    const rc = byId('restaurant_counter');
    expect(rc.metrics).toContainEqual({
      name: 'occupancy',
      label: expect.any(String) as string,
      unit: 'persons',
    });
    expect(rc.intervals.map((i) => i.kind)).toContain('table_session');
    expect(rc.events.map((e) => e.type)).toContain('capacity_alert');
  });

  it('restaurant_table liveSchema describes tables', () => {
    const props = byId('restaurant_table').liveSchema?.properties ?? {};
    expect(props.tables).toMatchObject({ type: 'array' });
  });

  it('no session → 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/usecases')
      .expect(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
