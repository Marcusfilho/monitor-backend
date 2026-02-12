"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const schemeBuilderRoutes_1 = __importDefault(require("./routes/schemeBuilderRoutes"));
const adminRoutes_1 = __importDefault(require("./routes/adminRoutes"));
const workerSessionTokenRoutes_1 = __importDefault(require("./routes/workerSessionTokenRoutes"));
const workerRoutes_1 = require("./routes/workerRoutes");
const authRoutes_1 = __importDefault(require("./routes/authRoutes"));
const monitorRoutes_1 = __importDefault(require("./routes/monitorRoutes"));
const jobRoutes_1 = __importDefault(require("./routes/jobRoutes"));
const installationsRoutes_1 = __importDefault(require("./routes/installationsRoutes"));
const adminCatalogRoutes_1 = __importDefault(require("./routes/adminCatalogRoutes"));
const sessionTokenStore_1 = require("./services/sessionTokenStore");
const migrate_1 = require("./db/migrate");
const cors_1 = __importDefault(require("cors"));
const path = require("path");
const installationsEngine = require("./services/installationsEngine");
const app = (0, express_1.default)();
// APP V1 — wire enqueue via loopback POST /api/jobs
if (!globalThis.__APPV1_INSTALL_ENGINE_WIRED) {
  globalThis.__APPV1_INSTALL_ENGINE_WIRED = true;
  const __instBase = () => {
    const port = process.env.PORT || process.env.RENDER_INTERNAL_PORT || 3000;
    return `http://127.0.0.1:${port}`;
  };
  installationsEngine.setEnqueueJob(async ({ type, payload }) => {
    const r = await fetch(__instBase() + "/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, payload })
    });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch (_) { j = { raw: t }; }
    if (!r.ok) {
      const e = new Error("enqueue_failed");
      e.details = { status: r.status, body: j };
      throw e;
    }
    return j;
  });
}
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
app.use((req, res, next) => {
    res.header("Vary", "Origin");
    next();
});
const corsMw = (0, cors_1.default)({
    origin: (origin, cb) => {
  // APP V1 — allow local dev origins (CORS) v2
  if (process.env.NODE_ENV !== "production") {
    try {
      if (!origin) return cb(null, true);
      const o = String(origin);
      if (o.indexOf("127.0.0.1") !== -1 || o.indexOf("localhost") !== -1) return cb(null, true);
    } catch (_) {}
  }


        if (!origin)
            return cb(null, true); // curl/postman
        if (allowedOrigins.includes(origin))
            return cb(null, true);
        // allow local dev origins
        if (origin && /^https?:\/\/(127\.0\.0\.1|localhost)(:\\d+)?$/.test(origin)) return cb(null, true);
        return cb(new Error("CORS blocked origin=" + origin), false);
    },
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "x-admin-key", "x-worker-key", "x-installation-token"],
    maxAge: 86400,
});
// --- CORS FIRST ---
app.options(/.*/, corsMw);
app.use(corsMw);
// Express/router aqui quebra com "*", então usamos regex:
// Parser antes das rotas
app.use(express_1.default.json());
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
app.use("/api/admin/catalogs", adminCatalogRoutes_1.default);
app.use("/api/auth", authRoutes_1.default);
app.use("/api/monitor", monitorRoutes_1.default);
app.use("/api/jobs", jobRoutes_1.default);
app.use("/api/installations", installationsRoutes_1.default);
app.use("/app", express_1.default.static(path.join(__dirname, "public")));
app.use("/api/scheme-builder", schemeBuilderRoutes_1.default);
app.use("/api/admin", adminRoutes_1.default);
app.use("/api/worker", workerRoutes_1.workerRoutes);
app.use("/api/worker", workerSessionTokenRoutes_1.default);
async function main() {
    await (0, sessionTokenStore_1.initSessionTokenStore)();
    // Em dev, deixa subir sem DB (pra testar CORS e front).
    // Em prod, mantém fail-fast.
    const isProd = (process.env.NODE_ENV || "").toLowerCase() === "production";
    if (!process.env.DATABASE_URL) {
        if (isProd)
            throw new Error("DATABASE_URL is not set");
        console.warn("[dev] DATABASE_URL is not set; skipping migrations");
    }
    else {
        await (0, migrate_1.migrateIfNeeded)();
    }
    const PORT = Number(process.env.PORT || 3000);
    app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
}
main().catch((err) => {
    console.error("[boot] failed:", err);
    process.exit(1);
});
exports.default = app;
