#!/usr/bin/env bash
# =============================================================================
# promote_to_prod.sh — Promoção segura: monitor-backend-dev → monitor-backend
#
# Estrutura de repos:
#   DEV:  ~/monitor-backend-dev   branch: dev   → Render dev
#   PROD: ~/monitor-backend       branch: main  → Render prod
#
# O que o script faz:
#   1. Garante remote "prod" apontando para Marcusfilho/monitor-backend
#   2. Verifica estado limpo do repo dev
#   3. Mostra diff resumido do que vai para prod
#   4. Smoke test interativo no Render dev
#   5. Merge dev → main local + push para remote prod
#   6. Copia workers para ~/monitor-backend e reinicia services
#   7. Smoke test no Render prod
#
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

# --- configuração -------------------------------------------------------------
DEV_REPO_DIR="${DEV_REPO_DIR:-$HOME/monitor-backend-dev}"
PROD_REPO_DIR="${PROD_REPO_DIR:-$HOME/monitor-backend}"

# Remote "prod" dentro do repo dev aponta para Marcusfilho/monitor-backend
PROD_REMOTE_NAME="prod"
PROD_REMOTE_URL="https://github.com/Marcusfilho/monitor-backend.git"

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
  git -C "$DEV_REPO_DIR" checkout "$DEV_BRANCH" 2>/dev/null || true
  exit 1
}

# --- garantir remote "prod" no repo dev ---------------------------------------
ensure_prod_remote() {
  header "VERIFICANDO REMOTE DE PRODUÇÃO"

  cd "$DEV_REPO_DIR" || abort "Diretório dev não encontrado: $DEV_REPO_DIR"

  if git remote get-url "$PROD_REMOTE_NAME" &>/dev/null; then
    local current_url
    current_url=$(git remote get-url "$PROD_REMOTE_NAME")
    ok "Remote '${PROD_REMOTE_NAME}' já existe: ${DIM}${current_url}${NC}"
  else
    warn "Remote '${PROD_REMOTE_NAME}' não encontrado. Criando..."
    git remote add "$PROD_REMOTE_NAME" "$PROD_REMOTE_URL"
    ok "Remote '${PROD_REMOTE_NAME}' criado → ${DIM}${PROD_REMOTE_URL}${NC}"
  fi

  echo -ne "  Sincronizando com remote prod... "
  if git fetch "$PROD_REMOTE_NAME" --quiet 2>/dev/null; then
    echo -e "${GREEN}ok${NC}"
  else
    echo -e "${YELLOW}falhou${NC}"
    warn "Não foi possível conectar ao remote prod."
    warn "Verifique a URL e acesso SSH:"
    echo -e "  ${DIM}${PROD_REMOTE_URL}${NC}"
    if ! ask_yn "Continuar mesmo assim?"; then
      abort "Remote prod inacessível."
    fi
  fi
}

# --- pré-checks do repo dev ---------------------------------------------------
check_git_state() {
  header "PRÉ-CHECKS DO REPOSITÓRIO DEV"

  cd "$DEV_REPO_DIR" || abort "Diretório não encontrado: $DEV_REPO_DIR"

  local current_branch
  current_branch=$(git rev-parse --abbrev-ref HEAD)
  if [[ "$current_branch" != "$DEV_BRANCH" ]]; then
    abort "Você está no branch '${current_branch}'. Mude para '${DEV_BRANCH}' antes de promover."
  fi
  ok "Branch atual: ${DEV_BRANCH}"

  if ! git diff --quiet || ! git diff --cached --quiet; then
    fail "Há mudanças não commitadas:"
    git status --short | sed 's/^/    /'
    echo ""
    abort "Commite ou descarte as mudanças antes de continuar."
  fi
  ok "Working tree limpa"

  git fetch origin --quiet
  local behind
  behind=$(git rev-list HEAD..origin/"$DEV_BRANCH" --count 2>/dev/null || echo "0")
  if [[ "$behind" -gt 0 ]]; then
    abort "Branch local está $behind commit(s) atrás de origin/${DEV_BRANCH}. Rode: git pull origin ${DEV_BRANCH}"
  fi
  ok "Sincronizado com origin/${DEV_BRANCH}"

  local ahead
  ahead=$(git rev-list "${PROD_REMOTE_NAME}/${PROD_BRANCH}"..HEAD --count 2>/dev/null || echo "0")
  if [[ "$ahead" -eq 0 ]]; then
    abort "Nenhum commit novo em relação a ${PROD_REMOTE_NAME}/${PROD_BRANCH}. Nada a promover."
  fi
  ok "${ahead} commit(s) novos para promover"
}

# --- resumo do diff -----------------------------------------------------------
show_diff_summary() {
  header "RESUMO DO QUE VAI PARA PRODUÇÃO"

  echo -e "  ${DIM}DEV:${NC}   Marcusfilho/monitor-backend-dev  (${DEV_BRANCH})"
  echo -e "  ${DIM}PROD:${NC}  Marcusfilho/monitor-backend       (${PROD_BRANCH})"
  echo ""

  echo -e "  ${DIM}Commits que entrarão em prod:${NC}"
  echo ""
  git log "${PROD_REMOTE_NAME}/${PROD_BRANCH}"..HEAD --oneline | sed 's/^/    /'
  echo ""

  echo -e "  ${DIM}Arquivos modificados:${NC}"
  echo ""
  git diff --name-status "${PROD_REMOTE_NAME}/${PROD_BRANCH}"..HEAD | sed 's/^/    /'
  echo ""

  if ! ask_yn "O conteúdo acima está correto para ir a produção?"; then
    abort "Promoção cancelada pelo usuário."
  fi
}

# --- smoke test no Render dev -------------------------------------------------
run_smoke_test() {
  header "SMOKE TEST — Render Dev"
  echo -e "  URL: ${DIM}${RENDER_DEV_URL}${NC}"
  echo ""
  echo -e "  Verifique no browser e responda cada item."
  echo ""

  local checks=(
    "Welcome.html abre sem erros no console"
    "Select de técnico está populado (34 nomes)"
    "Selecionar técnico e clicar Entrar: app carrega normalmente"
    "Badge do técnico aparece no header do app"
    "Formulário de instalação abre direto (sem tela dupla)"
    "Payload inclui campo 'technician' com id e nick (?debug=1)"
    "Reabrir a welcome pré-seleciona o último técnico"
  )

  local passed=0 failed=0
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

# --- merge local + push para repo prod ----------------------------------------
do_merge_and_push() {
  header "MERGE E PUSH PARA PRODUÇÃO"

  local timestamp
  timestamp=$(date '+%Y-%m-%d %H:%M')
  local merge_msg="chore: promoção dev → main (${timestamp})"

  step "1/4" "Preparando branch ${PROD_BRANCH} local..."
  if ! git show-ref --verify --quiet refs/heads/"$PROD_BRANCH"; then
    git checkout -b "$PROD_BRANCH" "${PROD_REMOTE_NAME}/${PROD_BRANCH}"
    ok "Branch ${PROD_BRANCH} criado localmente"
  else
    git checkout "$PROD_BRANCH"
    git reset --hard "${PROD_REMOTE_NAME}/${PROD_BRANCH}" --quiet
    ok "Branch ${PROD_BRANCH} sincronizado com ${PROD_REMOTE_NAME}/${PROD_BRANCH}"
  fi

  step "2/4" "Mergeando ${DEV_BRANCH} → ${PROD_BRANCH}..."
  if git merge "$DEV_BRANCH" --no-ff -m "$merge_msg"; then
    ok "Merge concluído: \"${merge_msg}\""
  else
    git checkout "$DEV_BRANCH"
    abort "Conflito durante o merge. Resolva manualmente e tente novamente."
  fi

  step "3/4" "Push para ${PROD_REMOTE_NAME}/${PROD_BRANCH} (Marcusfilho/monitor-backend)..."
  if git push "$PROD_REMOTE_NAME" "${PROD_BRANCH}:${PROD_BRANCH}"; then
    ok "Push realizado → Render prod iniciará redeploy em instantes"
  else
    git checkout "$DEV_BRANCH"
    abort "Falha no push. Verifique suas permissões no repo de prod."
  fi

  step "4/4" "Voltando para ${DEV_BRANCH}..."
  git checkout "$DEV_BRANCH"
  ok "De volta ao ${DEV_BRANCH} — repo dev intacto"
}

# --- copiar workers e reiniciar services --------------------------------------
update_workers() {
  header "WORKERS — VM de produção"

  if [[ ! -d "$PROD_REPO_DIR" ]]; then
    warn "Diretório prod não encontrado: ${PROD_REPO_DIR}"
    warn "Copie os workers manualmente:"
    for f in "${WORKER_FILES[@]}"; do
      echo "    cp ${DEV_REPO_DIR}/${f} ${PROD_REPO_DIR}/${f}"
    done
    return 0
  fi

  echo -e "  Copiando de ${DIM}${DEV_REPO_DIR}${NC} → ${DIM}${PROD_REPO_DIR}${NC}"
  echo ""

  local copied=0
  for f in "${WORKER_FILES[@]}"; do
    local src="${DEV_REPO_DIR}/${f}"
    local dst="${PROD_REPO_DIR}/${f}"
    if [[ -f "$src" ]]; then
      cp "$src" "$dst"
      ok "Copiado: ${f}"
      ((copied++))
    else
      warn "Não encontrado (ignorado): ${f}"
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
        echo -e "${YELLOW}falhou${NC}"
      fi
    done
    echo ""
    echo -e "  ${DIM}Status:${NC}"
    for w in "${WORKERS[@]}"; do
      sudo systemctl is-active --quiet "$w" \
        && echo -e "${OK} ${w} (ativo)" \
        || echo -e "${WARN} ${w} (inativo)"
    done
  else
    warn "Lembre de reiniciar manualmente:"
    for w in "${WORKERS[@]}"; do
      echo "    sudo systemctl restart ${w}"
    done
  fi
}

# --- smoke test no Render prod ------------------------------------------------
smoke_prod() {
  header "SMOKE TEST — Render Prod"
  echo -e "  Aguarde 1-2 min para o Render concluir o redeploy."
  echo -e "  URL: ${DIM}${RENDER_PROD_URL}${NC}"
  echo ""
  echo -ne "  Pressione ${BOLD}Enter${NC} quando o redeploy tiver concluído..."
  read -r

  local checks_prod=(
    "Render prod responde sem erro 502/503"
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
    echo -e "  ${BOLD}Revert do merge (recomendado):${NC}"
    echo -e "  ${DIM}cd ${DEV_REPO_DIR}${NC}"
    echo -e "  ${DIM}git checkout ${PROD_BRANCH}${NC}"
    echo -e "  ${DIM}git revert -m 1 HEAD${NC}"
    echo -e "  ${DIM}git push ${PROD_REMOTE_NAME} ${PROD_BRANCH}${NC}"
    echo -e "  ${DIM}git checkout ${DEV_BRANCH}${NC}"
    echo ""
  else
    ok "Produção validada com sucesso."
  fi
}

# --- sumário final ------------------------------------------------------------
final_summary() {
  header "PROMOÇÃO CONCLUÍDA"

  local sha
  sha=$(git -C "$DEV_REPO_DIR" rev-parse --short "${PROD_REMOTE_NAME}/${PROD_BRANCH}" 2>/dev/null || echo "N/A")

  echo -e "  ${BOLD}Repo prod:${NC}     Marcusfilho/monitor-backend @ ${sha}"
  echo -e "  ${BOLD}Render prod:${NC}   ${RENDER_PROD_URL}"
  echo -e "  ${BOLD}Render dev:${NC}    ${RENDER_DEV_URL}"
  echo ""
  echo -e "  ${DIM}Histórico de promoções:${NC}"
  echo -e "  ${DIM}git -C ${DEV_REPO_DIR} log --merges --oneline ${PROD_REMOTE_NAME}/${PROD_BRANCH}${NC}"
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
echo -e "  ${DIM}DEV:${NC}  Marcusfilho/monitor-backend-dev  (branch: ${DEV_BRANCH})"
echo -e "  ${DIM}PROD:${NC} Marcusfilho/monitor-backend       (branch: ${PROD_BRANCH})"
echo ""
echo -e "  Nenhuma ação destrutiva é feita sem confirmação."
echo ""

if ! ask_yn "Iniciar promoção?"; then
  echo ""
  echo -e "  Cancelado."
  echo ""
  exit 0
fi

ensure_prod_remote
check_git_state
show_diff_summary
run_smoke_test
do_merge_and_push
update_workers
smoke_prod
final_summary
