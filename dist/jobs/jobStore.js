"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createJob = createJob;
exports.getNextJob = getNextJob;
exports.completeJob = completeJob;
exports.getJob = getJob;
exports.listJobs = listJobs;
const crypto_1 = __importDefault(require("crypto"));
const jobs = [];
function generateId() {
    return crypto_1.default.randomBytes(8).toString("hex");
}
function createJob(typeOrJob, maybePayload) {
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
    return job;
}
function getNextJob(type, workerId) {
    const job = jobs.find((j) => j.type === type && j.status === "pending");
    if (!job)
        return null;
    job.status = "processing";
    job.workerId = workerId;
    job.updatedAt = new Date().toISOString();
    return job;
}
function completeJob(id, status, result, workerId) {
    const job = jobs.find((j) => j.id === id);
    if (!job)
        return null;
    job.status = status;
    job.result = result;
    job.updatedAt = new Date().toISOString();
    if (workerId)
        job.workerId = workerId;
    return job;
}
function getJob(id) {
    return jobs.find((j) => j.id === id) || null;
}
function listJobs() {
    return jobs;
}
