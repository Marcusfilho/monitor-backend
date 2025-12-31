"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const schemeBuilderRoutes_1 = __importDefault(require("./routes/schemeBuilderRoutes"));
const adminRoutes_1 = __importDefault(require("./routes/adminRoutes"));
const workerSessionTokenRoutes_1 = __importDefault(require("./routes/workerSessionTokenRoutes"));
const sessionTokenStore_1 = require("./services/sessionTokenStore");
const authRoutes_1 = __importDefault(require("./routes/authRoutes"));
const monitorRoutes_1 = __importDefault(require("./routes/monitorRoutes"));
const jobRoutes_1 = __importDefault(require("./routes/jobRoutes"));
const app = (0, express_1.default)();
const port = process.env.PORT || 3000;
app.use((0, cors_1.default)());
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
// Rotas existentes
app.use("/api/auth", authRoutes_1.default);
app.use("/api/monitor", monitorRoutes_1.default);
// NOVO: rotas de jobs
app.use("/api/jobs", jobRoutes_1.default);
// nova rota mais “amigável” para o app dos instaladores
app.use("/api/scheme-builder", schemeBuilderRoutes_1.default);
async function main() {
    await (0, sessionTokenStore_1.initSessionTokenStore)();
    app.use("/api/admin", adminRoutes_1.default);
    app.use("/api/worker", workerSessionTokenRoutes_1.default);
    const PORT = Number(process.env.PORT || 3000);
    app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
}
main().catch((err) => {
    console.error("[boot] failed:", err);
    process.exit(1);
});
exports.default = app;
