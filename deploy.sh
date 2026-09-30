#!/usr/bin/env bash
# Build locally, sync to the VM and (re)start Anda. Usage: ./deploy.sh
# Artifacts are built here, not on the VM: compiling Go/Next there would compete with
# Pulse for its ~350 MB of free RAM (no swap) and skew its benchmarks.
set -euo pipefail
cd "$(dirname "$0")"
HOST="${HOST:-ubuntu@102.211.122.78}"
KEY="${KEY:-$HOME/Downloads/test-macbook-air.pem}"
SSH="ssh -i $KEY $HOST"

echo "==> go build (linux/amd64)"
(cd server && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o bin/anda ./cmd/anda)

echo "==> next build"
(cd web && { [ -d node_modules ] || npm ci; } && npm run build)

echo "==> sync"
rsync -az --delete -e "ssh -i $KEY" \
  --exclude .git --exclude node_modules --exclude .next --exclude .env --exclude '*.db*' \
  ./ "$HOST:~/anda/"

$SSH 'cd ~/anda && \
  { docker network inspect edge >/dev/null 2>&1 || docker network create edge; } && \
  docker compose up -d --build && docker compose ps'

echo "Anda: https://anda.$(echo "${HOST#*@}" | tr . -).sslip.io"
