#!/usr/bin/env bash
set -euo pipefail

PROFILE_DIR="${HOME}/.mozilla/firefox/monitor_dbg_profile"
mkdir -p "$PROFILE_DIR"

# user.js força prefs no profile (não mexe no seu Firefox principal)
cat > "${PROFILE_DIR}/user.js" <<'PREFS'
user_pref("remote.active-protocols", 3);
user_pref("remote.enabled", true);
PREFS

echo "[ok] profile criado: ${PROFILE_DIR}"
echo "[ok] prefs: remote.active-protocols=3"
