# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Diretrizes de Desenvolvimento

### Premissa Principal: Performance
Ao propor qualquer correção, ajuste ou nova implementação, sempre prefira a solução mais rápida em tempo de execução, mesmo que isso implique mais código ou menor legibilidade.

- Priorize algoritmos de menor complexidade (O(n) > O(n²), etc.)
- Prefira operações em memória a I/O desnecessário
- Evite abstrações que adicionem overhead sem ganho real
- Em caso de dúvida entre duas soluções, escolha a de menor latência

### Regra de decisão
Sempre que houver trade-off entre velocidade de execução e qualidade de código, escolha velocidade. Justifique brevemente quando a escolha impactar manutenibilidade.

## Commands

```bash
# Build TypeScript → dist/
npm run build

# Run the server (serves HTTP + inline workers)
node dist/index.js

# Run a specific worker standalone (requires env vars from worker_secrets_rw.env)
npm run worker:can
npm run worker:install
npm run worker:uninstall

# Load env and start
source worker_secrets_rw.env && node dist/index.js

# Watch mode (no built-in script — use tsc manually)
npx tsc --watch
```

There are no automated tests. The test files (`test_can*.js`, `test_opr*.js`, `test_full.js`) are manual integration scripts run directly with Node.

## Architecture

This is a TypeScript/Express HTTP server that orchestrates vehicle tracking device installations, uninstalls, and maintenance jobs via the **Traffilog** fleet management platform.

### Key Concepts

- **Traffilog HTML5** (`html5.traffilog.com`) — used for installation activation, vehicle registration, and session management. Communicates via `application/x-www-form-urlencoded` POST with XML responses.
- **Traffilog AppEngine API** (`api-il.traffilog.com`) — JSON REST API used to obtain session tokens for WebSocket access.
- **Traffilog WebSocket** (`wss://websocket.traffilog.com:8182`) — real-time vehicle data channel used by CAN snapshot, Scheme Builder, and G-Sensor calibration workers.

### Job Queue (`src/jobs/jobStore.ts`)

File-backed in-memory job queue persisted to `/tmp/jobs_store_rw.json` (configurable via `JOBS_STORE_PATH`). Jobs have statuses: `pending → processing → completed | error`. Workers poll `POST /api/jobs/next` and complete via `POST /api/jobs/:id/complete`.

### Worker Pipeline

Jobs chain automatically via `dispatchPipeline()` in `src/routes/jobRoutes.ts` when a job completes successfully:

```
html5_install        → scheme_builder (or monitor_can_snapshot if SKIP_SB)
html5_uninstall      → save_snapshot
html5_maint_no_swap  → monitor_can_snapshot
html5_maint_with_swap→ scheme_builder (or monitor_can_snapshot if SKIP_SB)
scheme_builder       → monitor_can_snapshot
monitor_can_snapshot → waiting_approval (INSTALL/MAINT_WITH_SWAP) or save_snapshot
  [after approve-can]→ gs_calibration → save_snapshot
save_snapshot        → end
```

**SKIP_SB**: `installWorker` detects at baseline-load time whether the assigned scheme and asset type already match the target. If so, it signals `skip_sb: true` and the pipeline skips directly to CAN.

### Workers (all in `src/worker/`)

All workers follow the same pattern: poll loop → `pollNextJob()` → `processJob()` → `completeJob()` or `failJob()`. They communicate back to the API server via HTTP using `API_BASE_URL` + `WORKER_KEY`.

- **installWorker** — HTML5 install flow: resolves `vehicle_id` by plate (Path A) or serial (Path B), runs CMDT serial check/free, loads baseline, calls `SAVE_VHCL_ACTIVATION_NEW`, runs postcheck, optionally executes `CHANGE_COMPANY`.
- **uninstallWorker** — deactivates vehicle, creates stock entry, relinks serial.
- **schemeBuilderWorker** — opens WS session and applies vehicle scheme via `associate_vehicles_actions_opr` + `execute_action_opr`, waits for `UNIT_CONFIG_STATUS` push.
- **canWorker** — opens WS session, calls `collectVehicleMonitorSnapshot()`, streams partial results via `updateJob()`.
- **gsWorker** — sends G-Sensor calibration command `o2w` over WS.
- **saveSnapshotWorker** — writes completed job data to SQLite via `snapshotStore`, then exports to Google Drive.

All workers are also loaded inline by `src/index.ts` via dynamic `import()` so the entire system runs as a single process.

### Core Services (`src/core/`)

- **`traffilogAuth.ts`** — HTTP login to AppEngine API, returns `session_token` for WS URL construction.
- **`html5Session.ts`** — Manages cookie jar (`TFL_SESSION`, `ASP.NET_SessionId`) for HTML5 operations. Persists to disk at `HTML5_COOKIEJAR_PATH`.
- **`mwsService.ts`** — Wraps `GET_VHCL_ACTIVATION_DATA_NEW` (baseline load) and `SAVE_VHCL_ACTIVATION_NEW` (save) via HTML5 action URL.
- **`vhclsService.ts`** — Resolves `vehicle_id` via `VHCLS` HTML5 action. Dumps raw XML to `/tmp/vhcls_raw_<jobId>_*.xml` for client mismatch detection.
- **`vehicleMonitorSnapshotService.ts`** — WS message orchestration for CAN data collection (params + moduleState).
- **`changeCompanyService.ts`** — Moves a vehicle between clients via HTML5 `ASSET_BASIC_SAVE`.

### Auth & Session

`POST /api/auth/html5-login` validates technician credentials against Traffilog HTML5, fetches their allowed clients, and issues a UUID session token stored in SQLite (`data/monitor.db`). Protected routes use `requireSession` middleware which checks `X-Session-Token` header or `?token=` query param. Sessions expire after 8 hours.

### SSE Events (`src/routes/eventsRoutes.ts`)

`GET /events/:jobId` streams CAN snapshot progress via Server-Sent Events. Polls `jobStore` every 3s, sends only on change. Stops when ignition is on + all required CAN params present, or after 5 minutes.

### Config Files (`config/`)

- `asset_types_active.json` — active asset type IDs allowed for installation.
- `asset_types_by_client.json` — per-client asset type mapping, synced hourly via `syncAssetTypesByClient()`.
- `schemes_selection.json` — client → `vehicle_setting_id` mapping used by `getSelectedSchemeId()`.

### Environment Variables

Required variables (see `worker_secrets.env` for names, `worker_secrets_rw.env` for values):

| Variable | Used by |
|---|---|
| `API_BASE_URL` | All workers (self-call back to Express) |
| `WORKER_KEY` | Worker auth header `x-worker-key` |
| `TRAFFILOG_API_BASE_URL` | `traffilogAuth.ts` (AppEngine login) |
| `WS_LOGIN_NAME` / `WS_PASSWORD` | `traffilogAuth.ts` |
| `MONITOR_WS_GUID` | `canWorker` (WS URL) |
| `HTML5_LOGIN_NAME` / `HTML5_PASSWORD` | `html5Session.ts`, `authRoutes.ts` |
| `HTML5_COOKIEJAR_PATH` | Cookie persistence |
| `SQLITE_DB_PATH` | SQLite DB path (default: `data/monitor.db`) |
| `JOBS_STORE_PATH` | Job queue file (default: `/tmp/jobs_store_rw.json`) |
| `DRIVE_EXPORT_ENABLED` / `GOOGLE_SA_KEY_PATH` / `SPREADSHEET_ID` | Google Drive export |

---

## Pendências e melhorias futuras

### 🔴 Próxima sessão
- P1: moduleState — `[vm-ms] OK data=0 av=0` confirmado, Traffilog retorna `data=[]`. Causa raiz não confirmada — suspeita: falta de contexto de sessão ou parâmetro adicional no `get_monitor_module_state`. Próximo passo: testar com veículo conectado e comparar com sessão do Internal Tools.
- P2: canWorker paralelo — adicionar `CAN_WORKER_CONCURRENCY` env var para rodar N loops paralelos
- P3: HTML5_INSTALL com instalação ativa — requer reprodução controlada

### 🟡 Backlog

- **Filtrar asset_types por serial vinculado no sync por cliente**: `syncAssetTypesByClient()` busca todos os `vehicle_id` do cliente e coleta seus `asset_type`, mas inclui veículos placeholder/inativos (sem serial vinculado). Resultado: asset_types que não existem mais aparecem como "existentes". Fix: filtrar para trazer apenas veículos onde o serial está vinculado (campo serial/`DIAL_NUMBER` não vazio ou nulo) antes de agregar os asset_types.

- **Validação de serial antes de avançar tela (install / maint_with_swap)**: bloquear o botão "próxima tela" se o serial não estiver disponível. Regra: serial em uso quando `inner_id != license_nmbr && license_nmbr != "cmdt"`. Verificar onde inserir — provavelmente no modal de entrada do serial (antes de submeter), evitando que o job seja criado e o usuário precise recarregar o navegador. Solução rápida preferida.

- **Upload de fotos para SharePoint**: substituir AppScript Google Drive por upload direto via Graph API. Frontend envia `multipart/form-data` → backend recebe em memória (`multer` memoryStorage, limite 15MB) → `PUT` Graph API para pasta SharePoint. Sem tocar disco da VM. Service Worker no frontend para envio em background. Pico estimado: 5 usuários simultâneos ~40MB RAM.

- **Integração lista SharePoint (BaseInstalados)**: enviar os 18 campos exportados diretamente para lista `BaseInstalados` no site `SmartDrivingLabs`. Auth via OAuth 2.0 Client Credentials (já validada). Colunas mapeadas: `ID_Registro, Data, Placa (Title), Serial, Tecnico, Cliente, Serviço, Fabricante, Modelo, Ano, Cor, Chassi, LocalInstalacao, Comentario, JobID, Etiqueta, Chicote, CAN`. Gravar via `POST /sites/{id}/lists/{id}/items`.

### ✅ Feito recentemente
- canWorker: fix de rota /worker/can/poll
- Auth: migração para traffilogAuth HTTP
- ASSET_TYPE: fix sobrescrita no SAVE_VHCL_ACTIVATION_NEW
- systemd: monitor-backend-rewrite configurado como serviço
- SKIP_SB bug: installWorker retornava antes do SAVE_VHCL_ACTIVATION_NEW — http=200 era falso, instalação não era gravada no HTML5
- vehicleMonitorSnapshotService: get_monitor_module_state envolto em try/catch; unit_key ausente vira aviso em vez de exceção fatal

---

## Encerramento de sessão

Quando eu pedir "fecha sessão", "fecha marco" ou similar, primeiro me perguntar:
1. "Houve mudança de arquitetura ou decisão técnica importante nessa sessão?"
2. "Existem pendências que continuam na próxima sessão?"
3. "Há algo para anotar no backlog?"

Se MARCO (resposta SIM para 1 ou 2):
- Mover itens resolvidos de 🔴 para ✅ Feito
- Atualizar 🔴 Próxima sessão com novas pendências
- Atualizar arquitetura no CLAUDE.md se algo mudou
- Commit do CLAUDE.md: "docs: fecha marco - [resumo]"
- Commit do código modificado

Se SESSÃO SIMPLES (ambas NÃO):
- Apenas commit do código com mensagem descritiva
- Atualizar 🟡 Backlog se houver item novo
- CLAUDE.md só muda se tiver item novo no backlog

---

## Anotações rápidas

Quando eu disser frases como "anota no backlog", "melhoria futura",
"lembra de fazer", "adiciona nas correções futuras", "correção futura" ou similar:
- Adicionar o item na seção 🟡 Backlog imediatamente
- Confirmar com: "Anotado no backlog: [item]"
- Não precisa commitar agora — será commitado no encerramento
