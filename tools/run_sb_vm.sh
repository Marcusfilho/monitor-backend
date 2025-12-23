#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# carrega env base
set -a; source ./worker_env.sh 2>/dev/null || true; set +a

# token: arquivo (força usar o arquivo pra não herdar lixo do shell)
export MONITOR_SESSION_TOKEN="$(awk 'NF{print; exit}' .session_token | tr -d '\r\n ')"

GUID="7E65FBE2-993A-489E-A445-13E9E5CBFF02"
export MONITOR_WS_URL="wss://websocket.traffilog.com:8182/${GUID}/${MONITOR_SESSION_TOKEN}/json?defragment=1"

token_hashes="$(printf '%s' "$MONITOR_SESSION_TOKEN" | tr -cd '#' | wc -c)"
url_hashes="$(printf '%s' "$MONITOR_WS_URL" | tr -cd '#' | wc -c)"
SAFE_URL="$(echo "$MONITOR_WS_URL" | sed -E 's#(/[0-9A-Fa-f-]{36}/)[^/]+(/json)#\1<TOKEN>\2#')"

echo "token_len=${#MONITOR_SESSION_TOKEN} token_hashes=${token_hashes} ws_password_set=$([[ -n "${WS_PASSWORD:-}" ]] && echo YES || echo NO)"
echo "url_hashes=${url_hashes}"
echo "ws_url=${SAFE_URL}"

if [[ "$url_hashes" != "0" ]]; then
  echo "ERRO: MONITOR_WS_URL contém '#'."
  exit 1
fi

node tools/sb_run_vm.js "$@"
