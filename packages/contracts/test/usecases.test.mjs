import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createValidator } = require('../src/index.js');

const v = createValidator();

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
