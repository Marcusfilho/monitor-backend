import express from "express";
import cors from "cors";
import schemeBuilderRoutes from "./routes/schemeBuilderRoutes";
import adminRoutes from "./routes/adminRoutes";
import { initSessionTokenStore } from "./services/sessionTokenStore";



import authRoutes from "./routes/authRoutes";
import monitorRoutes from "./routes/monitorRoutes";
import jobRoutes from "./routes/jobRoutes";

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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
app.use("/api/auth", authRoutes);
app.use("/api/monitor", monitorRoutes);

// NOVO: rotas de jobs
app.use("/api/jobs", jobRoutes);

// nova rota mais “amigável” para o app dos instaladores
app.use("/api/scheme-builder", schemeBuilderRoutes);

async function main() {
  await initSessionTokenStore();

  app.use("/api/admin", adminRoutes);

  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
}

main().catch((err) => {
  console.error("[boot] failed:", err);
  process.exit(1);
});


export default app;

