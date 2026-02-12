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
const adminCatalogRoutes_1 = __importDefault(require("./routes/adminCatalogRoutes"));
const sessionTokenStore_1 = require("./services/sessionTokenStore");
const migrate_1 = require("./db/migrate");
const cors_1 = __importDefault(require("cors"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const app = (0, express_1.default)();
// === APP_INSTALLATIONS_V1_UI (same-origin, sem CORS) ===
(function mountAppV1Ui() {
    try {
        const candidates = [
            path_1.default.join(process.cwd(), "public"),
            path_1.default.join(process.cwd(), "dist", "public"),
            // quando compilado, __dirname vira dist/
            path_1.default.join(__dirname, "public"),
            path_1.default.join(__dirname, "..", "public"),
        ];
        const pick = candidates.find(d => fs_1.default.existsSync(d) && fs_1.default.existsSync(path_1.default.join(d, "app_installations_v1.html")));
        app.get("/app/__health", (req, res) => {
            const data = {
                ok: !!pick,
                picked: pick || null,
                candidates,
                fileExists: pick ? fs_1.default.existsSync(path_1.default.join(pick, "app_installations_v1.html")) : false,
            };
            res.status(pick ? 200 : 404).json(data);
        });
        if (pick) {
            app.use("/app", express_1.default.static(pick));
            app.get("/app", (req, res) => res.redirect("/app/app_installations_v1.html"));
        }
    }
    catch (e) {
        try {
            app.get("/app/__health", (req, res) => res.status(500).json({ ok: false, error: String(e) }));
        }
        catch (_) { }
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
const corsMw = (0, cors_1.default)({
    origin: (origin, cb) => {
        if (!origin)
            return cb(null, true); // curl/postman
        if (allowedOrigins.includes(origin))
            return cb(null, true);
        return cb(new Error("CORS blocked origin=" + origin), false);
    },
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "x-admin-key", "x-worker-key"],
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
