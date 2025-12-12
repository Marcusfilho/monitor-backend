#!/bin/bash

# === Config do backend no Render (quando migrar) ===
export RENDER_BASE_URL="http://localhost:3000"   # por enquanto local; depois trocamos para a URL do Render

# === Identificação do worker ===
export WORKER_ID="vm-tunel-01"
export WORKER_POLL_INTERVAL_MS=2000

# === Config do Monitor / WebSocket ===
export MONITOR_WS_URL="wss://websocket.traffilog.com:8182/7E65FBE2-993A-489E-A445-13E9E5CBFF02/TOKEN/json?defragment=1"

# ATUALMENTE: session_token manualmente copiado (vamos eliminar isso depois)
export MONITOR_SESSION_TOKEN="91812A5258EA45DA85648143AC5B68954600060824"

unset MONITOR_WS_COOKIE

