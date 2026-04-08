"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createJob = createJob;
exports.getNextJob = getNextJob;
exports.completeJob = completeJob;
exports.updateJob = updateJob;
exports.getJob = getJob;
exports.listJobs = listJobs;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// === PERSIST_JOBS_V1 ===
// Objetivo: evitar perder jobs em caso de restart do processo (Render), mantendo em arquivo.
// Observação: não substitui um DB/queue real; é um "best effort" para a fase V1.
const STORE_PATH = process.env.JOBS_STORE_PATH || "/tmp/jobs_store.json";
let jobs = [];
let loaded = false;
function safeParseJobs(raw) {
    try {
        const data = JSON.parse(String(raw || "").trim() || "null");
        if (!Array.isArray(data))
            return [];
        return data
            .filter((j) => j && typeof j === "object")
            .map((j) => ({
            id: String(j.id || ""),
            type: String(j.type || ""),
            status: String(j.status || "pending"),
            payload: j.payload,
            result: j.result,
            workerId: (j.workerId == null ? null : String(j.workerId)),
            createdAt: String(j.createdAt || new Date().toISOString()),
            updatedAt: String(j.updatedAt || new Date().toISOString()),
        }))
            .filter((j) => j.id && j.type);
    }
    catch {
        return [];
    }
}
function loadOnce() {
    if (loaded)
        return;
    loaded = true;
    try {
        if (fs_1.default.existsSync(STORE_PATH)) {
            const raw = fs_1.default.readFileSync(STORE_PATH, "utf8");
            jobs = safeParseJobs(raw);
        }
    }
    catch {
        jobs = jobs || [];
    }
}
function save() {
    try {
        const dir = path_1.default.dirname(STORE_PATH);
        if (dir && !fs_1.default.existsSync(dir))
            fs_1.default.mkdirSync(dir, { recursive: true });
        const tmp = `${STORE_PATH}.tmp`;
        fs_1.default.writeFileSync(tmp, JSON.stringify(jobs, null, 2), "utf8");
        fs_1.default.renameSync(tmp, STORE_PATH);
    }
    catch {
        // best effort
    }
}
// === /PERSIST_JOBS_V1 ===
function generateId() {
    return crypto_1.default.randomBytes(8).toString("hex");
}
function createJob(typeOrJob, maybePayload) {
    loadOnce();
    const now = new Date().toISOString();
    let type;
    let payload;
    if (typeOrJob && typeof typeOrJob === "object") {
        type = String(typeOrJob.type || "").trim();
        payload = typeOrJob.payload;
    }
    else {
        type = String(typeOrJob || "").trim();
        payload = maybePayload;
    }
    if (!type) {
        throw new Error("missing_type");
    }
    const job = {
        id: generateId(),
        type,
        status: "pending",
        payload,
        workerId: null,
        createdAt: now,
        updatedAt: now,
    };
    jobs.push(job);
    save();
    return job;
}
function getNextJob(type, workerId) {
    loadOnce();
    const job = jobs.find((j) => j.type === type && j.status === "pending");
    if (!job)
        return null;
    job.status = "processing";
    job.workerId = workerId;
    job.updatedAt = new Date().toISOString();
    save();
    return job;
}
function completeJob(id, status, result, workerId) {
    loadOnce();
    const job = jobs.find((j) => j.id === id);
    if (!job)
        return null;
    job.status = status;
    job.result = result;
    job.updatedAt = new Date().toISOString();
    if (workerId)
        job.workerId = workerId;
    save();
    return job;
}
function updateJob(id, patch) {
    loadOnce();
    const job = jobs.find((j) => j.id === id);
    if (!job)
        return null;
    Object.assign(job, patch);
    job.updatedAt = new Date().toISOString();
    save();
    return job;
}
function getJob(id) {
    loadOnce();
    return jobs.find((j) => j.id === id) || null;
}
function listJobs() {
    loadOnce();
    return jobs;
}
