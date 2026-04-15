// src/routes/api.js
const express = require("express");
const router = express.Router();
const { analisar } = require("../controllers/analisarController");
const { extrairTexto } = require("../controllers/ocrController");

// Health check
router.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    timestamp: new Date().toISOString(),
    versao: "1.0.0",
  });
});

// OCR — extrai texto de imagem ou PDF enviado em base64
router.post("/ocr", extrairTexto);

// Análise principal
router.post("/analisar", analisar);

module.exports = router;