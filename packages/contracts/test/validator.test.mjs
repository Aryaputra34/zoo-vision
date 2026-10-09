import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createValidator, loadRegistry } = require('../src/index.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// loadRegistry reads <dir>/envelope/message.json and <dir>/usecases/*/, so build that shape at runtime:
// the generated envelope plus the hand-written demo use case.
const dir = mkdtempSync(join(tmpdir(), 'contracts-registry-'));
mkdirSync(join(dir, 'envelope'), { recursive: true });
cpSync(join(root, 'generated/schemas/envelope/message.json'), join(dir, 'envelope/message.json'));
cpSync(join(root, 'test/fixtures/usecases'), join(dir, 'usecases'), { recursive: true });
test.after(() => rmSync(dir, { recursive: true, force: true }));

const v = createValidator(loadRegistry(dir));

const base = {
  cameraId: 'cam1',
  useCase: 'demo',
  schemaVersion: 1,
  configVersion: null,
  time: '2026-10-09T10:00:00.000Z',
};
const ping = (over = {}) => ({
  message: 'event',
  ...base,
  id: 'evt_' + '0'.repeat(32),
  type: 'ping',
  severity: 'info',
  snapshotPath: null,
  data: { n: 1 },
  ...over,
});

test('accepts a valid demo event', () => {
  assert.deepEqual(v.validateMessage(ping()), { ok: true });
});

test('rejects a polygon point outside 0..1', () => {
  const r = v.validateSettings('demo', { zone: [[0, 0], [1.2, 0], [1, 1]], tables: [] });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].path, '/zone/1/0');
});

test('rejects duplicate ids in a polygon list', () => {
  const t = { id: 'T1', name: 'a', polygon: [[0, 0], [1, 0], [1, 1]] };
  assert.deepEqual(
    v.validateSettings('demo', { zone: t.polygon, tables: [t, t] }).errors.map((e) => e.path),
    ['/tables/1/id'],
  );
});

test('restrictedFields lists x-minRole properties', () => {
  assert.deepEqual(v.restrictedFields('demo'), [
    { path: '/model_name', minRole: 'SUPERADMIN' },
    { path: '/tracker/lost_track_buffer', minRole: 'SUPERADMIN' },
  ]);
});

test('withDefaults fills nested defaults and leaves its input alone', () => {
  const input = { zone: [[0, 0], [1, 0], [1, 1]], tables: [], tracker: {} };
  const out = v.withDefaults('demo', input);
  assert.equal(out.model_name, 'a.onnx');
  assert.equal(out.tracker.lost_track_buffer, 30);
  assert.equal(input.model_name, undefined);
  assert.deepEqual(input.tracker, {});
});

test('assignableUseCases lists use cases that have settings', () => {
  assert.deepEqual(v.assignableUseCases(), ['demo']);
});

test('cameraId null is only allowed for the system use case', () => {
  assert.equal(v.validateMessage(ping({ cameraId: null })).ok, false);
});

test('rejects an unknown use case', () => {
  assert.equal(v.validateMessage(ping({ useCase: 'nope' })).ok, false);
});

test('rejects a metric name not in metrics.json', () => {
  const metric = { message: 'metric', ...base, name: 'nope', value: 1 };
  assert.equal(v.validateMessage(metric).ok, false);
  assert.deepEqual(v.validateMessage({ ...metric, name: 'count' }), { ok: true });
});

test('rejects a schemaVersion other than the use case version', () => {
  assert.equal(v.validateMessage(ping({ schemaVersion: 2 })).ok, false);
});

test('rejects an unknown event type', () => {
  assert.equal(v.validateMessage(ping({ type: 'pong' })).ok, false);
});

test('reports data errors under /data', () => {
  const r = v.validateMessage(ping({ data: { n: 'x' } }));
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].path, '/data/n');
});

const sessionId = 'ses_' + 'a'.repeat(32);
const open = (data) => ({ message: 'interval_open', ...base, sessionId, kind: 'visit', subjectId: 'T1', data });
const close = (data) => ({ message: 'interval_close', ...base, sessionId, kind: 'visit', endReason: 'ended', data });

test('interval_open data must carry the required fields', () => {
  assert.deepEqual(v.validateMessage(open({ tableName: 'Table 1' })), { ok: true });
  assert.equal(v.validateMessage(open({})).ok, false);
});

test('interval_close data is a partial: empty passes, unknown keys fail under /data', () => {
  assert.deepEqual(v.validateMessage(close({})), { ok: true });
  assert.deepEqual(v.validateMessage(close({ partySize: 3 })), { ok: true });
  const r = v.validateMessage(close({ bogus: 1 }));
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].path, '/data/bogus');
});
