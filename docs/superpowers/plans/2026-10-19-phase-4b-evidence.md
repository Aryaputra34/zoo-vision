# Zoo Vision Phase 4b (Evidence and Exports), Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native: the session implements every task itself, no per-task subagents) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Important events keep their clip after the continuous recording rolls over, and a kept clip plays with
byte ranges (Safari). Snapshots, kept clips, export files and the recordings of deleted cameras are cleaned on
schedule; the disk warns at 85% and 95%. A PDF summary is made in the background through Gotenberg. The site's
time zone and retention defaults live in a `SiteSettings` row edited in the web UI. Ends with tag `contract-v0.6`.

**Architecture:** One migration adds `SiteSettings`, `Evidence`, `ExportJob` and `Camera.evidenceRetentionDays`.
A global `SiteSettingsService` holds the row in memory and replaces `env.SITE_TIMEZONE` everywhere. Ingest adds an
`Evidence` row in the event's transaction; a pin tick (10 s, `JOBS=on`) copies the clip from MediaMTX playback into
`EVIDENCE_DIR` through one playback function shared with the live clip route. `RetentionJob` (hourly), `DiskJob`
(5 min) and the PDF tick (5 s) follow `OfflineJob`'s pattern: Postgres rows, a `running` flag, a public `tick()`.

**Tech Stack:** as in Phase 4a (Node 22, NestJS 11, Express 5, Prisma 7, ioredis, socket.io, ajv, Jest + supertest
+ Testcontainers), MediaMTX 1.21.1 playback, Gotenberg 8 (`/forms/chromium/convert/html`). No new npm
dependencies: `fetch`, `FormData`, `Blob`, `fs.statfs` are Node 22.

**Spec:** `docs/superpowers/specs/2026-10-19-phase-4b-evidence-design.md` (approved), which refines the parent spec
`docs/superpowers/specs/2026-10-08-zoo-vision-production-architecture-design.md` sections 5–8. The frontend half
is `D:\WORK\zoo-analytics-web\docs\superpowers\plans\2026-10-19-phase-4b-evidence-web.md`.

## Global Constraints

- Work in `D:\WORK\zoo-vision` on branch `phase-4b-evidence` (it holds the spec commit). Never commit to `main`.
  Push the branch and the tag only after the user says yes.
- No Claude attribution: no `Co-Authored-By` trailer, no "Generated with Claude Code" line, in commits or pull
  requests. Put this rule in every reviewer prompt too.
- No test-first steps (memory `no-tdd-in-plans`): implement, then the focused test the task names. Verification
  runs stay.
- The Acer laptop (memory `dev-laptop-constraints`): Docker Desktop must be running for Testcontainers and compose;
  ports 80/443/5432 are taken (Caddy on 8080); never build the engine image; MediaMTX runs natively
  (`.\mediamtx.exe deploy\mediamtx.yml` from the repo root). Never run a bare `docker compose up`.
- Don't edit historical documents: `docs/adr/*`, `docs/01_*`, `docs/04_*`, `docs/06_*`,
  `docs/architecture_best_practice_recommendation.md`, the parent spec, the Phase 0–4a plans and specs.
- Image tags stay `postgres:17.11-alpine`, `redis:7.4.11-alpine`, `bluenviron/mediamtx:1.21.1`,
  `caddy:2.11.7-alpine`; Gotenberg gets one exact `gotenberg/gotenberg:8.<minor>.<patch>` tag (Task 9).
- Contract: additive over v0.5. The CSV file name's last date becomes inclusive (a **changed** line). No use case's
  `schemaVersion` changes except `system` gaining `disk_low` (additive event type, version unchanged). One tag,
  `contract-v0.6`, at the end (Task 12). Every change gets a line in `docs/fe-contract.md` section 14 under
  `### v0.6`.
- Never in logs, audit rows, WebSocket messages or `Evidence.error`: passwords, `MEDIAMTX_PASSWORD`, API tokens,
  `ENGINE_TOKEN`, camera stream URLs, playback URLs with their query (log `host` only, as `ClipsService` does).
- Ids that become file paths (`cameraId`, `eventId`) must match `^[A-Za-z0-9_-]{1,128}$`; anything else is refused
  before a path is built.
- Numbers fixed here:

  | What | Value |
  |---|---|
  | SiteSettings defaults | `Zoo Vision`, `Asia/Jakarta`, recording 7, snapshots 90, audit snapshots 365, evidence 365 days |
  | Settings validation | `siteName` 1–100 chars; `timeZone` passes `isTimeZone`; every `*Days` integer 1–3650 |
  | Evidence `runAt` at ingest | event time + camera `clipAfterSec` + 60 s |
  | Pin tick | every 10 s, at most 5 due rows per tick, one after another; whole download at most 120 s |
  | Pin retry | after failure *n* (1–8) wait 2^(n−1) min (1, 2, 4 … 128); failure 9 → `FAILED` (≈ 4 h 15 min) |
  | PDF tick | every 5 s, one due job; Gotenberg call 60 s; retry after 1, 2, 4 min, then `FAILED` |
  | Retention | hourly, first pass 60 s after start; export files live 7 days |
  | Disk | every 5 min; warning ≥ 85%, critical ≥ 95%; a level re-arms below level − 2 points |
  | Export job list | the caller's own, newest first, at most 50 |
  | Kept clip cache | `Cache-Control: private, max-age=3600` |

## Decisions this plan makes beyond the design

The user should confirm these when reviewing the plan.

1. **Ingest already runs each batch in one transaction** (`IngestService.apply()` →
   `prisma.$transaction(async (tx) => …)`, and `applyEvent(tx, …)` inserts inside it). The `Evidence` insert goes
   into `applyEvent` with the same `tx`. `knownCameras` becomes a `Map` that also returns `auditCamera` and
   `clipAfterSec`, so no extra query.
2. **Interval stats use `"end" >= from`, not the spec's `> from`.** With `>`, a zero-length interval starting
   exactly at `from` would drop out of `count` (today's `start >= from` branch includes it). `>=` changes no
   result; it only lets the index cut rows.
3. **Index names.** Today: `Interval_cameraId_kind_start_idx`, the partial unique `Interval_open_camera_offline`,
   and `Metric_pkey` on `(cameraId, name, minute)`; nothing on `Interval(kind, end)` or `Metric(minute)`. New ones,
   if `EXPLAIN` keeps them: `Interval_kind_end_idx`, `Metric_minute_idx` (Prisma's default names).
4. **Pin retries reach about 4 hours** (the spec's figure): 8 retries at 1 … 128 min. The spec's "8 attempts" with
   the same doubling would stop at about 2 hours.
5. **No playback configured (`MEDIAMTX_PLAYBACK_URL` unset), or a `FILE` camera, is `NO_RECORDING` at once.** The
   demo profile has no MediaMTX: its warning events get `NO_RECORDING` rows, which still protect their snapshots.
   A later manual keep requeues them.
6. **The demo feed keeps `Asia/Jakarta` fixed** instead of reading the row (the spec says it reads it). The zone
   only shapes its fake opening hours; a route or a database URL for that is not worth it.
7. **`PathSync` and `StreamInfo` read `recordingRetentionDays` from the service.** A changed value reaches
   MediaMTX at the next 30 s reconcile; no extra trigger (the spec's "in seconds" becomes "within 30 s").
8. **`Camera.recordingPath` is dropped** in this migration, as 4a's plan promised (decision 1 there). The DTO still
   accepts and ignores it.
9. **Write access on Linux.** The API runs as uid 1000; MediaMTX and the engine run as root, so the folders they
   create (`zv_<id>/`, `<camera>/<date>/`) are not deletable by the API. Compose runs `mediamtx` and `zoo-ai-engine`
   with `user: "1000:1000"`, and `deploy/README.md` says to `chown -R 1000:1000 "$ZOO_DATA_DIR"`. Docker Desktop
   on Windows ignores ownership, so the laptop run can not prove this; the Phase 5 soak on Linux must (memory note).
   A delete that fails with `EACCES` is counted and logged once per pass.
10. **`POST /api/v1/events/:id/evidence` on an event without a camera** answers 404 `RECORDING_NOT_AVAILABLE`
    (the existing code); every other case answers 200 with the row.
11. **A kept clip whose file is missing** (deleted by hand) falls through to the playback stream, with a warning.
12. **PDF column labels** are the use case schema's `$defs[<type or kind>].title` when the loaded contract has it,
    else the key, followed by the unit (`(jumlah)`, `(detik)`, `avg`, `max`); totals cover only `events.*` and
    `intervals.*` columns (a sum of averages means nothing).

## Follow-ups (memories `phase-4a-followups`, `phase-3-followups`)

| Item | Where |
|---|---|
| I5: clip of a camera that switched MAIN/SUB | Task 3 (shared playback fallback) |
| I6: recordings of deleted cameras | Task 5 |
| I8: re-resolve the trusted proxy on an untrusted peer | Task 10 |
| Retention indexes (interval stats, metric series, `metrics.csv`) | Task 7 |
| `res.once('close')` after an `await` in `CsvResponder` | Task 10 |
| Export file names carry the exclusive end date | Task 10 |
| Demo snapshots grow ~80 MB/day | Task 5 (snapshot retention) |
| Clips have no byte ranges (Safari) | Task 4 (kept clips only, spec change 7) |
| `SITE_TIMEZONE` / `SITE_TZ` → `SiteSettings` | Task 1; the web half in the frontend plan |
| `fe-contract.md` debug-fps line changed after v0.5 | Task 11 (changelog) |

Parked by the spec: `pubsub.ts` failure handler, `debug_frames.py` on Redis failure, one shared box geometry schema,
database row retention, deleting recordings by free space. Still parked from earlier phases: the `StreamManager`
catch-up runaway, ANPR rebuilt synchronously, a long ONNX conversion starving workers, the orphan ONNX file, the
contract polish items left for `contract-v1.0`.

## Needs the user

1. Docker Desktop running for Testcontainers and compose; `docker pull gotenberg/gotenberg:<tag>` (Task 9, ~1.5 GB).
2. Task 7: about 10 minutes of Postgres time for a year of synthetic rows (a throwaway database, not `deploy`'s).
3. Task 12: watch the API-level laptop checks, then approve pushing the branch and `contract-v0.6`.
4. Merge the frontend's `phase-4a-video` pull request before the frontend plan starts (its branch is cut from
   `main` after that).

## Not in this plan

- The frontend (Exports page, Site settings page, keep button and badge, disk banner, `time.ts`): the frontend
  plan, which also holds the joint laptop run (spec section 8).
- Pruning database rows, deleting recordings by free space, byte ranges for unkept clips, an "un-keep".

## Review Focus

1. **A pin for an id that is not a plain name** (`../x`, `a/b`, `a\b`, an empty camera id). Expected: no file is
   written or deleted outside `EVIDENCE_DIR`; the row becomes `FAILED` with `invalid id`. Test in Task 3.
2. **A camera switched from MAIN to SUB recording after the event** (I5). Expected: playback 404 on `zv_<id>_sub`,
   then the clip from `zv_<id>`, for both the live route and the pin. Test in Task 3.
3. **A snapshot folder holding both kept and unkept events, next to a folder named `tmp`.** Expected: the unkept
   JPEGs go, the kept ones and the folder stay; `tmp` is untouched. Test in Task 5.
4. **`GET /exports/jobs/<not-a-uuid>/file`, or another user's job.** Expected: 404, never a 500 from Postgres's
   uuid cast. Test in Task 9.
5. **The disk goes from 80% straight to 97%, then back to 94%, then 96%.** Expected: one `critical` (no extra
   `warning`), nothing at 94%, nothing at 96% (not re-armed until below 93%). Test in Task 6.

## Execution sessions

Fresh session per block (memory `model-split-and-session-cost`). Each session starts by reading this plan, the
spec, and `git log --oneline main..` (trust git, not the checkboxes).

| Session | Tasks | Ends with |
|---|---|---|
| **A: settings and evidence** | 1–4 | site settings live, events pinned, kept clips served with ranges; Opus review of Tasks 3 and 4 |
| **B: retention and disk** | 5–7 | retention, disk warnings, the indexes decided by `EXPLAIN`; Opus review of Task 5 |
| **C: PDF and fixes** | 8–10 | PDF jobs through Gotenberg, I8, CSV fixes; Opus review of Tasks 9 and 10 |
| **D: contract and close** | 11–12 | contract files, `fe-contract.md` v0.6, API-level laptop checks, Opus whole-branch review, tag (after the user's yes) |
| then the frontend plan | W1–W6 | in `zoo-analytics-web`, sessions E and F |

## Models (native execution)

| What | Model |
|---|---|
| Each session (implements its tasks itself, `superpowers:executing-plans`) | Sonnet (`/model sonnet` before starting) |
| Per-task review | none: each task's tests and the "Run everything" step are the gate |
| End-of-session review (sessions A, B, C: the tasks named in the session table) | one Opus reviewer subagent over that session's commits |
| Whole branch (Task 12) | one Opus reviewer subagent |

Escalate a task to Opus (`/model opus`) only when Sonnet is stuck after 2–3 fix rounds.

## Target layout at the end of this plan

```
apps/api/prisma/migrations/  20261019090000_phase_4b/, 20261019100000_retention_indexes/ (if kept)
apps/api/src/site-settings/  site-settings.module.ts, site-settings.service.ts, site-settings.controller.ts, dto/
apps/api/src/evidence/       evidence.module.ts, evidence.controller.ts, evidence.service.ts, pin.job.ts, safe-id.ts
apps/api/src/media/          + playback.service.ts
apps/api/src/jobs/           + retention.job.ts, disk.job.ts, disk-levels.ts
apps/api/src/exports/        + export-jobs.controller.ts, export-jobs.service.ts, pdf.job.ts, pdf/report-html.ts,
                               pdf/report-range.ts, dto/export-job.dto.ts
packages/contracts/          usecases/system (+ disk_low), ws/server/disk.warning.schema.json, ws/examples/disk.warning/
deploy/                      compose (volumes rw, evidence, exports, gotenberg, users), .env examples, README
```

---

> **Session A starts here: Tasks 1–4.**

### Task 1: Migration, env, and `SiteSettings` live

**Files:**
- Modify: `apps/api/prisma/schema.prisma`; create `apps/api/prisma/migrations/20261019090000_phase_4b/migration.sql`
- Create: `apps/api/src/site-settings/{site-settings.module.ts,site-settings.service.ts,site-settings.controller.ts}`,
  `apps/api/src/site-settings/dto/site-settings.dto.ts`
- Modify: `apps/api/src/config/env.ts` (+ `env.spec.ts`), `apps/api/src/app.module.ts`,
  `apps/api/src/reports/{event-stats,interval-stats,metric-series}.service.ts`, `apps/api/src/exports/exports.service.ts`,
  `apps/api/src/system-log/system-log.service.ts`, `apps/api/src/mediamtx/{paths.ts,path-sync.service.ts,stream-info.service.ts}`
  (+ `paths.spec.ts`), `apps/api/src/cli.ts`
- Modify: `deploy/docker-compose.yml`, `deploy/.env.example`, `deploy/.env.demo.example`
- Test: create `apps/api/test/site-settings.e2e-spec.ts`; change `test/reports-events.e2e-spec.ts` ("with another
  SITE_TIMEZONE" becomes a PATCH)

**Interfaces:**
- Schema (one migration for all of 4b's tables):
  ```prisma
  model SiteSettings { id Int @id @default(1)  siteName String  timeZone String  recordingRetentionDays Int
    snapshotRetentionDays Int  auditSnapshotRetentionDays Int  evidenceRetentionDays Int
    updatedAt DateTime @updatedAt @db.Timestamptz(3) }
  enum EvidenceReason { SEVERITY AUDIT_CAMERA USER }
  enum EvidenceStatus { QUEUED KEPT NO_RECORDING FAILED }
  model Evidence { eventId String @id  event Event @relation(fields: [eventId], references: [id], onDelete: Restrict, onUpdate: Restrict)
    cameraId String  eventTime DateTime @db.Timestamptz(3)  reason EvidenceReason  status EvidenceStatus @default(QUEUED)
    runAt DateTime @db.Timestamptz(3)  attempts Int @default(0)  error String?  filePath String?  sizeBytes Int?
    createdAt DateTime @default(now()) @db.Timestamptz(3)
    @@index([status, runAt])  @@index([cameraId, eventTime]) }
  enum ExportStatus { QUEUED DONE FAILED EXPIRED }
  model ExportJob { id String @id @default(uuid()) @db.Uuid  params Json  status ExportStatus @default(QUEUED)
    runAt DateTime @default(now()) @db.Timestamptz(3)  attempts Int @default(0)  error String?  filePath String?
    sizeBytes Int?  finishedAt DateTime? @db.Timestamptz(3)  createdById String  createdByName String
    createdAt DateTime @default(now()) @db.Timestamptz(3) }
  // Camera: + evidenceRetentionDays Int? (null = site default); - recordingPath
  // Event: + evidence Evidence?
  ```
  The SQL also: `ALTER TABLE "SiteSettings" ADD CONSTRAINT "SiteSettings_one_row" CHECK ("id" = 1)`, the default row
  `INSERT … VALUES (1, 'Zoo Vision', 'Asia/Jakarta', 7, 90, 365, 365, now())`, `GRANT SELECT, UPDATE ON
  "SiteSettings"` and `GRANT SELECT, INSERT, UPDATE, DELETE ON "Evidence", "ExportJob"` to `zoo_api`.
- Env: `SITE_TIMEZONE` removed. New `EVIDENCE_DIR` (default `/data/evidence`), `EXPORTS_DIR` (`/data/exports`),
  `GOTENBERG_URL: string | undefined` (http(s) URL; unset = no PDF). The zone check becomes
  `export function isTimeZone(value: string): boolean` in `env.ts` (same rule as today's `timeZone` check).
- `SiteSettingsService` (`@Global()` module, `OnModuleInit` loads the row):
  ```ts
  export type SiteSettings = { siteName: string; timeZone: string; recordingRetentionDays: number;
    snapshotRetentionDays: number; auditSnapshotRetentionDays: number; evidenceRetentionDays: number };
  get current(): SiteSettings;              // the in-memory copy
  get timeZone(): string;
  update(patch: Partial<SiteSettings>): Promise<{ before: SiteSettings; after: SiteSettings }>;
  ```
  A comment on the copy: `shortcut: a second API process would not see a PATCH; compose runs one api`.
- `SiteSettingsController.get`/`.update` (operation ids `siteSettingsGet`, `siteSettingsUpdate`: the web's hooks
  are named after them). `GET /api/v1/site-settings` (any logged-in role) → `SiteSettingsDto` (the six fields).
  `PATCH /api/v1/site-settings` (`@MinRole('SUPERADMIN')`, body `UpdateSiteSettingsDto`, every field optional,
  class-validator for the ranges; a bad `timeZone` → 400 `VALIDATION_FAILED` at `/timeZone`). `setAudit`:
  `action: 'site_settings.update'`, `entity: 'site_settings'`, `before`/`after` the changed fields only.
- Readers: the three report services call `bucketStart(q.bucket, this.settings.timeZone, …)` per query;
  `ExportsService` and `SystemLogService` drop the constructor `this.local` and build
  `localDateTime(this.settings.timeZone)` once per export (inside `events()`, `summary()`, …, and in `filename`).
- `wantedPaths(cameras, cipher, defaultRetentionDays: number, onDecryptError?)`; `PathSync` passes
  `settings.current.recordingRetentionDays` on every pass. `StreamInfoService` uses the same default for
  `estimatedBytes`. Both `DEFAULT_RETENTION_DAYS` constants go.
- `cli.ts` passes `tz: 'Asia/Jakarta'` to the demo feed with
  `// shortcut: the demo's fake opening hours stay in Jakarta time; read site settings if a demo needs another zone`.
- Compose `api`: remove `SITE_TIMEZONE`; add `EVIDENCE_DIR: /data/evidence`, `EXPORTS_DIR: /data/exports`; volumes
  `snapshots` and `recordings` lose `:ro`, new `${ZOO_DATA_DIR:-./data}/evidence:/data/evidence` and
  `…/exports:/data/exports`. `mediamtx` and `zoo-ai-engine` get `user: "1000:1000"` (decision 9). `.env.example`
  loses `ZOO_SITE_TIMEZONE`.

- [ ] **Step 1: Implement**

Run `npx prisma migrate dev --create-only --name phase_4b` against a scratch database to get Prisma's DDL, then add
the CHECK, the row and the grants by hand, and rename the folder to `20261019090000_phase_4b`.

- [ ] **Step 2: Write the focused tests**

`test/site-settings.e2e-spec.ts`:
```ts
it('GET as a USER → the six defaults (Zoo Vision, Asia/Jakarta, 7, 90, 365, 365)')
it('PATCH as a MANAGER → 403; as a SUPERADMIN {timeZone: "Mars/Base"} → 400 at /timeZone; {snapshotRetentionDays: 0} → 400')
it('PATCH {timeZone: "Asia/Makassar"} → the next events.csv writes local times one hour later, without a new app') // spec test
it('PATCH writes one audit row site_settings.update with before/after of the changed field')
```
In `reports-events.e2e-spec.ts`, the "another zone" block PATCHes the zone (and restores it in `afterAll`) instead of
`createTestApp({ SITE_TIMEZONE })`. In `paths.spec.ts`, one case: a camera with `retentionDays: null` and default 3
→ `recordDeleteAfter: '3d'`.

- [ ] **Step 3: Run everything**

Run: `cd apps/api && npm run lint && npm run build && npm test && npm run test:e2e`. Expected: all pass;
`grep -rn SITE_TIMEZONE apps deploy --include=*.ts --include=*.yml --include=*.example` finds nothing.

- [ ] **Step 4: Commit**

```bash
git add apps/api deploy
git commit -m "feat(api): site settings in the database replace SITE_TIMEZONE; 4b tables and volumes"
```

---

### Task 2: Evidence rows: ingest, keep by hand, event rows, camera retention, usage

**Files:**
- Create: `apps/api/src/evidence/{evidence.module.ts,evidence.controller.ts,evidence.service.ts,safe-id.ts}`
- Modify: `apps/api/src/ingest/ingest.service.ts`, `apps/api/src/reports/rows.ts`, `apps/api/src/reports/dto/list.dto.ts`,
  `apps/api/src/reports/lists.service.ts`, `apps/api/src/exports/exports.service.ts`, `apps/api/src/live/ingest-push.ts`,
  `apps/api/src/cameras/{cameras.service.ts,camera-view.ts}`, `apps/api/src/cameras/dto/{camera-fields.dto.ts,camera-view.dto.ts}`,
  `apps/api/src/mediamtx/stream-info.service.ts`, `apps/api/src/mediamtx/dto/stream-info.dto.ts`, `apps/api/src/app.module.ts`
- Test: extend `apps/api/test/ingest.e2e-spec.ts`; create `apps/api/test/evidence.e2e-spec.ts`

**Interfaces:**
- Ingest: `knownCameras(tx, parsed): Promise<Map<string, { auditCamera: boolean; clipAfterSec: number }>>` (one
  query, as today). In `applyEvent`, when `inserted === 1 && m.cameraId !== null` and (`m.severity` is `warning` or
  `critical`, or the camera has `auditCamera`):
  ```sql
  INSERT INTO "Evidence" ("eventId","cameraId","eventTime","reason","runAt")
  VALUES (…, ${m.time}::timestamptz + make_interval(secs => ${clipAfterSec} + 60)) ON CONFLICT DO NOTHING
  ```
  `reason` is `AUDIT_CAMERA` when the camera has `auditCamera`, else `SEVERITY`.
- `safe-id.ts`: `export const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/; export function isSafeId(s: string): boolean`.
- `EvidenceService.keep(eventId: string): Promise<EvidenceDto>`:
  event missing → 404 `NOT_FOUND`; no `cameraId` → 404 `RECORDING_NOT_AVAILABLE`; no row → insert `USER`,
  `runAt = now()`; `FAILED`/`NO_RECORDING` → `status QUEUED, attempts 0, error NULL, runAt now()`;
  `QUEUED`/`KEPT` → unchanged.
- `POST /api/v1/events/:id/evidence` (`EvidenceController.keep`, operation id `evidenceKeep`, `@Controller('events')`,
  `@MinRole('MANAGER')`, `@HttpCode(200)`): `setAudit({ action: 'evidence.keep', entity: 'event',
  entityId: id })`. `EvidenceDto = { eventId: string; status: EvidenceStatus; reason: EvidenceReason }`.
- Event rows: `EventRow.evidence: { status; reason } | null`. Rename `EVENT_CAMERA` to `EVENT_INCLUDE` and add
  `evidence: { select: { status: true, reason: true } }`. `clipUrl` is also set when `evidence.status === 'KEPT'`.
  `ingest-push.ts` passes `evidence: null` (the `event.created` WebSocket message has no clip or evidence field).
- Camera: `recording.evidenceRetentionDays?: number | null` (1–3650, null = site default) in the recording DTO, the
  view and `cameras.service` (the same `set('recording.evidenceRetentionDays', 'evidenceRetentionDays', …)` line as
  `retentionDays`, so it is SUPERADMIN-only and audited with before/after).
- `StreamInfoDto` gains `evidenceBytes: number` and `evidenceCount: number`:
  `SELECT COALESCE(SUM("sizeBytes"),0)::bigint, count(*)::int FROM "Evidence" WHERE "cameraId" = $1 AND "status" = 'KEPT'`
  (as `Number`). FILE cameras get them too.

- [ ] **Step 1: Implement**

- [ ] **Step 2: Write the focused tests**

`ingest.e2e-spec.ts`:
```ts
it('a warning event → one Evidence row SEVERITY QUEUED, runAt = time + clipAfterSec + 60 s')
it('an info event on an auditCamera camera → one row AUDIT_CAMERA; an info event elsewhere → none')
it('a warning system event (cameraId null) → no row')
it('the same warning message delivered twice → still one row')   // spec test
```
`evidence.e2e-spec.ts`:
```ts
it('POST as a USER → 403; as a MANAGER on an info event → 200 USER QUEUED; again → 200, still one row')
it('a FAILED row → POST → 200 QUEUED, attempts 0, error null')
it('an unknown event → 404 NOT_FOUND; a system event → 404 RECORDING_NOT_AVAILABLE')
it('GET /events shows evidence {status, reason} on that row and null on others')
it('PATCH recording.evidenceRetentionDays as a MANAGER → 403; as a SUPERADMIN → saved, audit before/after')
```

- [ ] **Step 3: Run everything** (`cd apps/api && npm run lint && npm run build && npm test && npm run test:e2e`), expect pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "feat(api): evidence rows for warning, critical and audit-camera events; keep evidence by hand"
```

---

### Task 3: Shared playback with the I5 fallback, and the pin tick

**Files:**
- Create: `apps/api/src/media/playback.service.ts`, `apps/api/src/evidence/pin.job.ts`
- Modify: `apps/api/src/media/{clips.service.ts,media.module.ts}` (export `PlaybackService`),
  `apps/api/src/evidence/evidence.module.ts`
- Test: create `apps/api/test/pin.e2e-spec.ts` (a local `http.createServer` as the fake playback); extend
  `test/media.e2e-spec.ts`

**Interfaces:**
- `PlaybackService` (moves today's fetch out of `ClipsService`, unchanged in behaviour: basic auth, `redirect:
  'error'`, 10 s to headers, `URLSearchParams`, log `host` only):
  ```ts
  export type ClipCamera = { id: string } & Pick<Camera, 'sourceType'|'subStreamUrlEnc'|'recordingEnabled'
    |'recordingStream'|'inferenceStream'|'clipBeforeSec'|'clipAfterSec'>;
  export type Playback =
    | { ok: true; body: ReadableStream<Uint8Array> }
    | { ok: false; reason: 'NO_PATH' | 'NOT_FOUND' | 'UNAVAILABLE' };  // UNAVAILABLE: unreachable, timeout, 5xx, other
  open(camera: ClipCamera, eventTime: Date, signal: AbortSignal): Promise<Playback>;
  ```
  `NO_PATH`: no `MEDIAMTX_PLAYBACK_URL` or `mediamtxPaths(camera)?.recorded` is null. A 404 on the recorded path
  tries once more on the other name: `p.endsWith('_sub') ? p.slice(0, -4) : `${p}_sub`` (by name, not by the
  camera's current sub URL: the old recording may predate removing it). 404 on both → `NOT_FOUND`.
- `ClipsService.stream` maps `NO_PATH`/`NOT_FOUND`/`UNAVAILABLE` to today's 404 `RECORDING_NOT_AVAILABLE` and keeps
  its headers, `no-store` for a clip still recording, and the pipeline.
- `PinJob` (`OnModuleInit` schedules `tick` every 10 s when `JOBS=on`; `tick(now = new Date())` public, guarded by
  `running`, never throws). Per due row (`status = 'QUEUED' AND "runAt" <= now ORDER BY "runAt" LIMIT 5`):
  1. `isSafeId` on `cameraId` and `eventId`, else `FAILED`, `error: 'invalid id'`.
  2. `playback.open(camera, eventTime, AbortSignal.timeout(120_000))`.
  3. `ok` → stream to `EVIDENCE_DIR/<cameraId>/<localDate>/<eventId>.mp4.part` (`mkdir -p`, `localDate` = event date
     in `settings.timeZone`, `localDate` from `demo/demo-generators.ts`), `rename` to `.mp4`, `KEPT`, `filePath` relative
     (`<cameraId>/<date>/<eventId>.mp4`), `sizeBytes`. A stream error mid-file counts as `UNAVAILABLE`.
  4. `NO_PATH`/`NOT_FOUND` → `NO_RECORDING`.
  5. `UNAVAILABLE` → `attempts + 1`; `attempts` reaching 9 → `FAILED`, `error: 'recording service unavailable'`;
     else `runAt = now + 2^(attempts-1) min`.

- [ ] **Step 1: Implement**

- [ ] **Step 2: Write the focused tests**

`pin.e2e-spec.ts` (an app with `MEDIAMTX_PLAYBACK_URL` = the fake, `EVIDENCE_DIR` a temp folder; rows inserted with
`runAt` in the past; call `tick()` directly):
```ts
it('fake answers 200 with bytes → KEPT, file at <cam>/<date>/<evt>.mp4 with those bytes, sizeBytes, no .part left')   // spec test
it('404 on both zv_<id> and zv_<id>_sub → NO_RECORDING, no file')                                                    // spec test
it('camera now records SUB: 404 on zv_<id>_sub, 200 on zv_<id> → KEPT')                                               // Review Focus 2
it('500 → attempts 1, runAt +1 min; after the 9th 500 → FAILED')                                                      // spec test
it('a row with cameraId "../x" → FAILED "invalid id", nothing written outside EVIDENCE_DIR')                          // Review Focus 1
it('no MEDIAMTX_PLAYBACK_URL → NO_RECORDING')
```
`media.e2e-spec.ts`: `it('GET /media/clips/:id for a camera that switched to SUB plays from zv_<id> (I5)')`.

- [ ] **Step 3: Run everything** (`cd apps/api && npm run lint && npm run build && npm test && npm run test:e2e`), expect pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "feat(api): pin tick copies event clips into the evidence folder; playback falls back to the other stream path"
```

---

### Task 4: Kept clips served from the file with byte ranges

**Files:**
- Modify: `apps/api/src/media/clips.service.ts`, `apps/api/src/media/media.controller.ts` (OpenAPI: 206 and
  `Accept-Ranges` documented)
- Test: extend `apps/api/test/media.e2e-spec.ts`

**Interfaces:**
- `ClipsService.stream`: after the event lookup, a `KEPT` row with a `filePath` that `stat`s as a file answers
  `res.sendFile(filePath, { root: EVIDENCE_DIR, dotfiles: 'deny', headers: { 'Content-Type': 'video/mp4',
  'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } })` wrapped in a promise (the
  callback's error after headers are sent is a client that left: ignore it; before: 404 `RECORDING_NOT_AVAILABLE`).
  A missing file logs one warning and falls through to playback (decision 11). A kept clip plays even when the
  camera has no recorded path any more.

- [ ] **Step 1: Implement**

- [ ] **Step 2: Write the focused tests**

```ts
it('a KEPT clip with Range: bytes=0-99 → 206, Content-Range bytes 0-99/<size>, 100 bytes')      // spec test
it('a KEPT clip without Range → 200, Accept-Ranges: bytes, Cache-Control private, max-age=3600')
it('a KEPT row whose file is gone → the playback stream as before')
it('no KEPT row → playback stream unchanged, no Accept-Ranges header')                            // spec test
```

- [ ] **Step 3: Run everything** (`cd apps/api && npm run lint && npm run build && npm test && npm run test:e2e`), expect pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "feat(api): kept clips play from the evidence file with byte ranges"
```

> **Session A ends here.** Opus reviews Tasks 3 and 4 (path building and the id check, the `.part`/rename order,
> the retry arithmetic, nothing of the playback URL in logs or `error`, `sendFile`'s root).

---

> **Session B starts here: Tasks 5–7.**

### Task 5: `RetentionJob`

**Files:**
- Create: `apps/api/src/jobs/retention.job.ts`
- Modify: `apps/api/src/jobs/jobs.module.ts`
- Test: create `apps/api/test/retention.e2e-spec.ts` (temp `SNAPSHOT_DIR`, `EVIDENCE_DIR`, `EXPORTS_DIR`,
  `RECORDINGS_DIR`)

**Interfaces:**
- `RetentionJob.tick(now = new Date()): Promise<void>`, hourly with `JOBS=on`, first pass 60 s after start, guarded
  like `OfflineJob`. Four sweeps, each in its own `try` (one failing never stops the others); a failed delete is
  counted, and each sweep logs one line with its counts when anything was deleted or failed.
- **Snapshots:** each `SNAPSHOT_DIR/<camera>/<YYYY-MM-DD>/` whose name is a real date and is before
  `localDate(now) − days` (days = `auditSnapshotRetentionDays` for an `auditCamera` camera, else
  `snapshotRetentionDays`; a camera folder with no `Camera` row, or a name failing `isSafeId`, uses
  `snapshotRetentionDays`). In it, files `<eventId>.jpg` whose `eventId` has an `Evidence` row stay (one
  `SELECT "eventId" … WHERE "eventId" = ANY($1)` per folder); the rest are deleted; the folder goes if empty. Other
  names are left alone.
- **Kept clips:** rows of any status with `"eventTime" < now - make_interval(days =>
  COALESCE(c."evidenceRetentionDays", $site))` (join `Camera`), 500 at a time: delete the file if `filePath` is set
  (ENOENT is fine), then the row.
- **Export files:** `ExportJob` rows `DONE` with `finishedAt < now − 7 days`: delete the file, `status EXPIRED`,
  `filePath NULL`.
- **Recordings of deleted cameras (I6):** folders in `RECORDINGS_DIR` matching `^zv_([A-Za-z0-9_-]+?)(_sub)?$` whose
  id has no `Camera` row: files with `mtime` older than `recordingRetentionDays` go, then the folder if empty.
  Nothing else in `RECORDINGS_DIR` is touched (`feed_*`, other names).

- [ ] **Step 1: Implement**

- [ ] **Step 2: Write the focused tests**

```ts
it('snapshot folders older than 90 days go; a kept event\'s JPEG and its folder stay; a folder "tmp" stays')   // Review Focus 3, spec test
it('an auditCamera camera keeps a 100-day-old folder (365 days)')
it('a camera with evidenceRetentionDays 30 loses its 31-day-old clip file and row; another camera keeps it')    // spec test
it('an EXPORTS row DONE 8 days ago → EXPIRED, file gone; 6 days ago → untouched')
it('zv_gone/ (no camera) old segment deleted, folder removed; zv_<existing>/ and feed_x/ untouched')           // spec test
it('a second tick deletes nothing more')
```
Set `mtime` with `utimes`; dates relative to a fixed `now` passed to `tick`.

- [ ] **Step 3: Run everything** (`cd apps/api && npm run lint && npm run build && npm test && npm run test:e2e`), expect pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "feat(api): hourly retention for snapshots, kept clips, export files and deleted cameras' recordings"
```

---

### Task 6: `DiskJob`, `disk_low` and `disk.warning`

**Files:**
- Create: `apps/api/src/jobs/{disk.job.ts,disk-levels.ts,disk-levels.spec.ts}`
- Modify: `apps/api/src/jobs/jobs.module.ts` (imports `LiveModule` for `LiveGateway`),
  `packages/contracts/usecases/system/events.schema.json` (+ `disk_low`), `packages/contracts/usecases/system/examples/`,
  `packages/contracts/ws/server/disk.warning.schema.json` (new), `packages/contracts/ws/examples/disk.warning/` (new),
  regenerated `packages/contracts/generated/**`, `services/engine/contracts/**`

**Interfaces:**
- `disk-levels.ts` (pure):
  ```ts
  export type Level = 'ok' | 'warning' | 'critical';
  export function nextLevel(prev: Level, usedPercent: number): { level: Level; crossed: 'warning' | 'critical' | null };
  ```
  Up: `≥ 95` → critical, `≥ 85` → warning; `crossed` is set only when the level rises. Down: critical holds until
  `< 93`, warning until `< 83`; dropping never emits.
- `DiskJob.tick()` every 5 min with `JOBS=on`: `statfs` and `stat(dir).dev` for `RECORDINGS_DIR`, `SNAPSHOT_DIR`,
  `EVIDENCE_DIR`, `EXPORTS_DIR`; one entry per device (the first path named), level per device in memory.
  `usedPercent = round1((blocks − bfree) / (blocks − bfree + bavail) × 100)`, `freeBytes = bavail × bsize`. On a
  crossing: one `Event` (`useCase 'system'`, `type 'disk_low'`, severity = crossed, `cameraId null`,
  `data {path, usedPercent, freeBytes}`, as `models.service` writes `model_validation_failed`), then
  `gateway.toManagers('disk.warning', {path, usedPercent, freeBytes, severity, time})`. A missing folder is skipped
  with one warning per start. The first pass logs one line per device (path, used %, free GB).
- `disk_low` `$def` (`title: "DiskLow"`): `path` string 1–500, `usedPercent` number 0–100, `freeBytes` integer ≥ 0,
  all required, no extra properties. `disk.warning` schema: those three plus `severity` (`warning`|`critical`) and
  `time` (date-time).

- [ ] **Step 1: Implement; regenerate** (`cd packages/contracts && npm run generate`)

- [ ] **Step 2: Write the focused test** (`disk-levels.spec.ts`)

```ts
it('80 → 86 crosses warning; 86 → 96 crosses critical; 96 → 94 nothing; 94 → 96 nothing; 92 → 96 crosses critical again')
it('80 → 97 crosses critical only')                                          // Review Focus 5
it('warning holds at 84, re-arms at 82.9, crosses again at 85')
```

- [ ] **Step 3: Run everything**

Run: `cd packages/contracts && npm test && npm run check`; `cd apps/api && npm run lint && npm run build && npm test
&& npm run test:e2e`; `cd services/engine && uv run pytest -q` (regenerated models). Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api packages/contracts services/engine/contracts
git commit -m "feat(api): disk warnings at 85% and 95% as disk_low events and disk.warning for managers"
```

---

### Task 7: Retention indexes, decided by `EXPLAIN` on a year of data

**Files:**
- Modify: `apps/api/src/reports/interval-stats.service.ts` (the `iv` CTE's `WHERE` gains
  `AND (i."end" IS NULL OR i."end" >= ${from})`, decision 2)
- Modify (only for indexes kept): `apps/api/prisma/schema.prisma`, create
  `apps/api/prisma/migrations/20261019100000_retention_indexes/migration.sql`
- Scratch, never committed: `<scratchpad>/year.sql`, `<scratchpad>/explain-before.txt`, `explain-after.txt`

**Interfaces:**
- Candidates: `@@index([kind, end])` on `Interval` (`Interval_kind_end_idx`), `@@index([minute])` on `Metric`
  (`Metric_minute_idx`). Nothing else is tried.

- [ ] **Step 1: Load a year of data into a throwaway database**

A throwaway Postgres container (`docker run --rm -d -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=x
postgres:17.11-alpine`), `npx prisma migrate deploy` against it, `npm run cli -- demo-seed` for the cameras, then
`year.sql` with `generate_series`: for each demo camera, a `Metric` row per minute for 365 days for each of its
metric names, and ~200 `Interval` rows a day per camera over the same year (a mix of kinds, ~5% still open).
`VACUUM ANALYZE`.

- [ ] **Step 2: `EXPLAIN (ANALYZE, BUFFERS)` the three queries, before and after each index**

1. Interval stats for one kind over the last 7 days (the service's SQL with the new condition; copy it from a
   `DEBUG=prisma:query` run or build it by hand).
2. Metric series for one name over 7 days without `cameraIds`.
3. The first `metrics.csv` batch over 7 days.

Keep an index only when its query's plan changes and its time drops; record the before/after totals in the
commit message.

- [ ] **Step 3: Run everything** (`cd apps/api && npm run lint && npm run build && npm test && npm run test:e2e`), expect pass;
stop the throwaway container.

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "perf(api): interval stats bound by end; indexes kept by EXPLAIN on a year of data"
```

> **Session B ends here.** Opus reviews Task 5 (nothing outside the four folders is deleted, the evidence check
> before deleting a JPEG, the date arithmetic in the site zone, a camera id that is not a plain name).

---

> **Session C starts here: Tasks 8–10.**

### Task 8: The PDF page: range and HTML

**Files:**
- Create: `apps/api/src/exports/pdf/{report-range.ts,report-range.spec.ts,report-html.ts,report-html.spec.ts}`
- Modify: `apps/api/src/exports/exports.service.ts` (the summary rows become one public method)

**Interfaces:**
- `report-range.ts`: `export type Period = 'day' | 'week' | 'month';`
  `export function reportRange(period: Period, date: string, tz: string): { from: Date; to: Date; bucket: 'hour' | 'day' }`
  with local midnights from `localDayStart` (`demo/demo-generators.ts`, imported as it is): day = `[date, date+1)`,
  hour buckets; week = `[date, date+7)`, day buckets; month = `[first of month, first of next)`, day buckets.
- `ExportsService.summaryTable(q: SummaryQueryDto): Promise<{ header: string[]; rows: unknown[][] }>`: today's
  `summaryBatches` body up to `out`; `summaryBatches` now yields `summaryTable`'s rows in `BATCH` slices.
- `report-html.ts`:
  ```ts
  export type ReportInput = { siteName: string; period: Period; rangeLabel: string; generatedAt: string;
    generatedBy: string; header: string[]; rows: unknown[][]; labels: Record<string, string> };
  export function reportHtml(input: ReportInput): string;
  ```
  One self-contained page (inline `<style>`, A4 print CSS, no `<script>`, no external URL): a header (site name,
  period, `rangeLabel`, generated at, by whom); totals over all cameras per bucket for the `events.*` and
  `intervals.*` columns; then per camera a table (bucket × columns) and one inline-SVG bar chart per `events.*` and
  `intervals.*` column (bars scaled to that column's max; zero rows draw nothing). Rows empty → one line
  "Tidak ada data untuk periode ini". Every text from data or settings goes through one `escapeHtml` (`& < > " '`).
  Labels per decision 12, built by the caller.

- [ ] **Step 1: Implement**

- [ ] **Step 2: Write the focused tests**

```ts
// report-range.spec.ts
it('month of 2026-10-19 in Asia/Jakarta → 2026-09-30T17:00Z to 2026-10-31T17:00Z, day buckets')
it('week of 2026-10-01 → 7 days; day → 24 hour buckets range')
// report-html.spec.ts
it('a camera named <script>alert(1)</script> appears only as &lt;script&gt;…')        // spec test
it('no rows → the "Tidak ada data" line and no <svg>')
it('the page has no "http" outside the SVG xmlns and no <script>')
```

- [ ] **Step 3: Run everything** (`cd apps/api && npm run lint && npm run build && npm test`), expect pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "feat(api): PDF report page built from the summary query, escaped, inline SVG charts"
```

---

### Task 9: Export jobs API, the PDF tick, Gotenberg

**Files:**
- Create: `apps/api/src/exports/{export-jobs.controller.ts,export-jobs.service.ts,pdf.job.ts}`,
  `apps/api/src/exports/dto/export-job.dto.ts`
- Modify: `apps/api/src/exports/exports.module.ts`, `deploy/docker-compose.yml` (`gotenberg` service, API
  `GOTENBERG_URL`), `deploy/.env.example`, `deploy/.env.demo.example` (nothing to set: say so in a comment)
- Test: create `apps/api/test/export-jobs.e2e-spec.ts` (a local `http.createServer` as the fake Gotenberg)

**Interfaces:**
- `CreateExportJobDto`: `period` `IsIn(['day','week','month'])`; `date` `^\d{4}-\d{2}-\d{2}$` and a real date;
  `cameraIds?: string[]` (at most 50, each a string); `useCase?: string`. The service also checks every camera id
  exists and the use case is in `contracts.registry.useCases` (400 `VALIDATION_FAILED` with the path).
- `ExportJobDto = { id; params; status: 'QUEUED'|'DONE'|'FAILED'|'EXPIRED'; error: string | null;
  sizeBytes: number | null; createdAt: string; finishedAt: string | null; fileUrl: string | null }`
  (`fileUrl = /api/v1/exports/jobs/<id>/file` when `DONE`).
- `ExportJobsController.create`/`.list`/`.file` (operation ids `exportJobsCreate`, `exportJobsList`, `exportJobsFile`).
- `POST /api/v1/exports/jobs` (any role) → 202 with the row; no `GOTENBERG_URL` → 503 `UNAVAILABLE` (before
  validation is fine). `setAudit({ action: 'export.pdf', entity: 'export', entityId: id, after: params })`.
  `createdById`/`createdByName` from the actor.
- `GET /api/v1/exports/jobs` → `ExportJobDto[]`, `createdById = actor.id`, `createdAt DESC`, 50.
- `GET /api/v1/exports/jobs/:id/file`: an `id` failing a uuid regex, another owner, or not `DONE` → 404 `NOT_FOUND`;
  else `res.download`-style `sendFile` from `EXPORTS_DIR` with `Content-Type: application/pdf`,
  `Content-Disposition: attachment; filename="report-<period>-<date>.pdf"`, `Cache-Control: no-store`.
- `PdfJob.tick(now = new Date())` every 5 s with `JOBS=on`: one row `QUEUED AND runAt <= now ORDER BY runAt`.
  `reportRange` → `exports.summaryTable({from, to, bucket, cameraIds: ids?.join(','), useCase})` → `reportHtml`
  (`rangeLabel` from the local first and last day, `generatedAt` = local now, `generatedBy` = `createdByName`,
  labels per decision 12) → `POST ${GOTENBERG_URL}/forms/chromium/convert/html` as `FormData`: `files` =
  `Blob(html)` named `index.html`, `paperWidth 8.27`, `paperHeight 11.7`, margins `0.4`, `printBackground true`;
  `AbortSignal.timeout(60_000)`. 2xx → stream to `EXPORTS_DIR/<id>.pdf.part`, rename, `DONE`, `filePath`,
  `sizeBytes`, `finishedAt`. Unreachable, timeout or 5xx → `attempts + 1`, retry after 1, 2, 4 min; the 4th failure
  → `FAILED`, `error 'PDF service unavailable'`. A 4xx → `FAILED`, `error 'PDF conversion failed (<status>)'`.
- Compose: `gotenberg: image: gotenberg/gotenberg:8.<x>.<y>` (the newest 8.x tag on Docker Hub today, pinned
  exactly), `command: ["gotenberg", "--api-timeout=70s"]`, `restart: unless-stopped`, no `ports`, no `profiles`
  (so default and demo both run it). API: `GOTENBERG_URL: ${ZOO_GOTENBERG_URL-http://gotenberg:3000}`.

- [ ] **Step 1: Implement**

- [ ] **Step 2: Write the focused tests**

```ts
it('POST without GOTENBERG_URL → 503 UNAVAILABLE')
it('POST {period: "week", cameraIds: ["nope"]} → 400 at /cameraIds; a good one → 202 QUEUED and an export.pdf audit row')
it('tick with the fake answering %PDF bytes → DONE; GET file as the owner → 200 application/pdf, the name report-week-<date>.pdf')   // spec test
it('another user → 404; /exports/jobs/not-a-uuid/file → 404 NOT_FOUND, not 500')                                                    // Review Focus 4, spec test
it('the fake answers 503 four times → FAILED "PDF service unavailable"')
it('the HTML the fake received escapes a camera named <script>')
it('GET /exports/jobs lists only the caller\'s jobs, newest first')
```

- [ ] **Step 3: Run everything** (`cd apps/api && npm run lint && npm run build && npm test && npm run test:e2e`),
expect pass. Then `docker compose -f deploy/docker-compose.yml --env-file deploy/.env.demo --profile demo up -d
gotenberg api` and one real job through `curl` against `127.0.0.1:3001`: the PDF opens and shows the tables and
charts. Look at it before committing.

- [ ] **Step 4: Commit**

```bash
git add apps/api deploy
git commit -m "feat(api): PDF export jobs printed by Gotenberg, listed and downloaded by their owner"
```

---

### Task 10: I8 trusted proxy re-resolve; CSV close race and file name

**Files:**
- Modify: `apps/api/src/auth/trusted-proxy.ts` (+ `trusted-proxy.spec.ts`), `apps/api/src/exports/csv-responder.ts`,
  `apps/api/src/exports/exports.service.ts` (`filename`)
- Test: extend `apps/api/test/exports.e2e-spec.ts`

**Interfaces:**
- `trustedProxy(host, lookup, now = Date.now)`: `trust(addr)` that returns false for a string address also starts
  `void refresh()` when the last refresh *started* ≥ 10 s ago (one in flight at most). The answer for that request
  is still false; later requests see the new list. The 60 s timer stays.
- `CsvResponder.send`: `const gone = new AbortController(); res.once('close', () => gone.abort());` moves above the
  audit `await` (`streamCsv` already returns at once on an aborted signal).
- `filename(kind, range)`: the last date is the local date of `to − 1 ms`.

- [ ] **Step 1: Implement**

- [ ] **Step 2: Write the focused tests**

```ts
// trusted-proxy.spec.ts (fake lookup, injected clock)
it('an untrusted peer triggers one lookup; another within 10 s none; after 10 s one more')
it('after the lookup returns the new address, that peer is trusted')
// exports.e2e-spec.ts
it('from 2026-10-01T00:00+07:00 to 2026-10-08T00:00+07:00 → events-2026-10-01-2026-10-07.csv')   // spec text
```

- [ ] **Step 3: Run everything** (`cd apps/api && npm run lint && npm run build && npm test && npm run test:e2e`), expect pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "fix(api): re-resolve the proxy on an untrusted peer; CSV abort before audit; inclusive last date in file names"
```

> **Session C ends here.** Opus reviews Tasks 9 and 10 (the owner check and the uuid guard, nothing from the job's
> params reaching the HTML unescaped, Gotenberg failures never leaving a `.part` served, the refresh rate limit).

---

> **Session D starts here: Tasks 11–12.**

### Task 11: Contract files and `fe-contract.md` v0.6

**Files:**
- Modify: `apps/api/openapi.json` (regenerated), `packages/contracts/generated/**` (if anything is stale),
  `docs/fe-contract.md`

**Interfaces:**
- `fe-contract.md`, in the existing sections (no renumbering): section 3 who reads and edits site settings;
  section 7 `stream-info` `evidenceBytes`/`evidenceCount` and the camera's `recording.evidenceRetentionDays`;
  section 8 the zone comes from `GET /site-settings` (load once after login); section 9 event rows' `evidence`;
  section 10 PDF jobs (create 202, list, file, statuses, 503 without Gotenberg, the 7-day expiry) and the inclusive
  last date; section 11 `POST /events/:id/evidence`, kept clips with byte ranges and the rewritten Safari note
  (only kept clips seek in Safari); section 12 `disk.warning` in the `managers` room; section 13 `disk_low`.
  Section 14 `### v0.6`: one line per row of the spec's section 7 table, the CSV name marked **changed**, plus the
  debug-view "up to 15 per second" line.

- [ ] **Step 1: Regenerate and write the docs**

Run: `cd packages/contracts && npm run generate && npm run check`; `cd apps/api && npm run openapi`.

- [ ] **Step 2: Run everything**

Run: `cd packages/contracts && npm test`; `cd apps/api && npm run lint && npm run build && npm test && npm run
test:e2e && npm run openapi:check`; `cd services/engine && uv run pytest -q`. Expected: all pass, no stale file.

- [ ] **Step 3: Commit**

```bash
git add apps/api/openapi.json packages/contracts docs/fe-contract.md
git commit -m "docs(contract): v0.6 site settings, evidence, PDF jobs, disk warnings"
```

---

### Task 12: Docs, the laptop checks at API level, review, `contract-v0.6`

**Files:**
- Modify: `deploy/README.md` (section "Variables added in Phase 4b": `EVIDENCE_DIR`, `EXPORTS_DIR`,
  `ZOO_GOTENBERG_URL`, `ZOO_SITE_TIMEZONE` removed (set the zone in Site settings after upgrading); the
  `chown -R 1000:1000 "$ZOO_DATA_DIR"` step and why; Gotenberg's image size), `docs/10_LOCAL_QUICKSTART.md`
  (Phase 4b laptop run), `docs/fe-dev-setup.md` (Gotenberg in the demo profile)

- [ ] **Step 1: Write the docs**

- [ ] **Step 2: Laptop run, API level** (native MediaMTX; compose `postgres redis api-migrate api caddy gotenberg`;
  two `feed_*` cameras added as `RTSP`, one with `auditCamera`)

| Check | Pass when |
|---|---|
| Pin | a warning event (or `POST /events/:id/evidence`) → within ~2 min the row is `KEPT` and the file is in `data/evidence/<cam>/<date>/` |
| Ranges | `curl.exe -b cookie.txt -r 0-99 -o NUL -w "%{http_code}" http://localhost:8080/media/clips/<id>` → `206` |
| Rolled over | delete that camera's segment files under `data/recordings/zv_<id>/` → the clip still plays |
| Snapshot retention | `PATCH /site-settings {snapshotRetentionDays: 1}`, `tick` (restart the API, wait 60 s) → old snapshot folders gone, kept events' JPEGs stay |
| Zone | `PATCH {timeZone: "Asia/Makassar"}` → `summary.csv` hours move by one, no restart; set it back |
| PDF | a week PDF for both cameras → `DONE`, downloads, opens; `export.pdf` and `export.csv` rows in the audit log |
| Disk | the API's first `DiskJob` line lists the Docker Desktop disk once, and its used % matches `df -h /data` inside the `api` container |

Write the results into the PR description draft (scratchpad). A failure is fixed on this branch before the tag.

- [ ] **Step 3: Whole-branch review**

Dispatch an Opus reviewer over `git diff main...phase-4b-evidence` with the spec and this plan. Fix Critical and
Important findings; list the rest in memory `phase-4b-followups` (create it), with decision 9 (Linux ownership,
verify in the Phase 5 soak).

- [ ] **Step 4: Commit the docs and fixes**

```bash
git add deploy docs
git commit -m "docs: Phase 4b laptop run, deploy variables, data folder ownership"
```

- [ ] **Step 5: Tag and push (after the user's yes)**

```bash
git tag contract-v0.6
git push -u origin phase-4b-evidence
git push origin contract-v0.6
```

The pull request waits for the frontend plan's joint run (W6); merge with a merge commit, never a squash.
