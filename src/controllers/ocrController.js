// src/controllers/ocrController.js
const Tesseract = require("tesseract.js");

// pdfjs-dist v5 — importação correta
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs"); // ESM apenas na v5
// Em Node.js o worker é desabilitado automaticamente pelo pdfjs,
// mas workerSrc precisa existir antes disso ou o código quebra.
// Apontamos para o arquivo worker dentro do próprio pacote instalado.
pdfjsLib.GlobalWorkerOptions.workerSrc = path.join(
  require.resolve("pdfjs-dist/package.json"),
  "../build/pdf.worker.mjs"
);






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

async function extrairTextoPDF(buffer) {
  const uint8 = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({
    data: uint8,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
    // v5: desabilita worker explicitamente
    disableWorker: true,
  });

  const pdf = await loadingTask.promise;
  let texto = "";

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    texto += content.items.map((item) => item.str).join(" ") + "\n";
  }

  // PDF escaneado — renderiza e aplica OCR
  if (texto.trim().length < 20) {
    console.log("[OCR] PDF escaneado — aplicando OCR nas páginas...");
    texto = await ocrarPaginasPDF(pdf);
  }

  return texto;
}

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

async function extrairTextoImagem(buffer) {
  const { data: { text } } = await Tesseract.recognize(buffer, "por", {
    logger: () => {},
  });
  return text;
}

module.exports = { extrairTexto };