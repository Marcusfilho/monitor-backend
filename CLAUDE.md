# CLAUDE.md

## Diretrizes Comportamentais

> **Tradeoff**: Estas diretrizes priorizam cautela na *abordagem de codificação* — não em performance de runtime (ver "Premissa: Performance" na seção seguinte). Para tarefas triviais, use bom senso.

### 1. Pense Antes de Codificar

Não assuma. Não esconda confusão. Exponha os tradeoffs.

Antes de implementar:

- Declare suas suposições explicitamente. Se houver incerteza, pergunte.
- Se existirem múltiplas interpretações, apresente-as — não escolha silenciosamente.
- Se existir uma abordagem mais simples, diga isso. Questione quando for o caso.
- Se algo não estiver claro, pare. Nomeie o que está confuso. Pergunte.

### 2. Simplicidade Primeiro

O mínimo de código que resolve o problema. Nada especulativo.

- Nenhuma funcionalidade além do que foi pedido.
- Nenhuma abstração para código de uso único.
- Nenhuma "flexibilidade" ou "configurabilidade" que não foi solicitada.
- Nenhum tratamento de erro para cenários impossíveis.
- Se você escrever 200 linhas e poderia ser 50, reescreva.

Pergunte a si mesmo: "Um engenheiro sênior diria que isso está complicado demais?" Se sim, simplifique.

### 3. Mudanças Cirúrgicas

Toque apenas no que for necessário. Limpe apenas a sua própria bagunça.

Ao editar código existente:

- Não "melhore" código, comentários ou formatação adjacentes.
- Não refatore o que não está quebrado.
- Combine com o estilo existente, mesmo que você fizesse diferente.
- Se notar código morto não relacionado, mencione — não exclua.

Quando suas mudanças criam órfãos:

- Remova imports/variáveis/funções que SUAS mudanças tornaram inutilizados.
- Não remova código morto pré-existente, a menos que solicitado.

O teste: Toda linha alterada deve remeter diretamente ao pedido do usuário.

### 4. Execução Orientada a Metas

Defina critérios de sucesso. Repita até verificar.

Transforme tarefas em metas verificáveis antes de começar:

- "Corrigir o bug X" → reproduza o comportamento errado primeiro, depois corrija, depois confirme que sumiu.
- "Adicionar funcionalidade Y" → declare o comportamento esperado, implemente, valide manualmente.
- Para refatorações: confirme que o comportamento externo não mudou (logs, resposta HTTP, payloads WS).

Para tarefas com múltiplas etapas, declare um breve plano:

1. [Etapa] → verificar: [checagem]
2. [Etapa] → verificar: [checagem]
3. [Etapa] → verificar: [checagem]

> **Nota sobre testes**: Este projeto não tem testes automatizados. Substitua "escrever testes" por validação manual com `test_can*.js` / `test_opr*.js` / `test_full.js` ou por logs de diagnóstico diretos no worker.

---

## Diretrizes de Desenvolvimento

### Premissa: Performance acima de tudo
Prefira sempre a solução de menor latência em tempo de execução. Em qualquer trade-off entre velocidade e legibilidade/organização, escolha velocidade. Justifique brevemente quando a escolha impactar manutenibilidade.

## Commands

```bash
npm run build                          # TypeScript → dist/
node dist/index.js                     # servidor + workers inline
source worker_secrets_rw.env && node dist/index.js
npx tsc --watch                        # watch mode
```

Sem testes automatizados. `test_can*.js`, `test_opr*.js`, `test_full.js` são scripts manuais de integração.

## Architecture

TypeScript/Express que orquestra instalações/desinstalações/manutenções de rastreadores via plataforma **Traffilog**.

### Interfaces Traffilog
- **HTML5** (`html5.traffilog.com`) — cadastro de veículos, form-urlencoded POST, respostas XML.
- **AppEngine API** (`api-il.traffilog.com`) — JSON REST, emite `session_token` para WS.
- **WebSocket** (`wss://websocket.traffilog.com:8182`) — canal real-time para SB, CAN e GS.

### Job Queue (`src/jobs/jobStore.ts`)
File-backed em `/tmp/jobs_store_rw.json`. Statuses: `pending → processing → completed | error`. Workers fazem poll em `POST /api/jobs/next`.

### Worker Pipeline

```
html5_install        → scheme_builder (ou monitor_can_snapshot se SKIP_SB)
html5_uninstall      → save_snapshot
html5_maint_no_swap  → (no-op) — frontend auto-avança via _wantsCan:
  [Sim] → POST /start-can → monitor_can_snapshot → waiting_approval → approve-can → save_snapshot
  [Não] → POST /complete-maint → tela finalização
html5_maint_with_swap→ scheme_builder (ou monitor_can_snapshot se SKIP_SB)
scheme_builder       → monitor_can_snapshot
monitor_can_snapshot → waiting_approval (INSTALL/MAINT) ou save_snapshot (UNINSTALL)
  [approve-can] → gs_calibration → save_snapshot  (INSTALL/MAINT_WITH_SWAP)
  [approve-can] → save_snapshot                   (MAINT_NO_SWAP)
save_snapshot        → end
```

**SKIP_SB**: se scheme + asset_type já batem com o alvo no baseline, `installWorker` sinaliza `skip_sb: true` e o pipeline pula direto para CAN.

### Workers (`src/worker/`)
Todos seguem: poll loop → `pollNextJob()` → `processJob()` → `completeJob()` / `failJob()`. Comunicam de volta via HTTP (`API_BASE_URL` + `WORKER_KEY`). Carregados inline por `src/index.ts` via `import()` dinâmico — sistema roda como processo único.

- **installWorker** — resolve `vehicle_id` por placa (Path A) ou serial (Path B), CMDT check/free, baseline, `SAVE_VHCL_ACTIVATION_NEW`, postcheck, opcional `CHANGE_COMPANY`.
- **uninstallWorker** — desativa veículo, cria entrada de estoque, revincula serial.
- **schemeBuilderWorker** — aplica scheme via `associate_vehicles_actions_opr` + `execute_action_opr`, aguarda push `UNIT_CONFIG_STATUS`. Silence watchdog: 30s sem frame → espera até 90s → completa como `completed_no_push`.
- **canWorker** — coleta snapshot CAN via WS, stream parcial via `updateJob()`.
- **gsWorker** — envia comando G-Sensor `o2w` via WS. Poll fixo 3s (sem backoff).
- **saveSnapshotWorker** — grava no SQLite (`snapshotStore`), exporta para SharePoint.

### Core Services (`src/core/`)
- **`traffilogAuth.ts`** — login HTTP no AppEngine, retorna `session_token`.
- **`html5Session.ts`** — cookie jar (`TFL_SESSION`, `ASP.NET_SessionId`), persiste em `HTML5_COOKIEJAR_PATH`.
- **`mwsService.ts`** — `GET_VHCL_ACTIVATION_DATA_NEW` (baseline) e `SAVE_VHCL_ACTIVATION_NEW` (save).
- **`vhclsService.ts`** — resolve `vehicle_id` via VHCLS. `byInnerId=true` posta `INNER_ID=` (serial lookup — `LICENSE_NMBR=` não funciona). Detecta `empty_datasource` e força relogin automático.
- **`vehicleMonitorSnapshotService.ts`** — orquestra mensagens WS para coleta CAN.
- **`sharepointPhotoUploader.ts`** — upload de fotos via Graph API. Estrutura: `Fotos Instalações/{cliente}/{placa}/TipoN.ext`.

### Auth & Session
`POST /api/auth/html5-login` valida credenciais, emite UUID de sessão no SQLite. `requireSession` middleware verifica `X-Session-Token` ou `?token=`. Expiração: 8h.

### SSE (`src/routes/eventsRoutes.ts`)
`GET /events/:jobId` — push de progresso CAN. Poll interno 3s, envia só em mudança. Para quando ignição ON + todos os params CAN presentes, ou após 5min.

### Config (`config/`)
- `asset_types_active.json` — IDs de asset types permitidos.
- `asset_types_by_client.json` — mapeamento por cliente, sync horário.
- `schemes_selection.json` — cliente → `vehicle_setting_id`.

### Environment Variables

| Variable | Used by |
|---|---|
| `API_BASE_URL` | Todos os workers |
| `WORKER_KEY` | Auth header `x-worker-key` |
| `TRAFFILOG_API_BASE_URL` | `traffilogAuth.ts` |
| `WS_LOGIN_NAME` / `WS_PASSWORD` | `traffilogAuth.ts` |
| `MONITOR_WS_GUID` | `canWorker` |
| `HTML5_LOGIN_NAME` / `HTML5_PASSWORD` | `html5Session.ts`, `authRoutes.ts` |
| `HTML5_COOKIEJAR_PATH` | Cookie persistence |
| `SQLITE_DB_PATH` | default: `data/monitor.db` |
| `JOBS_STORE_PATH` | default: `/tmp/jobs_store_rw.json` |
| `SP_EXPORT_ENABLED` / `SP_TENANT_ID` / `SP_CLIENT_ID` / `SP_CLIENT_SECRET` / `SP_SITE_HOST` / `SP_SITE_PATH` / `SP_LIST_NAME` | SharePoint export |
| `SP_PHOTOS_DRIVE` | default: `Arquivos SDL` |
| `SP_PHOTOS_ROOT` | default: `Operação/Clientes/Fotos Instalações` |

---

## Pendências e melhorias futuras

### 🔴 Próxima sessão
- P0 🚨: CAN travado — conecta WS (unitConnEvents=12) mas `unitParametersEvents=0` e `moduleState=[]`. Confirmado na instalação 9BSG6X400T4123745 (job ab9187721bf9, 17/06). Investigar: (a) sequência WS vs. Internal Tools — `vehicle_subscribe` retorna `av=0`? `UNIT_PARAMETERS` filtrado?; (b) diferença entre veículo transmitindo vs. offline; (c) forçar `get_monitor_module_state` manualmente. Não alterar sem logs WS completos em mãos.
- P1: moduleState — mesma raiz provável do P0.
- P2: canWorker paralelo — `CAN_WORKER_CONCURRENCY` env var.
- P3: HTML5_INSTALL com instalação ativa — requer reprodução controlada.

### 🟡 Backlog
- **MAINT_NO_SWAP "não testar CAN" sem snapshot/export**: esse caminho não coleta CAN e o SB é terminal, então não há `save_snapshot` nem export para o SharePoint — só aplica o scheme e fecha como `maint_no_swap_skip`. Avaliar se precisa de registro/export mesmo sem CAN.
- **🔴 Jobs "processing orphan" pós-restart**: resetar para `pending` qualquer job em `processing` há mais de 10min sem atualização de `updatedAt` (no `jobStore` ou health-check periódico).
- **Botão "Reprocessar HTML5" no frontend**: endpoint `POST /api/installations/:id/retry-html5` funciona via curl, mas botão no app não aciona — investigar frontend (`installation_id` incorreto ou estado da UI).
- **Melhorias admin.html**: (1) exibe só 1 instalação ativa mesmo com múltiplas em paralelo; (2) botão Retry (↺) em jobs `error`; (3) botão Encerrar (✕) independente de status; (4) mover link admin para ícone discreto no rodapé (⚙), visível só para admin.

### ✅ Feito recentemente
- SB silencioso no MAINT_NO_SWAP (ambos os caminhos): `complete-maint` ("não testar") e `approve-can` ("validar CAN") enfileiram `scheme_builder` após a finalização, sem GS. SB é terminal (`_terminal`) — aplica o scheme e encerra, sem cascata para novo CAN. Corrige guard do `complete-maint` que exigia `vehicle_setting_id` (frontend nunca envia) → scheme resolvido via `getSelectedSchemeId(client_id)`. `comment` do SB usa o comentário da tela de cadastro; fallback `MAINT_NO_SWAP_SKIP` só quando vazio.
- Fix SB "No Response": status adicionado à lista `SB_DISCONNECTED` — avança para CAN em vez de falhar (equipamento offline durante apply do scheme).
- Fix frontend HTML5_ERROR: `btnCreate` re-habilitado no handler de erro — antes travava o formulário após clicar "Entendi".
- Fix modal `vehicle_id_not_found`: `extractLastError` agora usa `e.reason` quando `detail` é objeto; mensagem específica orienta técnico a verificar cadastro no Traffilog.
- Performance pipeline/app: GS poll fixo 3s (era backoff ×1.6 até 60s, pickup chegava a 22s); SB silence max wait 300s→90s (offline: 5m30s→~2min); frontend pollMs 5000→2000ms.
- checkSession ao retornar ao formulário: sessão HTML5 revalidada em `doReset()`.
- HTML5 parallelization: CMDT check + baseline em `Promise.allSettled` (-1-2s por instalação).
- Fix SB handshake timeout: retry com token fresco após 5s; SB auto-reseta para `pending` em `session_token_unavailable`.
- Fix VHCLS sessão stale: detecta `empty_datasource`, invalida cookie e força relogin.
- Fix SB av=1 sem process_id: avança pipeline sem falhar.
- Upload de fotos para SharePoint via Graph API. Modal no app com 7 tipos.
- Fix MAINT_NO_SWAP: fluxo completo com modal CAN antes da criação do job.

---

## Anotações rápidas

Quando eu disser "anota no backlog", "melhoria futura" ou similar: adicionar em 🟡 Backlog e confirmar. Será commitado no próximo `/marco`.

## Encerramento de sessão

Quando eu disser "fecha marco", "feche o marco", "fecha sessão" ou similar: invocar a skill `/marco` imediatamente, sem fazer perguntas.
