// src/controllers/ocrController.js
const Tesseract = require("tesseract.js");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

pdfjsLib.GlobalWorkerOptions.workerSrc = false;

async function extrairTexto(req, res) {
  const { base64, tipo } = req.body;

  if (!base64 || !tipo) {
    return res.status(400).json({ ok: false, erro: "base64 e tipo são obrigatórios." });
  }

  try {
    const buffer = Buffer.from(base64, "base64");
    let texto = "";

    if (tipo === "application/pdf") {
      texto = await extrairTextoPDF(buffer);
    } else if (tipo.startsWith("image/")) {
      texto = await extrairTextoImagem(buffer);
    } else {
      return res.status(400).json({ ok: false, erro: "Tipo não suportado. Use PDF ou imagem." });
    }

    if (!texto || texto.trim().length < 5) {
      return res.status(422).json({
        ok: false,
        erro: "Não foi possível extrair texto. Tente uma imagem mais nítida.",
      });
    }

    console.log("[OCR] Texto extraído:", texto.substring(0, 300));
    return res.json({ ok: true, texto: texto.trim() });

  } catch (err) {
    console.error("[OCR] Erro:", err.message);
    return res.status(500).json({ ok: false, erro: "Erro ao processar: " + err.message });
  }
}

// ── PDF ───────────────────────────────────────
async function extrairTextoPDF(buffer) {
  const uint8 = new Uint8Array(buffer);
  const pdf = await pdfjsLib.getDocument({
    data: uint8,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  let texto = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    texto += content.items.map((item) => item.str).join(" ") + "\n";
  }

  // PDF escaneado — renderiza em canvas e aplica OCR
  if (texto.trim().length < 20) {
    console.log("[OCR] PDF escaneado — renderizando páginas para OCR...");
    texto = await ocrarPaginasPDF(pdf);
  }

  return texto;
}

// Renderiza PDF em canvas Node.js e aplica Tesseract
async function ocrarPaginasPDF(pdf) {
  const { createCanvas } = require("canvas");
  let textoTotal = "";

  const totalPaginas = Math.min(pdf.numPages, 3);
  for (let i = 1; i <= totalPaginas; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
    const ctx = canvas.getContext("2d");

    await page.render({ canvasContext: ctx, viewport }).promise;

    const imgBuffer = canvas.toBuffer("image/png");
    const { data: { text } } = await Tesseract.recognize(imgBuffer, "por", {
      logger: () => {},
    });
    textoTotal += text + "\n";
  }

  return textoTotal;
}

// ── IMAGEM ────────────────────────────────────
async function extrairTextoImagem(buffer) {
  const { data: { text } } = await Tesseract.recognize(buffer, "por", {
    logger: () => {},
  });
  return text;
}

module.exports = { extrairTexto };
