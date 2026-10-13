import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createValidator, loadRegistry } = require('../src/index.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const registry = loadRegistry();
const v = createValidator(registry);

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const jsonFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []);

for (const uc of readdirSync(join(root, 'usecases'))) {
  const examples = join(root, 'usecases', uc, 'examples');
  const seen = { event: new Set(), interval_open: new Set(), metric: new Set() };

  for (const [folder, ok] of [['valid', true], ['invalid', false]]) {
    for (const f of jsonFiles(join(examples, 'messages', folder))) {
      const msg = readJson(join(examples, 'messages', folder, f));
      test(`${uc}: message ${folder}/${f}`, () => {
        assert.equal(v.validateMessage(msg).ok, ok);
      });
      if (ok) seen[msg.message]?.add(msg.type ?? msg.kind ?? msg.name);
    }
    for (const f of jsonFiles(join(examples, 'settings', folder))) {
      const settings = readJson(join(examples, 'settings', folder, f));
      test(`${uc}: settings ${folder}/${f}`, () => {
        assert.equal(v.validateSettings(uc, settings).ok, ok);
      });
    }
  }

  test(`${uc}: every event type, interval kind and metric has a valid message example`, () => {
    const c = registry.useCases.get(uc);
    assert.deepEqual([...seen.event].sort(), Object.keys(c.events).sort());
    assert.deepEqual([...seen.interval_open].sort(), Object.keys(c.intervals).sort());
    assert.deepEqual([...seen.metric].sort(), Object.keys(c.metrics).sort());
  });
}
