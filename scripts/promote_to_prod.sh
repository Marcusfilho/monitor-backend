#!/usr/bin/env bash
# =============================================================================
# promote_to_prod.sh — Promoção segura: branch dev → main
# Uso: bash scripts/promote_to_prod.sh
# =============================================================================

set -euo pipefail

# --- cores e símbolos ---------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

OK="  ${GREEN}✔${NC}"
FAIL="  ${RED}✖${NC}"
WARN="  ${YELLOW}⚠${NC}"
ASK="${CYAN}?${NC}"

# --- configuração do projeto --------------------------------------------------
REPO_DIR="${REPO_DIR:-$HOME/monitor-backend-dev}"
PROD_REPO_DIR="${PROD_REPO_DIR:-$HOME/monitor-backend}"
DEV_BRANCH="dev"
PROD_BRANCH="main"
RENDER_DEV_URL="https://monitor-backend-dev.onrender.com"
RENDER_PROD_URL="https://monitor-backend-1pm8.onrender.com"
WORKERS=(
  "monitor-html5-install-worker"
  "monitor-vehicle-resolver-worker"
)
WORKER_FILES=(
  "dist/worker/html5InstallWorker_v8.js"
  "dist/worker/vehicleResolverWorker.js"
)

# --- helpers ------------------------------------------------------------------
header() {
  echo ""
  echo -e "${BOLD}${CYAN}══════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}${CYAN}  $1${NC}"
  echo -e "${BOLD}${CYAN}══════════════════════════════════════════════════════${NC}"
  echo ""
}

step() { echo -e "\n${BOLD}[$1]${NC} $2"; }
ok()   { echo -e "${OK} $1"; }
fail() { echo -e "${FAIL} ${RED}$1${NC}"; }
warn() { echo -e "${WARN} ${YELLOW}$1${NC}"; }

ask_yn() {
  local prompt="$1"
  local answer
  while true; do
    echo -ne "  ${ASK} ${prompt} ${DIM}[s/n]${NC} "
    read -r answer
    case "$answer" in
      [sS]|[yY]) return 0 ;;
      [nN])       return 1 ;;
      *)          echo "    Digite s ou n." ;;
    esac
  done
}

abort() {
  echo ""
  echo -e "${FAIL} ${RED}${BOLD}Promoção abortada:${NC} ${RED}$1${NC}"
  echo ""
  exit 1
}

# --- smoke test interativo ----------------------------------------------------
run_smoke_test() {
  header "SMOKE TEST — Render Dev"
  echo -e "  URL: ${DIM}${RENDER_DEV_URL}${NC}"
  echo ""
  echo -e "  Responda cada item após verificar manualmente no browser."
  echo ""

  local checks=(
    "Welcome.html abre sem erros no console"
    "Select de técnico está populado (34 nomes)"
    "Ao selecionar técnico e clicar Entrar, o app carrega"
    "Badge do técnico aparece no header do app"
    "Formulário de instalação abre direto (sem tela dupla)"
    "Payload inclui campo 'technician' com id e nick (cheque com ?debug=1)"
    "Reabrir a welcome pré-seleciona o último técnico"
  )

  local passed=0
  local failed=0

  for check in "${checks[@]}"; do
    if ask_yn "${check}"; then
      ok "${check}"
      ((passed++))
    else
      fail "${check}"
      ((failed++))
    fi
  done

  echo ""
  echo -e "  Resultado: ${GREEN}${passed} ok${NC}  |  ${RED}${failed} falhou${NC}"
  echo ""

  if [[ $failed -gt 0 ]]; then
    abort "${failed} item(s) do smoke test falharam. Corrija no dev antes de promover."
  fi

  ok "Smoke test aprovado."
}

# --- pré-checks do git --------------------------------------------------------
check_git_state() {
  header "PRÉ-CHECKS DO REPOSITÓRIO"

  cd "$REPO_DIR" || abort "Diretório não encontrado: $REPO_DIR"

  # branch atual
  local current_branch
  current_branch=$(git rev-parse --abbrev-ref HEAD)
  if [[ "$current_branch" != "$DEV_BRANCH" ]]; then
    abort "Você está no branch '${current_branch}'. Mude para '${DEV_BRANCH}' antes de promover."
  fi
  ok "Branch atual: ${DEV_BRANCH}"

  # working tree limpa
  if ! git diff --quiet || ! git diff --cached --quiet; then
    fail "Há mudanças não commitadas no working tree:"
    git status --short | sed 's/^/    /'
    echo ""
    abort "Commite ou descarte as mudanças antes de continuar."
  fi
  ok "Working tree limpa (sem mudanças pendentes)"

  # sincronizado com remoto
  git fetch origin --quiet
  local behind
  behind=$(git rev-list HEAD..origin/"$DEV_BRANCH" --count 2>/dev/null || echo "0")
  if [[ "$behind" -gt 0 ]]; then
    abort "Branch local está $behind commit(s) atrás do origin/${DEV_BRANCH}. Rode: git pull origin ${DEV_BRANCH}"
  fi
  ok "Branch local sincronizado com origin/${DEV_BRANCH}"

  # diferença entre dev e main
  local ahead
  ahead=$(git rev-list origin/"$PROD_BRANCH"..HEAD --count 2>/dev/null || echo "0")
  if [[ "$ahead" -eq 0 ]]; then
    abort "Nenhum commit novo em '${DEV_BRANCH}' em relação ao '${PROD_BRANCH}'. Nada a promover."
  fi
  ok "${ahead} commit(s) novos para promover"
}

# --- mostrar diff resumido ----------------------------------------------------
show_diff_summary() {
  header "RESUMO DO QUE VAI PARA PRODUÇÃO"

  echo -e "  ${DIM}Commits que serão incluídos:${NC}"
  echo ""
  git log origin/"$PROD_BRANCH"..HEAD --oneline | sed 's/^/    /'
  echo ""

  echo -e "  ${DIM}Arquivos modificados:${NC}"
  echo ""
  git diff --name-status origin/"$PROD_BRANCH"..HEAD | sed 's/^/    /'
  echo ""

  if ! ask_yn "O conteúdo acima está correto para ir a produção?"; then
    abort "Promoção cancelada pelo usuário."
  fi
}

# --- executar o merge ---------------------------------------------------------
do_merge() {
  header "MERGE dev → main"

  local timestamp
  timestamp=$(date '+%Y-%m-%d %H:%M')
  local merge_msg="chore: promoção dev → main (${timestamp})"

  step "1/3" "Entrando no branch ${PROD_BRANCH}..."
  git checkout "$PROD_BRANCH"
  git pull origin "$PROD_BRANCH" --quiet
  ok "Branch ${PROD_BRANCH} atualizado"

  step "2/3" "Mergeando ${DEV_BRANCH} → ${PROD_BRANCH}..."
  if git merge "$DEV_BRANCH" --no-ff -m "$merge_msg"; then
    ok "Merge concluído: \"${merge_msg}\""
  else
    git checkout "$DEV_BRANCH"
    abort "Conflito durante o merge. Resolva manualmente e tente novamente."
  fi

  step "3/3" "Push para origin/${PROD_BRANCH}..."
  if git push origin "$PROD_BRANCH"; then
    ok "Push realizado — Render prod iniciará redeploy em instantes"
  else
    abort "Falha no push. Verifique permissões e conectividade."
  fi

  # voltar para dev
  git checkout "$DEV_BRANCH"
  ok "De volta ao branch ${DEV_BRANCH}"
}

# --- atualizar workers na VM de prod ------------------------------------------
update_workers() {
  header "WORKERS — VM de produção"

  if [[ ! -d "$PROD_REPO_DIR" ]]; then
    warn "Diretório de prod não encontrado: ${PROD_REPO_DIR}"
    warn "Pule esta etapa e atualize os workers manualmente."
    return 0
  fi

  echo -e "  Copiando workers de ${DIM}${REPO_DIR}${NC} → ${DIM}${PROD_REPO_DIR}${NC}"
  echo ""

  local copied=0
  for f in "${WORKER_FILES[@]}"; do
    local src="${REPO_DIR}/${f}"
    local dst="${PROD_REPO_DIR}/${f}"
    if [[ -f "$src" ]]; then
      cp "$src" "$dst"
      ok "Copiado: ${f}"
      ((copied++))
    else
      warn "Arquivo não encontrado (ignorado): ${f}"
    fi
  done

  if [[ $copied -eq 0 ]]; then
    warn "Nenhum worker copiado. Verifique os caminhos em WORKER_FILES."
    return 0
  fi

  echo ""
  if ask_yn "Reiniciar os workers agora?"; then
    for w in "${WORKERS[@]}"; do
      echo -ne "  Reiniciando ${w}... "
      if sudo systemctl restart "$w" 2>/dev/null; then
        echo -e "${GREEN}ok${NC}"
      else
        echo -e "${YELLOW}falhou (verifique manualmente)${NC}"
      fi
    done
    echo ""
    echo -e "  ${DIM}Status:${NC}"
    for w in "${WORKERS[@]}"; do
      sudo systemctl is-active --quiet "$w" \
        && echo -e "${OK} ${w}" \
        || echo -e "${WARN} ${w} (inativo)"
    done
  else
    warn "Workers não reiniciados. Lembre de rodar:"
    for w in "${WORKERS[@]}"; do
      echo "    sudo systemctl restart ${w}"
    done
  fi
}

# --- smoke test em prod -------------------------------------------------------
smoke_prod() {
  header "SMOKE TEST — Render Prod"
  echo -e "  Aguarde 1-2 min para o Render concluir o redeploy."
  echo -e "  URL: ${DIM}${RENDER_PROD_URL}${NC}"
  echo ""
  echo -ne "  Pressione ${BOLD}Enter${NC} quando o redeploy tiver concluído..."
  read -r

  local checks_prod=(
    "Render prod abre sem erro 502/503"
    "Welcome.html com select de técnico funcionando"
    "Fluxo completo de instalação sem regressão"
  )

  local failed=0
  for check in "${checks_prod[@]}"; do
    if ask_yn "${check}"; then
      ok "${check}"
    else
      fail "${check}"
      ((failed++))
    fi
  done

  echo ""
  if [[ $failed -gt 0 ]]; then
    warn "Prod com problema. Para reverter:"
    echo ""
    echo -e "    ${DIM}git checkout main${NC}"
    echo -e "    ${DIM}git revert -m 1 HEAD${NC}"
    echo -e "    ${DIM}git push origin main${NC}"
    echo ""
  else
    ok "Produção validada com sucesso."
  fi
}

# --- sumário final ------------------------------------------------------------
final_summary() {
  header "PROMOÇÃO CONCLUÍDA"

  local sha
  sha=$(git -C "$REPO_DIR" rev-parse --short origin/"$PROD_BRANCH")

  echo -e "  ${BOLD}Branch main:${NC}   origin/${PROD_BRANCH} @ ${sha}"
  echo -e "  ${BOLD}Render prod:${NC}   ${RENDER_PROD_URL}"
  echo -e "  ${BOLD}Render dev:${NC}    ${RENDER_DEV_URL}"
  echo ""
  echo -e "  ${DIM}Para ver o histórico de promoções:${NC}"
  echo -e "  ${DIM}git log --merges --oneline origin/main${NC}"
  echo ""
}

# =============================================================================
# MAIN
# =============================================================================

clear
echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║       PROMOTE TO PROD — monitor-backend              ║${NC}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Este script promove ${BOLD}${DEV_BRANCH}${NC} → ${BOLD}${PROD_BRANCH}${NC} com segurança."
echo -e "  Nenhuma ação destrutiva é feita sem confirmação."
echo ""

if ! ask_yn "Iniciar promoção?"; then
  echo ""
  echo -e "  Cancelado."
  echo ""
  exit 0
fi

check_git_state
show_diff_summary
run_smoke_test
do_merge
update_workers
smoke_prod
final_summary
