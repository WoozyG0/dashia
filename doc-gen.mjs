// Dash.IA — dashboard a partir de DOCUMENTO (CSV/XLSX), 100% genérico (domínio inferido do arquivo)
// Orquestração: (1) ENTENDER os dados → (2) MONTAR painéis a partir do entendimento →
// (3) INSIGHTS em lote com os dados JÁ AGREGADOS (vêm prontos; a lâmpada só revela).
import { agentText, extractJson } from "./anthropic.mjs";

const MODEL = process.env.DASH_MODEL ?? "sonnet";

// ── (1)+(2) Entender e montar — uma chamada, entendimento ANTES dos painéis ────────────────────────
const SYS_BUILD = `Você é um analista de dados sênior. Recebe uma planilha de DOMÍNIO DESCONHECIDO (colunas + estatísticas + amostra)
e monta um dashboard. O DIFERENCIAL é ENTENDER os dados de verdade ANTES de visualizar — não jogue números num template.

Responda APENAS JSON (sem markdown):
{
  "title": "título do dashboard — se houver pedido, reflita O PEDIDO (com o recorte/período); senão, o que os dados REALMENTE são",
  "understanding": {
    "domain": "que tipo de dado é este, inferido do CONTEÚDO (ex.: notas fiscais de venda, chamados de suporte, folha de ponto). Seja específico.",
    "grain": "o que representa CADA linha da planilha",
    "columnRoles": { "<nome exato da coluna>": "dimensão|medida|data|identificador|código|texto" },
    "request": {
      "asked": "resumo fiel do que o usuário pediu: métrica(s), dimensão(ões), período/filtros",
      "map": { "<termo do pedido>": "<coluna EXATA que o atende>" },
      "unmapped": ["termo do pedido SEM coluna correspondente no arquivo"]
    },
    "keyFindings": ["achado REAL já visível nas estatísticas, com número (ex.: 'SP concentra 26% das 27.564 notas')"],
    "angles": ["ângulo de análise que vale a pena explorar neste dataset"]
  },
  "tiles": [ TILE, ... ]
}

Cada TILE:
- "kind": "kpi" | "chart" | "insight" | "table"
- "title": rótulo claro — inclua o recorte quando houver filtro (ex.: "Faturamento por Família · 2024-2025")
- "dim": NOME EXATO de coluna de dimensão (eixo X / categoria) — só chart
- "dim2": segunda dimensão (vira séries EMPILHADAS no gráfico) — opcional, só bar/area com agg sum|count
- "measure": NOME EXATO de coluna de MÉTRICA (valor/quantidade) — kpi e chart. NUNCA um identificador/código como measure de soma.
- "agg": "sum" | "count" | "countdistinct" | "avg" | "min" | "max" | "share"
  · "share" = PARTICIPAÇÃO PERCENTUAL no total. Em chart: cada categoria vira % do total (soma 100) — use quando o pedido/ângulo é proporção, não valor absoluto. Em kpi: exige "shareWhere".
- "shareWhere": [{...mesmo formato de filters...}] — só kpi com agg "share": define o NUMERADOR (ex.: % do faturamento vindo de SP → shareWhere UF=SP); o denominador são as linhas do painel (após "filters").
- "bucket": "month" | "year" — só chart com dim de DATA: agrupa a série por mês/ano ("month" para evolução; NUNCA deixe uma linha com 1 ponto por dia se o período passa de 2 meses).
- "limit": N (3-50) e "order": "asc" — top N (padrão: maiores) ou, com order "asc", os N MENORES/piores.
- "format": "currency" | "percent" — como exibir o valor (kpi/chart). Dinheiro (R$) SEMPRE "currency".
- "chartType": "bar" | "line" | "pie" | "area" | "map" — só chart
- "columns": lista de NOMES EXATOS — só table (4 a 8, as mais relevantes)
- "filters": [{"col":"<coluna exata>","op":"=|!=|in|contains|>=|<=|>|<|between","value":...,"value2":...}] — opcional; aplicado ANTES da agregação (vale p/ kpi, chart e table). Datas SEMPRE em ISO completo (between "2024-01-01" e "2025-12-31" — nunca só o ano).
- "narrative": só insight → 3-5 frases analíticas com números reais das estatísticas
- "w": 3 (kpi) | 6 (chart/insight) | 12 (table/map)

INTENÇÃO DO PEDIDO — traduza o vocabulário do usuário na forma certa (errar isso é entregar outra coisa):
- "percentual / proporção / participação / fatia / share / %" → agg "share" (NUNCA valores absolutos)
- "evolução / tendência / ao longo do tempo / mensal / por mês" → line com bucket "month"
- "top / maiores / principais" → limit N · "piores / menores" → limit N + order "asc"
- "ticket médio / média por" → avg · "quantos / nº de clientes distintos" → countdistinct

O PEDIDO DO USUÁRIO É UM CONTRATO (prioridade máxima sobre qualquer regra de composição):
- Cada MÉTRICA e DIMENSÃO citada DEVE virar painel correspondente. Ex.: "faturamento por família, marca e estado" = gráfico de faturamento por família + outro por marca + outro por estado (mapa se for UF). Mapeie o termo do usuário à coluna REAL ("estado do cliente" pode ser UF, ESTADO, UF_CLIENTE…) e registre em understanding.request.map.
- PERÍODO/recorte citado ("2024-2025", "só pagos", "região Sul") → "filters" em TODOS os painéis, inclusive KPIs e tabela — e explícito no título do dashboard.
- Os painéis do contrato vêm PRIMEIRO na lista; depois complemente (KPIs do MESMO recorte, 1-2 insights, tabela).
- Termo do pedido sem coluna no arquivo → liste em understanding.request.unmapped e adapte o resto. NUNCA ignore um pedido em silêncio; NUNCA invente coluna.
- Sem pedido específico → visão geral coesa.

REGRAS:
- Baseie CADA painel no ENTENDIMENTO: use os papéis das colunas (measure = medida real; dim = dimensão; eixo temporal = data).
- Use SEMPRE nomes EXATOS das colunas. Nunca invente coluna.
- Composição coesa: 3-4 KPIs, 1-2 insights globais, 3-5 gráficos, 1 tabela = 8-11 painéis.
- data/tempo → "line" com bucket; comparar categorias → "bar"; poucas fatias + 1 medida → "pie"; UF/estado/região do Brasil → "map" w=12.
- Se não houver métrica numérica clara para um painel, use agg "count" (contagem de linhas) ou "countdistinct".

SEJA CRIATIVO NA ANÁLISE — você tem um arsenal, use-o para CONTAR A HISTÓRIA dos dados, não para repetir a mesma forma:
- Misture ângulos DIFERENTES: participação (share), evolução temporal (line+bucket), concentração (top N), cauda (bottom N com order asc), cruzamentos (dim2 empilhada), médias (avg), recortes comparados (mesmo gráfico filtrado de dois jeitos).
- Dois gráficos com a mesma forma e dimensões trocadas revelam menos que dois ângulos diferentes dos mesmos dados.
- Um bom dashboard responde: quanto? (KPIs) · onde se concentra? (share/top) · como evolui? (linha temporal) · o que destoa? (insight/outlier).
- KPIs de dinheiro sempre format "currency"; KPIs de proporção sempre agg "share" + shareWhere.`;

// bloco de contexto escrito pelo usuário — autoridade máxima sobre o significado dos dados
const ctxBlock = (context) => (context && String(context).trim()
  ? `\n\nCONTEXTO FORNECIDO PELO USUÁRIO sobre este documento (autoridade MÁXIMA — vale mais que qualquer inferência sua sobre colunas, siglas e regras):\n${String(context).trim()}`
  : "");

export async function buildDocDashboard({ columns, sample, stats, nl, context }) {
  const cols = (columns || []).map((c) => `${c.name} (${c.type || "texto"})`).join(", ");
  const statsBlock = stats ? `\n\nESTATÍSTICAS POR COLUNA (dataset completo):\n${stats}` : "";
  const amostra = JSON.stringify((sample || []).slice(0, 15));
  const prompt = `COLUNAS: ${cols}${statsBlock}

AMOSTRA (primeiras linhas):
${amostra}${ctxBlock(context)}

PEDIDO DO USUÁRIO: ${nl || "Entenda os dados e monte o dashboard mais revelador possível (visão geral)."}

Primeiro ENTENDA (preencha "understanding"), depois monte os "tiles" com base nesse entendimento. Responda só o JSON.`;
  return extractJson(await agentText(SYS_BUILD, prompt, MODEL));
}

// ═══ ORQUESTRAÇÃO MULTI-AGENTE ═══════════════════════════════════════════════════════════════════
// orquestrador (entende + planeja a equipe + KPIs globais) → N agentes em paralelo (cada um com a
// SUA fatia de colunas) → montagem → validação FINAL do próprio orquestrador (dedup + validade).
const ORCH_MODEL  = process.env.DASH_ORCH_MODEL  ?? MODEL;
const AGENT_MODEL = process.env.DASH_AGENT_MODEL ?? MODEL;
const AGENT_CONC  = Math.max(1, Number(process.env.DASH_AGENT_CONCURRENCY ?? 3));

// especificação de TILE compartilhada entre agentes (resumo do contrato de SYS_BUILD)
const TILE_SPEC = `Cada TILE:
{"kind":"kpi|chart|insight|table","title":"claro, com o recorte se houver filtro","dim":"coluna exata (chart)","dim2":"2ª dimensão (séries empilhadas; só bar/area com sum|count)","measure":"coluna exata de MÉTRICA (nunca identificador/código)","agg":"sum|count|countdistinct|avg|min|max|share","shareWhere":[{...só kpi share: numerador...}],"bucket":"month|year (dim de data)","limit":N,"order":"asc (menores/piores)","format":"currency|percent","chartType":"bar|line|pie|area|map","columns":["só table"],"filters":[{"col":"coluna exata","op":"=|!=|in|contains|>=|<=|>|<|between","value":...,"value2":...}],"narrative":"só insight","w":3|6|12}
Vocabulário → forma: percentual/proporção/fatia → agg "share" (nunca valores absolutos) · evolução/mensal → line + bucket "month" · top/maiores → limit · piores/menores → limit + order "asc" · dinheiro → format "currency". Datas de filtro SEMPRE ISO completo.`;

const SYS_ORCH = `Você é o ORQUESTRADOR de uma equipe de agentes analistas de dados. Recebe uma planilha de domínio
desconhecido (colunas + estatísticas + amostra) e monta o PLANO DE ANÁLISE: entende os dados de verdade, decide
QUANTOS agentes contratar e qual FATIA das colunas cada um cobre — a quantidade sai da RIQUEZA dos dados
(quantos ângulos distintos valem painel), não de um número fixo.

Responda APENAS JSON (sem markdown):
{
  "title": "título do dashboard (reflita o pedido e o recorte, se houver)",
  "understanding": {
    "domain": "o que estes dados SÃO, inferido do conteúdo — específico",
    "grain": "o que cada linha representa",
    "columnRoles": { "<coluna exata>": "dimensão|medida|data|identificador|código|texto" },
    "request": { "asked": "resumo fiel do pedido", "map": { "<termo>": "<coluna exata>" }, "unmapped": ["termo sem coluna"] },
    "keyFindings": ["achado REAL com número, visível nas estatísticas"],
    "angles": ["ângulo que vale explorar"]
  },
  "globalFilters": [ {"col":"...","op":"...","value":...,"value2":...} ],
  "selfTiles": [ TILES globais que VOCÊ monta: 3-4 KPIs (kind kpi; dinheiro format currency; proporção agg share+shareWhere) e 1 table (4-8 colunas) ],
  "agents": [ { "id": "a1", "focus": "nome curto do ângulo", "goal": "o que o agente deve revelar (1-2 frases, específicas a ESTES dados)", "columns": ["colunas EXATAS da fatia: dimensão(ões) âncora + medidas + data se precisar"], "tiles": 1 ou 2 } ]
}

${TILE_SPEC}

REGRAS DO PLANO:
- 2 a 5 agentes. Cada DIMENSÃO-ÂNCORA pertence a UM só agente (nunca dois agentes no mesmo ângulo). Medidas e colunas de data podem se repetir entre fatias.
- O PEDIDO DO USUÁRIO é CONTRATO: cada dimensão citada vira agente (ou painel garantido); período/recorte citado vira "globalFilters" (todo painel vai herdá-los); termo sem coluna → understanding.request.unmapped.
- Sem pedido específico: escolha os ângulos que melhor CONTAM A HISTÓRIA (participação, evolução temporal, concentração, cruzamentos).
- Os "goal" devem ser diversos: agentes repetindo a mesma forma com dimensão trocada revelam menos que ângulos diferentes.`;

const SYS_AGENT = `Você é um AGENTE ANALISTA focado numa FATIA de uma planilha, contratado por um orquestrador.
Recebe seu OBJETIVO, as colunas da SUA fatia (com estatísticas do dataset completo) e uma amostra.
Monte os painéis (tiles) que melhor cumprem o objetivo — kind "chart" (e "insight" se tiver um achado forte).

${TILE_SPEC}

REGRAS:
- Use SOMENTE colunas da sua fatia, com nomes EXATOS. Nunca invente coluna.
- APLIQUE os FILTROS GLOBAIS (fornecidos) no campo "filters" de TODO painel — são o recorte pedido pelo usuário.
- Gere a quantidade de tiles pedida pelo orquestrador (campo "tiles" do seu contrato). Qualidade > quantidade.
Responda APENAS JSON: {"tiles":[ TILE, ... ]}`;

const SYS_JUDGE = `Você é o ORQUESTRADOR fazendo a REVISÃO FINAL do trabalho dos seus agentes. Recebe o pedido do
usuário, o entendimento do dataset e os PAINÉIS CANDIDATOS (compactos, com id). Sua responsabilidade:
informação NÃO DUPLICADA, VÁLIDA, e o pedido do usuário COBERTO.
Responda APENAS JSON: {"keep":["ids na ORDEM final"],"retitle":{"id":"título melhor"},"drop":[{"id":"...","reason":"por que saiu"}]}
- DUPLICADO: mesmo ângulo (mesma dimensão×medida×agregação) ou dois painéis que contam a mesma coisa — fique com o melhor.
- INVÁLIDO: painel que não responde nada, medida sem sentido para a dimensão, ou que ignora o recorte global.
- ORDEM: KPIs primeiro, depois os gráficos do PEDIDO, depois os complementares, tabela por último.
- Não invente ids. Todo id vai em "keep" OU em "drop".`;

const statsFor = (stats, names) => {
  if (!stats) return "";
  const set = new Set((names || []).map((n) => String(n).toLowerCase()));
  return String(stats).split(/\r?\n/).filter((l) => { const m = l.match(/^\s*(.+?) \[/); return m && set.has(m[1].toLowerCase()); }).join("\n");
};
const pool = async (items, size, fn) => {
  const out = new Array(items.length); let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
};

export async function buildDocDashboardOrchestrated({ columns, sample, stats, nl, context, onProgress = () => {} }) {
  const cols = (columns || []).map((c) => `${c.name} (${c.type || "texto"})`).join(", ");
  const statsBlock = stats ? `\n\nESTATÍSTICAS POR COLUNA (dataset completo):\n${stats}` : "";
  const amostra = (sample || []).slice(0, 15);

  // 1) ORQUESTRADOR: entende, planeja a equipe e monta os KPIs globais
  onProgress({ stage: "orchestrate" });
  const orch = extractJson(await agentText(SYS_ORCH, `COLUNAS: ${cols}${statsBlock}

AMOSTRA (primeiras linhas):
${JSON.stringify(amostra)}${ctxBlock(context)}

PEDIDO DO USUÁRIO: ${nl || "Entenda os dados e monte o dashboard mais revelador possível (visão geral)."}

Monte o plano. Responda só o JSON.`, ORCH_MODEL));
  const agents = (Array.isArray(orch.agents) ? orch.agents : []).slice(0, 6);
  const gf = Array.isArray(orch.globalFilters) ? orch.globalFilters.filter((f) => f && f.col) : [];
  onProgress({ stage: "plan", title: orch.title, agents: agents.map((a) => a.focus || a.id), globalFilters: gf.length });
  if (!agents.length) throw new Error("orquestrador não definiu agentes"); // cai no fallback de 1 chamada

  // 2) AGENTES em paralelo — cada um recebe SÓ a sua fatia (colunas + estatísticas + amostra projetada)
  const results = await pool(agents, AGENT_CONC, async (a, i) => {
    const names = (Array.isArray(a.columns) ? a.columns : []).filter(Boolean);
    onProgress({ stage: "agent", i, n: agents.length, focus: a.focus || a.id });
    try {
      const proj = amostra.slice(0, 8).map((r) => Object.fromEntries(names.filter((n) => n in r).map((n) => [n, r[n]])));
      const r = extractJson(await agentText(SYS_AGENT, `SEU OBJETIVO (do orquestrador): ${a.goal || a.focus}
PAINÉIS A ENTREGAR: ${a.tiles || 2}

SUA FATIA — COLUNAS: ${names.join(", ")}
ESTATÍSTICAS DA FATIA:
${statsFor(stats, names) || "(sem estatísticas)"}

AMOSTRA DA FATIA:
${JSON.stringify(proj)}${ctxBlock(context)}

FILTROS GLOBAIS (recorte do pedido — aplique em todo painel): ${gf.length ? JSON.stringify(gf) : "nenhum"}
PEDIDO ORIGINAL DO USUÁRIO: ${nl || "(visão geral)"}

Responda só o JSON {"tiles":[...]}.`, AGENT_MODEL));
      const tiles = (Array.isArray(r.tiles) ? r.tiles : []).map((t) => ({ ...t, _agent: a.id || `a${i}` }));
      onProgress({ stage: "agent-done", i, n: agents.length, focus: a.focus || a.id, tiles: tiles.length });
      return tiles;
    } catch (e) {
      onProgress({ stage: "agent-fail", i, n: agents.length, focus: a.focus || a.id, error: String(e?.message ?? e) });
      return [];
    }
  });

  // 3) MONTAGEM: KPIs/tabela do orquestrador + tiles dos agentes; filtros globais herdados; dedup determinístico
  let tiles = [...(Array.isArray(orch.selfTiles) ? orch.selfTiles : []), ...results.flat()];
  if (gf.length) tiles = tiles.map((t) => t.kind === "insight" ? t
    : { ...t, filters: [...gf.filter((g) => !(t.filters || []).some((f) => f && f.col === g.col)), ...(t.filters || [])] });
  const sig = (t) => [t.kind, t.dim, t.dim2, t.measure, t.agg || "sum", t.bucket, JSON.stringify(t.filters || [])].join("|").toLowerCase();
  const seen = new Set();
  tiles = tiles.filter((t) => { if (t.kind === "insight") return true; const s = sig(t); if (seen.has(s)) return false; seen.add(s); return true; });

  // 4) VALIDAÇÃO FINAL do orquestrador: dedup semântico, validade e ordem (responsabilidade dele)
  tiles.forEach((t, i) => { t._id = "t" + i; });
  onProgress({ stage: "validate", candidates: tiles.length });
  try {
    const compact = tiles.map((t) => ({ id: t._id, kind: t.kind, title: t.title, dim: t.dim, dim2: t.dim2, measure: t.measure, agg: t.agg, chartType: t.chartType, filters: t.filters, agent: t._agent }));
    const judged = extractJson(await agentText(SYS_JUDGE, `PEDIDO DO USUÁRIO: ${nl || "(visão geral)"}

ENTENDIMENTO: ${JSON.stringify(orch.understanding || {})}

PAINÉIS CANDIDATOS:
${JSON.stringify(compact)}

Responda só o JSON {"keep":[...],"retitle":{...},"drop":[...]}.`, ORCH_MODEL,
      { thinking: { type: "disabled" }, effort: "low" })); // revisão é estrutural — deliberação longa só custa tempo
    const byId = new Map(tiles.map((t) => [t._id, t]));
    const keep = (Array.isArray(judged.keep) ? judged.keep : []).map((id) => byId.get(id)).filter(Boolean);
    if (keep.length >= Math.min(4, tiles.length)) { // juiz só vale se não descartou o dashboard inteiro
      for (const [id, title] of Object.entries(judged.retitle || {})) { const t = byId.get(id); if (t && typeof title === "string" && title.trim()) t.title = title.trim(); }
      const removed = tiles.length - keep.length;
      tiles = keep;
      onProgress({ stage: "validated", kept: keep.length, removed, drops: (judged.drop || []).slice(0, 6) });
    }
  } catch { /* juiz falhou → segue com a montagem + dedup determinístico */ }
  tiles.forEach((t) => { delete t._id; delete t._agent; });

  return { title: orch.title, understanding: orch.understanding, tiles,
    plan: { agents: agents.map((a) => ({ focus: a.focus || a.id, columns: a.columns || [] })) } };
}

// ── (3) Insights em lote — com os dados JÁ AGREGADOS de cada painel (vêm prontos) ──────────────────
const SYS_INSIGHTS = `Você é um analista de dados sênior. Recebe o ENTENDIMENTO de um dataset e VÁRIOS painéis, cada um com seus DADOS JÁ AGREGADOS.
Para CADA painel, escreva um insight curto e ESPECÍFICO (2 a 4 frases) para um executivo:
- Números REAIS dos dados do painel (líder, %, concentração, cauda, tendência, outlier).
- O "e daí?": o que a pessoa deve NOTAR — risco, oportunidade, anomalia. Nada genérico.
- Conecte ao entendimento do negócio quando fizer sentido.
FORMATO DA RESPOSTA (NÃO use JSON, NÃO use markdown): uma linha por painel, começando com o id entre colchetes:
[id_do_painel] texto do insight numa linha só
Uma linha por painel. Não repita o título. Não numere.`;

export async function insightsBatch({ understanding, nl, panels, context }) {
  const list = (panels || []).map((p) =>
    `id=${p.id} · "${p.title}"${p.dim ? ` · dimensão=${p.dim}` : ""}${p.dim2 ? `×${p.dim2}` : ""}${p.measure ? ` · ${p.agg || "sum"}(${p.measure})` : ""}${p.filters && p.filters.length ? ` · recorte=${JSON.stringify(p.filters)}` : ""}\n  dados: ${JSON.stringify((p.rows || []).slice(0, 30))}`
  ).join("\n\n");
  const prompt = `ENTENDIMENTO DO DATASET:\n${JSON.stringify(understanding || {})}${ctxBlock(context)}\n\nPEDIDO ORIGINAL: ${nl || "dashboard geral"}\n\nPAINÉIS (com dados agregados reais):\n${list}\n\nResponda no formato [id] insight, uma linha por painel.`;
  const text = await agentText(SYS_INSIGHTS, prompt, MODEL);
  // parse robusto a aspas/pontuação: cada linha "[id] texto"; linhas de continuação anexam ao id atual
  const out = {}; let curId = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*\[([^\]]+)\]\s*(.*)$/);
    if (m) { curId = m[1].trim(); out[curId] = m[2].trim(); }
    else if (curId && raw.trim()) out[curId] += (out[curId] ? " " : "") + raw.trim();
  }
  return out;
}

// ── Insight de UM painel (fallback on-demand, se o lote não cobriu) ─────────────────────────────────
const SYS_TILE_INSIGHT = `Você é analista de dados sênior. Recebe UM painel (título + dados JÁ AGREGADOS) e escreve um insight
curto e ESPECÍFICO (2-4 frases) para um executivo, com NÚMEROS REAIS e o "e daí?" (risco/oportunidade/anomalia).
Português do Brasil. Responda APENAS o texto (sem markdown, sem JSON, sem aspas).`;

export async function insightForTile({ title, dim, measure, agg, rows, nl }) {
  const data = JSON.stringify((rows || []).slice(0, 40));
  const ctx = [dim ? `dimensão: ${dim}` : "", measure ? `medida: ${agg || "sum"}(${measure})` : "", nl ? `contexto: ${nl}` : ""].filter(Boolean).join(" · ");
  const prompt = `PAINEL: ${title}\n${ctx}\n\nDADOS AGREGADOS:\n${data}\n\nEscreva o insight (2-4 frases, números reais).`;
  const text = await agentText(SYS_TILE_INSIGHT, prompt, MODEL);
  return text.trim().replace(/^["']|["']$/g, "");
}

// ── Extração de PDF: texto página a página (pdf.js no cliente) → dados estruturados ────────────────
const SYS_PDF = `Você extrai DADOS ESTRUTURADOS do texto de um PDF (relatórios, demonstrativos, listagens, extratos).
Recebe o texto página a página, com as linhas preservadas. Encontre os dados tabulares e devolva APENAS JSON:
{"columns":[{"name":"...","type":"número|texto|data"}],"rows":[{...}],"title":"do que o documento se trata","note":"o que você extraiu e decidiu (e o que ficou de fora)"}
- Cada registro de dados = um objeto em rows, com as MESMAS chaves de columns.
- Números pt-BR viram NÚMERO (1.234,56 → 1234.56; R$ e % removidos). Datas em ISO AAAA-MM-DD.
- Linhas de TOTAL/SUBTOTAL/cabeçalho repetido NÃO viram registro.
- Se houver várias tabelas, extraia a PRINCIPAL (mais registros) e avise na note; se as demais couberem no MESMO esquema (continuação por página), una tudo.
- Máximo 800 linhas; se houver mais, corte e avise na note.
- Sem dados tabulares → "rows": [] e explique na note o que o documento contém.`;

export async function extractPdfData({ name, pages }) {
  const all = Array.isArray(pages) ? pages : [];
  let budget = 48000; const parts = [];
  for (let i = 0; i < all.length && budget > 400; i++) {
    const t = String(all[i] || "").slice(0, Math.min(6000, budget));
    budget -= t.length;
    parts.push(`— PÁGINA ${i + 1} —\n${t}`);
  }
  const cut = parts.length < all.length ? `\n\n[+${all.length - parts.length} páginas truncadas por tamanho]` : "";
  return extractJson(await agentText(SYS_PDF, `PDF: ${name || "documento"} (${all.length} páginas)\n\n${parts.join("\n\n")}${cut}\n\nResponda só o JSON.`, MODEL));
}

// ── Edição conversacional ──────────────────────────────────────────────────────────────────────────
const SYS_EDIT_DOC = `Você EDITA um dashboard de DOCUMENTO. Recebe as COLUNAS (+ amostra), os PAINÉIS ATUAIS (JSON) e um
PEDIDO de alteração. Responda APENAS o JSON COMPLETO atualizado {"title":"...","tiles":[ TILE, ... ]} no mesmo formato:
{"kind":"kpi|chart|insight|table","title":"...","dim":"coluna","dim2":"coluna (séries empilhadas, opcional)","measure":"coluna","agg":"sum|count|countdistinct|avg|min|max|share","shareWhere":[{...só kpi share: numerador...}],"bucket":"month|year (dim de data)","limit":N,"order":"asc (menores/piores)","format":"currency|percent","chartType":"bar|line|pie|area|map","columns":["..."],"filters":[{"col":"coluna","op":"=|!=|in|contains|>=|<=|>|<|between","value":...,"value2":...}],"narrative":"...","w":3|6|12}
- MANTENHA os painéis que continuam (INCLUSIVE "filters", "dim2", "shareWhere", "bucket", "limit", "order", "format"); aplique só o que o pedido pede. Use os NOMES EXATOS das colunas.
- "percentual/proporção/participação" → agg "share" (chart: % do total por categoria; kpi: exige shareWhere). Filtro de data SEMPRE em ISO completo (between "2024-01-01" e "2025-12-31").`;

export async function editDocDashboard({ currentTiles, columns, sample, nl, context }) {
  const cols = (columns || []).map((c) => `${c.name} (${c.type || "texto"})`).join(", ");
  const atuais = JSON.stringify((currentTiles || []).map((t) => ({ title: t.title, kind: t.kind, chartType: t.chartType, dim: t.dim, dim2: t.dim2, measure: t.measure, agg: t.agg, filters: t.filters, shareWhere: t.shareWhere, bucket: t.bucket, limit: t.limit, order: t.order, format: t.format, narrative: t.narrative })));
  const prompt = `COLUNAS: ${cols}

AMOSTRA:
${JSON.stringify((sample || []).slice(0, 12))}${ctxBlock(context)}

PAINÉIS ATUAIS:
${atuais}

PEDIDO DE ALTERAÇÃO: ${nl}

Responda só o JSON completo atualizado.`;
  return extractJson(await agentText(SYS_EDIT_DOC, prompt, MODEL));
}
