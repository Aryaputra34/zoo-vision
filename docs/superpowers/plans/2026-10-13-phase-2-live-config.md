# Zoo Vision Phase 2 (Live Config Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cameras, zones and models are set up through the API and reach the running engine live. A saved
config applies to its camera between two frames, with no stream reconnect and no restart of the other
cameras. The engine reports which version each camera runs and whether it is alive. AI models are
registered, validated and converted through the API.

**Architecture:** The API serves each engine group's cameras on `/internal/engine/cameras` (engine token,
settings with the schema defaults filled in) and announces changes on `cfg:changed`. The engine's
supervisor refetches that snapshot on every notice, on every Redis reconnect and every 60 s. It reconciles
one worker per camera. A worker owns a stream and a pipeline, and applies a new config version between two
frames through the pipeline's `apply_config`. Pipelines live in `services/engine/usecases/<name>/`, take
typed settings parsed from the contracts, and share loaded models through a pool with one inference thread
per model. Workers report liveness and live state in `cam:{id}:status`; the API turns a missing key into a
`camera_offline` interval. Models are registered in `AiModel`. Validation and ONNX conversion run in the
engine as jobs from the Redis list `model:jobs`, and the results come back over HTTP.

**Tech Stack:** as in Phase 1 (Node 22, NestJS 11, Prisma 7, ioredis, ajv, Jest + supertest +
Testcontainers; Python 3.12 + uv 0.12.10, Ultralytics, supervision, redis-py, requests, pytest; Postgres
17.11, Redis 7.4.11), plus `@nestjs/schedule`, multer (through `@nestjs/platform-express`, with
`@types/multer`) and `onnxslim`.

**Spec:** `docs/superpowers/specs/2026-10-08-zoo-vision-production-architecture-design.md`: section 1
(flow, change classes, Redis keys), section 2 (process model, model pool, engine groups, static config),
section 3 (downtime intervals, system events), section 4 (`engine-internal`, `models`, `jobs` modules),
section 6 (phase 2), section 7 (AI models), section 8 (tests, error handling). Conventions come from the
Phase 1 plan, `docs/superpowers/plans/2026-10-09-phase-1-backbone.md`.

## Global Constraints

- Work in the main checkout `C:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor`, on branch
  `phase-2-live-config` created from `main`. Task 15 needs the local model files and sample videos, which
  a worktree would not have. Never commit to `main`. Push only after the user says yes.
- Commit messages and pull request descriptions carry no Claude attribution: no `Co-Authored-By` trailer
  and no "Generated with Claude Code" line.
- The dev laptop has no NVIDIA GPU and a weak CPU:
  - The engine always runs from source with `uv`, on CPU.
  - Docker runs only `postgres`, `redis`, `api-migrate`, `api` and the Testcontainers test containers.
  - Never run `docker compose up` without naming services. Never build the engine image.
  - Local engine runs use one camera at imgsz 640 and 1–2 fps.
  - The compose Redis is on host port 6380 (`ZOO_REDIS_PORT`). Quote paths: the repo path has a space.
    In Git Bash, `/tmp/...` arguments to `docker compose exec` need `MSYS_NO_PATHCONV=1`.
- Don't edit historical documents: `docs/adr/*`, `docs/01_*`, `docs/04_*`, `docs/06_*`,
  `docs/architecture_best_practice_recommendation.md`, the spec, the Phase 0 and Phase 1 plans.
- Versions: use the newest release of each named major when installing, and commit the lockfiles. Image
  tags stay `postgres:17.11-alpine` and `redis:7.4.11-alpine`.
- API paths: user routes are `/api/v1/...`. Engine routes are `/internal/engine/...`, outside the `api`
  prefix and outside URI versioning, and are never routed by Caddy. Swagger leaves them out.
- Contract rules (spec section 3): only add optional fields or enum values. Never change a field's
  meaning. No use case's `schemaVersion` changes in this phase.
- Never put these in logs, audit rows, or responses to anyone below SUPERADMIN: passwords, password hashes,
  API tokens, `ENGINE_TOKEN`, camera stream URLs. The engine logs a stream URL only through `mask_url`.
- Redis, in addition to Phase 1's keys:

  | Key | Type | Writer → reader | Content |
  |---|---|---|---|
  | `cfg:changed` | pub/sub | API → engine | `{cameraId, version}`. The engine treats it as a trigger only and refetches its whole snapshot |
  | `cam:{id}:status` | hash | engine → API | the fields in Task 4. Expires 15 s after the camera's last processed frame (or its worker start) |
  | `cam:{id}:frame` | string | engine → API | latest raw JPEG, width ≤ 1280, quality 80, written every 2 s, `PX 10000` |
  | `model:jobs` | list | API (`LPUSH`) → engine (`BRPOP`) | JSON jobs `validate` and `convert` (Tasks 5, 6) |

- Engine static config is environment variables only (Task 8). `configs/app_config.yaml` retires.
  `configs/cameras.yaml.example` and `configs/rules/*.yaml` stay for `tools/import_yaml_config.py` and
  `test_video.py`.
- Model files: the web upload accepts ONNX only. `.pt` and `.engine` files come in only through the
  server's `inbox/` folder.
- Numbers the spec doesn't give, fixed here:
  - Status heartbeat every 5 s. A camera counts as `reconnecting` when its last processed frame is more
    than 5 s old.
  - Frame JPEG every 2 s.
  - Full config resync every 60 s. `cfg:changed` notices are coalesced for 200 ms.
  - Watchdog stall limit 30 s. Offline check every 5 s.
  - Stream reconnect backoff starts at 2 s and doubles up to 30 s.
  - Model pool call timeout 30 s. `ENGINE_MAX_BATCH` defaults to 1.
  - Model upload limit 1 GiB.
  - Reason strings in messages and statuses are at most 500 characters.
  - A table added by a live change warms up for its `empty_debounce_sec`.

## Decisions this plan makes beyond the spec

The user should confirm these when reviewing the plan.

1. **A `cfg:changed` notice is only a trigger.** The engine refetches its group's whole snapshot on every
   notice, on every (re)subscribe, and every 60 s. It compares unversioned camera fields (URL, fps, name)
   by value. Why: notices carry an unchanged `activeVersion` for those fields (Phase 1 follow-up), and the
   API logs, never retries, a failed publish.
2. **The API is the runtime source of settings defaults.** `/internal/engine/cameras` sends settings with
   ajv's defaults filled in, and the engine validates them strictly with Pydantic. A cross-language parity
   test pins Pydantic's verdicts and defaults to ajv's. Why: two default implementations drift silently.
3. **Settings schemas are generated fully dereferenced** (no `$ref`), and Pydantic is generated with
   `--strict-nullable`. Why: today's bundler inlines a shared definition at its first use, so later
   references point at that property, including any `default` or `x-minRole` it carries.
4. **Settings never contain `null`.** A contracts test asserts that no settings schema allows it, and the
   engine rejects a `null` anywhere in settings. Why: Pydantic models accept `null` for optional fields
   without a default, and ajv rejects it.
5. **`model_id` joins `model_name`**, rather than replacing it. It is an optional SUPERADMIN field holding
   an `AiModel` id, and when it is set it wins. Why: replacing `model_name` would bump `schemaVersion`,
   which would invalidate every message already in the stream.
6. **`AiModel.status` adds `CONVERTING`**, for the target row of a conversion while the engine exports
   it. Files are stored as `<models dir>/registry/<id>.<ext>`. Built-in models stay where
   `tools/fetch_models.py` put them and are registered in place with source `BUILTIN`.
7. **Model jobs use a Redis list `model:jobs`** (`LPUSH`/`BRPOP`), not pub/sub, and results come back over
   HTTP. Why: a job then waits while no engine runs, and only one engine takes it.
8. **`cam:{id}:status` expires 15 s after the camera's last processed frame** (or its worker start, before
   the first frame), whatever the engine is doing. Why: the key can then say "reconnecting" and still
   expire, so a dead stream becomes an offline interval within about 15 s (spec section 8).
9. **The API's `jobs` module writes `camera_offline` intervals directly** (useCase `system`). A partial
   unique index allows one open interval per camera. They close with `endReason` `online` or `disabled`.
10. **The envelope's `endReason` adds `config_change`**: a table removed, a camera disabled, removed or
    moved to another group, or a use case changed.
11. **A new camera field `inferenceStream` (`MAIN|SUB`, SUPERADMIN only)** picks which stream the engine
    decodes (spec section 2). `SUB` falls back to the main URL when the camera has no sub URL.
12. **The engine runs Nx in mock mode** (bookmarks are only logged) until the API's `nx` output module
    exists. `app_config.yaml` and its `nx_server` section retire with the YAML config.
13. **The engine's preview server (`core/api_server.py`) stays until Phase 4.** The prototype dashboard
    keeps its live preview and snapshots.
14. **Moved to Phase 4:** per-frame boxes (`cam:{id}:boxes`), "draw only when needed", `cam:{id}:debug`
    and the debug view. They serve the live overlay and the debug view. `cam:{id}:frame` is built now,
    because Phase 3's zone editor needs it.
15. **The model pool batches only when `ENGINE_MAX_BATCH` > 1** (default 1). Why: ONNX exports with a
    static batch size reject batches; Phase 5's soak test decides. "Convert to ONNX" exports with dynamic
    shapes, opset 19 and simplify, which are `tools/export_model.py`'s defaults.
16. **ANPR stays per gate pipeline** (plate detector and OCR are not pooled; there is one gate camera). An
    `anpr` settings change rebuilds it between two frames.
17. **Engine routes use a shared `ENGINE_TOKEN`** (`Authorization: Bearer`), compared in constant time.
18. **A table added by a live change warms up silently** for its `empty_debounce_sec`. Its state follows
    the detections, but no session opens or closes. Tables present at engine start behave as today.
19. **`simulate_demo.py` and `test_synthetic_demo.py` are deleted.** They are prototype demos built on the
    old pipeline constructors; `test_video.py` covers running a pipeline on a video.
20. **A watchdog restart closes the camera's intervals with `engine_stop`.**
21. **MANAGER may read the model registry**; every change needs SUPERADMIN. An upload must start with byte
    `0x08` (an ONNX protobuf starts with its `ir_version` field), so a renamed pickle is refused early.
22. **Offline detection runs only when `JOBS=on`** (default on; the e2e tests set it off and call `tick()`).
23. **The engine sends a `config_rejected` system event** once per rejected version, so a rejection is on
    record after its status entry expires.

## Phase 1 follow-ups

From the Phase 1 final review (memory `phase-1-followups`):

| Follow-up | Where |
|---|---|
| Python/JS validator parity: `{field: null}` rejected by both, for every data and settings model | Task 1 |
| One source for settings defaults (ajv `withDefaults`, Pydantic, shared-ref default leak) | Task 1, Task 3 |
| Mask stream URLs in the engine logs | Task 8 |
| `cfg:changed` carries an unchanged `activeVersion` for unversioned fields | Tasks 3, 12, 13 (refetch on every notice) |
| `camera_offline` intervals use useCase `system`, so `engine_started` leaves them open | Tasks 2, 4 |
| Validate `ENGINE_GROUP`; `test_video.py` gets its own group | Task 8, Task 10 |
| Outage-then-recovery exactly-once e2e test | Task 7 |
| `walkProperties` follows only `properties` (`x-minRole`, polygon lists in `items`/`oneOf`) | Task 2 |
| The transient-error 503 filter doesn't log | Task 7 |

The Phase 3 follow-ups (error-body shape, `trust proxy`, `SWAGGER` default, `/api/health` error text,
ioredis timeouts, `changePassword` throttle, WebSocket push, reports and system-log endpoints) stay in
Phase 3.

## Needs the user

1. Docker Desktop running for the Testcontainers e2e suites (Tasks 3–7) and for Task 15.
2. Task 15: generate `ENGINE_TOKEN`, watch the one-camera laptop run, and approve `git push`. The pull
   request is opened from the compare link.
3. Optional, after the merge: spec verification #3 (two cameras share one model, measured in GPU memory)
   needs the CUDA laptop or the park server.

## Not in Phase 2

- Phase 3: the web (`zoo-vision-fe`) on the API, the `live` WebSocket gateway and post-commit push, the
  `usecases` endpoint, reports, system-log views, Caddy, and the Phase 3 follow-ups above.
- Phase 4: `cam:{id}:boxes`, drawing only when needed, the debug view, retiring `core/api_server.py`,
  MediaMTX Control API sync, evidence, retention jobs, `SiteSettings`.
- Phase 5: clock-drift check, NVDEC decoding, the soak test that settles `ENGINE_MAX_BATCH`, backups,
  ADR-009.
- A `model_validation_failed` system event: the `AiModel` status and its validation report carry the
  failure, and the system event views come in Phase 3.
- Class pickers validated against a model's class list: no settings field picks classes yet.
- Golden-clip regression tests (spec section 8). They need hand-counted expected results per clip and the
  clips in Git LFS. Plan them with the Phase 5 soak test, unless the user wants them sooner.
- TensorRT `.engine` builds cached per GPU.

## Review Focus

1. **The API is down when the engine starts, or goes down while it runs.** Expected: the engine retries
   until the API answers and then starts its cameras. While running, it keeps every camera on its current
   config. Tests in Task 12.
2. **Two quick saves while the first one's model is still loading.** Expected: the camera ends on the
   newer version and never runs the older one, and the detector loaded for the older one is released.
   Tests in Task 12.
3. **A camera whose stream never connects** (wrong URL, camera unplugged). Expected: its status shows
   `starting`, then expires, and the API opens a `camera_offline` interval. The watchdog doesn't restart
   it, and the other cameras are unaffected. Tests in Tasks 4 and 12.
4. **Redis restarts while the engine runs.** Expected: the listener resubscribes and triggers a resync,
   and the status keys are rewritten on the next heartbeat. Tests in Task 13.
5. **An upload that is too large or breaks off.** Expected: 413 or 4xx, no partial file left in
   `registry/`, and no `AiModel` row. Tests in Task 5.

## Target layout at the end of Phase 2

```
apps/api/src/        + engine-internal/, models/, jobs/, cameras/camera-status.*
packages/contracts/  scripts/deref.mjs, test/parity.test.mjs + parity_check.py, test/generate.test.mjs
services/engine/
  main.py            env config, supervisor, listener, status publisher, model jobs, preview server
  core/              env, settings, camera_config, model_pool, worker, supervisor, api_client,
                     config_listener, status, model_jobs (+ existing modules)
  usecases/<name>/   pipeline.py for cashier_presence, horse_riding, restaurant_counter,
                     restaurant_table, vehicle_gate (pipelines/ is gone)
deploy/              compose: ENGINE_TOKEN, JOBS, models volume shared by api and engine
```

## Models for subagent-driven execution

Per memory `model-split-and-session-cost`: Sonnet implements and reviews routine tasks. Opus reviews
security, concurrency and data-integrity code, and does the final whole-branch review.

| Task | Implementer | Reviewer |
|---|---|---|
| 1 parity, 7 ingest outage, 5 uploads, 9 model pool | Sonnet | Opus |
| 12 workers and supervisor | Opus (subtle concurrency) | Opus |
| all others | Sonnet | Sonnet |

---

### Task 1: Contracts: one validator behaviour in JS and Python

**Files:**
- Create: `packages/contracts/scripts/deref.mjs`
- Modify: `packages/contracts/scripts/generate.mjs`
- Create: `packages/contracts/test/parity.test.mjs`, `test/parity_check.py`, `test/generate.test.mjs`,
  `test/fixtures/refs/{settings.schema.json,common.schema.json}`
- Create: `services/engine/core/settings.py`
- Test: `services/engine/tests/test_settings.py`
- Regenerated, committed: `packages/contracts/generated/**`, `services/engine/contracts/**`
- Modify: `.github/workflows/contracts.yml` (add the paths `services/engine/core/settings.py` and
  `services/engine/core/messages.py`)

**Interfaces:**
- Produces, `scripts/deref.mjs`: `export async function derefSettings(file: string): Promise<object>`.
  It uses `$RefParser.dereference` with `dereference.circular: false`, then a JSON round trip, so that
  every reference is its own copy. Its siblings (`default`, `x-minRole`, `description`) apply only there.
- `generate.mjs`: `usecases/*/settings.schema.json` go through `derefSettings`. Every other schema keeps
  `$RefParser.bundle`. Add `--strict-nullable` to the datamodel-codegen arguments.
- Produces, `services/engine/core/settings.py`:
  ```python
  class SettingsError(ValueError):
      path: str  # JSON pointer of the first problem, "" for the document itself
  def parse_settings(use_case: str, settings: dict, *, strict: bool = True) -> BaseModel
  ```
  - A use case that is unknown or has no settings raises at path `""`.
  - A `None` at any depth raises at its pointer with the message `null is not allowed`.
  - `strict=True` runs `model_validate_json(json.dumps(settings, allow_nan=False), strict=True)`. It
    expects API-filled settings, because Pydantic cannot strictly validate a list default for a tuple field
    (`vehicle_gate` and `restaurant_counter` fail on a missing `tripwire`).
  - `strict=False` runs `model_validate(settings)`, which fills Pydantic's defaults. It is only for local
    YAML rule files (`test_video.py`) and tests.
  - The first Pydantic error becomes a `SettingsError`, its `loc` joined into a pointer (`/a/0/b`).

- [ ] **Step 1: Start the branch**

Run `git status --short`. Expected: only `?? docs/superpowers/plans/2026-10-13-phase-2-live-config.md`.
Then run `git switch -c phase-2-live-config main` and commit the plan alone
(`docs: Phase 2 implementation plan`).

- [ ] **Step 2: Write the failing tests**

```js
// packages/contracts/test/parity.test.mjs
// Every case goes through createValidator() here and through the engine's own validators in Python
// (core.settings.parse_settings, core.messages.validate) via test/parity_check.py: the verdicts must match.
// Python runs as: uv run --no-project --with pydantic==<P> --with numpy==<N> python -I test/parity_check.py <services/engine>
// where <P> and <N> are read from services/engine/uv.lock, so the test uses the engine's versions.
// stdin: [{kind: "settings", useCase, doc, strict} | {kind: "message", doc}]
// stdout: [{ok, dump?}]; dump = model.model_dump(mode="json", exclude_none=True) for accepted settings.

test('settings: each valid example with defaults filled passes both, and Pydantic returns it unchanged')
  // for every use case with settings and every examples/settings/valid/*.json:
  //   filled = v.withDefaults(uc, ex); v.validateSettings(uc, filled).ok === true
  //   py(strict) ok === true && deepStrictEqual(py.dump, filled)
test("settings: Pydantic's defaults equal withDefaults for each valid example")
  // py(raw example, strict=false).dump deepStrictEqual v.withDefaults(uc, ex)
test('settings: each invalid example fails both')
test('settings: null in place of any value of a filled valid example fails both')
  // every pointer into `filled` (object keys and array items, any depth): set null → js false, py false
test('messages: each example gets the same verdict from both')
  // usecases/*/examples/messages/{valid,invalid}/*.json → js ok === py ok, and equals the folder name
test('messages: null in place of any top-level or data value gets the same verdict from both')
  // e.g. vehicle_crossing data.ocrConfidence → both accept; data.plate → both reject;
  // interval_close data.tableName → both reject
```

```js
// packages/contracts/test/generate.test.mjs
test('generated settings schemas contain no $ref')                 // walk generated/schemas/usecases/*/settings.json
test('no settings schema accepts null')                            // no `type` containing "null", no null in enum/const
test('derefSettings gives each reference only its own default and x-minRole', async () => {
  // fixtures/refs/settings.schema.json: properties a and b both $ref common.schema.json#/$defs/Point;
  // a also has default [0.1, 0.2] and x-minRole SUPERADMIN, b has neither.
  const s = await derefSettings(fixture('refs/settings.schema.json'));
  assert.deepEqual(s.properties.a.default, [0.1, 0.2]);
  assert.equal(s.properties.a['x-minRole'], 'SUPERADMIN');
  assert.equal(s.properties.b.default, undefined);
  assert.equal(s.properties.b['x-minRole'], undefined);
});
```

```python
# services/engine/tests/test_settings.py
def test_filled_example_passes_strictly():
    s = parse_settings("vehicle_gate", load_example("vehicle_gate"))   # the example sets tripwire
    assert s.tripwire.start == (0.76, 0.58)

def test_null_anywhere_is_rejected_with_its_path():
    with pytest.raises(SettingsError) as e:
        parse_settings("horse_riding", {"tripwire": {"enabled": None}})
    assert e.value.path == "/tripwire/enabled"

def test_strict_refuses_a_number_in_a_string():
    with pytest.raises(SettingsError) as e:
        parse_settings("horse_riding", {"lost_track_buffer": "60"})
    assert e.value.path == "/lost_track_buffer"

def test_lax_fills_pydantic_defaults():
    assert parse_settings("restaurant_counter", {}, strict=False).tripwire.start == (0.1, 0.5)

@pytest.mark.parametrize("use_case", ["system", "nope"])
def test_use_case_without_settings(use_case):
    with pytest.raises(SettingsError) as e:
        parse_settings(use_case, {})
    assert e.value.path == ""

def test_defaulted_fields_are_not_optional():
    assert REGISTRY["horse_riding"].settings.model_fields["lost_track_buffer"].annotation is int
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd packages/contracts && npm test`, then
`cd ../../services/engine && uv run pytest -q tests/test_settings.py`.
Expected: FAIL. `derefSettings` is missing, `core.settings` is missing, and generated settings still
contain `$ref`.

- [ ] **Step 4: Add `deref.mjs` and change `generate.mjs` as in Interfaces, then `npm run generate`**

- [ ] **Step 5: Implement `core/settings.py`**

- [ ] **Step 6: Run everything until it passes**

Run: `cd packages/contracts && npm test && npm run check` (after `git add` of the generated output), then
`cd ../../services/engine && uv run pytest -q && uv run ruff check .`, then
`cd ../../apps/api && npm test && npm run build`.
Expected: all pass. A parity failure is a real difference between the two validators. Fix it in the schema
or in the generation, not in the test. For example, if a nested default is filled by Pydantic but not by
ajv, write the full default object in the schema.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts services/engine/contracts services/engine/core/settings.py services/engine/tests/test_settings.py .github/workflows/contracts.yml
git commit -m "feat(contracts): dereferenced settings schemas, strict-nullable models and a JS/Python parity test"
```

---

### Task 2: Contracts for Phase 2, and nested `x-minRole` and polygon lists

**Files:**
- Modify: `packages/contracts/envelope/message.schema.json`
- Modify: `packages/contracts/usecases/system/{events,intervals}.schema.json`, add examples
- Modify: `packages/contracts/common/detection.schema.json`, the five `usecases/*/settings.schema.json`
- Modify: `packages/contracts/src/index.js`, `src/index.d.ts`, `test/fixtures/usecases/demo/settings.json`,
  `test/validator.test.mjs`
- Modify: `apps/api/src/cameras/restricted-changes.ts`, `restricted-changes.spec.ts`
- Modify: `services/engine/core/messages.py`, `tests/test_messages.py`
- Regenerated: `packages/contracts/generated/**`, `services/engine/contracts/**`

**Interfaces:**
- Envelope: `interval_close.endReason` is `ended | engine_stop | config_change`.
- `system` events add `config_rejected` (title `ConfigRejected`): `{version: integer ≥ 1, reason: string,
  1–500 chars}`. It is sent with the camera's id as `cameraId` and severity `warning`.
- `system` intervals add `camera_offline` (title `CameraOffline`): data `{}` (no properties,
  `additionalProperties: false`). The API writes these intervals (Task 4).
- `common/detection.schema.json` adds `$defs/ModelId`:
  `{"title": "ModelId", "type": "string", "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"}`.
  Every settings schema gets an optional `model_id` with `$ref` to it, `"x-minRole": "SUPERADMIN"` and the
  description "AiModel id. When set, the camera runs this registry model instead of model_name.". Use a
  pattern rather than `format: uuid`, because Pydantic's UUID type accepts forms that ajv rejects.
- JS: the schema walk follows `properties`, `items`, `prefixItems`, `anyOf`, `oneOf` and `allOf`. Any array
  index is written as a `*` segment.
  - `restrictedFields(useCase)` may return paths such as `/zones/*/sensitivity`.
  - `validateSettings` checks duplicate ids in every `polygon-list` the walk reaches, at every concrete
    match of a wildcard path.
  - `index.d.ts` documents the `*` segment.
- API: `restrictedChanges(validator, useCase, before, after, role): string[]` returns concrete pointers.
  For a path with `*`:
  - Items are matched by their string `id` when every item on both sides has one, otherwise by index.
  - Matched items are compared after `withDefaults`.
  - An item only in `after` violates if its raw value at the restricted sub-path is defined.
  - Removing an item is allowed.
- Engine: each of the four builders in `core/messages.py` takes a keyword `config_version: int | None = None`
  and writes it to `configVersion`.

- [ ] **Step 1: Write the failing tests**

Demo fixture: add `zones` (an array of `{id, polygon, sensitivity: number, default 0.5, x-minRole
SUPERADMIN}`), and `layout`, a `oneOf` of `{kind: "rooms", rooms: polygon-list}` and `{kind: "none"}`.

```js
// test/validator.test.mjs
test('restrictedFields reaches into array items', () => {
  assert.ok(v.restrictedFields('demo').some((f) => f.path === '/zones/*/sensitivity'));
});
test('duplicate ids are found in a polygon list inside oneOf', () => {
  const room = { id: 'R1', name: 'a', polygon: [[0, 0], [1, 0], [1, 1]] };
  const r = v.validateSettings('demo', { ...minimal, layout: { kind: 'rooms', rooms: [room, room] } });
  assert.deepEqual(r.errors.map((e) => e.path), ['/layout/rooms/1/id']);
});
```

```ts
// restricted-changes.spec.ts: a stub validator whose restrictedFields() is
// [{ path: '/zones/*/sensitivity', minRole: 'SUPERADMIN' }] and whose withDefaults() is a deep clone
it("a manager changing one zone's sensitivity gets that zone's concrete path")  // ['/zones/1/sensitivity']
it('zones are matched by id, so reordering them is not a change')                // []
it('a manager may add a zone without sensitivity, but not one with it')          // [] / ['/zones/2/sensitivity']
it('a manager may remove a zone')                                                // []
```

```python
# tests/test_messages.py
def test_builders_carry_the_config_version():
    m = metric_message("cam_x", "horse_riding", "active_horses", 120_000, 1.0, config_version=7)
    validate(m)
    assert m["configVersion"] == 7

def test_config_rejected_and_config_change_are_valid():
    validate(event_message("cam_x", "system", "config_rejected", {"version": 3, "reason": "bad"}, "warning"))
    validate(interval_close_message("cam_x", "restaurant_table", "table_session", "ses_" + "0" * 32,
                                    end_reason="config_change"))
```

Example messages, valid: `config_rejected.json`, `camera_offline_open.json`, `camera_offline_close.json`.
Invalid: `config_rejected_reason_501_chars.json`.

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/contracts && npm test`; `cd apps/api && npx jest restricted-changes`;
`cd services/engine && uv run pytest -q tests/test_messages.py`. Expected: FAIL.

- [ ] **Step 3: Implement the schema changes, the walk, `restrictedChanges` and the builders; run
  `npm run generate`**

- [ ] **Step 4: Run everything**

Run the three suites, plus `npm run check` in `packages/contracts` and `npm run build` in `apps/api`.
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts services/engine/contracts services/engine/core/messages.py services/engine/tests apps/api/src/cameras
git commit -m "feat(contracts): config_rejected, camera_offline, model_id, and x-minRole inside items and oneOf"
```

---

### Task 3: API: the engine's camera snapshot, the engine token and the inference stream

**Files:**
- Modify: `apps/api/prisma/schema.prisma`; create migration `<ts>_camera_inference_stream`
- Modify: `apps/api/src/config/env.ts`, `env.spec.ts`, `bootstrap.ts`, `app.module.ts`
- Create: `apps/api/src/engine-internal/{engine-internal.module.ts,engine-token.guard.ts,engine-token.guard.spec.ts,engine-internal.controller.ts,engine-cameras.service.ts}`
- Modify: `apps/api/src/cameras/{dto/camera-fields.dto.ts,cameras.service.ts,camera-view.ts}` and
  `camera-view.spec.ts`
- Modify: `apps/api/test/app.ts`; create `apps/api/test/engine-internal.e2e-spec.ts`; extend
  `test/cameras.e2e-spec.ts`
- Modify: `deploy/docker-compose.yml` (api: `ENGINE_TOKEN`), `deploy/.env.example`, `apps/api/README.md`

**Interfaces:**
- `Camera.inferenceStream StreamChoice @default(MAIN)`.
  - Create and update accept `inferenceStream`, but only a SUPERADMIN may change it; it is not one of the
    MANAGER fields.
  - The MANAGER and SUPERADMIN views show it.
- `Env.ENGINE_TOKEN: string`, required, at least 32 characters. `test/app.ts` exports `TEST_ENGINE_TOKEN`
  and uses it as the default.
- `bootstrap.ts`: the global prefix `api` excludes `internal/{*path}` (all methods). The controller is
  `@Controller({ path: 'internal/engine', version: VERSION_NEUTRAL })`, `@Public()`,
  `@UseGuards(EngineTokenGuard)` and `@ApiExcludeController()`.
- `EngineTokenGuard`: `Authorization: Bearer <token>`. It compares SHA-256 digests with `timingSafeEqual`,
  and anything else is 401. A user session cookie is not enough.
- Produces, `GET /internal/engine/cameras?group=<g>`:
  ```
  200 {"cameras": EngineCamera[]}   enabled cameras with engineGroup = g, sorted by id
  400 when group is missing or does not match ^[a-z0-9_-]{1,32}$
  EngineCamera = {
    id, name, useCase,
    version: number,                 // Camera.activeVersion
    schemaVersion: number,           // of that version
    settings: object,                // validator.withDefaults(useCase, active version's settings)
    sourceUrl: string,               // decrypted; inferenceStream SUB → sub URL when set, else main
    targetFps: number,
    nxCameraId: string | null,
    model: { path: string, imgsz: number | [number, number] }   // path relative to the models dir
  }
  ```
  `EngineCamerasService.snapshot(group: string): Promise<EngineCamera[]>`. Here, `model.path` is
  `settings.model_name`; Task 6 adds `model_id`. `model.imgsz` is `settings.imgsz`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/engine-internal.e2e-spec.ts (createTestApp(), cameras created through POST /api/v1/cameras as SUPERADMIN)
it('401 without a token, with a wrong token, and with only a SUPERADMIN session cookie')
it('/api/internal/engine/cameras and /api/v1/internal/engine/cameras are 404')
it('400 for a missing group or "Bad Group"')
it('returns only enabled cameras of the group, sorted by id')
it("fills schema defaults: a horse camera saved without tripwire gets {enabled:false,start:[0.2,0.6],end:[0.8,0.6]}")
it('sourceUrl is the decrypted main URL; SUB uses the sub URL, and SUB without a sub URL falls back to main')
it('model is {path: settings.model_name, imgsz: settings.imgsz}')
```

```ts
// test/cameras.e2e-spec.ts
it('MANAGER PATCH {inferenceStream: "SUB"} → 403 with fields ["inferenceStream"]; SUPERADMIN → 200 and cfg:changed is published')
```

`env.spec.ts`: an `ENGINE_TOKEN` that is missing or 31 characters long is named in the `EnvError`, and its
value is not shown. `engine-token.guard.spec.ts`: right token → true; a wrong token of the same length,
`Basic x` and no header → 401.

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/api && npm test && npm run test:e2e -- engine-internal cameras`. Expected: FAIL (no
`ENGINE_TOKEN`, no route).

- [ ] **Step 3: Write the migration, then implement the module, the guard, the prefix exclusion and the
  camera field**

- [ ] **Step 4: Deploy and docs**

- `.env.example`: `ENGINE_TOKEN=change-me` with `# openssl rand -hex 32. The API and the engine share it.`
- Compose `api`: `ENGINE_TOKEN: ${ENGINE_TOKEN:?set ENGINE_TOKEN in .env}`.
- `apps/api/README.md`: `ENGINE_TOKEN`, and the `/internal/engine/*` routes.

- [ ] **Step 5: Run everything**

Run: `npm run lint && npm run build && npm test && npm run test:e2e`. Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api deploy/docker-compose.yml deploy/.env.example
git commit -m "feat(api): engine camera snapshot behind the engine token, and inferenceStream per camera"
```

---

### Task 4: API: camera status, the latest frame, and offline intervals

**Files:**
- Create: `apps/api/src/cameras/{camera-status.service.ts,camera-status.controller.ts}`
- Create: `apps/api/src/jobs/{jobs.module.ts,offline.job.ts}`; add `@nestjs/schedule`
- Modify: `apps/api/src/config/env.ts` (`JOBS: 'on' | 'off'`, default `on`), `app.module.ts`, `test/app.ts`
  (`JOBS: 'off'`)
- Create: migration `<ts>_open_camera_offline_index`
- Test: `apps/api/test/camera-status.e2e-spec.ts`, `apps/api/test/offline.e2e-spec.ts`

**Interfaces:**
- Consumes, the hash `cam:{id}:status` written by the engine (Task 13), all values strings:

  | Field | Value |
  |---|---|
  | `state` | `starting`, `running`, `reconnecting`, `error` |
  | `fps` | processed frames per second, e.g. `"4.9"` |
  | `lastFrameAt` | epoch ms of the last processed frame; `""` before the first |
  | `appliedVersion` | config version in use; `""` when none |
  | `configError` | `""` or `"v13 rejected: <reason>"` |
  | `useCase`, `engineGroup`, `bootId` | |
  | `restarts` | watchdog restarts of this camera since the engine started |
  | `live` | JSON object: the pipeline's latest status payload; `"{}"` before the first frame |
  | `updatedAt` | epoch ms |

- Produces:
  ```
  CameraStatus = { state, fps: number, lastFrameAt: number | null, appliedVersion: number | null,
                   configError: string | null, restarts: number, live: object, updatedAt: number }
  GET /api/v1/camera-status        any role → { cameraId, online: boolean, status: CameraStatus | null }[] (every camera, by id)
  GET /api/v1/cameras/:id/status   any role → { online, status }; 404 for an unknown camera
  GET /api/v1/cameras/:id/frame    any role → image/jpeg from cam:{id}:frame, Cache-Control: no-store;
                                   404 when the camera or the key is missing
  CameraStatusService.read(ids: string[]): Promise<Map<string, CameraStatus | null>>
  OfflineJob.tick(now?: Date): Promise<void>
  ```
  `online` is "the key exists". A `live` value that isn't valid JSON reads as `{}`.
- `OfflineJob` runs every 5 s when `JOBS=on` (registered with `SchedulerRegistry`). A tick is skipped while
  the previous one still runs. For each camera:
  - enabled, no key, no open interval → insert an `Interval`: id `ses_<32 hex>`, `useCase 'system'`,
    `kind 'camera_offline'`, `subjectId` null, `start` now, `configVersion` null, `schemaVersion` from the
    `system` contract, `data {}`;
  - enabled, key present, open interval → close it, `endReason 'online'`;
  - disabled with an open interval → close it, `endReason 'disabled'`.
- Migration (raw SQL; Prisma doesn't model partial indexes, so keep it out of `schema.prisma`. When a later
  `prisma migrate dev` proposes dropping it, delete that line):
  `CREATE UNIQUE INDEX "Interval_open_camera_offline" ON "Interval" ("cameraId") WHERE "useCase" = 'system' AND "kind" = 'camera_offline' AND "end" IS NULL;`
  The insert uses `ON CONFLICT ("cameraId") WHERE <same predicate> DO NOTHING`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/camera-status.e2e-spec.ts (status hashes seeded with HSET)
it('a camera with a status hash → online true and parsed numbers; without one → online false, status null')
it('as USER, GET /camera-status lists every camera')
it('GET /cameras/:id/frame returns the stored bytes as image/jpeg with no-store; 404 when the key is missing or the camera is unknown')
it("a live field that isn't JSON reads as {}")
```

```ts
// test/offline.e2e-spec.ts (JOBS off; the test calls app.get(OfflineJob).tick())
it('an enabled camera without a status key gets one open camera_offline interval (useCase system); a second tick adds none')
it('the key coming back closes it with endReason online; the key going away opens a new one')
it('disabling the camera closes its open interval with endReason disabled')
it('engine_started for its group leaves the camera_offline interval open')   // through IngestService.processBatch
it('a never-connecting camera: no key at all → offline interval; other cameras with keys stay without one')  // Review Focus 3
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run test:e2e -- camera-status offline`. Expected: FAIL (404s, no `OfflineJob`).

- [ ] **Step 3: Implement the migration, the service, the controller and the job**

- [ ] **Step 4: Run everything**

Run: `npm run lint && npm run build && npm test && npm run test:e2e`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): camera status and frame endpoints, camera_offline intervals from expired status keys"
```

---

### Task 5: API: the AI model registry (upload, rescan, list, delete)

**Files:**
- Modify: `apps/api/prisma/schema.prisma`; create migration `<ts>_ai_model` (table, enums, and
  `GRANT SELECT, INSERT, UPDATE, DELETE ON "AiModel" TO zoo_api`)
- Create: `apps/api/src/models/{models.module.ts,models.controller.ts,models.service.ts,model-files.ts,model-files.spec.ts,dto/model.dto.ts}`
- Modify: `apps/api/src/config/env.ts` (`MODELS_DIR`, default `/data/models`; `MODEL_UPLOAD_MAX_BYTES`,
  default 1073741824), `app.module.ts`, `package.json` (`@types/multer`)
- Modify: `apps/api/test/app.ts` (a fresh `mkdtemp` folder as `MODELS_DIR` per app)
- Modify: `deploy/docker-compose.yml` (api: `MODELS_DIR=/data/models`, volume
  `${ZOO_DATA_DIR:-./data}/models:/data/models`), `deploy/README.md`
- Test: `apps/api/test/models.e2e-spec.ts`

**Interfaces:**
- Prisma:
  ```prisma
  enum ModelFormat { ONNX PT ENGINE }
  enum ModelSource { BUILTIN FILESYSTEM UPLOAD CONVERTED }
  enum ModelStatus { UPLOADED VALIDATING READY FAILED CONVERTING }
  model AiModel {
    id String @id @default(uuid()) @db.Uuid
    name String
    version String?
    format ModelFormat
    source ModelSource
    status ModelStatus
    filePath String @unique          // relative to MODELS_DIR, "/" separators
    originalName String
    sha256 String? @unique           // null only while CONVERTING
    sizeBytes BigInt?
    classNames Json?                 // string[] after validation
    validation Json?                 // { ok, latencyMs?, device?, error?, at }
    convertedFromId String? @db.Uuid
    createdById String? @db.Uuid
    notes String?
    createdAt DateTime @default(now()) @db.Timestamptz(3)
    updatedAt DateTime @updatedAt @db.Timestamptz(3)
  }
  ```
- `MODELS_DIR` layout: `inbox/` (drop zone), `registry/<id>.<ext>` (registered files), and top-level files
  from `tools/fetch_models.py` (built-ins). On start the API creates `inbox/` and `registry/` and runs a
  rescan. Errors there are logged, never fatal.
- Produces (`ModelView` = the row with `sizeBytes` as a number):
  ```
  GET    /api/v1/models          MANAGER    → ModelView[], newest first
  GET    /api/v1/models/:id      MANAGER
  POST   /api/v1/models          SUPERADMIN multipart: file (required), name?, version?, notes?
                                 → 201 ModelView (VALIDATING once the job is queued; UPLOADED if Redis refused)
  POST   /api/v1/models/rescan   SUPERADMIN → { added: ModelView[], skipped: { file, reason }[] }
  DELETE /api/v1/models/:id      SUPERADMIN → 204; 409 when an enabled or disabled camera uses it
  Redis model:jobs LPUSH {"type":"validate","modelId":id,"path":filePath}
  ModelsService.enqueueValidation(id: string): Promise<void>   // sets VALIDATING after the LPUSH succeeds
  ```
- Upload rules:
  - The file name must end in `.onnx` (any case), and the first byte must be `0x08`. Otherwise 400 with the
    message "Only ONNX models can be uploaded. Copy .pt or .engine files into the inbox folder on the
    server and press Rescan.".
  - The file streams to `registry/.upload-<uuid>`. The SHA-256 is computed from the file, which is then
    renamed to `registry/<id>.onnx`.
  - Above `MODEL_UPLOAD_MAX_BYTES` → 413. The same SHA-256 as a registered model → 409 naming that model.
  - On every failure the temp file is removed and no row is written.
- Rescan rules:
  - `inbox/*.{onnx,pt,engine}` move to `registry/<id>.<ext>` with source `FILESYSTEM`.
  - Top-level `*.{onnx,pt,engine}` not yet registered by `filePath` are registered in place with source
    `BUILTIN`.
  - A SHA-256 already registered → skipped with reason `same file as <name>`; the inbox file stays.
  - Other files are ignored. Every added model gets a validation job.
- "In use": a camera's active settings, after `withDefaults`, have `model_id` = id, or the model is a
  top-level file and `model_name` equals its `filePath`.
- Delete removes the row, then the file (a missing file is ignored).
- Audit actions: `model.upload`, `model.rescan` (after: the added names), `model.delete`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/models.e2e-spec.ts (MODELS_DIR is a fresh temp folder; ONNX = Buffer.from([0x08, 0x07, 0x12, 0x00]))
it('SUPERADMIN uploads x.onnx → 201 VALIDATING; registry/<id>.onnx holds the bytes; model:jobs has the validate job; audit model.upload')
it('x.pt → 400 with the inbox hint; no row; registry/ holds no file')
it('x.onnx starting with PK\\x03\\x04 → 400; the temp file is gone')
it('a file over MODEL_UPLOAD_MAX_BYTES (set to 1024 for this app) → 413; registry/ holds no file; no row')   // Review Focus 5
it('the same bytes twice → 409 naming the first model')
it('MANAGER POST → 403; MANAGER GET /models → 200; USER GET → 403')
it('rescan: inbox a.pt, b.onnx, notes.txt and top-level yolo11s.onnx → 3 added (PT/FILESYSTEM, ONNX/FILESYSTEM, ONNX/BUILTIN); inbox keeps only notes.txt')
it('rescan again adds nothing; a copy of a.pt dropped in the inbox is skipped with "same file as a.pt"')
it('delete while a camera has model_name "yolo11s.onnx" → 409; an unused model → 204 and its file is gone')
```

`model-files.spec.ts`: `isOnnxHeader` (`0x08` → true; `PK`, `0x80` and empty → false), and
`registryPath(id, ext)`.

- [ ] **Step 2: Run them to see them fail**

Run: `npm run test:e2e -- models`. Expected: FAIL (404).

- [ ] **Step 3: Implement the migration, the module and the start-up rescan**

- [ ] **Step 4: Deploy docs**

`deploy/README.md`: the models folder layout, and that the API container runs as uid 1000, so
`sudo chown -R 1000:1000 "$ZOO_DATA_DIR/models"` after `fetch_models.py`. To add a `.pt` or `.engine`
model, copy it into `models/inbox/` and press Rescan.

- [ ] **Step 5: Run everything**

Run: `npm run lint && npm run build && npm test && npm run test:e2e`. Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api deploy
git commit -m "feat(api): AI model registry with ONNX upload, inbox rescan, in-use checks and validation jobs"
```

---

### Task 6: API: validation and conversion results, and `model_id` in camera settings

**Files:**
- Modify: `apps/api/src/models/{models.service.ts,models.controller.ts,dto/model.dto.ts}`
- Modify: `apps/api/src/engine-internal/{engine-internal.controller.ts,engine-cameras.service.ts}`
- Modify: `apps/api/src/cameras/{config-versions.service.ts,cameras.service.ts,cameras.module.ts}`
- Test: extend `test/models.e2e-spec.ts`, `test/engine-internal.e2e-spec.ts`, `test/camera-config.e2e-spec.ts`

**Interfaces:**
- Produces:
  ```
  POST /api/v1/models/:id/validate  SUPERADMIN → 202 ModelView (VALIDATING, job queued); 409 while CONVERTING
  POST /api/v1/models/:id/convert   SUPERADMIN body { imgsz?: number | [number, number] } (32..4096, multiples of 32)
     → 202 { source: ModelView, target: ModelView }; 409 unless the source is format PT and READY
     target row: format ONNX, source CONVERTED, status CONVERTING, filePath registry/<newId>.onnx,
                 convertedFromId = source id, name "<source name> (ONNX)"
     job: {"type":"convert","modelId":<source>,"targetId":<new>,"path":<source filePath>,
           "outPath":"registry/<newId>.onnx","imgsz":<imgsz or 640>}
  POST /internal/engine/models/:id/validation   {ok: true, classNames: string[], latencyMs: number, device: string}
                                              | {ok: false, error: string}
     → 204 while VALIDATING: READY (classNames, validation {ok, latencyMs, device, at}) or
       FAILED (validation {ok: false, error, at}); 409 in any other status (the row is unchanged)
  POST /internal/engine/models/:id/conversion   {ok: true, path: string, sha256: string} | {ok: false, error: string}
     → 204 while CONVERTING: ok → path must equal the row's filePath; sizeBytes from the file;
       a sha256 already registered → FAILED "duplicate of <name>"; else VALIDATING and a validate job.
       not ok → FAILED with the error. 409 in any other status
  ModelsService.assertSelectable(modelId: string | undefined, previousModelId: string | undefined): Promise<void>
     // throws 400 {message, errors: [{path: '/model_id', message}]} unless modelId is undefined,
     // equals previousModelId, or names a READY model
  ModelsService.resolvePath(modelId: string): Promise<string | null>   // filePath of that row, any status
  ```
- Camera create and config save call `assertSelectable(settings.model_id, previous active
  settings.model_id)`.
- `EngineCamera.model.path`: when `model_id` resolves, the row's `filePath`; otherwise `model_name`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/models.e2e-spec.ts
it('a validation report {ok: true} makes the model READY with classNames; a second report → 409 and nothing changes')
it('a validation report {ok: false} makes it FAILED with the error')
it('convert: a READY .pt (rescanned, then reported valid) → target CONVERTING and a convert job; a conversion report (file written at outPath first) → target VALIDATING and a validate job')
it('convert on an ONNX model → 409; MANAGER → 403; a failed conversion → target FAILED')
it('engine report routes need the engine token')
```

```ts
// test/camera-config.e2e-spec.ts
it('saving model_id of a VALIDATING model → 400 at /model_id; of a READY model → 201')
it('a MANAGER sending model_id → 403 (x-minRole)')
it('keeping an unchanged model_id is accepted after the model was revalidated to FAILED')
```

```ts
// test/engine-internal.e2e-spec.ts
it("model.path is the AiModel's registry path when model_id is set, else model_name")
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run test:e2e -- models camera-config engine-internal`. Expected: FAIL.

- [ ] **Step 3: Implement the endpoints, the checks and the resolution**

- [ ] **Step 4: Run everything**

Run: `npm run lint && npm run build && npm test && npm run test:e2e`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): model validation and conversion results, model_id selection in camera settings"
```

---

### Task 7: API: exactly-once ingest across an outage, and logged database faults

**Files:**
- Create: `apps/api/test/ingest-outage.e2e-spec.ts`
- Modify: `apps/api/src/prisma/transient.filter.ts`, `transient.filter.spec.ts`

**Interfaces:**
- `TransientDbFilter` logs every transient error with `Logger.error` as
  `database unavailable (<code>): <message>`, where `<code>` is the SQLSTATE or the Prisma code. The 503
  body stays as it is.

- [ ] **Step 1: Write the tests**

```ts
// test/ingest-outage.e2e-spec.ts (reuse the helpers of ingest.e2e-spec.ts: xadd, eventMsg, openMsg, closeMsg, drained)
it('entries read while Postgres is unreachable land exactly once after recovery', async () => {
  // app A: INGEST on, DATABASE_URL port 1. XADD 3 events, one interval open and its close.
  // Wait until group api has 5 pending entries and A has logged a failure, then close A.
  // app B: INGEST on, real database → drained() →
  //   Event count 3 with the sent ids, the interval closed with endReason "ended",
  //   DeadEvent count 0, HLEN ingest:failures 0.
  // XADD the same 5 messages again → drained() → still 3 events and 1 interval.
});
it('a revoked grant holds entries until the grant is back, then they land once', async () => {
  // ownerQuery('REVOKE INSERT ON "Event" FROM zoo_api'); app INGEST on; XADD 2 events;
  // wait for an "ingest failed" error log → pending 2, DeadEvent 0;
  // ownerQuery('GRANT INSERT ON "Event" TO zoo_api') → drained() → 2 events, DeadEvent 0.
  // The GRANT also runs in a finally block: TRUNCATE between tests does not restore grants.
});
```

`transient.filter.spec.ts`: a P1001 error is logged once, with `P1001` in the message, and the reply is
still 503 `Service unavailable`.

- [ ] **Step 2: Run them**

Run: `npm test -- transient.filter && npm run test:e2e -- ingest-outage`. Expected: the filter test FAILS
(nothing is logged). The outage tests should already pass, because they pin existing behaviour. If one
fails, it is a Phase 1 ingest bug: stop and fix it with superpowers:systematic-debugging before going on.

- [ ] **Step 3: Add the log line to the filter, then run everything**

Run: `npm run lint && npm run build && npm test && npm run test:e2e`. Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "test(api): exactly-once ingest across a database outage; log transient database errors"
```

---

### Task 8: Engine: environment config, masked stream URLs, reconnect backoff

**Files:**
- Create: `services/engine/core/env.py`
- Modify: `services/engine/core/stream_manager.py`
- Test: `services/engine/tests/test_env.py`, `tests/test_stream_manager.py`

**Interfaces:**
- Produces, `core/env.py`:
  ```python
  GROUP_PATTERN = re.compile(r"^[a-z0-9_-]{1,32}$")
  class EnvError(ValueError): ...
  @dataclass(frozen=True)
  class EngineEnv:
      redis_url: str            # REDIS_URL, required, redis:// or rediss://
      api_url: str              # API_URL, default http://127.0.0.1:3001
      engine_token: str         # ENGINE_TOKEN, required, ≥ 32 chars
      engine_group: str         # ENGINE_GROUP, default "default", must match GROUP_PATTERN
      device: str               # DEVICE, default "cpu"
      models_dir: str           # ZOO_MODELS_DIR, default "models"
      snapshot_dir: str         # SNAPSHOT_DIR, default "snapshots"
      snapshot_retention_days: int  # SNAPSHOT_RETENTION_DAYS, default 30, ≥ 0
      preview_host: str         # PREVIEW_HOST, default 127.0.0.1
      preview_port: int         # PREVIEW_PORT, default 8000, 0 = off
      preview_api_key: str      # PREVIEW_API_KEY, default ""
      max_batch: int            # ENGINE_MAX_BATCH, default 1, 1..16
      model_jobs: bool          # ENGINE_MODEL_JOBS, on|off, default on
  def load_env(source: Mapping[str, str] | None = None) -> EngineEnv   # one EnvError naming every bad variable, never a value
  ```
- Produces, `core/stream_manager.py`: `def mask_url(url: str) -> str`. For example,
  `rtsp://user:pass@host:554/p` becomes `rtsp://***@host:554/p`. A URL without credentials and a file path
  are returned unchanged. Every log line that names the source uses it.
- Reconnect waits 2, 4, 8, 16, 30, 30, … s, and goes back to 2 s after a successful read. A file source
  still loops at its end, as today.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_env.py
def test_defaults():
    env = load_env({"REDIS_URL": "redis://localhost:6379/0", "ENGINE_TOKEN": "x" * 32})
    assert (env.engine_group, env.api_url, env.max_batch, env.model_jobs, env.preview_port) == (
        "default", "http://127.0.0.1:3001", 1, True, 8000)

def test_every_bad_variable_is_named_without_its_value():
    with pytest.raises(EnvError) as e:
        load_env({"REDIS_URL": "http://x", "ENGINE_TOKEN": "short-secret", "ENGINE_GROUP": "Bad Group",
                  "ENGINE_MAX_BATCH": "0"})
    msg = str(e.value)
    for name in ("REDIS_URL", "ENGINE_TOKEN", "ENGINE_GROUP", "ENGINE_MAX_BATCH"):
        assert name in msg
    assert "short-secret" not in msg and "Bad Group" not in msg
```

```python
# tests/test_stream_manager.py (cv2.VideoCapture replaced by a fake that never opens; time.sleep recorded)
@pytest.mark.parametrize("url, masked", [
    ("rtsp://admin:s3cret@10.0.0.5:554/main", "rtsp://***@10.0.0.5:554/main"),
    ("rtsp://10.0.0.5/main", "rtsp://10.0.0.5/main"),
    ("sample_data/cars.mp4", "sample_data/cars.mp4"),
])
def test_mask_url(url, masked): assert mask_url(url) == masked

def test_logs_never_contain_the_password(caplog, failing_capture): ...
    # start and stop StreamManager("rtsp://admin:s3cret@127.0.0.1:1/x", "cam_x", 5) after a few reconnects
    # → "s3cret" not in caplog.text

def test_reconnect_backoff_doubles_to_30_s(failing_capture, sleeps): ...
    # the recorded reconnect waits start [2, 4, 8, 16, 30, 30]
```

- [ ] **Step 2: Run them to see them fail**

Run: `uv run pytest -q tests/test_env.py tests/test_stream_manager.py`. Expected: FAIL (`core.env` is
missing; the log contains the password).

- [ ] **Step 3: Implement `core/env.py`, `mask_url` and the backoff**

- [ ] **Step 4: Run the engine suite**

Run: `uv run pytest -q && uv run ruff check .`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add services/engine/core/env.py services/engine/core/stream_manager.py services/engine/tests
git commit -m "feat(engine): validated environment config, masked stream URLs, reconnect backoff"
```

---

### Task 9: Engine: the shared model pool

**Files:**
- Create: `services/engine/core/model_pool.py`
- Modify: `services/engine/core/model_store.py`, `services/engine/tests/conftest.py`
- Test: `services/engine/tests/test_model_pool.py`, `tests/test_model_store.py`

**Interfaces:**
- Produces:
  ```python
  class Detector(Protocol):          # what a pipeline holds as self.model
      names: dict[int, str]
      def __call__(self, source, **kwargs) -> list: ...   # same as YOLO.__call__ for one frame

  class ModelPool:
      def __init__(self, device: str, models_dir: str | None = None, *, max_batch: int = 1,
                   call_timeout: float = 30.0, loader: Callable[..., Any] | None = None)  # loader default: ultralytics.YOLO
      def acquire(self, path: str, imgsz: int | tuple[int, int]) -> Detector
      def release(self, detector: Detector) -> None
      def loaded(self) -> list[tuple[str, int | tuple[int, int]]]
      def close(self) -> None
  ```
- `resolve_model_path(name, models_dir)` (`core/model_store.py`) tries `<models_dir>/<name>` before
  `<models_dir>/<basename>`. Registry paths such as `registry/<id>.onnx` must keep their folder, and
  today's lookup drops it.
- `acquire` resolves `path` with `resolve_model_path(path, models_dir)`, and the key is
  `(resolved path, imgsz)`.
  - The first acquire of a key loads `loader(resolved, task="detect")`, blocking the caller, and starts
    that entry's inference thread. Later acquires of the key return a handle on the same entry.
  - A load error propagates, and the pool keeps nothing for that key.
  - `release` decrements the count. At zero, the thread stops and the model is dropped.
- A detector call queues `(frame, kwargs)` and waits for its result. The entry's thread takes consecutive
  queued requests with equal kwargs, up to `max_batch`, calls `model([frames...], **kwargs)` once, and
  hands request *i* the list `[results[i]]`, so `detector(frame, ...)[0]` works as before.
  - An exception goes to every request in that batch.
  - No answer within `call_timeout` raises `TimeoutError`.
  - The model object is only ever called from its entry's thread.
- `conftest.py`, `FakeYOLO`:
  - counts constructions (`loads`), and records each call's batch size (`batches`) and keyword arguments
    (`kwargs`);
  - fails a test if two calls overlap;
  - raises `FileNotFoundError` for a model name containing `missing`;
  - has two class-level `threading.Event`s, set by default: `gate`, which `__call__` waits on, and
    `load_gate`, which construction waits on.

  The `fake_yolo` fixture resets all of these. A new fixture `fake_pool` gives
  `ModelPool("cpu", loader=FakeYOLO)` with `core.model_pool.resolve_model_path` patched to return the
  name.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_model_store.py
def test_registry_paths_keep_their_folder(tmp_path):
    (tmp_path / "registry").mkdir(); (tmp_path / "registry" / "a.onnx").write_bytes(b"\x08")
    assert resolve_model_path("registry/a.onnx", str(tmp_path)) == str(tmp_path / "registry" / "a.onnx")
```

```python
# tests/test_model_pool.py (the fake_pool fixture)
def test_same_key_shares_one_model_and_unloads_at_zero(fake_pool):
    pool = fake_pool
    a, b = pool.acquire("m.onnx", 640), pool.acquire("m.onnx", 640)
    assert FakeYOLO.loads == 1 and pool.loaded() == [("m.onnx", 640)]
    pool.release(a); assert pool.loaded()
    pool.release(b); assert pool.loaded() == []

def test_other_imgsz_is_another_model(): ...       # ("m.onnx", 640) and ("m.onnx", 1280) → loads == 2

def test_calls_from_many_threads_never_overlap(): ...
    # 4 threads × 20 calls → every caller gets its own result; FakeYOLO saw no overlap

def test_batches_equal_kwargs_up_to_max_batch(): ...
    # max_batch=3; FakeYOLO.gate cleared; 4 calls with conf=0.3 queued from threads; gate set
    # → FakeYOLO.batches == [1, 3] (the first call was in flight); each caller got its own frame's result

def test_unequal_kwargs_are_not_batched(): ...     # conf 0.3 and 0.5 queued → two calls

def test_load_error_keeps_nothing(): ...           # acquire("missing.onnx") raises FileNotFoundError; loaded() == []

def test_call_timeout(): ...                       # call_timeout=0.2, gate cleared → TimeoutError
```

- [ ] **Step 2: Run them to see them fail**

Run: `uv run pytest -q tests/test_model_pool.py tests/test_model_store.py`. Expected: FAIL
(`core.model_pool` is missing; the registry path resolves to the bare file name).

- [ ] **Step 3: Implement `core/model_pool.py` and the `resolve_model_path` change**

- [ ] **Step 4: Run the engine suite**

Run: `uv run pytest -q && uv run ruff check .`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add services/engine/core/model_pool.py services/engine/core/model_store.py services/engine/tests
git commit -m "feat(engine): shared model pool with one inference thread per model"
```

---

### Task 10: Engine: use case registry and typed settings in the pipelines

Behaviour stays the same in this task. Only where pipelines live and what they read changes. Task 11 adds
live changes.

**Files:**
- Move with `git mv`, from `pipelines/` to `usecases/<name>/pipeline.py`:
  - `cashier_presence_pipeline.py` → `cashier_presence`
  - `horse_riding_pipeline.py` → `horse_riding`
  - `restaurant_pipeline.py` → `restaurant_counter`
  - `table_occupancy_pipeline.py` → `restaurant_table`
  - `vehicle_gate_pipeline.py` → `vehicle_gate`
- Create: `services/engine/usecases/__init__.py` (registry) and `usecases/<name>/__init__.py`
- Modify: `services/engine/core/base_pipeline.py`, `core/table_manager.py` (it takes a plain dict, as
  today)
- Modify: `services/engine/main.py`. Remove the YAML camera loop; until Task 13, `main()` logs "the engine
  runs from the API (Phase 2, Task 13)" and returns 1.
- Modify: `services/engine/test_video.py`
- Delete: `services/engine/simulate_demo.py`, `services/engine/test_synthetic_demo.py`, `pipelines/`
- Modify: `services/engine/tests/{conftest.py,test_imports.py,test_pipeline_wiring.py,test_pipeline_messages.py}`

**Interfaces:**
- Consumes: `parse_settings` (Task 1), `Detector`, `ModelPool` (Task 9), builders with `config_version`
  (Task 2).
- Produces, `core/base_pipeline.py`:
  ```python
  @dataclass(frozen=True)
  class CameraInfo:
      id: str
      name: str
      nx_camera_id: str | None = None      # None → the zero UUID in Nx bookmark calls

  class BasePipeline(ABC):
      use_case: ClassVar[str] = ""
      metric_fields: ClassVar[dict[str, str]] = {}
      events: EventStream | None = None
      snapshots: SnapshotStore | None = None
      def __init__(self, camera: CameraInfo, settings: BaseModel, model: Detector, *, device: str = "cpu",
                   nx_client: NxClient | None = None, config_version: int | None = None)
      camera_id: str; camera_name: str; nx_camera_id: str | None
      settings: BaseModel; model: Detector; device: str; config_version: int | None
      live: dict                      # the latest emit_status payload (Task 13 publishes it)
      def shutdown(self, end_reason: str = "engine_stop") -> None
  ```
  - Every message the pipeline builds carries `config_version`.
  - `rule_config_path`, `roi`, `rules`, `_load_rules` and `_apply_inline_roi` are removed: the import tool
    already maps inline ROIs into settings.
  - `self.imgsz` is gone; calls pass `imgsz=self.settings.imgsz`.
  - Pipelines read every rule from `self.settings` (typed attributes). The code defaults inside
    `.get(...)` calls disappear, because the schema defaults equal them (Phase 1 rule).
- Produces, `usecases/__init__.py`:
  ```python
  def pipeline_class(use_case: str) -> type[BasePipeline]     # KeyError for an unknown use case
  def use_cases() -> list[str]                                 # sorted
  def create_pipeline(camera: CameraInfo, use_case: str, settings: BaseModel, model: Detector, **kwargs) -> BasePipeline
  ```
  Discovery imports `usecases.<name>.pipeline` for every subpackage and maps each `BasePipeline` subclass's
  `use_case` to it. Two classes for one use case are an error.
- `test_video.py`:
  - `--pipeline` names map to use cases (`gate|vehicle_gate`, `cashier`, `restaurant`,
    `horse|horse_riding`, `restaurant_table|table|tables`).
  - The rule YAML goes through `parse_settings(use_case, rules, strict=False)`. `--no-anpr`,
    `--hide-boxes` and `--show-boxes` set the settings fields (`anpr.enabled`, `show_boxes`,
    `show_labels`) before parsing.
  - The model comes from `ModelPool(device).acquire(settings.model_name, settings.imgsz)`.
  - `--analytics` sends with engine group `test_video` (Phase 1 follow-up), never `ENGINE_GROUP`.
- `conftest.py`:
  - `example_settings(use_case)` → `parse_settings(use_case, <examples/settings/valid/current_rules.json>,
    strict=False)`.
  - `make_pipeline(use_case, settings=None, stream=None)` builds through the registry with a `FakeYOLO()`
    as the model.

- [ ] **Step 1: Port the tests first**

`test_pipeline_wiring.py` becomes:

```python
def test_registry_covers_every_assignable_use_case():
    assert use_cases() == sorted(u for u, c in REGISTRY.items() if c.settings)

@pytest.mark.parametrize("use_case", sorted(u for u, c in REGISTRY.items() if c.settings))
def test_pipeline_processes_frames(fake_yolo, use_case):
    p = make_pipeline(use_case)
    for ts in (0, 200):
        out = p.run(FRAME.copy(), ts)
        assert out.shape == FRAME.shape and out.dtype == np.uint8

def test_gate_without_plate_model_runs_without_anpr(fake_yolo, monkeypatch, tmp_path): ...   # as today, via settings

def test_messages_carry_the_config_version(fake_yolo, stream):
    p = make_pipeline("restaurant_table", stream=stream); p.config_version = 4
    p._handle_table_event("table_state_change", table_change("OCCUPIED"), "info")
    assert stream.sent[0]["configVersion"] == 4
```

`test_pipeline_messages.py` keeps its five tests and builds pipelines with `make_pipeline`.
`test_imports.py` drops the two deleted scripts and lists `usecases.*.pipeline`.

- [ ] **Step 2: Run them to see them fail**

Run: `uv run pytest -q`. Expected: FAIL (`usecases` is missing).

- [ ] **Step 3: Move the files, add the registry, convert `BasePipeline` and the five pipelines, update
  `test_video.py` and `main.py`**

- [ ] **Step 4: Run the engine suite and one video**

Run: `uv run pytest -q && uv run ruff check .`. Expected: all pass. Then run
`uv run python test_video.py --video sample_data/cars.mp4 --pipeline gate --no-anpr --no-gui --duration 10 --infer-fps 1`.
Expected: it runs to the end and logs crossings, as before.

- [ ] **Step 5: Commit**

```bash
git add -A services/engine
git commit -m "refactor(engine): use case registry, pipelines in usecases/<name>/ with typed settings"
```

---

### Task 11: Engine: `apply_config` for every use case, and tables that keep their state

**Files:**
- Modify: `services/engine/core/base_pipeline.py`, `core/table_manager.py`, the five
  `usecases/*/pipeline.py`
- Test: `services/engine/tests/test_apply_config.py`, `tests/test_table_manager.py`

**Interfaces:**
- Produces, `BasePipeline`:
  ```python
  def apply_config(self, settings: BaseModel, config_version: int | None) -> None
      # called between two frames: swaps self.settings and self.config_version, then calls
  def _on_settings(self, old: BaseModel, new: BaseModel) -> None   # subclass hook; base does nothing
  def set_model(self, model: Detector) -> Detector                 # swaps self.model, returns the previous one
  @staticmethod
  def changed(old: BaseModel, new: BaseModel, *fields: str) -> bool
  ```
  Thresholds, display flags and `nx_bookmark` are read from `self.settings` on every frame, so they apply
  without a hook. `model_name`, `model_id` and `imgsz` are the worker's business (Task 12). Geometry
  changes set a dirty flag. The zones are rebuilt at the start of the next `process_frame`, from the frame
  shape, the same way `_init_zones_if_needed` builds them today.
- What `_on_settings` rebuilds (change classes, spec section 1):

  | Use case | Fields | On change |
  |---|---|---|
  | horse_riding | `track_activation_thresh`, `lost_track_buffer`, `matching_thresh`, `frame_rate` | new ByteTrack (track ids restart) |
  | | `smoothing_frames` / `trace_length` | new smoother / new trace annotator |
  | | `tripwire`, `roi_polygon` | zones rebuilt next frame. Line counts are kept (the `set_tripwire` pattern). `tripwire.enabled` false drops the line |
  | vehicle_gate | tracker fields as above | new ByteTrack |
  | | `tripwire`, `roi_polygon` | zones rebuilt, counts kept |
  | | `anpr` | `AnprEngine` rebuilt now; the plate cache is kept |
  | cashier_presence | `clerk_zone`, `visitor_zone` | zones rebuilt. Presence timers and an open `desk_unattended` interval are kept |
  | restaurant_counter | `mode` | that mode's state resets: zones, line, count history, occupancy, tracker |
  | | `tracking_enabled`, `lost_track_buffer`, `smoothing_frames` | new tracker and smoother |
  | | `dining_zone`, `tripwire`, `shadow_zone` | zones rebuilt; line counts kept |
  | | `table_monitoring` | absent or `enabled` false: close every session (`config_change`), drop the engine. Otherwise `reconfigure` (or create) |
  | restaurant_table | `tables`, `dwell_time`, `show_overlay`, `show_labels`, `show_summary_card` | `reconfigure` |

- Produces, `core/table_manager.py`:
  ```python
  class TableOccupancyEngine:
      def reconfigure(self, config: dict) -> list[str]   # returns the ids of removed tables
  class TableSessions:
      def close(self, table_id: str, end_reason: str = "ended") -> None
      def close_all(self, end_reason: str) -> None
  ```
  - Tables whose id stays keep their `TableZone`. Name, polygon (the pixel cache resets), capacity and
    thresholds update; status, dwell and session count stay.
  - New ids start warming up. Their warm-up ends `empty_debounce_sec` after their first `update`. During
    it their state follows the detections, but `update` reports no transition for them.
  - Removed ids are dropped and returned. The pipeline closes their sessions with `config_change`.
  - The global dwell defaults and the presentation flags update too.
- `shutdown(end_reason)` passes its reason on to every interval close.

- [ ] **Step 1: Write the failing tests**

Frames are 1280×720, and `FakeYOLO.boxes` is set per frame (as in `test_pipeline_messages.py`). A person or
horse box that moves 20 px down per frame crosses a horizontal line.

```python
# tests/test_apply_config.py
def test_moving_the_horse_tripwire_keeps_counts_and_tracks(fake_yolo, stream): ...
    # tripwire y=0.6; a horse box walks down across it → line_zone.in_count == 1; tracker = p.tracker
    # apply_config(settings with tripwire y=0.8, enabled), version 2 → the same box keeps walking past 0.8
    # → in_count == 2, p.tracker is tracker, the horse_crossing events have configVersion 1 then 2

def test_tracker_tuning_builds_a_new_tracker(fake_yolo):           # lost_track_buffer 60 → 90: p.tracker is not old
def test_thresholds_apply_without_rebuilding(fake_yolo):           # confidence 0.35 → 0.5: tracker kept; FakeYOLO saw conf=0.5
def test_gate_tripwire_move_keeps_counts(fake_yolo, stream): ...   # as the horse test, anpr disabled
def test_cashier_zone_move_keeps_the_open_desk_interval(fake_yolo, stream): ...
    # desk_unattended opened (clerk absent 10 s); clerk_zone moved → no interval_close, no new open
def test_restaurant_table_change(fake_yolo, stream): ...
    # tables T1, T2 occupied (sessions open); new settings: T1 with a moved polygon, T2 removed, T3 new and occupied
    # → T2's session closed with endReason "config_change"; T1's session still open;
    #   no session opens for T3 during its warm-up; after warm-up, T3 going empty closes nothing
def test_disabling_table_monitoring_closes_every_session(fake_yolo, stream): ...   # restaurant_counter
def test_mode_change_resets_occupancy(fake_yolo): ...                              # restaurant_counter area → tripwire
def test_set_model_swaps_the_detector_and_keeps_the_tracker(fake_yolo): ...
def test_shutdown_reason_reaches_every_close(fake_yolo, stream): ...                # shutdown("config_change")
```

```python
# tests/test_table_manager.py
def test_reconfigure_keeps_state_by_id_and_returns_removed(): ...
def test_new_table_reports_no_transition_while_warming_up(): ...
def test_tables_at_construction_do_not_warm_up(): ...
```

- [ ] **Step 2: Run them to see them fail**

Run: `uv run pytest -q tests/test_apply_config.py tests/test_table_manager.py`. Expected: FAIL (no
`apply_config`).

- [ ] **Step 3: Implement the hooks per the table, and `reconfigure` with warm-up**

- [ ] **Step 4: Run the engine suite**

Run: `uv run pytest -q && uv run ruff check .`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add services/engine
git commit -m "feat(engine): apply_config per use case; tables keep their state across live changes"
```

---

### Task 12: Engine: camera workers, the supervisor's reconcile, and the watchdog

**Files:**
- Create: `services/engine/core/camera_config.py`, `core/worker.py`, `core/supervisor.py`
- Test: `services/engine/tests/test_worker.py`, `tests/test_supervisor.py`

**Interfaces:**
- Consumes: `parse_settings`, `ModelPool`, `create_pipeline`, `BasePipeline.apply_config` / `set_model` /
  `shutdown`, `StreamManager`, `mask_url`, `event_message`.
- Produces, `core/camera_config.py`:
  ```python
  class ApiError(Exception): ...        # the API could not give an answer (network, 4xx/5xx, bad body)
  @dataclass(frozen=True)
  class CameraConfig:
      id: str; name: str; use_case: str; version: int; settings: dict; source_url: str
      target_fps: int; model_path: str; imgsz: int | tuple[int, int]; nx_camera_id: str | None
      @classmethod
      def from_api(cls, entry: dict) -> "CameraConfig"   # an EngineCamera (Task 3); ValueError when malformed
  ```
- Produces, `core/worker.py`:
  ```python
  @dataclass
  class WorkerDeps:
      pool: ModelPool; events: EventStream | None; snapshots: SnapshotStore | None
      nx_client: NxClient; device: str
      stream_factory: Callable[..., Any] = StreamManager   # (source=, camera_id=, target_fps=) → start/stop/get_frame

  class CameraWorker:
      def __init__(self, config: CameraConfig, deps: WorkerDeps, *, clock: Callable[[], float] = time.time)
      id: str; config: CameraConfig; pipeline: BasePipeline | None
      state: str                 # starting | running | reconnecting | error | stopped
      applied_version: int | None; config_error: str | None; restarts: int
      started_at: float; last_frame_at: float | None; fps: float; latest_raw: np.ndarray | None
      def start(self) -> None
      def update(self, config: CameraConfig) -> None
      def stop(self, end_reason: str = "config_change", timeout: float = 10.0) -> None
      def stalled(self, now: float, after: float = 30.0) -> bool
  ```
  - `start()` runs the worker thread. The thread parses the settings strictly, acquires the detector, builds
    the pipeline, starts the stream, then loops. Each pass first applies every queued change, then takes a
    frame. A frame identical to the last one waits 10 ms, as in today's `camera_worker`.
  - A pipeline exception is logged, the frame is skipped, and the thread waits 1 s, as today.
  - `update(config)` runs in the caller's thread and never blocks on a model load:
    - `source_url` or `target_fps` changed → start a new stream, swap it in, stop the old one. The pipeline
      is kept.
    - `use_case` changed → parse the settings and load the model in a loader thread, then queue a rebuild.
      The old pipeline's `shutdown("config_change")` runs in the worker thread at the swap.
    - `version` changed → parse the settings. If `model_path` or `imgsz` changed, load the new detector in a
      loader thread first. Then queue `apply_config` (and `set_model`). The previous detector is released
      after the swap.
    - `name` or `nx_camera_id` changed → assigned between frames.
  - Every change gets a generation number. A loader that finishes after a newer generation was requested
    releases its detector and queues nothing.
  - A settings error or a model load error rejects that version:
    - `config_error = "v<version> rejected: <pointer>: <message>"` (500 characters at most);
    - one `config_rejected` system event per rejected version, with `cameraId` = the camera;
    - a running camera stays on its previous version and model; a new camera goes to state `error`
      without a stream.
  - `stop(end_reason)` ends the thread, calls `pipeline.shutdown(end_reason)`, stops the stream and
    releases the detector.
  - `stalled(now)` is true when the stream delivered a frame within `after` s, the worker started more
    than `after` s ago, and no frame was processed in the last `after` s.
- Produces, `core/supervisor.py`:
  ```python
  class Supervisor:
      def __init__(self, api, deps: WorkerDeps, *, worker_factory=CameraWorker, resync_sec: float = 60.0,
                   debounce_sec: float = 0.2, stall_sec: float = 30.0, clock=time.time,
                   on_stop: Callable[[str], None] = lambda camera_id: None)
          # api: an object with cameras() -> list[CameraConfig] that raises ApiError
          # on_stop: called with the camera id after a worker stopped (removed, replaced or shut down)
      workers: dict[str, CameraWorker]
      def pipelines(self) -> dict[str, BasePipeline]
      def reconcile(self, configs: list[CameraConfig]) -> None
      def sync(self) -> bool                     # fetch and reconcile; False on ApiError (logged once per outage)
      def request_sync(self) -> None             # thread-safe; runs a sync debounce_sec later, coalesced
      def check_stalls(self) -> None             # stop(end_reason="engine_stop") and restart stalled workers; restarts += 1
      def run(self, stop: threading.Event) -> None   # sync at once, then on request or every resync_sec; check_stalls every 1 s
      def shutdown(self) -> None                 # stop every worker with end_reason "engine_stop"
  ```
  `reconcile` starts the workers of new cameras, stops the ones no longer listed (`config_change`), and
  calls `update` on the rest. It never logs a source URL, except through `mask_url`.

- [ ] **Step 1: Write the failing tests**

Fakes:
- `FakeStream` serves scripted frames and counts its starts and stops;
- the `fake_pool` fixture (Task 9); `FakeYOLO.load_gate` holds a slow load, and `missing.onnx` fails to
  load;
- `RecordingStream` as `events`;
- `FakeApi`, whose `cameras()` returns a list or raises `ApiError`;
- `cfg(**over)`, which builds a `CameraConfig` for the `restaurant_table` example settings;
- `wait_until(cond)`, which polls up to 2 s.

```python
# tests/test_worker.py
def test_new_version_applies_between_frames_on_the_same_pipeline(): ...
    # w.update(cfg(version=2, settings=...)) → wait_until applied_version == 2; w.pipeline is the same object;
    # messages after the change carry configVersion 2
def test_source_change_restarts_only_the_stream(): ...        # streams started 2, stopped 1; pipeline is the same object
def test_use_case_change_rebuilds_and_closes_with_config_change(): ...
def test_invalid_version_keeps_the_previous_one_and_reports_once(): ...
    # v2 has tables[0].polygon [[0,0],[1,0]] → applied_version stays 1;
    # config_error starts "v2 rejected: /tables/0/polygon";
    # update(v2) again → still exactly one config_rejected event
def test_new_camera_with_invalid_settings_is_in_error_without_a_stream(): ...
def test_model_change_swaps_after_loading_and_releases_the_old_model(): ...   # pool.loaded() goes [A] → [A, B] → [B]
def test_superseded_model_load_is_discarded(): ...                            # Review Focus 2
    # v2 wants model B (loader gated), v3 wants model C; open the gate
    # → applied_version 3, the model is C, B is not in pool.loaded()
def test_model_load_error_keeps_the_running_model(): ...                       # v2 wants missing.onnx → config_error, still v1 on A
def test_stop_closes_intervals_with_the_reason(): ...
def test_stalled_only_when_frames_arrive_but_none_is_processed(): ...         # Review Focus 3
    # pipeline raising on every frame → stalled(now + 31) is True;
    # a stream that never delivers a frame → stalled(now + 31) is False
```

```python
# tests/test_supervisor.py
def test_reconcile_starts_new_stops_removed_and_updates_the_rest(): ...   # removed → its pipeline closes with config_change
def test_sync_failure_keeps_running_cameras(): ...                          # Review Focus 1: ApiError → workers unchanged
def test_first_sync_failure_starts_nothing_and_a_later_sync_starts_cameras(): ...   # Review Focus 1
def test_requests_inside_the_debounce_window_cause_one_sync(): ...         # 5 request_sync() within 50 ms → cameras() called once
def test_resync_runs_without_a_request(): ...                              # resync_sec=0.2 → cameras() called ≥ 2 times in 0.5 s
def test_stalled_worker_is_replaced(): ...                                 # stall_sec=0.3, a pipeline that always raises → new worker, restarts == 1
```

- [ ] **Step 2: Run them to see them fail**

Run: `uv run pytest -q tests/test_worker.py tests/test_supervisor.py`. Expected: FAIL (the modules are
missing).

- [ ] **Step 3: Implement `core/camera_config.py`, `core/worker.py` and `core/supervisor.py`**

- [ ] **Step 4: Run the engine suite 5 times** (it is concurrency code, so flakiness is a bug)

Run: `for i in 1 2 3 4 5; do uv run pytest -q tests/test_worker.py tests/test_supervisor.py || break; done && uv run pytest -q && uv run ruff check .`.
Expected: every run passes.

- [ ] **Step 5: Commit**

```bash
git add services/engine/core services/engine/tests
git commit -m "feat(engine): camera workers apply config between frames; supervisor reconcile and watchdog"
```

---

### Task 13: Engine: the API client, the change listener, status heartbeats and the new `main.py`

**Files:**
- Create: `services/engine/core/api_client.py`, `core/config_listener.py`, `core/status.py`
- Modify: `services/engine/main.py` (rewrite), `core/api_server.py`, `test_video.py`
- Delete: `services/engine/configs/app_config.yaml.example`
- Test: `services/engine/tests/test_api_client.py`, `tests/test_status_redis.py`,
  `tests/test_config_listener_redis.py`, `tests/test_main_redis.py`

**Interfaces:**
- Produces, `core/api_client.py`:
  ```python
  class EngineApi:
      def __init__(self, base_url: str, token: str, group: str, *, timeout: float = 5.0, session=None)
      def cameras(self) -> list[CameraConfig]       # GET /internal/engine/cameras?group=...
      def report_validation(self, model_id: str, body: dict) -> None    # POST /internal/engine/models/{id}/validation
      def report_conversion(self, model_id: str, body: dict) -> None    # POST /internal/engine/models/{id}/conversion
  ```
  - Every request sends `Authorization: Bearer <token>`.
  - Network errors, non-2xx answers and bad JSON raise `ApiError`. Its text holds neither the token nor a
    URL with credentials.
  - A malformed camera entry is skipped and logged by id.
- Produces, `core/config_listener.py`:
  `class ConfigListener(threading.Thread)` with
  `__init__(self, redis_client, on_change: Callable[[], None], *, channel: str = "cfg:changed")` and
  `stop()`. After every successful (re)subscribe it calls `on_change()`, and again for every message, whose
  content it ignores. On a connection error it reconnects with a 0.5 s backoff that doubles to 5 s.
- Produces, `core/status.py`:
  ```python
  class StatusPublisher(threading.Thread):
      def __init__(self, redis_client, workers: Callable[[], Iterable[CameraWorker]], *, engine_group: str,
                   boot_id: str, clock=time.time)
      def publish_status(self, now: float) -> None    # every 5 s
      def publish_frames(self, now: float) -> None    # every 2 s
      def forget(self, camera_id: str) -> None        # DEL cam:{id}:status (the supervisor calls it on stop)
  ```
  - Each status write is one pipeline: `HSET` of the Task 4 fields, then `PEXPIREAT` at
    `max(last_frame_at, started_at) + 15 s`. When that moment has passed, nothing is written.
  - `state` is `reconnecting` while the worker is `running` but its last frame is more than 5 s old.
  - `live` is `json.dumps(pipeline.live)`.
  - Frames: `SET cam:{id}:frame <jpeg> PX 10000` when the worker holds a raw frame newer than the last one
    published.
- `core/api_server.py`: `create_app(pipelines: Callable[[], Mapping[str, BasePipeline]], snapshots,
  api_key)`. Every route reads `pipelines()` once per request.
- `main.py`:
  ```python
  def run(env: EngineEnv, stop: threading.Event, *, loader=None, preview: bool = False) -> None
  def main(argv: list[str] | None = None) -> int     # --preview shows OpenCV windows; 2 on EnvError
  ```
  `run` does this, in order:
  1. `load_env()`, a boot id and Redis clients.
  2. `EventStream(engine_group=…)`, then `engine_started`.
  3. `SnapshotStore`, `ModelPool(env.device, env.models_dir, max_batch=env.max_batch, loader=loader)` and
     `NxClient(mock_mode=True)`.
  4. `EngineApi`, the `Supervisor` (`on_stop` calls `StatusPublisher.forget`),
     `ConfigListener(on_change=supervisor.request_sync)`, the `StatusPublisher`, and the preview server
     when `env.preview_port`.
  5. `supervisor.run(stop)`.
  6. At exit, in order: `supervisor.shutdown()`, stop the listener and publisher, `pool.close()`,
     `snapshots.stop()`, `events.stop()`.

  SIGINT and SIGTERM set `stop`. Task 14 adds model jobs to `run`.
- `test_video.py --analytics` passes `lambda: {pipeline.camera_id: pipeline}` to `create_app`, and reads
  `SNAPSHOT_DIR`, `PREVIEW_*` from the environment with the Task 8 defaults.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_api_client.py (a ThreadingHTTPServer fixture that serves canned answers and records requests)
def test_cameras_sends_the_token_and_group_and_parses_entries(): ...
def test_a_malformed_entry_is_skipped(): ...
@pytest.mark.parametrize("answer", [500, 401, "not json", "refused"])
def test_failures_raise_api_error_without_the_token(answer): ...   # "secret-token" not in str(error)
def test_reports_post_json(): ...
```

```python
# tests/test_status_redis.py (skipped without REDIS_URL; fake workers)
def test_status_hash_fields_and_expiry_anchored_at_the_last_frame(): ...
    # last frame 3 s ago → HGETALL has the Task 4 fields; PTTL between 11_000 and 12_000
def test_state_is_reconnecting_after_5_s_without_a_frame(): ...
def test_nothing_is_written_15_s_after_the_last_frame(): ...      # the key is gone after a publish_status
def test_frame_is_a_jpeg_with_a_10_s_ttl(): ...                   # GET starts with b"\xff\xd8"; PTTL ≤ 10_000
def test_forget_deletes_the_status(): ...
```

```python
# tests/test_config_listener_redis.py (skipped without REDIS_URL)
def test_subscribe_triggers_a_sync_and_every_notice_another(): ...
def test_a_dropped_connection_resubscribes_and_triggers_a_sync(): ...   # Review Focus 4: CLIENT KILL TYPE pubsub
```

```python
# tests/test_main_redis.py (skipped without REDIS_URL; FakeYOLO loader; a fake API on a free port)
def test_one_file_camera_runs_and_reports_its_version(tmp_path): ...
    # the fake API serves cam_main_test: vehicle_gate, version 1, sourceUrl sample_data/cars.mp4,
    # targetFps 2, settings = the filled example with anpr.enabled false, model {path: "x.onnx", imgsz: 640};
    # ZOO_MODELS_DIR=tmp_path holding an empty x.onnx (the pool resolves real paths here)
    # run(env, stop) in a thread → within 10 s cam:cam_main_test:status has appliedVersion "1"
    # and state "running"; the fake API returns version 2 and the test PUBLISHes cfg:changed
    # → appliedVersion "2" within 2 s; stop → the thread ends within 15 s
```

- [ ] **Step 2: Run them to see them fail**

Run, with a Redis: `docker run -d --rm --name zoo-redis-test -p 6381:6379 redis:7.4.11-alpine`, then
`REDIS_URL=redis://localhost:6381/0 uv run pytest -q tests/test_api_client.py tests/test_status_redis.py tests/test_config_listener_redis.py tests/test_main_redis.py`.
Expected: FAIL (the modules are missing).

- [ ] **Step 3: Implement the three modules, `main.py`, and the `api_server` and `test_video` changes;
  delete `app_config.yaml.example`**

- [ ] **Step 4: Run the engine suite with Redis**

Run: `REDIS_URL=redis://localhost:6381/0 uv run pytest -q && uv run ruff check .`, then
`docker stop zoo-redis-test`. Expected: all pass, and no Redis test is skipped.

- [ ] **Step 5: Commit**

```bash
git add -A services/engine
git commit -m "feat(engine): config from the API, cfg:changed listener, status heartbeats and frames"
```

---

### Task 14: Engine: model validation and conversion jobs

**Files:**
- Create: `services/engine/core/model_jobs.py`
- Modify: `services/engine/main.py` (start `ModelJobs` when `env.model_jobs`), `pyproject.toml` (add
  `onnxslim`, commented "declared so Ultralytics never pip-installs it at runtime"), `uv.lock`
- Test: `services/engine/tests/test_model_jobs.py`, `tests/test_model_jobs_redis.py`

**Interfaces:**
- Consumes: the jobs from Tasks 5 and 6, and `EngineApi.report_validation` / `report_conversion`.
- Produces:
  ```python
  def validate_model(path: str, device: str, *, loader=None) -> dict
      # {"ok": True, "classNames": [names in id order], "latencyMs": median of 3 timed calls after 1 warm-up,
      #  "device": device} | {"ok": False, "error": "<type>: <message>" (≤ 500 chars)}
  def convert_to_onnx(src: str, out: str, imgsz, *, loader=None) -> dict
      # loader(src).export(format="onnx", imgsz=imgsz, dynamic=True, half=False, opset=19, simplify=True),
      # then os.replace(exported, out) → {"ok": True, "sha256": hex} | {"ok": False, "error": ...}
  class ModelJobs(threading.Thread):
      def __init__(self, redis_client, api: EngineApi, models_dir: str, device: str, *, loader=None,
                   queue: str = "model:jobs")
      def handle(self, job: dict) -> None
      def stop(self) -> None
  ```
  - The loop runs `BRPOP queue 5`. A job that isn't valid JSON, or has an unknown type, is logged and
    dropped. A report that fails with `ApiError` is logged; the API's state shows the job unfinished, and
    the user retries with Validate.
  - Paths in jobs are relative to `models_dir`. The validate frame is zeros at the model's imgsz or 640.
    The conversion report's `path` is the job's `outPath`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_model_jobs.py (FakeYOLO loader; FakeYOLO.export writes "<stem>.onnx" next to the source and returns its path)
def test_validate_reports_classes_and_latency(): ...   # ok, classNames[0] == "person", latencyMs ≥ 0, device "cpu"
def test_validate_reports_a_load_error(): ...          # loader raises → ok False, the error names the exception
def test_convert_moves_the_export_to_out_path_and_hashes_it(tmp_path): ...
def test_handle_routes_jobs_and_reports(): ...         # validate → report_validation(modelId, …); convert → report_conversion(targetId, {ok, path: outPath, sha256})
def test_bad_jobs_are_dropped(caplog): ...             # "nope", {"type": "x"} → no report, logged
```

```python
# tests/test_model_jobs_redis.py (skipped without REDIS_URL)
def test_a_queued_job_is_taken_once(): ...             # two ModelJobs threads, one LPUSH → exactly one report
```

- [ ] **Step 2: Run them to see them fail**

Run: `uv run pytest -q tests/test_model_jobs.py`. Expected: FAIL (`core.model_jobs` is missing).

- [ ] **Step 3: Implement, add `onnxslim` (`uv add onnxslim`), and wire it into `main.run`**

- [ ] **Step 4: Run the engine suite with Redis**, as in Task 13. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add services/engine
git commit -m "feat(engine): model validation and ONNX conversion jobs from the model:jobs queue"
```

---

### Task 15: Deploy, docs and the end-to-end run

**Files:**
- Modify: `deploy/docker-compose.yml`:
  - `api`: `JOBS: "on"`.
  - `zoo-ai-engine`: `API_URL=http://127.0.0.1:3001`, `ENGINE_TOKEN=${ENGINE_TOKEN}`, `DEVICE=cuda:0`,
    `ZOO_MODELS_DIR=/app/models`, `SNAPSHOT_DIR=/app/snapshots`. Remove the `configs` volume; keep models
    read-write.
  - Header comments.
- Modify: `deploy/.env.example`, `deploy/README.md`, `docs/10_LOCAL_QUICKSTART.md`,
  `services/engine/README.md`, `apps/api/README.md`. CI needs no change: the engine workflow already
  covers `services/engine/**` with a Redis service, and Task 1 updated the contracts workflow.

**Docs content:**
- `services/engine/README.md`:
  - the environment variables (Task 8 table);
  - the engine gets its cameras from the API; there is no YAML;
  - `test_video.py` still takes a rule YAML;
  - `usecases/<name>/` and how to add a use case: a contract folder, then `usecases/<id>/pipeline.py`.
- `docs/10_LOCAL_QUICKSTART.md`:
  - The API and the engine share one models folder. Fetch into `deploy/data/models` and set
    `ZOO_MODELS_DIR` for the engine to that folder.
  - Add cameras with `tools/import_yaml_config.py`, as today.
  - A light run: PATCH `enabled: false` on all but one camera, then
    `uv run python main.py` with `REDIS_URL`, `ENGINE_TOKEN`, `API_URL` set.
  - Status: `curl /api/v1/camera-status`.
  - The dashboard's live preview still comes from the engine on :8000.
  - Remove every mention of `app_config.yaml` and `--cameras-config`.
- `deploy/README.md`: `ENGINE_TOKEN`, `JOBS`, the models folder (Task 5), and that an engine service for a
  second group sets its own `ENGINE_GROUP` and `ENGINE_MODEL_JOBS=off`.

- [ ] **Step 1: Update compose, the env example and the docs as above**

- [ ] **Step 2: Rebuild the API stack**

Run, in `deploy/`: `docker compose up -d --build postgres redis api-migrate api`.
Expected: `api-migrate` exits 0, and `curl -s http://127.0.0.1:3001/api/health` is ok.

- [ ] **Step 3: The one-camera laptop run** (with the user watching; spec verifications 1–4, 10 on CPU)

Prepare:
- `ENGINE_TOKEN` in `deploy/.env` (`openssl rand -hex 32`).
- The models in `deploy/data/models`: copy `yolo26s.onnx` and `yolo11s.pt` from
  `services/engine/models/`, not all six. On its first start the API queues a validation for every model
  file it finds.
- One enabled camera, the gate: `sourceType FILE`, `mainStreamUrl sample_data/cars.mp4` (the only video
  in the repo), `targetFps` 1, settings `model_name yolo26s.onnx`, `imgsz` 640, `anpr.enabled` false.
  The example uses the large `yolo26l.onnx`, and ANPR runs OCR on every vehicle; both are too heavy for
  this laptop.

Start the engine from source with `REDIS_URL`, `ENGINE_TOKEN`, `API_URL`, `ZOO_MODELS_DIR` and
`ENGINE_MODEL_JOBS=off`. Restart it with `ENGINE_MODEL_JOBS=on` for row e only, so model validations
and the conversion don't compete with the camera before that.

| # | Do | Expected |
|---|---|---|
| a | `GET /api/v1/camera-status` | the camera `online`, `appliedVersion` = `activeVersion` |
| b | save the config with the tripwire moved | `appliedVersion` follows within ~1 s; no "Connecting to stream" line in the engine log |
| c | save a polygon with two points | 400 from the API; the engine keeps running the previous version |
| d | PATCH the camera's `mainStreamUrl` to `sample_data/missing.mp4` | about 15 s later the camera is offline and an open `camera_offline` interval exists. PATCH it back → closed with `online` |
| e | restart the engine with `ENGINE_MODEL_JOBS=on`. Move `yolo11s.pt` into `inbox/`, then `POST /models/rescan` | it becomes READY. `POST /models/:id/convert` → a new ONNX row becomes READY after a minute or two of full CPU. Set it as `model_id` → the camera switches without a stream reconnect |
| f | upload a `.pt` through `POST /models` | 400 |
| g | stop the engine with Ctrl+C, start it again | the open intervals closed with `engine_stop`; the camera back within seconds |

- [ ] **Step 4: Run every suite**

Run:
- `cd packages/contracts && npm test && npm run check`;
- `cd apps/api && npm run lint && npm run build && npm test && npm run test:e2e`;
- `cd services/engine && REDIS_URL=… uv run pytest -q && uv run ruff check .`.

Expected: all pass.

- [ ] **Step 5: Commit, then ask before pushing**

```bash
git add deploy docs/10_LOCAL_QUICKSTART.md services/engine/README.md apps/api/README.md
git commit -m "docs(deploy): Phase 2 engine environment, shared models folder, live config quickstart"
```

Ask the user to approve `git push -u origin phase-2-live-config`. After the push, give the compare link
for the pull request.
