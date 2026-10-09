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

Contract rules: only add optional fields, never change a field's meaning; a breaking change bumps
that use case's `schemaVersion` in `usecase.json`.

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
