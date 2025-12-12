#!/usr/bin/env bash
set -euo pipefail

cd /home/questar/monitor-backend
source ./worker_env.sh

NODE_BIN="/usr/local/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi

if [ -z "${NODE_BIN}" ] || [ ! -x "${NODE_BIN}" ]; then
  echo "[worker] ERRO: node não encontrado. PATH=$PATH"
  exit 127
fi

if [ ! -f "dist/worker/schemeBuilderWorker.js" ]; then
  echo "[worker] ERRO: dist/worker/schemeBuilderWorker.js não existe. Rode: npm run build"
  exit 2
fi

echo "[worker] Node: $("$NODE_BIN" -v) ($NODE_BIN)"
echo "[worker] Iniciando worker SchemeBuilder. RENDER_BASE_URL=$RENDER_BASE_URL WORKER_ID=$WORKER_ID POLL_INTERVAL_MS=$WORKER_POLL_INTERVAL_MS"
exec "$NODE_BIN" dist/worker/schemeBuilderWorker.js

