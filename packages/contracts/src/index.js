'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const DEFAULT_DIR = path.join(__dirname, '..', 'generated', 'schemas');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readJsonIfExists = (file) => (fs.existsSync(file) ? readJson(file) : null);

/** Reads <dir>/envelope/message.json and <dir>/usecases/<id>/{usecase,settings,events,intervals,metrics}.json. */
function loadRegistry(dir = DEFAULT_DIR) {
  const envelope = readJson(path.join(dir, 'envelope', 'message.json'));
  const useCases = new Map();
  const root = path.join(dir, 'usecases');
  for (const id of fs.readdirSync(root).sort()) {
    const folder = path.join(root, id);
    if (!fs.statSync(folder).isDirectory()) continue;
    const meta = readJson(path.join(folder, 'usecase.json'));
    const defs = (schema) => (schema ? { ...schema.$defs } : {});
    useCases.set(id, {
      label: meta.label,
      schemaVersion: meta.schemaVersion,
      settings: readJsonIfExists(path.join(folder, 'settings.json')),
      events: defs(readJsonIfExists(path.join(folder, 'events.json'))),
      intervals: defs(readJsonIfExists(path.join(folder, 'intervals.json'))),
      metrics: readJsonIfExists(path.join(folder, 'metrics.json')) ?? {},
    });
  }
  return { envelope, useCases };
}

function newAjv(options = {}) {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true, discriminator: true, ...options });
  addFormats(ajv);
  ajv.addKeyword({ keyword: 'x-geometry', schemaType: 'string' });
  ajv.addKeyword({ keyword: 'x-minRole', schemaType: 'string' });
  return ajv;
}

const toErrors = (ajvErrors, prefix = '') =>
  ajvErrors.map((e) => ({
    // point at the offending key rather than its parent object
    path: prefix + e.instancePath + (e.keyword === 'additionalProperties' ? `/${e.params.additionalProperty}` : ''),
    message: e.message ?? 'invalid',
  }));

const fail = (path_, message) => ({ ok: false, errors: [{ path: path_, message }] });

/** Follows local `$ref`s (`#/...`) so walks see through them. */
function deref(root, node) {
  const seen = new Set();
  while (node && typeof node.$ref === 'string' && node.$ref.startsWith('#/') && !seen.has(node.$ref)) {
    seen.add(node.$ref);
    node = node.$ref
      .slice(2)
      .split('/')
      .reduce((acc, key) => acc?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
  }
  return node;
}

/**
 * Calls visit(schemaNode, pointer) for every schema node reachable through `properties`, `items`, `prefixItems`
 * and the `anyOf` / `oneOf` / `allOf` branches. The pointer is a JSON pointer into the settings document in which
 * any array index is the wildcard segment `*`; the branches of a combinator share their parent's pointer.
 */
function walkSchema(root, visit) {
  const go = (node, pointer, depth) => {
    node = deref(root, node);
    if (!node || typeof node !== 'object' || depth > 32) return;
    visit(node, pointer);
    for (const [key, child] of Object.entries(node.properties ?? {})) go(child, `${pointer}/${key}`, depth + 1);
    for (const child of [node.items, ...(node.prefixItems ?? [])]) {
      if (child && typeof child === 'object') go(child, `${pointer}/*`, depth + 1);
    }
    for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
      for (const child of node[keyword] ?? []) go(child, pointer, depth + 1);
    }
  };
  go(root, '', 0);
}

/** Every concrete pointer (and its value) in `doc` that a `*` pointer matches. */
function expandPointer(doc, pointer) {
  let matches = [{ path: '', value: doc }];
  for (const key of pointer.split('/').slice(1)) {
    matches = matches.flatMap(({ path: at, value }) => {
      if (key === '*') return Array.isArray(value) ? value.map((item, i) => ({ path: `${at}/${i}`, value: item })) : [];
      const child = value !== null && typeof value === 'object' && !Array.isArray(value) ? value[key] : undefined;
      return child === undefined ? [] : [{ path: `${at}/${key}`, value: child }];
    });
  }
  return matches;
}

function createValidator(registry = loadRegistry()) {
  const ajv = newAjv();
  const compiled = new Map();
  const compileOnce = (key, schema) => {
    if (!compiled.has(key)) compiled.set(key, ajv.compile(schema));
    return compiled.get(key);
  };

  const validateEnvelope = ajv.compile(registry.envelope);
  const defaulting = newAjv({ useDefaults: true });

  const check = (key, schema, data, prefix = '') => {
    const validate = compileOnce(key, schema);
    return validate(data) ? { ok: true } : { ok: false, errors: toErrors(validate.errors, prefix) };
  };

  function validateMessage(message) {
    if (!validateEnvelope(message)) return { ok: false, errors: toErrors(validateEnvelope.errors) };

    const useCase = registry.useCases.get(message.useCase);
    if (!useCase) return fail('/useCase', `unknown use case '${message.useCase}'`);
    if (message.schemaVersion !== useCase.schemaVersion) {
      return fail('/schemaVersion', `use case '${message.useCase}' is at schemaVersion ${useCase.schemaVersion}`);
    }
    if (message.cameraId === null && message.useCase !== 'system') {
      return fail('/cameraId', "cameraId may be null only for the 'system' use case");
    }

    if (message.message === 'metric') {
      return Object.hasOwn(useCase.metrics, message.name)
        ? { ok: true }
        : fail('/name', `unknown metric '${message.name}' for use case '${message.useCase}'`);
    }

    const [field, defs] = message.message === 'event' ? ['type', useCase.events] : ['kind', useCase.intervals];
    const def = Object.hasOwn(defs, message[field]) ? defs[message[field]] : undefined;
    if (!def) return fail(`/${field}`, `unknown ${field} '${message[field]}' for use case '${message.useCase}'`);

    // Close data is a partial merged into the open data, so its keys are checked but none is required.
    const schema = message.message === 'interval_close' ? { ...def, required: undefined } : def;
    return check(`${message.useCase}:${message.message}:${message[field]}`, schema, message.data, '/data');
  }

  function duplicateListIds(schema, settings) {
    const errors = new Map(); // a list reached through two branches reports once
    walkSchema(schema, (node, pointer) => {
      if (node['x-geometry'] !== 'polygon-list') return;
      for (const { path: listPath, value: list } of expandPointer(settings, pointer)) {
        if (!Array.isArray(list)) continue;
        const seen = new Set();
        list.forEach((item, index) => {
          const at = `${listPath}/${index}/id`;
          if (seen.has(item?.id)) errors.set(at, { path: at, message: `duplicate id '${item.id}'` });
          seen.add(item?.id);
        });
      }
    });
    return [...errors.values()];
  }

  function validateSettings(useCaseId, settings) {
    const schema = registry.useCases.get(useCaseId)?.settings;
    if (!schema) return fail('', `use case '${useCaseId}' has no settings`);
    const result = check(`${useCaseId}:settings`, schema, settings);
    const duplicates = result.ok ? duplicateListIds(schema, settings) : [];
    if (result.ok && duplicates.length === 0) return result;
    return { ok: false, errors: [...(result.errors ?? []), ...duplicates] };
  }

  function withDefaults(useCaseId, settings) {
    const schema = registry.useCases.get(useCaseId)?.settings;
    if (!schema) throw new Error(`use case '${useCaseId}' has no settings`);
    const copy = structuredClone(settings);
    const key = `${useCaseId}:defaults`;
    if (!compiled.has(key)) compiled.set(key, defaulting.compile(schema));
    compiled.get(key)(copy); // useDefaults fills the copy in place; validity is validateSettings' job
    return copy;
  }

  function restrictedFields(useCaseId) {
    const schema = registry.useCases.get(useCaseId)?.settings;
    if (!schema) return [];
    const fields = new Map();
    walkSchema(schema, (node, pointer) => {
      if (node['x-minRole'] && pointer) fields.set(`${pointer}\u0000${node['x-minRole']}`, { path: pointer, minRole: node['x-minRole'] });
    });
    return [...fields.values()];
  }

  function assignableUseCases() {
    return [...registry.useCases].filter(([, c]) => c.settings).map(([id]) => id).sort();
  }

  return { validateMessage, validateSettings, withDefaults, restrictedFields, assignableUseCases };
}

module.exports = { loadRegistry, createValidator, walkSchema };
