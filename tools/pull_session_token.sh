#!/usr/bin/env bash
set -euo pipefail

: "${RENDER_BASE:?defina RENDER_BASE (ex.: https://monitor-backend-1pm8.onrender.com)}"
: "${SESSION_TOKEN_ADMIN_KEY:?defina SESSION_TOKEN_ADMIN_KEY}"

OUT="${1:-.session_token}"

URL="${RENDER_BASE%/}/api/admin/session-token?key=${SESSION_TOKEN_ADMIN_KEY}"

tmp="${OUT}.tmp"
curl -fsS "$URL" > "$tmp"

if [ ! -s "$tmp" ]; then
  echo "[pull] ERRO: resposta vazia (token ainda não foi enviado?)" >&2
  rm -f "$tmp"
  exit 2
fi

mv "$tmp" "$OUT"
chmod 600 "$OUT" 2>/dev/null || true

len="$(wc -c < "$OUT" | tr -d ' ')"
echo "[pull] OK -> $OUT (len=$len)"
