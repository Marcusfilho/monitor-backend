#!/bin/bash
set -e

source ~/monitor-backend-dev/worker_secrets.env

COOKIEJAR=/tmp/html5_cookiejar.json
TMP=/tmp/ck_renew_$$.txt

echo "[renew_cookie] iniciando..."

# Bootstrap GET
curl -s -c "$TMP" "https://html5.traffilog.com/appv2/index.htm" \
  -H "accept: text/html" -o /dev/null

# Login
RESULT=$(curl -s -b "$TMP" -c "$TMP" \
  -X POST "https://html5.traffilog.com/AppEngine_2_1/default.aspx" \
  -H "content-type: application/x-www-form-urlencoded" \
  -H "origin: https://html5.traffilog.com" \
  -H "referer: https://html5.traffilog.com/appv2/index.htm" \
  --data-urlencode "username=${HTML5_LOGIN_NAME}" \
  --data-urlencode "password=${HTML5_PASSWORD}" \
  --data-urlencode "language=7001" \
  --data-urlencode "BOL_SAVE_COOKIE=1" \
  --data-urlencode "action=APPLICATION_LOGIN" \
  --data-urlencode "VERSION_ID=2")

if echo "$RESULT" | grep -q "node=-2"; then
  python3 - "$TMP" "$COOKIEJAR" <<'EOF'
import json, sys
tmp, out = sys.argv[1], sys.argv[2]
with open(tmp) as f: lines = f.readlines()
parts = []
for line in lines:
    line = line.strip()
    if not line: continue
    if line.startswith("#HttpOnly_"): line = line[len("#HttpOnly_"):]
    elif line.startswith("#"): continue
    cols = line.split("\t")
    if len(cols) >= 7:
        n, v = cols[5].strip(), cols[6].strip()
        if n: parts.append(f"{n}={v}")
cookie = "; ".join(parts)
if "EULA_APPROVED" not in cookie: cookie += "; EULA_APPROVED=1"
if "APPLICATION_ROOT_NODE" not in cookie: cookie += '; APPLICATION_ROOT_NODE=%7B%22node%22%3A%22-2%22%7D'
with open(out, "w") as f: json.dump({"cookie": cookie, "updatedAt": "auto"}, f, indent=2)
print("[renew_cookie] OK - cookie salvo em " + out)
EOF
else
  echo "[renew_cookie] FAIL: login não retornou redirect esperado"
  echo "$RESULT" | head -c 200
  rm -f "$TMP"
  exit 1
fi

rm -f "$TMP"
