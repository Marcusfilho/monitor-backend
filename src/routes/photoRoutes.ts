// photoRoutes.ts — POST /api/photos/upload
// Recebe multipart/form-data (multer memoryStorage, limite 15MB)
// Campos: photo (file), type, client_descr, plate, fleet (opcional)

import { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import { uploadInstallationPhoto, ALLOWED_PHOTO_TYPES, PhotoType } from "../services/sharepointPhotoUploader";

const router  = Router();
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const ALLOWED_SET = new Set<string>(ALLOWED_PHOTO_TYPES);

const MIME_EXT: Record<string, string> = {
  "image/jpeg"   : ".jpg",
  "image/png"    : ".png",
  "image/webp"   : ".webp",
  "image/heic"   : ".heic",
  "image/heif"   : ".heif",
};

router.post("/upload", upload.single("photo"), async (req: Request, res: Response) => {
  try {
    const type        = (req.body?.type        || "").trim();
    const clientDescr = (req.body?.client_descr|| "").trim();
    const plate       = (req.body?.plate       || "").trim().toUpperCase();
    const fleet       = (req.body?.fleet       || "").trim().toUpperCase();

    if (!type || !ALLOWED_SET.has(type)) {
      res.status(400).json({ ok: false, error: `tipo inválido: "${type}"` });
      return;
    }
    if (!clientDescr) {
      res.status(400).json({ ok: false, error: "client_descr obrigatório" });
      return;
    }
    if (!plate) {
      res.status(400).json({ ok: false, error: "plate obrigatório" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ ok: false, error: "arquivo obrigatório (campo: photo)" });
      return;
    }

    const mime = req.file.mimetype;
    const extFromName = path.extname(req.file.originalname || "") || ".jpg";
    const ext  = MIME_EXT[mime] ?? extFromName;

    const result = await uploadInstallationPhoto({
      type       : type as PhotoType,
      clientDescr,
      plate,
      fleet,
      buffer     : req.file.buffer,
      mimeType   : mime,
      ext,
    });

    res.json(result);
  } catch (err: any) {
    console.error("[photos] upload erro:", err?.message);
    res.status(502).json({ ok: false, error: err?.message ?? "erro ao enviar foto" });
  }
});

export default router;
