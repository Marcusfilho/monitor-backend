"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const app = (0, express_1.default)();
const port = process.env.PORT || 3000;
// middlewares básicos
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// rota de teste
app.get("/health", (_req, res) => {
    res.json({
        status: "ok",
        service: "monitor-backend",
        timestamp: new Date().toISOString()
    });
});
app.listen(port, () => {
    console.log(`✅ monitor-backend rodando na porta ${port}`);
});
