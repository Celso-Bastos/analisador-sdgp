// server.js
require("dotenv").config();

const express    = require("express");
const cors       = require("cors");
const helmet     = require("helmet");
const rateLimit  = require("express-rate-limit");
const apiRoutes  = require("./src/routes/api");

const app      = express();
const PORT     = process.env.PORT     || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";

// ── TRUST PROXY (obrigatório no Render) ───────────────────────────────────────
app.set("trust proxy", 1);

// ── SEGURANÇA — HELMET ────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({ origin: true }));

// ── BODY PARSER ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: false, limit: "20mb" }));

// ── RATE LIMIT GLOBAL (todas as rotas) ────────────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, erros: ["Muitas requisições. Aguarde e tente novamente."] },
}));

// ── RATE LIMIT ESPECÍFICO — /api/analisar ─────────────────────────────────────
// Máximo 3 análises por minuto por IP
app.use("/api/analisar", rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, erros: ["Muitas análises em pouco tempo. Aguarde 1 minuto."] },
}));

// ── RATE LIMIT ESPECÍFICO — /api/ocr ─────────────────────────────────────────
// Máximo 20 uploads por minuto por IP
app.use("/api/ocr", rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, erros: ["Muitos uploads em pouco tempo. Aguarde 1 minuto."] },
}));

// ── AUTENTICAÇÃO POR API KEY ──────────────────────────────────────────────────
// Protege todas as rotas /api exceto /api/health
// Configure ACCESS_KEY no .env — distribua apenas para usuários autorizados
//
// O cliente deve enviar o header: X-Access-Key: <valor do ACCESS_KEY>
//
function autenticar(req, res, next) {
  // Health check é público — não exige chave
  if (req.path === "/health") return next();

  const ACCESS_KEY = process.env.ACCESS_KEY;

  // Se ACCESS_KEY não estiver configurada, bloquear em produção, liberar em dev
  if (!ACCESS_KEY) {
    if (NODE_ENV === "production") {
      return res.status(500).json({ ok: false, erros: ["Servidor mal configurado — ACCESS_KEY ausente."] });
    }
    console.warn("[AUTH] ACCESS_KEY não configurada — modo development, acesso liberado.");
    return next();
  }

  const chaveEnviada = req.headers["x-access-key"];

  if (!chaveEnviada) {
    return res.status(401).json({ ok: false, erros: ["Acesso não autorizado — chave de acesso ausente."] });
  }

  // Comparação de tempo constante para evitar timing attacks
  if (!seguroIgual(chaveEnviada, ACCESS_KEY)) {
    console.warn(`[AUTH] Tentativa com chave inválida — IP: ${req.ip} — ${new Date().toISOString()}`);
    return res.status(401).json({ ok: false, erros: ["Acesso não autorizado — chave de acesso inválida."] });
  }

  next();
}

// Comparação em tempo constante — evita que um atacante descubra a chave
// medindo o tempo de resposta (timing attack)
function seguroIgual(a, b) {
  if (a.length !== b.length) return false;
  let resultado = 0;
  for (let i = 0; i < a.length; i++) {
    resultado |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return resultado === 0;
}

// ── STATIC + ROTAS ────────────────────────────────────────────────────────────
app.use(express.static("public"));

// Aplicar autenticação em todas as rotas /api
app.use("/api", autenticar, apiRoutes);

// ── ERROR HANDLER GLOBAL ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("[Erro global]", err.message);
  if (err.message?.startsWith("CORS:")) {
    return res.status(403).json({ ok: false, erros: [err.message] });
  }
  res.status(500).json({ ok: false, erros: ["Erro interno do servidor."] });
});

// ── 404 — SEMPRE O ÚLTIMO ─────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ ok: false, erros: ["Rota não encontrada."] });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🐟 Analisador SDGP rodando`);
  console.log(`   Ambiente  : ${NODE_ENV}`);
  console.log(`   Porta     : ${PORT}`);
  console.log(`   Auth      : ${process.env.ACCESS_KEY ? "✓ ACCESS_KEY configurada" : "⚠ ACCESS_KEY ausente"}`);
  console.log(`   Health    : http://localhost:${PORT}/api/health\n`);
});