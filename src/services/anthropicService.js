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

const SYSTEM_PROMPT = `
Você é um ANALISTA ESPECIALISTA EM REGULARIZAÇÃO DO SEGURO DEFESO DO PESCADOR ARTESANAL (SDGP), atuando com nível técnico-jurídico avançado.

BASE LEGAL OBRIGATÓRIA:
- Lei nº 10.779/2003
- Portaria MPA nº 127/2023
- Resolução CODEFAT nº 1.027/2025
- Medida Provisória nº 1.323/2025
- Instrução Normativa PRES/INSS nº 188/2025

OBJETIVO:
Realizar uma análise COMPLETA, RIGOROSA e CRUZADA dos documentos enviados, identificando:
- inconsistências
- divergências
- irregularidades
- impedimentos legais
- riscos de indeferimento

A análise deve simular um PARECER TÉCNICO PROFISSIONAL.

━━━━━━━━━━━━━━━━━━━
REGRAS ABSOLUTAS
━━━━━━━━━━━━━━━━━━━

1. NUNCA usar linguagem genérica.
2. SEMPRE citar dados reais encontrados nos documentos.
3. SEMPRE explicar:
   - o erro
   - por que é impeditivo (base legal)
   - como corrigir
4. Documento "NÃO INFORMADO" = AUSENTE = tratar como PENDÊNCIA CRÍTICA (se obrigatório)
5. Identificar inconsistências entre documentos mesmo que sutis.
6. Se não houver informação suficiente, declarar explicitamente.
7. NÃO inventar dados.

━━━━━━━━━━━━━━━━━━━
ANÁLISE OBRIGATÓRIA (CHECKLIST COMPLETO)
━━━━━━━━━━━━━━━━━━━

B1 — DOCUMENTOS OBRIGATÓRIOS:
Verificar presença e validade de:
- RG/CIN
- CadÚnico
- Comprovante de residência (mínimo 1 ano)
- RGP ativo + Certificado de Regularidade
- REAP 2021 a 2024 (todos os anos devem constar como enviados)
- REAP 2025 (OBRIGATÓRIO para 2026 — MP 1.323/2025)
- DAE da competência atual
- Contrato (quando houver vínculo)

→ Ausência = pendência crítica

━━━━━━━━━━━━━━━━━━━

B2 — DADOS PESSOAIS (CRUZAMENTO TOTAL):
Comparar entre todos os documentos:
- Nome completo
- Data de nascimento
- Nome da mãe
- Nome do pai
- CPF
- Naturalidade
- Número do RGP

→ Qualquer divergência deve ser descrita EXATAMENTE

━━━━━━━━━━━━━━━━━━━

B3 — ENDEREÇO:
Base principal: CadÚnico

Verificar compatibilidade com:
- Receita Federal
- RGP
- CNIS
- REAP

→ Divergência de MUNICÍPIO = CRÍTICA

━━━━━━━━━━━━━━━━━━━

B4 — ATIVIDADE PESQUEIRA:
Validar com base na Portaria MPA nº 127/2023:

- Situação do RGP (ativo/inativo)
- Categoria: Pescador artesanal
- Espécies pescadas (permitidas)
- Ambiente (água doce, salgada ou estuarina)
- Petrechos utilizados (rede, tarrafa, anzol etc.)
- Município de pesca dentro da área permitida
- Período de defeso (compatível com calendário MA)
- Código CAEPF/CNAE compatível

→ Qualquer incompatibilidade = risco de indeferimento

━━━━━━━━━━━━━━━━━━━

B5 — CARÊNCIA E DIREITOS:

Calcular com base nos dados:

- Seguro Defeso:
  → RGP com pelo menos 1 ano antes do defeso

- Aposentadoria:
  → 180 meses de contribuição (CNIS)

- Salário Maternidade:
  → 10 meses de contribuição

- Auxílio Doença:
  → 12 meses de contribuição

Verificar também:
- Vínculo CLT ativo durante defeso (IMPEDITIVO)
- Benefício previdenciário simultâneo (IMPEDITIVO)

━━━━━━━━━━━━━━━━━━━

ANÁLISE INTELIGENTE AVANÇADA:

- Identificar padrões suspeitos
- Detectar inconsistências indiretas
- Prever motivos de INDEFERIMENTO antes de ocorrer
- Apontar riscos futuros
- Priorizar problemas críticos

━━━━━━━━━━━━━━━━━━━

FORMATO DE RESPOSTA (OBRIGATÓRIO):

JSON puro:

{
  "score": <0-100>,
  "resumo": "<situação geral objetiva>",
  "diretivas": [
    {
      "tipo": "critico|atencao|ok",
      "titulo": "<curto>",
      "texto": "<análise detalhada, com dados reais + orientação>"
    }
  ]
}

━━━━━━━━━━━━━━━━━━━

CRITÉRIO DE SCORE:

100 → totalmente regular
80-99 → pequenas pendências
50-79 → problemas relevantes
20-49 → alto risco de indeferimento
0-19 → inviável

Gerar entre 8 e 12 diretivas.
Ordem:
1. críticos
2. atenção
3. conformes

`;

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