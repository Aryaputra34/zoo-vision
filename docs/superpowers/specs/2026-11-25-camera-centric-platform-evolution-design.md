# MagniVision Platform Evolution: Camera-Centric Multi-UseCase, Hybrid License & Integrations (Design Spec)

- **Status:** Draft untuk review tim Backend (`zoo-vision`) & Frontend (`zoo-vision-fe`)
- **Tanggal:** 2026-11-25
- **Nama Produk:** **MagniVision**
- **Dasar:** Hasil MoM TSI & diskusi arsitektur (evolusi dari [2026-10-08-zoo-vision-production-architecture-design.md](./2026-10-08-zoo-vision-production-architecture-design.md))
- **Cakupan Repo:** `zoo-vision` (API, Engine, Contracts, Deploy) & `zoo-vision-fe` (Next.js Web UI)

---

## 1. Ringkasan Eksekutif & Pemetaan MoM

Arsitektur awal `zoo-vision` dirancang untuk satu pelanggan (Taman Safari) dengan relasi **1 Kamera = 1 Use Case** dan halaman operasional yang dikelompokkan per use case.

Berdasarkan hasil **MoM TSI**, produk berevolusi menjadi platform video analytics **camera-centric & extensible** (mengadopsi pola arsitektur Nx MetaVMS + Nx AI Manager):
- 1 kamera dapat menjalankan **banyak use case sekaligus** (default maksimal **4**, dapat dikonfigurasi).
- Use case bekerja seperti **extension library** yang bisa ditambahkan ke kamera sesuai **Hybrid License** per client, tetap menggunakan **1 repo & 1 set release image** untuk semua client.
- UI mendukung **tampilan generik (day-1)** sekaligus **tampilan analitik khusus permintaan client** melalui 3-Slot UI Registry.
- Sistem menyediakan **Public OpenAPI + Webhook** untuk integrasi pihak ketiga, **Live View bersih tanpa bounding box**, dan **tema general (white-label)**.

### Pemetaan Poin MoM ke Prioritas

| Prioritas | Poin MoM | Ringkasan Perubahan | Repo Terdampak |
|---|---|---|---|
| **P0** (Quick Win) | **#2** Live Camera tanpa bbox | Hapus overlay bbox di Live View; Debug View tetap khusus `SUPERADMIN`; `BoxPublisher` jadi opsional | `zoo-vision-fe`, `services/engine` |
| **P0** (Quick Win) | **#7** Tema General | White-label UI, hapus branding safari, `APP_NAME` & branding di `SiteSettings` | `zoo-vision-fe`, `apps/api` |
| **P1** (Fondasi) | **#5** Multi-UseCase per Kamera | Refactor `Camera` (1) → `CameraUseCase` (0..N), single-stream fan-out di `CameraWorker`, per-usecase FPS, `SiteSettings.maxUseCasesPerCamera` | `packages/contracts`, `apps/api`, `services/engine` |
| **P1** (Fondasi) | **#1, #6** Camera-Centric UI & Summary | Area Operasional → Camera List (mini-summary per use case) → Camera Detail + 3-Slot UI Registry (Generic + Custom override) | `packages/contracts`, `apps/api`, `zoo-vision-fe` |
| **P2A** (Komersial) | **#3** Lisensi Hybrid | Offline signed Ed25519 license (`maxCameras`, `maxUseCasesPerCamera`, kuota per `useCase`, `features`), UI aktivasi & CLI issuer | `apps/api`, `zoo-vision-fe`, repo internal `license-issuer` |
| **P2B** (Integrasi) | **#4** OpenAPI & Webhook | Tag/docs Public Integration API + `WebhookEndpoint` + BullMQ async delivery + HMAC signature | `apps/api`, `zoo-vision-fe` |
| **P3** (Distribusi) | **#8** Packaging Multi-Client | Single GHCR image + model pack sesuai lisensi + offline bundle untuk site air-gapped | `deploy/`, `.github/workflows/`, `tools/` |

---

## 2. Prioritas 0 — Quick Wins (Live Clean View & Tema General)

### 2.1 Live Camera Tanpa Bounding Box (MoM #2)
- **Live View (User, Manager, Superadmin):**
  - Video tetap mengalir langsung dari MediaMTX melalui WebRTC (WHEP).
  - `zoo-vision-fe` **menghapus/tidak merender** canvas overlay bounding box pada halaman Live Camera & Camera Detail.
  - Tidak perlu join room WebSocket untuk box stream pada tampilan operasional normal.
- **Debug View (Khusus Developer / `SUPERADMIN`):**
  - Tetap dipertahankan untuk kalibrasi zona/ROI dan verifikasi deteksi, diakses dari menu Debug di Camera Detail (hanya terlihat oleh `SUPERADMIN`).
  - Pada tahap P1 (multi-usecase), Debug View memilih use case spesifik: `/media/debug/:cameraId/:useCase` (Redis key `cam:{id}:debug:{useCase}`).
- **Optimasi Engine (`services/engine`):**
  - Tambahkan env var `PUBLISH_BOXES=false` (default `false`). `BoxPublisher` hanya aktif jika `PUBLISH_BOXES=true` (misalnya ketika kelak mengaktifkan Nx bridge). Menghemat CPU serialization dan trafik Redis.

### 2.2 Tema General / White-Label (MoM #7)
- **Backend (`apps/api`):**
  - Tambah env `APP_NAME` (default `"MagniVision"`) untuk title OpenAPI (`swagger.ts`, misal `"MagniVision API"`) dan default `SiteSettings.siteName`.
  - Tambah kolom opsional pada `SiteSettings`: `brandSubtitle String?` dan `brandLogoUrl String?` (URL `http(s)://` atau relative path `/...`, diakses publik lewat `GET /api/v1/site-settings/branding` untuk halaman login).
  - *Catatan:* nama internal repo/package/cookie teknis tidak wajib di-rename sekarang agar tidak menimbulkan churn; seluruh teks yang tampil ke user menggunakan branding **MagniVision** / konfigurasi `SiteSettings`.
- **Frontend (`zoo-vision-fe`):**
  - Ganti palette warna dan ilustrasi bertema safari menjadi palette enterprise VMS netral (slate/zinc + warna aksen profesional).
  - Nama aplikasi, judul tab browser, dan logo sidebar dibaca dari `GET /api/v1/site-settings` (public subset untuk halaman login).

---

## 3. Prioritas 1 — Multi-UseCase per Camera & Camera-Centric Architecture

Ini adalah fondasi arsitektur utama. Prinsip yang diadopsi dari Nx Meta:
1. **Unik per jenis use case per kamera (`UNIQUE(cameraId, useCase)`):** 1 kamera hanya dapat memasang 1 instance dari setiap jenis use case. Jika 1 kamera butuh memantau beberapa jalur/area untuk use case yang sama (misal 2 tripwire gerbang atau banyak meja), ditangani sebagai **list zona/garis di dalam settings use case tersebut** agar GPU cukup menjalankan 1x inferensi.
2. **Toggle `enabled` tanpa hapus config:** Menonaktifkan use case di kamera tidak menghapus ROI/tripwire atau riwayat versinya.
3. **Batas maksimal per kamera dapat dikonfigurasi:** Dihitung berdasarkan use case yang **`enabled = true`** pada kamera tersebut, dengan rumus:
   ```text
   effectiveMax = min(license.maxUseCasesPerCamera, siteSettings.maxUseCasesPerCamera)
   ```
   *(Sebelum modul lisensi P2A aktif, `effectiveMax = siteSettings.maxUseCasesPerCamera`, default `4`).*

### 3.1 Perubahan Skema Database (`apps/api/prisma/schema.prisma`)

```prisma
model Camera {
  id                    String          @id // slug
  name                  String
  area                  String?
  enabled               Boolean         @default(true)
  sourceType            SourceType
  mainStreamUrlEnc      String
  subStreamUrlEnc       String?
  /// Batas atas FPS decode stream untuk kamera ini (digunakan bila > max FPS use case).
  targetFps             Int             @default(10)
  engineGroup           String          @default("default")
  auditCamera           Boolean         @default(false)
  recordingEnabled      Boolean         @default(true)
  recordingStream       StreamChoice    @default(MAIN)
  inferenceStream       StreamChoice    @default(MAIN)
  retentionDays         Int?
  evidenceRetentionDays Int?
  clipBeforeSec         Int             @default(15)
  clipAfterSec          Int             @default(15)
  nxCameraId            String?
  firstSeenAt           DateTime?       @db.Timestamptz(3)
  createdAt             DateTime        @default(now()) @db.Timestamptz(3)
  updatedAt             DateTime        @updatedAt @db.Timestamptz(3)

  useCases              CameraUseCase[]
  events                Event[]
  intervals             Interval[]
  metrics               Metric[]
}

/// Assignment 1 jenis use case pada 1 kamera (relasi 1 Camera -> 0..N UseCases).
model CameraUseCase {
  id            String                       @id @default(uuid()) @db.Uuid
  cameraId      String
  camera        Camera                       @relation(fields: [cameraId], references: [id], onDelete: Cascade, onUpdate: Restrict)
  useCase       String
  enabled       Boolean                      @default(true)
  /// Target FPS inferensi khusus use case ini (di-throttle dari stream utama kamera).
  targetFps     Int                          @default(5)
  activeVersion Int
  createdAt     DateTime                     @default(now()) @db.Timestamptz(3)
  updatedAt     DateTime                     @updatedAt @db.Timestamptz(3)

  versions      CameraUseCaseConfigVersion[]

  @@unique([cameraId, useCase])
  @@index([useCase, enabled])
}

model CameraUseCaseConfigVersion {
  cameraUseCaseId String        @db.Uuid
  cameraUseCase   CameraUseCase @relation(fields: [cameraUseCaseId], references: [id], onDelete: Cascade, onUpdate: Restrict)
  version         Int
  settings        Json
  schemaVersion   Int
  authorType      String
  authorId        String
  authorName      String
  note            String?
  createdAt       DateTime      @default(now()) @db.Timestamptz(3)

  @@id([cameraUseCaseId, version])
}
```

Perubahan pendukung pada tabel lain:
1. **`Metric`:** ubah primary key dari `@@id([cameraId, name, minute])` menjadi **`@@id([cameraId, useCase, name, minute])`** agar 2 use case di kamera yang sama tidak saling menimpa metrik dengan nama serupa (misal `occupancy` atau `fps`).
2. **`Event` & `Interval`:** **tidak perlu perubahan struktur** karena sudah memiliki kolom `cameraId` dan `useCase`. Opsional: tambah index `@@index([cameraId, useCase, time])` pada `Event` dan `@@index([cameraId, useCase, start])` pada `Interval` untuk mempercepat tab detail per use case di Camera Detail.
3. **`SiteSettings`:** tambah kolom:
   ```prisma
   maxUseCasesPerCamera Int     @default(4)
   brandSubtitle        String?
   brandLogoUrl         String?
   ```

#### Strategi Migrasi Data (Zero Data Loss)
Dalam 1 Prisma migration SQL:
1. Buat tabel `CameraUseCase` dan `CameraUseCaseConfigVersion`.
2. Untuk setiap row di `Camera` lama: insert 1 row `CameraUseCase` (`cameraId = c.id`, `useCase = c.useCase`, `enabled = true`, `targetFps = c.targetFps`, `activeVersion = c.activeVersion`).
3. Pindahkan seluruh row `CameraConfigVersion` yang memiliki `useCase = c.useCase` ke `CameraUseCaseConfigVersion` dengan `cameraUseCaseId` yang sesuai. *(Jika ada histori versi lama dengan `useCase` berbeda akibat perpindahan use case sebelumnya, buat `CameraUseCase` nonaktif `enabled = false` agar histori audit tetap utuh).*
4. Ubah PK `Metric` menjadi `(cameraId, useCase, name, minute)`.
5. Drop kolom `Camera.useCase`, `Camera.activeVersion`, dan tabel `CameraConfigVersion`.

---

### 3.2 Kontrak & Metadata Summary (`packages/contracts`)

Agar halaman **Area Operasional (Camera List)** dapat menampilkan ringkasan dari beragam use case yang berbeda secara generik (MoM #1 & #6), perluas `packages/contracts/usecases/<id>/usecase.json`:

```json
{
  "label": "Vehicle Gate",
  "description": "Hitung kendaraan masuk/keluar melewati tripwire dan baca plat nomor (ANPR).",
  "category": "traffic",
  "schemaVersion": 1,
  "defaultFps": 5,
  "summary": [
    {
      "field": "inCount",
      "label": "Masuk",
      "kind": "counter"
    },
    {
      "field": "outCount",
      "label": "Keluar",
      "kind": "counter"
    }
  ]
}
```

Spesifikasi field `summary[]` (maksimal 3–4 item utama agar muat di card kamera):
- `field`: nama key pada payload `live` (harus terdefinisi di `live.schema.json`; divalidasi oleh test CI `packages/contracts`).
- `label`: label pendek yang mudah dipahami operator.
- `kind`: `"counter"` (angka kumulatif) | `"gauge"` (nilai saat ini, misal okupansi) | `"status"` (boolean/enum pill, misal `attended` / `unattended`) | `"text"` (string ringkas, misal plat terakhir).
- `unit` *(opsional)*: misal `"org"`, `"meja"`, `"%"`.
- `toneMap` *(opsional, khusus `kind: "status"`)*: misal `{ "true": "ok", "false": "warning" }` agar UI tahu warna badge tanpa hardcode.

---

### 3.3 Perubahan REST API, Engine-Internal & Redis

#### A. REST Endpoints (`/api/v1`)

| Method & Path | Min Role | Fungsi |
|---|---|---|
| `GET /api/v1/usecases` | `USER` | Mengembalikan katalog library use case + `description`, `category`, `defaultFps`, `summary`, `settingsSchema`, `liveSchema`, plus info kuota (`licensed`, `quota`, `used`). |
| `GET /api/v1/cameras` | `USER` | List kamera + array `useCases[]` (`id`, `useCase`, `enabled`, `targetFps`, `activeVersion`). |
| `POST /api/v1/cameras` | `SUPERADMIN` | Buat kamera fisik (boleh tanpa use case awal, atau langsung menyertakan `useCases[]` awal). |
| `POST /api/v1/cameras/:id/usecases` | `SUPERADMIN` | Pasang use case baru ke kamera (`useCase`, `enabled?`, `targetFps?`, `settings`, `note?`). Validasi: (1) use case valid & berlisensi, (2) belum terpasang di kamera ini (`409 USE_CASE_ALREADY_ATTACHED`), (3) jika `enabled=true`, total aktif kamera `<= effectiveMax` (`409 MAX_USE_CASES_REACHED`) dan kuota lisensi mencukupi (`403 LICENSE_QUOTA_EXCEEDED`). |
| `PATCH /api/v1/cameras/:id/usecases/:useCase` | `MANAGER` (`enabled`), `SUPERADMIN` (`targetFps`) | Toggle `enabled` ON/OFF (tanpa menghapus zona/config) atau ubah `targetFps`. Jika mengaktifkan (`false → true`), validasi `effectiveMax` & kuota lisensi. |
| `DELETE /api/v1/cameras/:id/usecases/:useCase` | `SUPERADMIN` | Lepas use case dari kamera (hapus `CameraUseCase` & versi config-nya; data historis `Event`/`Interval`/`Metric` tetap aman karena hanya mereferensi `cameraId` dan string `useCase`). |
| `GET /api/v1/cameras/:id/usecases/:useCase/config` | `USER` | Ambil config aktif untuk use case tersebut pada kamera tersebut. |
| `PUT /api/v1/cameras/:id/usecases/:useCase/config` | `MANAGER` *(dibatasi `x-minRole`)* | Simpan config versi baru (optimistic locking lewat `baseVersion`, validasi schema & `x-minRole`). |
| `GET /api/v1/cameras/:id/usecases/:useCase/config/versions` | `MANAGER` | Riwayat versi & diff. |
| `POST /api/v1/cameras/:id/usecases/:useCase/config/rollback` | `MANAGER` | Rollback ke versi lama. |
| `GET /media/debug/:cameraId/:useCase` | `SUPERADMIN` | Stream MJPEG debug view untuk use case spesifik pada kamera tersebut. |

#### B. Engine Internal Snapshot (`GET /internal/engine/cameras`)

```ts
export type EngineCameraUseCase = {
  useCase: string;
  version: number;
  schemaVersion: number;
  targetFps: number;
  settings: Record<string, unknown>;
  model: { path: string; imgsz: number | [number, number] };
};

export type EngineCamera = {
  id: string;
  name: string;
  sourceUrl: string;
  /// Stream decode ceiling: max(camera.targetFps, max(uc.targetFps)).
  streamFps: number;
  nxCameraId: string | null;
  /// Hanya use case dengan enabled = true. Jika kosong, engine tidak perlu decode kamera ini.
  useCases: EngineCameraUseCase[];
};
```

*Catatan:* Jika sebuah kamera `enabled = true` tetapi **belum memiliki satu pun use case aktif** (`useCases: []`), MediaMTX tetap merekam & melayani live WebRTC, sementara AI Engine tidak membuka stream decode untuk kamera tersebut (0% beban GPU/CPU).

#### C. Struktur Redis Keys & Channels

| Key / Channel | Bentuk Baru | Keterangan |
|---|---|---|
| pub/sub `cfg:changed` | `{ "cameraId": "cam1", "useCase": "vehicle_gate", "version": 3 }` | Memberi tahu supervisor untuk resync (field `useCase` opsional jika perubahan di level kamera). |
| hash `cam:{id}:status` | `state`, `fps`, `lastFrameAt`, `engineGroup`, `bootId`, `restarts`, `updatedAt`, **`useCases`** (JSON string) | Field `useCases` berisi map: `{ "vehicle_gate": { "state": "running", "fps": 4.9, "appliedVersion": 3, "configError": null, "live": { "inCount": 142, "outCount": 130 } }, ... }`. |
| key `cam:{id}:frame` | Raw JPEG terbaru (tidak berubah) | Dipakai bersama oleh semua use case pada kamera tersebut untuk editor zona & thumbnail. |
| key `cam:{id}:debug:{useCase}` | Short TTL key | Selama key ini hidup, `DebugPublisher` meng-encode `slot.pipeline.latest_frame()` ke channel `cam:{id}:debugframes:{useCase}`. |

---

### 3.4 Refactor Engine: Single-Stream Fan-Out (`services/engine`)

Perubahan utama terjadi di [worker.py](file:///c:/Users/bd9/Documents/Work/zoo-vision/services/engine/core/worker.py), [status.py](file:///c:/Users/bd9/Documents/Work/zoo-vision/services/engine/core/status.py), dan [debug_frames.py](file:///c:/Users/bd9/Documents/Work/zoo-vision/services/engine/core/debug_frames.py):

```text
RTSP (MediaMTX) ──► 1 StreamManager (decode 1x per camera)
                          │
                          ▼  CameraWorker._loop()
          ┌───────────────┼───────────────┬───────────────┐
          ▼ (every 100ms) ▼ (every 200ms) ▼ (every 500ms) ▼ (every 1000ms)
   Slot: vehicle_gate   Slot: ppe_safety  Slot: queue     Slot: table
   (10 FPS)             (5 FPS)           (2 FPS)         (1 FPS)
          │               │                 │               │
          └───────────────┴────────┬────────┴───────────────┘
                                   ▼
                         Shared ModelPool (GPU batching)
                                   │
                                   ▼
                        Redis Stream `events` + `cam:{id}:status`
```

Aturan eksekusi di dalam `CameraWorker`:
1. **1 Stream per Kamera:** `StreamManager` dibuka pada `stream_fps = max(uc.target_fps for uc in config.use_cases)`. Kamera dengan 4 use case **hanya men-decode 1 stream RTSP**, tidak 4x.
2. **`_PipelineSlot` independen per use case:**
   - `self.slots: dict[str, _PipelineSlot]` (key = `use_case`).
   - Masing-masing slot mengelola `pipeline`, `detector` (dari shared `ModelPool`), `applied_version`, `config_error`, `rejected_versions`, `state`, `fps`, dan `next_run_at`.
3. **Per-UseCase Frame Throttling:**
   - Saat frame baru tiba dari stream, loop mengecek tiap slot: jika `now >= slot.next_run_at`, jalankan `slot.pipeline.run(frame, timestamp_ms)` dan perbarui `slot.next_run_at = now + (1.0 / slot.target_fps)`.
   - **Penting untuk immutability:** `frame` yang masuk ke `process_frame()` bersifat **read-only** (`frame.setflags(write=False)` atau tiap pipeline selalu `.copy()` sebelum menggambar anotasi, seperti yang sudah dilakukan di [vehicle_gate/pipeline.py](file:///c:/Users/bd9/Documents/Work/zoo-vision/services/engine/usecases/vehicle_gate/pipeline.py#L229)) sehingga anotasi 1 pipeline tidak pernah mencemari frame input pipeline lain.
4. **Isolasi Error & Hot-Swap per Slot:**
   - Exception di 1 slot di-catch per slot (hanya slot tersebut yang ditandai error/skip frame; slot lain di kamera yang sama tetap jalan normal).
   - Menambah/mengubah/menonaktifkan 1 use case hanya membuat/reconfigure/shutdown slot tersebut di antara 2 frame — **stream tidak reconnect dan state/counter use case lain di kamera itu tidak ter-reset**.
   - Model hot-swap tetap asinkron di helper thread per slot.
5. **Draw-on-Demand (Optimasi CPU untuk 4 Use Case):**
   - Pipeline hanya perlu menggambar anotasi OpenCV penuh jika: (a) ada viewer debug pada `cam:{id}:debug:{useCase}`, atau (b) terjadi event yang memerlukan snapshot (atau `--preview` aktif). Ini menjaga CPU tetap ringan saat 12 kamera × 4 use case berjalan bersamaan.

---

### 3.5 Arsitektur Frontend Camera-Centric & 3-Slot UI Registry (`zoo-vision-fe`)

#### A. Perubahan Navigasi & Halaman
- **Area Operasional → Halaman Daftar Kamera (`/cameras` atau `/operational`):**
  - Menampilkan daftar kamera (filter per `area`, status online/offline, atau filter use case).
  - Setiap **Camera Card** menampilkan:
    - Thumbnail terbaru (`cam:{id}:frame`), nama kamera, area, badge status (Online / Reconnecting / Offline).
    - **List ringkasan use case aktif** (maks `N` baris), misal:
      - `cam1` → `Vehicle Gate: Masuk 142 · Keluar 130` | `Cashier Presence: Aktif`
      - `cam2` → `Restaurant Counter: 24 org` | `Restaurant Table: 8/12 meja`
- **Halaman Camera Detail (`/cameras/:id`):**
  1. **Bagian Atas:** Live Video WebRTC **bersih tanpa bounding box** + metadata kamera + tombol Debug View (khusus `SUPERADMIN`, dengan dropdown pilih use case).
  2. **Header Use Cases:** Daftar pill/tab use case yang terpasang pada kamera + kuota (misal `2 / 4 Aktif`) + tombol **`+ Add Use Case`** (`SUPERADMIN`).
     - Klik `+ Add Use Case` membuka **Use Case Library Modal** (ala Nx Extension Library) yang menampilkan katalog dari `GET /api/v1/usecases`, deskripsi, dan sisa kuota lisensi.
  3. **Konten Tab Use Case:**
     - Toggle **`Enabled` ON/OFF** (tidak menghapus setting), status applied version (`Saved → Applied ✓`), tombol **Edit Zones / Settings** (membuka editor ROI/tripwire & form dinamis dari `settingsSchema`), dan tombol **Delete/Detach** (`SUPERADMIN`).
     - **Panel Analitik Use Case** (dirender melalui 3-Slot UI Registry di bawah).
- **Menu Analytics / Reports (Lintas Kamera):**
  - Sub-menu di sidebar dibentuk secara **dinamis** dari `GET /api/v1/usecases` (hanya menampilkan use case yang `licensed === true`).

#### B. 3-Slot UI Registry (Generic Day-1 + Custom Client Override)

```text
zoo-vision-fe/src/usecases/
├── _generic/
│   ├── GenericCardSummary.tsx   ← render dari `usecase.summary` + `status.useCases[uc].live`
│   ├── GenericCameraPanel.tsx   ← render KPI + tabel Event + timeline Interval + chart Metric
│   └── GenericReportPage.tsx    ← render agregasi multi-kamera dari /api/v1/reports/*
├── vehicle_gate/                ← contoh custom override
│   ├── index.ts                 ← export { CardSummary, CameraPanel, ReportPage }
│   ├── CardSummary.tsx
│   ├── CameraPanel.tsx          ← misal: log plat nomor + crop image
│   └── ReportPage.tsx           ← misal: rekap semua gate + pencarian plat
├── restaurant_table/
│   ├── index.ts                 ← export { CameraPanel, ReportPage } (CardSummary fallback ke Generic)
│   ├── CameraPanel.tsx          ← misal: grid/denah status meja + timer okupansi
│   └── ReportPage.tsx
└── registry.ts                  ← getUseCaseUi(useCaseId) → merge custom slot dgn _generic fallback
```

Aturan main untuk tim FE (3 Kategori Custom UI):
1. **Use case produk (reusable antar client):** masuk `zoo-vision-fe/src/usecases/<id>/` (mengisi 1–3 slot di atas), di-gate oleh `license.useCases` dan di-load secara **lazy (`next/dynamic`)** di `registry.ts` agar tidak membebani bundle browser client yang tidak membelinya. Use case baru yang belum punya folder tetap langsung jalan memakai `_generic`.
2. **Custom UI ringan eksklusif 1 client:** masuk `zoo-vision-fe/src/extensions/<feature_id>/`, di-gate oleh `license.features` (misal `"features": ["tsi_custom_summary"]`).
3. **Request UI besar / terhubung ke ERP/POS internal client:** **jangan dimasukkan ke `zoo-vision-fe`**; konsumsi melalui **OpenAPI + Webhook (MoM #4)** dari sistem terpisah (atau tampilkan via *External/Embedded Page* di menu jika client ingin akses dari satu tempat).

---

## 4. Prioritas 2A — Sistem Hybrid License (MoM #3 & Pondasi MoM #8)

### 4.1 Model Bisnis & Struktur Payload Lisensi
Lisensi menggunakan skema **Hybrid Offline Signed License** berbasis tanda tangan digital **Ed25519** (format file `.lic` = JSON payload + signature base64). Tidak memerlukan koneksi internet ke server lisensi.

```json
{
  "payload": {
    "schemaVersion": 1,
    "licenseId": "lic_2026_tsi_001",
    "customer": "Taman Safari Indonesia",
    "machineId": "e3b0c44298fc1c149afbf4c8996fb924...",
    "issuedAt": "2026-11-25T00:00:00Z",
    "expiresAt": "2027-11-25T23:59:59Z",
    "graceDays": 14,
    "maxCameras": 16,
    "maxUseCasesPerCamera": 4,
    "useCases": {
      "vehicle_gate": 4,
      "cashier_presence": 4,
      "restaurant_counter": 2,
      "restaurant_table": 2
    },
    "features": ["webhooks", "pdf_export"]
  },
  "signature": "<base64-ed25519-signature-of-canonical-payload>"
}
```

### 4.2 Hardware Fingerprint (`machineId`)
- Dihasilkan oleh `apps/api` dari gabungan identifier host yang di-mount read-only ke container `api`:
  - `/etc/machine-id` (Linux systemd machine ID) + `/sys/class/dmi/id/product_uuid` (jika tersedia), di-hash SHA-256.
  - Fallback untuk dev/non-Linux: machine identifier tersimpan di volume data.
- Ditampilkan di menu **Settings → License** lengkap dengan tombol *Copy* untuk proses aktivasi offline.

### 4.3 Aturan Enforcement & Grace Period (`apps/api/src/license/`)
1. **Penyimpanan:** File lisensi disimpan di `${DATA_DIR}/license.lic` (atau di-upload oleh `SUPERADMIN` via `PUT /api/v1/license`, langsung diverifikasi sebelum disimpan).
2. **Validasi Saat Mutasi:**
   - `POST /api/v1/cameras` & enable kamera → total kamera `enabled` `<= license.maxCameras`.
   - `POST /api/v1/cameras/:id/usecases` & enable use case →
     - `useCase` harus ada di `license.useCases` dengan kuota `> 0`,
     - total `CameraUseCase` aktif untuk `useCase` tersebut di seluruh kamera `<= license.useCases[useCase]`,
     - total `CameraUseCase` aktif pada kamera tersebut `<= min(license.maxUseCasesPerCamera, siteSettings.maxUseCasesPerCamera)`.
3. **Katalog Use Case (`GET /api/v1/usecases`):**
   - Hanya menandai `licensed: true` untuk use case yang memiliki kuota `> 0` pada lisensi aktif.
   - Use case tidak berlisensi disembunyikan dari operasional & menu Reports (atau tampil terpisah di halaman License/Add-ons jika diinginkan bisnis).
4. **Status & Grace Period:**
   - **Valid (`ACTIVE`):** berjalan penuh.
   - **Mendekati expired (≤ 30 hari):** banner peringatan di UI untuk `MANAGER` & `SUPERADMIN`, plus system event `license_expiring`.
   - **Grace Period (`GRACE`, sampai `expiresAt + graceDays`):** sistem tetap berjalan normal sambil menampilkan warning prominen agar operasional client tidak tiba-tiba mati mendadak.
   - **Expired / Invalid / Missing (`EXPIRED` / `UNLICENSED`):**
     - **Data tetap aman (Read-Only):** user tetap bisa login, melihat riwayat Event/Report, dan mengekspor CSV/PDF.
     - Engine berhenti menerima/memproses analitik baru (snapshot `/internal/engine/cameras` mengembalikan `[]`) dan API menolak aktivasi kamera/use case baru sampai lisensi valid di-upload.

### 4.4 Keypair Development vs Production & License Issuer CLI
- **Keypair terpisah:**
  - **Production:** hanya **Public Key Production** yang ditanam di dalam Docker image `api` saat CI build. **Tidak ada** flag `.env` untuk menonaktifkan lisensi pada build production.
  - **Development / CI:** memakai **Dev Public Key** + file `dev.lic` (`machineId: "*"`, semua use case kuota besar) khusus build non-production, sehingga developer tetap bekerja tanpa hambatan lisensi.
- **License Issuer CLI:**
  - Disimpan pada repo private internal terpisah (misal `magnivision-license-issuer`) bersama arsip JSON log lisensi yang pernah diterbitkan ke tiap client.
  - **Private Key Production** disimpan aman di luar git (password manager / Vault internal).

---

## 5. Prioritas 2B — Public OpenAPI & Webhook Integrations (MoM #4)

### 5.1 Public Integration OpenAPI
- **Pemisahan Dokumentasi:**
  - Tandai seluruh endpoint yang stabil dan ditujukan untuk integrasi pihak ketiga dengan `@ApiTags('Integration')` (meliputi: `GET /api/v1/cameras`, `GET /api/v1/cameras/status`, `GET /api/v1/usecases`, `GET /api/v1/events`, `GET /api/v1/intervals`, `GET /api/v1/reports/*`, dan CRUD `webhooks`).
  - Sediakan dokumen Swagger/OpenAPI terpisah (misal `/api/integration-docs` dan `/api/integration-docs-json`) yang hanya memuat endpoint `Integration` (aman dibuka untuk role `MANAGER` / integrator, sementara `/api/docs` penuh tetap khusus `SUPERADMIN`).
- **API Token (`ApiToken`):**
  - Tetap memakai Bearer `zv_...` yang sudah ada.
  - Role `USER` pada `ApiToken` otomatis bertindak sebagai **read-only integration token** (hanya bisa baca kamera, live status, events, intervals, reports).

### 5.2 Webhook Module (`apps/api/src/webhooks/`)

#### Skema Database
```prisma
model WebhookEndpoint {
  id          String            @id @default(uuid()) @db.Uuid
  name        String
  url         String
  /// Disimpan terenkripsi (AES-GCM, sama seperti UrlCipher) untuk signing HMAC-SHA256.
  secretEnc   String
  enabled     Boolean           @default(true)
  /// Filter kosong = semua; terisi = hanya yang cocok.
  cameraIds   String[]          @default([])
  useCases    String[]          @default([])
  eventTypes  String[]          @default([])
  minSeverity Severity          @default(info)
  timeoutMs   Int               @default(5000)
  createdAt   DateTime          @default(now()) @db.Timestamptz(3)
  updatedAt   DateTime          @updatedAt @db.Timestamptz(3)
  deliveries  WebhookDelivery[]
}

model WebhookDelivery {
  id           BigInt          @id @default(autoincrement())
  endpointId   String          @db.Uuid
  endpoint     WebhookEndpoint @relation(fields: [endpointId], references: [id], onDelete: Cascade)
  eventId      String
  status       String          // DELIVERED | FAILED
  httpStatus   Int?
  attempts     Int
  latencyMs    Int?
  error        String?
  createdAt    DateTime        @default(now()) @db.Timestamptz(3)

  @@index([endpointId, createdAt])
  @@index([createdAt]) // untuk retention cleanup 7 hari
}
```

#### Alur Pengiriman & Keamanan
1. **Decoupled dari Ingest:** Setelah `IngestService` melakukan commit batch event ke Postgres, event yang cocok dengan filter `WebhookEndpoint` aktif di-enqueue ke **BullMQ queue `webhooks`** (menggunakan Redis yang sudah ada). Kegagalan atau lambatnya server penerima **tidak pernah menghambat ingest event**.
2. **Format Request HTTP POST:**
   - Headers:
     - `Content-Type: application/json`
     - `X-Webhook-Id: <deliveryId>`
     - `X-Event-Id: <eventId>`
     - `X-Webhook-Timestamp: <unix_ms>`
     - `X-Signature-256: sha256=<hmac_sha256(secret, "${timestamp}.${rawBody}")>`
   - Body JSON:
     ```json
     {
       "id": "evt_01J...",
       "time": "2026-11-25T09:15:00.123Z",
       "cameraId": "cam_gate_01",
       "useCase": "vehicle_gate",
       "type": "vehicle_crossing",
       "severity": "info",
       "data": { "direction": "ENTRY", "vehicleType": "car", "plate": "B 1234 ABC" },
       "snapshotUrl": "/media/snapshots/evt_01J..."
     }
     ```
3. **Retry & Observability:**
   - BullMQ retry **5 kali** dengan exponential backoff (`2s`, `10s`, `30s`, `2m`, `10m`), timeout default `5000 ms`.
   - Status pengiriman dicatat di `WebhookDelivery` (retensi 7 hari oleh `RetentionJob`) agar admin dapat melihat kegagalan integrasi di UI.
   - Sediakan endpoint **`POST /api/v1/webhooks/:id/test`** untuk mengirim *dummy test event* langsung dari UI.
   - Validasi URL: tolak skema non-`http`/`https` dan blokir alamat loopback/metadata berbahaya (kecuali diizinkan eksplisit untuk LAN internal client).

---

## 6. Prioritas 3 — Packaging Multi-Client & Escape Hatch Plugin Container (MoM #8)

### 6.1 Distribusi 1 Repo untuk Semua Client (Tanpa Perlu Ubuntu CD Mirror)
- **Single Release Images:** CI (`.github/workflows/`) mem-build & mem-publish 3 image berversi (`vX.Y.Z`) ke **Private GitHub Container Registry (GHCR)**:
  - `ghcr.io/<org>/magnivision-api:vX.Y.Z`
  - `ghcr.io/<org>/magnivision-engine:vX.Y.Z`
  - `ghcr.io/<org>/magnivision-web:vX.Y.Z`
- **Model Pack per Use Case:** `models/manifest.json` menandai setiap file `.onnx` dengan tag `useCases: [...]`. `tools/fetch_models.py --license /data/license.lic` (atau `--usecases ...`) hanya mengunduh bobot model yang dibutuhkan client tersebut dari private object storage / release server.
- **Update di Site Client:**
  - **Site Online (punya internet):** `deploy/update.sh` login dengan read-only GHCR deploy token per client → `docker compose pull && docker compose up -d`.
  - **Site Offline / Air-Gapped:** script `tools/build_offline_bundle.sh vX.Y.Z --usecases ...` mengemas 1 bundle USB berisi: (a) `docker save` images, (b) file `.onnx` sesuai use case client, dan (c) mini `.deb` offline cache (~300–500 MB khusus `docker-ce` & `nvidia-container-toolkit` — jauh lebih praktis daripada Ubuntu CD mirror penuh).
  - **Kapan baru butuh self-hosted mirror/Harbor?** Hanya jika jumlah server client sudah puluhan/ratusan atau ada regulasi client yang mewajibkan pull image dari server domestik.

### 6.2 Escape Hatch: External Plugin Container (Tahap Lanjut)
Jika suatu saat ada use case khusus yang memerlukan dependency AI berat atau berkonflik dengan engine utama (misalnya VLM, Face Recognition, atau OCR/PyTorch versi berbeda):
- Bungkus **khusus use case tersebut** ke dalam Docker container engine terpisah (misal `vision-engine-vlm`).
- Tambahkan filter opsional `ENGINE_USE_CASES=vlm_fire` (atau gunakan `engineGroup` yang sudah ada) pada `/internal/engine/cameras`, sehingga engine utama menjalankan use case YOLO standar dan container khusus menjalankan use case berat tersebut.
- Karena keduanya berbicara ke **MediaMTX**, **`/internal/engine/*`**, dan **Redis Stream `events`** dengan kontrak yang sama, **API, Database, Lisensi, OpenAPI, Webhook, dan `zoo-vision-fe` tidak memerlukan perubahan arsitektur**.

---

## 7. Rencana Eksekusi Bertahap & Verifikasi

### Urutan Pengerjaan

| Tahap | Lingkup | Hasil Terukur (Definition of Done) |
|---|---|---|
| **Phase P0** | Live clean view + Tema general (`zoo-vision` + `zoo-vision-fe`) | Live camera tanpa bbox; Debug view khusus Superadmin; `PUBLISH_BOXES=false`; UI & Swagger netral tanpa tema safari. |
| **Phase P1A** | `packages/contracts` + Prisma migration + `apps/api` multi-usecase | Schema `CameraUseCase` + `summary` metadata + endpoint CRUD/config per use case + `SiteSettings.maxUseCasesPerCamera` + e2e tests lulus. |
| **Phase P1B** | `services/engine` single-stream fan-out + multi-slot status & debug | 1 kamera menjalankan hingga 4 use case simultan dengan 1 stream decode; live add/remove/toggle 1 use case tanpa drop stream atau reset counter use case lain; pytest lulus. |
| **Phase P1C** | `zoo-vision-fe` Camera-Centric UI + 3-Slot Registry | Area Operasional tampil sebagai Camera List + summary per use case; halaman Camera Detail dengan tab per use case + modal `+ Add Use Case`; minimal 1 custom override (`vehicle_gate`) + fallback `_generic` berjalan. |
| **Phase P2A** | Hybrid License module + CLI Issuer | Verifikasi Ed25519 offline, `machineId` di UI, enforcement `maxCameras` / `maxUseCasesPerCamera` / kuota per `useCase`, grace period, dan dev keypair terpisah. |
| **Phase P2B** | Public OpenAPI + Webhook module | `/api/integration-docs`, CRUD webhook + test event + BullMQ delivery dengan HMAC-SHA256 & retry + delivery log. |
| **Phase P3** | GHCR release pipeline + model pack + offline bundle script | Update 1 repo untuk 2 profil client berbeda (beda lisensi, beda use case aktif) sukses tanpa rebuild per client. |

### Checklist Verifikasi Kunci (End-to-End)
1. **Multi-UseCase Fan-Out:** 1 kamera menjalankan `vehicle_gate` (10 FPS) + `cashier_presence` (2 FPS) secara bersamaan; verifikasi hanya ada 1 koneksi RTSP ke MediaMTX dan kedua use case menghasilkan `Event`/`Metric` terpisah tanpa tabrakan PK di `Metric`.
2. **Isolasi Live Config:** Tambah use case ke-3 pada kamera berjalan → stream tidak putus, counter `vehicle_gate` tidak ter-reset; ubah config use case ke-2 menjadi invalid → hanya slot ke-2 yang melaporkan `configError`, slot lain tetap `running`.
3. **Toggle & Limit:** Nonaktifkan 1 use case → ROI/tripwire tetap tersimpan; mencoba mengaktifkan use case ke-5 saat `maxUseCasesPerCamera = 4` → ditolak API dengan `409 MAX_USE_CASES_REACHED`.
4. **License Gating:** Upload lisensi client A (hanya `vehicle_gate: 2`) → `GET /api/v1/usecases` hanya menampilkan `vehicle_gate` sebagai berlisensi; memasang `vehicle_gate` di kamera ke-3 ditolak dengan `403 LICENSE_QUOTA_EXCEEDED`; saat expired lewat grace period, data historis & export tetap bisa diakses.
5. **Webhook Resilience:** Target endpoint dimatikan → ingest event ke Postgres tetap 100% lancar, BullMQ melakukan retry sesuai backoff, dan `WebhookDelivery` mencatat error; saat target hidup kembali, delivery berhasil dengan `X-Signature-256` valid.
6. **Soak Test Hardware:** Simulasikan beban target (misal 8–12 kamera × 2–4 use case aktif dengan `targetFps` bervariasi) selama 24 jam di GPU target; pantau kestabilan VRAM, FPS per slot, dan tidak ada memory leak.
