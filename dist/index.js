"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/index.ts
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const authRoutes_1 = __importDefault(require("./routes/authRoutes"));
const monitorRoutes_1 = __importDefault(require("./routes/monitorRoutes"));
const app = (0, express_1.default)();
const port = process.env.PORT || 3000;
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.get("/", (_req, res) => {
    res.send("Monitor backend online. Use /health para status ou /api/... para as APIs.");
});
app.get("/health", (_req, res) => {
    res.json({
        status: "ok",
        service: "monitor-backend",
        timestamp: new Date().toISOString()
    });
});
// auth
app.use("/api/auth", authRoutes_1.default);
// monitor commands
app.use("/api/monitor", monitorRoutes_1.default);
app.listen(port, () => {
    console.log(`✅ monitor-backend rodando na porta ${port}`);
});
