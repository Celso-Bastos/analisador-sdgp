// src/services/anthropicService.js
// Uma chamada ao Groq 70B — prompt completo, resposta rápida

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODELO = "llama-3.3-70b-versatile";

function montarDocsTexto(documentos) {
  const labels = {
    rg:          "RG / CIN",
    rgp:         "RGP (Registro Geral da Atividade Pesqueira)",
    certificado: "Certificado de Regularidade do Pescador",
    residencia:  "Comprovante de Residência",
    cadunico:    "CadÚnico",
    receita:     "Dados da Receita Federal",
    cnis:        "CNIS",
    reap2124:    "REAP 2021–2024",
    reap25:      "REAP 2025",
    dae:         "DAE Competência Atual",
    contrato:    "Contrato",
  };

  return Object.entries(labels)
    .map(([k, l]) => `[${l}]:\n${documentos[k]?.trim().slice(0, 2000) || "NÃO INFORMADO"}`)
    .join("\n\n");
}

const SYSTEM_PROMPT = `Você é um especialista em regularização do SDGP com domínio da legislação vigente: Lei 10.779/2003, MP 1.323/2025, PL Conversão nº 1/2026, Portaria MPA nº 127/2023, Resolução CODEFAT nº 1.027/2025.

REGRAS:
- Cite sempre dados reais dos documentos (nomes, datas, números)
- Nunca use frases vagas como "é importante verificar"
- Documento "NÃO INFORMADO" = ausente = pendência crítica se obrigatório
- Diga O QUE está errado, POR QUE impede o benefício e O QUE fazer

CHECKLIST OBRIGATÓRIO — aplique todos os blocos:

B1 DOCUMENTOS OBRIGATÓRIOS:
RG/CIN | CadÚnico | Residência (mín. 1 ano) | RGP + Certificado de Regularidade | REAP 2021-2024 (anos 2021,2022,2023,2024 todos "Enviados") | REAP 2025 (obrigatório para 2026 — Art.9º PL Conversão) | DAE competência atual | Contrato (se aplicável)

B2 DADOS PESSOAIS — cruzar entre todos os documentos:
Nome completo | Data de nascimento | Nome da mãe | Nome do pai | Naturalidade | CPF | Número RGP
→ Cite divergências exatas entre documentos

B3 ENDEREÇO — base: CadÚnico:
Município deve ser igual em CadÚnico, Receita Federal, RGP, CNIS e REAP
→ Cite qualquer divergência de município

B4 ATIVIDADE PESQUEIRA:
- RGP: situação ativa, categoria PESCADOR ARTESANAL, validade
- Espécies do REAP: permitidas pela Portaria de defeso MA
- Ambiente (água doce/salgada/estuarina): permitido pela Portaria
- Petrechos (emalhe, tarrafa, linha/anzol): permitidos pela Portaria
- Município de pesca: abrangido pela Portaria
- Meses de defeso declarados no REAP: compatíveis com período MA (dez-mar)
- CANE do CAEPF: código de atividade permitido

B5 CARÊNCIAS E DIREITOS — calcule com as datas dos documentos:
- SDPA: data do 1º RGP ≥ 1 ano antes do defeso → cite data e cálculo
- Aposentadoria por idade: 180 meses de contribuição no CNIS → quantos têm, quantos faltam
- Salário Maternidade: 10 meses de contribuição → atingiu?
- Auxílio Doença: 12 meses de contribuição → atingiu?
- CNIS sem vínculo CLT ativo durante defeso (IMPEDITIVO)
- CNIS sem benefício previdenciário simultâneo (IMPEDITIVO)

FORMATO — JSON puro, sem markdown:
{
  "score": <0-100>,
  "resumo": "<situação geral com dados reais — máx 140 chars>",
  "diretivas": [
    {"tipo": "critico|atencao|ok", "titulo": "<até 6 palavras>", "texto": "<análise detalhada com dados reais e orientação>"}
  ]
}

Score: 100=conforme | 80-99=pequenas pendências | 50-79=relevantes | 20-49=sérios | 0-19=inviável
Gere 6-10 diretivas. Críticos primeiro, atenções depois, conformes por último.`;

async function analisarDocumentos(dados) {
  const docsTexto = montarDocsTexto(dados.documentos);

  const informados = Object.entries(dados.documentos)
    .filter(([, v]) => v?.trim()).map(([k]) => k);
  const todosIds = ["rg","rgp","certificado","residencia","cadunico","receita","cnis","reap2124","reap25","dae","contrato"];
  const ausentes = todosIds.filter(d => !informados.includes(d));

  const userMessage = `PESCADOR: ${dados.nome}
CPF: ${dados.cpf}
DATA HOJE: ${new Date().toLocaleDateString("pt-BR")}
DOCS PRESENTES: ${informados.join(", ") || "nenhum"}
DOCS AUSENTES: ${ausentes.join(", ") || "nenhum"}

DOCUMENTOS:
${docsTexto}

${dados.extras ? `INFORMAÇÕES ADICIONAIS: ${dados.extras}` : ""}

Aplique os 5 blocos do checklist. Para B4 verifique especificamente se as espécies, ambiente, petrechos e município declarados no REAP são compatíveis com a Portaria de defeso do MA. Para B5 calcule as carências usando as datas encontradas nos documentos.`;

  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODELO,
      temperature: 0.1,
      max_tokens: 2000,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!response.ok) {
    const erro = await response.json().catch(() => ({}));
    throw new Error(erro?.error?.message || `Erro Groq: ${response.status}`);
  }

  const data = await response.json();
  const raw = (data.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();

  let resultado;
  try { resultado = JSON.parse(raw); }
  catch (e) { throw new Error("Formato inesperado da IA. Tente novamente."); }

  resultado.score = Math.max(0, Math.min(100, Math.round(Number(resultado.score) || 0)));
  if (!Array.isArray(resultado.diretivas)) resultado.diretivas = [];

  return resultado;
}

module.exports = { analisarDocumentos };