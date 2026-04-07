// src/routes/clientRoutes.ts
// GET /api/clients — retorna lista de clientes disponíveis na sessão HTML5.
// Usado pelo frontend para exibir nomes reais dos clientes (evita divergência com o JSON local).

import { Router } from "express";
import { clientsQuery } from "../services/html5Client";

const router = Router();

/**
 * GET /api/clients
 *
 * Resposta:
 * {
 *   "status": "ok",
 *   "clients": [
 *     { "client_id": 219007, "client_descr": "Rápido Araguaia", "default_group_name": "Rápido Araguaia" },
 *     ...
 *   ]
 * }
 *
 * Em caso de sessão expirada, retorna lista vazia (não erro) — o frontend
 * usa o JSON local como fallback silencioso.
 */
router.get("/", async (_req, res) => {
  try {
    const clients = await clientsQuery();

    if (clients.length === 0) {
      // Sessão provavelmente expirada — retorna vazio para o frontend usar fallback
      console.warn("[GET /api/clients] Lista vazia — sessão HTML5 pode estar expirada");
      return res.json({ status: "ok", clients: [], warning: "session_may_be_expired" });
    }

    console.log(`[GET /api/clients] ${clients.length} clientes retornados`);
    return res.json({ status: "ok", clients });

  } catch (err: any) {
    console.error("[GET /api/clients] Erro:", err?.message || err);
    // Retorna vazio — frontend usa JSON como fallback, não trava o usuário
    return res.json({ status: "ok", clients: [], warning: "fetch_error", detail: err?.message });
  }
});

export default router;
