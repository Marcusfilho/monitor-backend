import express from "express";
import schemeBuilderRoutes from "./routes/schemeBuilderRoutes";
import adminRoutes from "./routes/adminRoutes";
import workerSessionTokenRoutes from "./routes/workerSessionTokenRoutes";
import { workerRoutes } from "./routes/workerRoutes";
import authRoutes from "./routes/authRoutes";
import monitorRoutes from "./routes/monitorRoutes";
import jobRoutes from "./routes/jobRoutes";
import adminCatalogRoutes from "./routes/adminCatalogRoutes";

import installationsRoutes from "./routes/installationsRoutes";
import { initSessionTokenStore } from "./services/sessionTokenStore";
import { migrateIfNeeded } from "./db/migrate";
import cors from "cors";


import fs from "fs";
import path from "path";
const app = express();


// === APP_INSTALLATIONS_V1_UI (same-origin, sem CORS) ===
(function mountAppV1Ui() {
  try {
    const candidates = [
      path.join(process.cwd(), "public"),
      path.join(process.cwd(), "dist", "public"),
      // quando compilado, __dirname vira dist/
      path.join(__dirname, "public"),
      path.join(__dirname, "..", "public"),
    ];

    const pick = candidates.find(d =>
      fs.existsSync(d) && fs.existsSync(path.join(d, "app_installations_v1.html"))
    );

    app.get("/app/__health", (req, res) => {
      const data = {
        ok: !!pick,
        picked: pick || null,
        candidates,
        fileExists: pick ? fs.existsSync(path.join(pick, "app_installations_v1.html")) : false,
      };
      res.status(pick ? 200 : 404).json(data);
    });

    if (pick) {
      app.use("/app", express.static(pick));
      app.get("/app", (req, res) => res.redirect("/app/app_installations_v1.html"));
    }
  } catch (e) {
    try {
      app.get("/app/__health", (req, res) => res.status(500).json({ ok:false, error: String(e) }));
    } catch(_) {}
  }
})();

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  res.header("Vary", "Origin");
  next();
});

const corsMw = cors((req, cb) => {
  // cors types: req é CorsRequest (tem `headers`, não tem `.header()`)
  const h: any = (req as any).headers || {};
  const pick1 = (v: any) => Array.isArray(v) ? v[0] : v;

  const origin = pick1(h["origin"]);
  const host = pick1(h["host"]);
  const xfp = pick1(h["x-forwarded-proto"]);
  const proto = String(xfp || "https").split(",")[0].trim();

  const sameOrigin = !!(origin && host && origin === `${proto}://${host}`);
  const ok = (!origin) || sameOrigin || allowedOrigins.includes(String(origin));

  const opts = {
    origin: ok ? true : false,
    methods: ["GET","HEAD","PUT","PATCH","POST","DELETE","OPTIONS"],
    allowedHeaders: ["content-type","authorization","x-admin-key","x-worker-key"],
    maxAge: 86400,
  };

  if (ok) return cb(null, opts);
  return cb(new Error("CORS blocked origin=" + origin), opts);
});
// --- CORS FIRST ---
app.options(/.*/, corsMw);
app.use(corsMw);
// Express/router aqui quebra com "*", então usamos regex:
// Parser antes das rotas
app.use(express.json());

// Healthcheck
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "monitor-backend",
    timestamp: new Date().toISOString(),
    git_commit: process.env.RENDER_GIT_COMMIT || null,
    git_branch: process.env.RENDER_GIT_BRANCH || null,
  });
});

// Rotas
app.use("/api/admin/catalogs", adminCatalogRoutes);

app.use("/api/auth", authRoutes);
app.use("/api/monitor", monitorRoutes);
app.use("/api/installations", installationsRoutes);
app.use("/api/jobs", jobRoutes);
app.use("/api/scheme-builder", schemeBuilderRoutes);

app.use("/api/admin", adminRoutes);
app.use("/api/worker", workerRoutes);
app.use("/api/worker", workerSessionTokenRoutes);

async function main() {
  await initSessionTokenStore();

  // Em dev, deixa subir sem DB (pra testar CORS e front).
  // Em prod, mantém fail-fast.
  const isProd = (process.env.NODE_ENV || "").toLowerCase() === "production";
  if (!process.env.DATABASE_URL) {
    if (isProd) throw new Error("DATABASE_URL is not set");
    console.warn("[dev] DATABASE_URL is not set; skipping migrations");
  } else {
    await migrateIfNeeded();
  }

  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
}

main().catch((err) => {
  console.error("[boot] failed:", err);
  process.exit(1);
});

export default app;
