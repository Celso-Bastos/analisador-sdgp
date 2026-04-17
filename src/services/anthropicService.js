// src/services/anthropicService.js
//
// Pipeline de 3 chamadas distribuídas entre provedores:
//
//  CHAMADA A — Perito Documental   → OpenRouter (Llama 3.3 70B :free, 128K ctx)
//  CHAMADA B — Perito Jurídico     → Groq       (Llama 3.3 70B,    128K ctx)
//  CHAMADA C — Consolidador        → OpenRouter (DeepSeek R1 :free, 164K ctx)
//
// Por que essa distribuição:
//  - Groq e OpenRouter têm rate limits INDEPENDENTES entre si
//  - A + B rodam em paralelo (Promise.all) → sem overhead de tempo
//  - C (consolidador) recebe JSONs pequenos → rápido e leve
//  - Se OpenRouter falhar no modelo principal, há fallback automático
// ─────────────────────────────────────────────────────────────────────────────

// ── CONFIGURAÇÕES DOS PROVEDORES ─────────────────────────────────────────────

const PROVEDORES = {
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    getKey: () => process.env.GROQ_API_KEY,
    modelo: "llama-3.3-70b-versatile",
    nome: "Groq",
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    getKey: () => process.env.OPENROUTER_API_KEY,
    // Modelos free do OpenRouter (128K–164K context, zero custo)
    modeloPrincipal:    "meta-llama/llama-3.3-70b-instruct:free",
    modeloFallback:     "deepseek/deepseek-r1:free",
    modeloConsolidador: "deepseek/deepseek-r1:free",
    nome: "OpenRouter",
    headers: {
      "HTTP-Referer": process.env.APP_URL || "https://sdgp.app",
      "X-Title": "Analisador SDGP",
    },
  },
};

// ── LABELS DOS DOCUMENTOS ────────────────────────────────────────────────────

const LABELS = {
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

function montarDocsTexto(documentos) {
  return Object.entries(LABELS)
    .map(([k, l]) => `[${l}]:\n${documentos[k]?.trim().slice(0, 3000) || "NÃO INFORMADO"}`)
    .join("\n\n");
}

// ── CHAMADA GENÉRICA (formato OpenAI-compatível) ──────────────────────────────

async function chamar({ provedor, modelo, systemPrompt, userMessage, maxTokens = 2000, label }) {
  const cfg = PROVEDORES[provedor];
  const key = cfg.getKey();

  if (!key) {
    throw new Error(`[${label}] Chave ausente para "${provedor}". Verifique o .env.`);
  }

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${key}`,
    ...(cfg.headers || {}),
  };

  const body = JSON.stringify({
    model: modelo,
    temperature: 0.1,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userMessage   },
    ],
  });

  const response = await fetch(cfg.url, { method: "POST", headers, body });

  if (!response.ok) {
    const erro = await response.json().catch(() => ({}));
    const msg  = erro?.error?.message || `HTTP ${response.status}`;
    throw new Error(`[${label}][${cfg.nome}] ${msg}`);
  }

  const data = await response.json();
  const raw  = (data.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();

  // DeepSeek R1 pode incluir bloco <think>...</think> antes do JSON — remover
  const semThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  try {
    return JSON.parse(semThink);
  } catch {
    throw new Error(`[${label}] JSON inválido: ${semThink.slice(0, 300)}`);
  }
}

// Wrapper com fallback automático entre modelos do OpenRouter
async function chamarOpenRouter({ modeloPrincipal, modeloFallback, ...resto }) {
  try {
    return await chamar({ provedor: "openrouter", modelo: modeloPrincipal, ...resto });
  } catch (err) {
    if (modeloFallback) {
      console.warn(`[${resto.label}] Fallback ativado (${modeloPrincipal} → ${modeloFallback}): ${err.message}`);
      return await chamar({ provedor: "openrouter", modelo: modeloFallback, ...resto });
    }
    throw err;
  }
}

// ── PROMPT A — PERITO DOCUMENTAL (OpenRouter) ────────────────────────────────

const SYSTEM_A = `
Você é um PERITO DOCUMENTAL especializado em conferência cruzada de documentos do Seguro Defeso do Pescador Artesanal (SDGP).

SEU ÚNICO PAPEL: comparar os documentos enviados ENTRE SI.
Você NÃO analisa legislação. Você NÃO avalia carências. Você compara dados.

━━━ CHECKLIST DE CRUZAMENTOS ━━━

[C1] PRESENÇA DE DOCUMENTOS
Liste quais dos 11 documentos estão presentes (conteúdo real) e quais estão ausentes
(marcados como "NÃO INFORMADO" ou com texto menor que 10 caracteres).

[C2] IDENTIDADE — CRUZAMENTO TOTAL
Compare entre TODOS os documentos que contenham esses campos:
nome completo, data de nascimento, nome da mãe, nome do pai, naturalidade, CPF, número do RGP.
→ Qualquer diferença deve ser reportada com os valores EXATOS encontrados.
  Exemplo: "Nome no RG: João Silva / Nome no CadÚnico: João da Silva — divergência no sobrenome"

[C3] ENDEREÇO — BASE: CadÚnico
Compare o endereço do CadÚnico com: Receita Federal, RGP, CNIS, REAP 2021–2024, REAP 2025.
→ Divergência de município = CRÍTICA
→ Divergência de bairro ou logradouro = ATENÇÃO
→ Endereço ausente em documento que deveria conter = ATENÇÃO

[C4] DATAS E VALIDADES
- Certificado de Regularidade: há data de vencimento? Está vencido?
- REAP 2021–2024: os 4 anos (2021, 2022, 2023, 2024) estão todos declarados?
- REAP 2025: o ano 2025 está declarado?
- DAE: a competência é recente? (máximo 3 meses de defasagem em relação à data de hoje)
- Contrato (se presente): datas de vigência são coerentes?

[C5] REAP vs. OUTROS DOCUMENTOS
Compare o conteúdo do REAP com os demais documentos:
- Município de pesca declarado no REAP vs. município de residência no CadÚnico (coerência geográfica)
- Espécies e petrechos declarados no REAP vs. categoria registrada no RGP
- Nome, CPF e número do RGP no REAP vs. demais documentos

[C6] CNIS vs. DAE vs. CONTRATO
- Identificar competência mais recente das contribuições no CNIS
- Comparar com a competência do DAE enviado (estão próximas?)
- Se houver contrato: há vínculo CLT ativo? → Marcar como CRÍTICO IMPEDITIVO

[C7] PADRÕES SUSPEITOS
- Nome com grafias diferentes em mais de 2 documentos
- Endereços que mudam significativamente de documento para documento
- Datas idênticas em documentos que normalmente não coincidiriam

━━━ REGRAS ABSOLUTAS ━━━
1. NUNCA invente dados. Se não encontrou, escreva "dado não localizado no documento".
2. SEMPRE cite os valores exatos encontrados nos documentos.
3. NÃO cite leis. NÃO calcule carências. Apenas compare.

━━━ SAÍDA OBRIGATÓRIA: JSON PURO, SEM MARKDOWN ━━━
{
  "documentos_presentes": ["lista de IDs: rg, rgp, certificado, residencia, cadunico, receita, cnis, reap2124, reap25, dae, contrato"],
  "documentos_ausentes": ["lista de IDs ausentes"],
  "divergencias": [
    {
      "tipo": "critico|atencao|ok",
      "categoria": "C1|C2|C3|C4|C5|C6|C7",
      "titulo": "título curto",
      "detalhe": "descrição precisa com valores reais encontrados"
    }
  ]
}
Gere 6–10 divergências. Ordem: críticos → atenções → conformes.
`;

// ── PROMPT B — PERITO JURÍDICO (Groq) ────────────────────────────────────────

const SYSTEM_B = `
Você é um PERITO JURÍDICO especializado na legislação do Seguro Defeso do Pescador Artesanal (SDGP).

SEU ÚNICO PAPEL: verificar se os dados dos documentos atendem aos requisitos legais vigentes.
Você NÃO compara documentos entre si. Você apenas verifica conformidade com a lei.

━━━ BASE LEGAL VIGENTE ━━━
- Lei nº 10.779/2003 (com alterações da MP 1.323/2025)
- Portaria MPA nº 127/2023
- Resolução CODEFAT nº 1.027/2025
- PL de Conversão nº 1/2026 (conversão da MP 1.323/2025, publicado em 24/03/2026)
- Instrução Normativa PRES/INSS nº 188/2025

━━━ CHECKLIST JURÍDICO ━━━

[J1] DOCUMENTOS OBRIGATÓRIOS POR LEI
Com base na MP 1.323/2025 e PL de Conversão nº 1/2026:
- RG/CIN → obrigatório (art. 1º, §10 da Lei 10.779 com redação da MP 1.323)
- CadÚnico → OBRIGATÓRIO (art. 2º, §3º) — prazo de regularização: 180 dias da publicação
- Comprovante de residência mínimo 1 ano → Portaria MPA 127/2023
- RGP ativo → art. 2º da Lei 10.779
- Certificado de Regularidade → Portaria MPA 127/2023
- REAP 2025 → OBRIGATÓRIO para concessão em 2026 (art. 9º, §único do PL Conversão nº 1/2026)
  ATENÇÃO CRÍTICA: em 2026 exige-se SOMENTE o REAP referente ao ano de 2025 para fins
  de concessão. Os REAPs de 2021–2024 têm prazo prorrogado até 31/12/2026, mas NÃO
  são impeditivos para concessão enquanto o REAP 2025 estiver presente.
- DAE da competência atual → art. 2º, §2º, II
- Inscrição na Previdência Social → art. 2º, §3º

[J2] REQUISITOS DO RGP (Portaria MPA 127/2023)
- Categoria: deve ser PESCADOR ARTESANAL (não industrial, não aquicultor)
- Situação: deve estar ATIVO
- Carência para o Seguro Defeso: RGP deve ter pelo menos 1 (um) ano de registro
  antes do início do período de defeso

[J3] ATIVIDADE PESQUEIRA — PORTARIA MPA 127/2023 — MARANHÃO
O pescador é do Maranhão. Verifique especificamente:
- Espécies exploradas no REAP: são contempladas pela portaria de defeso do MA?
  (Espécies típicas do MA: camarão-branco, camarão-rosa, curimatã, pirarucu, tambaqui)
- Ambiente de pesca (água doce, salgada, estuarina): compatível com a portaria do MA?
- Petrechos utilizados: compatíveis com a categoria artesanal?
  (tarrafa, rede de espera, anzol, espinhel, covos são compatíveis; redes de arrasto industrial, não)
- Município de pesca: dentro da área abrangida pela portaria do MA?
- CNAE/CAEPF: código 0311-6/01 (pesca em água salgada) ou 0312-4/01 (pesca em água doce)
  ou equivalente para pesca artesanal?

[J4] CARÊNCIAS PREVIDENCIÁRIAS
Usando contribuições identificadas no CNIS:

a) SEGURO DEFESO: exige inscrição ativa na Previdência + contribuições nos meses de exercício.
   Verificar se há DAE da competência atual (contribuição em dia).

b) APOSENTADORIA: 180 meses (15 anos) de contribuição. Total encontrado no CNIS?

c) SALÁRIO MATERNIDADE (pescadora): 10 meses de contribuição. Total encontrado no CNIS?

d) AUXÍLIO-DOENÇA: 12 meses de contribuição.
   Exceção: acidente de qualquer natureza dispensa carência.

[J5] IMPEDIMENTOS LEGAIS ABSOLUTOS
- Vínculo CLT ativo durante o período de defeso → IMPEDITIVO ABSOLUTO (art. 3º, §5º Lei 10.779)
- Benefício previdenciário de caráter continuado simultâneo ao defeso → IMPEDITIVO ABSOLUTO
- Suspensão por fraude anterior → 5 anos (dobro em reincidência — art. 3º)
- CadÚnico ausente com prazo de 180 dias já expirado → IMPEDITIVO

[J6] BIOMETRIA E VALIDAÇÃO (MP 1.323/2025, art. 1º, §10)
- Registro biométrico é exigido
- Documentos aceitos: CIN, CNH ou base do TSE (período de transição até implementação plena da CIN)
- Verificar se o documento de identidade apresentado é compatível com essa exigência

[J7] REAP — ANÁLISE ESPECÍFICA
- REAP 2025 AUSENTE → CRÍTICO IMPEDITIVO para concessão em 2026 (PL Conversão art. 9º, §único)
- REAP 2021–2024 ausente + REAP 2025 presente → ATENÇÃO (prazo para regularizar até 31/12/2026)
- Conteúdo mínimo exigido: venda do pescado, espécies, ambiente, petrechos, município, período
- Formato deve atender ao estabelecido pelo CODEFAT (Resolução 1.027/2025)

━━━ REGRAS ABSOLUTAS ━━━
1. SEMPRE cite o artigo/portaria/resolução que fundamenta cada apontamento.
2. NUNCA invente dados. Se não há informação suficiente, declare explicitamente.
3. NÃO compare documentos entre si.
4. Diferencie IMPEDITIVO (bloqueia o benefício) de PENDÊNCIA (pode ser regularizada).

━━━ SAÍDA OBRIGATÓRIA: JSON PURO, SEM MARKDOWN ━━━
{
  "conformidades_legais": [
    {
      "tipo": "critico|atencao|ok",
      "bloco": "J1|J2|J3|J4|J5|J6|J7",
      "titulo": "título curto",
      "base_legal": "dispositivo legal citado",
      "detalhe": "análise precisa com orientação de correção quando aplicável",
      "imperativo": true
    }
  ]
}
imperativo = true significa que esse item BLOQUEIA o benefício se não resolvido.
Gere 6–10 itens. Ordem: críticos → atenções → conformes.
`;

// ── PROMPT C — CONSOLIDADOR (OpenRouter DeepSeek R1) ─────────────────────────

const SYSTEM_C = `
Você é um CONSOLIDADOR DE ANÁLISES do Seguro Defeso do Pescador Artesanal (SDGP).

Você recebe dois relatórios técnicos em JSON e deve consolidá-los em um único resultado final.

━━━ CÁLCULO DO SCORE (0–100) ━━━
Ponto de partida: 100

Deduções por item identificado:
- Documento obrigatório AUSENTE: -12 pontos cada
- Impedimento absoluto (vínculo CLT ativo, benefício simultâneo): -25 pontos cada
- Item CRÍTICO não impeditivo: -10 pontos cada
- Item ATENÇÃO relevante (ex: endereço diferente, REAP 2021-2024 ausente): -4 pontos cada
- Item ATENÇÃO menor (ex: data levemente defasada): -2 pontos cada
- Item OK/conforme: sem dedução

Score mínimo: 0. Score máximo: 100.

━━━ REGRAS DE CONSOLIDAÇÃO ━━━
1. Mesmo problema nos dois relatórios → UMA única diretiva (não duplicar)
2. Mantenha a base legal do Relatório B quando disponível
3. Mantenha os valores exatos do Relatório A quando disponível
4. Combine os dois quando forem complementares
5. Cada diretiva deve conter: o problema + base legal (se houver) + como resolver
6. Resumo: máximo 2 frases, objetivo e direto

━━━ SAÍDA OBRIGATÓRIA: JSON PURO, SEM MARKDOWN ━━━
{
  "score": <número entre 0 e 100>,
  "resumo": "<situação geral em 1–2 frases objetivas>",
  "diretivas": [
    {
      "tipo": "critico|atencao|ok",
      "titulo": "<título curto e preciso>",
      "texto": "<problema detalhado + base legal + como corrigir>"
    }
  ]
}
Gere 8–14 diretivas. Ordem obrigatória: críticos → atenções → conformes.
`;

// ── FUNÇÃO PRINCIPAL ──────────────────────────────────────────────────────────

async function analisarDocumentos(dados) {
  const docsTexto = montarDocsTexto(dados.documentos);

  const informados = Object.entries(dados.documentos)
    .filter(([, v]) => v?.trim()?.length > 10)
    .map(([k]) => k);

  const todosIds = ["rg","rgp","certificado","residencia","cadunico","receita","cnis","reap2124","reap25","dae","contrato"];
  const ausentes = todosIds.filter(d => !informados.includes(d));

  const cabecalho = `PESCADOR: ${dados.nome}
CPF: ${dados.cpf}
DATA HOJE: ${new Date().toLocaleDateString("pt-BR")}
DOCS PRESENTES: ${informados.map(k => LABELS[k]).join(", ") || "nenhum"}
DOCS AUSENTES: ${ausentes.map(k => LABELS[k]).join(", ") || "nenhum"}`;

  const extras = dados.extras ? `\nINFORMAÇÕES ADICIONAIS: ${dados.extras}\n` : "";

  const msgA = `${cabecalho}${extras}

DOCUMENTOS PARA CRUZAMENTO INTERNO:
${docsTexto}

Execute todos os blocos C1 a C7. Cite sempre os valores exatos encontrados.`;

  const msgB = `${cabecalho}${extras}

DOCUMENTOS PARA ANÁLISE DE CONFORMIDADE LEGAL:
${docsTexto}

Execute todos os blocos J1 a J7.
Para J3: o pescador é do Maranhão — use a portaria de defeso do MA.
Para J4: calcule as carências usando as datas e competências encontradas nos documentos.`;

  // ── Chamadas A (OpenRouter) e B (Groq) em paralelo ────────────────────────
  console.log("[SDGP] Iniciando análise paralela...");
  console.log("       → Perito Documental: OpenRouter (Llama 3.3 70B :free)");
  console.log("       → Perito Jurídico:   Groq (Llama 3.3 70B)");

  const [resultadoA, resultadoB] = await Promise.all([
    chamarOpenRouter({
      modeloPrincipal: PROVEDORES.openrouter.modeloPrincipal,
      modeloFallback:  PROVEDORES.openrouter.modeloFallback,
      systemPrompt:    SYSTEM_A,
      userMessage:     msgA,
      maxTokens:       2000,
      label:           "PERITO-DOCUMENTAL",
    }),
    chamar({
      provedor:        "groq",
      modelo:          PROVEDORES.groq.modelo,
      systemPrompt:    SYSTEM_B,
      userMessage:     msgB,
      maxTokens:       2000,
      label:           "PERITO-JURIDICO",
    }),
  ]);

  console.log("[SDGP] Paralelo concluído. Iniciando consolidação...");
  console.log("       → Consolidador: OpenRouter (DeepSeek R1 :free)");

  // ── Chamada C — Consolidador (OpenRouter DeepSeek R1) ─────────────────────
  const msgC = `RELATÓRIO A — PERITO DOCUMENTAL (divergências internas entre documentos):
${JSON.stringify(resultadoA, null, 2)}

RELATÓRIO B — PERITO JURÍDICO (conformidade com a legislação vigente):
${JSON.stringify(resultadoB, null, 2)}

Consolide os dois relatórios eliminando redundâncias, calcule o score e gere as diretivas finais.`;

  const consolidado = await chamarOpenRouter({
    modeloPrincipal: PROVEDORES.openrouter.modeloConsolidador,
    modeloFallback:  PROVEDORES.openrouter.modeloPrincipal,
    systemPrompt:    SYSTEM_C,
    userMessage:     msgC,
    maxTokens:       2500,
    label:           "CONSOLIDADOR",
  });

  // ── Normalização final ────────────────────────────────────────────────────
  consolidado.score = Math.max(0, Math.min(100, Math.round(Number(consolidado.score) || 0)));
  if (!Array.isArray(consolidado.diretivas)) consolidado.diretivas = [];
  if (!consolidado.resumo) consolidado.resumo = "Análise concluída. Verifique as diretivas abaixo.";

  console.log(`[SDGP] Finalizado. Score: ${consolidado.score} | Diretivas: ${consolidado.diretivas.length}`);
  return consolidado;
}

module.exports = { analisarDocumentos };






