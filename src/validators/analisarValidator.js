// src/validators/analisarValidator.js
// Aceita payload com array de documentos (novo formato)
// { nome, cpf, documentos: [{ nome: "arquivo.pdf", texto: "..." }, ...] }

function sanitizar(texto, max = 50000) {
  if (typeof texto !== "string") return "";
  return texto.replace(/<[^>]*>/g, "").trim().slice(0, max);
}

function validarCPF(cpf) {
  const limpo = cpf.replace(/\D/g, "");
  if (limpo.length !== 11 || /^(\d)\1{10}$/.test(limpo)) return false;
  let soma = 0;
  for (let i = 0; i < 9; i++) soma += parseInt(limpo[i]) * (10 - i);
  let r = (soma * 10) % 11;
  if (r === 10 || r === 11) r = 0;
  if (r !== parseInt(limpo[9])) return false;
  soma = 0;
  for (let i = 0; i < 10; i++) soma += parseInt(limpo[i]) * (11 - i);
  r = (soma * 10) % 11;
  if (r === 10 || r === 11) r = 0;
  return r === parseInt(limpo[10]);
}

function validarPayload(body) {
  const erros = [];

  // Nome
  const nome = sanitizar(body.nome || "", 200);
  if (!nome || nome.length < 3) erros.push("Nome inválido ou ausente.");

  // CPF
  const cpf = sanitizar(body.cpf || "", 20);
  if (!cpf) erros.push("CPF ausente.");
  else if (!validarCPF(cpf)) erros.push("CPF inválido.");

  // Documentos — agora é um array de { nome, texto }
  const raw = body.documentos;
  if (!Array.isArray(raw) || raw.length === 0) {
    erros.push("Nenhum documento enviado.");
    return { valido: false, erros, dados: null };
  }

  const documentos = raw
    .filter(d => d && typeof d.texto === "string" && d.texto.trim().length > 10)
    .map(d => ({
      nome:  sanitizar(d.nome  || "documento", 200),
      texto: sanitizar(d.texto || "",          50000),
    }));

  if (documentos.length === 0) {
    erros.push("Nenhum documento com texto válido encontrado.");
  }

  const extras = sanitizar(body.extras || "", 3000);

  return {
    valido: erros.length === 0,
    erros,
    dados: { nome, cpf, documentos, extras },
  };
}

module.exports = { validarPayload };