import express from "express";
import cors from "cors";

const app = express();
const port = process.env.PORT || 3000;

// middlewares básicos
app.use(cors());
app.use(express.json());

// rota de teste
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "monitor-backend",
    timestamp: new Date().toISOString()
  });
});

app.listen(port, () => {
  console.log(`✅ monitor-backend rodando na porta ${port}`);
});
