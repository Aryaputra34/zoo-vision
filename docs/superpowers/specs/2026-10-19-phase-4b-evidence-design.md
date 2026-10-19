# Zoo Vision Phase 4b: evidence and exports (design)

- **Status:** written 2026-10-19, awaiting the user's review
- **Date:** 2026-10-19
- **Parent spec:** `docs/superpowers/specs/2026-10-08-zoo-vision-production-architecture-design.md`, sections 5
  (evidence, disk sizing), 6 (deployment), 7 (site settings, exports) and 8 (tests, error handling). The 4a spec
  (`2026-10-15-phase-4a-video-design.md`) split Phase 4 and listed what 4b takes ("For 4b" in its section 4). This
  document adds the 4b detail and records where it departs from the parent spec ("Changes to the parent spec").
- **Readers:** the backend developer (the project lead), who builds both the backend and the frontend of 4b, and
  the FE team, who will redesign the 4b pages later. Section 7 is the contract they build against.

## Goal

Important events keep their video after the continuous recording rolls over, and a kept clip plays in every
browser, Safari included. Snapshots, kept clips, export files and the recordings of deleted cameras are cleaned up
on schedule, and the disk warns before it fills. A manager downloads a PDF summary next to the CSVs. The site's
time zone and retention defaults live in the database and are edited in the web UI.

## Decisions taken in the 2026-10-19 brainstorm

| # | Question | Decision |
|---|---|---|
| 1 | How the PDF is made | **The API builds the HTML** (tables and inline-SVG bar charts) and Gotenberg only prints it (`convert/html`). Not a print page in the web app: that needs a render login for headless Chromium, Gotenberg reaching `web` and `api`, and breaks when the FE changes. Not a Node PDF library: the most code. |
| 2 | Who builds the 4b frontend | **The backend developer, as a proof of concept**, as in 4a. The FE team redesigns later. |
| 3 | What runs background work | **A tick in the `JOBS=on` process over Postgres rows**, the pattern of `OfflineJob`. Not BullMQ: one park has tens to hundreds of pins a day and a few PDFs a week, and exactly one process runs jobs, so there is no competition for rows and no lease to manage. |
| 4 | Clips of audit cameras | **The parent spec's rule stays: every event on an `auditCamera` camera is kept.** Retention is a site default plus a **per-camera override** set in the dashboard; lowering it is how old clips are cleaned. No single-clip or bulk delete screen. |
| 5 | Overengineering pass | Cut: a `RUNNING` status and its startup reset, a Redis publish for settings changes, running retention right after a save, a per-user export limit, who-requested columns on `Evidence` (the audit row has it). |

## 1. Site settings

### Table

`SiteSettings`, one row (`id = 1`), inserted by the migration with these defaults. The API's `zoo_api` role gets
`SELECT, UPDATE` on it.

| Field | Default | Used by |
|---|---|---|
| `siteName` | `Zoo Vision` | PDF header |
| `timeZone` | `Asia/Jakarta` | report buckets, CSV and PDF local times, export file names, the web's time formatting |
| `recordingRetentionDays` | 7 | MediaMTX `recordDeleteAfter` for cameras whose `retentionDays` is null (replaces 4a's hard-coded 7) |
| `snapshotRetentionDays` | 90 | retention job, snapshots |
| `auditSnapshotRetentionDays` | 365 | retention job, snapshots of `auditCamera` cameras |
| `evidenceRetentionDays` | 365 | retention job, kept clips of cameras whose `evidenceRetentionDays` is null |

Fixed in code, not settings: export files live 7 days; the disk thresholds are 85% and 95%.

### API

- `GET /api/v1/site-settings`: any logged-in role (the web needs `timeZone` on every page).
- `PATCH /api/v1/site-settings`: SUPERADMIN. `timeZone` must be an IANA name (the check `env.ts` uses today);
  every `*Days` is an integer ≥ 1; `siteName` 1–100 characters. Audited by the existing interceptor
  (`site_settings.update`).
- `SITE_TIMEZONE` is removed from `env.ts`, the compose file and `.env.example`. The demo CLI reads the row.

### Live without a restart

- `SiteSettingsService` loads the row at start and replaces its copy after a PATCH. Shortcut: a second API process
  would not see a change; there is none (compose runs one `api`), and the comment says so.
- Every reader of `env.SITE_TIMEZONE` reads the service instead: the report SQL takes the zone per query as today;
  `ExportsService` and `SystemLogService` build their `localDateTime` formatter per export instead of in the
  constructor.
- A PATCH that changes `recordingRetentionDays` runs one path-sync pass, so MediaMTX has the new value in seconds.

### Web

`SITE_TZ` in `src/lib/time.ts` goes. The settings are loaded once after login; the formatters are built lazily
from the loaded zone. Other open tabs pick up a change on reload; the zone changes perhaps once in a site's life.

**Kept limit:** DST at midnight and 30-minute offsets stay unsupported (Phase 3). Indonesia has neither.

## 2. Evidence (kept clips)

### Table

`Evidence`, mutable (`Event` is append-only for `zoo_api`):

| Field | |
|---|---|
| `eventId` | primary key, FK to `Event` |
| `cameraId`, `eventTime` | copied from the event, so the jobs never join |
| `reason` | `SEVERITY`, `AUDIT_CAMERA` or `USER` |
| `status` | `QUEUED`, `KEPT`, `NO_RECORDING` or `FAILED` |
| `runAt`, `attempts`, `error` | for the pin tick |
| `filePath`, `sizeBytes` | once `KEPT`; `filePath` is relative to `EVIDENCE_DIR` |
| `createdAt` | |

Index on `(status, runAt)` for the tick and on `(cameraId, eventTime)` for retention and usage. `zoo_api` gets
`SELECT, INSERT, UPDATE, DELETE` on `Evidence` and on `ExportJob` (section 4).

### How a row is made

- **In ingest**, in the same transaction as the event insert: for a `warning` or `critical` event, or any event of
  a camera with `auditCamera`, when the event has a `cameraId`. `runAt` = event time + `clipAfterSec` + 60 s, so
  MediaMTX has written the end of the clip. `ON CONFLICT DO NOTHING`: a redelivered message never makes a second
  row.
- **By hand**: `POST /api/v1/events/:id/evidence`, MANAGER and up, audited (`evidence.keep`). An event that is
  already kept answers 200 with its row; a `FAILED` or `NO_RECORDING` row is queued again (a manual retry, and the
  way to keep a clip for an event that was not pinned automatically). No "un-keep".

### The pin tick

Every 10 s in the `JOBS=on` process, guarded like `OfflineJob` (`running` flag, `tick()` public for tests), up to
5 due rows (`status = 'QUEUED' AND "runAt" <= now()`) per tick, one after another:

1. Fetch the clip with the same playback request `ClipsService` makes today. That request moves into one shared
   function used by both, so a live clip and a pinned clip can not differ.
2. **I5:** a 404 on the recorded path is tried once on the camera's other path (`zv_<id>` ↔ `zv_<id>_sub`), in the
   shared function, so live clips get the fallback too.
3. Stream the answer to `EVIDENCE_DIR/<camera>/<YYYY-MM-DD>/<eventId>.mp4.part` (the date of the event in the site
   time zone), rename to `.mp4`, set `KEPT`, `filePath`, `sizeBytes`.
4. 404 on both paths, or a camera with no recorded path: `NO_RECORDING` (final). The row still protects the event's
   snapshot from snapshot retention (section 3), so a critical event on a camera without recording keeps its JPEG
   as long as kept evidence lives.
5. MediaMTX unreachable, a timeout or a 5xx: `attempts + 1`, `runAt` = now + 1, 2, 4 … minutes; after 8 attempts
   (about 4 hours) `FAILED` with the reason in `error`.

A crash mid-pin leaves the row `QUEUED`; the next attempt overwrites the `.part` file. The camera and event ids
are written by the engine as `[A-Za-z0-9_-]` names, and the tick refuses any other character before building a
path.

### Serving

- `GET /media/clips/:eventId`: a `KEPT` row answers from the file with `res.sendFile` (byte ranges, so Safari plays
  it and seeking works; `Cache-Control: private, max-age=3600`). Without one, the clip streams from playback as
  today, still without ranges.
- Event rows gain `evidence: {status, reason} | null`. `clipUrl` is also set when the clip is kept but the camera
  no longer has a recorded path.
- `GET /api/v1/cameras/:id/stream-info` gains `evidenceBytes` and `evidenceCount` (a `SUM` over that camera's
  `KEPT` rows), so the camera form shows which camera fills the disk.

### Retention per camera

New column `Camera.evidenceRetentionDays` (null = the site's `evidenceRetentionDays`), SUPERADMIN like the other
recording fields, in the camera's recording settings. Lowering it is how old clips are cleaned: the next hourly
retention pass deletes the clips older than the new value. The camera save's audit row records who shortened it,
from what to what.

**Disk, for reference** (30 s clip ≈ 15 MB on a 4 Mbit/s main stream, ≈ 4 MB on a 1 Mbit/s sub-stream): an audit
cashier camera at 50–100 events a day keeps 0.3–0.5 TB a year; an audit gate camera at 1,000–2,000 a day keeps
5–11 TB a year on the main stream. That gate camera wants a short `evidenceRetentionDays` or a sub-stream
recording; `stream-info` and the disk warnings show it.

## 3. Retention and disk

### Retention job

`RetentionJob`, the same tick pattern, once an hour (every pass is idempotent):

| What | Rule |
|---|---|
| **Snapshots** | In `SNAPSHOT_DIR/<camera>/<YYYY-MM-DD>/`, folders older than `snapshotRetentionDays` (`auditSnapshotRetentionDays` for audit cameras; the site default for folders of deleted cameras). Files whose event id has an `Evidence` row stay; the rest go, then the folder if empty. Names that do not parse as a date are left alone. This also bounds the demo feed's snapshots (it writes the same tree). |
| **Kept clips** | `Evidence` rows (any status) whose `eventTime` is older than the camera's `evidenceRetentionDays` or the site's: delete the file if any, then the row. The event's snapshot goes at the next pass. |
| **Export files** | `ExportJob` rows finished more than 7 days ago: delete the file, set `EXPIRED`. |
| **Recordings of deleted cameras (I6)** | In `RECORDINGS_DIR`, folders named `zv_<id>` or `zv_<id>_sub` whose camera no longer exists: segment files older than `recordingRetentionDays` (by modification time), then the empty folder. MediaMTX only cleans paths it still has, so nothing cleans these today. Other folders (`feed_*`) are never touched. |

Mounts: the API's `snapshots` and `recordings` volumes become read-write; new `EVIDENCE_DIR` (`/data/evidence`)
and `EXPORTS_DIR` (`/data/exports`), read-write.

**Not in 4b: pruning database rows** (the parent spec's 2 years for analytics, 1 year for the system log). `zoo_api`
can not `DELETE` from those tables by design, they grow a few GB in 2 years, and no site has data that old. It
needs a prune function run by the owner role; parked.

### Disk warnings

`DiskJob`, every 5 minutes: `statfs` on `RECORDINGS_DIR`, `SNAPSHOT_DIR`, `EVIDENCE_DIR` and `EXPORTS_DIR`, each
disk counted once (by device id).

- Crossing **85%** writes a system event `disk_low` with severity `warning`, crossing **95%** one with `critical`;
  `data {path, usedPercent, freeBytes}`, `cameraId` null. Once per crossing; a level re-arms when usage falls 2
  points below it. The state is in memory: after an API restart a disk that is still full warns once more.
- The same moment sends `disk.warning {path, usedPercent, freeBytes, severity, time}` to the `managers` WebSocket
  room, as `audit.notice` does; the web shows a banner.
- Warnings only: MediaMTX still deletes recordings by age, not by free space.

### Retention indexes (Phase 3 performance items)

- Interval stats get `AND ("end" IS NULL OR "end" > from)` and an index on `Interval (kind, "end")`.
- An index on `Metric (minute)` for the metric series without `cameraIds` and the `metrics.csv` range scan.
- The plan checks each with `EXPLAIN` on a year of seeded demo data and keeps only the indexes that change the plan.

## 4. PDF exports

### Table

`ExportJob`:

| Field | |
|---|---|
| `id` | uuid |
| `params` | JSON `{period: "day" \| "week" \| "month", date: "YYYY-MM-DD", cameraIds?: string[], useCase?: string}` |
| `status` | `QUEUED`, `DONE`, `FAILED` or `EXPIRED` |
| `runAt`, `attempts`, `error` | for the PDF tick |
| `filePath`, `sizeBytes`, `finishedAt` | once `DONE` |
| `createdById`, `createdByName`, `createdAt` | |

PDF only: the CSVs keep streaming directly, as today.

### API (any logged-in role, like the CSVs)

- `POST /api/v1/exports/jobs` → 202 with the row. Validates the params (camera ids exist, use case known), writes
  the audit row (`export.pdf`, with the params) and queues. Without `GOTENBERG_URL`: 503 `UNAVAILABLE`.
- `GET /api/v1/exports/jobs`: the caller's own jobs, newest first, the last 50.
- `GET /api/v1/exports/jobs/:id/file`: the owner only (anyone else, or a job not `DONE`: 404). Sent as an attachment
  named `report-<period>-<date>.pdf`.

### Range and buckets (site time zone)

| Period | Range | Buckets |
|---|---|---|
| `day` | that day | hour |
| `week` | 7 days from `date` | day |
| `month` | the calendar month that contains `date` | day |

The numbers come from the query behind `summary.csv`, so the PDF, the CSV and the report endpoints agree.

### The PDF tick

Every 5 s, one due job at a time:

1. Run the summary query and build one HTML page: a header (`siteName`, period, local range, generated at, by
   whom), a totals section over the chosen cameras, then one section per camera with a table (bucket × column) and
   inline-SVG bar charts of its event counts and interval totals. Column labels are the contract schemas' `title`
   where present, else the key. Every text is HTML-escaped; the page loads nothing external.
2. POST it to Gotenberg `/forms/chromium/convert/html` (A4, 60 s timeout), stream the answer to
   `EXPORTS_DIR/<id>.pdf.part`, rename, set `DONE`.
3. Gotenberg unreachable or a 5xx: retry after 1, 2 and 4 minutes, then `FAILED` ("PDF service unavailable"). A
   range with no data still gives a PDF that says so.

### Deploy

A `gotenberg` service (pinned `gotenberg/gotenberg:8.x` tag), internal network only, no host port, in the default
and the demo profiles. `GOTENBERG_URL=http://gotenberg:3000` on the API.

### Phase 3 export fixes

- `CsvResponder` attaches `res.once('close')` before the audit `await` (the close race).
- CSV file names carry the inclusive last day: the local date of `to − 1 ms`, so `from` 1 Oct and `to` 8 Oct give
  `…-2026-10-01-2026-10-07.csv`.

## 5. Smaller items

| Item | 4b does |
|---|---|
| **I8** trusted proxy | A request from a peer outside the trusted set makes `TrustedProxyService` re-resolve `TRUSTED_PROXY_HOST` at once, at most once per 10 s, closing the up-to-a-minute gap after Caddy gets a new address. |
| 4a suggestions (`pubsub.ts` failure handler, `debug_frames.py` on Redis failure, one shared box geometry schema) | **Parked.** 4b does not touch that code and none is visible to users. |
| Demo snapshot growth | Section 3 (snapshot retention). |

## 6. The frontend (backend developer, proof of concept)

Branch `phase-4b-evidence` in `zoo-vision-fe`, cut from `main`. UI text in Indonesian, existing components, light
styling; the FE team redesigns later.

| Piece | What |
|---|---|
| Time | `src/lib/time.ts` reads the zone from site settings, loaded once after login; formatters built lazily |
| Exports page | PDF form (period, date, cameras or use case) and the caller's jobs, polled every 3 s while one is `QUEUED`: status, download, expired. Below it the existing CSV downloads with a date range and use case. |
| Site settings page | the six fields; SUPERADMIN edits, MANAGER reads |
| Camera form | `evidenceRetentionDays` with the recording fields; `StreamPanel` shows `evidenceBytes`/`evidenceCount` |
| Events | "Simpan bukti" (keep evidence) for MANAGER and up; a badge with the evidence status |
| Shell | a banner on `disk.warning` |

After merging, the generated contract files are re-pulled (`npm run contract:pull contract-v0.6`), never merged by
hand.

## 7. The contract: `contract-v0.6`

One tag at the end of 4b, additive over v0.5; every item gets a changelog entry in `fe-contract.md`.

| Item | Change |
|---|---|
| `GET`/`PATCH /api/v1/site-settings` | new |
| `POST /api/v1/events/:id/evidence` | new, MANAGER and up |
| event rows | new `evidence: {status, reason} \| null` |
| `/api/v1/exports/jobs` | new: create, list, file |
| camera view and save | new `evidenceRetentionDays` |
| `stream-info` | new `evidenceBytes`, `evidenceCount` |
| system events | new type `disk_low` |
| WebSocket | new message `disk.warning` in the `managers` room |
| `/media/clips/:eventId` | byte ranges for kept clips; the Safari note in section 11 is rewritten |
| CSV file names | the last date is inclusive |
| debug view | the "up to 15 per second" line changed after v0.5 goes out with this tag |

## 8. Tests and the laptop run

No test-first steps: each task ends with one focused test where the logic is risky.

| Area | What the tests prove |
|---|---|
| Ingest | a warning event and an audit-camera event each get one `Evidence` row; the same message twice still one |
| Pin tick (fake playback) | `KEPT` with the file in place; 404 on both paths → `NO_RECORDING`; a 5xx backs off, then `FAILED`; an id with a `/` is refused |
| Clip serving | a kept clip answers a `Range` request with 206; without one the playback stream is unchanged |
| Retention job (temp folders) | expired snapshot folders go, evidence-protected files stay; only `zv_*` folders of deleted cameras are swept, `feed_*` never; a lowered camera retention removes that camera's older clips |
| Disk job | the crossing and re-arm logic, as a pure function |
| Site settings | a zone change shows in the next CSV without a restart; only SUPERADMIN may PATCH |
| PDF (fake Gotenberg) | the job reaches `DONE`; a camera name with `<script>` is escaped in the HTML; another user's file is 404 |
| Indexes | the `EXPLAIN` check in the plan |
| Contract | CI fails on a stale `openapi.json` or web types file, as before |

**Laptop run** (native `mediamtx.exe`, the demo profile with Gotenberg, two `feed_*` cameras added as `RTSP`):

| Parent spec verification | Check |
|---|---|
| #7, the clip half | a warning event is kept; after its recording segment is deleted the clip still plays; `curl -r 0-99` gets 206 |
| #9 | PDF and CSV for 3 cameras over a week, downloaded from the Exports page; both appear in the audit log |
| new | snapshot retention set to 1 day on the demo data: old folders go, kept events' snapshots stay |
| new | the time zone changed in Site settings: report buckets and CSV times move without a restart |

## Changes to the parent spec

1. **No BullMQ.** Pins and PDFs run as ticks over Postgres rows in the one `JOBS=on` process (decision 3).
2. **The PDF is HTML built by the API**, not a print page of the web app; its charts are simpler than the
   dashboard's (decision 1).
3. **Only PDFs are background jobs.** CSVs of any size stream directly (they already read from a cursor).
4. **Per-camera evidence retention** (`Camera.evidenceRetentionDays`) next to the site default; lowering it is the
   cleaning tool.
5. **Database row retention is parked**: the API's role can not delete analytics rows, and no data is old enough.
6. **Disk warnings are warnings only**: no deleting of recordings by free space.
7. **Unkept clips still have no byte ranges**; keeping a clip is the way to play it in Safari.
8. **New:** `SiteSettings` (with `siteName`), `Evidence`, `ExportJob`, `disk_low`, `disk.warning`.
