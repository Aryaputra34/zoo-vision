# @zoo-vision/contracts

The single source of truth for the Redis stream messages and the per-use-case settings. Everything
else is generated from the JSON Schemas here.

```
common/geometry.schema.json        Point, Polygon, Line ($defs, coordinates 0-1)
envelope/message.schema.json       the four stream messages (event, interval_open, interval_close, metric)
usecases/<id>/                     usecase.json, settings.schema.json (optional), events.schema.json,
                                   intervals.schema.json, metrics.json, examples/
generated/schemas/**               bundled, self-contained copies (what src/index.js loads)
generated/ts/*.d.ts                TypeScript declarations
../../services/engine/contracts/   Pydantic models + registry.py for the engine
```

Never edit `generated/` or `services/engine/contracts/` by hand.

```
npm run generate   # rebuild all generated output (needs Node 22 and uv)
npm run check      # generate, then fail if the committed output differs
npm test           # validator + example tests
```

## Change rules (design spec section 3)

* Only add optional fields. Never change the meaning of an existing field, never remove or rename one.
* A breaking change bumps that use case's `schemaVersion` in `usecase.json`. Events and config versions store the
  `schemaVersion` they were written with, so old rows stay readable.
* Analytics data is stored by shape (`Event`, `Interval`, `Metric`), not by use case, so a new use case needs no
  database migration. Hot `data` fields that a report filters on may get an expression index later.
* Camera settings are validated against `settings.schema.json` on write (API) and on load (engine).

## Add a use case

1. Create `usecases/<id>/` (the id is the camera `useCase` slug, lower snake case) with:
   * `usecase.json`: `{ "label": "...", "schemaVersion": 1 }`;
   * `events.schema.json`: one schema per event `type` the use case emits;
   * `intervals.schema.json`: the `kind` values and their `data` (omit when the use case has no intervals);
   * `metrics.json`: the metric names with `label` and `unit`;
   * `settings.schema.json` (optional): the per-camera settings. Reuse `common/geometry.schema.json` for
     points, polygons and lines (coordinates 0-1);
   * `examples/messages/*.json` and `examples/settings/*.json`: sample payloads. `npm test` validates every
     example, so add at least one valid example per event, interval and metric.
2. `npm run generate`, then commit the changes under `generated/` and `services/engine/contracts/`.
3. `npm test && npm run check`.
4. Make the engine pipeline emit the messages (`services/engine/core/messages.py` builds the envelope).

## Use from JavaScript

```js
const { loadRegistry, createValidator } = require('@zoo-vision/contracts');
const v = createValidator(loadRegistry());
v.validateMessage(msg);              // { ok: true } | { ok: false, errors: [{ path, message }] }
v.validateSettings('system', cfg);
```

## Use from Python

```python
from contracts.envelope import Message
from contracts.registry import REGISTRY
```

The Python models come from `datamodel-code-generator` (version pinned in `scripts/generate.mjs`).
