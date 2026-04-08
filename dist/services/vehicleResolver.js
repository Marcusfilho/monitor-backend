"use strict";
// src/services/vehicleResolver.ts
// Implementa as regras de resolução de vehicle_id para INSTALL e MAINT_WITH_SWAP.
// Apenas consulta o HTML5 — não executa nenhuma ação destrutiva.
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveForInstall = resolveForInstall;
exports.resolveForMaintWithSwap = resolveForMaintWithSwap;
const html5Client_1 = require("./html5Client");
// ---------------------------------------------------------------------------
// INSTALL — Fase 1 (resolução sem execução)
// ---------------------------------------------------------------------------
async function resolveForInstall(params) {
    const { licence_nmbr, serial, client_descr } = params;
    let vehicle_id_final = null;
    let licence_nmbr_final = licence_nmbr;
    let resolution_path = "";
    let needs_uninstall_cmdt = false;
    // -------------------------------------------------------------------------
    // Passo 1: busca a placa em licence_nmbr
    // -------------------------------------------------------------------------
    console.log(`[resolver] INSTALL: buscando placa licence_nmbr="${licence_nmbr}"`);
    const plateRecords = await (0, html5Client_1.vhclsQueryByPlate)(licence_nmbr);
    // Filtra pelo match exato de licence_nmbr (o VHCLS pode retornar mais de um)
    const plateRecord = plateRecords.find((r) => r.licence_nmbr.trim().toUpperCase() === licence_nmbr.trim().toUpperCase()) || null;
    if (plateRecord) {
        console.log(`[resolver] placa encontrada vehicle_id=${plateRecord.vehicle_id} inner_id="${plateRecord.inner_id}"`);
        if ((0, html5Client_1.isEmptyInnerId)(plateRecord.inner_id)) {
            // Placa existe e está sem serial — reutiliza
            vehicle_id_final = plateRecord.vehicle_id;
            licence_nmbr_final = plateRecord.licence_nmbr;
            resolution_path = "PLATE_FOUND_EMPTY";
        }
        else {
            // Placa existe mas tem serial — vai buscar pelo serial
            console.log(`[resolver] placa tem inner_id="${plateRecord.inner_id}", buscando serial`);
            resolution_path = "PLATE_HAS_SERIAL_goto_SERIAL_SEARCH";
        }
    }
    // -------------------------------------------------------------------------
    // Passo 2: busca serial em inner_id (se ainda não resolveu)
    // -------------------------------------------------------------------------
    if (vehicle_id_final === null) {
        console.log(`[resolver] INSTALL: buscando serial="${serial}" em inner_id`);
        const serialInnerRecords = await (0, html5Client_1.vhclsQueryBySerial)(serial);
        const serialInnerRecord = serialInnerRecords.find((r) => (0, html5Client_1.serialsMatch)(r.inner_id, serial)) || null;
        if (serialInnerRecord) {
            console.log(`[resolver] serial encontrado em inner_id: vehicle_id=${serialInnerRecord.vehicle_id} licence_nmbr="${serialInnerRecord.licence_nmbr}"`);
            // inner_id == licence_nmbr → serial disponível para reaproveitamento
            if ((0, html5Client_1.serialsMatch)(serialInnerRecord.inner_id, serialInnerRecord.licence_nmbr)) {
                vehicle_id_final = serialInnerRecord.vehicle_id;
                resolution_path = "SERIAL_INNER_FREE";
            }
            else if (serialInnerRecord.licence_nmbr.trim().toUpperCase() === "CMDT") {
                // Serial está em CMDT → precisará de uninstall_cmdt antes
                vehicle_id_final = serialInnerRecord.vehicle_id;
                needs_uninstall_cmdt = true;
                resolution_path = "SERIAL_INNER_CMDT";
            }
            else {
                // Serial em uso por outro veículo
                console.log(`[resolver] serial já utilizado em vehicle_id=${serialInnerRecord.vehicle_id} licence_nmbr="${serialInnerRecord.licence_nmbr}"`);
                return {
                    status: "ERROR_SERIAL_ALREADY_USED",
                    error_message: `Serial já utilizado no veículo ${serialInnerRecord.vehicle_id} (${serialInnerRecord.licence_nmbr})`,
                    resolution_path: "SERIAL_INNER_IN_USE",
                };
            }
        }
    }
    // -------------------------------------------------------------------------
    // Passo 3: busca serial em licence_nmbr (se ainda não resolveu)
    // -------------------------------------------------------------------------
    if (vehicle_id_final === null) {
        console.log(`[resolver] INSTALL: buscando serial="${serial}" em licence_nmbr`);
        const serialLicenceRecords = await (0, html5Client_1.vhclsQueryByPlate)(serial);
        const serialLicenceRecord = serialLicenceRecords.find((r) => r.licence_nmbr.trim().toUpperCase() === serial.trim().toUpperCase()) || null;
        if (serialLicenceRecord) {
            console.log(`[resolver] serial encontrado em licence_nmbr: vehicle_id=${serialLicenceRecord.vehicle_id}`);
            vehicle_id_final = serialLicenceRecord.vehicle_id;
            resolution_path = "SERIAL_AS_PLATE";
        }
    }
    // -------------------------------------------------------------------------
    // Passo 4: nenhum registro encontrado — sinaliza criação de novo vehicle_id
    // -------------------------------------------------------------------------
    if (vehicle_id_final === null) {
        console.log(`[resolver] INSTALL: nenhum registro encontrado — novo vehicle_id necessário`);
        // vehicle_id_final permanece null = criar novo
        resolution_path = "CREATE_NEW";
    }
    // -------------------------------------------------------------------------
    // Passo 5: valida cliente do vehicle_id resolvido
    // -------------------------------------------------------------------------
    let client_descr_current;
    let client_id_current;
    let client_mismatch = false;
    if (vehicle_id_final !== null) {
        // Busca o registro completo para pegar o cliente atual
        // Já temos os dados da busca anterior — re-busca pelo vehicle_id
        const checkRecords = await (0, html5Client_1.vhclsQueryByPlate)(licence_nmbr_final);
        const checkRecord = checkRecords.find((r) => r.vehicle_id === vehicle_id_final) || null;
        if (checkRecord) {
            client_descr_current = checkRecord.client_descr;
            client_id_current = checkRecord.client_id;
        }
        else {
            // Se não encontrou pela placa, tenta pelo serial
            const checkBySerial = await (0, html5Client_1.vhclsQueryBySerial)(serial);
            const checkBySerialRecord = checkBySerial.find((r) => r.vehicle_id === vehicle_id_final) || null;
            if (checkBySerialRecord) {
                client_descr_current = checkBySerialRecord.client_descr;
                client_id_current = checkBySerialRecord.client_id;
            }
        }
        if (client_descr_current) {
            client_mismatch =
                client_descr_current.trim().toUpperCase() !== client_descr.trim().toUpperCase();
            if (client_mismatch) {
                console.log(`[resolver] client_mismatch: atual="${client_descr_current}" informado="${client_descr}"`);
            }
        }
    }
    return {
        status: "OK",
        vehicle_id_final: vehicle_id_final ?? undefined,
        licence_nmbr_final,
        client_descr_current,
        client_id_current,
        client_mismatch,
        needs_uninstall_cmdt,
        resolution_path,
    };
}
// ---------------------------------------------------------------------------
// MAINT_WITH_SWAP — Fase 1 (resolução sem execução, sem desinstalar nada)
// ---------------------------------------------------------------------------
async function resolveForMaintWithSwap(params) {
    const { licence_nmbr, serial_old, serial_new, client_descr } = params;
    // -------------------------------------------------------------------------
    // Passo 1: busca a placa
    // -------------------------------------------------------------------------
    console.log(`[resolver] MAINT_WITH_SWAP: buscando placa licence_nmbr="${licence_nmbr}"`);
    const plateRecords = await (0, html5Client_1.vhclsQueryByPlate)(licence_nmbr);
    const plateRecord = plateRecords.find((r) => r.licence_nmbr.trim().toUpperCase() === licence_nmbr.trim().toUpperCase()) || null;
    if (!plateRecord) {
        return {
            status: "ERROR_PLATE_NOT_FOUND",
            error_message: "Placa incorreta ou inexistente",
            resolution_path: "PLATE_NOT_FOUND",
        };
    }
    console.log(`[resolver] placa encontrada vehicle_id=${plateRecord.vehicle_id} inner_id="${plateRecord.inner_id}"`);
    // -------------------------------------------------------------------------
    // Passo 2: valida coerência da placa
    // -------------------------------------------------------------------------
    let vehicle_id_final;
    let serial_old_found;
    if ((0, html5Client_1.isEmptyInnerId)(plateRecord.inner_id)) {
        // Placa sem serial instalado — aceita qualquer serial_old
        vehicle_id_final = plateRecord.vehicle_id;
        serial_old_found = "";
    }
    else if ((0, html5Client_1.serialsMatch)(plateRecord.inner_id, serial_old)) {
        // Placa bate com o serial antigo informado
        vehicle_id_final = plateRecord.vehicle_id;
        serial_old_found = plateRecord.inner_id;
    }
    else {
        console.log(`[resolver] placa inner_id="${plateRecord.inner_id}" não bate com serial_old="${serial_old}"`);
        return {
            status: "ERROR_PLATE_INVALID",
            error_message: "Placa incorreta ou inexistente",
            resolution_path: "PLATE_SERIAL_MISMATCH",
        };
    }
    // -------------------------------------------------------------------------
    // Passo 3: valida disponibilidade do serial_new (ANTES de qualquer ação)
    // -------------------------------------------------------------------------
    console.log(`[resolver] MAINT_WITH_SWAP: validando serial_new="${serial_new}"`);
    let needs_uninstall_cmdt = false;
    const newSerialRecords = await (0, html5Client_1.vhclsQueryBySerial)(serial_new);
    const newSerialRecord = newSerialRecords.find((r) => (0, html5Client_1.serialsMatch)(r.inner_id, serial_new)) || null;
    if (newSerialRecord) {
        console.log(`[resolver] serial_new encontrado: vehicle_id=${newSerialRecord.vehicle_id} licence_nmbr="${newSerialRecord.licence_nmbr}"`);
        if ((0, html5Client_1.serialsMatch)(newSerialRecord.inner_id, newSerialRecord.licence_nmbr)) {
            // Serial disponível para reaproveitamento
        }
        else if (newSerialRecord.licence_nmbr.trim().toUpperCase() === "CMDT") {
            // Precisará de uninstall_cmdt
            needs_uninstall_cmdt = true;
        }
        else {
            // Serial em uso
            return {
                status: "ERROR_SERIAL_NEW_ALREADY_USED",
                error_message: "Serial novo já está em uso em outro veículo",
                resolution_path: "SERIAL_NEW_IN_USE",
            };
        }
    }
    // se newSerialRecord === null: serial_new não existe no sistema → disponível
    // -------------------------------------------------------------------------
    // Passo 4: valida cliente
    // -------------------------------------------------------------------------
    const client_descr_current = plateRecord.client_descr;
    const client_id_current = plateRecord.client_id;
    const client_mismatch = client_descr_current.trim().toUpperCase() !== client_descr.trim().toUpperCase();
    if (client_mismatch) {
        console.log(`[resolver] client_mismatch: atual="${client_descr_current}" informado="${client_descr}"`);
    }
    return {
        status: "OK",
        vehicle_id_final,
        serial_old_found,
        client_descr_current,
        client_id_current,
        client_mismatch,
        needs_uninstall_cmdt,
        resolution_path: (0, html5Client_1.isEmptyInnerId)(plateRecord.inner_id) ? "PLATE_EMPTY" : "PLATE_SERIAL_MATCH",
    };
}
