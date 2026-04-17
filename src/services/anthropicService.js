// src/services/anthropicService.js
//
// Pipeline de 3 chamadas em chaves Groq independentes:
//
//  CHAMADA A — Perito Documental → GROQ_API_KEY_1 (rate limit próprio)
//  CHAMADA B — Perito Jurídico   → GROQ_API_KEY_2 (rate limit próprio)
//  CHAMADA C — Consolidador      → GROQ_API_KEY_3 (recebe JSONs pequenos)
//
//  A + B rodam em paralelo (Promise.all) → sem overhead de tempo
//  Cada chave tem 6.000 TPM e 1.000 RPD independentes entre si
// ─────────────────────────────────────────────────────────────────────────────

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODELO   = "llama-3.3-70b-versatile";

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

// ── CHAMADA GROQ GENÉRICA ────────────────────────────────────────────────────

async function chamarGroq({ apiKey, systemPrompt, userMessage, maxTokens = 2000, label }) {
  if (!apiKey) throw new Error(`[${label}] Chave de API ausente. Verifique o .env.`);

  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODELO,
      temperature: 0.1,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userMessage   },
      ],
    }),
  });

  if (!response.ok) {
    const erro = await response.json().catch(() => ({}));
    const msg  = erro?.error?.message || `HTTP ${response.status}`;
    throw new Error(`[${label}] Erro Groq: ${msg}`);
  }

  const data = await response.json();
  const raw  = (data.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`[${label}] JSON inválido na resposta: ${raw.slice(0, 300)}`);
  }
}

// ── PROMPT A — PERITO DOCUMENTAL ─────────────────────────────────────────────
// Papel exclusivo: cruzar os documentos entre si e detectar divergências internas
// NÃO analisa legislação — apenas compara dados

const SYSTEM_A = `
Você é um PERITO DOCUMENTAL especializado em conferência cruzada de documentos do Seguro Defeso do Pescador Artesanal (SDGP).

SEU ÚNICO PAPEL: comparar os documentos enviados ENTRE SI e identificar divergências, ausências e inconsistências internas.
Você NÃO analisa legislação. Você NÃO avalia carências. Você compara dados.

━━━━━━━━━━━━━━━━━━━
DOCUMENTOS QUE VOCÊ RECEBE
━━━━━━━━━━━━━━━━━━━
RG/CIN · CadÚnico · Receita Federal · Comprovante de Residência
RGP · Certificado de Regularidade · REAP 2021–2024 · REAP 2025
CNIS · DAE Competência Atual · Contrato

━━━━━━━━━━━━━━━━━━━
CHECKLIST OBRIGATÓRIO DE CRUZAMENTOS
━━━━━━━━━━━━━━━━━━━

[C1] PRESENÇA DE DOCUMENTOS
Verificar quais dos 11 documentos estão presentes (com conteúdo real) e quais estão ausentes.
→ Ausente = "NÃO INFORMADO" ou texto com menos de 10 caracteres
→ Liste EXATAMENTE quais estão ausentes

[C2] IDENTIDADE — CRUZAMENTO TOTAL
Compare entre TODOS os documentos que contenham esses dados:
- Nome completo (variações de grafia, abreviações, inversões)
- Data de nascimento
- Nome da mãe
- Nome do pai
- Naturalidade / município de nascimento
- CPF
- Número do RGP
→ Qualquer diferença, por menor que seja, DEVE ser reportada com os valores exatos encontrados.
  Exemplo: "Nome no RG: João Silva / Nome no CadÚnico: João da Silva — divergência no sobrenome"

[C3] ENDEREÇO — BASE: CadÚnico
O endereço do CadÚnico é a referência principal.
Compare com: Receita Federal · RGP · CNIS · REAP 2021–2024 · REAP 2025
→ Divergência de município = CRÍTICA
→ Divergência de bairro/logradouro = ATENÇÃO
→ Ausência de endereço em documento que deveria conter = ATENÇÃO

[C4] DATAS E VALIDADES
- Data de emissão do RGP (verificar se existe e se é coerente com o tempo de inscrição)
- Data de emissão do Certificado de Regularidade (verificar vencimento)
- Período coberto pelo REAP 2021–2024 (todos os anos 2021, 2022, 2023 e 2024 devem constar)
- REAP 2025 — verificar se o ano de 2025 está declarado
- DAE — verificar se a competência do DAE é recente (máximo 3 meses de defasagem)
- Contrato (se presente): verificar datas de vigência e coerência

[C5] CONSISTÊNCIA DO REAP vs. OUTROS DOCUMENTOS
Compare as informações declaradas no REAP com os outros documentos:
- Município de pesca declarado no REAP vs. município de residência no CadÚnico (coerência geográfica)
- Espécies e petrechos declarados no REAP vs. categoria no RGP
- Dados do pescador no REAP (nome, CPF, RGP) vs. demais documentos

[C6] CNIS vs. DAE vs. CONTRATO
- Verificar se há contribuições previdenciárias no CNIS
- Identificar a competência mais recente do CNIS
- Comparar com a competência do DAE enviado (estão próximas?)
- Se houver contrato: verificar se existe vínculo CLT ativo — isso é CRÍTICO IMPEDITIVO
→ Registrar o número de contribuições identificadas no CNIS

[C7] PADRÕES SUSPEITOS
- Datas idênticas em documentos diferentes que normalmente não coincidiriam
- Informações que parecem copiadas entre documentos
- Endereços que mudam significativamente de documento para documento
- Nome do pescador com grafias diferentes em mais de 2 documentos

━━━━━━━━━━━━━━━━━━━
REGRAS ABSOLUTAS
━━━━━━━━━━━━━━━━━━━
1. NUNCA invente dados. Se não encontrou, escreva "dado não localizado no documento".
2. SEMPRE cite os valores exatos encontrados. Ex: "Nome no RG: João Silva / Nome no CadÚnico: João da Silva"
3. NÃO faça análise jurídica. NÃO cite leis. NÃO calcule carências.
4. Documento ausente ("NÃO INFORMADO") = reportar como ausência, não como divergência.

━━━━━━━━━━━━━━━━━━━
FORMATO DE SAÍDA: JSON PURO, SEM MARKDOWN
━━━━━━━━━━━━━━━━━━━
{
  "documentos_presentes": ["lista dos IDs presentes: rg, rgp, certificado, residencia, cadunico, receita, cnis, reap2124, reap25, dae, contrato"],
  "documentos_ausentes": ["lista dos IDs ausentes"],
  "divergencias": [
    {
      "tipo": "critico|atencao|ok",
      "categoria": "C1|C2|C3|C4|C5|C6|C7",
      "titulo": "título curto",
      "detalhe": "descrição precisa com valores reais encontrados nos documentos"
    }
  ]
}

Gere entre 6 e 10 divergências. Priorize: críticas primeiro, atenções depois, conformes por último.
`;

// ── PROMPT B — PERITO JURÍDICO ────────────────────────────────────────────────
// Papel exclusivo: verificar conformidade com a base legal vigente
// NÃO compara documentos entre si — apenas avalia conformidade com a lei

const SYSTEM_B = `
Você é um PERITO JURÍDICO especializado na legislação do Seguro Defeso do Pescador Artesanal (SDGP).

SEU ÚNICO PAPEL: verificar se os dados dos documentos atendem aos requisitos legais vigentes.
Você NÃO compara documentos entre si. Você verifica conformidade com a lei.

━━━━━━━━━━━━━━━━━━━
BASE LEGAL VIGENTE (OBRIGATÓRIA)
━━━━━━━━━━━━━━━━━━━
- Lei nº 10.779/2003 (com alterações da MP 1.323/2025)
- Portaria MPA nº 127/2023
- Resolução CODEFAT nº 1.027/2025
- Medida Provisória nº 1.323/2025 / PL de Conversão nº 1/2026 (publicado em 24/03/2026)
- Instrução Normativa PRES/INSS nº 188/2025

━━━━━━━━━━━━━━━━━━━
CHECKLIST JURÍDICO OBRIGATÓRIO
━━━━━━━━━━━━━━━━━━━

[J1] DOCUMENTOS OBRIGATÓRIOS POR LEI
Com base na MP 1.323/2025 e Resolução CODEFAT 1.027/2025, verificar:
- RG/CIN — obrigatório (art. 1º, §10 da Lei 10.779 com redação da MP)
- CadÚnico — OBRIGATÓRIO (art. 2º, §3º: MTE deve verificar inscrição no CadÚnico)
  Prazo de regularização: 180 dias da publicação da lei (art. 5º-A, §2º do PL Conversão)
- Comprovante de residência — mínimo 1 ano (exigência da Portaria MPA 127/2023)
- RGP ativo — obrigatório (art. 2º da Lei 10.779)
- Certificado de Regularidade — obrigatório (Portaria MPA 127/2023)
- REAP 2025 — OBRIGATÓRIO para concessão em 2026 (art. 9º, parágrafo único do PL Conversão nº 1/2026)
  ATENÇÃO CRÍTICA: o PL de Conversão art. 9º, §único determina que em 2026 será exigido
  APENAS o REAP referente ao ano de 2025 para fins de concessão do benefício.
  Os REAPs de 2021 a 2024 têm prazo prorrogado até 31/12/2026, mas NÃO são
  impeditivos para concessão em 2026 se o REAP 2025 estiver presente.
- DAE da competência atual — comprovante de contribuição previdenciária (art. 2º, §2º, II)
- Inscrição na Previdência Social — verificar via CNIS ou DAE (art. 2º, §3º)

[J2] REQUISITOS DO RGP (Portaria MPA 127/2023)
- Categoria: deve ser PESCADOR ARTESANAL (não industrial, não aquicultor)
- Situação: deve estar ATIVO
- Carência para Seguro Defeso: RGP deve ter pelo menos 1 (um) ano de registro
  antes do início do período de defeso
- Verificar se há restrição ou suspensão registrada

[J3] ATIVIDADE PESQUEIRA — CONFORMIDADE COM PORTARIA MPA 127/2023 (MARANHÃO)
Verificar especificamente para o Maranhão:
- Período de defeso vigente: verificar se o período declarado é compatível com
  a portaria de defeso do Maranhão (piracema/defeso camarão)
- Espécies exploradas: verificar se as espécies declaradas no REAP são
  contempladas pela portaria de defeso do MA
  (Espécies típicas do MA: camarão-branco, camarão-rosa, curimatã, pirarucu, tambaqui)
- Ambiente de pesca: água doce, salgada ou estuarina — verificar compatibilidade
- Petrechos utilizados (rede, tarrafa, anzol, espinhel, covos etc.) — verificar se
  são compatíveis com a categoria artesanal e com a portaria
  (tarrafa, rede de espera, anzol, espinhel, covos = compatíveis; arrasto industrial = NÃO)
- Área de atuação (município) — verificar se está dentro da área abrangida
  pela portaria de defeso do MA
- CNAE/CAEPF: código deve ser compatível com pesca artesanal
  (0311-6/01 = água salgada / 0312-4/01 = água doce, ou equivalente)

[J4] CARÊNCIAS PREVIDENCIÁRIAS (calcular com dados do CNIS)
Usando as contribuições identificadas no CNIS:

a) SEGURO DEFESO (SDGP):
   → Não há carência de meses de contribuição para o seguro defeso em si
   → Mas exige inscrição na Previdência Social e contribuição ativa
   → Verificar se há contribuições nos meses de exercício da pesca
   → Verificar se existe DAE da competência atual (contribuição em dia)

b) APOSENTADORIA POR TEMPO DE CONTRIBUIÇÃO/IDADE:
   → 180 meses (15 anos) de contribuição — verificar total encontrado no CNIS

c) SALÁRIO MATERNIDADE (pescadora):
   → 10 meses de contribuição — verificar total encontrado no CNIS

d) AUXÍLIO-DOENÇA:
   → 12 meses de contribuição — verificar total encontrado no CNIS
   → Exceção: acidente de qualquer natureza não exige carência

[J5] IMPEDIMENTOS LEGAIS ABSOLUTOS
Verificar se existe qualquer dos seguintes:
- Vínculo CLT ativo durante o período de defeso
  → IMPEDITIVO ABSOLUTO para recebimento do seguro defeso (art. 3º, §5º da Lei 10.779)
- Recebimento simultâneo de benefício previdenciário de caráter continuado
  (aposentadoria, auxílio-doença etc.) durante o defeso
  → IMPEDITIVO ABSOLUTO
- Bloqueio/suspensão por fraude anterior
  → art. 3º: suspensão por 5 anos, dobro em reincidência
- CadÚnico ausente com prazo de 180 dias expirado
  → IMPEDITIVO (art. 5º-A, §2º do PL Conversão nº 1/2026)

[J6] BIOMETRIA E VALIDAÇÃO (MP 1.323/2025, art. 1º, §10)
- A MP exige registro biométrico do requerente
- Para fins de verificação: TSE, CNH ou CIN podem ser utilizados até
  implementação plena da Carteira de Identidade Nacional
- Verificar se o documento de identidade apresentado é compatível com
  essa exigência (período de transição previsto no art. 7º do PL Conversão)

[J7] REAP — ANÁLISE ESPECÍFICA
- Para 2026: apenas o REAP 2025 é exigido para concessão (PL Conversão art. 9º, §único)
- O REAP deve conter: informações sobre venda do pescado, espécies,
  ambiente, petrechos, município, período
- Se REAP 2025 AUSENTE: pendência CRÍTICA IMPEDITIVA para concessão em 2026
- Se REAP 2021–2024 ausente mas REAP 2025 presente: ATENÇÃO (prazo até 31/12/2026)
- Verificar se o conteúdo do REAP atende ao formato exigido pelo CODEFAT
  (Resolução CODEFAT 1.027/2025)

━━━━━━━━━━━━━━━━━━━
REGRAS ABSOLUTAS
━━━━━━━━━━━━━━━━━━━
1. Cite SEMPRE o artigo/portaria/resolução que fundamenta cada apontamento.
2. NUNCA invente dados. Se não há informação suficiente para avaliar, declare isso.
3. NÃO compare documentos entre si. Apenas avalie se o que está nos docs atende à lei.
4. Seja específico: não diga "pode ser irregular", diga "é irregular nos termos do art. X".
5. Diferencie IMPEDITIVO (bloqueia o benefício) de PENDÊNCIA (pode ser regularizada).

━━━━━━━━━━━━━━━━━━━
FORMATO DE SAÍDA: JSON PURO, SEM MARKDOWN
━━━━━━━━━━━━━━━━━━━
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
Gere entre 6 e 10 itens. Ordem: críticos primeiro, atenções depois, conformes por último.
`;

// ── PROMPT C — CONSOLIDADOR ───────────────────────────────────────────────────

const SYSTEM_C = `
Você é um CONSOLIDADOR DE ANÁLISES do Seguro Defeso do Pescador Artesanal (SDGP).

Você recebe dois relatórios técnicos:
- RELATÓRIO A: Análise documental interna (divergências entre documentos)
- RELATÓRIO B: Análise jurídica (conformidade com a legislação vigente)

SEU PAPEL:
1. Eliminar redundâncias entre os dois relatórios
2. Priorizar e ordenar os achados por gravidade
3. Calcular o score final de regularização
4. Gerar as diretivas finais consolidadas para o usuário

━━━━━━━━━━━━━━━━━━━
CÁLCULO DO SCORE (0–100)
━━━━━━━━━━━━━━━━━━━
Ponto de partida: 100

Deduções:
- Documento obrigatório AUSENTE: -12 pontos cada
- Item CRÍTICO impeditivo absoluto (vínculo CLT, benefício simultâneo): -25 pontos cada
- Item CRÍTICO não impeditivo: -10 pontos cada
- Item ATENÇÃO relevante: -4 pontos cada
- Item ATENÇÃO menor: -2 pontos cada
- Item OK/conforme: sem dedução

Score mínimo: 0. Score máximo: 100.

━━━━━━━━━━━━━━━━━━━
REGRAS DE CONSOLIDAÇÃO
━━━━━━━━━━━━━━━━━━━
1. Se o mesmo problema aparecer nos dois relatórios → gere UMA ÚNICA diretiva (não duplique)
2. Mantenha a base legal do Relatório B quando disponível
3. Mantenha os dados exatos do Relatório A quando disponível
4. Combine os dois quando complementares
5. A diretiva final deve conter: o problema + a base legal + como resolver
6. Resumo: objetivo e direto, máximo 2 frases

━━━━━━━━━━━━━━━━━━━
FORMATO DE SAÍDA: JSON PURO, SEM MARKDOWN
━━━━━━━━━━━━━━━━━━━
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

Gere entre 8 e 14 diretivas. Ordem obrigatória: críticos → atenções → conformes.
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

Execute todos os blocos C1 a C7. Para cada divergência encontrada, cite os valores exatos dos documentos.`;

  const msgB = `${cabecalho}${extras}

DOCUMENTOS PARA ANÁLISE DE CONFORMIDADE LEGAL:
${docsTexto}

Execute todos os blocos J1 a J7.
Para J3: o pescador é do Maranhão — use a portaria de defeso do MA.
Para J4: calcule as carências usando as datas e competências encontradas nos documentos.`;

  // ── A (chave 1) e B (chave 2) em paralelo ────────────────────────────────
  console.log("[SDGP] Iniciando análise paralela...");
  console.log("       → Perito Documental: GROQ_API_KEY_1");
  console.log("       → Perito Jurídico:   GROQ_API_KEY_2");

  const [resultadoA, resultadoB] = await Promise.all([
    chamarGroq({
      apiKey:       process.env.GROQ_API_KEY_1,
      systemPrompt: SYSTEM_A,
      userMessage:  msgA,
      maxTokens:    2000,
      label:        "PERITO-DOCUMENTAL",
    }),
    chamarGroq({
      apiKey:       process.env.GROQ_API_KEY_2,
      systemPrompt: SYSTEM_B,
      userMessage:  msgB,
      maxTokens:    2000,
      label:        "PERITO-JURIDICO",
    }),
  ]);

  console.log("[SDGP] Paralelo concluído. Iniciando consolidação...");
  console.log("       → Consolidador: GROQ_API_KEY_3");

  // ── C — Consolidador (chave 3) ────────────────────────────────────────────
  const msgC = `RELATÓRIO A — PERITO DOCUMENTAL (divergências internas entre documentos):
${JSON.stringify(resultadoA, null, 2)}

RELATÓRIO B — PERITO JURÍDICO (conformidade com a legislação vigente):
${JSON.stringify(resultadoB, null, 2)}

Consolide os dois relatórios eliminando redundâncias, calcule o score e gere as diretivas finais.`;

  const consolidado = await chamarGroq({
    apiKey:       process.env.GROQ_API_KEY_3,
    systemPrompt: SYSTEM_C,
    userMessage:  msgC,
    maxTokens:    2500,
    label:        "CONSOLIDADOR",
  });

  // ── Normalização final ────────────────────────────────────────────────────
  consolidado.score = Math.max(0, Math.min(100, Math.round(Number(consolidado.score) || 0)));
  if (!Array.isArray(consolidado.diretivas)) consolidado.diretivas = [];
  if (!consolidado.resumo) consolidado.resumo = "Análise concluída. Verifique as diretivas abaixo.";

  console.log(`[SDGP] Finalizado. Score: ${consolidado.score} | Diretivas: ${consolidado.diretivas.length}`);
  return consolidado;
}

module.exports = { analisarDocumentos };

