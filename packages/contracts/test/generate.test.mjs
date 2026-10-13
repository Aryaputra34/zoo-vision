import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derefSettings } from '../scripts/deref.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (rel) => join(root, 'test', 'fixtures', rel);
const usecasesDir = join(root, 'generated', 'schemas', 'usecases');
const settingsSchemas = readdirSync(usecasesDir)
  .map((id) => [id, join(usecasesDir, id, 'settings.json')])
  .filter(([, file]) => existsSync(file))
  .map(([id, file]) => [id, JSON.parse(readFileSync(file, 'utf8'))]);

// Calls visit(node, pointer) for every object and array in the document.
const walk = (node, visit, pointer = '') => {
  if (node === null || typeof node !== 'object') return;
  visit(node, pointer);
  for (const [k, child] of Object.entries(node)) walk(child, visit, `${pointer}/${k}`);
};

test('there are settings schemas to check', () => {
  assert.ok(settingsSchemas.length >= 5);
});

test('generated settings schemas contain no $ref', () => {
  for (const [id, schema] of settingsSchemas) {
    walk(schema, (node, pointer) => {
      assert.ok(!('$ref' in node) || typeof node.$ref !== 'string', `${id}${pointer} has a $ref`);
    });
  }
});

test('no settings schema accepts null', () => {
  for (const [id, schema] of settingsSchemas) {
    walk(schema, (node, pointer) => {
      if (Array.isArray(node)) return;
      const types = [].concat(node.type ?? []);
      assert.ok(!types.includes('null'), `${id}${pointer} allows type null`);
      if ('const' in node) assert.notEqual(node.const, null, `${id}${pointer} has const null`);
      if (Array.isArray(node.enum)) assert.ok(!node.enum.includes(null), `${id}${pointer} has null in enum`);
    });
  }
});

test('derefSettings gives each reference only its own default and x-minRole', async () => {
  const s = await derefSettings(fixture('refs/settings.schema.json'));
  assert.deepEqual(s.properties.a.default, [0.1, 0.2]);
  assert.equal(s.properties.a['x-minRole'], 'SUPERADMIN');
  assert.equal(s.properties.b.default, undefined);
  assert.equal(s.properties.b['x-minRole'], undefined);
});
