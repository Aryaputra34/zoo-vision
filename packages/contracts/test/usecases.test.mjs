import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createValidator, loadRegistry } = require('../src/index.js');

const v = createValidator();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const jsonFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []);

test('the five camera use cases are assignable', () => {
  assert.deepEqual(v.assignableUseCases(), [
    'cashier_presence',
    'horse_riding',
    'restaurant_counter',
    'restaurant_table',
    'vehicle_gate',
  ]);
});

test('superadmin-only fields per use case', () => {
  const paths = (uc) => v.restrictedFields(uc).map((f) => f.path).sort();
  assert.deepEqual(paths('cashier_presence'), ['/imgsz', '/model_id', '/model_name']);
  assert.deepEqual(paths('horse_riding'), [
    '/frame_rate', '/imgsz', '/lost_track_buffer', '/matching_thresh', '/model_id', '/model_name',
    '/smoothing_frames', '/track_activation_thresh', '/track_horses_only',
  ]);
  assert.deepEqual(paths('restaurant_counter'), [
    '/containment_threshold', '/deduplication_enabled', '/imgsz', '/iou_threshold',
    '/lost_track_buffer', '/model_id', '/model_name', '/smoothing_frames', '/tracking_enabled',
  ]);
  assert.deepEqual(paths('restaurant_table'), [
    '/containment_threshold', '/deduplication_enabled', '/imgsz', '/iou_threshold', '/model_id', '/model_name',
  ]);
  assert.deepEqual(paths('vehicle_gate'), [
    '/anpr', '/frame_rate', '/imgsz', '/lost_track_buffer', '/matching_thresh',
    '/model_id', '/model_name', '/track_activation_thresh',
  ]);
});

test('every use case with settings has a live schema; live examples pass and invalid ones fail', () => {
  const registry = loadRegistry();
  for (const id of v.assignableUseCases()) {
    assert.ok(registry.useCases.get(id).live, `${id} has a live schema`);
    const dir = join(root, 'usecases', id, 'examples', 'live');
    const valid = jsonFiles(join(dir, 'valid'));
    const invalid = jsonFiles(join(dir, 'invalid'));
    assert.ok(valid.length >= 1 && invalid.length >= 1, `${id} has a valid and an invalid live example`);
    for (const f of valid) assert.equal(v.validateLive(id, readJson(join(dir, 'valid', f))).ok, true, `${id}/valid/${f}`);
    for (const f of invalid) assert.equal(v.validateLive(id, readJson(join(dir, 'invalid', f))).ok, false, `${id}/invalid/${f}`);
  }
  // a use case without a live schema accepts anything
  assert.equal(registry.useCases.get('system').live, null);
  assert.deepEqual(v.validateLive('system', { anything: 1 }), { ok: true });
});

test('system accepts a model_validation_failed event; one without error fails', () => {
  const message = {
    message: 'event',
    cameraId: null,
    useCase: 'system',
    schemaVersion: 1,
    configVersion: null,
    time: '2026-10-14T10:00:00.000Z',
    id: 'evt_00000000000000000000000000000009',
    type: 'model_validation_failed',
    severity: 'warning',
    snapshotPath: null,
    data: { modelId: '5f0e2a4c-1d3b-4c6e-8a7f-9b0c1d2e3f40', name: 'yolo-custom', error: 'class names missing' },
  };
  assert.deepEqual(v.validateMessage(message), { ok: true });
  const { error: _error, ...withoutError } = message.data;
  assert.equal(v.validateMessage({ ...message, data: withoutError }).ok, false);
});
