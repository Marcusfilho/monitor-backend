import express from "express";
import path from "path";
import jobRoutes           from "./routes/jobRoutes";
import eventsRoutes        from "./routes/eventsRoutes";
import authRoutes          from "./routes/authRoutes";
import installationsRoutes from "./routes/installationsRoutes";
import { requireSession }  from "./middleware/requireSession";
import adminRoutes         from "./routes/adminRoutes";

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
