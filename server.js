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

// ── SEGURANÇA ─────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// ── CORS ──────────────────────────────────────
const origensPermitidas = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : [];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (origensPermitidas.includes("*")) return callback(null, true);
    if (origensPermitidas.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origem não permitida — ${origin}`));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

// ── RATE LIMITING ─────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, erros: ["Muitas requisições. Aguarde e tente novamente."] },
}));

app.use("/api/analisar", rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { ok: false, erros: ["Muitas análises em pouco tempo. Aguarde 1 minuto."] },
}));

// ── BODY PARSER ───────────────────────────────
// Aumentado para suportar upload de arquivos em base64
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: false, limit: "20mb" }));

// ── STATIC + ROTAS ────────────────────────────
app.use(express.static("public"));
app.use("/api", apiRoutes);

// ── ERROS GLOBAIS ─────────────────────────────
app.use((err, req, res, next) => {
  console.error("[Erro global]", err.message);
  if (err.message?.startsWith("CORS:")) {
    return res.status(403).json({ ok: false, erros: [err.message] });
  }
  res.status(500).json({ ok: false, erros: ["Erro interno do servidor."] });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, erros: ["Rota não encontrada."] });
});

// ── START ─────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🐟 Analisador SDGP rodando`);
  console.log(`   Ambiente : ${NODE_ENV}`);
  console.log(`   Porta    : ${PORT}`);
  console.log(`   URL      : http://localhost:${PORT}`);
  console.log(`   Health   : http://localhost:${PORT}/api/health\n`);
});

