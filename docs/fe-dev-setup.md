# Frontend development setup

Run the whole backend on your machine with fake cameras, users and history: no GPU, no camera, no Python.
Then work on the dashboard with `npm run dev` and hot reload.

## What you need

- Docker Desktop (or Docker Engine with the compose plugin)
- Node.js 22
- Git

## Steps

1. Clone both repos **side by side**:

   ```bash
   git clone https://github.com/Aryaputra34/zoo-vision.git
   git clone <the frontend repo> zoo-vision-fe
   ```

2. Copy the demo environment file:

   ```bash
   cd zoo-vision/deploy
   cp .env.demo.example .env
   ```

   Every secret in it is fixed and public. It is for your machine only, never for a real site.

3. Start the backend:

   ```bash
   docker compose up -d --build
   ```

   The first start builds the API image (a few minutes). `COMPOSE_PROFILES=demo` in the file also starts
   `demo-seed` (creates the cameras and users) and `demo-feed` (14 days of history, then live events). About a
   minute after the start the history is loaded.

4. Start the dashboard, in the frontend repo:

   ```bash
   cd ../../zoo-vision-fe
   npm install
   npm run dev
   ```

5. Open **http://localhost:8080**. Never open `:3000`: the login cookie and the WebSocket only work through
   Caddy, which serves the dashboard and the API on this one address.

## Demo logins

| Username | Role | Password |
|---|---|---|
| `demo-superadmin` | SUPERADMIN | `demo-only-password-123` |
| `demo-manager` | MANAGER | the same |
| `demo-user` | USER | the same |

There are five demo cameras, one per use case: `demo_vehicle_gate`, `demo_horse_riding`, `demo_cashier_presence`,
`demo_restaurant_counter` and `demo_restaurant_table`. Their stills are synthetic scenes marked DEMO. Clips are not
available (`RECORDING_NOT_AVAILABLE`): there is no MediaMTX in the demo. Roughly every 10 minutes one camera goes
silent for 2 minutes, so the offline states get exercised.

## Useful addresses

| Address | What |
|---|---|
| http://localhost:8080 | The dashboard and the API |
| http://localhost:8080/api/docs | Swagger UI (`ZOO_SWAGGER=public` in the demo file) |
| http://localhost:8080/api/docs-json | The OpenAPI document |
| `docker compose logs -f demo-feed` | What the demo feed is doing |

## Start over

`docker compose down -v` deletes **everything**: the database, Redis and Caddy's data (the demo snapshot files
stay in `deploy/data/snapshots`). The next `docker compose up -d --build` seeds and backfills again.
`docker compose down` (without `-v`) keeps the data.

## Troubleshooting

- **A port is in use.** Set it in `deploy/.env`: `ZOO_HTTP_PORT` (Caddy, 8080), `ZOO_API_PORT` (the API on the
  loopback, 3001) or `ZOO_REDIS_PORT` (Redis on the loopback, 6379). If you change `ZOO_HTTP_PORT`, open that port.
  Change `ZOO_WEB_UPSTREAM` too when `next dev` is not on port 3000, and start it with the same port.
- **`/` shows 502.** Caddy cannot reach `next dev`. Start `npm run dev` and check the port.
- **Login works but you are sent back to the login page.** You opened `:3000` instead of `:8080`, or
  `ZOO_COOKIE_SECURE` is not `false`.
- **`host.docker.internal` on Linux.** The compose file maps it to the host for Caddy (`extra_hosts`), so it needs
  no change. If `/` still answers 502, check that `next dev` listens on all interfaces
  (`npm run dev -- -H 0.0.0.0`) and that a firewall allows the Docker bridge to reach the port.
- **Nothing shows in the pages.** `docker compose ps` should list `demo-seed` as exited 0 and `demo-feed` as
  running. `docker compose logs demo-seed` says why a seed failed (`ZOO_DEMO=on` and a `DEMO_PASSWORD` of at least
  10 characters are required).
- **Wrong project.** Containers are named `zoo-vision-<service>-1`. Another stack on the same machine needs its
  own `COMPOSE_PROJECT_NAME`.
