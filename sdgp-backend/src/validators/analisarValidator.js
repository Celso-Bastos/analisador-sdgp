// src/validators/analisarValidator.js
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

  const nome = sanitizar(body.nome || "", 200);
  if (!nome || nome.length < 3) erros.push("Nome inválido ou ausente.");

  const cpf = sanitizar(body.cpf || "", 20);
  if (!cpf) erros.push("CPF ausente.");
  else if (!validarCPF(cpf)) erros.push("CPF inválido.");

  const campos = [
    "rg", "rgp", "certificado", "residencia", "cadunico",
    "receita", "cnis", "reap2124", "reap25", "dae", "contrato"
  ];

  const documentos = {};
  let algum = false;

  for (const campo of campos) {
    const val = sanitizar(body.documentos?.[campo] || "", 50000);
    documentos[campo] = val;
    if (val) algum = true;
  }

  if (!algum) erros.push("Preencha pelo menos um documento.");

  const extras = sanitizar(body.extras || "", 3000);

  return {
    valido: erros.length === 0,
    erros,
    dados: { nome, cpf, documentos, extras },
  };
}

module.exports = { validarPayload };