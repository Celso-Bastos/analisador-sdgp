// src/routes/api.js
const express  = require("express");
const router   = express.Router();
const { analisar }         = require("../controllers/analisarController");
const { extrairTexto }     = require("../controllers/ocrController");
const { iniciarLogin, callbackGoogle } = require("../middleware/auth");

// ── ROTAS PÚBLICAS ────────────────────────────────────────────────────────────

// Health check
router.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    timestamp: new Date().toISOString(),
    versao: "2.0.0",
  });
});

// Login Google — inicia o fluxo OAuth
router.get("/auth/google", iniciarLogin);

// Callback Google — recebe o code e gera JWT
router.get("/auth/google/callback", callbackGoogle);

// ── ROTAS PROTEGIDAS (exigem JWT via middleware no server.js) ─────────────────

// OCR — extrai texto de imagem ou PDF
router.post("/ocr", extrairTexto);

// Análise principal
router.post("/analisar", analisar);

module.exports = router;