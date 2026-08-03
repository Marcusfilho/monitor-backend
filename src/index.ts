import express from "express";
import path from "path";
import jobRoutes           from "./routes/jobRoutes";
import eventsRoutes        from "./routes/eventsRoutes";
import authRoutes          from "./routes/authRoutes";
import installationsRoutes from "./routes/installationsRoutes";
import { requireSession }  from "./middleware/requireSession";
import adminRoutes, { syncAssetTypesByClient, syncAssetTypes } from "./routes/adminRoutes";
import photoRoutes from "./routes/photoRoutes";
import { reclaimOrphans } from "./jobs/jobStore";
import { sweepSchemeVerify } from "./services/schemeVerifyService";

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "../public")));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "monitor-backend-rewrite", ts: new Date().toISOString() });
});

// ─── Rotas ────────────────────────────────────────────────────────────────────
app.use("/api/auth",          authRoutes);
app.use("/api/jobs", jobRoutes);
app.use("/api/installations", requireSession, installationsRoutes);
app.use("/events",            eventsRoutes);
app.use("/api/admin",         adminRoutes);
app.use("/api/photos",        requireSession, photoRoutes);

// ─── Sync asset_types_by_client — a cada 1h ───────────────────────────────────
const SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hora
function scheduleSyncByClient() {
  syncAssetTypesByClient()
    .then(() => console.log("[index] syncAssetTypesByClient OK"))
    .catch(e  => console.error("[index] syncAssetTypesByClient ERRO:", e.message));
}
// Primeira execução: 30s após o boot (aguarda workers subirem)
setTimeout(() => {
  scheduleSyncByClient();
  setInterval(scheduleSyncByClient, SYNC_INTERVAL_MS);
}, 30_000);

// ─── Sync asset_types_active (catálogo de modelos) — a cada 3h ────────────────
// Atualiza o catálogo que alimenta o dropdown E o realce por cliente. Como o
// catálogo muda, refaz o by-client em seguida para o realce refletir novos modelos.
const ASSET_TYPES_SYNC_MS = 3 * 60 * 60 * 1000; // 3 horas
async function scheduleSyncAssetTypes() {
  try {
    await syncAssetTypes();
    console.log("[index] syncAssetTypes OK");
    await syncAssetTypesByClient();
    console.log("[index] syncAssetTypesByClient (pós catálogo) OK");
  } catch (e: any) {
    console.error("[index] syncAssetTypes ERRO:", e.message);
  }
}
// Primeira execução: 45s após o boot (escalonado após o by-client de 30s)
setTimeout(() => {
  scheduleSyncAssetTypes();
  setInterval(scheduleSyncAssetTypes, ASSET_TYPES_SYNC_MS);
}, 45_000);

// ─── Reclaim de jobs órfãos — processing travado > 10min → pending ────────────
// Roda no boot (recupera jobs presos por restart) e a cada 2min (workers travados).
const ORPHAN_CHECK_MS = 2 * 60 * 1000; // 2min
function reclaimOrphanJobs() {
  try {
    const n = reclaimOrphans();
    if (n) console.log(`[index] reclaimOrphans: ${n} job(s) processing→pending`);
  } catch (e: any) {
    console.error("[index] reclaimOrphans ERRO:", e.message);
  }
}
reclaimOrphanJobs();
setInterval(reclaimOrphanJobs, ORPHAN_CHECK_MS);

// ─── SB_VERIFY_V1 — confere scheme atribuído, a cada 5min ────────────────────
// Fora do caminho do técnico: só varre serviços já finalizados (a linha do snapshot
// nasce no save_snapshot). Primeira execução 90s após o boot, escalonada depois
// dos syncs de asset_types (30s/45s).
const SB_VERIFY_MS = 5 * 60 * 1000; // 5min
function runSchemeVerify() {
  sweepSchemeVerify().catch((e: any) =>
    console.error("[index] sweepSchemeVerify ERRO:", e?.message || e),
  );
}
setTimeout(() => {
  runSchemeVerify();
  setInterval(runSchemeVerify, SB_VERIFY_MS);
}, 90_000);

// ─── Worker heartbeat (path raiz, fora do jobRoutes) ─────────────────────────
app.post("/api/worker/heartbeat", (req: any, res: any) => {
  const key = req.headers["x-worker-key"] || "";
  const expectedKey = process.env.WORKER_KEY || "";
  if (expectedKey && key !== expectedKey) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const { worker_id, checks } = req.body || {};
  if (checks && Object.values(checks).some((v: any) => v === false)) {
    console.warn(`[hb] worker=${worker_id} checks=${JSON.stringify(checks)}`);
  }
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[rewrite] servidor HTTP ouvindo na porta ${PORT}`);
});

export default app;

// ── inline workers ──────────────────────────────────────────────────────────
if (!process.env.API_BASE_URL) process.env.API_BASE_URL = "http://localhost:" + (process.env.PORT || "3000");
if (!process.env.WORKER_KEY)   process.env.WORKER_KEY   = "inline";
import("./worker/install/installWorker.js").catch(e => console.error("[index] installWorker falhou:", e));
import("./worker/gs/gsWorker.js").catch(e => console.error("[index] gsWorker falhou:", e));
import("./worker/sb/schemeBuilderWorker.js").catch(e => console.error("[index] schemeBuilderWorker falhou:", e));
import("./worker/can/canWorker.js").catch(e => console.error("[index] canWorker falhou:", e));
