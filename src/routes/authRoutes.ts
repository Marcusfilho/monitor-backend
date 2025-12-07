// src/routes/authRoutes.ts
import { Router } from "express";
import { getTraffiToken } from "../services/tokenCache";

const router = Router();

/**
 * GET /api/auth/token
 * Devolve um token válido (usando cache).
 */
router.get("/token", async (_req, res) => {
  try {
    const tokenInfo = await getTraffiToken();

    res.json({
      status: "ok",
      accessToken: tokenInfo.accessToken,
      expiresInSeconds: tokenInfo.expiresInSeconds
      // se quiser incluir o raw: tokenInfo.raw,
      // é só adicionar aqui (eu deixei de fora pra não vazar info demais)
    });
  } catch (err: any) {
    console.error("Erro ao obter token:", err?.message || err);

    res.status(500).json({
      status: "error",
      message: "Falha ao obter token",
      details: err?.message || "Erro desconhecido"
    });
  }
});

export default router;
