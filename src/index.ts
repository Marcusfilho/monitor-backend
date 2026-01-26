import express from "express";
import schemeBuilderRoutes from "./routes/schemeBuilderRoutes";
import adminRoutes from "./routes/adminRoutes";
import workerSessionTokenRoutes from "./routes/workerSessionTokenRoutes";
import authRoutes from "./routes/authRoutes";
import monitorRoutes from "./routes/monitorRoutes";
import jobRoutes from "./routes/jobRoutes";
import adminCatalogRoutes from "./routes/adminCatalogRoutes";

import { initSessionTokenStore } from "./services/sessionTokenStore";
import { migrateIfNeeded } from "./db/migrate";
import cors from "cors";


const app = express();

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  res.header("Vary", "Origin");
  next();
});

const corsMw = cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl/postman
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked origin=" + origin), false);
  },
  methods: ["GET","HEAD","PUT","PATCH","POST","DELETE","OPTIONS"],
  allowedHeaders: ["content-type","authorization","x-admin-key","x-worker-key"],
  maxAge: 86400,
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
app.use("/api/jobs", jobRoutes);
app.use("/api/scheme-builder", schemeBuilderRoutes);

app.use("/api/admin", adminRoutes);
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
