"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertHeartbeat = upsertHeartbeat;
exports.getAllHeartbeats = getAllHeartbeats;
const hbByWorker = new Map();
function upsertHeartbeat(hb) {
    hbByWorker.set(hb.worker_id, hb);
}
function getAllHeartbeats() {
    return Array.from(hbByWorker.values()).sort((a, b) => (a.worker_id > b.worker_id ? 1 : -1));
}
