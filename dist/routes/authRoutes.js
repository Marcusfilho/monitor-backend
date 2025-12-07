"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/authRoutes.ts
const express_1 = require("express");
const tokenCache_1 = require("../services/tokenCache");
const router = (0, express_1.Router)();
/**
 * GET /api/auth/token
 * Devolve um token válido (usando cache).
 */
router.get("/token", async (_req, res) => {
    try {
        const tokenInfo = await (0, tokenCache_1.getTraffiToken)();
        res.json({
            status: "ok",
            accessToken: tokenInfo.accessToken,
            expiresInSeconds: tokenInfo.expiresInSeconds
            // se quiser incluir o raw: tokenInfo.raw,
            // é só adicionar aqui (eu deixei de fora pra não vazar info demais)
        });
    }
    catch (err) {
        console.error("Erro ao obter token:", err?.message || err);
        res.status(500).json({
            status: "error",
            message: "Falha ao obter token",
            details: err?.message || "Erro desconhecido"
        });
    }
});
exports.default = router;
