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

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[rewrite] servidor HTTP ouvindo na porta ${PORT}`);
});

export default app;

// ── inline workers ──────────────────────────────────────────────────────────
if (!process.env.API_BASE_URL) process.env.API_BASE_URL = "http://localhost:" + (process.env.PORT || "3000");
if (!process.env.WORKER_KEY)   process.env.WORKER_KEY   = "inline";
import("./worker/install/installWorker.js").catch(e => console.error("[index] installWorker falhou:", e));
