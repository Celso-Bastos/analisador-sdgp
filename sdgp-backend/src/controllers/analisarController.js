// src/controllers/analisarController.js
// Orquestra validação → serviço → resposta

const { validarPayload } = require("../validators/analisarValidator");
const { analisarDocumentos } = require("../services/anthropicService");

/**
 * POST /api/analisar
 * Body: { nome, cpf, documentos: { cnis, rgp, reap, contribuicao, residencia } }
 */
async function analisar(req, res) {
  // 1. Validação
  const { valido, erros, dados } = validarPayload(req.body);

  if (!valido) {
    return res.status(400).json({
      ok: false,
      erros,
    });
  }

  // 2. Chamada ao serviço de IA
  try {
    const resultado = await analisarDocumentos(dados);

    return res.status(200).json({
      ok: true,
      resultado,
    });
  } catch (error) {
    console.error("[analisar] Erro ao chamar IA:", error.message);

    // Erros da Anthropic API
    if (error.status === 401) {
      return res.status(500).json({
        ok: false,
        erros: ["Chave de API inválida. Verifique o arquivo .env no servidor."],
      });
    }

    if (error.status === 429) {
      return res.status(429).json({
        ok: false,
        erros: ["Limite de requisições atingido. Aguarde alguns segundos e tente novamente."],
      });
    }

    return res.status(500).json({
      ok: false,
      erros: [error.message || "Erro interno ao processar a análise."],
    });
  }
}

module.exports = { analisar };
