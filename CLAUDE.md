# Anda

A watch-party web app: sign in, join a room, chat, and watch a film in sync. The full plan (build order, WebSocket protocol, "done when" per step) is the Claude Doc "Anda — Watch Party App Plan": https://claude.ai/artifact/HTWvaFVXutdVXcTuJTzwPY. Read it with the docs tools before starting a step.

**Status:** steps 1–6 are done (auth; rooms, chat, presence; synced playback; HLS remuxing; Library + torrents; polish: host handover, "Still watching?" and the Rejoin gate, auto-pause when everyone's away, switching release mid-film). Non-AAC audio is converted to AAC while remuxing (video is always copied). Step 7 (voice and camera) is built too, ahead of the bigger VM the plan wanted: LiveKit (SFU, built-in TURN) in a `livekit` container; the API only mints tokens (`internal/voice`, `POST /api/rooms/{code}/voice`, members only); the browser talks to LiveKit directly (`web/lib/voice.ts`, lazy-loaded `livekit-client`). It needs UDP 7882, TCP 7881 and UDP 3478 open to the VM in the Pantech console (they were blocked as of 2026-09-30). Members also carry a `connection` indicator (good/fair/poor) derived from their buffer reports. Since then: rooms resume their film and position after emptying or a restart (`rooms.media_id`/`media_position`); `reaction_send`/`reaction` float one of six Phosphor-icon reactions over the film; and films are prepared with every audio track (up to 4) as HLS audio renditions plus text subtitles extracted to WebVTT (`media/tracks.go`: master `index.m3u8`, `stream_v`/`stream_aN` playlists, `sub_N.vtt`, `tracks.json`; older films keep the single-playlist layout). Each viewer picks their own subtitles (with a timing nudge) and audio language. Subtitle addons are opt-in via `ANDA_SUBTITLE_ADDONS`. Adaptive quality: heavy films (video over 2 Mbit/s, new layout only) get a background 480p rung (`media/rungs.go`: `stream_l`/`init_l`/`seg_l_*`, keyframes aligned to the original's segments, added to the master playlist once complete; one film at a time at nice 19, ~3x real time on the VM; `ANDA_LOW_RUNG=off` for Pulse benchmark runs). hls.js switches per viewer; the quality menu has Auto / Data saver. The Library shows each release's estimated bitrate and flags ones over 4 Mbit/s. Next is step 8 (multi-VM split and benchmark). `ANDA_IDLE_AFTER` (e.g. `40s`) shortens the 3h idle before "Still watching?" for testing. Films come from two places: files in `/data/media` (rescanned every 5 minutes, probed, remuxed to HLS when the video is H.264), and the Library, where the host searches (Cinemeta), picks a stream, and it downloads through Stremio's server (`torrent` container) while ffmpeg remuxes it into a growing HLS "event" playlist that the room can watch as it arrives. Finished Library films are the cache (`/data/hls/<id>`, capped by `ANDA_CACHE_GB`, least recently watched evicted, never a film a room is showing).

**Stream sources:** the only built-in one is Blender's open films (Sintel, Big Buck Bunny, Cosmos Laundromat; Tears of Steel is WebM and correctly hidden), via WebTorrent's public torrents. Other Stremio stream addons are the user's choice: base URLs, comma-separated, in `ANDA_STREAM_ADDONS` in `~/anda/.env` on the VM. Don't add or suggest piracy addons (e.g. Torrentio) yourself.

**Pulse and Anda run side by side** (since 2026-09-30, after the VM rebuild). What makes it fit: the VM has a 2 GB swap file (`/swapfile`, `vm.swappiness=10`, a safety net for spikes rather than working memory), Anda is down to three containers (the API serves the web app itself, via `internal/site`), and LiveKit is trimmed to 96 MB. Measured with both idle: Pulse ~130 MB, Anda ~105 MB, Caddy ~15 MB, ~420 MB available. The configured limits still add up to more than RAM (Pulse's are sized for its load tests), so heavy Pulse benchmarks plus a torrent download lean on swap; mention that when benchmarking.

**Delivery tuning** (2026-09-30, measured ~150 ms RTT and ~17 Mbit/s from the user's Mac to the VM): the VM runs BBR with `fq` pacing, no slow start after idle, `tcp_notsent_lowat=16384` and 7.5 MB UDP buffers (`/etc/sysctl.d/90-fast-video.conf`, `/etc/modules-load.d/bbr.conf`); Caddy's container gets the TCP ones via `sysctls:` in `proxy/docker-compose.yml`, because containers don't inherit them. Caddy compresses Anda's HLS playlists (zstd, gzip); segments stay as they are. New films are cut into ~2s-minimum segments (`-hls_time 2`, `independent_segments`); the player attaches a downloading film after 6s and preloads hls.js as the room opens. This tuning also changes Pulse's network behaviour, so benchmark before/after comparisons across it aren't like for like.

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

- **Host:** `ubuntu@102.211.122.78`, SSH key `~/Downloads/test-macbook-air.pem`. Apache CloudStack KVM, Ubuntu 24.04 (the VM was rebuilt from scratch on 2026-09-30: Docker was reinstalled from Docker's apt repo, and all data, including `~/anda/.env`, started over).
- **Size:** 1 vCPU, 961 MB RAM, 2 GB swap file, 20 GB disk (~15 GB free).
- **Tooling on the VM:** Docker 29 + Compose v5. No Go, Node or build tools, so build inside Docker images.
- **Moving soon:** the user plans to move everything to a new VM (IP not known yet). Keep the host in one place (`HOST=` in `deploy.sh`) so the move is a one-line change.

### Routing

Caddy (`proxy/`) is the only container that publishes ports (80/443). Projects join the external Docker network **`edge`** and Caddy reaches them by network alias. Hostnames come from sslip.io (`<name>.<ip-with-dashes>.sslip.io` resolves to that IP), and Caddy gets real Let's Encrypt certs for them automatically.

| URL | Goes to |
|---|---|
| https://anda.102-211-122-78.sslip.io | Anda: `/livekit/*` → `anda-livekit:7880` (prefix stripped), everything else → `anda-api:8080` (it serves the web app too) |
| https://pulse.102-211-122-78.sslip.io | Pulse |
| http://102.211.122.78 (bare IP, also `localhost` on the VM) | Pulse. Keep it that way; Pulse's k6/bench scripts depend on it |

New routes (e.g. `/ws` for step 2) go in the `anda.{$SUFFIX}` block of `proxy/Caddyfile`. Then run `proxy/deploy.sh`. It rsyncs, writes `SUFFIX` to `~/proxy/.env` on the VM, and reloads Caddy.

## Conventions (match Pulse and the proxy)

- **Compose:** one `docker-compose.yml` in this repo, deployed to `~/anda` on the VM.
- **Networking:**
  - Never publish host ports.
  - Put the public-facing service(s) on `edge` with an `anda-` alias (e.g. `anda-api`, `anda-web`); keep everything else, like a database, on the default network only.
  - Exception: LiveKit's media ports (see below).
  - Declare `edge` as `external: true`.
- **Memory limits:** set `mem_limit` on every service (see the budget below).
- **Builds happen on the dev machine, not the VM.** Compiling `modernc.org/sqlite` or running `next build` needs more RAM than the VM can spare, and would skew Pulse's numbers. `deploy.sh` cross-compiles Go (`CGO_ENABLED=0 GOOS=linux GOARCH=amd64`) to `server/bin/anda` and builds `web/out/`; the Dockerfiles only copy those in (alpine for the API, nginx:alpine for the web). The Mac has no Docker.
- **Service names must be unique on `edge`.** Compose registers every service's bare name on each network it joins, so a service called `api` on `edge` answered Pulse's lookups for its own `api` (Pulse's nginx got Anda's API and returned 502, until renamed and nginx restarted: nginx resolves upstreams once at startup). Hence Anda's API service is `anda-api` (`docker compose exec anda-api ...`). Pulse uses `db`, `api`, `web`; don't reuse those on `edge`.
- Three containers: `anda-api` (128 MB, includes ffmpeg, and serves the Next.js export from `/srv/web`, staged into `server/bin/web` by `deploy.sh`), `torrent` (`stremio/server`, 256 MB, internal only; the image is 1.7 GB), and `livekit` (alias `anda-livekit`, 96 MB; signalling through Caddy at `/livekit`). Total limits ~480 MB. No Node process of ours in production. `deploy.sh` runs compose with `--remove-orphans`, so a dropped service really goes.
- **The one exception to "never publish host ports":** `livekit` publishes UDP 7882, TCP 7881 and UDP 3478, because WebRTC media can't go through Caddy. Its key and secret (`LIVEKIT_KEY`, `LIVEKIT_SECRET`) and `LIVEKIT_NODE_IP` are generated into `~/anda/.env` by `deploy.sh` on first run. Local dev: build `livekit-server` from source (no macOS release binary), run it with `deploy/livekit.yaml`, and start the API with `ANDA_LIVEKIT_URL=ws://localhost:7880` plus the key and secret.
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
