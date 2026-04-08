"use strict";
// src/services/html5Client.ts
// Cliente HTTP reutilizável para o HTML5 do Traffilog.
// Não depende do WebSocket — usa cookie jar salvo em disco.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.readHtml5Cookie = readHtml5Cookie;
exports.html5Post = html5Post;
exports.vhclsQueryByPlate = vhclsQueryByPlate;
exports.vhclsQueryBySerial = vhclsQueryBySerial;
exports.isEmptyInnerId = isEmptyInnerId;
exports.normalizeSerial = normalizeSerial;
exports.serialsMatch = serialsMatch;
exports.clientsQuery = clientsQuery;
const fs = __importStar(require("fs"));
const https = __importStar(require("https"));
const HTML5_ACTION_URL = (process.env.HTML5_ACTION_URL || "https://html5.traffilog.com/AppEngine_2_1/default.aspx").trim();
const HTML5_COOKIEJAR_PATH = (process.env.HTML5_COOKIEJAR_PATH || "/tmp/html5_cookiejar.json").trim();
const HTML5_TIMEOUT_MS = Number(process.env.HTML5_TIMEOUT_MS || "10000");
// ---------------------------------------------------------------------------
// Cookie jar
// ---------------------------------------------------------------------------
function readHtml5Cookie() {
    try {
        if (!fs.existsSync(HTML5_COOKIEJAR_PATH))
            return "";
        const raw = fs.readFileSync(HTML5_COOKIEJAR_PATH, "utf8").trim();
        if (!raw)
            return "";
        let j = null;
        try {
            j = JSON.parse(raw);
        }
        catch {
            return raw;
        }
        if (!j)
            return "";
        if (typeof j === "string")
            return j.trim();
        if (typeof j.cookieHeader === "string")
            return j.cookieHeader.trim();
        if (typeof j.cookie === "string")
            return j.cookie.trim();
        return "";
    }
    catch {
        return "";
    }
}
// ---------------------------------------------------------------------------
// HTTP POST genérico ao HTML5
// ---------------------------------------------------------------------------
function html5Post(bodyParams) {
    return new Promise((resolve, reject) => {
        try {
            const bodyStr = Object.entries(bodyParams)
                .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
                .join("&");
            const body = Buffer.from(bodyStr, "utf8");
            const cookieHeader = readHtml5Cookie();
            const headers = {
                "content-type": "application/x-www-form-urlencoded",
                "content-length": String(body.length),
                "accept": "*/*",
                "origin": "https://html5.traffilog.com",
                "referer": "https://html5.traffilog.com/appv2/index.htm",
            };
            if (cookieHeader)
                headers["cookie"] = cookieHeader;
            const u = new URL(HTML5_ACTION_URL);
            const req = https.request({
                protocol: u.protocol,
                hostname: u.hostname,
                port: u.port ? Number(u.port) : 443,
                path: (u.pathname || "/") + (u.search || ""),
                method: "POST",
                headers,
            }, (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(Buffer.from(c)));
                res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
                res.on("error", reject);
            });
            req.setTimeout(HTML5_TIMEOUT_MS, () => {
                req.destroy();
                reject(new Error(`[html5] timeout após ${HTML5_TIMEOUT_MS}ms`));
            });
            req.on("error", reject);
            req.write(body);
            req.end();
        }
        catch (e) {
            reject(e);
        }
    });
}
function parseVhclsXml(xml) {
    const records = [];
    // Extrai cada bloco <DATA .../>
    const dataRe = /<DATA\s([^>]*?)\/>/gi;
    let m;
    while ((m = dataRe.exec(xml)) !== null) {
        const attrs = m[1];
        function attr(name) {
            const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i");
            const hit = attrs.match(re);
            return hit ? hit[1].trim() : "";
        }
        const vehicleId = Number(attr("VEHICLE_ID"));
        if (!vehicleId)
            continue;
        // INNER_ID vem como "0000000913039454" quando tem serial,
        // ou ausente / vazio quando não tem serial instalado.
        const rawInnerId = attr("INNER_ID");
        records.push({
            vehicle_id: vehicleId,
            licence_nmbr: attr("LICENSE_NMBR"),
            inner_id: rawInnerId,
            client_id: Number(attr("CLIENT_ID")),
            client_descr: attr("CLIENT_DESCR"),
            unit_id: attr("UNIT_ID"),
        });
    }
    return records;
}
async function vhclsQueryByPlate(licenceNmbr) {
    const xml = await html5Post({
        REFRESH_FLG: "1",
        LICENSE_NMBR: licenceNmbr,
        CLIENT_DESCR: "",
        OWNER_DESCR: "",
        DIAL_NMBR: "",
        INNER_ID: "",
        action: "VHCLS",
        VERSION_ID: "2",
    });
    return parseVhclsXml(xml);
}
async function vhclsQueryBySerial(innerId) {
    const xml = await html5Post({
        REFRESH_FLG: "1",
        LICENSE_NMBR: "",
        CLIENT_DESCR: "",
        OWNER_DESCR: "",
        DIAL_NMBR: "",
        INNER_ID: innerId,
        action: "VHCLS",
        VERSION_ID: "2",
    });
    return parseVhclsXml(xml);
}
// ---------------------------------------------------------------------------
// Helpers de comparação
// ---------------------------------------------------------------------------
// inner_id "vazio" = ausente, "", ou só zeros
function isEmptyInnerId(v) {
    return !v || /^0+$/.test(v.trim());
}
// Normaliza serial para comparação: remove zeros à esquerda e espaços
function normalizeSerial(v) {
    return v.trim().replace(/^0+/, "") || "0";
}
function serialsMatch(a, b) {
    return normalizeSerial(a) === normalizeSerial(b);
}
function parseClientsXml(xml) {
    const records = [];
    // Tenta <CLIENT CLIENT_ID="..." CLIENT_DESCR="..." DEFAULT_GROUP_NAME="..." />
    const re = /<CLIENT\s([^>]*?)\/>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const attrs = m[1];
        function attr(name) {
            const hit = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
            return hit ? hit[1].trim() : "";
        }
        const clientId = Number(attr("CLIENT_ID"));
        if (!clientId)
            continue;
        records.push({
            client_id: clientId,
            client_descr: attr("CLIENT_DESCR"),
            default_group_name: attr("DEFAULT_GROUP_NAME"),
        });
    }
    return records;
}
async function clientsQuery() {
    const xml = await html5Post({
        REFRESH_FLG: "1",
        action: "CLIENTS",
        VERSION_ID: "2",
    });
    return parseClientsXml(xml);
}
