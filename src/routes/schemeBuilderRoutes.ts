import { Router, Request, Response } from "express";
import { createJob, getJob } from "../jobs/jobStore";

const router = Router();

/**
 * POST /api/scheme-builder/start
 * Cria um job de Scheme Builder na fila
 */
router.post("/start", (req: Request, res: Response) => {
  const {
    clientId,
    clientName,
    vehicleId,
    vehicleSettingId,
    comment,
  } = req.body || {};

  if (!vehicleId || !vehicleSettingId) {
    return res
      .status(400)
      .json({ error: "Campos 'vehicleId' e 'vehicleSettingId' são obrigatórios." });
  }

  const payload = {
    clientId: clientId ?? null,
    clientName: clientName ?? null,
    vehicleId,
    vehicleSettingId,
    comment: comment ?? null,
  };

  const job = createJob("scheme_builder", payload);

  return res.status(201).json({
    jobId: job.id,
    job,
  });
});

/**
 * GET /api/scheme-builder/:id
 * Consulta status/resultado de um job
 */
router.get("/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const job = getJob(id);

  if (!job) {
    return res.status(404).json({ error: "Job não encontrado." });
  }

  return res.json({ job });
});

export default router;

