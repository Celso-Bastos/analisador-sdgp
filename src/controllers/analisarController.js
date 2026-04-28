// src/controllers/analisarController.js
const { validarPayload }    = require("../validators/analisarValidator");
const { analisarDocumentos } = require("../services/anthropicService");

async function analisar(req, res) {
  // 1. Validação
  const { valido, erros, dados } = validarPayload(req.body);
  if (!valido) return res.status(400).json({ ok: false, erros });

  // 2. Chamada ao serviço de IA
  try {
    const { classificacao, ...resultado } = await analisarDocumentos(dados);

    return res.status(200).json({
      ok: true,
      resultado,
      classificacao: classificacao || null,
    });

  } catch (error) {
    console.error("[analisar] Erro ao chamar IA:", error.message);

    if (error.message?.includes("401")) {
      return res.status(500).json({ ok: false, erros: ["Chave de API inválida. Verifique o .env."] });
    }
    if (error.message?.includes("429")) {
      return res.status(429).json({ ok: false, erros: ["Limite de requisições atingido. Aguarde e tente novamente."] });
    }
    return res.status(500).json({ ok: false, erros: [error.message || "Erro interno."] });
  }
}

module.exports = { analisar };