# Anda

A watch-party web app: sign in, join a room, chat, and watch a film in sync. The full plan (build order, WebSocket protocol, "done when" per step) is the Claude Doc "Anda — Watch Party App Plan": https://claude.ai/artifact/HTWvaFVXutdVXcTuJTzwPY. Read it with the docs tools before starting a step.

**Status:** step 1 (auth) is done and deployed. Next is step 2 (rooms and chat over WebSockets).

**Stack:** Go API in `server/` (`net/http`, SQLite via `modernc.org/sqlite`, goose migrations embedded from `server/migrations`, argon2id), Next.js static export in `web/`. Ask before adding dependencies the plan doesn't list.

**The plan assumes a VM of its own; this one is shared with Pulse.** Its memory table (Stremio server 200–400 MB, ffmpeg, "add swap") doesn't fit here. Steps 1–3 fit; steps 4–5 (ffmpeg remux, Stremio's streaming server) need a decision with the user before they're built.

## Workspace

`pantech-play/` is a plain folder of sibling git repos, not a monorepo:

| Repo | What |
|---|---|
| `anda/` | This project |
| `pulse/` | A social app used to benchmark the VM (Fastify + Postgres + nginx, vanilla-JS SPA). Its README has the details |
| `proxy/` | Caddy, the single front door for every project on the VM |

Don't edit `pulse/` from here. The one file Anda needs to change outside itself is `proxy/Caddyfile`.

## Where it runs

One shared VM, no domain:

- **Host:** `ubuntu@102.211.122.78`, SSH key `~/Downloads/test-macbook-air.pem`. Apache CloudStack KVM, Ubuntu 22.04.
- **Size:** 1 vCPU, 957 MB RAM, **no swap**, 20 GB disk (~16 GB free).
- **Tooling on the VM:** Docker 29 + Compose v5. No Go, Node or build tools, so build inside Docker images.
- **Moving soon:** the user plans to move everything to a new VM (IP not known yet). Keep the host in one place (`HOST=` in `deploy.sh`) so the move is a one-line change.

### Routing

Caddy (`proxy/`) is the only container that publishes ports (80/443). Projects join the external Docker network **`edge`** and Caddy reaches them by network alias. Hostnames come from sslip.io (`<name>.<ip-with-dashes>.sslip.io` resolves to that IP), and Caddy gets real Let's Encrypt certs for them automatically.

| URL | Goes to |
|---|---|
| https://anda.102-211-122-78.sslip.io | Anda: `/api/*` → `anda-api:8080`, everything else → `anda-web:80` |
| https://pulse.102-211-122-78.sslip.io | Pulse |
| http://102.211.122.78 (bare IP, also `localhost` on the VM) | Pulse. Keep it that way; Pulse's k6/bench scripts depend on it |

New routes (e.g. `/ws` for step 2) go in the `anda.{$SUFFIX}` block of `proxy/Caddyfile`. Then run `proxy/deploy.sh`. It rsyncs, writes `SUFFIX` to `~/proxy/.env` on the VM, and reloads Caddy.

## Conventions (match Pulse and the proxy)

- **Compose:** one `docker-compose.yml` in this repo, deployed to `~/anda` on the VM.
- **Networking:**
  - Never publish host ports.
  - Put the public-facing service(s) on `edge` with an `anda-` alias (e.g. `anda-api`, `anda-web`); keep everything else, like a database, on the default network only.
  - Declare `edge` as `external: true`.
- **Memory limits:** set `mem_limit` on every service (see the budget below).
- **Builds happen on the dev machine, not the VM.** Compiling `modernc.org/sqlite` or running `next build` needs more RAM than the VM can spare, and would skew Pulse's numbers. `deploy.sh` cross-compiles Go (`CGO_ENABLED=0 GOOS=linux GOARCH=amd64`) to `server/bin/anda` and builds `web/out/`; the Dockerfiles only copy those in (alpine for the API, nginx:alpine for the web). The Mac has no Docker.
- Two containers: `api` (alias `anda-api`, 96 MB) and `web` (alias `anda-web`, 32 MB). No Node process in production.
- **`deploy.sh`**, modelled on `pulse/deploy.sh`:
  - `HOST`/`KEY` env overrides with the defaults above.
  - `rsync -az --delete`, excluding `.git`, `node_modules`, `.next`, `.env` and local `*.db` files (the built artifacts are synced on purpose).
  - Create `edge` if missing: `docker network inspect edge >/dev/null 2>&1 || docker network create edge`.
  - Then `docker compose up -d --build`.
- **Data:** the SQLite file lives in the `anda_data` volume at `/data/anda.db`.
- **Secrets:** none yet (session tokens are random and stored hashed). When one is needed, generate it on the VM into `~/anda/.env` on the first deploy, and never sync or commit it (Pulse does this with `openssl rand`).
- **Deploying:** it touches a shared, live machine. Confirm with the user before running `deploy.sh` or changing the proxy.

## Resource budget

Measured idle usage: Pulse db ~160 MB, Pulse api ~37 MB, Pulse nginx ~7 MB, Caddy ~35 MB. About 345 MB is available.

Pulse's limits (db 420 MB, api 280 MB, nginx 64 MB) plus Caddy (64 MB) already add up to ~830 MB. They're sized for Pulse's load tests, and Pulse grows toward them under load. With no swap, overcommitting means the kernel OOM-kills something.

- **Aim for Anda's total limits around 150 MB.** A Go API fits in 30–60 MB, and a static-file server in under 20 MB.
- **A separate Postgres container is the expensive part** (~100 MB+ even when tuned small). Weigh SQLite, or a small tuned Postgres, and flag the trade-off to the user rather than picking silently.
- **CPU:** there's one vCPU for everything, so keep background work (polling, cron, heavy image builds) light.

## Interplay with Pulse

- Pulse exists to measure this VM. Anything Anda does (CPU, memory, disk I/O, even `docker build` on the VM) shows up in Pulse's benchmark numbers. Mention this when adding anything heavy.
- Don't touch Pulse's containers or volumes (`pulse_pgdata`, `pulse_uploads`) or the proxy's `proxy_caddy_data` (TLS certs).
- Never run `docker system prune --volumes` or anything similar on the VM.
