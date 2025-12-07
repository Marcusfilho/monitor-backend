// src/routes/monitorRoutes.ts
import { Router } from "express";
import {
  assignFirmware,
  AssignFirmwarePayload
} from "../services/monitorService";
import {
  runSchemeBuilderBackend,
  SchemeBuilderParams
} from "../services/schemeBuilderService";

const router = Router();

/**
 * POST /api/monitor/assign-firmware
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

/**
 * POST /api/monitor/scheme-builder
 * Exemplo de body:
 * {
 *   "clientId": 218572,
 *   "clientName": "TRANSLIMA",
 *   "vehicleId": 1940478,
 *   "vehicleSettingId": 5592,
 *   "comment": "Comentário opcional"
 * }
 */
router.post("/scheme-builder", async (req, res) => {
  const body = req.body as Partial<SchemeBuilderParams>;

  if (
    !body.clientId ||
    !body.clientName ||
    !body.vehicleId ||
    !body.vehicleSettingId
  ) {
    return res.status(400).json({
      status: "error",
      message:
        "Campos obrigatórios: clientId, clientName, vehicleId, vehicleSettingId."
    });
  }

  try {
    const result = await runSchemeBuilderBackend(body as SchemeBuilderParams);
    const httpStatus = result.status === "ok" ? 200 : 502;

    res.status(httpStatus).json(result);
  } catch (err: any) {
    console.error("[POST /api/monitor/scheme-builder] Erro inesperado:", err);
    res.status(500).json({
      status: "error",
      message: "Erro interno ao executar SchemeBuilder no backend."
    });
  }
});

export default router;
