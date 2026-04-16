// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const apiRoutes = require("./src/routes/api");

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";

// ── 1. SEGURANÇA ──────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// ── 2. CORS ───────────────────────────────────
app.use(cors({ origin: true }));

// ── 3. BODY PARSER (ANTES de tudo que lê o body) ──
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: false, limit: "20mb" }));

// ── 4. RATE LIMITING GLOBAL ───────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, erros: ["Muitas requisições. Aguarde e tente novamente."] },
}));

// ── 5. RATE LIMITING ESPECÍFICO ───────────────
app.use("/api/analisar", rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { ok: false, erros: ["Muitas análises em pouco tempo. Aguarde 1 minuto."] },
}));

// ── 6. STATIC ─────────────────────────────────
app.use(express.static("public"));

// ── 7. ROTAS DA API ───────────────────────────  ← DEVE VIR ANTES DO 404
app.use("/api", apiRoutes);

// ── 8. ERRO GLOBAL (4 parâmetros = handler de erro) ──
app.use((err, req, res, next) => {
  console.error("[Erro global]", err.message);
  if (err.message?.startsWith("CORS:")) {
    return res.status(403).json({ ok: false, erros: [err.message] });
  }
  res.status(500).json({ ok: false, erros: ["Erro interno do servidor."] });
});

// ── 9. 404 (SEMPRE O ÚLTIMO) ──────────────────  ← PROBLEMA ESTAVA AQUI
app.use((req, res) => {
  res.status(404).json({ ok: false, erros: ["Rota não encontrada."] });
});

// ── START ─────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🐟 Analisador SDGP rodando`);
  console.log(`   Ambiente : ${NODE_ENV}`);
  console.log(`   Porta    : ${PORT}`);
  console.log(`   Health   : http://localhost:${PORT}/api/health\n`);
});