import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createValidator } = require('../src/index.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const examples = join(root, 'ws', 'examples');
const v = createValidator();

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const jsonFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []);

const NAMES = [
  'event.created',
  'data.changed',
  'status.snapshot',
  'audit.notice',
  'session.ended',
  'subscribe',
  'unsubscribe',
];

test('each ws example validates; a status.snapshot with a null camera is valid', () => {
  for (const name of NAMES) {
    const valid = jsonFiles(join(examples, name, 'valid'));
    assert.ok(valid.length >= 1, `${name} has a valid example`);
    for (const [folder, ok] of [['valid', true], ['invalid', false]]) {
      for (const f of jsonFiles(join(examples, name, folder))) {
        const result = v.validateWsMessage(name, readJson(join(examples, name, folder, f)));
        assert.equal(result.ok, ok, `${name}/${folder}/${f}: ${JSON.stringify(result)}`);
      }
    }
  }
  const withNull = {
    at: '2026-10-14T10:00:02.000Z',
    cameras: {
      cam_a: {
        state: 'running',
        fps: 5,
        lastFrameAt: 1760436000.5,
        appliedVersion: 3,
        configError: null,
        restarts: 0,
        live: { inCount: 2 },
        updatedAt: 1760436000.6,
      },
      cam_offline: null,
    },
  };
  assert.deepEqual(v.validateWsMessage('status.snapshot', withNull), { ok: true });
});

test('validateWsMessage("nope", {}) fails; subscribe {rooms: ["managers"]} fails', () => {
  assert.equal(v.validateWsMessage('nope', {}).ok, false);
  assert.equal(v.validateWsMessage('subscribe', { rooms: ['managers'] }).ok, false);
  assert.equal(v.validateWsMessage('subscribe', { rooms: [] }).ok, false);
  assert.equal(v.validateWsMessage('subscribe', { rooms: ['status'] }).ok, true);
});
