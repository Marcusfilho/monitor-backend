#!/bin/bash
# =============================================================================
# pre_push_check.sh — Valida o pipeline antes de qualquer git push
# Uso: bash ~/monitor-backend-dev/scripts/pre_push_check.sh && git push origin dev
# =============================================================================
set -euo pipefail

cd ~/monitor-backend-dev

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║           PRE-PUSH CHECK — monitor-backend-dev       ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

ERRORS=0

# ── CHECK 1: Build limpo ───────────────────────────────────────────────────
echo "▶ [1/4] Build TypeScript..."
BUILD_OUT=$(npm run build 2>&1)
BUILD_EXIT=$?
if [ $BUILD_EXIT -ne 0 ]; then
  echo "  ❌ Build FALHOU:"
  echo "$BUILD_OUT" | tail -10
  ERRORS=$((ERRORS + 1))
else
  echo "  ✅ Build OK"
fi

# ── CHECK 2: export default router presente ────────────────────────────────
echo ""
echo "▶ [2/4] Export default em installationsRoutes.ts..."
if grep -q "export default router" src/routes/installationsRoutes.ts; then
  echo "  ✅ export default router presente"
else
  echo "  ❌ 'export default router' NÃO encontrado em src/routes/installationsRoutes.ts"
  echo "     Corrija com: echo 'export default router;' >> src/routes/installationsRoutes.ts"
  ERRORS=$((ERRORS + 1))
fi

# ── CHECK 3: Ordem das rotas no dist (vhcls-lookup ANTES de /:id) ──────────
echo ""
echo "▶ [3/4] Ordem das rotas em dist/routes/installationsRoutes.js..."
if [ ! -f dist/routes/installationsRoutes.js ]; then
  echo "  ⚠️  dist/routes/installationsRoutes.js não existe — build pode ter falhado"
  ERRORS=$((ERRORS + 1))
else
  LINE_VHCLS=$(grep -n "vhcls-lookup" dist/routes/installationsRoutes.js 2>/dev/null | head -1 | cut -d: -f1 || echo "")
  LINE_ID=$(grep -n 'router\.get.*"/:id"\|router\.get.*'"'"'/:id'"'" dist/routes/installationsRoutes.js 2>/dev/null | head -1 | cut -d: -f1 || echo "")

  if [ -z "$LINE_VHCLS" ]; then
    echo "  ❌ Rota 'vhcls-lookup' NÃO encontrada no dist — endpoint pode estar faltando"
    ERRORS=$((ERRORS + 1))
  elif [ -z "$LINE_ID" ]; then
    echo "  ⚠️  Rota '/:id' não encontrada no dist — verifique se o arquivo está correto"
    echo "  ℹ️  vhcls-lookup está na linha ${LINE_VHCLS}"
  elif [ "$LINE_VHCLS" -lt "$LINE_ID" ]; then
    echo "  ✅ Ordem OK — vhcls-lookup (L${LINE_VHCLS}) antes de /:id (L${LINE_ID})"
  else
    echo "  ❌ ORDEM ERRADA — /:id (L${LINE_ID}) está ANTES de vhcls-lookup (L${LINE_VHCLS})"
    echo "     Express vai capturar /vhcls-lookup como parâmetro :id → 404 silencioso"
    echo "     Corrija em src/routes/installationsRoutes.ts e rebuilde"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ── CHECK 4: Patch no arquivo correto (public/, não app/) ──────────────────
echo ""
echo "▶ [4/4] Frontend em public/ (não app/)..."
FRONTEND_FILE="public/app_installations_v1.html"
if [ ! -f "$FRONTEND_FILE" ]; then
  echo "  ⚠️  $FRONTEND_FILE não encontrado — verifique o nome do arquivo"
else
  # Verifica se o arquivo em public/ é mais recente que o de app/ (se existir)
  if [ -f "app/app_installations_v1.html" ]; then
    PUB_MT=$(stat -c %Y "$FRONTEND_FILE" 2>/dev/null || echo 0)
    APP_MT=$(stat -c %Y "app/app_installations_v1.html" 2>/dev/null || echo 0)
    if [ "$APP_MT" -gt "$PUB_MT" ]; then
      echo "  ❌ app/app_installations_v1.html é MAIS RECENTE que public/"
      echo "     Você editou o arquivo errado! O Render ignora app/ — só lê public/"
      echo "     Copie: cp app/app_installations_v1.html public/app_installations_v1.html"
      echo "     Depois rebuilde e faça commit do public/"
      ERRORS=$((ERRORS + 1))
    else
      echo "  ✅ public/ está mais recente que app/ — OK"
    fi
  else
    echo "  ✅ Só public/ existe — OK"
  fi

  # Verifica se o dist/public/ foi gerado (postbuild deve ter copiado)
  if [ -f "dist/public/app_installations_v1.html" ]; then
    DIST_MT=$(stat -c %Y "dist/public/app_installations_v1.html" 2>/dev/null || echo 0)
    PUB_MT=$(stat -c %Y "$FRONTEND_FILE" 2>/dev/null || echo 0)
    if [ "$DIST_MT" -lt "$PUB_MT" ]; then
      echo "  ⚠️  dist/public/ parece desatualizado em relação a public/"
      echo "     Rode: npm run build"
    else
      echo "  ✅ dist/public/ atualizado pelo postbuild"
    fi
  fi
fi

# ── RESULTADO FINAL ─────────────────────────────────────────────────────────
echo ""
if [ $ERRORS -eq 0 ]; then
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║  ✅  TUDO OK — pode fazer git push                   ║"
  echo "╚══════════════════════════════════════════════════════╝"
  echo ""
  exit 0
else
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║  ❌  ${ERRORS} ERRO(S) encontrado(s) — push BLOQUEADO        ║"
  echo "║  Corrija acima e rode o script novamente.            ║"
  echo "╚══════════════════════════════════════════════════════╝"
  echo ""
  exit 1
fi
