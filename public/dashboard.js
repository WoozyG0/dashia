// Dashboards (BI) — "IA monta + você ajusta". Reusa FMChart (chart-lib.js) e os endpoints
// /dashboard/* + /report/run. Grade 12 colunas; tiles kpi/chart/table; arrastar p/ reordenar,
// redimensionar largura, editar SQL, remover, adicionar painel; salvar/abrir; exportar HTML.
const $ = (id) => document.getElementById(id);
let dash = null;          // { title, tiles[], schemaTables[] }
let charts = {};          // id -> ECharts instance
let lastNl = "";
let building = false;     // trava o envio enquanto monta
let _staggerNext = false; // próxima renderização entra com cascata (só em build/load, não em ajustes)
let _pendingReason = null; // raciocínio capturado durante o build (vira dash.reasoning)
const EXAMPLES = ["visão de compras 2024", "faturamento por mês e top fornecedores", "pedidos por status e por empresa"];

// ── tema ──
function applyTheme(theme) {
  document.body.classList.toggle("light", theme === "light");
  document.querySelectorAll("#theme-toggle button").forEach((b) => b.classList.toggle("active", b.dataset.theme === theme));
  try { localStorage.setItem("studio-theme", theme); } catch {}
  if (dash) renderAll();
}
document.querySelectorAll("#theme-toggle button").forEach((b) => (b.onclick = () => applyTheme(b.dataset.theme)));

const tokFn = () => { const cs = getComputedStyle(document.body); return (n, d) => cs.getPropertyValue(n).trim() || d; };
// ícones (stroke) dos controles do tile
const ICONS = {
  resize: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  sql: '<path d="M8 6l-5 6 5 6M16 6l5 6-5 6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  bulb: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z"/>',
  grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
};
const ico = (name) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="${name === "grip" ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const isNum = (v) => window.FMChart.isNum(v);
const fmtN = (v) => (isNum(v) && String(v).length > 3 ? Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) : v == null ? "" : String(v));

// ── chamadas ──
async function post(url, body) { return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()); }
function loading(on, msg) {
  $("db-empty").classList.toggle("hidden", !on && !!dash);
  $("db-result").classList.toggle("hidden", on || !dash);
  if (on) { $("db-empty").classList.remove("hidden"); $("db-empty").querySelector(".eh-title").innerHTML = msg + '<span class="busy"></span>'; $("ex-chips").innerHTML = ""; }
}
function fail(msg) {
  hideOverlay();
  $("db-result").classList.add("hidden"); $("db-empty").classList.remove("hidden");
  $("db-empty").querySelector(".eh-title").textContent = "Não consegui montar";
  $("db-empty").querySelector("div:nth-child(3)").textContent = msg;
  $("ex-chips").innerHTML = "";
}

// ── overlay de trabalho: skeleton do dashboard + card central com etapas ──
function showOverlay(title, sub, withSteps) {
  const ov = $("build-overlay");
  ov.classList.remove("closing");
  ov.classList.toggle("journey", !!withSteps); // criação do relatório = jornada imersiva em tela cheia
  $("bo-title").textContent = title;
  $("bo-sub").textContent = sub || "";
  $("bo-steps").innerHTML = "";
  ov.classList.remove("hidden");
  if (withSteps) journeyInit(title, sub);
}
function overlaySub(t) { $("bo-sub").textContent = t; const j = $("jy-sub"); if (j) j.textContent = t; }
function hideOverlay() {
  const ov = $("build-overlay");
  journeyDestroy();
  if (ov.classList.contains("journey") && !ov.classList.contains("hidden")) {
    ov.classList.add("closing"); // fade suave — o reveal do dashboard entra por baixo
    setTimeout(() => { if (ov.classList.contains("closing")) { ov.classList.add("hidden"); ov.classList.remove("closing", "journey"); } }, 280);
  } else ov.classList.add("hidden");
  const board = $("dashboardboard"); if (board) board.scrollTop = 0; // reveal sempre começa do topo
}
const fmtBytes = (b) => b >= 1048576 ? (b / 1048576).toFixed(1).replace(".", ",") + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";

// progresso ao vivo (SSE): passo atual + checklist dos painéis sendo rodados
function setLoading(msg, p) {
  $("db-empty").classList.remove("hidden"); $("db-result").classList.add("hidden");
  $("db-empty").querySelector(".eh-title").innerHTML = "Montando dashboard" + '<span class="busy"></span>';
  $("db-empty").querySelector("div:nth-child(3)").textContent = msg || "Trabalhando…";
  if (p && p.stage === "plan") $("ex-chips").innerHTML = (p.titles || []).map((t, i) => `<span class="ex-chip prog" data-i="${i + 1}" data-title="${esc(t || "")}">${esc(t || ("Painel " + (i + 1)))}</span>`).join("");
  if (p && p.stage === "tile-schema")   $("ex-chips").querySelectorAll(".prog").forEach((c) => { if (c.dataset.title === p.tileTitle) c.setAttribute("title", "buscando schema…"); });
  if (p && p.stage === "tile-gen")      $("ex-chips").querySelectorAll(".prog").forEach((c) => { if (c.dataset.title === p.tileTitle) { c.classList.add("active"); c.setAttribute("title", "gerando SQL…"); } });
  if (p && p.stage === "tile-validate") $("ex-chips").querySelectorAll(".prog").forEach((c) => { if (c.dataset.title === p.tileTitle) c.setAttribute("title", "validando colunas…"); });
  if (p && p.stage === "tile") $("ex-chips").querySelectorAll(".prog").forEach((c) => { const ci = Number(c.dataset.i); c.classList.toggle("done", ci <= p.i); c.classList.remove("active"); });
  if (p && p.stage === "editor-done" && p.removed?.length) {
    const removedMap = Object.fromEntries((p.removed || []).map((r) => [r.title, r.reason || "redundante"]));
    $("ex-chips").querySelectorAll(".prog").forEach((c) => {
      if (removedMap[c.dataset.title] !== undefined) {
        c.style.opacity = "0.35"; c.style.textDecoration = "line-through";
        c.setAttribute("title", removedMap[c.dataset.title]);
      }
    });
  }
}
function progressMsg(p) {
  if (p.stage === "tile") return `Painel ${p.i}/${p.total} pronto: ${p.title || ""}`;
  if (p.stage === "tile-validate") return `Validando colunas: ${p.tileTitle || ""}`;
  if (p.stage === "tile-gen") return `Gerando SQL: ${p.tileTitle || ""}`;
  if (p.stage === "tile-schema") return `Buscando schema: ${p.tileTitle || ""}`;
  if (p.stage === "plan") return `${p.total} painéis planejados — rodando em paralelo…`;
  if (p.stage === "orchestrate-done") return `Plano pronto (${p.total} painéis). Iniciando agents…`;
  if (p.stage === "orchestrate") return p.msg || "Orquestrador planejando painéis…";
  if (p.stage === "editor-start") return `Verificando redundâncias em ${p.total} painéis…`;
  if (p.stage === "editor-done") return p.removed?.length ? `Editor removeu ${p.removed.length} painel(eis) redundante(s) — ${p.kept} mantidos` : `${p.kept} painéis prontos ✓`;
  if (p.stage === "candidates-done") return `Li ${p.count} tabelas candidatas…`;
  if (p.stage === "pick-done") return `Escolhi ${(p.tables || []).length} tabelas. Gerando SQL…`;
  if (p.stage === "compose-done") return "Plano pronto. Rodando os painéis…";
  return p.msg || "Trabalhando…";
}

// Fase 4: badge de confiança derivado do estado do tile (não depende de salvar badge no JSON)
function computeBadge(t) {
  if (t.error) return { type: "err",   label: "✕", tip: "Erro ao buscar dados" + (t.error ? ": " + t.error.slice(0, 120) : "") };
  if (t.rowCount === 0) return { type: "empty", label: "○", tip: "Sem dados para este período/filtro" };
  if (t.warn || t.fixed) return { type: "warn",  label: "⚠", tip: t.warn || "SQL corrigido automaticamente" };
  return { type: "ok",    label: "✓", tip: "Dados validados" };
}
// ── log "Raciocínio da IA": enche ao vivo conforme a IA decide (tabelas, plano, porquê dos painéis) ──
const TL_IC = {
  search: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  tables: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>',
  think: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z"/></svg>',
  panel: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>',
};
function thinkClear() { const el = $("think-log"); if (el) el.innerHTML = ""; }
function thinkRow(icon, html, sub) {
  const el = $("think-log"); if (!el) return;
  const row = document.createElement("div"); row.className = "tl-row" + (sub ? " sub" : "");
  row.innerHTML = (sub ? "" : `<span class="tl-ic">${icon || ""}</span>`) + `<span>${html}</span>`;
  el.appendChild(row);
}
function thinkStep(p) {
  if (p.stage === "orchestrate-done") {
    if (p.reasoning) thinkRow(TL_IC.think, esc(p.reasoning));
    for (const t of p.plan || []) thinkRow(TL_IC.panel, `<b>${esc(t.title || "")}</b>${t.why ? ` — <span class="tl-muted">${esc(t.why)}</span>` : ""}`);
    if (_pendingReason) { _pendingReason.plan = p.reasoning || ""; _pendingReason.tiles = p.plan || []; }
  } else if (p.stage === "candidates-done") thinkRow(TL_IC.search, `Li <b>${p.count}</b> tabelas candidatas no banco.`);
  else if (p.stage === "pick-done") {
    thinkRow(TL_IC.tables, `Escolhi <b>${(p.tables || []).length}</b> tabela(s): ${esc((p.tables || []).join(", "))}`);
    if (p.reasoning) thinkRow(null, esc(p.reasoning), true);
    if (_pendingReason) { _pendingReason.tables = p.tables || []; _pendingReason.tablesWhy = p.reasoning || ""; }
  } else if (p.stage === "compose-done") {
    if (p.reasoning) thinkRow(TL_IC.think, esc(p.reasoning));
    for (const t of p.plan || []) thinkRow(TL_IC.panel, `<b>${esc(t.title || "")}</b>${t.why ? ` — <span class="tl-muted">${esc(t.why)}</span>` : ""}`);
    if (_pendingReason) { _pendingReason.plan = p.reasoning || ""; _pendingReason.tiles = p.plan || []; }
  } else if (p.stage === "editor-done" && p.removed?.length) {
    const cutIcon = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm12 12a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm-3.5-3.5L20 6M4 20l9-9"/></svg>';
    thinkRow(cutIcon, `Editor removeu <b>${p.removed.length}</b> painel(eis) redundante(s):`);
    for (const r of p.removed) thinkRow(null, `"${esc(r.title)}" — <span class="tl-muted">${esc(r.reason)}</span>`, true);
  }
}
// monta o HTML do painel "Raciocínio" (fixo/recolhível) a partir de dash.reasoning
function reasonCardHTML(r) {
  if (!r) return "";
  const parts = [];
  if (r.tables && r.tables.length) parts.push(`<div class="rc-row"><b>Tabelas escolhidas:</b> ${esc(r.tables.join(", "))}</div>`);
  if (r.tablesWhy) parts.push(`<div class="rc-row rc-muted">${esc(r.tablesWhy)}</div>`);
  if (r.plan) parts.push(`<div class="rc-row">${esc(r.plan)}</div>`);
  if (r.tiles && r.tiles.length) parts.push(`<ul class="rc-list">${r.tiles.map((t) => `<li><b>${esc(t.title || "")}</b>${t.why ? ` — <span class="rc-muted">${esc(t.why)}</span>` : ""}</li>`).join("")}</ul>`);
  if (!parts.length) return "";
  return `<details class="reason-card"><summary>Como a IA montou este dashboard</summary><div class="rc-body">${parts.join("")}</div></details>`;
}
// Card "Como a IA entendeu seus dados" — mostra o entendimento (domínio, granularidade, achados)
function understandingCardHTML(u) {
  if (!u) return "";
  const parts = [];
  if (u.request && (u.request.asked || u.request.map)) { // o contrato: o que foi pedido → como foi atendido
    const pairs = Object.entries(u.request.map || {}).filter(([, v]) => v).map(([k, v]) => `${esc(k)} → <b>${esc(v)}</b>`);
    parts.push(`<div class="rc-row"><b>Seu pedido:</b> ${esc(u.request.asked || "")}${pairs.length ? `<div class="rc-muted" style="margin-top:3px">${pairs.join(" · ")}</div>` : ""}</div>`);
    if (Array.isArray(u.request.unmapped) && u.request.unmapped.length)
      parts.push(`<div class="rc-row rc-warn">Não encontrado no arquivo: ${esc(u.request.unmapped.join(", "))} — painéis adaptados ao que existe.</div>`);
  }
  if (u.domain)  parts.push(`<div class="rc-row"><b>O que são estes dados:</b> ${esc(u.domain)}</div>`);
  if (u.grain)   parts.push(`<div class="rc-row rc-muted">Cada linha representa: ${esc(u.grain)}</div>`);
  const plan = dash && dash.plan;
  if (plan && Array.isArray(plan.agents) && plan.agents.length)
    parts.push(`<div class="rc-row"><b>Equipe do orquestrador:</b> ${plan.agents.length} agente(s) — ${plan.agents.map((a) => esc(a.focus)).join(" · ")}</div>`);
  if (Array.isArray(u.keyFindings) && u.keyFindings.length) parts.push(`<ul class="rc-list">${u.keyFindings.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`);
  if (Array.isArray(u.angles) && u.angles.length) parts.push(`<div class="rc-row rc-muted">Ângulos explorados: ${esc(u.angles.join(" · "))}</div>`);
  if (!parts.length) return "";
  return `<details class="reason-card" open><summary>Como a IA entendeu seus dados</summary><div class="rc-body">${parts.join("")}</div></details>`;
}
function parseSse(block) {
  let event = "message", data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;
  try { return { event, data: JSON.parse(data) }; } catch { return null; }
}
function setBuilding(on) {
  building = on;
  document.body.classList.toggle("building", on); // dispara a animação do ícone
  $("send").disabled = on;                         // bloqueia o envio até terminar
}
async function build(nl) {
  if (building || !nl.trim()) return; // já está montando -> ignora
  lastNl = nl; setBuilding(true);
  setLoading("Iniciando…"); thinkClear();
  _pendingReason = { tables: [], tablesWhy: "", plan: "", tiles: [] };
  try {
    const res = await fetch("/dashboard/build", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nl }) });
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n"); buf = parts.pop();
      for (const part of parts) {
        const ev = parseSse(part); if (!ev) continue;
        if (ev.event === "progress") { setLoading(progressMsg(ev.data), ev.data); thinkStep(ev.data); }
        else if (ev.event === "done") {
          if (!ev.data.ok) fail(ev.data.error);
          else { dash = { title: ev.data.title, tiles: ev.data.tiles || [], schemaTables: ev.data.schemaTables || [], source: "bank", reasoning: _pendingReason }; renderAll(); }
        }
      }
    }
  } catch (e) { fail(e.message); }
  finally { setBuilding(false); } // libera o botão no fim (sucesso ou erro)
}

// ── render ──
function disposeCharts() { for (const id in charts) { try { charts[id].dispose(); } catch {} } charts = {}; }

// auto-salva o dashboard de trabalho no navegador (sobrevive ao reload)
let _workTimer = null;
function saveWorking() {
  clearTimeout(_workTimer);
  _workTimer = setTimeout(() => {
    if (!dash) { try { localStorage.removeItem("studio-dash-working"); } catch {} return; }
    const tiles = dash.tiles.map((t) => ({ id: t.id, kind: t.kind, chartType: t.chartType, title: t.title, w: t.w, why: t.why, warn: t.warn,
      fields: t.fields, sql: t.sql, xField: t.xField, yFields: t.yFields, dim: t.dim, dim2: t.dim2, measure: t.measure, agg: t.agg,
      filters: t.filters, shareWhere: t.shareWhere, bucket: t.bucket, limit: t.limit, order: t.order, format: t.format,
      stacked: t.stacked, percent: t.percent, srcRows: t.srcRows, _doc: t._doc,
      narrative: t.narrative, insight: t.insight, highlight: t.highlight,
      columns: t.columns, rows: t.rows, rowCount: t.rowCount, error: t.error }));
    const base = { title: dash.title, schemaTables: dash.schemaTables, source: dash.source, reasoning: dash.reasoning, understanding: dash.understanding, plan: dash.plan };
    const doc = docData ? { name: docData.name, columns: docData.columns, rows: docData.rows, context: docCtx, sheetContext: docData.sheetContext } : null;
    const noRows = tiles.map((t) => ({ ...t, rows: undefined })); // recalcula ao restaurar (doc) ou re-roda o SQL (banco)
    const tries = [
      { ...base, tiles, doc },
      { ...base, tiles: noRows, doc },                                          // sem dados dos painéis, mantém o documento
      { ...base, tiles: noRows, doc: doc ? { ...doc, rows: undefined } : null }, // sem dados do documento
      { ...base, tiles: noRows },                                               // só a estrutura
    ];
    for (const v of tries) { try { localStorage.setItem("studio-dash-working", JSON.stringify(v)); return; } catch {} }
  }, 500);
}
async function restoreWorking() {
  let spec;
  try { spec = JSON.parse(localStorage.getItem("studio-dash-working") || "null"); } catch {}
  if (!spec || !Array.isArray(spec.tiles) || !spec.tiles.length) return false;
  if (spec.doc && spec.doc.columns) { // restaura o documento (pra recalcular e re-perguntar)
    docData = spec.doc; showDocBanner({ chip: false }); // chip some — dados já nos tiles
    setDocCtx(spec.doc.context || "", { store: false });
    if (docData.rows) $("prompt").placeholder = `Pergunte sobre "${docData.name}"… ou envie em branco p/ um dashboard geral`;
  }
  dash = { title: spec.title || "Meu dashboard", tiles: spec.tiles, schemaTables: spec.schemaTables || [], source: spec.source, reasoning: spec.reasoning, understanding: spec.understanding, plan: spec.plan };
  _staggerNext = true;
  renderAll();
  for (const t of dash.tiles) {
    if (t.rows && t.rows.length) continue;
    if (t._doc) { if (docData && docData.rows) Object.assign(t, aggregateDoc(docData.rows, t)); continue; } // recalcula do documento
    if (t.sql) { const r = await post("/report/run", { sql: t.sql }); if (r.ok) { t.columns = r.columns; t.rows = r.rows; t.rowCount = r.rowCount; t.error = undefined; } else t.error = r.error; }
  }
  renderAll();
  return true;
}

function renderAll() {
  $("db-empty").classList.add("hidden"); $("db-result").classList.remove("hidden");
  $("db-name").textContent = dash.title || "Dashboard";
  $("title").textContent = dash.title || "Dashboard";
  const okTiles = dash.tiles.filter((t) => !t.error).length;
  $("meta").textContent = `${dash.tiles.length} painel(éis)${okTiles < dash.tiles.length ? ` · ${dash.tiles.length - okTiles} com erro` : ""}`;
  $("btn-export").disabled = !dash.tiles.length;
  $("btn-present").disabled = !dash.tiles.length;
  $("reason-slot").innerHTML = dash.understanding ? understandingCardHTML(dash.understanding) : reasonCardHTML(dash.reasoning);
  disposeCharts();
  const grid = $("grid"); grid.innerHTML = "";
  dash.tiles.forEach((t, i) => {
    const el = tileEl(t);
    if (_staggerNext) el.style.setProperty("--i", Math.min(i, 14)); // cascata na entrada
    else el.style.animation = "none";                               // ajustes re-renderizam sem piscar
    grid.appendChild(el);
  });
  _staggerNext = false;
  saveWorking(); // persiste no navegador a cada mudança
}

function kpiValue(t) {
  if (!t.rows || !t.rows.length) return null;
  const r = t.rows[0];
  const c = (t.columns || []).find((c) => isNum(r[c])) ?? (t.columns || [])[0];
  return c == null ? null : r[c];
}
// Detecta a coluna de nome de entidade numa lista de colunas (fornecedor, empresa, etc.)
function detectNameCol(columns) {
  return (columns || []).find(c => /NOME|RAZAO|FANTASIA|FORN|EMPRESA|CLIENTE|DESCRICAO|DESC_|TITULAR/i.test(c)) || null;
}

function tableHTML(t) {
  const cols = t.columns || [], rows = t.rows || [];
  const nums = new Set(window.FMChart.numericCols(cols, rows));
  const hl = t.highlight; // { column, rule:"past" } -> destaca em vermelho as linhas vencidas
  const isPast = (v) => { const d = Date.parse(v); return !isNaN(d) && d < Date.now(); };
  const th = cols.map((c) => `<th class="${nums.has(c) ? "num" : ""}">${esc(c)}</th>`).join("");
  const trs = rows.slice(0, 500).map((r) => {
    const danger = hl && hl.column && (hl.rule === "past" ? isPast(r[hl.column]) : false);
    return `<tr class="${danger ? "row-danger" : ""}">` + cols.map((c) => `<td class="${nums.has(c) ? "num" : ""}">${esc(fmtN(r[c]))}</td>`).join("") + "</tr>";
  }).join("");
  return `<div class="fgrid-wrap"><table class="fgrid"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

// Resumo humano do recorte de um painel — o usuário VÊ o que entrou (e o que não entrou) na conta.
// É a resposta ao "somei no Excel e deu diferente": se há filtro, ele está escrito no painel.
function filterLabel(t) {
  if (!t.filters || !t.filters.length) return "";
  const OPS = { "=": "=", "!=": "≠", ">=": "≥", "<=": "≤", ">": ">", "<": "<", in: "em", contains: "contém" };
  const parts = t.filters.map((f) => {
    const op = String(f.op || "=").toLowerCase();
    const val = Array.isArray(f.value) ? f.value.join(", ") : String(f.value ?? "");
    return op === "between" ? `${f.col} ${val} a ${f.value2 ?? "…"}` : `${f.col} ${OPS[op] ?? op} ${val}`;
  });
  const total = docData && docData.rows ? docData.rows.length : null;
  const n = (t.srcRows != null && total) ? ` · ${t.srcRows.toLocaleString("pt-BR")} de ${total.toLocaleString("pt-BR")} linhas` : "";
  return parts.join(" · ") + n;
}
const filtHtml = (t) => (t._doc && t.filters && t.filters.length)
  ? `<div class="tile-filt" title="Recorte aplicado a este painel — linhas fora dele NÃO entram na conta">recorte: ${esc(filterLabel(t))}</div>` : "";

function tileEl(t) {
  const el = document.createElement("div");
  el.className = `tile w${t.w} ${t.kind}`;
  el.dataset.id = t.id;
  const isInsight = t.kind === "insight";
  // lâmpada: mostra o insight DESTE painel (já vem pronto do build). Fica no head (visível quando pronta/gerando).
  const bulbCls = t.insight ? " has" : (t._insightPending ? " gen" : "");
  const bulbTitle = t.insight ? "Ver o insight deste painel" : (t._insightPending ? "Gerando insight…" : "Insight deste painel (IA)");
  const bulbBtn = isInsight ? "" : `<button class="tile-bulb${bulbCls}" data-act="insight" title="${bulbTitle}">${ico("bulb")}</button>`;
  const tools = `
    <div class="tile-tools">
      <button data-act="resize" title="Largura">${ico("resize")}</button>
      <button data-act="remove" title="Remover">${ico("x")}</button>
    </div>
    <span class="tile-grip" data-act="grip" title="Arraste para reordenar">${ico("grip")}</span>`;
  const cur = t.kind === "kpi" ? "kpi" : t.kind === "table" ? "table" : (t.chartType || "bar");
  const TYPES = [["kpi", "KPI"], ["bar", "Barra"], ["line", "Linha"], ["area", "Área"], ["pie", "Pizza"], ["map", "Mapa"], ["table", "Tabela"]];
  // insight não tem seletor de tipo (é texto analítico), nem badge de dados
  const typeSel = isInsight ? "" : `<select class="tile-type" title="Tipo de visual">${TYPES.map(([v, l]) => `<option value="${v}"${v === cur ? " selected" : ""}>${l}</option>`).join("")}</select>`;
  const markHtml = isInsight
    ? `<span class="tile-insight-mark" title="Insight da IA"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z"/></svg></span>`
    : (() => { const bdg = computeBadge(t); return `<span class="tile-badge tile-badge-${bdg.type}" title="${esc(bdg.tip)}">${esc(bdg.label)}</span>`; })();
  el.innerHTML = `<div class="tile-head">${markHtml}<span class="tile-title"${t.why ? ` title="${esc(t.why)}"` : ""}>${esc(t.title || "(sem título)")}</span>${bulbBtn}${typeSel}${tools}</div><div class="tile-body"></div>`;
  const body = el.querySelector(".tile-body");
  if (t.error) body.innerHTML = `<div class="tile-err">${esc(t.error)}</div>`;
  else if (t.kind === "kpi") body.innerHTML = `<div class="kpi-val ${t.format === "currency" ? "curr" : ""}">${window.FMChart.fmtKpi(kpiValue(t), t.format)}</div>` + filtHtml(t);
  else if (isInsight) body.innerHTML = `<p class="insight-text">${esc(t.narrative || "")}</p>`;
  else if (t.kind === "table") body.innerHTML = tableHTML(t) + filtHtml(t);
  else { body.innerHTML = `<div class="tile-chart" id="ch-${t.id}"></div><div class="tile-note" id="note-${t.id}"></div>`; setTimeout(() => mountChart(t), 0); }
  wireTile(el, t);
  return el;
}

function mountChart(t) {
  const node = $("ch-" + t.id); if (!node) return;
  const c = echarts.init(node, null, { renderer: "canvas" });
  charts[t.id] = c;
  const filtNote = (t._doc && t.filters && t.filters.length) ? "recorte: " + filterLabel(t) : "";
  if ((t.chartType || "") === "map") { // mapa do Brasil (carrega o GeoJSON 1x)
    const n0 = $("note-" + t.id); if (n0) n0.textContent = filtNote;
    window.FMChart.ensureBrazilMap().then(() => {
      if (charts[t.id] !== c) return;
      c.setOption(window.FMChart.mapOption({ columns: t.columns || [], rows: t.rows || [], xField: t.xField, yFields: t.yFields }, tokFn()), true);
    }).catch(() => {});
    return;
  }
  const { option, note } = window.FMChart.chartOption({ chartType: t.chartType || "bar", columns: t.columns || [], rows: t.rows || [], xField: t.xField, yFields: t.yFields, stacked: t.stacked, percent: t.percent }, tokFn());
  c.setOption(option, true);
  const n = $("note-" + t.id); if (n) n.textContent = [filtNote, note].filter(Boolean).join(" · ");
}

function renderSchema() {
  const tabs = dash.schemaTables || [];
  $("sch-grid").innerHTML = tabs.map((t) => `
    <div class="sch-card ${t.used ? "used" : ""}">
      <div class="sch-tname">${esc(t.table)}${t.used ? ' <span class="an-chip" style="background:linear-gradient(135deg,#7c5cff,#38bdf8)">usada</span>' : ""}</div>
      ${t.comment ? `<div class="sch-tcom">${esc(t.comment)}</div>` : ""}
      ${(t.columns || []).slice(0, 16).map((c) => `<div class="sch-col">${esc(c.name)} <span style="color:var(--muted)">${esc(c.type)}</span>${c.pk ? ' <span class="pk">PK</span>' : ""}${c.fk ? ' <span class="fk">FK</span>' : ""}</div>`).join("")}
    </div>`).join("") || '<div class="db-meta">Monte um dashboard para ver as tabelas usadas.</div>';
}

// Classificação de fornecedores/empresas por tipo (IA usa conhecimento real — não regex de nome)
async function classifyTile(t) {
  const nameCol = detectNameCol(t.columns);
  if (!nameCol || !t.rows?.length) return;
  const btn = document.querySelector(`[data-id="${t.id}"] [data-act="classify"]`);
  if (btn) { btn.innerHTML = '<span class="busy" style="display:inline-block;width:14px;height:14px"></span>'; btn.disabled = true; }
  try {
    const r = await post("/dashboard/classify-rows", { rows: t.rows, nameCol });
    if (r.ok && r.rows?.length) {
      t.rows = r.rows;
      if (r.addedCols) for (const c of r.addedCols) if (!t.columns.includes(c)) t.columns.push(c);
      t.classified = true;
      renderAll();
    } else if (btn) { btn.textContent = "!"; btn.disabled = false; btn.title = r.error || "Erro"; }
  } catch (e) {
    if (btn) { btn.textContent = "!"; btn.disabled = false; btn.title = e.message; }
  }
}

// ── interações por tile ──
let draggingId = null;
function wireTile(el, t) {
  el.querySelector('[data-act="resize"]').onclick = () => { const o = [3, 4, 6, 12], i = o.indexOf(t.w); t.w = o[(i + 1) % o.length]; renderAll(); };
  el.querySelector('[data-act="remove"]').onclick = () => { dash.tiles = dash.tiles.filter((x) => x.id !== t.id); renderAll(); };
  const bulb = el.querySelector('[data-act="insight"]'); if (bulb) bulb.onclick = () => openInsightModal(t);
  const ts = el.querySelector(".tile-type"); if (ts) ts.onchange = (e) => setTileViz(t, e.target.value);
  const grip = el.querySelector('[data-act="grip"]');
  grip.addEventListener("mousedown", () => (el.draggable = true));
  el.addEventListener("dragstart", (e) => { draggingId = t.id; el.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
  el.addEventListener("dragend", () => { el.draggable = false; el.classList.remove("dragging"); document.querySelectorAll(".tile.dragover").forEach((x) => x.classList.remove("dragover")); });
  el.addEventListener("dragover", (e) => {
    if (isFieldDrag(e)) { e.preventDefault(); e.stopPropagation(); el.classList.add("fp-over"); $("dashboardboard").classList.remove("fp-drag"); return; } // soltar coluna neste painel (some o overlay do fundo)
    if (draggingId && draggingId !== t.id) { e.preventDefault(); el.classList.add("dragover"); }
  });
  el.addEventListener("dragleave", () => { el.classList.remove("dragover"); el.classList.remove("fp-over"); });
  el.addEventListener("drop", (e) => {
    if (isFieldDrag(e)) { e.preventDefault(); e.stopPropagation(); el.classList.remove("fp-over"); try { addFieldToTile(t, JSON.parse(e.dataTransfer.getData("application/x-field"))); } catch {} return; }
    e.preventDefault();
    if (!draggingId || draggingId === t.id) return;
    const from = dash.tiles.findIndex((x) => x.id === draggingId), to = dash.tiles.findIndex((x) => x.id === t.id);
    const [moved] = dash.tiles.splice(from, 1); dash.tiles.splice(to, 0, moved);
    draggingId = null; renderAll();
  });
}

// ── modais ──
function openModal(html) { $("modal-card").innerHTML = html; $("modal").classList.remove("hidden"); }
function closeModal() { $("modal").classList.add("hidden"); }
$("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

// Insight de um painel (lâmpada): gera sob demanda com os dados AGREGADOS reais do tile, cacheia em t.insight
async function openInsightModal(t) {
  const shell = (bodyHtml) => `<div class="insight-modal">
    <div class="im-head"><span class="im-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z"/></svg></span><h3>${esc(t.title)}</h3></div>
    <div class="im-body">${bodyHtml}</div>
    <div class="modal-row"><button class="pill ghost" id="m-cancel">Fechar</button><button class="pill run" id="m-regen">Gerar de novo</button></div>
  </div>`;
  const render = (text) => { openModal(shell(`<p class="im-text">${esc(text)}</p>`)); $("m-cancel").onclick = closeModal; $("m-regen").onclick = () => genInsight(t, true); };
  if (t.insight) return render(t.insight);
  genInsight(t, false);
}
async function genInsight(t, force) {
  openModal(`<div class="insight-modal"><div class="im-head"><span class="im-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z"/></svg></span><h3>${esc(t.title)}</h3></div>
    <div class="im-body"><div class="im-loading">Analisando este painel<span class="busy"></span></div></div></div>`);
  try {
    const r = await post("/dashboard/insight", { title: t.title, dim: t.dim, measure: t.measure, agg: t.agg, rows: t.rows || [], nl: lastNl });
    if (!r.ok) throw new Error(r.error || "Falha ao gerar insight");
    t.insight = r.narrative;
    openInsightModal(t);           // re-renderiza com o texto
    const bulb = document.querySelector(`.tile[data-id="${t.id}"] .tile-bulb`); if (bulb) bulb.classList.add("has");
    saveWorking();
  } catch (e) {
    openModal(`<div class="insight-modal"><h3>${esc(t.title)}</h3><p class="im-text" style="color:#f87171">Erro: ${esc(e.message)}</p><div class="modal-row"><button class="pill ghost" id="m-cancel">Fechar</button></div></div>`);
    $("m-cancel").onclick = closeModal;
  }
}

function openSqlModal(t) {
  openModal(`<h3>SQL — ${esc(t.title)}</h3><textarea id="m-sql">${esc(t.sql)}</textarea>
    <div class="modal-row"><button class="pill ghost" id="m-cancel">Fechar</button><button class="pill run" id="m-run">Rodar</button></div>`);
  $("m-cancel").onclick = closeModal;
  $("m-run").onclick = async () => {
    const sql = $("m-sql").value; $("m-run").innerHTML = 'Rodando<span class="busy"></span>';
    const r = await post("/report/run", { sql });
    if (!r.ok) { $("m-run").textContent = "Rodar"; alert(r.error); return; }
    t.sql = sql; t.columns = r.columns; t.rows = r.rows; t.rowCount = r.rowCount; t.error = undefined;
    closeModal(); renderAll();
  };
}

// ── espaço do usuário: perfil + relatórios salvos com resumo ──
let userProfile = null;
async function loadUserProfile() {
  try { const r = await fetch("/user").then((x) => x.json()); userProfile = (r.ok && r.user) || {}; } catch { userProfile = {}; }
  const av = $("btn-user"); if (av) av.textContent = (userProfile.name || "?").trim().charAt(0).toUpperCase() || "?";
}
async function openUserSpace() {
  const r = await fetch("/dashboard/list").then((x) => x.json()).catch(() => ({}));
  const items = r.items || [];
  const u = userProfile || {};
  const fmtDt = (iso) => { if (!iso) return ""; const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("pt-BR") + " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); };
  const cards = items.map((it) => `
    <div class="us-card" data-n="${esc(it.name)}">
      <div class="us-card-main">
        <div class="us-title">${esc(it.title)}</div>
        <div class="us-meta">${[fmtDt(it.savedAt), it.tiles ? `${it.tiles} painéis` : "", it.file].filter(Boolean).map(esc).join(" · ")}</div>
        ${it.asked ? `<div class="us-sum">${esc(it.asked)}</div>` : it.domain ? `<div class="us-sum">${esc(it.domain)}</div>` : ""}
      </div>
      <div class="us-card-actions">
        <button class="pill run us-open" data-n="${esc(it.name)}">Abrir</button>
        <button class="us-del" data-n="${esc(it.name)}" title="Excluir">×</button>
      </div>
    </div>`).join("");
  openModal(`<div class="user-space">
    <div class="us-head">
      <span class="us-avatar">${esc((u.name || "?").trim().charAt(0).toUpperCase() || "?")}</span>
      <div><h3 style="margin:0">Seu espaço</h3><div class="db-meta">Perfil e relatórios salvos — tudo local, na sua máquina.</div></div>
    </div>
    <div class="us-profile">
      <input id="us-name" class="fld" placeholder="Seu nome" value="${esc(u.name || "")}" />
      <input id="us-role" class="fld" placeholder="Cargo (ex.: Analista de Dados)" value="${esc(u.role || "")}" />
      <input id="us-company" class="fld" placeholder="Empresa" value="${esc(u.company || "")}" />
      <button class="pill ghost" id="us-save">Salvar perfil</button>
    </div>
    <div class="us-sec">Relatórios salvos <span class="db-meta">(${items.length})</span></div>
    <div class="us-list">${cards || '<div class="db-meta" style="padding:14px 4px">Nenhum relatório salvo ainda — monte um dashboard e use o ícone de disquete para salvar.</div>'}</div>
    <div class="modal-row"><button class="pill ghost" id="m-cancel">Fechar</button></div>
  </div>`);
  $("m-cancel").onclick = closeModal;
  $("us-save").onclick = async () => {
    const body = { name: $("us-name").value, role: $("us-role").value, company: $("us-company").value };
    const rr = await post("/user", body);
    if (rr.ok) { userProfile = rr.user; loadUserProfile(); toast("Perfil salvo"); } else toast(rr.error || "Erro ao salvar", true);
  };
  $("modal-card").querySelectorAll(".us-open").forEach((b) => (b.onclick = () => loadDash(b.dataset.n)));
  $("modal-card").querySelectorAll(".us-del").forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm(`Excluir o relatório "${b.dataset.n}"?`)) return;
    await post("/dashboard/delete", { name: b.dataset.n });
    openUserSpace(); // re-renderiza a lista
  }));
}
async function loadDash(name) {
  closeModal(); showOverlay("Abrindo " + name, "");
  const r = await fetch("/dashboard/load?name=" + encodeURIComponent(name)).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) return fail(r.error);
  const spec = r.spec;
  // restaura documento se o dash foi criado a partir de arquivo
  if (spec.doc && spec.doc.columns) {
    docData = spec.doc; showDocBanner({ chip: false }); // silencioso — dados já nos tiles
    if (docData.rows) $("prompt").placeholder = `Pergunte sobre "${docData.name}"… ou envie em branco p/ um dashboard geral`;
  } else {
    docData = null; showDocBanner();
  }
  dash = { title: spec.title || name, tiles: spec.tiles || [], schemaTables: spec.schemaTables || [], source: spec.source, understanding: spec.understanding };
  _staggerNext = true;
  for (const t of dash.tiles) {
    if (t._doc) { // tile de documento: recalcula a partir dos dados salvos
      if (docData && docData.rows) Object.assign(t, aggregateDoc(docData.rows, t));
      else t.error = "Reanexe o arquivo para ver os dados.";
      continue;
    }
    if (t.sql) { // tile de banco: re-roda com dados frescos
      const rr = await post("/report/run", { sql: t.sql });
      if (rr.ok) { t.columns = rr.columns; t.rows = rr.rows; t.rowCount = rr.rowCount; t.error = undefined; }
      else t.error = rr.error || "Erro ao buscar dados.";
    } else if (!t.rows?.length) {
      // tile salvo antes do fix (sem _doc, sem sql) → era de documento
      t.error = "Reanexe o arquivo para ver os dados.";
    }
  }
  renderAll();
  hideOverlay();
}

function openSaveModal() {
  openModal(`<h3>Salvar dashboard</h3><input id="m-name" class="fld" style="width:100%;padding:10px 13px;border-radius:9px;border:1px solid var(--field-border);background:var(--field);color:var(--text);font:14px var(--font-ui)" value="${esc(dash.title || "Dashboard")}" />
    <div class="modal-row"><button class="pill ghost" id="m-cancel">Cancelar</button><button class="pill run" id="m-save">Salvar</button></div>`);
  $("m-cancel").onclick = closeModal;
  $("m-save").onclick = async () => {
    const name = $("m-name").value.trim() || "Dashboard"; dash.title = name;
    const spec = { ...dash, doc: docData ? { name: docData.name, columns: docData.columns, rows: docData.rows } : undefined };
    const r = await post("/dashboard/save", { name, spec });
    closeModal(); if (!r.ok) alert(r.error); else { $("db-name").textContent = name; $("title").textContent = name; }
  };
}

function openAddModal() {
  openModal(`<h3>Adicionar painel</h3><input id="m-add" class="fld" placeholder="ex.: ticket médio por empresa" style="width:100%;padding:10px 13px;border-radius:9px;border:1px solid var(--field-border);background:var(--field);color:var(--text);font:14px var(--font-ui)" />
    <div class="modal-row"><button class="pill ghost" id="m-cancel">Cancelar</button><button class="pill run" id="m-go">Adicionar</button></div>`);
  $("m-cancel").onclick = closeModal;
  $("m-add").focus();
  $("m-go").onclick = async () => {
    const nl = $("m-add").value.trim(); if (!nl) return;
    closeModal();
    editDash("adicione um painel: " + nl); // doc: regenera incluindo o novo painel
  };
}

// ── export HTML (auto-contido: KPIs + insights + tabelas + imagens dos gráficos) ──
function exportHtml() {
  const tiles = dash.tiles.map((t) => {
    if (t.error) return "";
    if (t.kind === "kpi") return `<div class="kpi"><div class="kt">${esc(t.title)}</div><div class="kv">${window.FMChart.fmtKpi(kpiValue(t), t.format)}</div></div>`;
    if (t.kind === "insight") return `<div class="card span insight"><h4>${esc(t.title)}</h4><p>${esc(t.narrative || "")}</p></div>`;
    if (t.kind === "table") return `<div class="card span"><h4>${esc(t.title)}</h4>${tableHTML(t)}</div>`;
    const c = charts[t.id]; const img = c ? c.getDataURL({ pixelRatio: 2, backgroundColor: "#fff" }) : "";
    return `<div class="card"><h4>${esc(t.title)}</h4><img src="${img}" style="max-width:100%"/></div>`;
  }).join("");
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(dash.title)}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;margin:24px;background:#f4f4f6}h1{font-size:22px}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.kpi,.card{background:#fff;border:1px solid #e4e4e8;border-radius:12px;padding:14px}
.kpi .kt{color:#666;font-size:13px}.kpi .kv{font-size:28px;font-weight:700;margin-top:4px}.card h4{margin:0 0 8px}.span{grid-column:1/-1}
.insight{border-left:4px solid #f97316}.insight p{color:#333;line-height:1.6;font-size:14px;margin:0}
table{border-collapse:collapse;width:100%;font:11px Tahoma}th,td{border:1px solid #b6b6b6;padding:3px 7px}th{background:#c0c0c0;color:#000080;text-align:left}</style>
<h1>${esc(dash.title)}</h1><div class="grid">${tiles}</div>`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  a.download = (dash.title || "dashboard").replace(/[^a-z0-9]+/gi, "_").slice(0, 40) + ".html";
  a.click(); URL.revokeObjectURL(a.href);
}

// ── wiring geral ──
function showView(v) {
  document.querySelectorAll("#view-toggle button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  $("dashboardboard").classList.toggle("hidden", v !== "dash");
  $("schemaboard").classList.toggle("hidden", v !== "schema");
}
// começa um dashboard NOVO (do zero): limpa o de trabalho salvo e volta ao estado vazio
function newDash() {
  dash = null; lastNl = ""; _pendingReason = null; docData = null;
  try { localStorage.removeItem("studio-dash-working"); } catch {}
  disposeCharts();
  showDocBanner();
  $("prompt").placeholder = "Descreva a análise… ou anexe uma planilha (clipe) e clique enviar";
  $("title").textContent = "";
  $("db-name").textContent = ""; // limpa o nome do dash anterior no topbar
  $("db-result").classList.add("hidden");
  $("db-empty").classList.remove("hidden");
  $("db-empty").querySelector(".eh-title").innerHTML = "Seus dados têm uma história.<br/>A IA conta ela para você.";
  $("db-empty").querySelector("div:nth-child(3)").innerHTML = "Solte uma planilha em qualquer lugar da tela — a IA <b>entende o que os dados são</b>, monta KPIs, gráficos e tabela, e entrega <b>insights analíticos</b> prontos em cada painel.";
  $("ex-chips").innerHTML = "";
  thinkClear();
  $("prompt").value = ""; $("prompt").focus();
}
function submitPrompt(nl) {
  nl = (nl ?? $("prompt").value).trim();
  const has = dash && dash.tiles && dash.tiles.length;
  if (has) { if (nl) { editDash(nl); $("prompt").value = ""; } return; } // já existe -> edita
  if (docData) { buildFromDoc(nl); $("prompt").value = ""; return; }     // doc novo (texto ou vazio = geral)
  toast("Anexe uma planilha (clipe ao lado) para começar.", true);       // sem doc: pede o arquivo
}
$("chat-form").addEventListener("submit", (e) => { e.preventDefault(); submitPrompt(); });
document.querySelectorAll("#view-toggle button").forEach((b) => (b.onclick = () => showView(b.dataset.view)));
$("t-save").onclick = () => dash && openSaveModal();
$("t-open").onclick = openUserSpace;
$("btn-user") && ($("btn-user").onclick = openUserSpace);
loadUserProfile();
// licença MIT no topbar — abre o texto completo num modal
$("btn-mit") && ($("btn-mit").onclick = async () => {
  const txt = await fetch("/license").then((r) => r.text()).catch(() => "MIT License — veja o arquivo LICENSE no repositório.");
  openModal(`<h3>Licença MIT</h3><div class="db-meta">Software livre: use, copie, modifique e distribua — mantendo o aviso de copyright.</div>
    <pre class="mit-pre">${esc(txt)}</pre>
    <div class="modal-row"><button class="pill ghost" id="m-cancel">Fechar</button></div>`);
  $("m-cancel").onclick = closeModal;
});
$("t-add") && ($("t-add").onclick = () => dash && docData && openAddModal());
$("t-rebuild").onclick = () => lastNl && docData && buildFromDoc(lastNl);
$("t-new").onclick = newDash;
$("t-index") && ($("t-index").onclick = indexCatalog);
$("t-spec")  && ($("t-spec").onclick  = specProfiler);

// indexa o banco (catálogo de dimensões) com progresso ao vivo
async function indexCatalog() {
  const st = await fetch("/catalog/status").then((x) => x.json()).catch(() => ({}));
  openModal(`<h3>Indexar o banco</h3>
    <div class="db-meta" style="margin-bottom:10px">Varre as tabelas-dimensão pequenas e guarda os <b>valores reais</b> (categoria, segmento, status…) num catálogo local seguro. Depois a IA passa a conhecer esses dados — sem reconsultar o banco a cada pedido. Roda uma vez (alguns minutos).</div>
    <div class="db-meta">${st.count ? `Catálogo atual: <b>${st.count}</b> dimensões${st.builtAt ? " · " + new Date(st.builtAt).toLocaleString("pt-BR") : ""}.` : "Catálogo ainda não construído."}</div>
    <div id="idx-prog" class="db-meta" style="margin-top:12px;min-height:20px"></div>
    <div class="modal-row"><button class="pill ghost" id="m-cancel">Fechar</button><button class="pill run" id="m-build">Construir agora</button></div>`);
  $("m-cancel").onclick = closeModal;
  $("m-build").onclick = async () => {
    $("m-build").innerHTML = 'Indexando<span class="busy"></span>'; $("m-build").disabled = true;
    try {
      const res = await fetch("/catalog/build", { method: "POST" });
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true }); const parts = buf.split("\n\n"); buf = parts.pop();
        for (const part of parts) {
          const ev = parseSse(part); if (!ev) continue;
          if (ev.event === "progress") { const p = ev.data; $("idx-prog").textContent = p.stage === "scan" ? `Varendo ${p.total} tabelas candidatas…` : p.stage === "progress" ? `${p.i}/${p.total} · ${p.count} dimensões catalogadas` : "Finalizando…"; }
          else if (ev.event === "done") { $("idx-prog").innerHTML = ev.data.ok ? `✓ <b>${ev.data.count}</b> dimensões catalogadas (de ${ev.data.scanned} candidatas).` : "Erro: " + ev.data.error; $("m-build").innerHTML = "Construir de novo"; $("m-build").disabled = false; }
        }
      }
    } catch (e) { $("idx-prog").textContent = "Erro: " + e.message; $("m-build").disabled = false; $("m-build").textContent = "Tentar de novo"; }
  };
}
// Fase 2: SPEC Auto-Profiler — classifica tabelas e descobre métricas sem IA
async function specProfiler() {
  const st = await fetch("/spec/status").then((x) => x.json()).catch(() => ({}));
  openModal(`<h3>Perfilar banco (SPEC)</h3>
    <div class="db-meta" style="margin-bottom:10px">Classifica cada tabela como <b>fato</b>, <b>dimensão</b>, <b>bridge</b> ou <b>lookup</b> e descobre as <b>métricas automáticas</b> (colunas de valor → SUM) e <b>dimensões canônicas</b>. Roda sem IA — puro SQL de metadados. Base do modo SaaS.</div>
    <div class="db-meta">${st.exists ? `SPEC atual: <b>${st.tableCount}</b> tabelas · ${st.summary ? Object.entries(st.summary).map(([k,v]) => `${v} ${k}`).join(", ") : ""} · ${st.builtAt ? new Date(st.builtAt).toLocaleString("pt-BR") : ""}` : "SPEC ainda não construído."}</div>
    <div id="spec-prog" class="db-meta" style="margin-top:12px;min-height:20px"></div>
    <div class="modal-row"><button class="pill ghost" id="m-spec-cancel">Fechar</button><button class="pill run" id="m-spec-build">Perfilar agora</button></div>`);
  $("m-spec-cancel").onclick = closeModal;
  $("m-spec-build").onclick = async () => {
    $("m-spec-build").innerHTML = 'Perfilando<span class="busy"></span>'; $("m-spec-build").disabled = true;
    try {
      const res = await fetch("/spec/build", { method: "POST" });
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true }); const parts = buf.split("\n\n"); buf = parts.pop();
        for (const part of parts) {
          const ev = parseSse(part); if (!ev) continue;
          if (ev.event === "progress") {
            const p = ev.data;
            $("spec-prog").textContent = p.stage === "spec-list" ? p.msg :
              p.stage === "spec-progress" ? `${p.done}/${p.total} tabelas perfiladas…` : p.msg || "Trabalhando…";
          } else if (ev.event === "done") {
            const d = ev.data;
            $("spec-prog").innerHTML = d.ok
              ? `✓ <b>${d.tableCount}</b> tabelas · ${d.summary ? Object.entries(d.summary).map(([k,v]) => `${v} ${k}`).join(", ") : ""}`
              : "Erro: " + d.error;
            $("m-spec-build").innerHTML = "Refazer"; $("m-spec-build").disabled = false;
          }
        }
      }
    } catch (e) { $("spec-prog").textContent = "Erro: " + e.message; $("m-spec-build").disabled = false; $("m-spec-build").textContent = "Tentar de novo"; }
  };
}

const exMenu = $("export-menu");
$("btn-export").onclick = (e) => { e.stopPropagation(); if (!$("btn-export").disabled) exMenu.classList.toggle("hidden"); };
document.addEventListener("click", (e) => { if (!e.target.closest(".export-wrap")) exMenu.classList.add("hidden"); });
exMenu.querySelector('[data-fmt="html"]').onclick = () => { exportHtml(); exMenu.classList.add("hidden"); };
exMenu.querySelector('[data-fmt="pptx"]')?.addEventListener("click", () => { exportPptx(); exMenu.classList.add("hidden"); });
window.addEventListener("resize", () => { for (const id in charts) charts[id].resize(); });

// ── export PowerPoint: deck de ALTA FIDELIDADE (capa, resumo executivo, gráfico+insight, encerramento) ──
async function exportPptx() {
  if (!dash || !dash.tiles.length) return;
  const panelColor = tokFn()("--panel", "#211f1e"); // captura no tema atual — o slide emoldura na mesma cor
  const tiles = dash.tiles.map((t) => {
    const o = { kind: t.kind, title: t.title, columns: t.columns, narrative: t.narrative, insight: t.insight };
    if (t._doc && t.filters && t.filters.length) o._filt = filterLabel(t);
    if (t.kind === "kpi") o._kpiValue = window.FMChart.fmtKpi(kpiValue(t), t.format);
    else if (t.kind === "table") o._rows = (t.rows || []).slice(0, 30);
    else if (charts[t.id]) {
      const dom = charts[t.id].getDom();
      o._chartRatio = dom && dom.clientWidth ? dom.clientHeight / dom.clientWidth : 0.56;
      o._chartImage = charts[t.id].getDataURL({ type: "png", pixelRatio: 2, backgroundColor: panelColor });
    }
    return o;
  });
  try {
    toast("Montando a apresentação…");
    const res = await fetch("/export/pptx", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: dash.title, fileName: docData?.name || null, user: userProfile,
        understanding: dash.understanding || null, panelColor, tiles }) });
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (dash.title || "dashboard").replace(/[^a-z0-9]+/gi, "_").slice(0, 40) + ".pptx";
    a.click(); URL.revokeObjectURL(a.href);
  } catch (e) { toast("Erro ao gerar PowerPoint: " + e.message, true); }
}

// ── modo apresentação ──
function enterPresent() {
  document.body.classList.add("present");
  $("present-title").textContent = dash?.title || "Dashboard";
  setTimeout(() => { for (const id in charts) charts[id].resize(); }, 50);
}
function exitPresent() {
  document.body.classList.remove("present");
  setTimeout(() => { for (const id in charts) charts[id].resize(); }, 50);
}
$("btn-present").onclick = () => enterPresent();
$("present-exit").onclick = () => exitPresent();
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("present")) exitPresent(); });

// init
applyTheme(localStorage.getItem("studio-theme") || "dark");
$("ex-chips").innerHTML = "";
// ── logo: volta ao topo (recarrega) ──
document.querySelector("#topbar .logo")?.addEventListener("click", () => (location.href = "/"));

// ── tutorial gamificado (spotlight + fala) ──
const TOUR = [
  { sel: "#attach", place: "top", text: "Bem-vindo ao Dash.IA! Comece anexando um arquivo aqui no clipe — CSV, Excel (lê TODAS as abas) ou PDF (lê todas as páginas) — ou arraste para qualquer lugar da tela." },
  { sel: "#ctx-btn", place: "top", text: "Este é o livro de CONTEXTO: explique o que as colunas significam, siglas e regras do negócio. A IA lê isso antes de montar qualquer painel — e o texto fica salvo por arquivo. Opcional, mas deixa a análise muito mais certeira." },
  { sel: "#chat-form", place: "top", text: "Descreva o que quer analisar em português (\"percentual do faturamento por estado em 2024\") — ou deixe em branco para um dashboard geral. Uma equipe de agentes de IA entende os dados e monta tudo." },
  { sel: "#dashboardboard", place: "auto", text: "Aqui ficam os painéis: KPIs, gráficos, tabela e insights analíticos (a lâmpada de cada painel já vem pronta). Você arrasta pra reordenar, redimensiona ou remove cada um." },
  { sel: "#btn-user", place: "bottom", text: "Este é o seu espaço: seu perfil e a lista dos relatórios salvos, com resumo — pra abrir qualquer um em um clique." },
  { sel: "#btn-export", place: "bottom", text: "E aqui você exporta: página HTML ou uma apresentação PowerPoint de alta fidelidade com capa, resumo executivo e um slide por gráfico com o insight ao lado. Bom proveito!" },
];
const tourEl = $("tour"), tourSpot = $("tour-spot"), tourPop = $("tour-pop"), tourTextEl = $("tour-text"), tourStepEl = $("tour-step"), tourNextBtn = $("tour-next");
let tourIdx = 0, tourTyper = null;
function tourType(t) {
  clearInterval(tourTyper); tourTextEl.textContent = ""; tourTextEl.classList.remove("done");
  let i = 0;
  tourTyper = setInterval(() => { i++; tourTextEl.textContent = t.slice(0, i); if (i >= t.length) { clearInterval(tourTyper); tourTyper = null; tourTextEl.classList.add("done"); } }, 13);
}
function placeTourPop(r, place) {
  const pr = tourPop.getBoundingClientRect(), gap = 14, vw = innerWidth, vh = innerHeight;
  const opt = (p) => p === "top" ? { l: r.left + r.width / 2 - pr.width / 2, t: r.top - pr.height - gap }
    : p === "right" ? { l: r.right + gap, t: r.top + r.height / 2 - pr.height / 2 }
    : p === "left" ? { l: r.left - pr.width - gap, t: r.top + r.height / 2 - pr.height / 2 }
    : { l: r.left + r.width / 2 - pr.width / 2, t: r.bottom + gap };
  let c = opt(place === "auto" ? "bottom" : place);
  if (c.t + pr.height > vh - 10) c = opt("top");
  if (c.t < 10) c = opt("bottom");
  tourPop.style.left = Math.max(12, Math.min(c.l, vw - pr.width - 12)) + "px";
  tourPop.style.top = Math.max(12, Math.min(c.t, vh - pr.height - 12)) + "px";
}
function positionTour() {
  const s = TOUR[tourIdx], el = document.querySelector(s.sel);
  if (!el || !el.getClientRects().length) return;
  const r = el.getBoundingClientRect(), p = 7;
  tourSpot.style.left = (r.left - p) + "px"; tourSpot.style.top = (r.top - p) + "px";
  tourSpot.style.width = (r.width + p * 2) + "px"; tourSpot.style.height = (r.height + p * 2) + "px";
  placeTourPop(r, s.place);
}
function showTourStep(i) {
  if (i >= TOUR.length) return endTour(true);
  const s = TOUR[i], el = document.querySelector(s.sel);
  if (!el || !el.getClientRects().length) return showTourStep(i + 1);
  tourIdx = i; positionTour();
  tourStepEl.textContent = `${i + 1}/${TOUR.length}`;
  tourNextBtn.querySelector("span").textContent = i === TOUR.length - 1 ? "Começar!" : "Próximo";
  tourType(s.text);
}
function startTour(force) { if (!force && localStorage.getItem("studio-dash-tour-done")) return; tourEl.classList.remove("hidden"); showTourStep(0); }
function endTour(done) { clearInterval(tourTyper); tourTyper = null; tourEl.classList.add("hidden"); if (done) try { localStorage.setItem("studio-dash-tour-done", "1"); } catch {} }
tourNextBtn.addEventListener("click", () => {
  if (tourTyper) { clearInterval(tourTyper); tourTyper = null; tourTextEl.textContent = TOUR[tourIdx].text; tourTextEl.classList.add("done"); return; }
  if (tourIdx >= TOUR.length - 1) endTour(true); else showTourStep(tourIdx + 1);
});
$("tour-skip").addEventListener("click", () => endTour(true));
$("tour-help").addEventListener("click", () => startTour(true));
addEventListener("resize", () => { if (!tourEl.classList.contains("hidden")) positionTour(); });

// ── preparar o ambiente ao entrar: liga a IA + indexa o banco (1x), com progresso ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function finishPrep() {
  $("prep").classList.add("prep-done");
  setTimeout(() => $("prep").classList.add("hidden"), 450);
  if (location.hash === "#open") return setTimeout(openOpenModal, 200); // veio de "Abrir dashboard salvo"
  if (location.hash === "#new") { // veio de "Novo dashboard": começa limpo, não restaura o anterior
    try { localStorage.removeItem("studio-dash-working"); } catch {}
    history.replaceState(null, "", location.pathname);
    if (!localStorage.getItem("studio-dash-tour-done")) setTimeout(() => startTour(false), 500);
    return;
  }
  restoreWorking().then((restored) => { // recupera o dashboard de trabalho perdido no reload
    if (!restored && !localStorage.getItem("studio-dash-tour-done")) setTimeout(() => startTour(false), 500);
  });
}
// Dash.IA não tem banco — entra direto (sem indexação). A tela de prep fica só como splash rápido.
function prepareEnvironment() {
  const prep = $("prep");
  if (prep) prep.classList.add("hidden");
  finishPrep();
}
prepareEnvironment();

// ════════════ Builder arrasta-e-solta: painel de campos + cruzamento via IA ════════════
const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
function isFieldDrag(e) { return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("application/x-field"); }
// colunas técnicas/auditoria escondidas por padrão (mostráveis via "+ N técnicos")
const NOISE_COL = /(^DATA_(CADASTRO|ALTERACAO|INCLUSAO|ATUALIZACAO|IMPORTACAO|MIGRACAO))|^DT_(CAD|ALT)|USUARIO|STRID|^HORA_|_HORA$|TIMESTAMP|CONTROLE|^SEQ_|_SEQ$|^ROW|^FLAG_MIGR|ORIGEM_REGISTRO/i;
function colKind(type) { return /CHAR|CLOB/i.test(type) ? "txt" : /DATE|TIMESTAMP/i.test(type) ? "dat" : "num"; }
function fieldOf(raw) {
  const k = colKind(raw.type);
  let role = k === "num" ? "measure" : "dimension";
  if (k === "num" && /^(CODIGO|ID|NUMERO|COD|CNPJ|CPF|CEP)|_(CODIGO|ID)$/i.test(raw.column)) role = "dimension";
  return role === "measure" ? { table: raw.table, column: raw.column, role, agg: "SUM" } : { table: raw.table, column: raw.column, role };
}
function inferViz(fields) {
  const dims = fields.filter((f) => f.role === "dimension"), meas = fields.filter((f) => f.role === "measure");
  if (dims.length === 0 && meas.length >= 1) return { kind: "kpi" };
  if (meas.length >= 1 && dims.some((f) => /ESTADO|^UF$|_UF$|REGIAO/i.test(f.column))) return { kind: "chart", chartType: "map" }; // campo geográfico -> mapa
  if (dims.length >= 1 && meas.length >= 1) return { kind: "chart", chartType: "bar" };
  return { kind: "table" };
}
function setTileViz(tile, v) {
  if (v === "kpi") tile.kind = "kpi";
  else if (v === "table") tile.kind = "table";
  else { tile.kind = "chart"; tile.chartType = v; }
  if (tile._doc && docData) Object.assign(tile, aggregateDoc(docData.rows, tile)); // recalcula com a nova forma
  renderAll();
}
async function requeryTile(tile) {
  if (!tile.fields || !tile.fields.length) return;
  const el = document.querySelector(`.tile[data-id="${tile.id}"]`); if (el) el.classList.add("loading");
  const viz = inferViz(tile.fields); tile.kind = viz.kind; tile.chartType = viz.chartType;
  const r = await post("/dashboard/field-query", { fields: tile.fields });
  if (r.ok) { tile.sql = r.sql; tile.columns = r.columns; tile.rows = r.rows; tile.rowCount = r.rowCount; tile.error = undefined; if (r.title) tile.title = r.title; }
  else tile.error = r.error;
  renderAll();
}
function addFieldToTile(tile, raw) {
  const f = fieldOf(raw); tile.fields = tile.fields || [];
  if (tile.fields.some((x) => x.table === f.table && x.column === f.column)) return;
  tile.fields.push(f); requeryTile(tile);
}
function newTileFromField(raw) {
  const f = fieldOf(raw);
  const tile = { id: "t" + Date.now().toString(36) + Math.floor(Math.random() * 1e3).toString(36), kind: "table", w: 6, fields: [f], title: f.column };
  dash.tiles.push(tile); renderAll(); requeryTile(tile);
}
function removeField(tile, i) {
  tile.fields.splice(i, 1);
  if (!tile.fields.length) { dash.tiles = dash.tiles.filter((x) => x.id !== tile.id); renderAll(); return; }
  requeryTile(tile);
}
let fpLoaded = false;
function openFields() {
  if (!dash) { dash = { title: "Meu dashboard", tiles: [], schemaTables: [] }; renderAll(); }
  document.body.classList.add("fields-open");
  if (!fpLoaded) { fpLoaded = true; searchTables(""); }
  setTimeout(() => { for (const id in charts) charts[id].resize(); }, 280);
}
function closeFields() { document.body.classList.remove("fields-open"); setTimeout(() => { for (const id in charts) charts[id].resize(); }, 280); }
$("fields-tab") && ($("fields-tab").onclick = () => (document.body.classList.contains("fields-open") ? closeFields() : openFields()));
$("fp-close") && ($("fp-close").onclick = closeFields);
$("fp-search") && $("fp-search").addEventListener("input", debounce(() => searchTables($("fp-search").value.trim()), 260));
async function searchTables(q) {
  const r = await fetch("/schema/search?q=" + encodeURIComponent(q)).then((x) => x.json()).catch(() => ({}));
  const list = $("fp-list"); list.innerHTML = "";
  if (!r.tables || !r.tables.length) { list.innerHTML = '<div class="fp-hint" style="border:0">Nada encontrado.</div>'; return; }
  for (const t of r.tables) list.appendChild(fpTableEl(t));
}
const CARET = '<svg class="fp-caret" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
function fpTableEl(t) {
  const el = document.createElement("div"); el.className = "fp-table";
  el.innerHTML = `<div class="fp-tname">${CARET}<span>${esc(t.table)}</span>${t.numRows != null ? `<span class="fp-rows">${t.numRows}</span>` : ""}</div><div class="fp-cols"></div>`;
  const cols = el.querySelector(".fp-cols");
  el.querySelector(".fp-tname").onclick = async () => {
    el.classList.toggle("open");
    if (el.classList.contains("open") && !cols.dataset.loaded) {
      cols.dataset.loaded = "1"; cols.innerHTML = '<div class="fp-col" style="opacity:.6">carregando…</div>';
      const r = await fetch("/schema/columns?table=" + encodeURIComponent(t.table)).then((x) => x.json()).catch(() => ({}));
      const all = r.columns || [];
      const useful = all.filter((c) => !NOISE_COL.test(c.name)), tech = all.filter((c) => NOISE_COL.test(c.name));
      cols.innerHTML = "";
      for (const c of useful) cols.appendChild(fpColEl(t.table, c));
      if (tech.length) {
        const more = document.createElement("div"); more.className = "fp-more"; more.textContent = `+ ${tech.length} campos técnicos`;
        more.onclick = () => { more.remove(); for (const c of tech) cols.appendChild(fpColEl(t.table, c)); };
        cols.appendChild(more);
      }
    }
  };
  return el;
}
function fpColEl(table, c) {
  const el = document.createElement("div"); el.className = "fp-col"; el.draggable = true;
  const k = colKind(c.type), lbl = k === "num" ? "#" : k === "dat" ? "D" : "A";
  el.innerHTML = `<span class="fp-type ${k}">${lbl}</span><span>${esc(c.name)}</span>`;
  el.title = `${c.name} · ${c.type}${c.comment ? " — " + c.comment : ""}`;
  el.addEventListener("dragstart", (e) => { e.dataTransfer.setData("application/x-field", JSON.stringify({ table, column: c.name, type: c.type })); e.dataTransfer.effectAllowed = "copy"; });
  return el;
}
(() => {
  const board = $("dashboardboard");
  board.addEventListener("dragover", (e) => { if (isFieldDrag(e)) { e.preventDefault(); board.classList.add("fp-drag"); } });
  board.addEventListener("dragleave", (e) => { if (e.target === board) board.classList.remove("fp-drag"); });
  board.addEventListener("drop", (e) => { board.classList.remove("fp-drag"); if (!isFieldDrag(e)) return; e.preventDefault(); try { newTileFromField(JSON.parse(e.dataTransfer.getData("application/x-field"))); } catch {} });
})();

// ════════════ Análise a partir de DOCUMENTO (CSV/XLSX) ════════════
function toast(msg, err) {
  const el = document.createElement("div");
  el.textContent = msg;
  el.style.cssText = `position:fixed;bottom:120px;left:50%;transform:translateX(-50%);z-index:90;padding:9px 16px;border-radius:10px;font:13px var(--font-ui);color:#fff;background:${err ? "#dc2626" : "var(--accent,#f97316)"};box-shadow:0 8px 24px rgba(0,0,0,.25)`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
let docData = null; // { name, columns:[{name,type}], rows:[{}] }
let docCtx  = "";   // contexto escrito pelo usuário sobre o documento (colunas, siglas, regras) — vai à IA em todo prompt

// painel de contexto: botão no chat-form abre/fecha; texto persiste por ARQUIVO (localStorage) e no auto-save
const ctxKey = () => "dashia-ctx:" + (docData?.name || "_geral");
function setDocCtx(v, { store = true } = {}) {
  docCtx = String(v || "");
  $("ctx-text").value = docCtx;
  $("ctx-btn").classList.toggle("on", !!docCtx.trim());
  if (store) { try { docCtx.trim() ? localStorage.setItem(ctxKey(), docCtx) : localStorage.removeItem(ctxKey()); } catch {} }
}
$("ctx-btn").onclick = () => { const p = $("ctx-panel"); p.classList.toggle("hidden"); if (!p.classList.contains("hidden")) $("ctx-text").focus(); };
$("ctx-close").onclick = () => $("ctx-panel").classList.add("hidden");
$("ctx-text").addEventListener("input", (e) => setDocCtx(e.target.value));
$("attach").onclick = () => $("doc-input").click();
$("db-attach-cta") && ($("db-attach-cta").onclick = () => $("doc-input").click());
// Decodifica CSV respeitando o encoding: UTF-8 (com/sem BOM) ou, se falhar, Windows-1252 —
// exports de ERP brasileiro costumam vir em Latin-1 (acentos viram "?" se lidos como UTF-8).
// (usado só no fallback síncrono; o caminho normal é o parse-worker.js, que tem cópia própria)
function decodeCsvBytes(bytes) {
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("windows-1252").decode(bytes); } // acentos preservados
}

// Converte a planilha em objetos DETECTANDO a linha de cabeçalho real (pula linhas de título)
// e convertendo datas (Date do Excel e seriais numéricos) para ISO.
function sheetToObjects(ws) {
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, blankrows: false });
  if (!aoa.length) return { columns: [], rows: [] };
  // cabeçalho = linha (entre as 15 primeiras) com mais células preenchidas, favorecendo texto (nomes de coluna)
  let headerIdx = 0, best = -1;
  for (let i = 0; i < Math.min(15, aoa.length); i++) {
    const cells = aoa[i] || [];
    const nonEmpty = cells.filter((c) => c != null && String(c).trim() !== "").length;
    const textCells = cells.filter((c) => c != null && String(c).trim() !== "" && isNaN(Number(c))).length;
    const score = nonEmpty + textCells * 0.5;
    if (score > best) { best = score; headerIdx = i; }
  }
  const seen = {};
  const header = (aoa[headerIdx] || []).map((h, j) => {
    let name = (h == null || String(h).trim() === "") ? `coluna_${j + 1}` : String(h).trim();
    if (seen[name] != null) { seen[name]++; name = `${name}_${seen[name]}`; } else seen[name] = 0;
    return name;
  });
  const pad = (n) => String(n).padStart(2, "0");
  const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const serialToDate = (n) => { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
  const isDateCol = /DATA|VENCIMENT|EMISS|ENTREGA|NASCIMENT|COMPETENC|PAGAMENTO|^DT[_ ]|[_ ]DT$|^DT$/i;
  const rows = [];
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const arr = aoa[i];
    if (!arr || arr.every((c) => c == null || String(c).trim() === "")) continue;
    const o = {};
    for (let j = 0; j < header.length; j++) {
      let v = arr[j] ?? null; const k = header[j];
      if (v instanceof Date) v = fmtDate(v);
      else if (typeof v === "number" && isDateCol.test(k) && v > 20000 && v < 80000) v = serialToDate(v);
      o[k] = v;
    }
    rows.push(o);
  }
  const columns = header.map((name) => ({ name, type: inferColType(rows, name) }));
  // Normaliza colunas numéricas UMA vez no parse: strings pt-BR ("1.234,56") viram Number
  // de verdade — todo o pipeline downstream (agregação, gráfico, insight) trabalha com número.
  const numCols = columns.filter((c) => c.type === "número").map((c) => c.name);
  if (numCols.length) for (const r of rows) for (const k of numCols) {
    const v = r[k];
    if (typeof v === "string" && v.trim() !== "") { const n = toNumberBR(v); if (n !== null) r[k] = n; }
  }
  return { columns, rows };
}

// Converte string numérica (pt-BR "1.234,56" / "1.234.567" ou en "1,234.56") em Number; null se não for número.
// Cobre contábil "(1.234,56)" e SAP "1.234,56-" (negativos) — célula descartada em silêncio = soma ERRADA.
function toNumberBR(v) {
  if (typeof v === "number") return isNaN(v) ? null : v;
  if (typeof v !== "string") return null;
  let s = v.trim().replace(/^R\$\s*/, "").replace(/%$/, "");
  let neg = false;
  if (/^\(.+\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); } // contábil: (1.234,56) = negativo
  if (/-$/.test(s))       { neg = true; s = s.slice(0, -1); }        // SAP: 1.234,56- = negativo
  if (!s || /[^\d.,\-+eE\s]/.test(s)) return null;
  s = s.replace(/\s/g, "");
  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");   // pt-BR: 1.234,56
  else if (lastComma !== -1 && lastDot > lastComma) s = s.replace(/,/g, ""); // en: 1,234.56
  else if (lastComma !== -1) s = s.replace(",", ".");                     // só vírgula: 12,5
  else if (lastDot !== -1 && /^[-+]?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ""); // 1.234.567 = milhar pt-BR sem vírgula
  const n = Number(s);
  return isNaN(n) ? null : (neg ? -n : n);
}

// contexto completo enviado à IA: o que o usuário escreveu + abas auxiliares/origem do arquivo
function aiContext() {
  return [docCtx, docData && docData.sheetContext].filter((s) => s && String(s).trim()).join("\n\n");
}

async function ingestFile(f) {
  if (!f) return;
  if (!/\.(csv|xlsx|xls|pdf)$/i.test(f.name)) return toast("Formato não suportado — use CSV, XLSX, XLS ou PDF.", true);
  showOverlay("Lendo " + f.name, fmtBytes(f.size)); // feedback IMEDIATO — o parse pesado roda no worker
  try {
    let columns, rows, stats, sheetsInfo = null, sheetContext = "";
    if (/\.pdf$/i.test(f.name)) {
      const r = await parsePdfFile(f); // pdf.js (todas as páginas) + IA estrutura os dados
      columns = r.columns; rows = r.rows; stats = docStatsText(columns, rows); sheetContext = r.context;
    } else {
      const r = await parseFileAsync(f);
      columns = r.columns; rows = r.rows; stats = r.stats; sheetsInfo = r.sheetsInfo || null;
      if (sheetsInfo && sheetsInfo.context) sheetContext = sheetsInfo.context;
    }
    if (!rows.length) { hideOverlay(); return toast("Documento vazio ou sem dados.", true); }
    docData = { name: f.name, columns, rows, stats, sheetContext, sheetsInfo };
    try { setDocCtx(localStorage.getItem(ctxKey()) || "", { store: false }); } catch {} // recupera o contexto deste arquivo
    hideOverlay();
    showDocBanner();
    $("prompt").placeholder = `Pergunte sobre "${f.name}"… ou envie em branco p/ um dashboard geral`;
    let msg = `${f.name}: ${rows.length.toLocaleString("pt-BR")} linhas, ${columns.length} colunas`;
    if (sheetsInfo && sheetsInfo.stacked) msg += ` · ${sheetsInfo.used.length} abas empilhadas (${sheetsInfo.used.join(", ")})`;
    if (sheetsInfo && sheetsInfo.context) msg += " · abas auxiliares viraram contexto da IA";
    toast(msg);
    if (sheetsInfo && sheetsInfo.ignored && sheetsInfo.ignored.length)
      setTimeout(() => toast(`Abas com estrutura diferente ficaram de fora: ${sheetsInfo.ignored.join("; ")}`, true), 1200);
    $("prompt").focus();
  } catch (err) { hideOverlay(); toast("Falha ao ler o documento: " + err.message, true); }
}

// PDF: pdf.js extrai o texto de TODAS as páginas (preservando linhas) e a IA estrutura em colunas/linhas
async function parsePdfFile(f) {
  overlaySub("carregando o leitor de PDF…");
  if (!window.pdfjsLib) await new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = "/vendor/pdf.min.js";
    s.onload = res; s.onerror = () => rej(new Error("leitor de PDF não disponível")); document.head.appendChild(s);
  });
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.js";
  // isEvalSupported:false — mitigação do CVE-2024-4367 (execução de JS via fonte maliciosa no PDF)
  const doc = await pdfjsLib.getDocument({ data: await f.arrayBuffer(), isEvalSupported: false }).promise;
  const nPages = Math.min(doc.numPages, 300);
  const pages = [];
  for (let i = 1; i <= nPages; i++) {
    overlaySub(`lendo página ${i}/${doc.numPages}…`);
    const pg = await doc.getPage(i);
    const tc = await pg.getTextContent();
    const lines = new Map(); // agrupa por Y — preserva a estrutura de tabela do PDF
    for (const it of tc.items) { const y = Math.round(it.transform[5]); if (!lines.has(y)) lines.set(y, []); lines.get(y).push(it); }
    pages.push([...lines.entries()].sort((a, b) => b[0] - a[0])
      .map(([, its]) => its.sort((a, b) => a.transform[4] - b.transform[4]).map((t) => t.str).join(" ").trim())
      .filter(Boolean).join("\n"));
  }
  overlaySub("estruturando os dados com a IA…");
  const r = await post("/doc/extract-pdf", { name: f.name, pages });
  if (!r.ok) throw new Error(r.error || "falha ao extrair o PDF");
  if (!r.rows || !r.rows.length) throw new Error(r.note || "não encontrei dados tabulares neste PDF");
  const context = `ORIGEM: PDF "${f.name}" (${doc.numPages} páginas, todas lidas${doc.numPages > nPages ? `, ${nPages} processadas` : ""}).` +
    (r.title ? ` Conteúdo: ${r.title}.` : "") + (r.note ? ` Extração: ${r.note}` : "");
  return { columns: r.columns || [], rows: r.rows, context };
}

// Parse do arquivo FORA da thread da UI (Web Worker) — planilhas grandes não travam mais a tela.
let _parseWorker = null;
function parseFileAsync(f) {
  return new Promise(async (resolve, reject) => {
    let buf;
    try { buf = await f.arrayBuffer(); } catch (e) { return reject(e); }
    if (window.Worker) {
      try {
        if (!_parseWorker) _parseWorker = new Worker("/parse-worker.js");
        _parseWorker.onmessage = (ev) => {
          const d = ev.data || {};
          if (d.progress) return overlaySub(d.progress);
          if (d.ok) resolve({ columns: d.columns, rows: d.rows, stats: d.stats, sheetsInfo: d.sheetsInfo });
          else reject(new Error(d.error || "falha ao processar o arquivo"));
        };
        _parseWorker.onerror = () => { _parseWorker = null; reject(new Error("falha no processamento em segundo plano")); };
        _parseWorker.postMessage({ name: f.name, buf }, [buf]); // transfere o buffer (zero cópia)
        return;
      } catch { _parseWorker = null; /* cai no fallback síncrono */ }
    }
    // fallback síncrono (browser sem Worker) — trava, mas funciona
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const wb = /\.csv$/i.test(f.name)
        ? XLSX.read(decodeCsvBytes(bytes), { type: "string" })
        : XLSX.read(bytes.buffer, { type: "array", cellDates: true });
      resolve(sheetToObjects(wb.Sheets[wb.SheetNames[0]]));
    } catch (e) { reject(e); }
  });
}
$("doc-input").addEventListener("change", (e) => { const f = e.target.files?.[0]; e.target.value = ""; ingestFile(f); });

// ── drag & drop de arquivo em QUALQUER lugar da tela (overlay via body.dropping) ──
const hasFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");
let _dragDepth = 0;
document.addEventListener("dragenter", (e) => { if (!hasFileDrag(e)) return; e.preventDefault(); _dragDepth++; document.body.classList.add("dropping"); });
document.addEventListener("dragover",  (e) => { if (hasFileDrag(e)) e.preventDefault(); });
document.addEventListener("dragleave", (e) => { if (!hasFileDrag(e)) return; _dragDepth = Math.max(0, _dragDepth - 1); if (!_dragDepth) document.body.classList.remove("dropping"); });
document.addEventListener("drop", (e) => {
  if (!hasFileDrag(e)) return;
  e.preventDefault(); _dragDepth = 0; document.body.classList.remove("dropping");
  const f = e.dataTransfer.files?.[0];
  if (f) ingestFile(f);
});
function inferColType(rows, col) {
  const vals = rows.slice(0, 60).map((r) => r[col]).filter((v) => v != null && v !== "");
  if (!vals.length) return "texto";
  if (vals.some((v) => /^\d{4}-\d\d-\d\d/.test(String(v)))) return "data";
  if (vals.every((v) => !isNaN(Number(String(v).replace(/\./g, "").replace(",", "."))))) return "número";
  return "texto";
}
function showDocBanner({ chip = true } = {}) {
  const show = !!docData && chip;
  $("doc-chip-name").textContent = docData ? docData.name : "";
  $("doc-chip").classList.toggle("hidden", !show);
  $("attach").classList.toggle("has-file", show);
  const warn = document.querySelector(".db-warn");
  if (warn) warn.classList.toggle("hidden", !!docData);
}
$("doc-clear").onclick = () => { newDash(); };

// ── Passe de validação: garante que cada tile referencia colunas REAIS do documento ──
// Corrige nomes (case-insensitive), ajusta measure/agg quando a coluna não existe/não é numérica,
// veta IDENTIFICADORES como medida de soma (usa o columnRoles do entendimento da IA + heurística),
// e descarta gráficos sem dimensão válida. Determinístico (sem IA) — impede tile quebrado.
const ID_NAME_RX = /^(NR|NUM|NUMERO|COD|CODIGO|CD|ID|SEQ|CPF|CNPJ|CEP|NF|NOTA)[_ ]|[_ ](ID|CODIGO|COD|NR|NUM|NUMERO|SEQ)$|^(ID|CODIGO|NR_NOTA)$/i;
function validateDocTiles(specTiles, columns, columnRoles) {
  const exact   = new Set(columns.map((c) => c.name));
  const byLower = new Map(columns.map((c) => [c.name.toLowerCase().trim(), c.name]));
  const normKey = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");
  const byNorm  = new Map(columns.map((c) => [normKey(c.name), c.name])); // "Família" ↔ "FAMILIA", "Estado do Cliente" ↔ "ESTADO_DO_CLIENTE"
  const typeOf  = new Map(columns.map((c) => [c.name, c.type]));
  // identificador = papel dito pela IA no entendimento OU nome com cara de código/ID
  const roleOf = new Map(Object.entries(columnRoles || {}).map(([k, v]) => [k.toLowerCase().trim(), String(v).toLowerCase()]));
  const isIdentifier = (n) => {
    if (!n) return false;
    const role = roleOf.get(n.toLowerCase().trim());
    if (role && /identificador|c[oó]digo|id\b/.test(role)) return true;
    return ID_NAME_RX.test(n);
  };
  const numeric = columns.filter((c) => c.type === "número" && !isIdentifier(c.name)).map((c) => c.name);
  const resolve = (n) => { if (!n) return null; if (exact.has(n)) return n; return byLower.get(String(n).toLowerCase().trim()) || byNorm.get(normKey(n)) || null; };
  const isNumeric = (n) => n && typeOf.get(n) === "número";
  // medida somável = numérica E não-identificador (somar NR_NOTA/CODIGO produz KPI absurdo)
  const isSummable = (n) => isNumeric(n) && !isIdentifier(n);

  const tiles = [], dropped = [], fixed = [];
  for (const t of specTiles) {
    if (t.kind === "insight") { tiles.push(t); continue; }        // narrativa: não depende de coluna
    const nt = { ...t };
    const agg = (nt.agg || "sum").toLowerCase();

    // filtros: só entram com coluna REAL — filtro quebrado é removido (nunca aplicado errado)
    const cleanFilters = (arr) => {
      if (!Array.isArray(arr) || !arr.length) return undefined;
      const vf = [];
      for (const f of arr) { const col = resolve(f && f.col); if (col) vf.push({ ...f, col }); else fixed.push(nt.title); }
      return vf.length ? vf : undefined;
    };
    nt.filters = cleanFilters(nt.filters);
    nt.shareWhere = cleanFilters(nt.shareWhere);
    nt.format = ["currency", "percent"].includes(nt.format) ? nt.format : undefined;
    nt.bucket = ["month", "year"].includes(String(nt.bucket || "").toLowerCase()) ? String(nt.bucket).toLowerCase() : undefined;
    nt.limit  = Number.isFinite(+nt.limit) && +nt.limit >= 1 ? Math.min(50, Math.round(+nt.limit)) : undefined;
    nt.order  = nt.order === "asc" ? "asc" : undefined;

    if (nt.kind === "table") {
      let cols = (nt.columns || []).map(resolve).filter(Boolean);
      if (cols.length < (nt.columns || []).length) fixed.push(nt.title);
      if (!cols.length) cols = columns.slice(0, 8).map((c) => c.name);
      nt.columns = cols; tiles.push(nt); continue;
    }

    if (nt.kind === "kpi") {
      const m = resolve(nt.measure);
      if (agg === "share") { // participação: precisa do numerador (shareWhere); measure opcional (sem = share de linhas)
        if (nt.shareWhere) { nt.measure = isSummable(m) ? m : null; nt.format = "percent"; }
        else { nt.agg = "count"; nt.measure = null; fixed.push(nt.title); }
      }
      else if (agg === "count") { nt.measure = null; }
      else if (agg === "countdistinct") { nt.measure = m || columns[0]?.name || null; if (!m) fixed.push(nt.title); }
      else { // sum/avg/min/max exigem métrica real (numérica e não-identificador)
        if (isSummable(m)) nt.measure = m;
        else if (numeric.length) { nt.measure = numeric[0]; fixed.push(nt.title); }
        else { nt.agg = "count"; nt.measure = null; fixed.push(nt.title); }
      }
      tiles.push(nt); continue;
    }

    // chart: exige dimensão real; sem ela, descarta
    const dimOk = resolve(nt.dim);
    if (!dimOk) { dropped.push(nt.title || "(sem título)"); continue; }
    if (dimOk !== nt.dim) fixed.push(nt.title);
    nt.dim = dimOk;
    // dim2 (séries empilhadas): opcional — só se resolver, for diferente do dim e a agregação empilhar
    const d2 = resolve(nt.dim2);
    nt.dim2 = (d2 && d2 !== nt.dim && (agg === "sum" || agg === "count")) ? d2 : undefined;
    const m = resolve(nt.measure);
    if (agg === "count") { nt.measure = null; }
    else if (agg === "countdistinct") { nt.measure = m || nt.dim; }
    else if (agg === "share") { nt.measure = isSummable(m) ? m : null; } // share sem measure = % das linhas
    else { if (isSummable(m)) nt.measure = m; else if (numeric.length) { nt.measure = numeric[0]; fixed.push(nt.title); } else { nt.agg = "count"; nt.measure = null; fixed.push(nt.title); } }
    tiles.push(nt);
  }
  return { tiles, dropped, fixed: [...new Set(fixed)] };
}

// materializa 1 tile do spec da IA (calcula os dados em memória, exceto insight que é texto)
function docTileFromSpec(t, i) {
  const wDefault = t.kind === "kpi" ? 3 : (t.kind === "table" ? 12 : 6);
  const tile = { id: "doc" + i + Date.now().toString(36) + Math.floor(Math.random() * 1e3).toString(36),
    kind: t.kind, title: t.title, chartType: t.chartType, w: t.w || wDefault,
    dim: t.dim, dim2: t.dim2, measure: t.measure, agg: t.agg, filters: t.filters, shareWhere: t.shareWhere,
    bucket: t.bucket, limit: t.limit, order: t.order, format: t.format,
    columns: t.columns, narrative: t.narrative, highlight: t.highlight, _doc: true };
  if (t.kind !== "insight") Object.assign(tile, aggregateDoc(docData.rows, tile));
  return tile;
}
function reportValidation({ dropped, fixed }) {
  if (dropped.length) toast(`${dropped.length} painel(éis) descartado(s) — coluna inexistente: ${dropped.slice(0, 3).join(", ")}`, true);
  else if (fixed.length) toast(`${fixed.length} painel(éis) ajustado(s) automaticamente às colunas reais`);
}
// ── Jornada imersiva da criação: a linha viaja pela tela, para em cada check e a legenda narra ──
const JY_STEPS = [
  ["Dados prontos", "planilha lida e estatísticas calculadas"],
  ["Entendendo os dados", "o orquestrador descobre o que os dados são e planeja a equipe"],
  ["Agentes em ação", "cada agente analisa a sua fatia das colunas, em paralelo"],
  ["Revisão do orquestrador", "remove duplicidade, valida e garante o pedido coberto"],
  ["Acendendo os insights", "cada painel ganha a sua leitura analítica"],
];
const JY_LABELS = ["Dados", "Entender", "Agentes", "Revisar", "Insights"];
// gráfico de barras 3D que nasce durante a jornada — uma barra sobe a cada etapa concluída
const JY_BAR = {
  COLORS: ["#f97316", "#8b5cf6", "#38bdf8", "#34d399", "#fbbf24"], // mesma paleta dos gráficos reais
  H: [128, 176, 148, 208, 238], W: 74, DX: 18, DY: -10, BASE: 300, // alturas + profundidade isométrica
  XS: [300, 450, 600, 750, 900],                                    // centro de cada barra no mundo
};
const jyShade = (hex, k) => { // k>0 clareia (face do topo), k<0 escurece (face lateral)
  const n = parseInt(hex.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
  const m = (c) => Math.round(k > 0 ? c + (255 - c) * k : c * (1 + k));
  return `rgb(${m(r)},${m(g)},${m(b)})`;
};
let jy = null;
function journeyInit(title, sub) {
  $("jy-title").textContent = title || "Montando seu relatório";
  $("jy-sub").textContent = sub || "";
  $("jy-step").textContent = ""; $("jy-caption").textContent = ""; $("jy-count").textContent = "";
  const { COLORS, H, W, DX, DY, BASE, XS } = JY_BAR;
  const svgEl = $("jy-svg");
  if (!document.getElementById("jb-sheen")) svgEl.querySelector("defs").insertAdjacentHTML("beforeend",
    `<linearGradient id="jb-sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".30"/><stop offset=".7" stop-color="#fff" stop-opacity=".04"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`
    + COLORS.map((c, i) => `<linearGradient id="jbr${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity=".20"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient>`).join(""));

  // ── o palco é o GRÁFICO: 5 barras isométricas (3 faces sombreadas + sheen + aresta + reflexo),
  // com rótulo embaixo, fantasma pulsante enquanto a etapa trabalha e check estourando no topo.
  const barsG = $("jy-bars3d");
  barsG.setAttribute("opacity", ".95");
  barsG.innerHTML = XS.map((cx, i) => {
    const c = COLORS[i], x = cx - W / 2, yF = BASE - H[i];
    return `<g class="jy-bar3d">
      <rect class="jb-refl" x="${x}" y="${BASE + 4}" width="${W}" height="0" fill="url(#jbr${i})"/>
      <rect class="jb-ghost" x="${x}" y="${yF}" width="${W}" height="${H[i]}" rx="3" stroke="${c}"/>
      <polygon class="jb-side" fill="${jyShade(c, -0.38)}"/>
      <polygon class="jb-top"  fill="${jyShade(c, 0.34)}"/>
      <rect class="jb-front" x="${x}" y="${BASE}" width="${W}" height="0" fill="${c}"/>
      <rect class="jb-sheen" x="${x}" y="${BASE}" width="${W}" height="0" fill="url(#jb-sheen)"/>
      <line class="jb-edge" x1="${x}" x2="${x + W}" y1="${BASE}" y2="${BASE}" stroke="${jyShade(c, 0.55)}" stroke-width="1.6"/>
      <g class="jb-done" transform="translate(${cx + DX / 2},${yF - 26})"><g class="jb-done-in">
        <circle r="13" fill="${c}"/><path d="M-5 .5 -1.5 4 6 -4" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      </g></g>
      <text class="jb-label" x="${cx + DX / 2}" y="${BASE + 34}">${JY_LABELS[i]}</text>
    </g>`;
  }).join("");
  const bars = [...barsG.querySelectorAll(".jy-bar3d")].map((el, i) => ({
    el, h: 0, v: 0, target: 0, x: XS[i] - W / 2, cx: XS[i] + DX / 2,
    refl: el.querySelector(".jb-refl"), side: el.querySelector(".jb-side"), top: el.querySelector(".jb-top"),
    front: el.querySelector(".jb-front"), sheen: el.querySelector(".jb-sheen"), edge: el.querySelector(".jb-edge"),
  }));
  if (jy) cancelAnimationFrame(jy.raf);
  jy = { bars, stage: -1, raf: 0 };
  const loop = () => {
    if (!jy) return;
    // barras: física de MOLA — sobem com overshoot e assentam quando a etapa conclui (gráfico nascendo)
    for (const b of jy.bars) {
      if (b.h === b.target && b.v === 0) continue;
      b.v += (b.target - b.h) * 0.085; b.v *= 0.80;
      b.h += b.v;
      if (Math.abs(b.v) < 0.02 && Math.abs(b.target - b.h) < 0.4) { b.h = b.target; b.v = 0; }
      const h = Math.max(0, b.h), yT = JY_BAR.BASE - h, x = b.x, w = JY_BAR.W, dx = JY_BAR.DX, dy = JY_BAR.DY;
      b.front.setAttribute("y", yT); b.front.setAttribute("height", h);
      b.sheen.setAttribute("y", yT); b.sheen.setAttribute("height", h);
      b.top.setAttribute("points", `${x},${yT} ${x + dx},${yT + dy} ${x + w + dx},${yT + dy} ${x + w},${yT}`);
      b.side.setAttribute("points", `${x + w},${yT} ${x + w + dx},${yT + dy} ${x + w + dx},${JY_BAR.BASE + dy} ${x + w},${JY_BAR.BASE}`);
      b.edge.setAttribute("y1", yT); b.edge.setAttribute("y2", yT);
      b.refl.setAttribute("height", Math.min(34, h * 0.20));
    }
    jy.raf = requestAnimationFrame(loop);
  };
  jy.raf = requestAnimationFrame(loop);
  journeyStage(0);
  setTimeout(() => jy && jy.stage === 0 && journeyStage(1), 800); // dados já vêm prontos — parte pro entendimento
}
function journeyDestroy() { if (jy) { cancelAnimationFrame(jy.raf); jy = null; } }
function journeySwapCaption(text) {
  const el = $("jy-caption");
  if (!text || el.textContent === text) return;
  el.classList.remove("swap"); void el.offsetWidth;
  el.textContent = text; el.classList.add("swap");
}
function journeyStage(k, detail) {
  if (!jy) return;
  if (k <= jy.stage) { journeySwapCaption(detail); return; } // mesmo estágio: só atualiza a narração
  for (let i = 0; i < k; i++) { // etapas vencidas: barra sobe (mola) + check estoura no topo
    const b = jy.bars[i]; if (!b) continue;
    b.target = JY_BAR.H[i];
    b.el.classList.remove("charging"); b.el.classList.add("done");
  }
  jy.bars.forEach((b, i) => b.el.classList.toggle("charging", i === k)); // a ativa pulsa o fantasma
  jy.stage = k;
  $("jy-count").textContent = `ETAPA ${String(k + 1).padStart(2, "0")} · ${String(JY_STEPS.length).padStart(2, "0")}`;
  const st = $("jy-step"); // título entra como letreiro de cinema (tracking + blur)
  st.classList.remove("swap"); void st.offsetWidth;
  st.textContent = JY_STEPS[k][0]; st.classList.add("swap");
  journeySwapCaption(detail || JY_STEPS[k][1]);
}
function journeyFinish() { // gráfico completo: última barra sobe e o overlay dá lugar ao dashboard
  if (!jy) return;
  jy.bars.forEach((b, i) => { b.target = JY_BAR.H[i]; b.el.classList.remove("charging"); b.el.classList.add("done"); });
  $("jy-count").textContent = "APRESENTANDO";
  const st = $("jy-step"); st.classList.remove("swap"); void st.offsetWidth;
  st.textContent = "Seu relatório está pronto"; st.classList.add("swap");
  journeySwapCaption("revelando o dashboard…");
}
// compat: os eventos SSE continuam chamando renderBuildSteps(0..3) — mapeia para os nós 1..4
function renderBuildSteps(stage, subOverride) { journeyStage(stage + 1, subOverride); }
// traduz o progresso SSE da orquestração em etapa + subtexto do overlay
function orchProgress(p) {
  if (!p || !p.stage) return;
  if (p.stage === "orchestrate") renderBuildSteps(0);
  else if (p.stage === "plan") { renderBuildSteps(1, `${(p.agents || []).length} agente(s): ${(p.agents || []).join(" · ")}`); overlaySub(p.title || ""); }
  else if (p.stage === "agent") renderBuildSteps(1, `agente ${p.i + 1}/${p.n} analisando: ${p.focus || ""}`);
  else if (p.stage === "agent-done") renderBuildSteps(1, `✓ ${p.focus || `agente ${p.i + 1}`} — ${p.tiles} painel(éis)`);
  else if (p.stage === "agent-fail") renderBuildSteps(1, `✕ ${p.focus || `agente ${p.i + 1}`} falhou (a equipe segue)`);
  else if (p.stage === "validate") renderBuildSteps(2, `${p.candidates} painéis candidatos em revisão`);
  else if (p.stage === "validated") renderBuildSteps(2, `${p.kept} aprovados${p.removed ? ` · ${p.removed} removido(s) pela revisão` : ""}`);
  else if (p.stage === "fallback") renderBuildSteps(1, "orquestração indisponível — montando em chamada única");
}

// ── Balanceador de layout: garante linhas SEMPRE completas na grade de 12 colunas ──
// Quando um tile largo (w12) viria depois de uma linha meio-cheia, busca à frente um tile
// que caiba no buraco e o antecipa; se não houver, ALARGA o último tile da linha para fechar.
function layoutBalance(tiles) {
  const W = (t) => (t.w === 3 || t.w === 4 || t.w === 6 || t.w === 12) ? t.w : (t.kind === "kpi" ? 3 : t.kind === "table" ? 12 : 6);
  let rem = 12;
  for (let i = 0; i < tiles.length; i++) {
    const w = W(tiles[i]);
    if (w <= rem) { rem -= w; if (rem === 0) rem = 12; continue; }
    // não cabe: tenta puxar um tile futuro que preencha exatamente o buraco
    const j = tiles.findIndex((t, k) => k > i && W(t) === rem);
    if (j !== -1) { const [moved] = tiles.splice(j, 1); tiles.splice(i, 0, moved); rem = 12; continue; }
    // sem candidato: alarga o tile anterior para fechar a linha (nunca fica buraco)
    if (i > 0) tiles[i - 1].w = W(tiles[i - 1]) + rem;
    rem = 12 - w; if (rem === 0) rem = 12;
  }
  return tiles;
}

// consome o stream SSE do build orquestrado: progresso → overlay; devolve o "done" (com fallback p/ JSON puro)
async function postBuildDoc(body) {
  const res = await fetch("/dashboard/build-doc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const ct = res.headers.get("Content-Type") || "";
  if (!ct.includes("text/event-stream")) return res.json(); // 429/erro do gate ou versão antiga
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "", done = null;
  for (;;) {
    const { value, done: end } = await reader.read(); if (end) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n"); buf = parts.pop();
    for (const part of parts) {
      const ev = parseSse(part); if (!ev) continue;
      if (ev.event === "progress") orchProgress(ev.data);
      else if (ev.event === "done") done = ev.data;
    }
  }
  return done || { ok: false, error: "conexão encerrada sem resposta" };
}

async function buildFromDoc(nl) {
  if (building || !docData) return;
  lastNl = nl; setBuilding(true);
  showOverlay("Analisando seus dados", `${docData.name} · ${docData.rows.length.toLocaleString("pt-BR")} linhas`, true);
  try {
    const stats = docData.stats || docStatsText(docData.columns, docData.rows); // já vêm do worker; fallback p/ docs restaurados
    const r = await postBuildDoc({ columns: docData.columns, sample: docData.rows.slice(0, 15), stats, nl, context: aiContext() });
    if (!r.ok) return fail(r.error);
    const val = validateDocTiles(r.tiles || [], docData.columns, r.understanding?.columnRoles); // validação + papéis do entendimento
    const tiles = layoutBalance(val.tiles.map(docTileFromSpec));                                 // linhas sempre completas
    dash = { title: r.title || docData.name, tiles, schemaTables: [], source: "doc", understanding: r.understanding, plan: r.plan };
    renderAll(); // materializa atrás do overlay (insights ainda rodando)
    reportValidation(val);
    const un = r.understanding?.request?.unmapped;
    if (Array.isArray(un) && un.length) toast(`O arquivo não tem: ${un.join(", ")} — o dashboard foi adaptado ao que existe`, true);
    showDocBanner({ chip: false }); // dados já embutidos nos tiles — chip some
    // Etapa final: os insights fazem PARTE da geração — o dashboard só aparece com as lâmpadas prontas
    renderBuildSteps(3);
    await Promise.race([generateAllInsights(r.understanding), sleep(90000)]); // teto de 90s — não trava o reveal
    journeyFinish();     // última barra sobe + check…
    await sleep(700);    // …tempo da mola assentar antes da transição
    _staggerNext = true;
    renderAll(); // reveal com cascata e tudo pronto
  } catch (e) { fail(e.message); } finally { setBuilding(false); hideOverlay(); }
}

// Gera o insight de TODOS os painéis de uma vez, com os dados já agregados — vêm prontos p/ a lâmpada.
async function generateAllInsights(understanding) {
  if (!dash || !dash.tiles) return;
  const targets = dash.tiles.filter((t) => t.kind !== "insight" && !t.insight && t.rows && t.rows.length);
  if (!targets.length) return;
  targets.forEach((t) => { t._insightPending = true; });
  renderAll();
  const panels = targets.map((t) => ({ id: t.id, title: t.title, dim: t.dim, dim2: t.dim2, measure: t.measure, agg: t.agg, filters: t.filters, rows: (t.rows || []).slice(0, 30) }));
  try {
    const r = await post("/dashboard/insights-batch", { understanding, nl: lastNl, panels, context: aiContext() });
    const ins = (r && r.ok && r.insights) || {};
    for (const t of dash.tiles) { if (ins[t.id]) t.insight = ins[t.id]; t._insightPending = false; }
  } catch { for (const t of dash.tiles) t._insightPending = false; }
  renderAll();
  saveWorking();
}
// edição conversacional: já existe dashboard -> aplica o pedido sem refazer tudo
async function editDash(nl) {
  if (building || !nl.trim()) return;
  lastNl = nl; setBuilding(true);
  showOverlay("Ajustando o dashboard", nl.length > 60 ? nl.slice(0, 57) + "…" : nl);
  try {
    if (dash.source === "doc" || docData) {
      if (!docData) { fail("Reanexe o documento (clipe) para editar este dashboard."); return; }
      const understanding = dash.understanding;
      const r = await post("/dashboard/edit-doc", { currentTiles: dash.tiles.map((t) => ({ title: t.title, kind: t.kind, chartType: t.chartType, dim: t.dim, dim2: t.dim2, measure: t.measure, agg: t.agg, filters: t.filters, shareWhere: t.shareWhere, bucket: t.bucket, limit: t.limit, order: t.order, format: t.format, narrative: t.narrative })), columns: docData.columns, sample: docData.rows.slice(0, 12), nl, context: aiContext() });
      if (!r.ok) return fail(r.error);
      const val = validateDocTiles(r.tiles || [], docData.columns, understanding?.columnRoles);
      const tiles = layoutBalance(val.tiles.map(docTileFromSpec));
      dash = { title: r.title || dash.title, tiles, schemaTables: [], source: "doc", reasoning: dash.reasoning, understanding };
      renderAll(); // atrás do overlay
      reportValidation(val);
      showDocBanner({ chip: false });
      overlaySub("gerando os insights dos painéis…");
      await Promise.race([generateAllInsights(understanding), sleep(90000)]);
      _staggerNext = true;
      renderAll();
    } else {
      const r = await post("/dashboard/edit", { currentTiles: dash.tiles.map((t) => ({ title: t.title, kind: t.kind, chartType: t.chartType, sql: t.sql })), nl });
      if (!r.ok) return fail(r.error);
      const bySql = new Map(dash.tiles.map((t) => [(t.sql || "").trim(), t]));
      dash = { title: r.title || dash.title, schemaTables: dash.schemaTables, source: "bank", reasoning: dash.reasoning, tiles: (r.tiles || []).map((t, i) => {
        const id = "t" + i + Date.now().toString(36);
        if (t.reuse) { const cur = bySql.get((t.sql || "").trim()); return { ...t, id, columns: cur?.columns, rows: cur?.rows, rowCount: cur?.rowCount, error: cur?.error }; }
        return { ...t, id };
      }) };
      renderAll();
    }
  } catch (e) { fail(e.message); } finally { setBuilding(false); hideOverlay(); }
}
// data em qualquer forma comum (ISO ou dd/mm/aaaa) → ISO "AAAA-MM-DD"; null se não for data
function docIsoDate(v) {
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d\d)-(\d\d)/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return `${m[3]}-${String(m[2]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
  return null;
}

// ── Filtros de linha (o "recorte" pedido pelo usuário: período, categoria, etc.) ──
// Comparação esperta: data (ISO ou dd/mm/aaaa) > número (pt-BR) > texto sem acento/caixa.
function applyDocFilters(rows, filters) {
  if (!filters || !filters.length) return rows;
  const norm = (v) => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const isoDate = docIsoDate;
  const cmp = (raw, val) => {
    const da = isoDate(raw), db = isoDate(val);
    if (da && db) return da < db ? -1 : da > db ? 1 : 0;
    const na = toNumberBR(raw), nb = toNumberBR(val);
    if (na !== null && nb !== null) return na - nb;
    const sa = String(raw ?? ""), sb = String(val ?? "");
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  };
  const eq = (raw, val) => norm(raw) === norm(val) || (toNumberBR(raw) !== null && toNumberBR(val) !== null && toNumberBR(raw) === toNumberBR(val));
  return rows.filter((r) => filters.every((f) => {
    const raw = r[f.col], op = String(f.op || "=").toLowerCase();
    if (op === "in")       return (Array.isArray(f.value) ? f.value : [f.value]).some((v) => eq(raw, v));
    if (op === "contains") return norm(raw).includes(norm(f.value));
    if (op === "=")        return eq(raw, f.value);
    if (op === "!=")       return !eq(raw, f.value);
    if (op === ">=")       return cmp(raw, f.value) >= 0;
    if (op === "<=")       return cmp(raw, f.value) <= 0;
    if (op === ">")        return cmp(raw, f.value) > 0;
    if (op === "<")        return cmp(raw, f.value) < 0;
    if (op === "between")  return cmp(raw, f.value) >= 0 && (f.value2 == null || cmp(raw, f.value2) <= 0);
    return true;
  }));
}

// agregação em memória sobre as linhas do documento (sem SQL)
function aggregateDoc(rows, t) {
  rows = applyDocFilters(rows, t.filters); // recorte do pedido ANTES de qualquer conta
  const num = (v) => { const n = toNumberBR(v); return n === null ? 0 : n; }; // pt-BR-aware
  const a = (t.agg || "sum").toLowerCase();
  const baseOf = (rs) => (t.measure ? rs.reduce((s, r) => s + num(r[t.measure]), 0) : rs.length); // valor-base do share
  // dim de data com bucket → agrupa por mês/ano (evolução temporal legível, não 1 barra por dia)
  const bucketOf = (v) => {
    const k = v ?? "(vazio)";
    if (!t.bucket) return k;
    const iso = docIsoDate(v);
    return iso ? (t.bucket === "year" ? iso.slice(0, 4) : iso.slice(0, 7)) : k;
  };
  const numAgg = (vals) => {
    const n = vals.map(num);
    if (!n.length) return 0;
    if (a === "avg") return n.reduce((x, y) => x + y, 0) / n.length;
    if (a === "min") return n.reduce((x, y) => (x < y ? x : y), n[0]); // reduce: spread estoura a pilha em grupos grandes
    if (a === "max") return n.reduce((x, y) => (x > y ? x : y), n[0]);
    return n.reduce((x, y) => x + y, 0);
  };
  const aggOf = (rs) => a === "count" ? rs.length
    : a === "countdistinct" || a === "distinct" ? new Set(rs.map((r) => r[t.measure])).size
    : numAgg(rs.map((r) => r[t.measure]));
  const srcRows = rows.length; // nº de linhas que ENTRARAM na conta (após o recorte) — transparência
  if (t.kind === "table") {
    const cols = (t.columns && t.columns.length ? t.columns : Object.keys(rows[0] || {})).slice(0, 8);
    return { columns: cols, rows: rows.slice(0, 500), rowCount: rows.length, srcRows };
  }
  const meaL = `${a}_${t.measure || "linhas"}`;
  if (t.kind === "kpi" || !t.dim) {
    if (a === "share") { // participação: fração 0-1 do total que atende ao shareWhere (fmtKpi percent exibe %)
      const den = baseOf(rows) || 1;
      return { columns: [meaL], rows: [{ [meaL]: baseOf(applyDocFilters(rows, t.shareWhere)) / den }], rowCount: 1, srcRows };
    }
    return { columns: [meaL], rows: [{ [meaL]: aggOf(rows) }], rowCount: 1, srcRows };
  }

  // duas dimensões (dim × dim2): pivô — dim no eixo, top-6 valores de dim2 viram séries empilhadas
  if (t.dim2 && t.chartType !== "pie" && t.chartType !== "map") {
    const val = (r) => (a === "count" ? 1 : num(r[t.measure]));
    const totals = new Map();
    for (const r of rows) { const k = String(r[t.dim2] ?? "(vazio)"); totals.set(k, (totals.get(k) || 0) + val(r)); }
    const top = [...totals.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k]) => k);
    const isTop = new Set(top);
    const groups2 = new Map(); let hasOthers = false;
    for (const r of rows) {
      const k = bucketOf(r[t.dim]);
      if (!groups2.has(k)) groups2.set(k, {});
      const s0 = String(r[t.dim2] ?? "(vazio)");
      const s = isTop.has(s0) ? s0 : (hasOthers = true, "Outros");
      const g = groups2.get(k); g[s] = (g[s] || 0) + val(r);
    }
    const series = (hasOthers ? [...top, "Outros"] : top);
    const safe = (s) => (s === t.dim ? s + " (série)" : s); // série não pode colidir com a coluna do eixo
    let out2 = [...groups2.entries()].map(([k, g]) => ({ [t.dim]: k, ...Object.fromEntries(series.map((s) => [safe(s), g[s] || 0])) }));
    const ys = series.map(safe);
    const tot = (r) => ys.reduce((s, c) => s + (r[c] || 0), 0);
    if (t.chartType === "line") out2.sort((x, y) => (String(x[t.dim]) < String(y[t.dim]) ? -1 : 1));
    else out2.sort((x, y) => tot(y) - tot(x));
    if (t.limit) out2 = out2.slice(0, Math.max(1, t.limit | 0));
    return { columns: [t.dim, ...ys], rows: out2, rowCount: out2.length, xField: t.dim, yFields: ys, stacked: true, srcRows };
  }

  const groups = new Map();
  for (const r of rows) { const k = bucketOf(r[t.dim]); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  let out;
  if (a === "share") { // participação: cada categoria vira % do total (pontos percentuais, soma 100)
    const totals = [...groups.entries()].map(([k, rs]) => [k, baseOf(rs)]);
    const total = totals.reduce((s, [, v]) => s + v, 0) || 1;
    out = totals.map(([k, v]) => ({ [t.dim]: k, [meaL]: Math.round((v / total) * 10000) / 100 }));
  } else {
    out = [...groups.entries()].map(([k, rs]) => ({ [t.dim]: k, [meaL]: aggOf(rs) }));
  }
  if (t.chartType === "line") out.sort((x, y) => (String(x[t.dim]) < String(y[t.dim]) ? -1 : 1)); // tempo: cronológico
  else out.sort((x, y) => num(y[meaL]) - num(x[meaL]));
  if (t.order === "asc" && t.chartType !== "line") out.reverse(); // "piores/menores" primeiro
  if (t.limit) out = out.slice(0, Math.max(1, t.limit | 0));
  return { columns: [t.dim, meaL], rows: out, rowCount: out.length, xField: t.dim, yFields: [meaL], stacked: false, percent: a === "share", srcRows };
}

// Resumo estatístico do dataset COMPLETO (por coluna) — alimenta os insights da IA com números reais.
function docStatsText(columns, rows) {
  const total = rows.length;
  return (columns || []).map((c) => {
    const name = c.name, type = c.type;
    const vals = rows.map((r) => r[name]).filter((v) => v != null && v !== "");
    if (type === "número") {
      const nums = vals.map(toNumberBR).filter((n) => n !== null); // pt-BR-aware — Number() cru descartava "1.234.567"
      if (!nums.length) return `  ${name} [número]: sem valores`;
      const sum = nums.reduce((a, b) => a + b, 0);
      const min = nums.reduce((a, b) => a < b ? a : b, nums[0]);
      const max = nums.reduce((a, b) => a > b ? a : b, nums[0]);
      return `  ${name} [número]: soma=${sum.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}, média=${(sum / nums.length).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}, min=${min}, max=${max}`;
    }
    if (type === "data") {
      const s = vals.map(String).sort();
      return `  ${name} [data]: de ${s[0]} até ${s[s.length - 1]}`;
    }
    const freq = {};
    for (const v of vals) freq[String(v)] = (freq[String(v)] || 0) + 1;
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 6);
    return `  ${name} [texto]: ${Object.keys(freq).length} distintos. Top: ${top.map(([v, n]) => `${v}(${n}, ${Math.round(n / total * 100)}%)`).join(", ")}`;
  }).join("\n");
}
