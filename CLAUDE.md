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
html5_maint_no_swap  → (no-op) — frontend auto-avança via _wantsCan:
  [Sim] frontend→ POST /start-can → monitor_can_snapshot → waiting_approval → approve-can → save_snapshot
  [Não] frontend→ POST /complete-maint → (SB silencioso em background) → tela finalização
html5_maint_with_swap→ scheme_builder (or monitor_can_snapshot if SKIP_SB)
scheme_builder       → monitor_can_snapshot
monitor_can_snapshot → waiting_approval (INSTALL/MAINT_WITH_SWAP/MAINT_NO_SWAP) or save_snapshot (UNINSTALL)
  [after approve-can]→ gs_calibration → save_snapshot  (INSTALL/MAINT_WITH_SWAP)
  [after approve-can]→ save_snapshot                   (MAINT_NO_SWAP — sem GS)
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
- **saveSnapshotWorker** — writes completed job data to SQLite via `snapshotStore`, then exports to SharePoint (or Drive if enabled).

All workers are also loaded inline by `src/index.ts` via dynamic `import()` so the entire system runs as a single process.

### Core Services (`src/core/`)

- **`traffilogAuth.ts`** — HTTP login to AppEngine API, returns `session_token` for WS URL construction.
- **`html5Session.ts`** — Manages cookie jar (`TFL_SESSION`, `ASP.NET_SessionId`) for HTML5 operations. Persists to disk at `HTML5_COOKIEJAR_PATH`.
- **`mwsService.ts`** — Wraps `GET_VHCL_ACTIVATION_DATA_NEW` (baseline load) and `SAVE_VHCL_ACTIVATION_NEW` (save) via HTML5 action URL.
- **`vhclsService.ts`** — Resolves `vehicle_id` via `VHCLS` HTML5 action. Accepts `byInnerId` flag: when true, posts `INNER_ID=<key>` instead of `LICENSE_NMBR=<key>` — required for serial-number lookup (Traffilog ignores serial in LICENSE_NMBR). Dumps raw XML to `/tmp/vhcls_raw_<jobId>_*.xml` for client mismatch detection.
- **`vehicleMonitorSnapshotService.ts`** — WS message orchestration for CAN data collection (params + moduleState).
- **`changeCompanyService.ts`** — Moves a vehicle between clients via HTML5 `ASSET_BASIC_SAVE`.
- **`sharepointPhotoUploader.ts`** — Upload de fotos de instalação para SharePoint via Graph API drive. Descobre driveId de "Arquivos SDL" dinamicamente, numera fotos sequencialmente por tipo (`Cabeamento1`, `Veiculo2`, etc.), cria pastas intermediárias automaticamente. Estrutura: `Operação/Clientes/Fotos Instalações/{cliente}/{[frota -] placa}/`.

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
| `DRIVE_EXPORT_ENABLED` / `GOOGLE_SA_KEY_PATH` / `SPREADSHEET_ID` | Google Drive export (legado) |
| `SP_EXPORT_ENABLED` / `SP_TENANT_ID` / `SP_CLIENT_ID` / `SP_CLIENT_SECRET` / `SP_SITE_HOST` / `SP_SITE_PATH` / `SP_LIST_NAME` | SharePoint export via Graph API |
| `SP_PHOTOS_DRIVE` | Nome do document library para fotos (default: `Arquivos SDL`) |
| `SP_PHOTOS_ROOT` | Caminho raiz das fotos no drive (default: `Operação/Clientes/Fotos Instalações`) |

---

## Pendências e melhorias futuras

### 🔴 Próxima sessão
- P0 🚨: Validação CAN travada — CAN abre sessão WS, conecta (unitConnEvents=12) mas `unitParametersEvents=0` e `moduleState=[]`. Confirmado em produção na instalação 9BSG6X400T4123745 (job ab9187721bf9, 17/06/2026): params=0, can0/can1/j1708 todos null. SB estava OK (silence timeout → pipeline avançou). O canWorker está funcional e em loop ativo (3 tentativas × 120s), mas o Traffilog não envia UNIT_PARAMETERS nenhuma vez. Investigar: (a) comparar sequência de mensagens WS do CAN com sessão funcional do Internal Tools — especialmente se `vehicle_subscribe` retorna `av=0` ou se há `UNIT_PARAMETERS` sendo filtrado/descartado; (b) avaliar se há diferença de comportamento quando o veículo transmite vs. não transmite; (c) testar forçar `get_monitor_module_state` manualmente via WS e ver se retorna dados. **Atenção redobrada** — não alterar sem reprodução controlada e logs WS completos em mãos.
- P1: moduleState — `[vm-ms] OK data=0 av=0` confirmado, Traffilog retorna `data=[]`. Provavelmente mesma raiz do P0.
- P2: canWorker paralelo — adicionar `CAN_WORKER_CONCURRENCY` env var para rodar N loops paralelos
- P3: HTML5_INSTALL com instalação ativa — requer reprodução controlada

### 🟡 Backlog

- **🔴 PRIORIDADE — Jobs "processing orphan" pós-restart**: quando o servidor reinicia, jobs em `processing` ficam presos pois o novo processo de worker só pega `pending`. Solução: no `jobStore` ou em um health-check periódico, resetar para `pending` qualquer job em `processing` há mais de N minutos sem atualização de `updatedAt` (sugestão: 10 min).
- **SB: resiliência a session_token_unavailable**: quando `getTrafflogToken()` falha após 3 tentativas, SB agora reseta job para `pending` (auto-retry) em vez de `error` permanente. Monitorar se causa loop infinito em falhas persistentes — adicionar contador de retries no payload.
- **Verificação do fluxo completo pós-instalação**: acompanhar se CAN está coletando parâmetros e se exportação para SharePoint está correta para todas as instalações recentes (ex: TAW0D75 em waiting_approval, 9BSG6X400T4123745 snapshot enviado). Usuário fará o acompanhamento manualmente.
- **Botão "Reprocessar HTML5" não está funcionando**: endpoint implementado e testado via curl, mas o botão no app não surte efeito — investigar se o problema é no frontend (estado da UI, `installation_id` incorreto) ou se o job não está sendo repegado pelo worker após o reset.
- **Melhorias no painel admin (admin.html) — gestão de jobs**: (1) Corrigir exibição de jobs ativos: atualmente só mostra 1 instalação ativa mesmo com múltiplas em paralelo — investigar filtro/query em `/api/admin/jobs`; (2) Botão Retry (↺) em jobs com status `error` — endpoint `POST /api/jobs/:id/retry` já existe; (3) Botão Encerrar (✕) em qualquer job independente do status, não só os ativos; (4) Remover link do painel admin do menu lateral do `app.html` e reposicionar — sugestão: ícone discreto no rodapé do app (ex: engrenagem ⚙ canto inferior direito) visível apenas para usuários admin.


### ✅ Feito recentemente
- Performance pipeline/app (medição via logs): (1) GS worker — removido backoff exponencial (era `1.6×` até `MAX_IDLE=60s`; pickup chegava a 22s); agora poll fixo 3s → pickup máx 3s; (2) SB silence max wait — reduzido de 300s para 90s (veículo offline: fase SB cai de 5m30s para ~2min); (3) Frontend poll — `pollMs` reduzido de 5000ms para 2000ms, atualizações chegam ao app 2.5× mais rápido
- checkSession ao retornar ao formulário: `initSession` IIFE convertido para função nomeada `checkSession()`; chamada no final de `doReset()` para revalidar sessão HTML5 antes do próximo serviço
- HTML5 phase parallelization: CMDT check + baseline load agora em `Promise.allSettled` paralelo → economiza ~1-2s por instalação
- Fix SB handshake timeout: `processJob` agora tem loop de 2 tentativas; em timeout de handshake WS, invalida token e reabre sessão com token fresco após 5s — resolve `Opening handshake has timed out` que falhava sem retry
- Fix VHCLS sessão stale silenciosa: quando `DATASOURCE` vazio (sem `login=-1`), `vhclsService` detecta `empty_datasource`, invalida TFL_SESSION do cookiejar e força relogin automático antes do retry — resolve instalações travando com `vehicle_id_not_found` após sessão HTML5 expirar silenciosamente
- Fix SB av=1 sem process_id: quando `associate call_num=1` retorna `av=1` (scheme já associado de tentativa anterior) e `get_vcls_action_review_opr` não devolve `process_id`, fecha WS e retorna como ok — avança pipeline para CAN sem falhar com "process_id nao retornado"
- Upload de fotos para SharePoint: `POST /api/photos/upload` (multer memoryStorage 15MB) → `sharepointPhotoUploader.ts` → Graph API drive PUT. Estrutura `Fotos Instalações/{cliente}/{placa}/TipoN.ext`. Modal no app com 7 tipos (Cabeamento, Local, Veículo, Equipamento, Placa, Chassi, Documento), upload imediato ao selecionar, feedback por foto, reset no `doReset()`
- Endpoint genérico `POST /api/jobs/:id/retry` em `jobRoutes.ts` — reseta qualquer job `error` ou `processing` → `pending`; usado para reprocessar SB/CAN/etc. sem intervenção manual
- Fix MAINT_NO_SWAP (fluxo completo refeito): modal "Deseja testar CAN?" exibido antes da criação do job. "Sim" → job criado com `vehicle_id` no payload (worker completa instantaneamente) → poll auto-dispara `start-can` → fase CAN → `waiting_approval` → Validar CAN → `save_snapshot`. "Não" → poll auto-dispara `complete-maint` → tela de finalização imediata. `state._wantsCan` + `state._maintAutoTriggered` controlam a auto-progressão sem cliques intermediários. Pipeline `html5_maint_no_swap` não cria mais `monitor_can_snapshot` automaticamente. `monitor_can_snapshot` para MAINT_NO_SWAP agora vai para `waiting_approval` (igual INSTALL). Novo endpoint `POST /api/installations/:id/start-can`. Fix URL `complete-maint` (era `/:jobId/actions/complete-maint`). Fix guard que rejeitava status `completed` no `complete-maint`. `maintNoSwapWorker` expõe `vehicle_id` no nível raiz do result. `canApprove` removeu exclusão de MAINT_NO_SWAP.
- Fix login `index.html`: `r.json()` substituído por `r.text()` + `JSON.parse()` com fallback — evita crash `Unexpected token '<'` quando backend ou proxy retorna HTML em vez de JSON
- Resiliência a latência Traffilog: `HTTP_TIMEOUT_MS=60000` no `.env`; postcheck (`mwsPostcheck`) timeout por AbortError agora é não-fatal no installWorker — continua com `dial=saveFields.DIAL_NUMBER` em vez de falhar o job
- Botão "Reprocessar HTML5" / "Reenviar cadastro": endpoint `POST /api/installations/:id/retry-html5` implementado em `installationsRoutes.ts` — reseta job HTML5 (`error` ou `processing`) para `pending`, worker reprocessa automaticamente no próximo poll (~4s)
- SharePoint export via Graph API: `src/services/sharepointExporter.ts` — OAuth2 Client Credentials, descoberta dinâmica de siteId/listId, mapeamento de colunas internas SP; `snapshotStore` suporta múltiplos exporters via `_loadExporters()`; `DRIVE_EXPORT_ENABLED=0` + `SP_EXPORT_ENABLED=1`; serviço exportado em PT (Instalação, Desinstalação, etc.)
- CAN no snapshot: `approve-can` percorre cadeia de jobs para achar `monitor_can_snapshot` e passa `result.snapshot` no payload do `save_snapshot`
- Campos extras (Cor/Chassi/LocalInstalacao): fallbacks de nomes de campo no saveSnapshotWorker (`p.cor ?? p.vehicle_color`, etc.)
- GS_CALIBRATION regression fix: restaurado `...(job.result ?? {})` no spread do base em `approve-can` — `vehicle_id` vinha do result do installWorker
- Validação de serial em uso: `vhcls-lookup?by=serial` usa `INNER_ID=` no VHCLS (LICENSE_NMBR= não funciona para seriais); frontend exibe banner vermelho e bloqueia criação de job se serial já vinculado a outra placa
- Seletores Fabricante/Modelo mobile: substituídos por dropdown customizado (`_cselBuild`/`_cselVal` em app.html) com itens do cliente em azul/negrito — CSS em `<option>` nativo não funciona em iOS/Android
- UNINSTALL flow: vehicle_id, serial (inner_id) e client_id/client_descr agora passados no payload via vhcls-lookup; CMDT criado corretamente após desativação
- vhcls-lookup: retorna inner_id, client_id, client_descr; detecta login=-1 e faz relogin automático
- asset_types sync: normalização trim+lowercase resolve mismatch de espaços ("Scania " vs "Scania"); catálogo saltou de 8 para 46 modelos Scania
- syncAssetTypesByClient: filtra veículos sem INNER_ID (placeholders); usa chave normalizada; Francisconi e outros clientes agora recebem asset_types corretos
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
