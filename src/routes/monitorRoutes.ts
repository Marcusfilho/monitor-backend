// src/routes/monitorRoutes.ts
import { Router } from "express";
import { assignFirmware, AssignFirmwarePayload } from "../services/monitorService";

const router = Router();

/**
 * POST /api/monitor/assign-firmware
 * Exemplo de payload:
 * {
 *   "clientId": 37,
 *   "vehicleId": 1940478,
 *   "serial": "913018234",
 *   "firmwareId": 2681,
 *   "firmwareHex": "0A79.35",
 *   "requestedBy": "Marcus_Prod"
 * }
 */
router.post("/assign-firmware", async (req, res) => {
  const body = req.body as Partial<AssignFirmwarePayload>;

  if (!body.clientId || !body.vehicleId || !body.firmwareId) {
    return res.status(400).json({
      status: "error",
      message:
        "Campos obrigatórios: clientId, vehicleId, firmwareId (serial e firmwareHex opcionais)."
    });
  }

  try {
    const result = await assignFirmware(body as AssignFirmwarePayload);
    const httpStatus = result.status === "ok" ? 200 : 502;

    res.status(httpStatus).json(result);
  } catch (err: any) {
    console.error("[POST /api/monitor/assign-firmware] Erro inesperado:", err);
    res.status(500).json({
      status: "error",
      message: "Erro interno ao processar comando de firmware."
    });
  }
});

export default router;
