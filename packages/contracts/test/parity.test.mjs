// Every case goes through createValidator() here and through the engine's own validators in Python
// (core.settings.parse_settings, core.messages.validate) via test/parity_check.py: the verdicts must match.
// Python runs as: uv run --no-project --with pydantic==<P> --with numpy==<N> python -I test/parity_check.py <services/engine>
// where <P> and <N> are read from services/engine/uv.lock, so the test uses the engine's versions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createValidator, loadRegistry } = require('../src/index.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const engine = join(root, '..', '..', 'services', 'engine');
const v = createValidator(loadRegistry());

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const jsonFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []);
const lockVersion = (name) => {
  const m = readFileSync(join(engine, 'uv.lock'), 'utf8').match(
    new RegExp(`\\[\\[package\\]\\]\\r?\\nname = "${name}"\\r?\\nversion = "([^"]+)"`),
  );
  assert.ok(m, `${name} not found in uv.lock`);
  return m[1];
};

const examples = (uc, kind, folder) =>
  jsonFiles(join(root, 'usecases', uc, 'examples', kind, folder)).map((f) => ({
    name: `${uc}/${kind}/${folder}/${f}`,
    doc: readJson(join(root, 'usecases', uc, 'examples', kind, folder, f)),
  }));

// null at every pointer of a document (object keys and array items, any depth)
const nullPointers = (doc, path = []) =>
  doc !== null && typeof doc === 'object'
    ? Object.entries(doc).flatMap(([k, child]) => [[...path, k], ...nullPointers(child, [...path, k])])
    : [];
const setAt = (doc, path, value) => {
  const copy = structuredClone(doc);
  let node = copy;
  for (const k of path.slice(0, -1)) node = node[k];
  node[path.at(-1)] = value;
  return copy;
};
const shallowNullPointers = (doc) => nullPointers(doc).filter((p) => p.length === 1 || (p[0] === 'data' && p.length === 2));

// One Python process for the whole file: collect every case up front, run them once.
const cases = [];
const add = (key, c) => cases.push({ key, c });

const useCases = readdirSync(join(root, 'usecases')).sort();
const withSettings = v.assignableUseCases();

const validSettings = [];
const invalidSettings = [];
for (const uc of withSettings) {
  for (const ex of examples(uc, 'settings', 'valid')) {
    const filled = v.withDefaults(uc, ex.doc);
    validSettings.push({ uc, ex, filled });
    add(`strict:${ex.name}`, { kind: 'settings', useCase: uc, doc: filled, strict: true });
    add(`lax:${ex.name}`, { kind: 'settings', useCase: uc, doc: ex.doc, strict: false });
    for (const path of nullPointers(filled)) {
      add(`null:${ex.name}:/${path.join('/')}`, { kind: 'settings', useCase: uc, doc: setAt(filled, path, null), strict: true });
    }
  }
  for (const ex of examples(uc, 'settings', 'invalid')) {
    const filled = v.withDefaults(uc, ex.doc);
    invalidSettings.push({ uc, ex, filled });
    add(`invalid:${ex.name}`, { kind: 'settings', useCase: uc, doc: filled, strict: true });
  }
}

const messages = [];
for (const uc of useCases) {
  for (const folder of ['valid', 'invalid']) {
    for (const ex of examples(uc, 'messages', folder)) {
      messages.push({ ...ex, ok: folder === 'valid' });
      add(`msg:${ex.name}`, { kind: 'message', doc: ex.doc });
      if (folder !== 'valid') continue;
      for (const path of shallowNullPointers(ex.doc)) {
        add(`msgnull:${ex.name}:/${path.join('/')}`, { kind: 'message', doc: setAt(ex.doc, path, null) });
      }
    }
  }
}

const run = spawnSync(
  'uv',
  ['run', '--no-project', '--with', `pydantic==${lockVersion('pydantic')}`, '--with', `numpy==${lockVersion('numpy')}`,
    'python', '-I', join(root, 'test', 'parity_check.py'), engine],
  { input: JSON.stringify(cases.map((c) => c.c)), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
);
assert.equal(run.status, 0, `parity_check.py failed:\n${run.stderr}`);
const results = JSON.parse(run.stdout);
const py = new Map(cases.map((c, i) => [c.key, results[i]]));
const jsMessage = (doc) => v.validateMessage(doc).ok;

test('settings: each valid example with defaults filled passes both, and Pydantic returns it unchanged', () => {
  assert.ok(validSettings.length >= 5);
  for (const { uc, ex, filled } of validSettings) {
    assert.equal(v.validateSettings(uc, filled).ok, true, ex.name);
    const r = py.get(`strict:${ex.name}`);
    assert.equal(r.ok, true, ex.name);
    assert.deepStrictEqual(r.dump, filled, ex.name);
  }
});

test("settings: Pydantic's defaults equal withDefaults for each valid example", () => {
  for (const { ex, filled } of validSettings) {
    const r = py.get(`lax:${ex.name}`);
    assert.equal(r.ok, true, ex.name);
    assert.deepStrictEqual(r.dump, filled, ex.name);
  }
});

test('settings: each invalid example fails both', () => {
  assert.ok(invalidSettings.length >= 4);
  for (const { uc, ex, filled } of invalidSettings) {
    assert.equal(v.validateSettings(uc, filled).ok, false, `js ${ex.name}`);
    assert.equal(py.get(`invalid:${ex.name}`).ok, false, `py ${ex.name}`);
  }
});

test('settings: null in place of any value of a filled valid example fails both', () => {
  let n = 0;
  for (const { uc, ex, filled } of validSettings) {
    for (const path of nullPointers(filled)) {
      n++;
      const where = `${ex.name}:/${path.join('/')}`;
      assert.equal(v.validateSettings(uc, setAt(filled, path, null)).ok, false, `js ${where}`);
      assert.equal(py.get(`null:${where}`).ok, false, `py ${where}`);
    }
  }
  assert.ok(n > 50);
});

test('messages: each example gets the same verdict from both', () => {
  assert.ok(messages.length > 10);
  for (const ex of messages) {
    assert.equal(jsMessage(ex.doc), ex.ok, `js ${ex.name}`);
    assert.equal(py.get(`msg:${ex.name}`).ok, ex.ok, `py ${ex.name}`);
  }
});

test('messages: null in place of any top-level or data value gets the same verdict from both', () => {
  let n = 0;
  for (const ex of messages.filter((m) => m.ok)) {
    for (const path of shallowNullPointers(ex.doc)) {
      n++;
      const where = `${ex.name}:/${path.join('/')}`;
      assert.equal(py.get(`msgnull:${where}`).ok, jsMessage(setAt(ex.doc, path, null)), where);
    }
  }
  assert.ok(n > 20);
});
