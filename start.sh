#!/usr/bin/env bash
# Coin Bank launcher (Linux/macOS) — auto-restarts if the process exits.
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --omit=dev
while true; do
  echo "[Coin Bank] starting..."
  node --expose-gc --max-old-space-size=384 index.js
  code=$?
  [ "$code" = "0" ] && [ -f .stop ] && exit 0
  echo "[Coin Bank] stopped (code $code). Restarting in 5s... (Ctrl+C to quit)"
  sleep 5
done
