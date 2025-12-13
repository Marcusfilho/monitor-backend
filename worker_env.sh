#!/bin/bash

# === Config do backend no Render (quando migrar) ===
RENDER_BASE_URL="http://localhost:3000"

# === Identificação do worker ===
WORKER_ID="vm-tunel-01"
WORKER_POLL_INTERVAL_MS=2000

# === Config do Monitor / WebSocket ===
MONITOR_WS_URL="wss://websocket.traffilog.com:8182/7E65FBE2-993A-489E-A445-13E9E5CBFF02/TOKEN/json?defragment=1"

# ATUALMENTE: session_token manualmente copiado (vamos eliminar isso depois)
MONITOR_SESSION_TOKEN="91812A5258EA45DA85648143AC5B68954600060824"

unset MONITOR_WS_COOKIE

