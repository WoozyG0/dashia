// Worker de parse: lê CSV/XLSX FORA da thread da interface (zero travada).
// Recebe { name, buf(ArrayBuffer) } e devolve { ok, columns, rows } com progresso no meio.
// As funções são cópias worker-side das do dashboard.js (sem DOM) — manter em sincronia.
importScripts("/vendor/xlsx.full.min.js");

const post = (m) => self.postMessage(m);

// UTF-8 (com/sem BOM) com fallback Windows-1252 — exports de ERP brasileiro vêm em Latin-1
function decodeCsvBytes(bytes) {
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("windows-1252").decode(bytes); }
}

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
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
  else if (lastComma !== -1 && lastDot > lastComma) s = s.replace(/,/g, "");
  else if (lastComma !== -1) s = s.replace(",", ".");
  else if (lastDot !== -1 && /^[-+]?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ""); // 1.234.567 = milhar pt-BR sem vírgula
  const n = Number(s);
  return isNaN(n) ? null : (neg ? -n : n);
}

function inferColType(rows, col) {
  const vals = rows.slice(0, 60).map((r) => r[col]).filter((v) => v != null && v !== "");
  if (!vals.length) return "texto";
  if (vals.some((v) => /^\d{4}-\d\d-\d\d/.test(String(v)))) return "data";
  if (vals.every((v) => !isNaN(Number(String(v).replace(/\./g, "").replace(",", "."))))) return "número";
  return "texto";
}

// Detecção da linha de cabeçalho real + datas serial→ISO + normalização numérica pt-BR
function sheetToObjects(ws) {
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, blankrows: false });
  if (!aoa.length) return { columns: [], rows: [] };
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
  const numCols = columns.filter((c) => c.type === "número").map((c) => c.name);
  if (numCols.length) for (const r of rows) for (const k of numCols) {
    const v = r[k];
    if (typeof v === "string" && v.trim() !== "") { const n = toNumberBR(v); if (n !== null) r[k] = n; }
  }
  return { columns, rows };
}

// Estatísticas por coluna (para o entendimento + insights da IA), com LIMITES para não explodir:
// números/datas = varredura completa (barata); texto = amostra de até 150k linhas e mapa de
// frequência limitado a 8k valores distintos (suficiente para o "top").
function computeStatsText(columns, rows) {
  const total = rows.length;
  const TXT_SAMPLE = Math.min(total, 150000), MAP_CAP = 8000;
  return columns.map((c) => {
    const name = c.name, type = c.type;
    if (type === "número") {
      let sum = 0, min = Infinity, max = -Infinity, n = 0;
      for (const r of rows) { const v = r[name]; if (typeof v === "number" && !isNaN(v)) { sum += v; if (v < min) min = v; if (v > max) max = v; n++; } }
      if (!n) return `  ${name} [número]: sem valores`;
      return `  ${name} [número]: soma=${sum.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}, média=${(sum / n).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}, min=${min}, max=${max}`;
    }
    if (type === "data") {
      let min = null, max = null;
      for (const r of rows) { const v = r[name]; if (v == null || v === "") continue; const s = String(v); if (min === null || s < min) min = s; if (max === null || s > max) max = s; }
      return min === null ? `  ${name} [data]: sem valores` : `  ${name} [data]: de ${min} até ${max}`;
    }
    const freq = new Map(); let seen = 0, capped = false;
    for (let i = 0; i < TXT_SAMPLE; i++) {
      const v = rows[i]?.[name]; if (v == null || v === "") continue; seen++;
      const k = String(v);
      if (freq.has(k)) freq.set(k, freq.get(k) + 1);
      else if (freq.size < MAP_CAP) freq.set(k, 1);
      else capped = true;
    }
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const distinct = capped ? `${MAP_CAP}+` : String(freq.size);
    const sampleNote = TXT_SAMPLE < total ? ` (amostra de ${TXT_SAMPLE.toLocaleString("pt-BR")})` : "";
    return `  ${name} [texto]: ${distinct} distintos${sampleNote}. Top: ${top.map(([v, n]) => `${v}(${n}, ${Math.round(n / (seen || 1) * 100)}%)`).join(", ")}`;
  }).join("\n");
}

// ── Workbook COMPLETO: lê TODAS as abas ──
// Abas com o mesmo esquema (nomes casados sem acento/caixa, similaridade >= 0.7) são EMPILHADAS
// com uma coluna ABA (caso clássico: uma aba por mês/filial). Abas pequenas de outro esquema
// (legenda, de-para, parâmetros) viram CONTEXTO textual para a IA. O resto é reportado.
const normColKey = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");
function parseWorkbook(wb) {
  const sheets = [];
  for (const name of wb.SheetNames) {
    const { columns, rows } = sheetToObjects(wb.Sheets[name]);
    if (rows.length) sheets.push({ name, columns, rows });
  }
  if (!sheets.length) return { columns: [], rows: [], sheetsInfo: null };
  if (sheets.length === 1) return { ...sheets[0], sheetsInfo: { used: [sheets[0].name], stacked: false, context: null, ignored: [] } };

  const sig = (s) => new Set(s.columns.map((c) => normColKey(c.name)));
  const clusters = [];
  for (const s of sheets) {
    const ss = sig(s);
    let best = null, bestJ = 0;
    for (const c of clusters) {
      const inter = [...ss].filter((x) => c.sig.has(x)).length;
      const j = inter / (new Set([...ss, ...c.sig]).size || 1);
      if (j > bestJ) { bestJ = j; best = c; }
    }
    if (best && bestJ >= 0.7) { best.sheets.push(s); ss.forEach((x) => best.sig.add(x)); }
    else clusters.push({ sig: new Set(ss), sheets: [s] });
  }
  clusters.sort((a, b) => b.sheets.reduce((n, s) => n + s.rows.length, 0) - a.sheets.reduce((n, s) => n + s.rows.length, 0));
  const main = clusters[0], multi = main.sheets.length > 1;

  // empilha o cluster principal com nomes canônicos (os da 1ª aba)
  const canon = main.sheets[0].columns.map((c) => c.name);
  const canonBy = new Map(canon.map((n) => [normColKey(n), n]));
  const extra = [];
  for (const s of main.sheets.slice(1)) for (const c of s.columns)
    if (!canonBy.has(normColKey(c.name))) { canonBy.set(normColKey(c.name), c.name); extra.push(c.name); }
  const rows = [];
  for (const s of main.sheets) {
    const map = s.columns.map((c) => [c.name, canonBy.get(normColKey(c.name)) || c.name]);
    for (const r of s.rows) {
      const o = multi ? { ABA: s.name } : {};
      for (const [from, to] of map) o[to] = r[from];
      rows.push(o);
    }
  }
  const names = [...(multi ? ["ABA"] : []), ...canon, ...extra];
  const columns = names.map((n) => ({ name: n, type: n === "ABA" ? "texto" : inferColType(rows, n) }));

  // abas fora do cluster principal: pequenas = contexto (legenda/de-para); grandes = reportadas
  const others = clusters.slice(1).flatMap((c) => c.sheets);
  let context = ""; const ignored = [];
  for (const s of others) {
    if (s.rows.length <= 80 && s.columns.length <= 15) {
      const lines = s.rows.slice(0, 40).map((r) => s.columns.map((c) => `${c.name}=${r[c.name] ?? ""}`).join(" · "));
      context += `ABA AUXILIAR "${s.name}" (${s.rows.length} linhas — use como legenda/referência):\n${lines.join("\n")}\n\n`;
    } else ignored.push(`${s.name} (${s.rows.length.toLocaleString("pt-BR")} linhas, estrutura diferente)`);
  }
  return { columns, rows, sheetsInfo: { used: main.sheets.map((s) => s.name), stacked: multi, context: context.trim() || null, ignored } };
}

self.onmessage = (ev) => {
  const { name, buf } = ev.data;
  try {
    post({ progress: "abrindo o arquivo…" });
    const wb = /\.csv$/i.test(name)
      ? XLSX.read(decodeCsvBytes(new Uint8Array(buf)), { type: "string" })
      : XLSX.read(buf, { type: "array", cellDates: true });
    post({ progress: wb.SheetNames.length > 1 ? `estruturando ${wb.SheetNames.length} abas…` : "estruturando as linhas…" });
    const { columns, rows, sheetsInfo } = parseWorkbook(wb);
    post({ progress: "analisando as colunas…" });
    const stats = computeStatsText(columns, rows); // fora da UI — o build não trava mais aqui
    post({ progress: "quase lá — preparando a análise…" });
    post({ ok: true, columns, rows, stats, sheetsInfo });
  } catch (e) {
    post({ ok: false, error: String((e && e.message) || e) });
  }
};
