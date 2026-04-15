// =============================================================================
// PATCH: html5_change_company — adicionar em vehicleResolverWorker.js
// =============================================================================
// INSTRUÇÕES:
//   1) Cole as funções abaixo ANTES do loop principal de processamento de jobs
//   2) Cole o bloco "if (flow === 'CHANGE_COMPANY')" DENTRO do switch/if de jobs
//   3) Não mexer no html5InstallWorker_v8.js
// =============================================================================

// ---------------------------------------------------------------------------
// Helpers de XML simples (sem dependência externa)
// ---------------------------------------------------------------------------

/**
 * Extrai todos os atributos de tags XML que correspondem ao seletor de tagName.
 * Ex: parseXmlAttrs(xml, "GROUP") → [{GROUP_ID:"231207", CLIENT_DESCR:"TransLima", ...}, ...]
 */
function parseXmlAttrs(xml, tagName) {
  const results = [];
  const re = new RegExp(`<${tagName}([^>]*)>`, "gi");
  const attrRe = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrsStr = m[1];
    const obj = {};
    let a;
    while ((a = attrRe.exec(attrsStr)) !== null) {
      obj[a[1]] = a[2];
    }
    attrRe.lastIndex = 0;
    results.push(obj);
  }
  return results;
}

/**
 * Retorna o GROUP_ID do grupo raiz cujo CLIENT_DESCR === clientName.
 * Prioriza grupos sem PARENT_OBJECT (raiz) ou pega o primeiro match.
 */
function resolveGroupId(xml, clientName) {
  const groups = parseXmlAttrs(xml, "GROUP");
  // Primeiro tenta grupo raiz (sem PARENT_OBJECT ou PARENT_OBJECT vazio)
  const root = groups.find(
    g => g.CLIENT_DESCR === clientName && (!g.PARENT_OBJECT || g.PARENT_OBJECT === "")
  );
  if (root) return root.GROUP_ID;
  // Fallback: qualquer grupo com CLIENT_DESCR igual
  const fallback = groups.find(g => g.CLIENT_DESCR === clientName);
  if (fallback) return fallback.GROUP_ID;
  return null;
}

/**
 * Extrai todos os atributos da primeira tag DATA (ou DATA_OBJ) do XML retornado pelo ASSET_BASIC_LOAD.
 * Retorna um objeto plano com todos os campos necessários para o SAVE.
 */
function parseAssetLoadAttrs(xml) {
  // Tenta tag DATA primeiro, depois DATA_OBJ
  for (const tag of ["DATA", "DATA_OBJ", "ASSET"]) {
    const found = parseXmlAttrs(xml, tag);
    if (found.length > 0) return found[0];
  }
  // Fallback: retorna objeto vazio (SAVE vai falhar mas não vai travar o worker)
  console.warn("[changeCompany] Não encontrou tag DATA/DATA_OBJ/ASSET no XML do LOAD");
  return {};
}

// ---------------------------------------------------------------------------
// Função principal: changeCompany
// ---------------------------------------------------------------------------

/**
 * Executa a troca de empresa de um veículo no HTML5.
 * Fluxo: LOGIN_USER_GROUPS → ASSET_BASIC_LOAD → ASSET_BASIC_SAVE (com novo GROUP_ID)
 *
 * @param {number|string} vehicleId   - ASSET_ID do veículo
 * @param {string}        plate       - Placa real (ASSET_DESCRIPTION)
 * @param {string}        targetClient - CLIENT_DESCR alvo (ex: "TransLima")
 */
async function changeCompany(vehicleId, plate, targetClient) {
  const HTML5_URL = "https://html5.traffilog.com/AppEngine_2_1/default.aspx";

  // Lê o cookie do jar local (mesma função já usada pelo worker para VHCLS)
  const cookieHeader = readCookieHeader(); // função já existente no worker

  // Helper local para POST form-urlencoded ao HTML5
  async function html5Post(body) {
    const encoded = Object.entries(body)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const resp = await fetch(HTML5_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": cookieHeader,
      },
      body: encoded,
    });
    if (!resp.ok) throw new Error(`HTML5 POST falhou: ${resp.status} ${resp.statusText}`);
    return resp.text();
  }

  // 1) LOGIN_USER_GROUPS — busca todos os grupos disponíveis
  console.log(`[changeCompany] Buscando grupos para cliente "${targetClient}"...`);
  const groupsXml = await html5Post({ action: "LOGIN_USER_GROUPS", VERSION_ID: "2" });

  const groupId = resolveGroupId(groupsXml, targetClient);
  if (!groupId) {
    throw new Error(
      `[changeCompany] GROUP_ID não encontrado para "${targetClient}". ` +
      `XML recebido (primeiros 500 chars): ${groupsXml.slice(0, 500)}`
    );
  }
  console.log(`[changeCompany] GROUP_ID resolvido: ${groupId} para "${targetClient}"`);

  // 2) ASSET_BASIC_LOAD — carrega dados atuais do veículo
  console.log(`[changeCompany] ASSET_BASIC_LOAD vehicle_id=${vehicleId} plate=${plate}...`);
  const loadXml = await html5Post({
    ASSET_ID: String(vehicleId),
    ASSET_DESCRIPTION: plate,
    action: "ASSET_BASIC_LOAD",
    VERSION_ID: "2",
  });
  const loadAttrs = parseAssetLoadAttrs(loadXml);
  console.log(`[changeCompany] LOAD OK — campos: ${Object.keys(loadAttrs).join(", ")}`);

  if (Object.keys(loadAttrs).length === 0) {
    throw new Error(
      `[changeCompany] ASSET_BASIC_LOAD retornou XML sem campos reconhecidos. ` +
      `XML (primeiros 500 chars): ${loadXml.slice(0, 500)}`
    );
  }

  // 3) ASSET_BASIC_SAVE — salva com novo GROUP_ID
  const saveBody = {
    ...loadAttrs,
    GROUP_ID: groupId,
    action: "ASSET_BASIC_SAVE",
    VERSION_ID: "2",
  };
  console.log(`[changeCompany] ASSET_BASIC_SAVE com GROUP_ID=${groupId}...`);
  const saveXml = await html5Post(saveBody);
  console.log(`[changeCompany] SAVE OK — resposta (primeiros 200): ${saveXml.slice(0, 200)}`);

  return { group_id_applied: groupId, client_descr: targetClient };
}

// ---------------------------------------------------------------------------
// Bloco a adicionar no loop de processamento de jobs
// Cole DENTRO do bloco que processa cada job, no lugar correto do if/switch
// ---------------------------------------------------------------------------

/*
  // ---- INÍCIO DO BLOCO A COLAR ----

  if (flow === "CHANGE_COMPANY") {
    const { vehicle_id, plate_real, client_descr } = payload;

    if (!vehicle_id || !plate_real || !client_descr) {
      throw new Error(
        `[html5_change_company] Campos obrigatórios faltando: ` +
        `vehicle_id=${vehicle_id}, plate_real=${plate_real}, client_descr=${client_descr}`
      );
    }

    console.log(`[job:html5_change_company] Iniciando CHANGE_COMPANY — ` +
      `vehicle_id=${vehicle_id} plate=${plate_real} → "${client_descr}"`);

    const ccResult = await changeCompany(vehicle_id, plate_real, client_descr);

    result = {
      status: "OK",
      ...ccResult,
      vehicle_id,
      plate_real,
    };

    console.log(`[job:html5_change_company] CHANGE_COMPANY concluído:`, result);
  }

  // ---- FIM DO BLOCO A COLAR ----
*/
