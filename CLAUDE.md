# Anda

A watch-party web app: sign in, join a room, chat, and watch a film in sync. The full plan (build order, WebSocket protocol, "done when" per step) is the Claude Doc "Anda — Watch Party App Plan": https://claude.ai/artifact/HTWvaFVXutdVXcTuJTzwPY. Read it with the docs tools before starting a step.

**Status:** steps 1–5 are done (auth; rooms, chat, presence; synced playback; HLS remuxing; Library + torrents). Next is step 6 (polish: host handover, away states, stream switching). Films come from two places: files in `/data/media` (rescanned every 5 minutes, probed, remuxed to HLS when H.264 + AAC), and the Library, where the host searches (Cinemeta), picks a stream, and it downloads through Stremio's server (`torrent` container) while ffmpeg remuxes it into a growing HLS "event" playlist that the room can watch as it arrives. Finished Library films are the cache (`/data/hls/<id>`, capped by `ANDA_CACHE_GB`, least recently watched evicted, never a film a room is showing).

**Stream sources:** the only built-in one is Blender's open films (Sintel, Big Buck Bunny, Cosmos Laundromat; Tears of Steel is WebM and correctly hidden), via WebTorrent's public torrents. Other Stremio stream addons are the user's choice: base URLs, comma-separated, in `ANDA_STREAM_ADDONS` in `~/anda/.env` on the VM. Don't add or suggest piracy addons (e.g. Torrentio) yourself.

**Pulse is stopped** (since 2026-09-30, at the user's request, so Anda has the VM). With the torrent engine, Anda's limits total ~416 MB, so starting Pulse again would overcommit memory: ask first, and consider stopping `torrent` if Pulse must run. `docker compose stop` kept its containers and volumes; `cd ~/pulse && docker compose start` brings it back. Don't restart it unless asked.

**UI:** "Screening room" direction: warm near-black, one ember accent, Geist + Geist Mono, a full-bleed stage with translucent glass chrome over it, and on phones chat is a sheet dragged over the film. Before any UI work load `frontend-dev` (visual rules and quality gates) and `apple-design` (materials, springs, gestures), plus `emil-design-eng` / `mobile-native` for polish and phone mechanics. Stack: Tailwind v4 (tokens in `web/app/globals.css` `@theme`), Motion, Phosphor icons (use the `*Icon` names; the bare ones are deprecated). Components live in `web/components/` (`ui/`, `home/`, `room/`, `profile/`, `projector.tsx`). The profile page is `/me`: rooms you've been in (`room_members`), rejoin, end (owner) or remove from your list.

**Stack:** Go API in `server/` (`net/http`, SQLite via `modernc.org/sqlite`, goose migrations embedded from `server/migrations`, argon2id, `coder/websocket`), Next.js static export in `web/`. Server packages: `auth`, `rooms` (one goroutine per room; `playback.go` is the want-vs-blockers state machine), `gateway` (sockets, resume, replaced, time_ping), `media` (scan, ffprobe + remux worker in `hls.go`, torrent pipeline + eviction in `torrent.go`, ready shelf, progress, serves `/media/{id}/index.m3u8` and segments), `library` (Stremio addon client, built-in open films, stream filtering), `torrent` (client for Stremio's server), `protocol` (message types, names exactly as in the plan), `store`, `httpx`. Client sync lives in `web/lib/player-sync.ts`; `web/lib/hls-source.ts` attaches hls.js (lazy-loaded; native HLS fallback). Rooms are at `/room?code=XXXXXX` (query string because the export is static).

**Local dev:** run the API with `ANDA_WS_ORIGINS=localhost:3000 go run ./cmd/anda` in `server/`, and `npm run dev` in `web/` (it proxies `/api` to :8080; the socket goes straight to `ws://localhost:8080/ws`). Fast Refresh remounts rooms in every open tab, so with two tabs open they can replace each other in dev only. For Library work locally, run Stremio's server with Node: copy `/stremio/server.js` out of the `stremio/server` image and start it with `node server.js` (port 11470), then set `ANDA_TORRENT_URL=http://localhost:11470`. To test two users in one browser, use `localhost:3000` and `127.0.0.1:3000` (separate cookie jars; both are allowed dev origins; start the API with `ANDA_WS_ORIGINS=localhost:3000,127.0.0.1:3000` and `ANDA_MEDIA=<dir with an .mp4>`). Keep both visible (split panes): browsers pause video in hidden tabs. Ask before adding dependencies the plan doesn't list.

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
| https://anda.102-211-122-78.sslip.io | Anda: `/api/*`, `/ws` and `/media/*` → `anda-api:8080`, everything else → `anda-web:80` |
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
- Three containers: `api` (alias `anda-api`, 128 MB, includes ffmpeg), `web` (alias `anda-web`, 32 MB), and `torrent` (`stremio/server`, 256 MB, internal only; the image is 1.7 GB). No Node process of ours in production.
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
