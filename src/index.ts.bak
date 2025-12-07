// src/index.ts
import express from "express";
import cors from "cors";
import authRoutes from "./routes/authRoutes";

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// rota raiz opcional (pra não dar "Cannot GET /")
app.get("/", (_req, res) => {
  res.send(
    "Monitor backend online. Use /health para status ou /api/... para as APIs."
  );
});

// healthcheck
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "monitor-backend",
    timestamp: new Date().toISOString()
  });
});

// rotas de autenticação
app.use("/api/auth", authRoutes);

app.listen(port, () => {
  console.log(`✅ monitor-backend rodando na porta ${port}`);
});
