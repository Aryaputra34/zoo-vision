# Zoo Vision Phase 1 (Backbone) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Engine output flows engine → Redis stream → NestJS API → Postgres. Cameras, users, roles,
API tokens and the audit log are managed through the API. Every use case's settings and messages
are defined once, in `packages/contracts`.

**Architecture:** `packages/contracts` holds JSON Schema per use case plus the stream message
envelope. A Node script bundles the schemas and generates TypeScript declarations and Pydantic
models; generated code is committed and CI fails when it is stale. The package also exports the
one validator that the API and the contract tests use. The engine still reads YAML. It now builds
contract-checked messages (events, interval open/close, per-minute metrics) and XADDs them to the
Redis stream `events` through a sender with a bounded buffer. `apps/api` (NestJS 11 + Prisma 7 +
Postgres 17 + Redis) provides cookie sessions and API tokens, users, audit, and cameras with
versioned configs. Its `EventsConsumer` writes the three generic tables idempotently. A one-off
script imports `cameras.yaml` + `rules/*.yaml` into camera config versions through the API.

**Tech Stack:** Node 22 LTS, npm, NestJS 11, Prisma 7 (`prisma-client` generator,
`@prisma/adapter-pg`, `prisma.config.ts`), ioredis, bcrypt, `@nestjs/passport` + `passport-local`,
`@nestjs/swagger`, `@nestjs/throttler`, `@nestjs/terminus`, class-validator, Jest + supertest +
Testcontainers, ajv (draft 2020-12), json-schema-to-typescript, `@apidevtools/json-schema-ref-parser`,
datamodel-code-generator (via `uvx`), Python 3.12 + uv 0.12.10, redis-py, pytest, Postgres 17,
Redis 7.4, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-08-zoo-vision-production-architecture-design.md`
(sections 1 (Redis keys), 3, 4, 6 (phase 1), 8; section 7's login history and system log rules).

## Global Constraints

- Work in the main checkout `C:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor`, on branch
  `phase-1-backbone` created from `main`. Task 14 needs the local model files and
  `services/engine/configs/cameras.yaml`, which a worktree would not have. Never commit to `main`.
  Push only after the user says yes.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- This phase runs on a Windows laptop with Docker Desktop and no NVIDIA GPU:
  - The engine always runs from source with `uv`, on CPU.
  - Docker runs only `postgres`, `redis`, `api-migrate`, `api` and the Testcontainers test
    containers.
  - Never run `docker compose up` without naming services. Never build the engine image
    (`services/engine/Dockerfile`) in this phase; it needs a CUDA machine (the user's CUDA laptop
    or the park server) and Phase 1 doesn't need it.
- Don't edit historical documents: `docs/adr/*`, `docs/01_*`, `docs/04_*`, `docs/06_*`,
  `docs/architecture_best_practice_recommendation.md`, the spec, the Phase 0 plan.
- The engine still reads `cameras.yaml` + `rules/*.yaml`. `core/api_server.py` (live preview,
  snapshots, health) stays. Config from the API is Phase 2.
- Versions: use the newest release of each named major when installing, and commit the lockfiles.
  Postgres `postgres:17.<patch>-alpine` and Redis `redis:7.4.<patch>-alpine`: pick the current patch
  tag once and use that exact tag in compose, Testcontainers and CI.
- API paths: global prefix `api`, URI versioning, default version `1` → `/api/v1/...`. Health is
  `/api/health` (version-neutral). Swagger UI is at `/api/docs`, its JSON at `/api/docs-json`.
- Times: Postgres `timestamptz(3)`, UTC. Messages carry `YYYY-MM-DDTHH:MM:SS.mmmZ`.
- Coordinates are normalized, 0–1 inclusive.
- Redis: stream `events` with one field `msg` (JSON), written with
  `XADD events MAXLEN ~ 1000000 * msg <json>`. Consumer group `api`, consumer `api-1`. Channel
  `cfg:changed`. Keys `sess:{sha256hex(token)}`, `usess:{userId}`, `loginfail:{username}`,
  `ingest:failures`.
- Roles rank `USER < MANAGER < SUPERADMIN`.
- Database roles: `zoo_owner` runs migrations only; the API connects as `zoo_api`. For `zoo_api`,
  `Event`, `AuditLog`, `LoginLog`, `DeadEvent` are SELECT + INSERT only. `CameraConfigVersion` adds
  DELETE (only with its camera). `Interval` may UPDATE only `end`, `endReason`, `data`. `Metric` may
  UPDATE only `value`.
- Never put these in logs, audit rows, or responses to anyone below SUPERADMIN: passwords, password
  hashes, API tokens or their hashes, camera stream URLs. API tokens are shown once, at creation.
- Contract rules (spec section 3): only add optional fields. Never change a field's meaning. A
  breaking change bumps that use case's `schemaVersion`.
- Settings field names are the YAML rule keys the pipelines read today (snake_case). Each schema
  `default` equals the pipeline's code default. Message `data` fields stay camelCase, as today.
- Numbers the spec doesn't give, fixed here: bcrypt cost 12; passwords at least 10 characters;
  5 failed logins in 15 min lock the account for the rest of those 15 min; login is throttled to
  10 requests/min per IP; sessions slide 12 h with a 7 d cap; dead-letter after 5 failed attempts.

## Decisions this plan makes beyond the spec

The user should confirm these when reviewing the plan.

1. **Pipelines send the target message shapes now.** `table_state_change` events become
   `table_session` intervals. The cashier gets a `desk_unattended` interval. Numeric status fields
   become per-minute averages (`Metric`). The 30 s `status` event is no longer sent; Phase 2 turns
   `emit_status` into the `cam:{id}:status` heartbeat.
2. **zoo-analytics-web gets no new events from this phase until Phase 3** (the spec says "instead of
   HTTP"). Its live preview through the engine's API server keeps working.
3. `configVersion` is `null` while the engine runs from YAML. From Phase 2 it is always set.
4. Settings keep `model_name` (a file name in `models/`) until the Phase 2 model registry adds
   `modelId`.
5. Each use case folder adds a `usecase.json` (`label`, `schemaVersion`). A folder without
   `settings.schema.json` (`system`) cannot be assigned to a camera.
6. Source type `FILE` joins `RTSP | MEDIAMTX | NX`, for sample-video cameras (dev and test).
7. Migrations run as `zoo_owner` in a one-shot `api-migrate` compose service. The long-running API
   only has the `zoo_api` password.
8. Failed attempts per entry are counted in the Redis hash `ingest:failures`, not via XPENDING's
   delivery count. When a batch fails, the consumer first probes Postgres, so an outage never
   dead-letters anything.
9. The session stores only the user id. The guard reads `role` and `active` from Postgres on every
   request, which is how disabling a user or changing a role takes effect on the next request.
10. Config saves carry `baseVersion`. A stale one gets 409, so two editors can't overwrite each
    other.
11. `CameraConfigVersion` also stores `useCase`, so rolling back across a use-case change restores
    both.
12. Swagger is `SWAGGER=public|off` in Phase 1. Superadmin-only docs need the web login (Phase 3).
13. On a clean shutdown the engine closes its own open intervals (`endReason = engine_stop`).
    `engine_started` handling covers crashes.
14. A camera can be deleted only while no `Event`/`Interval`/`Metric` row references it. Otherwise
    the answer is "disable it instead".

## Needs the user

1. Docker Desktop running: Testcontainers e2e from Task 5 on, compose in Task 14.
2. Task 14: choose the first superadmin's password and the deploy secrets.
3. Task 14: approve `git push`. The pull request is opened from the compare link.

## Not in Phase 1

- Engine config from the API, a `cfg:changed` listener, `cam:{id}:status` heartbeats, offline
  detection and downtime intervals, `engineGroup` filtering in the engine, the shared model pool,
  `AiModel`: Phase 2.
- `reports`, `system-log` views, `usecases` endpoint, the `live` WebSocket gateway and post-commit
  push, Caddy, superadmin-only Swagger, notifying managers about `auditCamera` changes, publishing
  `@zoo-vision/contracts` to GitHub Packages, the web: Phase 3.
- MediaMTX Control API sync, the `media` module, evidence, retention jobs, `ExportJob`,
  `SiteSettings` (added with its first user): Phase 4.
- Clock-drift check, backups, image publishing: Phase 5.
- Recording `LoginLog` session expiry. Logout is recorded as its own `LOGOUT` row; expiry is not
  observable without a job.

## Review Focus

1. **Postgres down or restarting while the engine runs.** Expected: entries wait in the stream,
   nothing is dead-lettered, and every entry lands exactly once after recovery. Tests in Task 12.
2. **Redis down while the engine runs.** Expected: camera loops never block, the buffer stays
   bounded, the oldest messages drop first, and the drop count arrives as an `events_dropped`
   system event once Redis is back. Tests in Task 3.
3. **Two people edit the same camera at once.** Expected: one save wins and the other gets 409;
   nothing is silently overwritten. Tests in Task 11.
4. **The last active superadmin is deactivated or demoted, including by themselves.** Expected: 409,
   so the site never loses its only superadmin. Tests in Task 8.
5. **Secrets leaking through the side doors:** camera URL passwords in audit rows, manager views or
   the import script's output; API tokens or password hashes in audit rows. Tests in Tasks 8, 9, 10
   and 13.

## Target layout at the end of Phase 1

```
zoo-vision/
  .github/workflows/  engine.yml (+ redis service), repo.yml, contracts.yml, api.yml
  apps/api/           NestJS + Prisma: src/{auth,users,api-tokens,audit,cameras,contracts,ingest,
                      health,prisma,redis,config}, prisma/, test/, Dockerfile, README.md
  packages/contracts/ common/, envelope/, usecases/<name>/, scripts/generate.mjs, src/index.js,
                      generated/{schemas,ts}/, test/
  services/engine/    contracts/ (generated Pydantic), core/{messages,event_stream,metrics}.py, …
  deploy/             docker-compose.yml (+ postgres, redis, api-migrate, api), postgres/init/, .env.example
  tools/              import_yaml_config.py (+ tests)
```

---

### Task 1: Contracts package, message envelope and code generation

**Files:**
- Create: `packages/contracts/package.json`, `package-lock.json`, `README.md`
- Create: `packages/contracts/common/geometry.schema.json`, `envelope/message.schema.json`
- Create: `packages/contracts/usecases/system/{usecase.json,events.schema.json,intervals.schema.json,metrics.json}`
  and `usecases/system/examples/messages/{valid,invalid}/*.json`
- Create: `packages/contracts/scripts/generate.mjs`, `src/index.js`, `src/index.d.ts`
- Create: `packages/contracts/test/validator.test.mjs`, `test/examples.test.mjs`,
  `test/fixtures/registry/**` (a hand-bundled `demo` use case)
- Generated, committed: `packages/contracts/generated/schemas/**`, `generated/ts/*.d.ts`,
  `services/engine/contracts/**`
- Create: `services/engine/tests/test_contracts_generated.py`, `.github/workflows/contracts.yml`
- Modify: `.gitattributes`

**Interfaces:**
- Produces, use case folder `usecases/<id>/`:
  - `usecase.json` `{"label": str, "schemaVersion": int}`.
  - Optional `settings.schema.json`.
  - `events.schema.json` and `intervals.schema.json`: `$defs` keyed by event type / interval kind.
    Each entry is a flat object with a PascalCase `title` and `additionalProperties: false`, with no
    `$ref`.
  - `metrics.json` `{"<name>": {"label": str, "unit": str}}`.
  - `examples/messages/{valid,invalid}/*.json`: complete stream messages.
  - `examples/settings/{valid,invalid}/*.json`.
- Produces, geometry `$defs` in `common/geometry.schema.json`:
  - `Point`: `[x, y]`, numbers 0–1.
  - `Polygon`: at least 3 Points, `"x-geometry": "polygon"`.
  - `Line`: `{start: Point, end: Point}`, `"x-geometry": "line"`.
  - A list of named polygons is an array property marked `"x-geometry": "polygon-list"`. Its items
    have `id` (`^[A-Za-z0-9_-]{1,32}$`), `name` and `polygon`.
  - Settings fields that need a higher role carry `"x-minRole": "SUPERADMIN"`.
- Produces, envelope (`oneOf` on `message`, every branch `additionalProperties: false`):

  | Field | `event` | `interval_open` | `interval_close` | `metric` |
  |---|---|---|---|---|
  | `cameraId` | string, or `null` (system only) | string | string | string |
  | `useCase`, `schemaVersion` (int ≥ 1), `configVersion` (int or null) | ✓ | ✓ | ✓ | ✓ |
  | `time` | event time | interval start | interval end | minute start, pattern `…:00.000Z` |
  | `id` `^evt_[0-9a-f]{32}$`, `type`, `severity` `info\|warning\|critical`, `snapshotPath` (string or null) | ✓ | | | |
  | `sessionId` `^ses_[0-9a-f]{32}$`, `kind` | | ✓ | ✓ | |
  | `subjectId` (string or null) | | ✓ | | |
  | `endReason` `ended\|engine_stop` | | | ✓ | |
  | `data` (object; on close, merged into the open data) | ✓ | ✓ | ✓ | |
  | `name`, `value` (number) | | | | ✓ |

  Every field in the table is required; "or null" marks the nullable ones. `time` always matches
  `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`.
- Produces, `system` use case: label `System`, schemaVersion 1, no settings, no intervals, no
  metrics. Events:
  - `engine_started` `{bootId: ^[0-9a-f]{32}$, engineGroup: string}`
  - `events_dropped` `{engineGroup: string, count: int ≥ 1}`
- Produces, JS (`src/index.js`, CommonJS; runtime deps `ajv` + `ajv-formats` only; `index.d.ts`
  declares the types and re-exports `generated/ts/*.d.ts`):
  ```ts
  type ValidationError = { path: string; message: string };          // path = JSON pointer
  type ValidationResult = { ok: true } | { ok: false; errors: ValidationError[] };
  function loadRegistry(dir?: string): Registry;   // default: ../generated/schemas
  function createValidator(registry?: Registry): {
    validateMessage(message: unknown): ValidationResult;
    validateSettings(useCase: string, settings: unknown): ValidationResult;
    withDefaults(useCase: string, settings: object): object;          // deep clone, defaults filled
    restrictedFields(useCase: string): { path: string; minRole: 'MANAGER' | 'SUPERADMIN' }[];
    assignableUseCases(): string[];                                    // have settings, sorted
  };
  ```
  `validateMessage` checks these in order:
  1. The envelope.
  2. The use case is known.
  3. `schemaVersion` equals the use case's.
  4. `cameraId` may be `null` only when `useCase` is `system`.
  5. The type or kind is known.
  6. `data` matches its `$def`; errors get the prefix `/data`.
  7. A metric `name` is in `metrics.json`.

  `validateSettings` also rejects duplicate `id`s inside any `polygon-list` (path
  `/<list>/<index>/id`). ajv runs in strict mode with the keywords `x-geometry` and `x-minRole`
  registered.
- Produces, Python (generated):
  - `services/engine/contracts/envelope.py` with root model `Message`.
  - `contracts/<use_case>/{settings,events,intervals}.py`.
  - `contracts/registry.py`:
    ```python
    @dataclass(frozen=True)
    class UseCaseContract:
        label: str
        schema_version: int
        settings: type[BaseModel] | None
        events: dict[str, type[BaseModel]]
        intervals: dict[str, type[BaseModel]]
        metrics: dict[str, str]  # name -> unit
    REGISTRY: dict[str, UseCaseContract]
    ```
- Produces, npm scripts in `packages/contracts`: `generate`, `check` (generate, then
  `git diff --exit-code -- generated ../../services/engine/contracts`), `test` (`node --test`).

- [ ] **Step 1: Start the branch**

Run: `git status --short`. Expected: only `?? docs/superpowers/plans/2026-10-09-phase-1-backbone.md`.
Then `git switch -c phase-1-backbone main` and commit the plan alone
(`docs: Phase 1 implementation plan`).

- [ ] **Step 2: Write the failing tests**

`test/fixtures/registry/demo/` is a hand-written use case `demo` with schemaVersion 1. It has:
- settings `zone` (Polygon), `tables` (polygon-list), `model_name` (`x-minRole: SUPERADMIN`, default
  `"a.onnx"`), `tracker.lost_track_buffer` (`x-minRole: SUPERADMIN`, default 30);
- event `ping {n: integer}`;
- metric `count`.

```js
// test/validator.test.mjs
const v = createValidator(loadRegistry(fixtureDir));
test('rejects a polygon point outside 0..1', () => {
  const r = v.validateSettings('demo', { zone: [[0, 0], [1.2, 0], [1, 1]], tables: [] });
  assert.equal(r.ok, false); assert.equal(r.errors[0].path, '/zone/1/0');
});
test('rejects duplicate ids in a polygon list', () => {
  const t = { id: 'T1', name: 'a', polygon: [[0, 0], [1, 0], [1, 1]] };
  assert.deepEqual(v.validateSettings('demo', { zone: t.polygon, tables: [t, t] }).errors.map(e => e.path), ['/tables/1/id']);
});
test('restrictedFields lists x-minRole properties', () => {
  assert.deepEqual(v.restrictedFields('demo'), [
    { path: '/model_name', minRole: 'SUPERADMIN' }, { path: '/tracker/lost_track_buffer', minRole: 'SUPERADMIN' }]);
});
test('withDefaults fills nested defaults and leaves its input alone', () => {
  const input = { zone: [[0, 0], [1, 0], [1, 1]], tables: [], tracker: {} };
  const out = v.withDefaults('demo', input);
  assert.equal(out.model_name, 'a.onnx'); assert.equal(out.tracker.lost_track_buffer, 30);
  assert.equal(input.model_name, undefined);
});
test('cameraId null is only allowed for the system use case', () => { /* demo ping with cameraId null → not ok */ });
test('rejects a metric name not in metrics.json', () => { /* metric "nope" → not ok */ });
test('rejects a schemaVersion other than the use case version', () => { /* schemaVersion 2 → not ok */ });
test('reports data errors under /data', () => { /* ping {n: "x"} → errors[0].path === '/data/n' */ });
```

`test/examples.test.mjs` checks the real registry:
- every `usecases/*/examples/messages/valid/*.json` → `ok: true`;
- every `invalid/*.json` → `ok: false`;
- the same for `examples/settings/{valid,invalid}` through `validateSettings`;
- every event type, interval kind and metric name has at least one valid message example.

System invalid examples:
- `engine_started` with a 31-character `bootId`;
- `time` without milliseconds;
- an extra top-level field;
- type `engine_exploded`.

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd packages/contracts && npm test`. Expected: FAIL with `Cannot find module '../src/index.js'`.

- [ ] **Step 4: Write the schemas, `src/index.js` and `scripts/generate.mjs`**

`generate.mjs` first deletes `generated/` and `services/engine/contracts/`, then:
1. **Schemas.** For every source schema, `$RefParser.bundle()` writes a self-contained copy to
   `generated/schemas/<same relative path, .schema.json → .json>`. It also copies `usecase.json` and
   `metrics.json`. JSON is written with 2-space indent, LF and a trailing newline.
2. **TypeScript.** `json-schema-to-typescript` `compile()` runs on the bundled files with
   `unreachableDefinitions: true` and a "Generated … do not edit" banner. It writes
   `generated/ts/<useCase>.d.ts` (settings, events and intervals together) and
   `generated/ts/envelope.d.ts`.
3. **Python.** Pin `datamodel-code-generator` to its current release in a constant and run, for each
   bundled file:
   `uvx --from datamodel-code-generator==<pin> datamodel-codegen --input <f> --input-file-type jsonschema --output <out> --output-model-type pydantic_v2.BaseModel --use-title-as-name --disable-timestamp --target-python-version 3.12 --custom-file-header "# Generated by packages/contracts/scripts/generate.mjs. Do not edit."`
   Outputs go to `services/engine/contracts/envelope.py` and
   `services/engine/contracts/<useCase>/{settings,events,intervals}.py`. The script then writes the
   `__init__.py` files and `registry.py`, importing classes by each `$def`'s `title`.

`loadRegistry` reads `generated/schemas`. `.gitattributes` gets
`packages/contracts/generated/** text eol=lf` and `services/engine/contracts/** text eol=lf`.

- [ ] **Step 5: Generate and run the tests**

Run: `npm run generate && npm test`. Expected: all pass.

- [ ] **Step 6: The engine can import the generated models**

`services/engine/tests/test_contracts_generated.py`:
```python
from contracts.registry import REGISTRY

def test_system_use_case_is_generated():
    started = REGISTRY["system"].events["engine_started"]
    assert started(bootId="0" * 32, engineGroup="default").engineGroup == "default"
    assert REGISTRY["system"].settings is None and REGISTRY["system"].schema_version == 1
```
Run: `cd services/engine && uv run pytest -q tests/test_contracts_generated.py && uv run ruff check .`
Expected: PASS. `services/engine/.dockerignore` must not exclude `contracts/`.

- [ ] **Step 7: CI and the stale check**

`.github/workflows/contracts.yml` runs on paths `packages/contracts/**`,
`services/engine/contracts/**` and its own file, on ubuntu-24.04:
- `actions/setup-node@v4` (Node 22, npm cache on `packages/contracts/package-lock.json`);
- `astral-sh/setup-uv@v6` (0.12.10);
- in `packages/contracts`: `npm ci`, `npm test`, `npm run check`.

Run locally: `git add -A packages/contracts services/engine/contracts .gitattributes && npm run check`.
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts services/engine/contracts services/engine/tests/test_contracts_generated.py .github/workflows/contracts.yml .gitattributes
git commit -m "feat(contracts): envelope, system use case, TS + Pydantic generation"
```

---

### Task 2: The five camera use case contracts

**Files:**
- Create: `packages/contracts/usecases/{cashier_presence,horse_riding,restaurant_counter,restaurant_table,vehicle_gate}/`
  holding `usecase.json`, `settings.schema.json`, `events.schema.json`, `intervals.schema.json`,
  `metrics.json`, `examples/messages/{valid,invalid}/*.json`, `examples/settings/{valid,invalid}/*.json`
- Create: `packages/contracts/test/usecases.test.mjs`
- Regenerate: `generated/**`, `services/engine/contracts/**`

**Interfaces:**
- Consumes: Task 1 folder layout, geometry `$defs`, `createValidator`.
- Produces: the settings below (all schemaVersion 1, `additionalProperties: false` at every level).
  S marks `x-minRole: SUPERADMIN`. A dash means optional with no default.

**Used by several use cases:**
- `model_name`: string `^[\w.-]+\.(onnx|pt|engine)$` (S).
- `imgsz`: integer 32–4096, or `[h, w]` of such integers (S).
- `confidence_threshold`: number 0.01–1.
- `nx_bookmark`: optional `{tag?, title?, duration_ms?: int 1000–600000}`.
- `DwellTime`: `{enabled: false, min_occupied_sec: 0.0, empty_debounce_sec: 15.0, alert_dwell_sec: 3600.0}`
  (numbers ≥ 0).
- `TableList` (`x-geometry: polygon-list`): items have
  - `id`, `polygon` (both required);
  - `name` (default `""`), `capacity` (int ≥ 1, default 4);
  - optional `confidence_threshold`, `min_occupied_sec`, `empty_debounce_sec`, `track_dwell_time`.

**cashier_presence** ("Cashier presence")
- Settings:
  - `model_name` `"yolo11s.onnx"` S, `imgsz` 640 S, `confidence_threshold` 0.22
  - `clerk_zone` Polygon (required), `visitor_zone` Polygon –
  - `absence_alert_timeout_sec` int ≥ 1, 10; `min_waiting_confirm_sec` int ≥ 0, 3
  - `visitor_waiting_alert_timeout_sec` int ≥ 1, 5; `debounce_alert_sec` int ≥ 0, 30
  - `nx_bookmark`
- Events: `cashier_unattended {absentSec: int ≥ 0}`, `customer_waiting {waitingSec: int ≥ 0}`.
- Intervals: `desk_unattended {}` (subjectId null).
- Metrics: `queue_length` (persons), `clerk_count` (persons).

**horse_riding** ("Pony riding")
- Settings:
  - `model_name` `"yolo11m.pt"` S, `imgsz` 640 S, `confidence_threshold` 0.35
  - `track_horses_only` true S
  - `track_activation_thresh` 0.25 S, `lost_track_buffer` int 60 S, `matching_thresh` 0.70 S,
    `frame_rate` int 1–60, 15 S, `smoothing_frames` int 4 S
  - `tripwire` `{enabled: false, start: Point, end: Point}` (`x-geometry: line`),
    defaults start `[0.20, 0.60]`, end `[0.80, 0.60]`
  - `roi_polygon` Polygon –
  - `display_label` `"Horse"`, `display_label_plural` –, `attraction_title` –
  - `show_boxes` true, `show_labels` true, `show_traces` true, `trace_length` int 45
  - `debounce_alert_sec` 15, `nx_bookmark`
- Events: `horse_crossing {direction: "DEPARTURE"|"RETURN", trackerId: int}`.
- Metrics: `active_horses` (horses).

**restaurant_counter** ("Restaurant occupancy")
- Settings:
  - `model_name` `"yolo11s.onnx"` S, `imgsz` 1920 S, `confidence_threshold` 0.20
  - `mode` `"area_occupancy"|"tripwire"`, default `"area_occupancy"`
  - `deduplication_enabled` true S, `iou_threshold` 0.45 S, `containment_threshold` 0.65 S
  - `tracking_enabled` true S, `lost_track_buffer` 30 S, `smoothing_frames` 5 S
  - `show_boxes` true, `show_labels` true
  - `dining_zone` Polygon –
  - `tripwire` Line, defaults start `[0.1, 0.5]`, end `[0.9, 0.5]`
  - `shadow_zone` `{enabled: false, start: [1.00, 0.48], end: [0.82, 0.17], confidence_threshold: 0.11}`
    (`x-geometry: line`)
  - `max_capacity` int 60, `warning_capacity` int 45, `smoothing_window_sec` 4.0,
    `debounce_alert_sec` int 60
  - `table_monitoring` – `{enabled: true, show_overlay: true, show_labels: true,
    show_summary_card: false, dwell_time: DwellTime, tables: TableList}`
  - `nx_bookmark`
- Events: `capacity_alert {occupancy: int, maxCapacity: int, warningCapacity: int, level: "full"|"near_limit"}`.
- Intervals: `table_session {tableName: string}` (subjectId = table id).
- Metrics: `occupancy` (persons), `occupied_tables` (tables).

**restaurant_table** ("Restaurant tables")
- Settings:
  - `model_name` `"yolo11s.onnx"` S, `imgsz` 1920 S, `confidence_threshold` 0.20
  - `deduplication_enabled` true S, `iou_threshold` 0.45 S, `containment_threshold` 0.65 S
  - `show_person_boxes` false, `show_person_labels` false
  - `show_overlay` true, `show_labels` true, `show_summary_card` true
  - `dwell_time` DwellTime
  - `tables` TableList (required, minItems 1)
  - `nx_bookmark`
- Events: none (`$defs: {}`).
- Intervals: `table_session {tableName: string}`.
- Metrics: `occupied_tables` (tables), `table_occupancy_pct` (percent).

**vehicle_gate** ("Vehicle gate")
- Settings:
  - `model_name` `"yolo26s.onnx"` S, `imgsz` 640 S, `confidence_threshold` 0.30
  - `tripwire` Line, defaults start `[0.760, 0.580]`, end `[0.050, 0.430]`
  - `roi_polygon` Polygon –
  - `track_activation_thresh` 0.25 S, `lost_track_buffer` 75 S, `matching_thresh` 0.70 S,
    `frame_rate` 15 S
  - `anpr` S `{enabled: true, model_path: "models/license_plate_detector.onnx", min_plate_confidence: 0.25}`
  - `nx_bookmark`
- Events: `vehicle_crossing {direction: "ENTRY"|"EXIT", vehicleType: string, plate: string,
  plateValid: boolean, ocrConfidence: number|null, trackerId: int}`.
- Intervals and metrics: none.

Settings examples:
- Valid: the settings each rule file in `services/engine/configs/rules/` means today, converted by
  hand (drop `rule_name`, `target_class(es)`, `vehicle_classes`, `entry_direction`,
  `departure_direction`, `anpr.regex_pattern`, `nx_bookmark.log_periodic_minutes`, the empty
  `roi_polygon`; the pipelines never read them).
- Invalid:
  - cashier `clerk_zone` with a point at 1.2;
  - cashier polygon with 2 points;
  - restaurant_table duplicate table id `T2`;
  - vehicle_gate unknown key `rule_name`;
  - restaurant_counter `mode: "foo"`.

- [ ] **Step 1: Write the failing test**

```js
// test/usecases.test.mjs
const v = createValidator();
test('the five camera use cases are assignable', () => {
  assert.deepEqual(v.assignableUseCases(), ['cashier_presence', 'horse_riding', 'restaurant_counter', 'restaurant_table', 'vehicle_gate']);
});
test('superadmin-only fields per use case', () => {
  const paths = uc => v.restrictedFields(uc).map(f => f.path).sort();
  assert.deepEqual(paths('cashier_presence'), ['/imgsz', '/model_name']);
  assert.deepEqual(paths('horse_riding'), ['/frame_rate', '/imgsz', '/lost_track_buffer', '/matching_thresh', '/model_name', '/smoothing_frames', '/track_activation_thresh', '/track_horses_only']);
  assert.deepEqual(paths('restaurant_counter'), ['/containment_threshold', '/deduplication_enabled', '/imgsz', '/iou_threshold', '/lost_track_buffer', '/model_name', '/smoothing_frames', '/tracking_enabled']);
  assert.deepEqual(paths('restaurant_table'), ['/containment_threshold', '/deduplication_enabled', '/imgsz', '/iou_threshold', '/model_name']);
  assert.deepEqual(paths('vehicle_gate'), ['/anpr', '/frame_rate', '/imgsz', '/lost_track_buffer', '/matching_thresh', '/model_name', '/track_activation_thresh']);
});
```
Task 1's `examples.test.mjs` covers the examples and requires one valid example per type, kind and
metric.

- [ ] **Step 2: Run to see it fail**

Run: `npm test`. Expected: FAIL (`assignableUseCases()` returns `[]`).

- [ ] **Step 3: Write the five use case folders, then `npm run generate`**

- [ ] **Step 4: Run all contract tests**

Run: `npm test && cd ../../services/engine && uv run pytest -q tests/test_contracts_generated.py`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts services/engine/contracts
git commit -m "feat(contracts): settings, events, intervals and metrics for the five use cases"
```

---

### Task 3: Engine messages, Redis sender and minute metrics

**Files:**
- Create: `services/engine/core/messages.py`, `core/event_stream.py`, `core/metrics.py`
- Modify: `services/engine/pyproject.toml` (add `redis>=5.0`), `uv.lock`
- Test: `services/engine/tests/test_messages.py`, `tests/test_event_stream.py`, `tests/test_metrics.py`

**Interfaces:**
- Consumes: `contracts.envelope.Message`, `contracts.registry.REGISTRY`.
- Produces, `core/messages.py`:
  ```python
  class ContractError(ValueError): ...
  def new_id(prefix: str) -> str                      # f"{prefix}_{uuid4().hex}"
  def iso_ms(epoch_ms: int) -> str                    # "2026-10-09T03:04:05.123Z"
  def event_message(camera_id: str | None, use_case: str, type: str, data: dict, severity: str = "info",
                    time_ms: int | None = None, snapshot_path: str | None = None, event_id: str | None = None) -> dict
  def interval_open_message(camera_id: str, use_case: str, kind: str, subject_id: str | None,
                            data: dict | None = None, time_ms: int | None = None, session_id: str | None = None) -> dict
  def interval_close_message(camera_id: str, use_case: str, kind: str, session_id: str, data: dict | None = None,
                             time_ms: int | None = None, end_reason: str = "ended") -> dict
  def metric_message(camera_id: str, use_case: str, name: str, minute_ms: int, value: float) -> dict
  def validate(message: dict) -> None                 # raises ContractError; same rules as validateMessage
  ```
  Builders don't validate. They convert numpy scalars to Python values (via `.item()`), default
  `time_ms` to the wall clock, take `schemaVersion` from `REGISTRY`, and set `configVersion: None`.
- Produces, `core/event_stream.py`:
  ```python
  class EventStream:
      def __init__(self, redis_url: str | None = None, *, client=None, stream: str = "events",
                   maxlen: int = 1_000_000, buffer_size: int = 10_000, engine_group: str = "default")
      def send(self, message: dict) -> None   # validate, then enqueue; never blocks or raises
      def stop(self, timeout: float = 5.0) -> None
      dropped_total: int
  ```
  - `send` logs a `ContractError` and drops the message.
  - A worker thread runs, oldest message first:
    `client.xadd(stream, {"msg": json.dumps(m, separators=(",", ":"))}, maxlen=maxlen, approximate=True)`.
  - On `redis.exceptions.ConnectionError`/`TimeoutError`: keep the message, back off 0.5 s doubling
    to 5 s, and log once per outage.
  - A full buffer drops the oldest message and counts it.
  - After the next successful XADD, if any drops are unreported, enqueue
    `events_dropped {engineGroup, count}` (`useCase` `system`, `cameraId` null) and log it.
  - `stop` flushes for up to `timeout`, then logs how many messages it left undelivered.
- Produces, `core/metrics.py`:
  ```python
  class MinuteMetrics:
      def __init__(self, on_minute: Callable[[str, int, float], None])   # (name, minute_ms, mean)
      def sample(self, name: str, value: float, now: float) -> None      # now = epoch seconds
      def flush(self) -> None
  ```
  It keeps one mean per name per UTC minute. A sample in a later minute emits the earlier minutes
  for that name. `flush` emits everything open, in name order.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_messages.py
CONTRACTS = ENGINE_DIR.parent.parent / "packages" / "contracts" / "usecases"

@pytest.mark.parametrize("path", sorted(CONTRACTS.glob("*/examples/messages/valid/*.json")), ids=lambda p: f"{p.parts[-5]}/{p.name}")
def test_valid_contract_examples_pass(path):
    validate(json.loads(path.read_text(encoding="utf-8")))

@pytest.mark.parametrize("path", sorted(CONTRACTS.glob("*/examples/messages/invalid/*.json")), ids=lambda p: f"{p.parts[-5]}/{p.name}")
def test_invalid_contract_examples_fail(path):
    with pytest.raises(ContractError):
        validate(json.loads(path.read_text(encoding="utf-8")))

def test_event_message_converts_numpy_scalars():
    m = event_message("cam_gate_entry_01", "vehicle_gate", "vehicle_crossing", {
        "direction": "ENTRY", "vehicleType": "car", "plate": "B 1234 XYZ", "plateValid": np.bool_(True),
        "ocrConfidence": np.float32(0.5), "trackerId": np.int64(7)}, time_ms=1_760_000_000_123)
    validate(m)
    assert json.loads(json.dumps(m))["data"]["trackerId"] == 7
    assert re.fullmatch(r"evt_[0-9a-f]{32}", m["id"]) and m["time"] == "2025-10-09T08:53:20.123Z"
    assert m["schemaVersion"] == 1 and m["configVersion"] is None

def test_unknown_type_and_bad_data_are_rejected():
    with pytest.raises(ContractError):
        validate(event_message("cam_x", "horse_riding", "horse_jump", {}))
    with pytest.raises(ContractError):
        validate(event_message("cam_x", "horse_riding", "horse_crossing", {"direction": "SIDEWAYS", "trackerId": 1}))

def test_metric_minute_must_be_whole():
    validate(metric_message("cam_x", "horse_riding", "active_horses", 120_000, 2.5))
    with pytest.raises(ContractError):
        validate(metric_message("cam_x", "horse_riding", "active_horses", 120_500, 2.5))
```

```python
# tests/test_event_stream.py: FakeRedis.xadd appends (name, fields, maxlen, approximate),
# or raises redis.exceptions.ConnectionError while .down is True; wait_until(cond, 2.0) polls.
def test_one_xadd_per_message_with_capped_length(): ...
    # entries[0] == ("events", {"msg": <json>}, 1_000_000, True); json.loads(...)["type"] == "engine_started"
def test_buffers_while_redis_is_down_and_keeps_order(): ...
    # down; send a, b, c; 0.2 s later nothing sent; up → delivered types == [a, b, c]
def test_full_buffer_drops_oldest_and_reports_the_count(): ...
    # buffer_size=2, engine_group="g1", down; send m1, m2, m3 → dropped_total == 1;
    # up → delivered == [m2, m3, events_dropped {"engineGroup": "g1", "count": 1}]
def test_send_never_blocks_while_redis_is_down(): ...
    # down; 1000 sends take < 0.5 s
def test_invalid_message_is_logged_and_never_sent(caplog): ...
    # send({"message": "event"}) raises nothing; no xadd; an ERROR record mentions the contract
```

```python
# tests/test_metrics.py
def test_mean_per_minute_is_emitted_when_the_minute_ends():
    out = []; mm = MinuteMetrics(lambda n, m, v: out.append((n, m, v)))
    mm.sample("occupancy", 2, 120.0); mm.sample("occupancy", 4, 150.5)
    assert out == []
    mm.sample("occupancy", 9, 180.0)
    assert out == [("occupancy", 120_000, 3.0)]

def test_flush_emits_the_open_minute_once():
    # after the previous samples: flush() → ("occupancy", 180_000, 9.0); a second flush adds nothing

def test_names_are_independent():
    # "a" and "b" sampled in the same minute; flush() → [("a", ...), ("b", ...)]
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd services/engine && uv run pytest -q tests/test_messages.py tests/test_event_stream.py tests/test_metrics.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'core.messages'`.

- [ ] **Step 3: Add `redis` (`uv add "redis>=5.0"`) and implement the three modules**

- [ ] **Step 4: Run the engine suite**

Run: `uv run pytest -q && uv run ruff check .`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add services/engine/core/messages.py services/engine/core/event_stream.py services/engine/core/metrics.py services/engine/tests services/engine/pyproject.toml services/engine/uv.lock
git commit -m "feat(engine): contract-checked messages, Redis stream sender, minute metrics"
```

---

### Task 4: Pipelines send events, intervals and metrics to Redis

**Files:**
- Modify: `services/engine/core/base_pipeline.py`, `core/table_manager.py` (add `TableSessions`),
  and `pipelines/{cashier_presence,horse_riding,restaurant,table_occupancy,vehicle_gate}_pipeline.py`
- Modify: `services/engine/main.py`, `test_video.py`, `configs/app_config.yaml.example`, `README.md`
- Modify: `docs/10_LOCAL_QUICKSTART.md`, `.github/workflows/engine.yml`
- Delete: `services/engine/core/analytics_dispatcher.py`
- Test: `tests/conftest.py`, `tests/test_pipeline_messages.py`, `tests/test_event_stream_redis.py`

**Interfaces:**
- Consumes: Task 3 builders, `EventStream`, `MinuteMetrics`.
- Produces, `BasePipeline`:
  - `events: Optional[EventStream] = None` replaces `analytics`. `recording_path` and
    `STATUS_INTERVAL_SEC` are removed: the camera row holds the recording path.
  - Class attribute `metric_fields: Dict[str, str] = {}` maps a status field to a metric name.
  - `emit(event_type: str, data: dict, severity: str = "info") -> None` keeps its signature. Inside
    `run()`, events still wait for the frame, and the snapshot path becomes the message's
    `snapshotPath` (not `data["snapshot"]`).
  - `open_interval(kind: str, subject_id: Optional[str] = None, data: Optional[dict] = None, time_ms: Optional[int] = None) -> str`
    returns the session id, even when `events` is None.
  - `close_interval(session_id: str, data: Optional[dict] = None, end_reason: str = "ended") -> None`.
    The kind is remembered from the open; an unknown id is a no-op.
  - `emit_status(data: dict) -> None` samples `metric_fields` on every call (no throttle) and
    skips `None` values. The other fields wait for Phase 2.
  - `shutdown() -> None` closes the open intervals with `end_reason="engine_stop"` and flushes the
    metrics.
- Produces, `core/table_manager.py`:
  `class TableSessions: __init__(self, pipeline: BasePipeline); on_change(self, data: dict) -> None`.
  `OCCUPIED` opens `table_session` (subject `tableId`, data `{tableName}`); `EMPTY` closes it.
  `RestaurantCounterPipeline` and `TableOccupancyPipeline` call it from `_handle_table_event`
  instead of `self.emit(...)`. Their Nx bookmark code is unchanged.
- `metric_fields` per pipeline:
  - cashier `{"visitorCount": "queue_length", "clerkCount": "clerk_count"}`
  - horse `{"activeHorses": "active_horses"}`
  - restaurant_counter `{"occupancy": "occupancy", "occupiedTables": "occupied_tables"}`
  - restaurant_table `{"occupiedTables": "occupied_tables", "occupancyRatePct": "table_occupancy_pct"}`
  - gate `{}`
- Cashier: when `absent_duration >= absence_timeout_sec` and no `desk_unattended` interval is open,
  open one with `time_ms = now_ms - absent_duration * 1000`. Close it when the clerk is present
  again. The alert events don't change.
- `main.py`:
  - Reads env `REDIS_URL`. If it is unset, nothing is sent and one warning says so.
  - Reads env `ENGINE_GROUP` (default `"default"`).
  - Sends `engine_started {bootId: uuid4().hex, engineGroup}` before starting the workers.
  - Saves snapshots whenever events are on. The `analytics:` section of `app_config.yaml` is no
    longer read.
  - On exit: join the workers, call `pipeline.shutdown()` on each pipeline, then `stream.stop()`.
- `test_video.py --analytics`: same wiring from `REDIS_URL`, with `shutdown()` and `stop()` at the
  end. Update its help text.

- [ ] **Step 1: Write the failing tests**

`conftest.py`:
- `FakeYOLO` gets a class attribute `boxes` (an N×6 tensor, default empty) that `__call__` returns.
- New fixture `stream`: a `RecordingStream` whose `send(msg)` calls `validate(msg)` and then
  appends to `.sent`, so every pipeline test also proves its messages meet the contract.
- The `desk_unattended` open goes at the top of the clerk-absent branch. It is sent immediately,
  while the alert event waits for the end of the frame, so the open always comes first.

```python
# tests/test_pipeline_messages.py
def table_change(status): return {"tableId": "T1", "tableName": "Table 1", "oldStatus": "", "status": status, "dwellSec": 0, "timestampMs": 1}

@pytest.mark.parametrize("rule_key", ["restaurant_table", "restaurant_counter"])
def test_table_state_changes_become_one_session(fake_yolo, stream, rule_key):
    p = create_pipeline(camera(rule_key, rule_key), NxClient(mock_mode=True), "cpu"); p.events = stream
    p._handle_table_event("table_state_change", table_change("OCCUPIED"), "info")
    p._handle_table_event("table_state_change", table_change("EMPTY"), "info")
    opened, closed = stream.sent
    assert (opened["message"], opened["kind"], opened["subjectId"], opened["data"]) == ("interval_open", "table_session", "T1", {"tableName": "Table 1"})
    assert (closed["message"], closed["sessionId"], closed["endReason"]) == ("interval_close", opened["sessionId"], "ended")

def test_cashier_desk_unattended_interval_and_alert_snapshot(fake_yolo, stream, tmp_path):
    # FakeYOLO.boxes = [[600, 480, 680, 600, 0.9, 0]] (inside clerk_zone on 1280x720) for the frame at ts 40_000,
    # empty for ts 41_000..50_000 (every 1000), the person again at 51_000; p.snapshots = SnapshotStore(tmp_path, retention_days=0).
    # Start at 40 s: the alert's 30 s debounce counts from stream time 0, and ts 0 would fall back to the wall clock.
    # At 50_000 the absence reaches 10 s → open + alert; at 51_000 → close.
    kinds = [(m["message"], m.get("kind") or m.get("type")) for m in stream.sent if m["message"] != "metric"]
    assert kinds == [("interval_open", "desk_unattended"), ("event", "cashier_unattended"), ("interval_close", "desk_unattended")]
    alert = next(m for m in stream.sent if m.get("type") == "cashier_unattended")
    assert (tmp_path / alert["snapshotPath"]).is_file()

def test_status_fields_become_minute_metrics(fake_yolo, stream):
    # restaurant_table pipeline, two frames, then p.shutdown()
    assert {m["name"] for m in stream.sent if m["message"] == "metric"} == {"occupied_tables", "table_occupancy_pct"}

def test_shutdown_closes_open_intervals(fake_yolo, stream):
    # open via table_change("OCCUPIED"), then p.shutdown() → last message is interval_close with endReason "engine_stop"

def test_no_table_state_change_events_remain(fake_yolo, stream):
    # after the OCCUPIED/EMPTY pair above, no message has message == "event"
```

```python
# tests/test_event_stream_redis.py
pytestmark = pytest.mark.skipif(not os.environ.get("REDIS_URL"), reason="needs REDIS_URL")

def test_messages_land_in_the_stream():
    name = f"events-test-{uuid.uuid4().hex}"
    s = EventStream(os.environ["REDIS_URL"], stream=name)
    s.send(event_message(None, "system", "engine_started", {"bootId": uuid.uuid4().hex, "engineGroup": "default"}))
    s.stop()
    r = redis.Redis.from_url(os.environ["REDIS_URL"])
    [(_, fields)] = r.xrange(name)
    validate(json.loads(fields[b"msg"])); r.delete(name)
```

- [ ] **Step 2: Run them to see them fail**

Run: `uv run pytest -q tests/test_pipeline_messages.py`.
Expected: FAIL (`BasePipeline` has no `events` / `open_interval`).

- [ ] **Step 3: Implement the changes listed under Interfaces, and delete `core/analytics_dispatcher.py`**

- [ ] **Step 4: CI gets a Redis service**

In `.github/workflows/engine.yml`:
- add `services: redis: {image: "redis:7.4.<patch>-alpine", ports: ["6379:6379"]}`;
- add job env `REDIS_URL: redis://localhost:6379/0`;
- add the paths `packages/contracts/usecases/**` and `services/engine/contracts/**`.

- [ ] **Step 5: Docs**

- `services/engine/README.md`: `REDIS_URL` and `ENGINE_GROUP`.
- `app_config.yaml.example`: remove `analytics:`, keep `snapshots:`.
- `docs/10_LOCAL_QUICKSTART.md`: start a local Redis
  (`docker run -d --name zoo-redis -p 6379:6379 redis:7.4.<patch>-alpine`), set `REDIS_URL`, and
  watch with `docker exec zoo-redis redis-cli XREVRANGE events + - COUNT 5`. State that the
  dashboard receives no events from Phase 1 until Phase 3, and that live preview still works.

- [ ] **Step 6: Run everything**

Run: `docker run -d --rm --name zoo-redis-test -p 6379:6379 redis:7.4.<patch>-alpine`, then
`REDIS_URL=redis://localhost:6379/0 uv run pytest -q && uv run ruff check .`, then
`docker stop zoo-redis-test`. Expected: all pass, and none of the Redis tests skipped.

- [ ] **Step 7: Commit**

```bash
git add -A services/engine docs/10_LOCAL_QUICKSTART.md .github/workflows/engine.yml
git commit -m "feat(engine): pipelines send events, intervals and minute metrics to the Redis stream"
```

---

### Task 5: NestJS API skeleton, Prisma schema, health and the e2e harness

**Files:**
- Create in `apps/api/`: `package.json`, `package-lock.json`, `tsconfig.json`,
  `tsconfig.build.json`, `nest-cli.json`, `eslint.config.mjs`, `.prettierrc`, `test/jest-e2e.json`,
  `Dockerfile`, `Dockerfile.dockerignore`, `README.md`, `prisma.config.ts`,
  `prisma/schema.prisma`, `prisma/migrations/<ts>_init/migration.sql`
- Create in `apps/api/src/`: `main.ts`, `bootstrap.ts`, `app.module.ts`, `config/env.ts`,
  `prisma/{prisma.module,prisma.service}.ts`, `redis/redis.module.ts`, `health/health.controller.ts`,
  `contracts/{contracts.module,contracts.service}.ts`
- Create in `apps/api/test/`: `setup/{global-setup,global-teardown,db}.ts`, `app.ts`,
  `health.e2e-spec.ts`
- Create: `.github/workflows/api.yml`
- Modify: root `.gitignore` (`apps/api/src/generated/`, `apps/api/dist/`, `node_modules/`)

**Interfaces:**
- Produces, env (validated at boot; on failure the app refuses to start and names each bad
  variable):
  - `DATABASE_URL` (`zoo_api`), `REDIS_URL`, `CAMERA_URL_KEY` (base64 that decodes to 32 bytes)
  - `COOKIE_SECURE` (`true|false`, default `true`), `SWAGGER` (`public|off`, default `off`)
  - `PORT` (default `3001`), `INGEST` (`on|off`, default `on`; used in Task 12)
  - `prisma.config.ts` uses `DATABASE_MIGRATE_URL` (`zoo_owner`) for the CLI.
- Produces, code:
  - `configureApp(app: INestApplication): void` in `bootstrap.ts`: cookie-parser, the prefix and
    versioning from Global Constraints, `ValidationPipe({whitelist: true, forbidNonWhitelisted: true, transform: true})`,
    shutdown hooks, and Swagger when `SWAGGER=public` (`addCookieAuth('zoo_session')`,
    `addBearerAuth()`).
  - `PrismaService extends PrismaClient`, built with `new PrismaPg({ connectionString: DATABASE_URL })`.
    Import the client from `src/generated/prisma/client`.
  - The `REDIS` injection token provides an ioredis `Redis` for commands; blocking readers call
    `.duplicate()`.
  - `ContractsService` exposes `validator` (from `createValidator()`) and `registry`.
    `"@zoo-vision/contracts": "file:../../packages/contracts"`.
- Produces, test helpers:
  - `createTestApp(env?: Record<string, string>): Promise<INestApplication>` (calls `configureApp`).
  - `resetDb(): Promise<void>` truncates every app table as `zoo_owner`.
  - `flushRedis(): Promise<void>`.
  - `ownerQuery(sql: string, ...params): Promise<unknown[]>`.
  - Global setup starts `postgres:17.<patch>-alpine` (user `zoo_owner`, db `zoo_vision`) and
    `redis:7.4.<patch>-alpine` with Testcontainers. It runs `prisma migrate deploy` as `zoo_owner`,
    then `CREATE ROLE zoo_api` if missing and `ALTER ROLE zoo_api LOGIN PASSWORD 'zoo_api'`, then
    sets `process.env`. Jest e2e uses `--runInBand`.
- Produces, `prisma/schema.prisma`: generator `prisma-client`, output `../src/generated/prisma`,
  `moduleFormat = "cjs"`. The datasource has `provider = "postgresql"` only; the URL lives in
  `prisma.config.ts`. Every `DateTime` is `@db.Timestamptz(3)`.

```prisma
enum Role { SUPERADMIN MANAGER USER }
enum SourceType { RTSP MEDIAMTX NX FILE }
enum StreamChoice { MAIN SUB }
enum LoginResult { SUCCESS WRONG_PASSWORD DISABLED LOCKED RATE_LIMITED LOGOUT }
enum Severity { info warning critical }

model User      { id String @id @default(uuid()) @db.Uuid; username String @unique; name String; passwordHash String
                  role Role; active Boolean @default(true); createdAt DateTime @default(now()); updatedAt DateTime @updatedAt
                  apiTokens ApiToken[] }
model ApiToken  { id String @id @default(uuid()) @db.Uuid; name String; prefix String; tokenHash String @unique; role Role
                  createdById String @db.Uuid; createdBy User @relation(fields: [createdById], references: [id])
                  createdAt DateTime @default(now()); lastUsedAt DateTime?; revokedAt DateTime? }
model AuditLog  { id BigInt @id @default(autoincrement()); time DateTime @default(now())
                  actorType String /* user|token */; actorId String; actorName String
                  action String; entity String; entityId String?; before Json?; after Json?; ip String?
                  @@index([entity, entityId, time]) @@index([time]) }
model LoginLog  { id BigInt @id @default(autoincrement()); time DateTime @default(now()); username String /* as typed */
                  userId String? @db.Uuid; result LoginResult; ip String?; userAgent String?  @@index([time]) }
model Camera    { id String @id /* slug */; name String; area String?; useCase String; enabled Boolean @default(true)
                  sourceType SourceType; mainStreamUrlEnc String; subStreamUrlEnc String?; recordingPath String?
                  targetFps Int @default(5); engineGroup String @default("default"); auditCamera Boolean @default(false)
                  recordingEnabled Boolean @default(true); recordingStream StreamChoice @default(MAIN)
                  retentionDays Int? /* null = site default */; clipBeforeSec Int @default(15); clipAfterSec Int @default(15)
                  nxCameraId String?; activeVersion Int; createdAt DateTime @default(now()); updatedAt DateTime @updatedAt
                  versions CameraConfigVersion[]; events Event[]; intervals Interval[]; metrics Metric[] }
model CameraConfigVersion { cameraId String; camera Camera @relation(fields: [cameraId], references: [id], onDelete: Cascade)
                  version Int; useCase String; settings Json; schemaVersion Int
                  authorType String; authorId String; authorName String; note String?; createdAt DateTime @default(now())
                  @@id([cameraId, version]) }
model Event     { id String @id /* evt_… */; time DateTime; cameraId String?; camera Camera? @relation(fields: [cameraId], references: [id], onDelete: Restrict)
                  useCase String; type String; severity Severity; configVersion Int?; schemaVersion Int
                  snapshotPath String?; data Json; ingestedAt DateTime @default(now())
                  @@index([cameraId, type, time]) @@index([time]) }
model Interval  { id String @id /* ses_… */; cameraId String; camera Camera @relation(fields: [cameraId], references: [id], onDelete: Restrict)
                  useCase String; kind String; subjectId String?; start DateTime; end DateTime?; endReason String?
                  configVersion Int?; schemaVersion Int; data Json  @@index([cameraId, kind, start]) }
model Metric    { cameraId String; camera Camera @relation(fields: [cameraId], references: [id], onDelete: Restrict)
                  useCase String; name String; minute DateTime; value Float  @@id([cameraId, name, minute]) }
model DeadEvent { id BigInt @id @default(autoincrement()); streamId String; payload String /* raw msg */
                  reason String; createdAt DateTime @default(now()) }
```
(Shown compressed; write it one field per line. Raw SQL must quote `"Interval"`, `"end"` and the
camelCase columns.)

- [ ] **Step 1: Scaffold**

Run `npx @nestjs/cli@11 new api --package-manager npm --skip-git` inside `apps/`, then add the
dependencies named in Tech Stack. Keep `prisma` in `dependencies`, not dev: the `api-migrate`
container runs it. Add `"postinstall": "prisma generate"`. Install the contracts package's runtime
deps with `cd packages/contracts && npm ci --omit=dev`.

- [ ] **Step 2: Write the failing e2e test**

```ts
// test/health.e2e-spec.ts
it('GET /api/health reports database and redis up', async () => {
  const res = await request(app.getHttpServer()).get('/api/health').expect(200);
  expect(res.body.status).toBe('ok');
  expect(Object.keys(res.body.info)).toEqual(expect.arrayContaining(['database', 'redis']));
});
it('refuses to start without a 32-byte CAMERA_URL_KEY', async () => {
  await expect(createTestApp({ CAMERA_URL_KEY: Buffer.alloc(16).toString('base64') })).rejects.toThrow(/CAMERA_URL_KEY/);
});
it('serves the OpenAPI document only when SWAGGER=public', async () => {
  const pub = await createTestApp({ SWAGGER: 'public' });
  const doc = (await request(pub.getHttpServer()).get('/api/docs-json').expect(200)).body;
  expect(Object.keys(doc.components.securitySchemes)).toEqual(expect.arrayContaining(['zoo_session', 'bearer']));
  await request(app.getHttpServer()).get('/api/docs-json').expect(404);   // app was built with SWAGGER=off
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd apps/api && npm run test:e2e`. Expected: FAIL (404 on `/api/health`, or the harness is
missing).

- [ ] **Step 4: Implement**

Write the schema and create the init migration:
`npx prisma migrate dev --name init --create-only` against a local `postgres:17.<patch>-alpine`
container, run as `zoo_owner`.

The health check (terminus) runs `SELECT 1` through Prisma and a Redis `PING`.

`Dockerfile`:
- build context is the repo root;
- multi-stage on `node:22-bookworm-slim`;
- copies `packages/contracts` and runs `npm ci --omit=dev` there;
- copies `apps/api` and runs `npm ci`, `prisma generate`, `npm run build`, then
  `npm prune --omit=dev`;
- the runtime stage has `packages/contracts`, `apps/api/{dist,node_modules,prisma,prisma.config.ts,package.json}`;
- `USER node`, `CMD ["node", "dist/main.js"]`.

- [ ] **Step 5: Run the tests, lint and the image build**

Run: `npm run lint && npm run build && npm test && npm run test:e2e`. Expected: all pass.
Run: `docker build -f apps/api/Dockerfile -t zoo-vision-api:dev .` from the repo root.
Expected: the build succeeds.

- [ ] **Step 6: CI**

`.github/workflows/api.yml` runs on paths `apps/api/**`, `packages/contracts/**` and its own file,
on ubuntu-24.04:
- setup-node 22 with an npm cache over both lockfiles;
- `npm ci --omit=dev` in `packages/contracts`;
- in `apps/api`: `npm ci`, `npm run lint`, `npm run build`, `npm test`, `npm run test:e2e`.

The runner's Docker serves Testcontainers.

- [ ] **Step 7: Commit**

```bash
git add apps/api .github/workflows/api.yml .gitignore
git commit -m "feat(api): NestJS skeleton, Prisma schema, health, Swagger, e2e harness"
```

---

### Task 6: Database roles and append-only tables

**Files:**
- Create: `apps/api/prisma/migrations/<ts>_db_roles/migration.sql`,
  `deploy/postgres/init/01-api-role.sh`
- Test: `apps/api/test/append-only.e2e-spec.ts`
- Modify: `apps/api/README.md` (rule: every migration that adds a table also adds its GRANTs)

**Interfaces:**
- Produces, the migration:
  1. Creates `zoo_api NOLOGIN` if missing.
  2. `GRANT USAGE ON SCHEMA public`.
  3. SELECT, INSERT, UPDATE, DELETE on `User`, `ApiToken`, `Camera`.
  4. SELECT, INSERT, DELETE on `CameraConfigVersion`.
  5. SELECT, INSERT on `Event`, `AuditLog`, `LoginLog`, `DeadEvent`, `Interval`, `Metric`.
  6. `UPDATE ("end", "endReason", "data") ON "Interval"` and `UPDATE ("value") ON "Metric"`.
  7. `USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public`.
- Produces, `01-api-role.sh`: `psql -v pw="$ZOO_API_DB_PASSWORD"` with heredoc
  `CREATE ROLE zoo_api LOGIN PASSWORD :'pw';`. It runs on the first Postgres start, before any
  migration.

- [ ] **Step 1: Write the failing test**

```ts
// The app's PrismaService connects as zoo_api.
it.each([
  'UPDATE "Event" SET "type" = \'x\'', 'DELETE FROM "Event"', 'TRUNCATE "Event"',
  'UPDATE "AuditLog" SET "action" = \'x\'', 'DELETE FROM "AuditLog"',
  'UPDATE "LoginLog" SET "username" = \'x\'', 'DELETE FROM "LoginLog"',
  'UPDATE "DeadEvent" SET "reason" = \'x\'',
  'UPDATE "Interval" SET "kind" = \'x\'', 'DELETE FROM "Interval"',
  'UPDATE "Metric" SET "name" = \'x\'', 'DELETE FROM "Metric"',
  'UPDATE "CameraConfigVersion" SET "note" = \'x\'',
])('zoo_api cannot run: %s', async (sql) => {
  await expect(prisma.$executeRawUnsafe(sql)).rejects.toThrow(/permission denied/);
});
it('zoo_api can close an interval and overwrite a metric value', async () => {
  // seed one camera, one open interval and one metric with ownerQuery, then as zoo_api:
  // UPDATE "Interval" SET "end" = now(), "endReason" = 'ended', "data" = "data" || '{}'::jsonb → 1 row
  // UPDATE "Metric" SET "value" = 2 → 1 row
});
it('every application table grants SELECT to zoo_api', async () => {
  // information_schema.tables in public minus _prisma_migrations, each with has_table_privilege('zoo_api', t, 'SELECT')
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npm run test:e2e -- append-only`. Expected: the `it.each` cases already pass, because
`zoo_api` has no rights yet. The close/overwrite test and the SELECT-grant test FAIL with
`permission denied`.

- [ ] **Step 3: Write the migration and the init script**

- [ ] **Step 4: Run the whole e2e suite**

Run: `npm run test:e2e`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/migrations apps/api/test deploy/postgres apps/api/README.md
git commit -m "feat(api): zoo_api role with append-only analytics, audit and login tables"
```

---

### Task 7: Login, sessions, login history and role guards

**Files:**
- Create in `apps/api/src/auth/`: `auth.module.ts`, `auth.controller.ts`, `auth.service.ts`,
  `session.service.ts`, `session-ttl.ts`, `password.ts`, `lockout.service.ts`, `local.strategy.ts`,
  `local-auth.guard.ts`, `auth.guard.ts`, `roles.guard.ts`, `login-throttler.guard.ts`,
  `decorators.ts`, `actor.ts`
- Create: `apps/api/src/cli.ts`, `apps/api/test/helpers/auth.ts`
- Test: `src/auth/session-ttl.spec.ts`, `src/auth/actor.spec.ts`, `test/auth.e2e-spec.ts`

**Interfaces:**
- Produces, types and decorators:
  - `type Actor = { type: 'user' | 'token'; id: string; name: string; role: Role }`, set on
    `req.actor`.
  - `roleAtLeast(role: Role, min: Role): boolean`.
  - `@Public()`, `@MinRole(role)`, `@CurrentActor()`. A route that is not public and has no
    `@MinRole` needs any logged-in actor.
- Produces, services:
  - `SessionService`:
    - `create(userId, meta: {ip?: string; userAgent?: string}): Promise<string>` returns the raw
      token (32 random bytes, base64url).
    - `resolve(token): Promise<{userId: string} | null>` applies the sliding TTL.
    - `destroy(token): Promise<void>`.
    - `revokeAllForUser(userId: string, exceptToken?: string): Promise<void>`.
    - Keys: `sess:{sha256hex(token)}` holds `{userId, createdAt}`; `usess:{userId}` is a set of
      hashes.
  - `sessionTtlMs(createdAtMs: number, nowMs: number): number` returns
    `min(12 h, createdAt + 7 d − now)`; `≤ 0` means expired.
  - `hashPassword(plain): Promise<string>` (bcrypt 12), `verifyPassword(plain, hash): Promise<boolean>`,
    and `DUMMY_HASH`, compared against for unknown users so their timing matches.
  - `LockoutService`:
    - `lockedForSec(username): Promise<number>`, `recordFailure(username): Promise<void>`,
      `reset(username): Promise<void>`.
    - Key `loginfail:{lowercased username}`: INCR with a 15 min EXPIRE set on the first failure.
      A value ≥ 5 means locked until the key expires.
- Produces, endpoints (`@SkipAudit()` is added to them in Task 8):
  - `POST /api/v1/auth/login {username, password}`:
    - 200 `{id, username, name, role}` and cookie
      `zoo_session` (httpOnly, `SameSite=Lax`, `Path=/`, `Secure` = `COOKIE_SECURE`, max-age 7 d).
    - 401 `Invalid username or password` (wrong password or unknown user).
    - 403 `Account disabled`.
    - 423 `Account locked. Try again in N minutes.`
    - 429 from `LoginThrottlerGuard` (10/min per IP).
    - Each outcome writes one `LoginLog` row with the result, the typed username, the userId when
      the user matched, the IP and the user agent.
    - Usernames are trimmed and lowercased for lookup and lockout.
  - `POST /api/v1/auth/logout` → 204: deletes the session, clears the cookie, writes `LOGOUT`.
  - `GET /api/v1/auth/me` → the `Actor`.
- `AuthGuard` (APP_GUARD): a public route passes. Otherwise the cookie → session → user is read
  from Postgres each request. An inactive user gets the session destroyed and a 401. A missing or
  invalid cookie is a 401. Bearer tokens arrive in Task 9.
- `RolesGuard` (APP_GUARD, after `AuthGuard`) applies `@MinRole`.
- CLI: `node dist/cli.js create-superadmin --username <u> --name <n>`. It reads the password from
  env `ZOO_ADMIN_PASSWORD` (at least 10 characters), exits 1 if the username exists, and prints the
  new user's id. npm script `cli`.
- Test helpers:
  - `seedUser(app, role, opts?: {username?, password?, active?}): Promise<{id, username, password}>`;
  - `login(app, username, password): Promise<string>` returns the `Cookie` header value;
  - `asRole(app, role): Promise<{cookie: string; user}>`.

- [ ] **Step 1: Write the failing tests**

Unit tests:
- `sessionTtlMs(0, 0) === 12 * 3600e3`;
- `sessionTtlMs(0, 7 * 86400e3 - 3600e3) === 3600e3`;
- `sessionTtlMs(0, 7 * 86400e3) <= 0`;
- `roleAtLeast` across all 9 pairs.

`test/auth.e2e-spec.ts` (each ends by reading the newest `LoginLog` row):
- `login sets an httpOnly SameSite=Lax zoo_session cookie and logs SUCCESS with the user id`
- `GET /auth/me returns the actor with the cookie and 401 without it`
- `wrong password → 401, WRONG_PASSWORD with userId; unknown user → 401, WRONG_PASSWORD with userId null`
- `disabled user → 403, DISABLED`
- `five wrong passwords lock the account: the right password then gets 423 and LOCKED`
- `the eleventh attempt in a minute from one IP gets 429 and RATE_LIMITED` (use different usernames
  so the lockout stays out of the way)
- `logout → 204, LOGOUT row, and the old cookie gets 401`
- `deactivating a logged-in user (UPDATE through Prisma) makes their next request 401`
- `create-superadmin CLI creates a SUPERADMIN who can log in` (call the exported command function,
  not a subprocess)

- [ ] **Step 2: Run to see them fail**

Run: `npm test -- auth && npm run test:e2e -- auth`. Expected: FAIL (404 on `/api/v1/auth/login`).

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run**

Run: `npm run lint && npm test && npm run test:e2e`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): cookie sessions in Redis, login history, lockout, role guards"
```

---

### Task 8: Users and the audit log

**Files:**
- Create: `apps/api/src/users/{users.module,users.controller,users.service}.ts`, `src/users/dto/*.ts`
- Create: `apps/api/src/audit/{audit.module,audit.service,audit.interceptor,audit-context,redact}.ts`
- Modify: `apps/api/src/auth/auth.controller.ts` (add `@SkipAudit()` and `PUT /auth/password`)
- Test: `src/audit/redact.spec.ts`, `src/audit/audit.interceptor.spec.ts`,
  `test/users.e2e-spec.ts`, `test/audit.e2e-spec.ts`

**Interfaces:**
- Consumes: `Actor`, `MinRole`, `SessionService.revokeAllForUser`, `hashPassword`.
- Produces, audit:
  - `setAudit(req: Request, entry: {action: string; entity: string; entityId?: string; before?: unknown; after?: unknown}): void`.
  - `@SkipAudit()`.
  - `AuditInterceptor` (APP_INTERCEPTOR):
    - Applies to POST/PUT/PATCH/DELETE without `@SkipAudit()`.
    - Only after the handler succeeds, it writes one `AuditLog` row from `req.actor`, `req.ip` and
      the entry.
    - With no entry: `action = "<METHOD> <route path>"`, and `entity` = the first path segment
      after `/api/v1/`.
    - It passes `before`/`after` through `redactSecrets`.
  - `redactSecrets(value: unknown): unknown` deep-clones the value. Every key named `password`,
    `passwordHash`, `currentPassword`, `newPassword`, `token`, `tokenHash`, `mainStreamUrl`,
    `subStreamUrl`, `mainStreamUrlEnc` or `subStreamUrlEnc` gets the value `"[redacted]"`.
- Produces, `UserDto {id, username, name, role, active, createdAt}`. It never has `passwordHash`.
- Produces, endpoints (MANAGER+ unless noted):
  - `GET /api/v1/users`: a manager sees USER and MANAGER accounts; a superadmin sees all.
  - `POST /api/v1/users {username ^[a-z0-9._-]{3,32}$, name 1–100, password ≥ 10, role}` → 201
    `UserDto`. A manager can create only USER/MANAGER (else 403). A duplicate username gets 409.
    Audit `user.create`.
  - `PATCH /api/v1/users/:id {name?, role?, active?, password?}` → `UserDto`. A manager can't touch
    a SUPERADMIN account or grant SUPERADMIN (403). Setting `active: false` or a password revokes
    all of that user's sessions. Deactivating or demoting the last active SUPERADMIN gets 409.
    Audit `user.update`; `after` adds `passwordChanged: true` when a password was set.
  - `PUT /api/v1/auth/password {currentPassword, newPassword}` (session users; a token actor gets
    403) → 204. A wrong current password gets 400. It revokes the user's other sessions. Audit
    `user.password`.

- [ ] **Step 1: Write the failing tests**

- `redact.spec`: nested and array occurrences are replaced, other keys are kept, the input is
  unchanged.
- `audit.interceptor.spec`: with a fake `ExecutionContext` for `POST /api/v1/things`, a handler that
  sets no entry still leads to `AuditService.record` being called with
  `{action: 'POST /api/v1/things', entity: 'things'}`; a GET leads to no call; a handler that
  throws leads to no call.

`users.e2e-spec.ts`:
- `USER gets 403 on GET and POST /users`
- `MANAGER creates USER and MANAGER; 403 for role SUPERADMIN; 403 on PATCH of a superadmin`
- `MANAGER's list has no superadmins; SUPERADMIN's list has everyone`
- `deactivating a logged-in user ends their session on the next request`
- `the only superadmin cannot deactivate or demote themselves (409); with a second superadmin both work`
- `password change: wrong current → 400; right → 204; old password fails login; other sessions 401; current session still 200`

`audit.e2e-spec.ts`:
- `creating a user writes user.create with after = UserDto`. Also assert that
  `JSON.stringify(row)` matches neither `/passwordHash/` nor `/\$2[aby]\$/` nor the plain password.
- `a 403 POST /users by a USER writes no audit row`
- `login and logout write no audit row`

- [ ] **Step 2: Run to see them fail**

Run: `npm test -- audit && npm run test:e2e -- users audit`. Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run**

Run: `npm run lint && npm test && npm run test:e2e`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): users with role rules, audit interceptor with secret redaction"
```

---

### Task 9: API tokens and Bearer auth

**Files:**
- Create: `apps/api/src/api-tokens/{api-tokens.module,api-tokens.controller,api-tokens.service}.ts`,
  `src/api-tokens/dto/*.ts`
- Modify: `apps/api/src/auth/auth.guard.ts`
- Test: `apps/api/test/api-tokens.e2e-spec.ts`

**Interfaces:**
- Consumes: `Actor`, `setAudit`.
- Produces, tokens:
  - Format `zv_` + 32 random bytes as base64url.
  - Stored as `tokenHash = sha256 hex`, with `prefix` = the first 8 characters after `zv_`.
  - `ApiTokensService.resolve(raw: string): Promise<Actor | null>` returns null if the token is
    revoked or unknown. It sets `lastUsedAt` when that is empty or older than 60 s.
- Produces, endpoints (all SUPERADMIN):
  - `POST /api/v1/api-tokens {name 1–100, role}` → 201 `{id, name, role, prefix, createdAt, token}`.
    This is the only response that ever carries `token`. Audit `api_token.create` with after
    `{id, name, role, prefix}`.
  - `GET /api/v1/api-tokens` → `[{id, name, role, prefix, createdBy: username, createdAt, lastUsedAt, revokedAt}]`.
  - `DELETE /api/v1/api-tokens/:id` → 204. It sets `revokedAt` and is idempotent. Audit
    `api_token.revoke`.
- `AuthGuard`: if an `Authorization` header is present, it decides alone. `Bearer zv_…` that
  resolves → `Actor {type: 'token'}`. Anything else is a 401, even with a valid cookie. Without the
  header, the cookie applies as before.

- [ ] **Step 1: Write the failing tests**

`api-tokens.e2e-spec.ts`:
- `a created token authenticates GET /auth/me as {type: 'token', role}`
- `a USER-role token gets 403 on POST /users`
- `a revoked token gets 401 on its next request`
- `the list and every audit row never contain the raw token or its hash`: search
  `JSON.stringify(rows)` for both.
- `MANAGER gets 403 on all three endpoints`
- `"Bearer abc" gets 401 even with a valid session cookie`
- `lastUsedAt is set after the token is used`
- `PUT /auth/password with a token gets 403`

- [ ] **Step 2: Run to see them fail**

Run: `npm run test:e2e -- api-tokens`. Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run**

Run: `npm run lint && npm test && npm run test:e2e`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): hashed API tokens with roles, Bearer auth and revocation"
```

---

### Task 10: Cameras

**Files:**
- Create: `apps/api/src/cameras/{cameras.module,cameras.controller,cameras.service,camera-view,url-cipher,config-notifier}.ts`,
  `src/cameras/dto/*.ts`
- Test: `src/cameras/url-cipher.spec.ts`, `src/cameras/camera-view.spec.ts`,
  `test/cameras.e2e-spec.ts`, `test/helpers/settings.ts` (loads
  `packages/contracts/usecases/<uc>/examples/settings/valid/*.json`)

**Interfaces:**
- Consumes: `ContractsService.validator`, `setAudit`, `MinRole`, `REDIS`.
- Produces:
  - `UrlCipher` (key from `CAMERA_URL_KEY`; the constructor throws unless it is 32 bytes):
    - `encrypt(plain: string): string` uses AES-256-GCM with a random 12-byte IV and produces
      `v1.<iv>.<tag>.<ciphertext>` (base64url parts).
    - `decrypt(stored: string): string` throws on tampering.
  - `toCameraView(camera: Camera, role: Role, cipher: UrlCipher): CameraView`:
    - USER: `{id, name, area, useCase, enabled, activeVersion}`.
    - MANAGER adds `{sourceType, recordingPath, targetFps, engineGroup, auditCamera, nxCameraId,
      recording: {enabled, stream, retentionDays, clipBeforeSec, clipAfterSec}, createdAt, updatedAt}`.
    - SUPERADMIN adds `{mainStreamUrl, subStreamUrl}`, decrypted.
  - `ConfigNotifier.notify(cameraId: string, version: number | null): Promise<void>` runs
    `PUBLISH cfg:changed {"cameraId", "version"}` after the commit.
- Produces, endpoints:
  - `GET /api/v1/cameras` (any role) → `CameraView[]` sorted by id.
  - `GET /api/v1/cameras/:id` → 200 or 404.
  - `POST /api/v1/cameras` (SUPERADMIN), body:
    - `id ^[a-z][a-z0-9_]{2,63}$`, `name`, `area?`, `useCase`, `enabled?`, `sourceType`;
    - `mainStreamUrl` (`^rtsps?://` unless `sourceType` is `FILE`), `subStreamUrl?`,
      `recordingPath?`, `targetFps?` 1–30, `engineGroup? ^[a-z0-9_-]{1,32}$`, `auditCamera?`;
    - `recording? {enabled?, stream?, retentionDays? 1–3650 | null, clipBeforeSec? 0–300, clipAfterSec? 0–300}`;
    - `nxCameraId?`, `settings`, `note?`.

    Outcomes: 201 creates the camera and version 1 in one transaction; 400 for a use case that is
    unknown or not assignable, or for settings that fail validation (body
    `{message, errors: [{path, message}]}`); 409 when the id exists. It then calls
    `notify(id, 1)`. Audit `camera.create`.
  - `PATCH /api/v1/cameras/:id`: any create field except `id`, `useCase`, `settings`, `note`.
    - MANAGER+ may change `name`, `area`, `enabled`.
    - Any other field whose value actually changes (URLs compared decrypted) needs SUPERADMIN, else
      403 `{message, fields: [...]}`.
    - Then `notify(id, activeVersion)`. Audit `camera.update`.
  - `DELETE /api/v1/cameras/:id` (SUPERADMIN):
    - 409 `Camera has analytics data; disable it instead` when any Event, Interval or Metric
      references it;
    - otherwise 204, deleting the camera and its versions, then `notify(id, null)`;
    - audit `camera.delete`.
  - Audit `before`/`after` are SUPERADMIN views with both URLs set to `"[redacted]"`. On update,
    `after` adds `streamUrlsChanged: boolean`.

- [ ] **Step 1: Write the failing tests**

Unit tests:
- the cipher round-trips;
- two encryptions of the same URL differ;
- flipping one ciphertext byte makes `decrypt` throw;
- a 16-byte key makes the constructor throw;
- `toCameraView` keys per role (exact key lists, and URLs only for SUPERADMIN).

`cameras.e2e-spec.ts`:
- `SUPERADMIN creates a cashier camera with the valid example settings → 201; the stored row contains no "rtsp://" and not the password`
- `GET as MANAGER has no stream URLs; as SUPERADMIN shows them decrypted; as USER has no recording block`
- `settings with clerk_zone point 1.2 → 400 with errors[0].path "/clerk_zone/0/0"`
- `useCase "system" or "nope" → 400`
- `duplicate id → 409`
- `MANAGER PATCH {name} → 200; {targetFps: 12} → 403 with fields ["targetFps"]; {name, targetFps: <unchanged>} → 200`
- `USER PATCH → 403; MANAGER POST → 403`
- `create publishes cfg:changed {"cameraId":"cam_test_01","version":1}` (subscribe on a separate
  connection first)
- `DELETE with an Event row → 409; without → 204 and no versions left`
- `no audit row for cameras contains the plain URL`

- [ ] **Step 2: Run to see them fail**

Run: `npm test -- cameras && npm run test:e2e -- cameras`. Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run**

Run: `npm run lint && npm test && npm run test:e2e`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): cameras with encrypted stream URLs, role-filtered views and field rules"
```

---

### Task 11: Camera config versions, rollback and field-level roles

**Files:**
- Create: `apps/api/src/cameras/{camera-config.controller,config-versions.service,json-diff,restricted-changes}.ts`
- Test: `src/cameras/json-diff.spec.ts`, `src/cameras/restricted-changes.spec.ts`,
  `test/camera-config.e2e-spec.ts`

**Interfaces:**
- Consumes: `validator.validateSettings`, `withDefaults`, `restrictedFields`, `ConfigNotifier`,
  `setAudit`, `roleAtLeast`.
- Produces:
  - `diffJson(before: unknown, after: unknown): {path: string; before?: unknown; after?: unknown}[]`.
    It recurses through plain objects and compares arrays and scalars as whole values (deep
    equality). Paths are JSON pointers, sorted. A side that is missing is omitted.
  - `restrictedChanges(validator, useCase: string, before: object | null, after: object, role: Role): string[]`
    returns the restricted paths whose values differ between `withDefaults(before)` and
    `withDefaults(after)` when the role is below that field's `minRole`.
- Produces, endpoints:
  - `GET /api/v1/cameras/:id/config` (any role) →
    `{version, useCase, schemaVersion, settings, note, createdAt, author: {type, name}}` for the
    active version.
  - `GET /api/v1/cameras/:id/config/versions` (MANAGER+) → newest first, without `settings`.
  - `GET /api/v1/cameras/:id/config/versions/:version` (MANAGER+) → the full version plus `changes`
    (`diffJson` against the previous version; a `/useCase` entry if the use case changed; `[]` for
    version 1).
  - `POST /api/v1/cameras/:id/config` (MANAGER+) `{baseVersion: int, useCase?: string, settings: object, note?: ≤ 500}`
    → 201 `{version}`. In order:
    1. 409 if `baseVersion` ≠ `activeVersion` (the message names the current version).
    2. A `useCase` change needs SUPERADMIN (403).
    3. 400 for invalid settings.
    4. 403 `{message: "Only a superadmin can change: <paths>", fields}` if `restrictedChanges` is
       not empty.
    5. In one transaction: insert version `activeVersion + 1` and update `Camera.activeVersion` and
       `Camera.useCase`. A primary-key collision becomes 409.
    6. Audit `camera_config.save` with before and after `{version, useCase, settings}`.
    7. `notify`.

    Settings are stored as sent; defaults are not filled in.
  - `POST /api/v1/cameras/:id/config/rollback` (MANAGER+) `{baseVersion, version}` saves that
    version's `useCase` + `settings` through the same path, with note `rollback to v<N>`. An unknown
    version gets 404. Audit `camera_config.rollback`.

- [ ] **Step 1: Write the failing tests**

Unit tests:
- `diffJson`:
  - a nested change → `/tripwire/start`;
  - an array change → the whole array path `/clerk_zone`;
  - an added key has only `after`; a removed key has only `before`.
- `restrictedChanges`:
  - a manager changing `/model_name` → `["/model_name"]`;
  - a manager adding `model_name` equal to its default → `[]`;
  - a superadmin → `[]`;
  - a manager changing `confidence_threshold` → `[]`.

`camera-config.e2e-spec.ts`:
- `MANAGER saves a moved clerk_zone with baseVersion 1 → 201 {version: 2}; GET config returns v2; cfg:changed version 2`
- `a stale baseVersion → 409 and no version 3`
- `two saves with the same baseVersion at once (Promise.all) → one 201 and one 409`
- `MANAGER changing model_name → 403 fields ["/model_name"]; SUPERADMIN → 201`
- `MANAGER changing useCase → 403; SUPERADMIN to vehicle_gate with valid gate settings → 201 and the camera's useCase is vehicle_gate`
- `invalid settings → 400 with paths`
- `rollback to v1 creates v3 equal to v1 with note "rollback to v1"; a MANAGER rollback across a model_name change → 403`
- `versions list is newest first; version 2's changes contain "/clerk_zone"`
- `audit row camera_config.save has before.version 1 and after.version 2`

- [ ] **Step 2: Run to see them fail**

Run: `npm test -- json-diff restricted && npm run test:e2e -- camera-config`. Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run**

Run: `npm run lint && npm test && npm run test:e2e`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): versioned camera configs with optimistic concurrency, rollback and x-minRole"
```

---

### Task 12: EventsConsumer: the stream into Postgres

**Files:**
- Create: `apps/api/src/ingest/{ingest.module,events-consumer.service,ingest.service}.ts`
- Test: `src/ingest/ingest.service.spec.ts`, `test/ingest.e2e-spec.ts`, `test/helpers/messages.ts`

**Interfaces:**
- Consumes: `validator.validateMessage`, `PrismaService`, `REDIS`.
- Produces, `EventsConsumer` (starts on bootstrap when `INGEST=on`, stops on shutdown):
  - It uses its own `redis.duplicate()` connection.
  - It runs `XGROUP CREATE events api 0 MKSTREAM` and ignores `BUSYGROUP`.
  - Each loop:
    1. `XREADGROUP GROUP api api-1 COUNT 100 STREAMS events 0` (its own pending entries).
    2. If that returns nothing: `… COUNT 100 BLOCK 5000 STREAMS events >`.
    3. Pass the entries to `processBatch`.
  - When `processBatch` throws, it backs off 1 s, doubling to 30 s, and resets after a success.
- Produces, `IngestService.processBatch(entries: {id: string; msg: string | undefined}[]): Promise<void>`:
  1. Parse each entry and run `validateMessage`. Look up the cameras with one query
     (`id = ANY(...)`). Invalid JSON, a failed validation or an unknown camera → that entry gets a
     `DeadEvent {streamId, payload, reason}`.
  2. In one transaction, in stream order: insert the dead events and apply the valid messages.
     Commit, then `XACK` every id of the batch.
  3. If the transaction throws, probe Postgres with `SELECT 1`.
     - The probe fails → rethrow. Nothing is acked, counted or dead-lettered.
     - The probe succeeds → run each entry in its own transaction. A success is acked (and its
       `ingest:failures` field removed). A failure runs `HINCRBY ingest:failures <id> 1`; at 5 the
       entry becomes a `DeadEvent` (reason = the error message) and is acked and removed from the
       hash.
  4. Every dead-lettered entry also logs one warning with the stream id and the reason.
- Apply rules (raw SQL where Prisma can't express it; quote identifiers):
  - `event`:
    - `INSERT … ON CONFLICT ("id") DO NOTHING`.
    - Only when that insert added a row and the event is `system`/`engine_started`:
      `UPDATE "Interval" SET "end" = <event time>, "endReason" = 'engine_restart' WHERE "end" IS NULL AND "useCase" <> 'system' AND "cameraId" IN (SELECT "id" FROM "Camera" WHERE "engineGroup" = <data.engineGroup>)`.
  - `interval_open`: insert with `start = time`, `ON CONFLICT ("id") DO NOTHING`.
  - `interval_close`:
    `UPDATE "Interval" SET "end" = time, "endReason" = endReason, "data" = "data" || <data>::jsonb WHERE "id" = sessionId AND "end" IS NULL`.
    If no row changed and none exists → `DeadEvent` `close for unknown interval`. If no row changed
    and the row is already closed → no-op.
  - `metric`:
    `INSERT … ON CONFLICT ("cameraId", "name", "minute") DO UPDATE SET "value" = EXCLUDED."value"`.
- Test helpers: `eventMsg(over)`, `openMsg(over)`, `closeMsg(over)`, `metricMsg(over)`,
  `engineStarted(group, timeIso?)`. Each asserts `validateMessage(...).ok`, so the tests only use
  valid fixtures. `xadd(msg | string)` writes to `events`.

- [ ] **Step 1: Write the failing tests**

`ingest.service.spec.ts` (Prisma and Redis mocked):
- `when the batch transaction fails and SELECT 1 fails, it rethrows and calls neither XACK, HINCRBY nor DeadEvent insert`
- `when one entry keeps failing with the database up, it is dead-lettered on the fifth batch and acked; the others are acked on the first`

`ingest.e2e-spec.ts` (app with `INGEST=on`; poll with `waitFor`):
- `an event lands once when the same message is XADDed twice`
- `processBatch twice with the same entries leaves one Event, one Interval and the metric value unchanged`
- `pending entries are processed on start`:
  1. With an `INGEST=off` app: create the group, XADD, and read the entry with
     `XREADGROUP GROUP api api-1 … >` without acking.
  2. Start an `INGEST=on` app.
  3. Expect the row to appear and `XPENDING events api` to report 0.
- `invalid JSON, unknown use case, bad data and unknown camera each become one DeadEvent with a reason; a valid message XADDed after them still lands`
- `interval open then close sets end and endReason, and merges data`
- `close for an unknown session → DeadEvent; closing twice changes nothing`
- `metric for the same minute twice keeps the last value`
- `engine_started {engineGroup: "default"}`:
  - closes camera A's open interval (group default) with `engine_restart` and `end` = the event
    time;
  - leaves camera B's (group g2) open;
  - leaves A's interval opened after it open.
- `a redelivered engine_started does not close intervals opened after it`: processBatch
  `[started, openNew]`, then `[started]` again; `openNew` is still open.

- [ ] **Step 2: Run to see them fail**

Run: `npm test -- ingest && npm run test:e2e -- ingest`. Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run**

Run: `npm run lint && npm test && npm run test:e2e`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): EventsConsumer with idempotent ingest, dead-lettering and engine restart handling"
```

---

### Task 13: One-off import of `cameras.yaml` + rules

**Files:**
- Create: `tools/import_yaml_config.py`, `tools/tests/test_import_yaml_config.py`
- Modify: `tools/README.md`, `.github/workflows/repo.yml`

**Interfaces:**
- Consumes:
  - the bundled schemas `packages/contracts/generated/schemas/<uc>/settings.json`;
  - `POST /api/v1/cameras` (Task 10);
  - the engine's YAML layout.
- Produces, the script:
  - It has a PEP 723 header with deps `pyyaml>=6` and `requests>=2.31`.
  - Run it as `uv run tools/import_yaml_config.py --cameras services/engine/configs/cameras.yaml`,
    with `[--engine-dir services/engine] [--contracts-dir packages/contracts/generated/schemas] [--api http://127.0.0.1:3001] [--dry-run]`.
  - The token comes from env `ZOO_API_TOKEN` (a SUPERADMIN API token); `--dry-run` doesn't need
    it.
- Produces, pure functions:
  ```python
  def normalize_use_case(pipeline: str) -> str            # main.create_pipeline's aliases; ValueError if unknown
  def effective_rules(cam: dict, engine_dir: Path) -> dict  # rule file, then inline `rules`, then inline `roi`,
                                                          # exactly as BasePipeline.__init__ / _apply_inline_roi
  def to_settings(use_case: str, rules: dict, schema: dict) -> tuple[dict, list[str]]  # (settings, dropped JSON pointers)
  def source_type(source: str) -> str                    # rtsp(s)://…:8554/… → MEDIAMTX; rtsp(s):// → RTSP; else FILE
  def mask_url(url: str) -> str                          # rtsp://u:p@h/x → rtsp://***@h/x
  def camera_payload(cam: dict, use_case: str, settings: dict) -> dict
  def import_cameras(payloads: list[dict], post: Callable[[dict], tuple[int, str]]) -> int  # exit code
  ```
  - `to_settings` first applies the use case's transforms (below), then prunes keys the schema
    doesn't define. It walks `properties` and `items`, following the bundled file's internal `#/…`
    `$ref`s, and records each removed key as a JSON pointer.
  - Transforms:
    - cashier: `clerk_zone = rules.clerk_zone ?? rules.zone_polygon ?? [[0.33, 0.46], [0.72, 0.46], [0.72, 1.0], [0.33, 1.0]]`.
    - horse and gate: drop an empty `roi_polygon`.
    - restaurant_table: lift the contents of `table_monitoring` to the top level (the pipeline
      reads `rules.get("table_monitoring", rules)`).
  - `camera_payload`:
    - `{id, name, useCase, enabled, sourceType, mainStreamUrl: source, targetFps: target_fps or 10, recordingPath, nxCameraId, settings, note: "imported from cameras.yaml"}`;
    - `nxCameraId` is `None` for `00000000-0000-0000-0000-000000000000`.
  - `import_cameras`: 201 → `created`, 409 → `exists, skipped`, anything else → print the status
    and body as a failure. The exit code is 1 if anything failed.
  - Output prints the dropped keys per camera, and masks every URL with `mask_url`.

- [ ] **Step 1: Write the failing tests**

```python
EXAMPLE = yaml.safe_load((ENGINE / "configs/cameras.yaml.example").read_text(encoding="utf-8"))["cameras"]
# the example file has no horse or table camera; these two cover those transforms
EXTRA = [{"id": "cam_pony_01", "name": "Pony", "pipeline": "horse", "source": "sample_data/kuda.mp4",
          "rule_config": "configs/rules/horse_riding.yaml"},
         {"id": "cam_tables_01", "name": "Tables", "pipeline": "table_monitor", "source": "sample_data/restoran.mp4",
          "rule_config": "configs/rules/restaurant_table.yaml"}]

@pytest.mark.parametrize("cam", EXAMPLE + EXTRA, ids=lambda c: c["id"])
def test_every_example_camera_validates(cam):
    uc = normalize_use_case(cam["pipeline"])
    schema = json.loads((SCHEMAS / uc / "settings.json").read_text(encoding="utf-8"))
    settings, _ = to_settings(uc, effective_rules(cam, ENGINE), schema)
    jsonschema.Draft202012Validator(schema).validate(settings)

def test_inline_list_roi_does_not_replace_the_rule_files_clerk_zone():
    cam = next(c for c in EXAMPLE if c["id"] == "cam_cashier_02")
    rule = yaml.safe_load((ENGINE / cam["rule_config"]).read_text(encoding="utf-8"))
    assert settings_for(cam)["clerk_zone"] == rule["clerk_zone"]   # matches what the engine runs today

def test_dropped_keys_are_reported():
    assert dropped_for("cam_gate_entry_01") == ["/anpr/regex_pattern", "/entry_direction", "/rule_name", "/vehicle_classes"]
    assert dropped_for("cam_cashier_01") == ["/rule_name", "/target_class"]

def test_aliases_and_source_types():
    assert normalize_use_case("horse") == "horse_riding" and normalize_use_case("table_monitor") == "restaurant_table"
    assert source_type("rtsp://127.0.0.1:8554/cam_x") == "MEDIAMTX"
    assert source_type("rtsp://u:p@10.0.0.5/s") == "RTSP"
    assert source_type("sample_data/cars.mp4") == "FILE"

def test_mask_url_hides_credentials():
    assert mask_url("rtsp://admin:secret@10.0.0.5:554/s1") == "rtsp://***@10.0.0.5:554/s1"

def test_import_exit_code(capsys):
    responses = iter([(201, ""), (409, ""), (400, '{"errors":[]}')])
    assert import_cameras([{"id": "a"}, {"id": "b"}, {"id": "c"}], lambda p: next(responses)) == 1
```
(`settings_for` and `dropped_for` are small helpers inside the test file built on the functions
above.)

- [ ] **Step 2: Run to see them fail**

Run: `uvx --from "pytest>=8.3" --with pyyaml --with jsonschema --with requests pytest -q tools/tests/test_import_yaml_config.py`
Expected: FAIL (`ModuleNotFoundError: import_yaml_config`).

- [ ] **Step 3: Implement, and update `repo.yml` to the same `uvx … --with …` command**

- [ ] **Step 4: Run**

Run the Step 2 command, then
`uv run tools/import_yaml_config.py --cameras services/engine/configs/cameras.yaml.example --dry-run`.
Expected: tests pass. The dry run prints one payload per example camera, with no `user:pass@` in the
output.

- [ ] **Step 5: Commit**

```bash
git add tools .github/workflows/repo.yml
git commit -m "feat(tools): import cameras.yaml and rule files into camera config versions"
```

---

### Task 14: Deploy, docs and the end-to-end run

**Files:**
- Modify: `deploy/docker-compose.yml`, `deploy/.env.example`, `deploy/README.md`, `README.md`,
  `docs/10_LOCAL_QUICKSTART.md`, `apps/api/README.md`, `packages/contracts/README.md`

**Interfaces:**
- Produces, compose services:
  - `postgres`:
    - `postgres:17.<patch>-alpine`;
    - env `POSTGRES_USER=zoo_owner`, `POSTGRES_PASSWORD`, `POSTGRES_DB=zoo_vision`,
      `ZOO_API_DB_PASSWORD`;
    - volumes `pgdata`, and `./postgres/init` mounted read-only at `/docker-entrypoint-initdb.d`;
    - `pg_isready` healthcheck, no host port.
  - `redis`:
    - `redis:7.4.<patch>-alpine`;
    - `redis-server --appendonly yes --appendfsync everysec --requirepass ${REDIS_PASSWORD}`;
    - port `127.0.0.1:6379:6379` (the engine uses host networking), volume `redisdata`,
      `redis-cli ping` healthcheck.
  - `api-migrate`:
    - image `zoo-vision-api:${ZOO_VERSION:-dev}`, built with context `..` and
      `dockerfile: apps/api/Dockerfile`;
    - command `npx prisma migrate deploy`;
    - env `DATABASE_MIGRATE_URL=postgresql://zoo_owner:${POSTGRES_PASSWORD}@postgres:5432/zoo_vision`;
    - `restart: "no"`, and it waits for postgres to be healthy.
  - `api`:
    - same image;
    - env:
      - `DATABASE_URL=postgresql://zoo_api:${ZOO_API_DB_PASSWORD}@postgres:5432/zoo_vision`
      - `REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379/0`
      - `CAMERA_URL_KEY`
      - `COOKIE_SECURE=false` (no TLS until Caddy in Phase 3)
      - `SWAGGER=public`
    - port `127.0.0.1:3001:3001`;
    - `depends_on`: `api-migrate` with `service_completed_successfully`, and `redis` healthy;
    - healthcheck
      `node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`.
  - `zoo-ai-engine` adds `REDIS_URL=redis://:${REDIS_PASSWORD}@127.0.0.1:6379/0` and
    `ENGINE_GROUP=default`, and depends on `redis`.
  - `.env.example` adds `POSTGRES_PASSWORD`, `ZOO_API_DB_PASSWORD`, `REDIS_PASSWORD` and
    `CAMERA_URL_KEY`, with a comment on generating each (`openssl rand -base64 32`).
  - `deploy/README.md` warns: losing `CAMERA_URL_KEY` makes every stored stream URL unreadable, so
    back it up with the database.

- [ ] **Step 1: Compose and docs**

Write the compose changes and the docs:
- `README.md`: the repo layout.
- Quickstart: a "Backend" section with the steps below.
- `apps/api/README.md`: scripts, env, e2e needs Docker, the grant rule for migrations.
- `packages/contracts/README.md`: how to add a use case and the change rules from spec section 3.

- [ ] **Step 2: Bring up the backend**

Run: `cd deploy && cp .env.example .env` and fill in the four secrets. Then
`docker compose up -d --build postgres redis api-migrate api`, then
`curl -s http://127.0.0.1:3001/api/health`.
Expected: `api-migrate` exited 0, `docker compose ps` shows `api` healthy, and the response has
`"status":"ok"`. The `zoo-ai-engine` service stays down: on the laptop the engine runs from source
(Step 5).

- [ ] **Step 3: First superadmin, login and token**

Run: `docker compose exec -e ZOO_ADMIN_PASSWORD=<chosen> api node dist/cli.js create-superadmin --username admin --name "Magnet Admin"`.

In `http://127.0.0.1:3001/api/docs`:
1. `POST /api/v1/auth/login`.
2. `POST /api/v1/api-tokens {name: "yaml import", role: "SUPERADMIN"}`; copy the token.
3. Try `POST /api/v1/auth/login` once with a wrong password.

Expected: both Swagger calls succeed, and `LoginLog` has `SUCCESS` and `WRONG_PASSWORD` rows.

- [ ] **Step 4: Import the local config**

Run: `ZOO_API_TOKEN=<token> uv run tools/import_yaml_config.py --cameras services/engine/configs/cameras.yaml`.
Expected: one `created` per camera with its dropped keys, and exit 0. Run it again. Expected:
`exists, skipped` for every camera.

- [ ] **Step 5: Engine to Postgres**

From `services/engine`, run
`REDIS_URL=redis://:<REDIS_PASSWORD>@127.0.0.1:6379/0 uv run python main.py` for about 3 minutes
with the local `cameras.yaml` (sample videos), then stop it with Ctrl+C. Query with
`docker compose exec postgres psql -U zoo_owner zoo_vision -c '<sql>'`.

Expected:
- one `engine_started` Event;
- `vehicle_crossing` Events for the gate camera;
- `Metric` rows for each running camera's metric names;
- every `Interval` closed, the last ones with `endReason = engine_stop`;
- `DeadEvent` is empty;
- `XPENDING events api` reports 0.

- [ ] **Step 6: Durability and crash checks (spec Verification 4 and part of 3)**

1. With the engine running, `docker compose stop api` for 2 minutes, then `docker compose start api`.
   Expected: within a minute `XPENDING` is 0, the Event count includes the gap, there are no
   duplicate ids (`SELECT id, count(*) … HAVING count(*) > 1` is empty), and `DeadEvent` is empty.
2. Kill the engine hard (`taskkill /F /PID <pid>`) while at least one interval is open (check
   with `SELECT "id" FROM "Interval" WHERE "end" IS NULL`), then start it again. Expected: those
   intervals are closed with `endReason = engine_restart`, and intervals opened after the restart
   stay open.

- [ ] **Step 7: Every suite, then the branch state**

Run:
- `cd packages/contracts && npm test && npm run check`;
- `cd apps/api && npm run lint && npm test && npm run test:e2e`;
- `cd services/engine && REDIS_URL=redis://:<pw>@127.0.0.1:6379/0 uv run pytest -q && uv run ruff check .`;
- the `tools/tests` command from Task 13.

Expected: all pass. `git status --short` is empty. `git log --oneline main..HEAD` lists the plan
commit and Tasks 1–14.

- [ ] **Step 8: Commit and hand off**

```bash
git add deploy README.md docs/10_LOCAL_QUICKSTART.md apps/api/README.md packages/contracts/README.md
git commit -m "feat(deploy): Postgres, Redis and API in compose; backend quickstart"
```
Ask the user to approve `git push -u origin phase-1-backbone`, then give them
`https://github.com/Aryaputra34/zoo-vision/compare/main...phase-1-backbone`. The PR description ends
with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
