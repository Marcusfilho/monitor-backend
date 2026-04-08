#!/bin/bash
# kill_all_jobs.sh — Cancela todos os jobs ativos e instalações presas
# Uso: ./kill_all_jobs.sh [--dry-run]

BASE_URL="https://monitor-backend-dev.onrender.com"
WORKER_KEY=$(grep WORKER_KEY ~/monitor-backend-dev/worker_secrets.env | head -1 | cut -d= -f2 | tr -d '"' | tr -d ' ')
DRY_RUN=false
[[ "$1" == "--dry-run" ]] && DRY_RUN=true

echo "======================================"
echo " KILL ALL JOBS — $BASE_URL"
echo " DRY_RUN=$DRY_RUN"
echo "======================================"

# ── 1) Buscar todos os jobs ──────────────────────────────────────────
JOBS_JSON=$(curl -s "$BASE_URL/api/jobs" -H "x-worker-key: $WORKER_KEY")
if [[ -z "$JOBS_JSON" || "$JOBS_JSON" == "null" ]]; then
  echo "[!] Não foi possível buscar jobs. Verifique WORKER_KEY e URL."
  exit 1
fi

# IDs e status dos jobs que precisam ser cancelados
ACTIVE_IDS=$(echo "$JOBS_JSON" | python3 -c "
import json, sys
jobs = json.load(sys.stdin).get('jobs', [])
kill_statuses = {'queued', 'processing', 'pending'}
for j in jobs:
    if j.get('status') in kill_statuses:
        print(j['id'] + '|' + j['status'] + '|' + j.get('type','?'))
")

if [[ -z "$ACTIVE_IDS" ]]; then
  echo "[✓] Nenhum job ativo encontrado."
else
  echo ""
  echo "── Jobs a cancelar ──────────────────"
  echo "$ACTIVE_IDS" | while IFS='|' read -r jid jstatus jtype; do
    echo "  • $jid  [$jstatus]  $jtype"
    if [[ "$DRY_RUN" == "false" ]]; then
      RES=$(curl -s -X POST "$BASE_URL/api/jobs/${jid}/complete" \
        -H "x-worker-key: $WORKER_KEY" \
        -H "content-type: application/json" \
        -d '{"status":"cancelled","result":{}}')
      STATUS=$(echo "$RES" | python3 -c "import json,sys; print(json.load(sys.stdin).get('job',{}).get('status','?'))" 2>/dev/null)
      echo "    → $STATUS"
    fi
  done
fi

# ── 2) Buscar instalações presas ─────────────────────────────────────
echo ""
echo "── Instalações a cancelar ───────────"

# Pega installation_ids dos jobs cancelados acima + qualquer inst ainda SB_RUNNING
INST_IDS=$(echo "$JOBS_JSON" | python3 -c "
import json, sys
jobs = json.load(sys.stdin).get('jobs', [])
kill_statuses = {'queued', 'processing', 'pending'}
seen = set()
for j in jobs:
    if j.get('status') in kill_statuses:
        iid = j.get('payload', {}).get('installation_id')
        if iid and iid not in seen:
            seen.add(iid)
            print(iid)
")

if [[ -z "$INST_IDS" ]]; then
  echo "[✓] Nenhuma instalação presa encontrada."
else
  echo "$INST_IDS" | while read -r iid; do
    # Buscar status atual da instalação
    INST_JSON=$(curl -s "$BASE_URL/api/installations/${iid}" -H "x-worker-key: $WORKER_KEY")
    INST_STATUS=$(echo "$INST_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)
    echo "  • $iid  [$INST_STATUS]"
    if [[ "$DRY_RUN" == "false" && "$INST_STATUS" != "COMPLETED" && "$INST_STATUS" != "CANCELLED" ]]; then
      RES=$(curl -s -X POST "$BASE_URL/api/installations/${iid}/_worker/patch" \
        -H "x-worker-key: $WORKER_KEY" \
        -H "content-type: application/json" \
        -d '{"status":"CANCELLED"}')
      NEW_STATUS=$(echo "$RES" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)
      echo "    → $NEW_STATUS"
    fi
  done
fi

# ── 3) Reiniciar worker se havia jobs ativos ─────────────────────────
if [[ -n "$ACTIVE_IDS" && "$DRY_RUN" == "false" ]]; then
  echo ""
  echo "── Reiniciando worker ───────────────"
  if sudo systemctl restart monitor-schemebuilder-worker 2>/dev/null; then
    echo "  → worker reiniciado ✓"
  else
    echo "  ⚠ não foi possível reiniciar o worker (sem sudo?)"
    echo "    rode manualmente: sudo systemctl restart monitor-schemebuilder-worker"
  fi
fi

echo ""
echo "======================================"
echo " CONCLUÍDO"
echo "======================================"
