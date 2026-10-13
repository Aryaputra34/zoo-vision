# Deploy

Docker Compose for one park server (Ubuntu LTS + NVIDIA driver + NVIDIA Container Toolkit). Run every
command from this folder.

| Service | What it does |
|---|---|
| `postgres` | Postgres 17. Creates the `zoo_api` role on first start (`postgres/init`). No host port |
| `redis` | Redis 7.4 with a password and AOF persistence. Published on `127.0.0.1:${ZOO_REDIS_PORT:-6379}` for the host-networked engine |
| `api-migrate` | One-shot: `prisma migrate deploy` as `zoo_owner`, then exits |
| `api` | The NestJS API on `127.0.0.1:3001` (Swagger at `/api/docs`) |
| `mediamtx` | Pulls each camera once, records it, re-serves RTSP to the engine, serves event clips on :9996 |
| `zoo-ai-engine` | The Python engine (`services/engine`), image `zoo-vision-engine:${ZOO_VERSION}` |

## First run

```bash
cp .env.example .env                                     # then replace every change-me (see Secrets)
python3 ../tools/fetch_models.py --dest ./data/models    # offline: add --from /media/usb/models
cp ../services/engine/configs/cameras.yaml.example ../services/engine/configs/cameras.yaml
cp ../services/engine/configs/app_config.yaml.example ../services/engine/configs/app_config.yaml
docker compose up -d --build
```

First create the superadmin: `docker compose exec -e ZOO_ADMIN_PASSWORD=<password> api node dist/cli.js create-superadmin --username admin --name "Admin"`.

Use the same folder for `--dest` as `ZOO_DATA_DIR` in `.env`, plus `/models`. Host data lives under
`ZOO_DATA_DIR` (default `./data`, git-ignored): `recordings/`, `snapshots/`, `models/`, `logs/`.

## Secrets

`.env` is git-ignored. Generate each value and never reuse one:

| Variable | Generate with |
|---|---|
| `POSTGRES_PASSWORD`, `ZOO_API_DB_PASSWORD`, `REDIS_PASSWORD` | `openssl rand -hex 24` (they go into connection URLs, so keep them URL-safe) |
| `CAMERA_URL_KEY` | `openssl rand -base64 32` |
| `ZOO_REDIS_PORT` | optional: the host port for Redis when 6379 is taken |

> **Back up `CAMERA_URL_KEY` together with the database.** It encrypts every stored camera stream URL. If it is
> lost, all stored stream URLs become unreadable and every camera's URL must be entered again.

## Without a GPU (laptop)

Never run a bare `docker compose up`: it would also build the GPU engine and start MediaMTX. Name the services:

```bash
docker compose up -d --build postgres redis api-migrate api
```

Run the engine from source against it; see [docs/10_LOCAL_QUICKSTART.md](../docs/10_LOCAL_QUICKSTART.md).
Stop: `docker compose stop api redis postgres`. Start again: `docker compose start postgres redis api`.
`docker compose down -v` also deletes the `pgdata` and `redisdata` volumes.

## Updating to a new backend version

Run from `deploy/` after `git pull`. Events keep queueing in Redis while the API restarts, so nothing is lost.

1. Compare `.env.example` with your `.env` and add any new keys.
2. Back up the database first. Migrations only go forward; going back means restoring this file and the
   previous version:
   ```bash
   docker compose exec -T postgres pg_dump -U zoo_owner -Fc -f /tmp/zoo.dump zoo_vision
   docker compose cp postgres:/tmp/zoo.dump ./zoo-$(date +%Y%m%d).dump
   ```
   In Git Bash on Windows, run `export MSYS_NO_PATHCONV=1` first; otherwise `/tmp/...` is rewritten into a
   Windows path.
3. Rebuild the API, apply new migrations and restart it:
   `docker compose up -d --build api-migrate api`. `api-migrate` must exit 0 (`docker compose ps -a`); if it
   fails, the API does not start, and `docker compose logs api-migrate` says why.
4. If the update changed the `postgres` or `redis` services, also run `docker compose up -d postgres redis`.
   The containers are recreated; the data stays in the `pgdata` and `redisdata` volumes.
5. Engine: on a laptop, `cd services/engine && uv sync`, then restart it. On the GPU server,
   `docker compose up -d --build zoo-ai-engine`.
6. Check: `docker compose ps` (all healthy) and `curl -s http://127.0.0.1:3001/api/health`.

Restore a backup: `docker compose cp ./zoo-YYYYMMDD.dump postgres:/tmp/zoo.dump`, then
`docker compose exec postgres pg_restore -U zoo_owner -d zoo_vision --clean --if-exists /tmp/zoo.dump`.
Phase 5 adds install/update scripts, nightly backups and the offline (USB) update path.

## Database access (Navicat, psql)

Postgres publishes no port by default; the API reaches it inside the compose network. To browse it,
copy `docker-compose.override.yml.example` to `docker-compose.override.yml` (git-ignored) and run
`docker compose up -d postgres`. Postgres is then on `127.0.0.1:5433` (set `ZOO_PG_PORT` in `.env` to change
it), database `zoo_vision`, user `zoo_owner`, password `POSTGRES_PASSWORD` from `.env`.

`zoo_owner` owns the schema and can change anything, including the append-only analytics, audit and login
tables. On a park server, keep the port on 127.0.0.1 and connect through an SSH tunnel.

## Windows development

Run MediaMTX v1.21.1 locally. Download the Windows build from the MediaMTX GitHub releases into the
repo root (`mediamtx.exe` is git-ignored), then from the repo root run:

```powershell
.\mediamtx.exe deploy\mediamtx.yml
```

`mediamtx.yml` still holds the prototype's camera paths and FFmpeg test loops (Windows file paths).
Phase 4 replaces the static paths with cameras added through the web UI (MediaMTX Control API).
