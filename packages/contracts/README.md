# @zoo-vision/contracts

The single source of truth for the Redis stream messages and the per-use-case settings. Everything
else is generated from the JSON Schemas here.

```
common/geometry.schema.json        Point, Polygon, Line ($defs, coordinates 0-1)
envelope/message.schema.json       the four stream messages (event, interval_open, interval_close, metric)
usecases/<id>/                     usecase.json, settings.schema.json (optional), live.schema.json (with settings),
                                   events.schema.json, intervals.schema.json, metrics.json, examples/
ws/server/*.schema.json            the WebSocket messages the API sends (event.created, data.changed, ...)
ws/client/*.schema.json            the ones the browser sends (subscribe, unsubscribe)
ws/examples/<message>/             valid/ and invalid/ payloads, checked by npm test
generated/schemas/**               bundled, self-contained copies (what src/index.js loads)
generated/ts/*.d.ts                TypeScript declarations (one per use case, envelope, ws)
generated/web/index.d.ts           the same types in ONE file with no imports, for the frontend
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
   * `live.schema.json` (**required when there are settings**): the shape of the `live` values the pipeline
     reports in `cam:{id}:status` (what `emit_status` is given). Every field optional, `additionalProperties:
     true`, and the title `<PascalUseCase>Live`; the engine's `tests/test_live_contract.py` checks each pipeline
     against it, and the frontend's live tiles are typed from it;
   * `examples/messages/*.json`, `examples/settings/*.json` and `examples/live/{valid,invalid}/*.json`: sample
     payloads. `npm test` validates every example, so add at least one valid example per event, interval and
     metric, and a valid and an invalid live example.
2. `npm run generate`, then commit the changes under `generated/` and `services/engine/contracts/`.
3. `npm test && npm run check`.
4. Make the engine pipeline emit the messages (`services/engine/core/messages.py` builds the envelope).

## WebSocket messages

`ws/server/<name>.schema.json` and `ws/client/<name>.schema.json` describe each socket.io payload; the file name is
the event name (`event.created`, `data.changed`, `status.snapshot`, `audit.notice`, `session.ended`, `subscribe`,
`unsubscribe`). The schema `title` names the generated type (`EventCreated`, `DataChanged`, ...). The API imports
the types from this package, and the gateway's real messages are validated against the schemas in its tests.
Change rules are the same: only add optional fields and new message types.

## The frontend's types file

`generated/web/index.d.ts` holds, in one self-contained file: the envelope types, one `namespace` per use case
(its settings, events, intervals and live types), the WebSocket payloads, `ServerToClientEvents`,
`ClientToServerEvents` and `UseCaseId`. The frontend pulls it, with `apps/api/openapi.json` and
`docs/fe-contract.md`, at a git tag `contract-vX.Y`.

## Use from JavaScript

```js
const { loadRegistry, createValidator } = require('@zoo-vision/contracts');
const v = createValidator(loadRegistry());
v.validateMessage(msg);              // { ok: true } | { ok: false, errors: [{ path, message }] }
v.validateSettings('system', cfg);
v.validateLive('vehicle_gate', live);          // a use case without a live schema accepts anything
v.validateWsMessage('event.created', payload); // an unknown message name is an error
```

## Use from Python

```python
from contracts.envelope import Message
from contracts.registry import REGISTRY
```

The Python models come from `datamodel-code-generator` (version pinned in `scripts/generate.mjs`).
