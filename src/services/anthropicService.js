// src/services/anthropicService.js
//
// Pipeline de 3 chamadas em chaves Groq independentes:
//
//  CHAMADA A — Perito Documental → GROQ_API_KEY_1 → llama-3.1-8b-instant  (6.000 TPM)
//  CHAMADA B — Perito Jurídico   → GROQ_API_KEY_2 → llama-3.3-70b-versatile (6.000 TPM)
//  CHAMADA C — Consolidador      → GROQ_API_KEY_3 → llama-3.3-70b-versatile (6.000 TPM)
//
//  A + B rodam em paralelo (Promise.all) → sem overhead de tempo.
//  Cada chave deve ser de uma organização Groq diferente.
//  O OCR é limpo antes de enviar — remove ruído sem perder dados relevantes.
// ─────────────────────────────────────────────────────────────────────────────

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODELO_A = "llama-3.1-8b-instant";     // Perito Documental — cruzamento de dados
const MODELO_B = "llama-3.3-70b-versatile";  // Perito Jurídico   — raciocínio legal
const MODELO_C = "llama-3.3-70b-versatile";  // Consolidador      — síntese final

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

// ── LIMPEZA DE OCR ───────────────────────────────────────────────────────────
// Remove ruído do OCR preservando 100% das informações relevantes.
// Reduz tokens de ~3.000 para ~1.200 por documento sem perda de dados úteis.

function limparOCR(texto, maxChars = 800) {
  if (!texto || typeof texto !== "string") return "";

  return texto
    // 1. Normalizar quebras de linha
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")

    // 2. Remover linhas compostas só de caracteres decorativos (bordas, separadores)
    .replace(/^[\s\-=_*#|~.]{3,}$/gm, "")

    // 3. Remover sequências repetidas de caracteres não alfanuméricos
    //    Ex: "-----", ".....", "=====", "______"
    .replace(/([^a-zA-Z0-9àáâãéêíóôõúüçÀÁÂÃÉÊÍÓÔÕÚÜÇ\s])\1{2,}/g, "")

    // 4. Remover linhas com menos de 3 caracteres úteis (ruído puro do OCR)
    .split("\n")
    .filter(linha => linha.replace(/\s/g, "").length >= 3)
    .join("\n")

    // 5. Colapsar múltiplas linhas em branco para uma só
    .replace(/\n{3,}/g, "\n\n")

    // 6. Colapsar múltiplos espaços/tabs em um único espaço
    .replace(/[ \t]{2,}/g, " ")

    // 7. Trim final
    .trim()

    // 8. Limitar tamanho — só após limpeza para não cortar dado útil no meio
    .slice(0, maxChars);
}

function montarDocsTexto(documentos) {
  return Object.entries(LABELS)
    .map(([k, l]) => {
      const raw = documentos[k]?.trim() || "";
      const texto = raw.length > 0 ? limparOCR(raw) : "NÃO INFORMADO";
      return `[${l}]:\n${texto}`;
    })
    .join("\n\n");
}

// ── CHAMADA GROQ GENÉRICA ────────────────────────────────────────────────────

async function chamarGroq({ apiKey, modelo, systemPrompt, userMessage, maxTokens = 2000, label }) {
  if (!apiKey) throw new Error(`[${label}] Chave de API ausente. Verifique o .env.`);

  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelo,
      temperature: 0.1,
      max_tokens: maxTokens,
      // Força retorno em JSON puro — sem markdown, sem texto livre
      response_format: { type: "json_object" },
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

  // Capturar uso de tokens reportado pela API
  const usage = data.usage || {};
  const tokensEntrada = usage.prompt_tokens     || 0;
  const tokensSaida   = usage.completion_tokens || 0;
  const tokensTotal   = usage.total_tokens      || (tokensEntrada + tokensSaida);

  // Limpar fences de markdown residuais
  let raw = (data.choices?.[0]?.message?.content || "").trim();
  raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

  // Se vier texto antes do JSON, extrair só o objeto
  const jsonStart = raw.indexOf("{");
  if (jsonStart > 0) raw = raw.slice(jsonStart);

  try {
    const parsed = JSON.parse(raw);
    // Anexar usage ao resultado para consolidação de métricas
    parsed.__usage = { label, modelo, tokensEntrada, tokensSaida, tokensTotal };
    return parsed;
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
NORMALIZAÇÃO OBRIGATÓRIA ANTES DE QUALQUER COMPARAÇÃO
━━━━━━━━━━━━━━━━━━━
Antes de comparar QUALQUER valor entre documentos, aplique estas normalizações:

DATAS — formatos diferentes do mesmo dia são IGUAIS:
  "15/03/1985" = "15 de março de 1985" = "1985-03-15" = "15-03-85" → IGUAIS, não reportar
  Só é divergência se dia, mês ou ano forem numericamente diferentes.

ENDEREÇOS — variações de escrita são IGUAIS:
  "Rua" = "R." = "RUA" → mesma coisa
  "Avenida" = "Av." = "AV" → mesma coisa
  Maiúsculas/minúsculas não são divergência.
  Acentuação inconsistente do OCR (ex: "Anajatuba" vs "Anajatuba") → ignorar.
  Espaços duplos ou simples → ignorar.
  Só é divergência se o nome da rua, número ou município forem SEMANTICAMENTE diferentes.

NOMES — variações de escrita são IGUAIS:
  Maiúsculas/minúsculas não são divergência ("JOÃO SILVA" = "João Silva").
  Acentuação inconsistente do OCR → ignorar.
  Só é divergência se uma parte do nome estiver ausente ou trocada.

DOCUMENTOS IDÊNTICOS — se o mesmo arquivo foi enviado em dois campos:
  Os dados serão idênticos. Não reportar como divergência — reportar como "ok".

ARTEFATOS DE OCR — não são divergências:
  Caracteres estranhos isolados, espaços extras, quebras de linha inesperadas
  são erros do OCR, não diferenças reais nos documentos.

SE APÓS NORMALIZAÇÃO OS VALORES FOREM IGUAIS → tipo "ok", NUNCA reportar como divergência.
SE APÓS NORMALIZAÇÃO OS VALORES FOREM DIFERENTES → aí sim reportar com os valores exatos.

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
4. Documento ausente ("NÃO INFORMADO") = reportar como ausência no C1, mas NÃO bloqueia
   a análise dos demais blocos. Analise SEMPRE todos os documentos que estiverem presentes,
   independentemente de quantos foram enviados. Mesmo com 1 documento, faça a análise.
5. NUNCA use IDs inventados. Use APENAS os IDs exatos desta lista:
   rg · rgp · certificado · residencia · cadunico · receita · cnis · reap2124 · reap25 · dae · contrato

━━━━━━━━━━━━━━━━━━━
FORMATO DE SAÍDA: JSON PURO, SEM MARKDOWN
━━━━━━━━━━━━━━━━━━━
ATENÇÃO: os campos "documentos_presentes" e "documentos_ausentes" devem conter
APENAS os IDs exatos desta lista (nada mais, nada menos):
rg · rgp · certificado · residencia · cadunico · receita · cnis · reap2124 · reap25 · dae · contrato

{
  "documentos_presentes": ["rg", "cadunico"],
  "documentos_ausentes": ["rgp", "certificado", "residencia", "receita", "cnis", "reap2124", "reap25", "dae", "contrato"],
  "divergencias": [
    {
      "tipo": "critico|atencao|ok",
      "categoria": "C1|C2|C3|C4|C5|C6|C7",
      "titulo": "título curto",
      "detalhe": "descrição precisa com valores reais encontrados nos documentos"
    }
  ]
}

REGRA ANTI-CONTRADIÇÃO (OBRIGATÓRIA):
- Valores IGUAIS entre documentos = tipo "ok", NUNCA reportar como divergência
- Mesmo município, mesmo nome, mesma data = CONFORME, não divergente
- Só gere uma diretiva de divergência se os valores forem REALMENTE diferentes
- NÃO invente problemas para atingir um número mínimo
- Se não houver divergência em um bloco, registre como "ok" com detalhe "Sem divergências identificadas"
- Gere apenas divergências REAIS — pode ser 1, pode ser 10, conforme o que encontrar
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

[J3] ATIVIDADE PESQUEIRA — VALIDAÇÃO TRIANGULAR POR PORTARIA (MARANHÃO)

IMPORTANTE: Existem duas portarias de defeso aplicáveis ao MA com regras distintas.
A validação deve ser feita em 4 etapas obrigatórias:

ETAPA 1 — IDENTIFICAR PORTARIA PELO MUNICÍPIO DE RESIDÊNCIA (CadÚnico):
Use o município do CadÚnico como base e verifique em qual portaria ele se enquadra.

  PORTARIA 75/17 — Portaria Interministerial MDIC/MMA nº 75/2017
  Período de defeso: 01/01 a 31/05
  Ambiente: MARINHO (água salgada / estuarina)
  Área de pesca: Mar ou Estuário
  Espécies permitidas: camarão-rosa (Farfantepenaeus brasiliensis) e camarão-branco (Litopenaeus schmitti)
  Petrechos compatíveis: rede de arrasto artesanal, tarrafa, rede de espera
  CNAE compatível: 0311-6/01 (pesca em água salgada)
  Municípios MA abrangidos (62 municípios):
  Água Doce do Maranhão, Alcântara, Amapá do Maranhão, Anajatuba, Apicum-Açu, Araioses,
  Axixá, Bacabeira, Bacuri, Bacurituba, Barreirinhas, Belágua, Bequimão, Boa Vista do Gurupi,
  Cachoeira Grande, Cajapió, Cândido Mendes, Carutapera, Cedral, Central do Maranhão,
  Cururupu, Godofredo Viana, Governador Nunes Freire, Guimarães, Humberto de Campos,
  Icatu, Ilha Grande, Itapecuru Mirim, Junco do Maranhão, Luís Domingues,
  Magalhães de Almeida, Maracaçumé, Matinha, Mirinzal, Morros, Olinda Nova do Maranhão,
  Paulino Neves, Paço do Lumiar, Peri Mirim, Pinheiro, Porto Rico do Maranhão,
  Presidente Juscelino, Primeira Cruz, Raposa, Rosário, Santa Helena,
  Santa Quitéria do Maranhão, Santa Rita, Santana do Maranhão, Santo Amaro do Maranhão,
  Serrano do Maranhão, São Bento, São Bernardo, São João Batista, São José de Ribamar,
  São Luís, São Vicente Ferrer, Turiaçu, Turilândia, Tutóia, Urbano Santos, Viana

  PORTARIA 85/03 — Portaria IBAMA nº 85/2003
  Período de defeso: 01/12 a 30/03
  Ambiente: CONTINENTAL (água doce)
  Área de pesca: Rio ou Lago (bacias hidrográficas continentais)
  Espécies permitidas: todas as espécies ocorrentes nas bacias continentais do MA
  (curimatã, tambaqui, pirarucu, jaraqui, matrinxã, pacu e demais espécies de rio)
  Petrechos compatíveis: tarrafa, rede de espera, anzol, espinhel, covo
  CNAE compatível: 0312-4/01 (pesca em água doce)
  Municípios MA abrangidos (217 municípios — inclui todos os da Portaria 75 exceto Ilha Grande,
  mais municípios exclusivamente continentais como: Açailândia, Aldeias Altas, Altamira do Maranhão,
  Alto Alegre do Maranhão, Alto Alegre do Pindaré, Alto Parnaíba, Amarante do Maranhão,
  Anapurus, Araguanã, Arame, Arari, Bacabal, Balsas, Barra do Corda, Barão de Grajaú,
  Bela Vista do Maranhão, Benedito Leite, Bernardo do Mearim, Bom Jardim, Bom Jesus das Selvas,
  Bom Lugar, Brejo, Brejo de Areia, Buriti, Buriti Bravo, Buriticupu, Buritirana,
  Cajari, Campestre do Maranhão, Cantanhede, Capinzal do Norte, Carolina, Caxias,
  Centro Novo do Maranhão, Centro do Guilherme, Chapadinha, Cidelândia, Codó, Coelho Neto,
  Colinas, Conceição do Lago-Açu, Coroatá, Davinópolis, Dom Pedro, Duque Bacelar,
  Esperantinópolis, Estreito, Feira Nova do Maranhão, Fernando Falcão, Formosa da Serra Negra,
  Fortaleza dos Nogueiras, Fortuna, Gonçalves Dias, Governador Archer, Governador Edison Lobão,
  Governador Eugênio Barros, Governador Luiz Rocha, Governador Newton Bello, Grajaú,
  Graça Aranha, Igarapé Grande, Igarapé do Meio, Imperatriz, Itaipava do Grajaú,
  Itinga do Maranhão, Jatobá, Jenipapo dos Vieiras, Joselândia, João Lisboa,
  Lago Verde, Lago da Pedra, Lago do Junco, Lago dos Rodrigues, Lagoa Grande do Maranhão,
  Lagoa do Mato, Lajeado Novo, Lima Campos, Loreto, Marajá do Sena, Maranhãozinho,
  Mata Roma, Matões, Matões do Norte, Milagres do Maranhão, Mirador, Miranda do Norte,
  Montes Altos, Monção, Nina Rodrigues, Nova Colinas, Nova Iorque, Nova Olinda do Maranhão,
  Olho d Água das Cunhãs, Palmeirândia, Paraibano, Parnarama, Passagem Franca, Pastos Bons,
  Paulo Ramos, Pedreiras, Pedro do Rosário, Penalva, Peritoró, Pindaré-Mirim, Pio XII,
  Pirapemas, Porto Franco, Poção de Pedras, Presidente Dutra, Presidente Médici,
  Presidente Sarney, Presidente Vargas, Riachão, Ribamar Fiquene, Sambaíba,
  Santa Filomena do Maranhão, Santa Inês, Santa Luzia, Santa Luzia do Paruá,
  Santo Antônio dos Lopes, Satubinha, Senador Alexandre Costa, Senador La Rocque,
  Sucupira do Norte, Sucupira do Riachão, São Benedito do Rio Preto,
  São Domingos do Azeitão, São Domingos do Maranhão, São Francisco do Brejão,
  São Francisco do Maranhão, São Félix de Balsas, São José dos Basílios, São João do Carú,
  São João do Paraíso, São João do Soter, São João dos Patos, São Luís Gonzaga do Maranhão,
  São Mateus do Maranhão, São Pedro da Água Branca, São Pedro dos Crentes,
  São Raimundo das Mangabeiras, São Raimundo do Doca Bezerra, São Roberto,
  Sítio Novo, Tasso Fragoso, Timbiras, Timon, Trizidela do Vale, Tufilândia, Tuntum,
  Vargem Grande, Vila Nova dos Martírios, Vitorino Freire, Vitória do Mearim, Zé Doca,
  e todos os 61 municípios da Portaria 75 exceto Ilha Grande)

ETAPA 2 — MUNICÍPIOS COM DUPLA ABRANGÊNCIA (61 municípios nas duas portarias):
Os seguintes municípios se enquadram em AMBAS as portarias — o pescador pode exercer
pesca continental (P85) E/OU pesca marinha (P75). Nesse caso verificar qual o REAP declara
e se a declaração é INTERNAMENTE CONSISTENTE (ambiente + área + produto + portaria):
Água Doce do Maranhão, Alcântara, Amapá do Maranhão, Anajatuba, Apicum-Açu, Araioses,
Axixá, Bacabeira, Bacuri, Bacurituba, Barreirinhas, Belágua, Bequimão, Boa Vista do Gurupi,
Cachoeira Grande, Cajapió, Cândido Mendes, Carutapera, Cedral, Central do Maranhão,
Cururupu, Godofredo Viana, Governador Nunes Freire, Guimarães, Humberto de Campos,
Icatu, Itapecuru Mirim, Junco do Maranhão, Luís Domingues, Magalhães de Almeida,
Maracaçumé, Matinha, Mirinzal, Morros, Olinda Nova do Maranhão, Paulino Neves,
Paço do Lumiar, Peri Mirim, Pinheiro, Porto Rico do Maranhão, Presidente Juscelino,
Primeira Cruz, Raposa, Rosário, Santa Helena, Santa Quitéria do Maranhão, Santa Rita,
Santana do Maranhão, Santo Amaro do Maranhão, Serrano do Maranhão, São Bento,
São Bernardo, São João Batista, São José de Ribamar, São Luís, São Vicente Ferrer,
Turiaçu, Turilândia, Tutóia, Urbano Santos, Viana

ETAPA 3 — VALIDAÇÃO TRIANGULAR OBRIGATÓRIA:
Para cada portaria identificada, verificar se os 3 elementos do REAP são compatíveis SIMULTANEAMENTE:

  SE PORTARIA 75 (marinha):
  ✓ Ambiente deve ser: marinho / água salgada / estuarina
  ✓ Área deve ser: mar ou estuário (NÃO pode ser rio ou lago)
  ✓ Produto deve ser: camarão-rosa ou camarão-branco
  ✗ INCOMPATÍVEL: ambiente água doce + produto peixe + portaria 75

  SE PORTARIA 85 (continental):
  ✓ Ambiente deve ser: continental / água doce / rio / lago
  ✓ Área deve ser: rio ou lago (NÃO pode ser mar ou estuário)
  ✓ Produto deve ser: espécies de água doce (curimatã, tambaqui, pirarucu, jaraqui etc.)
  ✗ INCOMPATÍVEL: ambiente marinho + produto camarão + portaria 85

  SE MUNICÍPIO DUPLO e REAP declara AMBAS as portarias:
  → Verificar se cada conjunto (portaria + ambiente + área + produto) é individualmente consistente

ETAPA 4 — CRUZAMENTO COM MUNICÍPIO DE PESCA (REAP):
- Município de residência (CadÚnico) → portaria(s) aplicável(is)
- Município de pesca (REAP) → deve estar na mesma portaria ou ser limítrofe
- Se município de pesca NÃO estiver na portaria identificada → CRÍTICO
- Petrechos compatíveis com a categoria artesanal e com a portaria identificada?

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
  console.log("       → Perito Documental: GROQ_API_KEY_1 (llama-3.1-8b-instant)");
  console.log("       → Perito Jurídico:   GROQ_API_KEY_2 (llama-3.3-70b-versatile)");

  const [resultadoA, resultadoB] = await Promise.all([
    chamarGroq({
      apiKey:       process.env.GROQ_API_KEY_1,
      modelo:       MODELO_A,
      systemPrompt: SYSTEM_A,
      userMessage:  msgA,
      maxTokens:    2000,
      label:        "PERITO-DOCUMENTAL",
    }),
    chamarGroq({
      apiKey:       process.env.GROQ_API_KEY_2,
      modelo:       MODELO_B,
      systemPrompt: SYSTEM_B,
      userMessage:  msgB,
      maxTokens:    2000,
      label:        "PERITO-JURIDICO",
    }),
  ]);

  console.log("[SDGP] Paralelo concluído. Iniciando consolidação...");
  console.log("       → Consolidador: GROQ_API_KEY_3 (llama-3.3-70b-versatile)");

  // ── C — Consolidador (chave 3) ────────────────────────────────────────────
  const msgC = `RELATÓRIO A — PERITO DOCUMENTAL (divergências internas entre documentos):
${JSON.stringify(resultadoA, null, 2)}

RELATÓRIO B — PERITO JURÍDICO (conformidade com a legislação vigente):
${JSON.stringify(resultadoB, null, 2)}

Consolide os dois relatórios eliminando redundâncias, calcule o score e gere as diretivas finais.`;

  const consolidado = await chamarGroq({
    apiKey:       process.env.GROQ_API_KEY_3,
    modelo:       MODELO_C,
    systemPrompt: SYSTEM_C,
    userMessage:  msgC,
    maxTokens:    2500,
    label:        "CONSOLIDADOR",
  });

  // ── Normalização final ────────────────────────────────────────────────────
  consolidado.score = Math.max(0, Math.min(100, Math.round(Number(consolidado.score) || 0)));
  if (!Array.isArray(consolidado.diretivas)) consolidado.diretivas = [];
  if (!consolidado.resumo) consolidado.resumo = "Análise concluída. Verifique as diretivas abaixo.";

  // ── Métricas de tokens das 3 chamadas ────────────────────────────────────
  const usageA = resultadoA.__usage || {};
  const usageB = resultadoB.__usage || {};
  const usageC = consolidado.__usage || {};

  // Remover __usage do resultado final (não deve ir para o frontend)
  delete resultadoA.__usage;
  delete resultadoB.__usage;
  delete consolidado.__usage;

  const totalInput  = (usageA.tokensEntrada || 0) + (usageB.tokensEntrada || 0) + (usageC.tokensEntrada || 0);
  const totalOutput = (usageA.tokensSaida   || 0) + (usageB.tokensSaida   || 0) + (usageC.tokensSaida   || 0);
  const totalGeral  = totalInput + totalOutput;

  // ── Tabela de preços por modelo (USD por 1M tokens) ──────────────────────
  // Fonte: preços públicos — atualizar conforme necessário
  const PRECOS = {
    "llama-3.1-8b-instant":    { input: 0.05,  output: 0.08  }, // Groq on-demand
    "llama-3.3-70b-versatile": { input: 0.59,  output: 0.79  }, // Groq on-demand
    "claude-sonnet-4-5":       { input: 3.00,  output: 15.00 }, // Anthropic
    "claude-opus-4":           { input: 15.00, output: 75.00 }, // Anthropic
    "gpt-4o":                  { input: 2.50,  output: 10.00 }, // OpenAI
    "gpt-4o-mini":             { input: 0.15,  output: 0.60  }, // OpenAI
    "gemini-2.0-flash":        { input: 0.10,  output: 0.40  }, // Google
  };

  // Cotação USD → BRL (atualizar periodicamente ou buscar via API de câmbio)
  const USD_BRL = parseFloat(process.env.USD_BRL || "4.9655");

  function usdParaBrl(usd) {
    return (usd * USD_BRL).toFixed(6);
  }

  function calcularCusto(modeloNome, tokIn, tokOut) {
    const p = PRECOS[modeloNome];
    if (!p) return null;
    const custoInput  = (tokIn  / 1_000_000) * p.input;
    const custoOutput = (tokOut / 1_000_000) * p.output;
    return (custoInput + custoOutput);
  }

  // Custo real desta análise (modelos usados)
  const custoA = calcularCusto(MODELO_A, usageA.tokensEntrada || 0, usageA.tokensSaida || 0);
  const custoB = calcularCusto(MODELO_B, usageB.tokensEntrada || 0, usageB.tokensSaida || 0);
  const custoC = calcularCusto(MODELO_C, usageC.tokensEntrada || 0, usageC.tokensSaida || 0);
  const custoReal = (custoA || 0) + (custoB || 0) + (custoC || 0);

  // Projeção: e se usasse modelo pago para todas as 3 chamadas?
  function projetarCusto(modeloNome) {
    const usd = calcularCusto(modeloNome, totalInput, totalOutput);
    if (usd === null) return "N/A";
    return `U$ ${usd.toFixed(6)}  (R$ ${usdParaBrl(usd)})`;
  }

  console.log("\n┌──────────────────────────────────────────────────────────────┐");
  console.log("│                    SDGP — USO DE TOKENS                      │");
  console.log("├──────────────────────┬──────────┬──────────┬─────────────────┤");
  console.log("│ Chamada              │  Entrada │   Saída  │       Total      │");
  console.log("├──────────────────────┼──────────┼──────────┼─────────────────┤");
  console.log(`│ A Perito Documental  │ ${String(usageA.tokensEntrada||0).padStart(8)} │ ${String(usageA.tokensSaida||0).padStart(8)} │ ${String(usageA.tokensTotal||0).padStart(15)} │`);
  console.log(`│ B Perito Jurídico    │ ${String(usageB.tokensEntrada||0).padStart(8)} │ ${String(usageB.tokensSaida||0).padStart(8)} │ ${String(usageB.tokensTotal||0).padStart(15)} │`);
  console.log(`│ C Consolidador       │ ${String(usageC.tokensEntrada||0).padStart(8)} │ ${String(usageC.tokensSaida||0).padStart(8)} │ ${String(usageC.tokensTotal||0).padStart(15)} │`);
  console.log("├──────────────────────┼──────────┼──────────┼─────────────────┤");
  console.log(`│ TOTAL                │ ${String(totalInput).padStart(8)} │ ${String(totalOutput).padStart(8)} │ ${String(totalGeral).padStart(15)} │`);
  console.log("└──────────────────────┴──────────┴──────────┴─────────────────┘");
  console.log(`\n  Cotação utilizada: 1 USD = R$ ${USD_BRL.toFixed(4)}`);
  console.log("\n  Custo real desta análise (Groq on-demand):");
  console.log(`  A (llama-3.1-8b-instant):    U$ ${(custoA||0).toFixed(6)}  (R$ ${usdParaBrl(custoA||0)})`);
  console.log(`  B (llama-3.3-70b-versatile): U$ ${(custoB||0).toFixed(6)}  (R$ ${usdParaBrl(custoB||0)})`);
  console.log(`  C (llama-3.3-70b-versatile): U$ ${(custoC||0).toFixed(6)}  (R$ ${usdParaBrl(custoC||0)})`);
  console.log(`  TOTAL REAL:                  U$ ${custoReal.toFixed(6)}  (R$ ${usdParaBrl(custoReal)})`);
  console.log("\n  Projeção: se usasse modelo pago para todas as chamadas:");
  console.log(`  claude-sonnet-4-5:   ${projetarCusto("claude-sonnet-4-5")}`);
  console.log(`  claude-opus-4:       ${projetarCusto("claude-opus-4")}`);
  console.log(`  gpt-4o:              ${projetarCusto("gpt-4o")}`);
  console.log(`  gpt-4o-mini:         ${projetarCusto("gpt-4o-mini")}`);
  console.log(`  gemini-2.0-flash:    ${projetarCusto("gemini-2.0-flash")}`);
  console.log(`\n  Score: ${consolidado.score} | Diretivas: ${consolidado.diretivas.length}\n`);

  return consolidado;
}

module.exports = { analisarDocumentos };