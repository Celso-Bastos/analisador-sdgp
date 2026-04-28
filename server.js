// server.js
require("dotenv").config();

const express   = require("express");
const cors      = require("cors");
const helmet    = require("helmet");
const rateLimit = require("express-rate-limit");
const apiRoutes = require("./src/routes/api");
const { verificarJWT } = require("./src/middleware/auth");

const app      = express();
const PORT     = process.env.PORT     || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";

// ── VALIDAÇÃO DE VARIÁVEIS OBRIGATÓRIAS ───────────────────────────────────────
const VARS_OBRIGATORIAS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "JWT_SECRET",
  "EMAILS_AUTORIZADOS",
];
const ausentes = VARS_OBRIGATORIAS.filter(v => !process.env[v]);
if (ausentes.length > 0) {
  console.error(`\n❌ Variáveis de ambiente ausentes: ${ausentes.join(", ")}`);
  console.error("   Configure o .env antes de iniciar.\n");
  process.exit(1);
}

// ── TRUST PROXY (obrigatório no Render) ───────────────────────────────────────
app.set("trust proxy", 1);

// ── SEGURANÇA — HELMET ────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({ origin: true }));

// ── BODY PARSER ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: false, limit: "20mb" }));

// ── RATE LIMIT GLOBAL ─────────────────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, erros: ["Muitas requisições. Aguarde e tente novamente."] },
}));

// ── RATE LIMIT — /api/analisar ────────────────────────────────────────────────
app.use("/api/analisar", rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, erros: ["Muitas análises em pouco tempo. Aguarde 1 minuto."] },
}));

// ── RATE LIMIT — /api/ocr ─────────────────────────────────────────────────────
app.use("/api/ocr", rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, erros: ["Muitos uploads em pouco tempo. Aguarde 1 minuto."] },
}));

// ── RATE LIMIT — /api/auth ────────────────────────────────────────────────────
app.use("/api/auth", rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, erros: ["Muitas tentativas de login. Aguarde 15 minutos."] },
}));

// ── STATIC ────────────────────────────────────────────────────────────────────
app.use(express.static("public"));

// ── AUTENTICAÇÃO JWT + ROTAS ──────────────────────────────────────────────────
app.use("/api", verificarJWT, apiRoutes);

// ── ERROR HANDLER GLOBAL ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("[Erro global]", err.message);
  res.status(500).json({ ok: false, erros: ["Erro interno do servidor."] });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ ok: false, erros: ["Rota não encontrada."] });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🐟 Analisador SDGP rodando`);
  console.log(`   Ambiente  : ${NODE_ENV}`);
  console.log(`   Porta     : ${PORT}`);
  console.log(`   Auth      : Google OAuth 2.0`);
  console.log(`   Autorizado: ${process.env.EMAILS_AUTORIZADOS}`);
  console.log(`   Health    : http://localhost:${PORT}/api/health\n`);
});