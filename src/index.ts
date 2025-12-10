import express from "express";
import cors from "cors";

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
  });
});

// Rotas existentes
app.use("/api/auth", authRoutes);
app.use("/api/monitor", monitorRoutes);

// NOVO: rotas de jobs
app.use("/api/jobs", jobRoutes);

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

export default app;
