#!/usr/bin/env bash
set -euo pipefail

CLIENT_ID="${1:?clientId}"
CLIENT_NAME="${2:?clientName}"
VEHICLE_ID="${3:?vehicleId}"
VEHICLE_SETTING_ID="${4:?vehicleSettingId}"
COMMENT="${5:-manual test}"

TOKEN_FILE="${SB_TOKEN_FILE:-/tmp/.session_token}"

# 1) Se não tem token, roda uma vez para gerar
if [ ! -s "$TOKEN_FILE" ]; then
  echo "[wrap] token ausente -> gerando via user_login..."
  WS_DEBUG="${WS_DEBUG:-0}" node tools/sb_run_vm.js "$CLIENT_ID" "$CLIENT_NAME" "$VEHICLE_ID" "$VEHICLE_SETTING_ID" "$COMMENT (login)" || true
fi

# 2) Agora roda “valendo”
echo "[wrap] executando fluxo com token existente..."
WS_DEBUG="${WS_DEBUG:-0}" node tools/sb_run_vm.js "$CLIENT_ID" "$CLIENT_NAME" "$VEHICLE_ID" "$VEHICLE_SETTING_ID" "$COMMENT"
