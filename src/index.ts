// src/index.ts
import express from "express";
import cors from "cors";
import authRoutes from "./routes/authRoutes";
import monitorRoutes from "./routes/monitorRoutes";

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.send(
    "Monitor backend online. Use /health para status ou /api/... para as APIs."
  );
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "monitor-backend",
    timestamp: new Date().toISOString()
  });
});

// auth
app.use("/api/auth", authRoutes);

// monitor commands
app.use("/api/monitor", monitorRoutes);

app.listen(port, () => {
  console.log(`✅ monitor-backend rodando na porta ${port}`);
});
