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
- **Confirmar ao vivo a retenção de snapshots (1º serviço real após 28/07)**: a inversão do `CLEANUP_MODE` foi validada em DB temporária, mas ainda **não** houve um `save_snapshot` real depois do deploy. No próximo serviço, conferir no journal do `monitor-snapshot-worker-rw` que sai **`marked exported id=`** (e **nunca mais** `deleted id=`), que a linha aparece em `monitor-backend-rewrite/data/monitor.db` com as colunas achatadas preenchidas, e que o item no SharePoint entrou com os mesmos campos de sempre. Na mesma checagem, confirmar que a mtime de `monitor-backend-dev/data/monitor.db` **não se move** — é o gate para aposentar a DB órfã (ver 🟡).
- **`completed_no_push` com `progress=%` vazio — parser de progresso não extrai o push (2 casos: veh 1914177 e veh 1991741)**: o SB fecha como `completed_no_push` quando o `execute_action_opr` é aceito (process_id obtido) mas o watchdog de 90s estoura sem progresso — o worker registra `progress=%` (vazio) **mesmo recebendo** frames `UNIT_CONFIG_STATUS`. Casos: (1) veh **1914177** (ENEVA, placa `604 - QZB8F00`, serial 913055568, scheme 5536, job `13fce0288d9dc10c`, 23/07) — chegaram pushes às 09:27:50 e 09:28:05 e mesmo assim `progress=%`; (2) veh **1991741** (JBS, placa BYZ5G71, scheme 5643, job de reprocesso `9105864a795b7102`, 27/07) — `get_vcls OK processId=11002354`, apply enviado, fechou `no_push`. **Confirmar no Traffilog se o scheme foi aplicado nos dois** e, se não, reenviar. Investigar por que o push chega sem casar com o parser de progresso (o `waitSbCompleted` recebe o `UNIT_CONFIG_STATUS` mas não extrai o campo de progresso).
- P2: canWorker paralelo — `CAN_WORKER_CONCURRENCY` env var.
- P3: HTML5_INSTALL com instalação ativa — requer reprodução controlada.

### 🟡 Backlog
- **Aposentar `monitor-backend-dev/data/monitor.db` (agora órfã)**: desde 28/07 a DB canônica é `monitor-backend-rewrite/data/monitor.db` — as duas units (`monitor-snapshot-worker-rw`, `monitor-snapshot-retry-rw`) perderam a diretiva `Environment=SQLITE_DB_PATH=` e passaram a herdar o caminho do `worker_secrets_rw.env`. A DB do dev ficou **sem leitor e sem escritor**, mas a confirmação final ainda depende de observar um `save_snapshot` real: conferir que a mtime de `monitor-backend-dev/data/monitor.db` **não** se move e que a linha nova aparece na DB da rewrite. Depois disso, `mv` para `~/backups/` (cópia já existe em `~/backups/monitor.db.dev-20260728_160745`). Isso remove um dos 6 bloqueios do item "Remover repos antigas". Os outros 5 continuam: 4 units rodando código do dev (`monitor-can-snapshot-worker`, `monitor-html5-warmup-worker`, `monitor-html5-heartbeat`, `monitor-vehicle-resolver-worker`) + cron `*/30 renew_html5_cookie.sh`.
- **`HTML5_LOGIN_CURL_FILE` é dependência morta em 4 units `-rw`**: `monitor-can-worker-rw`, `monitor-html5-uninstall-worker-rw`, `monitor-html5-maint-no-swap-worker-rw` e `monitor-html5-maint-with-swap-worker-rw` setam `Environment=HTML5_LOGIN_CURL_FILE=/home/questar/monitor-backend/html5_login_curl.txt`. O arquivo **não existe** e a variável **não é lida por nenhum código da rewrite** (`grep` em `src/` → zero ocorrências). Pode sair das units sem efeito — é a última amarra dessas 4 units à repo `monitor-backend`. Descoberto na auditoria de 28/07.
- **Install worker roda em DUPLICIDADE (inline + standalone) — consolidar p/ 1 ator HTML5**: o `index.js` (processo principal, pid 7128, porta 3000) importa e roda `installWorker`/`gsWorker`/`schemeBuilderWorker`/`canWorker` **inline** (`src/index.ts:105-108`, jar `_rewrite`), **e** há a unit standalone `monitor-html5-install-worker-rw` (`worker_secrets_rw.env`) rodando o **mesmo** installWorker. Dois processos separados fazendo `html5Login` = duas sessões que se derrubam no server-side (sessão única por conta) → janela de eviction que pode voltar a causar falso "not found" no Path A. Mitigado hoje por: jar unificado (convergem no último login) + guarda anti-duplicata (ver Feito). Follow-up seguro: (1) confirmar qual worker efetivamente processa (o inline aparenta ganhar os polls — logs `[install-rw]`/`[installations]` saem no journal do `monitor-backend-rewrite`, o journal do standalone estava vazio); (2) se o inline cobre, `disable --now` o standalone `monitor-html5-install-worker-rw`; idem avaliar `uninstall`/`maint-no-swap`/`maint-with-swap` standalone (esses **não** têm equivalente inline — não desabilitar sem migrar). Objetivo: só o processo principal fala HTML5 no Severino. **Não fiz agora p/ não arriscar quebrar install.** Casa com o item "Remover repos antigas" (mesma família de units).
- **Login HTML5 frio precisa de mais warmup que 2 tentativas / não rodar scripts avulsos contra o jar `_rewrite`**: um login **do zero** (jar vazio) do Severino às vezes devolve VHCLS vazio mesmo após `warmupAsp`+`html5Login` nas 2 tentativas do `resolveByPlate`/`resolveVehicleIdDirect` — o servidor, que mantém a sessão **quente** no jar `_rewrite`, resolve estável (verificado 5/5). Gotcha operacional: **não rodar scripts node avulsos de VHCLS contra o jar `_rewrite` com o servidor no ar** — eles disparam relogin/invalidação e **poluem a sessão do servidor**, gerando falsos "null". Validar sempre pelo endpoint do servidor (`GET /api/installations/vhcls-lookup?plate=`), ou usar um jar temporário isolado ciente de que o cold-start pode precisar de mais warmup. Melhoria possível: subir o nº de tentativas do cold-login ou fazer um warmup explícito antes da 1ª query.
- **Avaliar Severino_Prod também para WS/appengine (isolamento total)**: hoje só o **HTML5** da rewrite migrou p/ `Severino_Prod`; `WS_LOGIN_NAME`/`WS_PASSWORD` (CAN) e o appengine seguem em `Marcus_Prod` (não arrisquei o CAN sem saber se Severino tem permissão de WS/API). A staleness que causava duplicata era só do HTML5, então o CAN não precisa — mas se quiser isolar de vez, testar Severino no WS/appengine antes de trocar. Ver [[conta-html5-rewrite-severino]].
- **Sobra da duplicata: veh 1997372 com a placa `542 - QZA4A80`**: após a consolidação de 24/07 (serial movido p/ 1914180) o 1997372 ficou desativado, **sem serial**, mantendo a placa (igual ao 1987842). A regra do menor `vehicle_id` escolhe o 1914180, mas toda busca pela placa loga o aviso de duplicata. **Usuário vai limpar/aposentar manualmente no HTML5.**
- **Sobra da duplicata: veh 1987842 com a placa `604 - QZB8F00`**: após o descadastro de 23/07 ele ficou desativado e **sem serial**, mas manteve a placa. Não estorva — a regra do menor `vehicle_id` escolhe o 1914177 —, porém toda busca por essa placa loga o aviso de duplicata. Proposta: renomear o 1987842 para um placeholder (ex.: `CMDT-913055568`) e aposentá-lo de vez. Decisão do usuário, não feito.
- **Auditar duplicatas de placa no Traffilog**: o `console.warn` novo no `parseVehicleIdFromVhclsXml` denuncia toda placa que casa com >1 veículo. Vale varrer os logs depois de alguns dias para dimensionar quantos cadastros duplicados o bug do strip criou desde que existe (todo INSTALL de cliente que usa prefixo de frota era candidato) e planejar a limpeza.
- **Limpar `schemes_selection.json` legados**: desde a correção do scheme-por-cliente (15/07), o `schemeSelectionService.ts` lê o `active-config.json` da internal-tools (`/home/questar/internal-tools/active-config.json`, `settings[clientId].vehicleSettingId`) como fonte única, gerenciado pela configpage. O `config/schemes_selection.json` (formato `{clients:[{client_id, selected_scheme_id}]}`) virou só **fallback** para clientes ainda ausentes no `active-config.json` — congelado desde 27/mai, com dados que podem divergir do que a internal-tools mantém (ex.: GEOCARGO estava 5576 lá vs. 5675 no active-config). O `public/schemes_selection.json` é cópia morta (nenhum uso). Proposta: (1) confirmar que todos os clientes ativos já estão no `active-config.json` (55 hoje) — se sim, remover o branch de fallback em `schemeSelectionService.ts:getSelectedSchemeId`; (2) apagar `config/schemes_selection.json` e `public/schemes_selection.json`; (3) checar se `adminRoutes.ts` (que ainda escreve `SCHEMES_PATH`) e o `admin.html` ainda dependem dele — migrar ou remover. Cuidado: hoje o fallback ainda protege clientes fora do active-config; não remover antes de confirmar cobertura.
- **Module state ausente no export — re-check pelo timer de 30min**: o `saveSnapshotWorker` já faz backfill do module state antes de exportar (`fetchModuleState`, até 60s), mas se nesse momento o registro ainda não existir no servidor Traffilog o snapshot é exportado **sem** module state e não há nova tentativa. Acontece quando a unidade para de transmitir logo após a instalação (caso confirmado: veh 1997930 — sem registro nem 50min depois, `unitParametersEvents=0`). Proposta: aproveitar o `monitor-snapshot-retry-rw.timer` (já roda a cada 30min chamando `retryPending()`) para, antes de exportar um registro pendente, re-consultar o module state via WS e preencher `snapshot_json.can.moduleState` + `canSummary`. Exige manter o snapshot como `pending` quando o module state vier vazio (hoje ele exporta e vira `exported`), com um cap (ex.: 2h) para não ficar preso para sempre em veículo que nunca reporta.
- **Escala da pressão do ar (`0000711F`) — validar em campo**: a entrada `sys_param_brake1_air_pressure` na `PARAM_META` (`vehicleMonitorSnapshotService.ts`) usa `multiplier: 0.05` **por inferência** (raw 0x95=149 → 7,45 — coerente com freio a ar de caminhão, ~7-8 bar), não por fonte oficial: nem a `PARAM_META` daqui nem a cópia do `internal-tools` tinham esse param. Confirmar com um veículo transmitindo. Fonte autoritativa possível: `get_unit_parameters_metadata` é chamado em `vehicleMonitorSnapshotService.ts:~458` e tem a **resposta descartada** (`.catch(()=>{})`) — se ela trouxer multiplicador/offset/unidade por param, substitui a `PARAM_META` hardcoded de vez (não deu pra sondar: Traffilog recusando login com `av=6666`).
- **Aviso do lookup de placa (INSTALL) — diferenciar por `inner_id`**: hoje `_doLookup` (`app.html:875-881`) sempre exibe o banner vermelho "Placa já cadastrada no sistema" quando a placa é encontrada em INSTALL, sem distinguir se o veículo tem equipamento. Busca confirmada: `GET /api/installations/vhcls-lookup?plate=` → `resolveByPlate`/`postVhcls` (`vhclsService.ts`) posta `LICENSE_NMBR=<placa>`; a resposta já traz `inner_id` (parseado do XML VHCLS) e é gravada em `state._innerIdFromLookup`. A busca continua rodando exista a placa ou não. Melhorar a branch `isInstall` decidindo pelo `inner_id` do veículo encontrado: (a) placa existe **E** `inner_id` preenchido → banner **vermelho**, incluindo o serial na mensagem, ex.: "Este veículo já existe no HTML5 com o serial {inner_id}."; (b) placa existe **E** `inner_id` vazio → banner **azul** normal (reusar o estilo `#1e3a5f`/`#091624` já presente), pode manter o texto atual — veículo cadastrado sem equipamento, instalação segue; (c) placa não encontrada → mantém o comportamento atual (verde, "instalação nova"). Só frontend (`public/app.html`) — backend já retorna `inner_id`. Sem `npm run build` (arquivo estático em `public/`).
- **🔴 Jobs "processing orphan" pós-restart**: resetar para `pending` qualquer job em `processing` há mais de 10min sem atualização de `updatedAt` (no `jobStore` ou health-check periódico).
- **Botão "Reprocessar HTML5" no frontend**: endpoint `POST /api/installations/:id/retry-html5` funciona via curl, mas botão no app não aciona — investigar frontend (`installation_id` incorreto ou estado da UI).
- **Melhorias admin.html**: (1) exibe só 1 instalação ativa mesmo com múltiplas em paralelo; (2) botão Retry (↺) em jobs `error`; (3) botão Encerrar (✕) independente de status; (4) mover link admin para ícone discreto no rodapé (⚙), visível só para admin.
- **CAN com veículo offline — moduleState/instalação não aparece**: `get_monitor_module_state` retorna `data:0` (e `av=0`) quando o veículo está offline durante a captura — sem registros de módulo no servidor, o CAN não tem o que mostrar e a instalação não "aparece" completa. Confirmado em 29/06: veículo online (1990679) trouxe 38 módulos; offline trouxe 0. Já corrigido o timing (consulta pós-janela, seção 7b) e o `isConnected` (deriva de `unitParametersEvents>0`). Falta: detectar offline e (a) avisar o técnico claramente ("veículo offline — religue/ignição"), e/ou (b) re-capturar automaticamente quando `is_connected` virar 1. Nota: `av` (action_value) não é confiável — usar `data.length`.
- **Remover repos antigas (`monitor-backend`, `monitor-backend-dev`)**: o refatoramento está completo e funcional em `monitor-backend-rewrite`. **Requer planejamento** — não é só apagar diretório: ainda há serviços systemd ativos apontando para as repos legadas (`monitor-html5-install-worker` v5, `monitor-html5-warmup-worker`, `monitor-vehicle-resolver-worker`, `monitor-html5-heartbeat`) + cron `*/30 renew_html5_cookie.sh` (em `monitor-backend-dev/scripts/`) + EnvironmentFiles em `/etc/monitor-backend/`. Plano sugerido: (1) confirmar que nenhum serviço `-rw` depende de algo das repos antigas; (2) `disable --now` + remover units legadas; (3) remover/cobrir o cron de cookie pela versão da rewrite; (4) limpar `/etc/monitor-backend/`; (5) só então remover os diretórios. Validar HTML5/CAN/SB end-to-end após cada etapa.

### ✅ Feito recentemente
- **Snapshots deixaram de ser apagados + histórico do SharePoint importado p/ o SQLite (28/07)**: o `snapshotStore` funcionava como buffer descartável — gravava, exportava e **apagava** (`CLEANUP_MODE` default `"delete"`). O `sqlite_sequence` mostrava **720 inseridos e ~692 destruídos**: todo o dado bruto (parameters CAN, moduleState de 38 módulos, mileage, engine_hours) foi perdido, sobrando só os 17 campos achatados do SharePoint com o CAN comprimido em 255 chars. Agora a tabela é a **base histórica permanente**, lida direto (SQLite/WAL) por outra repo da VM. Mudanças: (1) default do `CLEANUP_MODE` invertido para **`"mark"`** — `"delete"` vira opt-in explícito, para env ausente nunca mais destruir dado; (2) schema ganhou 13 colunas achatadas (`source`, `sp_item_id`, `service_date`, `manufacturer`, `model`, `year`, `color`, `chassi`, `local_instalacao`, `etiqueta`, `chicote`, `comment`, `can_summary`) + `PRAGMA journal_mode=WAL` + índices em `job_id`/`service_date`/`plate`/`client_id` e **UNIQUE parcial em `sp_item_id`**; (3) `_insertSnapshot` deriva as colunas do próprio `p.snapshot_json.cadastro` — a interface `SnapshotPayload` **não muda**, então `saveSnapshotWorker`, `_buildFields` e `exportSnapshot` ficam intactos (o único diff no `sharepointExporter.ts` são 4 keywords `export` + um `return`, para reuso do `_getToken`/`_graphGet`/`_ensureIds`/`_formatCan`). **Gotcha que só apareceu na execução**: `CREATE TABLE IF NOT EXISTS` **não afrouxa constraint** — a tabela existente tinha `job_id` e `snapshot_json` como `NOT NULL`, e linhas do SharePoint não têm nenhum dos dois; foi preciso adicionar reconstrução de tabela (`CREATE __new` → `INSERT SELECT` → `DROP` → `RENAME`) na migração, idempotente e preservando as linhas. Consolidação: DB canônica passou a ser `monitor-backend-rewrite/data/monitor.db` (as 2 units perderam o `Environment=SQLITE_DB_PATH=` e herdam do `worker_secrets_rw.env`); 28 linhas legadas migradas do dev via `scripts/migrate-dev-snapshots.cjs`. Backfill: `src/services/sharepointBackfill.ts` + `scripts/backfill-sharepoint.cjs` (`--dry-run` suportado) pagina `GET /lists/{id}/items?$expand=fields&$top=500` seguindo `@odata.nextLink` — **4.969 itens em 10s**, `ON CONFLICT(sp_item_id) WHERE sp_item_id IS NOT NULL DO NOTHING` (o índice é parcial, o `ON CONFLICT` precisa repetir o `WHERE`). Total: **4.997 linhas / 1,8 MB**; INSTALL 3827 · UNINSTALL 608 · MAINT 510 · NO_SWAP 20 · WITH_SWAP 4; 0 etiquetas fora do canônico; re-execução dá `inseridas=0`. Dois achados de mapeamento: o `LABEL_PT` não cobre **`Trás`** (1.292 linhas legadas — alias extra `TRAS→BACK` obrigatório, senão viravam NULL) e existe um serviço **`Manutenção` genérico** (510 linhas, sem distinção de troca → `MAINT`). `Serial`/`Ano` vêm do Graph como **float** (`913000494.0`) — truncados. `data/` foi adicionada ao `.gitignore` (a DB agora tem dado de produção). `npm run build` + restart de `monitor-snapshot-worker-rw`.
- **SCHEME_BUILDER colidia com installs paralelos do mesmo cliente — serialização por `client_id` no despacho (27/07, commit `df8cb14`)**: o "processo de review" do SB no Traffilog é um **slot ÚNICO por `client_id`** — `review_process_attributes` e `get_vcls_action_review_opr` são chaveados **só por `client_id`** (sem `vehicle_id`/`process_id`). Quando dois installs do mesmo cliente rodavam o `scheme_builder` em paralelo na mesma sessão WS, o 2º recebia `associate call_num=1 av=8` (slot ocupado/locked) + `review_process_attributes` **vazio** (`data:[]`, `action_records:0`) → sem `process_id` → **`process_id nao retornado — abortando SB`** (`error`), install destravado mas scheme não aplicado. Confirmado no veh **1991741** (JBS, cliente 217857, placa BYZ5G71): job SB `8ae21c4c27a39334` (veh 1993032, mesmo cliente) segurou o slot em loop `SB_WAIT`/keepalive de 08:01:33 a 08:03:36; o SB do 1991741 tentou o review às 08:02:51 no meio dessa janela → colidiu. Fix em `jobStore.ts:getNextJob` (bloco `SB_CLIENT_SERIALIZE_V1`): para `type==="scheme_builder"`, **não entrega** um SB de um cliente enquanto outro SB do mesmo `client_id` está `processing` (calcula `busyClients` dos SB em processing e pula os pendentes desses clientes). SB de clientes distintos seguem paralelos; **installs paralelos ficam livres — só o SB é encadeado**. Cobre cross-process (o `getNextJob`/`/api/jobs/next` é o ponto único servido pelo inline, onde todos os workers batem — inline e standalone `monitor-sb-worker-rw`, este ocioso). Órfãos presos em `processing` são liberados pelo `reclaimOrphans` (10min), então SB travado nunca bloqueia o cliente pra sempre. **Validado ao vivo**: logo após o deploy chegou uma rajada de installs JBS (1997571, 1997558, 1998611, …) — todos os SB rodaram **um de cada vez**, `completed`, **sem nenhum novo erro**; antes teriam colidido. Reprocesso do 1991741 (SB reenfileirado via `POST /api/jobs`, payload do job que falhou) pegou o slot livre → `associate av=0` (sem `av=8`) → `get_vcls OK processId=11002354` → pipeline cascateou pro CAN (`waiting_approval`). `npm run build` + restart de `monitor-backend-rewrite`. Nota: o SB do reprocesso fechou como `completed_no_push` (mesmo padrão do 1914177, ver 🔴) — apply aceito mas sem confirmação por push.
- **CHANGE_COMPANY revertia o asset_type do install para NA (24/07)**: no INSTALL via Path B com `client_mismatch` (veículo/placeholder resolvido num cliente ≠ cadastro), o pipeline roda `CHANGE_COMPANY` **depois** do `SAVE_VHCL_ACTIVATION_NEW`. O `assetBasicSave` (`ASSET_BASIC_SAVE` em `changeCompanyService.ts:164`) grava `MODEL_CODE = vhclsData.ASSET_TYPE`, e o `vhclsData` vinha do **veículo resolvido** — quando é um placeholder CMDT em branco (asset NA), **desfazia** o asset que o SAVE tinha acabado de gravar (técnico seleciona Scania → volta a `ASSET_TYPE=1`/NA). Só se manifesta quando o asset do veículo resolvido **difere** do selecionado; se o veículo já tinha o asset certo (ex.: 1940475, Path B+CHANGE_COMPANY mas placeholder já era Scania G460 23697), o regravado coincide e nada quebra. Confirmado no 1999766 (placa `200 - UMP2H64`, Francisconi): postcheck às 14:08 mostrava 21223 (Scania R500LA); consulta ao vivo depois mostrava `ASSET_TYPE=1` NA. `client_id_found=219411` ≠ cadastro `219322` → CHANGE_COMPANY rodou. Fix cirúrgico no call site (`installWorker.ts` ~588): antes do `executeChangeCompany`, sobrescreve `vhclsData.ASSET_TYPE = payload.assetType` (+ `MANUFACTURER_DESCR`/`MODEL` do `payload.vehicle`, e apaga `ASSET_TYPE_DESCR` p/ o servidor re-derivar), pro `ASSET_BASIC_SAVE` **preservar** o asset selecionado. `npm run build` + restart de `monitor-backend-rewrite` e `monitor-html5-install-worker-rw`. O 1999766 foi corrigido em produção com um SAVE direto (`ASSET_TYPE=21223`, sem CHANGE_COMPANY pois já está no 219322) — postcheck `applied=true`, estável. Nota de diagnóstico: consultas MWS (`mwsLoadBaseline`/`mwsSave`/`mwsPostcheck`) **não invalidam** a sessão, então podem rodar contra o jar quente `_rewrite` sem poluir (ao contrário de `resolveByPlate`, ver [[html5-jar-rewrite-nao-rodar-scripts-avulsos]]).
- **Conta HTML5 própria p/ a rewrite (`Severino_Prod`) — mata a raiz das duplicatas por sessão stale (24/07)**: o bug do dia (INSTALL da placa `542 - QZA4A80` criou o duplicado 1997372 em vez de resolver o 1914180 existente) **não** era o strip do `2e20972` — a chave ia correta (`LICENSE_NMBR="542 - QZA4A80"`), mas o VHCLS voltava **vazio** no momento do install (dumps `vhcls_raw_..._a1/_a2` sem `<DATA>`), o Path A concluía "not found" e caía no Path B → placeholder CMDT → duplicata. **Causa raiz: eviction contínua da sessão HTML5.** A rewrite, o `internal-tools` (pid 12863, `/home/questar/internal-tools`) e o cron `renew_html5_cookie.sh` (a cada 30min) logavam **todos na mesma conta `Marcus_Prod`**; o HTML5 mantém **1 sessão por conta** → cada login derrubava os outros no server-side. Fix: rewrite passou a usar **`Severino_Prod`** só no HTML5 (`.env` + `worker_secrets_rw.env`; WS/appengine seguem em Marcus — CAN intacto), com **jar unificado** (`HTML5_COOKIEJAR_PATH=/tmp/html5_cookiejar_rewrite.json` adicionado no `worker_secrets_rw.env`, p/ processo principal e workers standalone convergirem numa sessão só). Como internal-tools+cron ficam no Marcus, a eviction contínua acabou. Validado: Severino loga+warmup e resolve `QZA4A80`→1914180 (cliente 217062 ENEVA), estável 5/5 pelo endpoint do servidor. Backups: `.env.bak_20260724_104429`, `worker_secrets_rw.env.bak_20260724_104429`. Restart de `monitor-backend-rewrite` + workers HTML5 `-rw`. Ver [[conta-html5-rewrite-severino]].
- **Guarda anti-duplicata no Path B (`installWorker.ts`) — blindagem contra falso "not found" (24/07)**: como a resposta VHCLS "válida vazia" é **indistinguível** de "placa não existe" (ambas = zero `<DATA>`), e o Path B (serial→placeholder) é o fluxo **normal** de todo install novo, não dá p/ simplesmente abortar quando o Path A vem vazio. A guarda: antes de carimbar a placa real num placeholder CMDT, **reconfirma a placa** via `resolveByPlate(plateBare)` (sem frota — query mais abrangente por substring); se reaparecer em outro `vehicle_id ≠ placeholder`, usa esse (retorna `resolvedBy:"plate"`, não duplica); se continuar vazia, placa é nova de fato → Path B segue (install novo intacto). Custo: 1 consulta VHCLS extra por install que cai no Path B (desprezível no fluxo humano de minutos). `npm run build` + restart de `monitor-backend-rewrite` e `monitor-html5-install-worker-rw`.
- **Consolidação da duplicata 1997372→1914180 (24/07)**: `mwsDeactivate` no 1997372 liberou o serial `913054981` (verificado: `INNER_ID` → 0 registros), seguido de `html5_install` **forçando `vehicle_id=1914180` no payload** (job `2aa982cf1d97e841`) — como o payload já traz o vehicle_id, o `installWorker` pula a resolução Path A/B (`resolved_by:"payload"`), imune a qualquer staleness. Postcheck: 1914180 com `ASSET_TYPE=23726` (VW Meteor 29.520) + `DIAL_NUMBER=913054981`. CAN da pipeline **cancelado** a pedido (`POST /api/admin/jobs/:id/cancel`). Confirmado de quebra: o "asset NA-NA-NA" que o usuário via é o **cadastro MANUFACTURER/MODEL do VHCLS** (fica NA quando o veículo nasce de placeholder CMDT no Path B), separado do `ASSET_TYPE` de ativação — resolver p/ o veículo existente corrige o asset de graça.
- **INSTALL resolvia `vehicle_id` errado quando a placa tem prefixo de frota** (commit `2e20972`): a chave de busca era normalizada (strip de espaços/pontuação) **antes de ir ao servidor**. O frontend monta `plate_real = "604 - QZB8F00"`; o strip mandava `LICENSE_NMBR=604-QZB8F00` e o filtro do VHCLS — que é **substring** do `LICENSE_NMBR` gravado — devolvia datasource vazio. Caminho A falhava, caía no Caminho B, resolvia pelo serial e **renomeava o placeholder CMDT com a placa real, duplicando o cadastro** (job `e08036a8d50847fe`: gravou no 1987842 em vez do 1914177). Provado por probe direto: `"604 - QZB8F00"`→2 linhas, `"QZB8F00"`→2, `"604-QZB8F00"`→**0**. O strip estava em **4 pontos** (`installWorker:139`, `resolveVehicleIdDirect:249`, `resolveByPlate:433`, `normPlate` em `installationsRoutes`) — os dois do meio só apareceram quando o teste de verificação falhou depois do primeiro build. Regra agora: **normalizar só para comparar/deduplicar, nunca para consultar.** Junto: (a) Caminho A tenta placa cheia → placa sem frota, e zera os aliases de serial que faltavam (`serie`/`innerId`/`SERIAL`/`lookup_license*`), que faziam o Caminho A resolver pelo serial reportando `resolvedBy:"plate"` e pular o `CHANGE_COMPANY`; (b) placa ambígua → **menor `vehicle_id` vence**, com `console.warn` listando os IDs. Exige `npm run build` + restart de `monitor-backend-rewrite` e `monitor-html5-install-worker-rw`.
- **Erro de token do CAN** (mesmo commit): login do AppEngine devolveu HTTP 200 com **corpo vazio** e o `JSON.parse("")` virava `SyntaxError: Unexpected end of JSON input` — mensagem que escondia a causa. Agora corpo vazio tem erro próprio (`resposta vazia (HTTP 200)`) e o `parse error` inclui o corpo cru. Além disso o `canWorker` **abortava o job na 1ª tentativa** (`failJob` + `return`), curto-circuitando o próprio `CAN_MAX_ATTEMPTS`; passa a consumir as tentativas restantes reusando `invalidateTrafflogToken()` + sleep de 10s. Restart de `monitor-can-worker-rw`.
- **Correção da duplicata em produção (23/07)**: `DEACTIVATE_VEHICLE_HIST` no 1987842 via `mwsDeactivate` liberou o serial (verificado: busca por `INNER_ID` passou a 0 registros — necessário porque `classifyVehicle` classificaria o 1987842 como `blocked`, tendo placa real, e o INSTALL falharia com `serial_in_use`), seguido de um `html5_install` normal (job `e813682ec50c554a`) que resolveu `Caminho A → 1914177` e gravou o serial. Serve também como validação end-to-end do fix acima.
- Snapshots não subiam ao SharePoint — dois campos quebravam o export com `400 Invalid request` genérico (`sharepointExporter.ts`): (1) **CAN >255 chars** — `_formatCan` despejava todos os params (ex.: 914 chars); a coluna `CAN` é texto de linha única (máx 255). Agora mantém IGN/KEY/MOD, adiciona params só até caber, marca quantos ficaram de fora (`+N`) e tem guard final `slice(0,255)`. (2) **Serial vazio** — mandava `""` para a coluna `Serial` (tipo `number`) → rejeitado; agora manda `null` (`p.serial || null`). Diagnóstico isolado campo-a-campo via probe no Graph. Drenados os **66 pendentes acumulados desde 10/jun** (a DB do worker é `monitor-backend-dev/data/monitor.db` via `SQLITE_DB_PATH`). Exige `npm run build` + restart de `monitor-snapshot-worker-rw`.
- Timer de retry do export (resolve o gap estrutural): `retryPending()` existia mas **nunca era agendado** (a "cron das 6h" do comentário nunca foi ligada) — por isso qualquer falha transitória ficava presa como `pending` para sempre. Criado `scripts/retry-snapshots.cjs` (runner) + units `monitor-snapshot-retry-rw.service` (oneshot) e `.timer` (a cada 30min, `OnBootSec=5min`, `Persistent=true`) em `/etc/systemd/system/` — reusam `worker_secrets_rw.env` e setam `SQLITE_DB_PATH` para a DB do worker. Units estão **fora do repo** (`/etc/systemd/system/`). Testado: exit 0.
- App — carregar foto da galeria: cada tipo de foto ganhou botão **🖼️ (galeria)** além do **📷 (câmera)**; segundo input `accept="image/*"` **sem** `capture` abre a galeria/arquivos em vez de forçar a câmera. Fluxo de câmera original intacto. Só frontend (`public/app.html`) — arquivo estático, sem build/restart.
- CAN moduleState + isConnected (resolve P0/P1): `get_monitor_module_state` movido para DEPOIS da janela de params (seção 7b em `vehicleMonitorSnapshotService.ts`, espelhando o internal-tools) — a consulta precoce (t≈0.5s) e o retry no 1º param voltavam `data:0/av=0`. Confirmado 29/06: veículo online (1990679) trouxe 38 módulos; offline → 0 (esperado, tratado no backlog). `isConnected` agora deriva de `unitParametersEvents>0` em vez do snapshot único e defasado do redis (`get_vehicle_data_from_redis` em t≈0). Removidos o bloco de consulta precoce e o retry frágil (`moduleStateRetried`). Nota: `av` (action_value) não é confiável — usar `data.length`. Exige `npm run build` + restart de `monitor-can-worker-rw` e `monitor-can-snapshot-worker`.
- MAINT_NO_SWAP "não testar CAN" agora gera snapshot + export: `complete-maint` enfileira `save_snapshot` (além do SB silencioso) com cliente, serial, placa+frota, serviço, data e técnico — sem CAN/gsensor/veículo (campos saem em branco no SharePoint). Serial vem do `inner_id` do lookup de placa (`_innerIdFromLookup`), antes zerado no frontend; banner "Serial atual do veículo" passou a aparecer também no MAINT_NO_SWAP (`app.html:885`). Resolve o item de backlog homônimo. **Nota operacional**: mudança de `src/` só vale após `npm run build` **+ restart** do `index.js` (porta 3000) — o snapshot não saía porque o servidor rodava `dist` antigo. `complete-maint` ("não testar") e `approve-can` ("validar CAN") enfileiram `scheme_builder` após a finalização, sem GS. SB é terminal (`_terminal`) — aplica o scheme e encerra, sem cascata para novo CAN. Corrige guard do `complete-maint` que exigia `vehicle_setting_id` (frontend nunca envia) → scheme resolvido via `getSelectedSchemeId(client_id)`. `comment` do SB usa o comentário da tela de cadastro; fallback `MAINT_NO_SWAP_SKIP` só quando vazio.
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
