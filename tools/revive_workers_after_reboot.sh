#!/usr/bin/env bash
set -u

ROOT="${HOME}/monitor-backend"

HTML5_SERVICE="monitor-html5-install-worker.service"
SB_SERVICE="monitor-schemebuilder-worker.service"
CAN_SERVICE="monitor-can-snapshot-worker.service"

TUNNEL_CANDIDATES=(
  "${TUNNEL_SERVICE:-}"
  "monitor-tunnel-ensure.service"
)

log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*"
}

unit_exists() {
  local svc="$1"
  [ -n "$svc" ] || return 1
  systemctl list-unit-files --type=service --no-pager 2>/dev/null | awk '{print $1}' | grep -Fxq "$svc"
}

restart_if_exists() {
  local svc="$1"
  if unit_exists "$svc"; then
    log "restart $svc"
    sudo systemctl restart "$svc" || log "AVISO: falha ao reiniciar $svc"
    return 0
  fi
  return 1
}

start_if_exists() {
  local svc="$1"
  if unit_exists "$svc"; then
    log "start $svc"
    sudo systemctl start "$svc" || log "AVISO: falha ao iniciar $svc"
    return 0
  fi
  return 1
}

ensure_running() {
  local svc="$1"
  if ! unit_exists "$svc"; then
    log "AVISO: serviço não encontrado: $svc"
    return 1
  fi

  if systemctl is-active --quiet "$svc"; then
    log "$svc já está active; reiniciando para garantir estado limpo"
    sudo systemctl restart "$svc" || log "AVISO: falha ao reiniciar $svc"
  else
    log "$svc está inativo; iniciando"
    sudo systemctl start "$svc" || log "AVISO: falha ao iniciar $svc"
  fi
}

check_dns() {
  log "checando DNS de websocket.traffilog.com"
  getent hosts websocket.traffilog.com || log "AVISO: DNS não respondeu"
}

wait_8182() {
  local tries="${1:-24}"
  local sleep_s="${2:-5}"
  local i

  log "aguardando websocket.traffilog.com:8182 ficar acessível"
  for i in $(seq 1 "$tries"); do
    if timeout 5 bash -lc 'echo > /dev/tcp/websocket.traffilog.com/8182' 2>/dev/null; then
      log "OK: 8182 acessível na tentativa $i/$tries"
      return 0
    fi
    log "aguardando tentativa $i/$tries sem 8182; esperando ${sleep_s}s"
    sleep "$sleep_s"
  done

  log "AVISO: 8182 continuou inacessível após ${tries} tentativas"
  return 1
}

show_status() {
  echo
  log "status final dos workers"
  sudo systemctl status \
    "$HTML5_SERVICE" \
    "$SB_SERVICE" \
    "$CAN_SERVICE" \
    --no-pager -l | sed -n '1,220p'
}

show_logs() {
  echo
  log "logs finais"
  sudo journalctl \
    -u "$HTML5_SERVICE" \
    -u "$SB_SERVICE" \
    -u "$CAN_SERVICE" \
    -n 120 --no-pager -o cat
}

main() {
  cd "$ROOT" 2>/dev/null || {
    log "ERRO: repo não encontrada em $ROOT"
    return 1
  }

  log "daemon-reload"
  sudo systemctl daemon-reload

  echo
  log "serviços candidatos de túnel detectados"
  systemctl list-unit-files --type=service --no-pager | \
    grep -Ei 'tunel|tunnel|openvpn|wg-quick|wireguard|autossh|ssh' || true

  echo
  local restarted_tunnel=0
  local svc
  for svc in "${TUNNEL_CANDIDATES[@]}"; do
    [ -n "$svc" ] || continue
    if restart_if_exists "$svc"; then
      restarted_tunnel=1
      break
    fi
  done

  if [ "$restarted_tunnel" = "0" ]; then
    log "AVISO: nenhum serviço de túnel conhecido foi reiniciado"
  fi

  echo
  check_dns
  echo

  if wait_8182 24 5; then
    echo
    ensure_running "$HTML5_SERVICE"
    echo
    ensure_running "$SB_SERVICE"
    echo
    ensure_running "$CAN_SERVICE"
  else
    echo
    log "8182 indisponível; reiniciando apenas o HTML5"
    ensure_running "$HTML5_SERVICE"
    log "SB/CAN não serão forçados sem rota websocket"
  fi

  show_status
  show_logs
}

main "$@"
