// Dash.IA — servidor standalone (dashboards a partir de documentos, IA keyless via Agent SDK)
import http from "node:http";
import fs   from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Carrega .env (sem dependência): o testador põe a ANTHROPIC_API_KEY dele lá.
// Variáveis já definidas no ambiente têm prioridade; valores vazios são ignorados.
try {
  const envRaw = await fs.readFile(path.join(here, ".env"), "utf8");
  for (const line of envRaw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && m[2] !== "" && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const PORT  = Number(process.env.PORT || 4000);
const DATA  = path.resolve(path.join(here, "data"));
await fs.mkdir(DATA, { recursive: true });

// Erros não capturados não devem derrubar o servidor
process.on("uncaughtException",  (e) => process.stderr.write(`[uncaughtException] ${e?.stack ?? e}\n`));
process.on("unhandledRejection", (r) => process.stderr.write(`[unhandledRejection] ${r?.stack ?? r}\n`));

const { buildDocDashboard, buildDocDashboardOrchestrated, editDocDashboard, insightForTile, insightsBatch, extractPdfData } = await import("./doc-gen.mjs");

// ── Helpers ───────────────────────────────────────────────────────────────────
const MIME = { ".html": "text/html;charset=utf-8", ".js": "text/javascript;charset=utf-8", ".css": "text/css;charset=utf-8", ".json": "application/json", ".geojson": "application/json", ".svg": "image/svg+xml" };
const mime = (f) => MIME[path.extname(f).toLowerCase()] ?? "text/plain";

async function serveFile(res, abs) {
  try {
    const data = await fs.readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    // html/js/css sempre frescos (max-age aqui já entregou tela velha p/ usuário); vendor pesado pode cachear
    const cc = abs.includes("vendor") ? "public,max-age=86400"
      : (ext === ".js" || ext === ".css" || ext === ".html") ? "no-store" : "public,max-age=3600";
    res.writeHead(200, { "Content-Type": mime(abs), "Cache-Control": cc });
    res.end(data);
  } catch { res.writeHead(404); res.end("Not found"); }
}

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 60 * 1024 * 1024) throw new Error("Payload muito grande (máx 60 MB)");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function safeName(s) {
  return String(s || "dashboard").replace(/[^a-zA-Z0-9_\-À-ɏ]/g, "_").slice(0, 60);
}

// ── Servidor ──────────────────────────────────────────────────────────────────
// Trava de concorrência das rotas de IA: cada chamada spawna um processo Claude —
// sem limite, um loop de requests vira DoS de custo (queima a cota do plano).
const AI_MAX = Number(process.env.AI_CONCURRENCY ?? 2);
let aiActive = 0;
const AI_ROUTES = new Set(["/dashboard/build-doc", "/dashboard/edit-doc", "/dashboard/insight", "/dashboard/insights-batch", "/doc/extract-pdf"]);

http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, "http://localhost");
  const method = req.method;
  // Sem CORS de propósito: a UI é servida por este mesmo servidor (same-origin).
  // CORS "*" permitiria a qualquer site aberto no browser ler os dashboards e disparar IA.

  // Arquivos estáticos
  if (method === "GET") {
    if (pathname === "/") return serveFile(res, path.join(here, "public", "index.html")); // landing page
    if (pathname === "/app" || pathname === "/dashboard") return serveFile(res, path.join(here, "public", "dashboard.html"));
    if (pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (pathname === "/license") return serveFile(res, path.join(here, "LICENSE"));
    // Como a IA está configurada? "key" (.env) | "claude-code" (sessão local) | "none" (a UI avisa)
    if (pathname === "/health") {
      let ai = process.env.ANTHROPIC_API_KEY ? "key" : "none";
      if (ai === "none") {
        try {
          if (existsSync(path.join(homedir(), ".claude", ".credentials.json"))) ai = "claude-code";
          else if (existsSync(path.join(homedir(), ".claude.json")) &&
                   /oauthAccount|primaryApiKey/.test(readFileSync(path.join(homedir(), ".claude.json"), "utf8"))) ai = "claude-code";
        } catch {}
      }
      return json(res, { ok: true, ai });
    }
    if (/^\/(style\.css|dashboard\.js|chart-lib\.js|parse-worker\.js)$/.test(pathname)) return serveFile(res, path.join(here, "public", pathname.slice(1)));
    if (pathname.startsWith("/vendor/")) {
      const rel = pathname.slice(8);
      if (rel.includes("..")) { res.writeHead(400); res.end(); return; }
      return serveFile(res, path.join(here, "public", "vendor", rel));
    }
    // Stub: Dash.IA não tem banco — prepareEnvironment consulta isso e segue direto
    if (pathname === "/catalog/status") return json(res, { count: 0, builtAt: null });
  }

  try {
    // Rotas de IA passam pela trava de concorrência
    if (method === "POST" && AI_ROUTES.has(pathname)) {
      if (aiActive >= AI_MAX) return json(res, { ok: false, error: "Muitas análises simultâneas — aguarde a atual terminar." }, 429);
      aiActive++;
      try {
        const body = await readBody(req);
        if (pathname === "/dashboard/build-doc") {
          // SSE: orquestrador → agentes (paralelo) → validação — o cliente VÊ a equipe trabalhando.
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
          const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };
          try {
            const out = process.env.DASH_ORCHESTRATE !== "0"
              ? await buildDocDashboardOrchestrated({ ...body, onProgress: (p) => send("progress", p) })
              : await buildDocDashboard(body);
            send("done", { ok: true, ...out });
          } catch (e) {
            // orquestração falhou → fallback: build de 1 chamada (o produto nunca quebra)
            process.stderr.write(`[orquestracao] fallback: ${e?.message ?? e}\n`);
            try { send("progress", { stage: "fallback" }); send("done", { ok: true, ...(await buildDocDashboard(body)) }); }
            catch (e2) { send("done", { ok: false, error: String(e2?.message ?? e2) }); }
          }
          res.end(); return;
        }
        if (pathname === "/dashboard/edit-doc")       return json(res, { ok: true, ...(await editDocDashboard(body)) });
        if (pathname === "/doc/extract-pdf")          return json(res, { ok: true, ...(await extractPdfData(body)) });
        if (pathname === "/dashboard/insight")        return json(res, { ok: true, narrative: await insightForTile(body) });
        if (pathname === "/dashboard/insights-batch") return json(res, { ok: true, insights: await insightsBatch(body) });
      } finally { aiActive--; }
    }

    // ── Export PowerPoint (apresentação de alta fidelidade, identidade Dash.IA) ──
    if (method === "POST" && pathname === "/export/pptx") {
      const { default: pptxgen } = await import("pptxgenjs");
      const body = await readBody(req);
      const buf  = await buildPresentation(pptxgen, body);
      const fn   = `${safeName(body.title)}.pptx`;
      res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation", "Content-Disposition": `attachment; filename="${fn}"`, "Content-Length": buf.length });
      res.end(buf);
      return;
    }

    // ── Perfil do usuário (espaço do user — local, sem auth) ──────────────
    if (pathname === "/user") {
      const file = path.join(DATA, "user.json");
      if (method === "GET")  return json(res, { ok: true, user: JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}")) });
      if (method === "POST") {
        const b = await readBody(req);
        const user = { name: String(b.name ?? "").slice(0, 80), role: String(b.role ?? "").slice(0, 80), company: String(b.company ?? "").slice(0, 80) };
        await fs.writeFile(file, JSON.stringify(user, null, 2), "utf8");
        return json(res, { ok: true, user });
      }
    }

    // ── Salvar / listar / carregar / excluir dashboards ────────────────────
    if (method === "POST" && pathname === "/dashboard/save") {
      const { name, spec } = await readBody(req);
      const sn   = safeName(name);
      const file = path.join(DATA, `dash_${sn}.json`);
      await fs.writeFile(file, JSON.stringify({ ...(spec ?? {}), savedAt: new Date().toISOString() }, null, 2), "utf8");
      return json(res, { ok: true, name: sn });
    }
    if (method === "GET" && pathname === "/dashboard/list") {
      // lista com RESUMO (título, quando, nº de painéis, domínio) — alimenta o espaço do usuário
      const files = (await fs.readdir(DATA).catch(() => [])).filter((f) => /^dash_.*\.json$/i.test(f));
      const items = [];
      for (const f of files) {
        const name = f.replace(/^dash_/, "").replace(/\.json$/, "");
        try {
          const spec = JSON.parse(await fs.readFile(path.join(DATA, f), "utf8"));
          items.push({ name, title: spec.title || name, savedAt: spec.savedAt || null,
            tiles: Array.isArray(spec.tiles) ? spec.tiles.length : 0,
            domain: spec.understanding?.domain || null, asked: spec.understanding?.request?.asked || null,
            file: spec.doc?.name || null });
        } catch { items.push({ name, title: name, savedAt: null, tiles: 0 }); }
      }
      items.sort((a, b) => String(b.savedAt || "").localeCompare(String(a.savedAt || "")));
      return json(res, { ok: true, names: items.map((i) => i.name), items });
    }
    if (method === "POST" && pathname === "/dashboard/delete") {
      const { name } = await readBody(req);
      const file = path.join(DATA, `dash_${safeName(name)}.json`);
      if (!path.resolve(file).startsWith(path.resolve(DATA))) return json(res, { ok: false, error: "Nome inválido" }, 400);
      await fs.unlink(file).catch(() => {});
      return json(res, { ok: true });
    }
    if (method === "GET" && pathname === "/dashboard/load") {
      const sn   = safeName(searchParams.get("name") || "");
      const file = path.join(DATA, `dash_${sn}.json`);
      if (!path.resolve(file).startsWith(path.resolve(DATA))) return json(res, { ok: false, error: "Nome inválido" }, 400);
      const spec = JSON.parse(await fs.readFile(file, "utf8"));
      return json(res, { ok: true, spec });
    }

  } catch (e) {
    process.stderr.write(`[erro] ${pathname}: ${e?.stack ?? e}\n`);
    return json(res, { ok: false, error: String(e?.message ?? e) }, 500);
  }

  res.writeHead(404); res.end("Not found");
}).listen(PORT, process.env.HOST ?? "127.0.0.1", () => {
  console.log(`Dash.IA: http://localhost:${PORT}`);
  if (process.env.ANTHROPIC_API_KEY) console.log("IA: usando a ANTHROPIC_API_KEY do .env.");
  else console.log(
    "IA: sem ANTHROPIC_API_KEY no .env — vou usar a sessao local do Claude Code (se instalado e logado).\n" +
    "    Para usar chave propria: copie .env.example para .env, preencha ANTHROPIC_API_KEY e reinicie.");
});
// 127.0.0.1 por padrão: dashboards salvos contêm dados reais da empresa — não expor na rede.
// Para acesso externo consciente (deploy SaaS com auth), definir HOST=0.0.0.0.

// ═══ Apresentação PPTX de alta fidelidade — um DECK, não um dump card-a-card ═══════════════════
// Estrutura: capa → resumo executivo (dados + achados + KPIs em cards) → leituras da IA →
// 1 slide por gráfico (imagem em card + insight ao lado) → tabela estilizada → encerramento.
async function buildPresentation(pptxgen, { title, fileName, user, understanding, tiles = [], panelColor }) {
  const BG = "191817", PANEL = "211F1E", LINE = "33302D", ACCENT = "F97316", ACCENT2 = "FB923C",
        TEXT = "F2F2F3", TEXT2 = "D8D6D3", MUTED = "9B9BA1", FONT = "Segoe UI";
  const imgBg = String(panelColor || "#211f1e").replace("#", "").toUpperCase() || PANEL;
  const prs = new pptxgen();
  prs.layout = "LAYOUT_WIDE"; // 13.33 × 7.5
  prs.author = user?.name || "Dash.IA";
  prs.title  = title || "Dashboard";
  prs.defineSlideMaster({
    title: "DIA", background: { color: BG },
    objects: [
      { rect: { x: 0, y: 0, w: "100%", h: 0.055, fill: { color: ACCENT } } },
      { text: { text: "Dash.IA", options: { x: 0.5, y: 7.08, w: 2, h: 0.3, fontSize: 10, bold: true, color: MUTED, fontFace: FONT } } },
    ],
    slideNumber: { x: 12.5, y: 7.08, color: MUTED, fontSize: 10, fontFace: FONT },
  });
  const head = (s, txt) => {
    s.addText(txt || "", { x: 0.55, y: 0.35, w: 12.2, h: 0.62, fontSize: 20, bold: true, color: TEXT, fontFace: FONT });
    s.addShape(prs.ShapeType.rect, { x: 0.57, y: 0.98, w: 0.55, h: 0.05, fill: { color: ACCENT } });
  };
  // logomark oficial: "D" de dashboard — haste = barra de gráfico, borda = gráfico de linha
  // com pontos de dado, faísca de IA no contra-espaço (mesma marca da UI, em shapes nativos)
  const drawMark = (s, x, y, sz) => {
    const u = sz / 24;
    s.addShape(prs.ShapeType.roundRect, { x, y, w: sz, h: sz, rectRadius: sz * 0.2, fill: { color: ACCENT } });
    s.addShape(prs.ShapeType.roundRect, { x: x + 6.6 * u, y: y + 5.8 * u, w: 3.1 * u, h: 12.4 * u, rectRadius: 1.5 * u, fill: { color: "FFFFFF" } });
    const seg = (x1, y1, x2, y2) => s.addShape(prs.ShapeType.line, {
      x: x + Math.min(x1, x2) * u, y: y + Math.min(y1, y2) * u,
      w: Math.max(0.001, Math.abs(x2 - x1)) * u, h: Math.max(0.001, Math.abs(y2 - y1)) * u,
      flipV: (x2 - x1) * (y2 - y1) < 0,
      line: { color: "FFFFFF", width: Math.max(1.2, sz * 6.8), endLineCap: "round" },
    });
    const P = [[9.7, 6.4], [11.8, 6.4], [15.7, 8.1], [17.4, 12], [15.7, 15.9], [11.8, 17.6], [9.7, 17.6]];
    for (let i = 0; i < P.length - 1; i++) seg(P[i][0], P[i][1], P[i + 1][0], P[i + 1][1]);
    for (const [px, py] of [[15.7, 8.1], [17.4, 12], [15.7, 15.9]])
      s.addShape(prs.ShapeType.ellipse, { x: x + (px - 1.25) * u, y: y + (py - 1.25) * u, w: 2.5 * u, h: 2.5 * u, fill: { color: "FFFFFF" } });
    const star = prs.ShapeType.star4 || prs.ShapeType.diamond;
    s.addShape(star, { x: x + 10.6 * u, y: y + 9.9 * u, w: 4 * u, h: 4 * u, fill: { color: "FFFFFF" } });
  };
  const kpis     = tiles.filter((t) => t.kind === "kpi");
  const insights = tiles.filter((t) => t.kind === "insight");
  const charts   = tiles.filter((t) => t.kind !== "kpi" && t.kind !== "insight" && t.kind !== "table");
  const tabs     = tiles.filter((t) => t.kind === "table");
  const hoje = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });

  // ── capa ──
  const cv = prs.addSlide();
  cv.background = { color: BG };
  cv.addShape(prs.ShapeType.rect, { x: 0, y: 0, w: 0.14, h: 7.5, fill: { color: ACCENT } });
  drawMark(cv, 0.85, 1.35, 0.95);
  cv.addText([{ text: "Dash", options: { color: TEXT } }, { text: ".IA", options: { color: ACCENT2 } }],
    { x: 1.95, y: 1.42, w: 4, h: 0.85, fontSize: 28, bold: true, fontFace: FONT });
  cv.addText(title || "Dashboard", { x: 0.87, y: 3.0, w: 11.7, h: 1.7, fontSize: 33, bold: true, color: TEXT, fontFace: FONT, lineSpacingMultiple: 1.04, valign: "top" });
  const sub = [fileName, hoje, user?.name ? `por ${user.name}${user.role ? ` · ${user.role}` : ""}` : null].filter(Boolean).join("     ·     ");
  cv.addText(sub, { x: 0.87, y: 4.85, w: 11.7, h: 0.45, fontSize: 13, color: MUTED, fontFace: FONT });
  cv.addText("Análise gerada por uma equipe de agentes de IA — dados processados localmente",
    { x: 0.87, y: 6.55, w: 11.7, h: 0.4, fontSize: 11.5, color: ACCENT2, fontFace: FONT });

  // ── resumo executivo: o que são os dados + achados + KPIs em cards ──
  if (understanding || kpis.length) {
    const s = prs.addSlide({ masterName: "DIA" });
    head(s, "Resumo executivo");
    if (understanding?.domain)
      s.addText([{ text: "O QUE SÃO ESTES DADOS\n", options: { fontSize: 10, bold: true, color: ACCENT2, charSpacing: 2 } },
                 { text: understanding.domain, options: { fontSize: 12.5, color: TEXT2 } }],
        { x: 0.55, y: 1.25, w: 6.4, h: 1.5, fontFace: FONT, lineSpacingMultiple: 1.2, valign: "top" });
    const finds = (understanding?.keyFindings || []).slice(0, 5);
    if (finds.length) {
      s.addText("PRINCIPAIS ACHADOS", { x: 0.55, y: 2.85, w: 6.4, h: 0.3, fontSize: 10, bold: true, color: ACCENT2, charSpacing: 2, fontFace: FONT });
      s.addText(finds.map((f) => ({ text: String(f), options: { bullet: { code: "25AA", indent: 12 }, breakLine: true } })),
        { x: 0.68, y: 3.2, w: 6.3, h: 3.6, fontSize: 12, color: TEXT2, fontFace: FONT, lineSpacingMultiple: 1.35, valign: "top" });
    }
    kpis.slice(0, 8).forEach((k, i) => {
      const col = i % 2, row = (i / 2) | 0, x = 7.35 + col * 2.98, y = 1.25 + row * 1.45;
      s.addShape(prs.ShapeType.roundRect, { x, y, w: 2.84, h: 1.3, rectRadius: 0.07, fill: { color: PANEL }, line: { color: LINE, width: 0.75 } });
      s.addShape(prs.ShapeType.rect, { x: x + 0.16, y: y + 0.2, w: 0.045, h: 0.9, fill: { color: ACCENT } });
      s.addText(String(k.title || ""), { x: x + 0.3, y: y + 0.1, w: 2.45, h: 0.42, fontSize: 9, color: MUTED, fontFace: FONT, valign: "top" });
      s.addText(String(k._kpiValue ?? "—"), { x: x + 0.3, y: y + 0.5, w: 2.45, h: 0.68, fontSize: 21, bold: true, color: TEXT, fontFace: FONT, valign: "middle" });
    });
  }

  // ── leituras da IA (tiles de insight) ──
  if (insights.length) {
    const s = prs.addSlide({ masterName: "DIA" });
    head(s, "Leituras da IA");
    insights.slice(0, 3).forEach((t, i) => {
      const y = 1.3 + i * 1.95;
      s.addShape(prs.ShapeType.roundRect, { x: 0.55, y, w: 12.2, h: 1.75, rectRadius: 0.08, fill: { color: PANEL }, line: { color: LINE, width: 0.75 } });
      s.addShape(prs.ShapeType.rect, { x: 0.55, y: y + 0.12, w: 0.05, h: 1.5, fill: { color: ACCENT } });
      s.addText(String(t.title || "Insight"), { x: 0.85, y: y + 0.12, w: 11.6, h: 0.35, fontSize: 12, bold: true, color: ACCENT2, fontFace: FONT });
      s.addText(String(t.narrative || ""), { x: 0.85, y: y + 0.5, w: 11.6, h: 1.15, fontSize: 11.5, color: TEXT2, fontFace: FONT, lineSpacingMultiple: 1.25, valign: "top" });
    });
  }

  // ── um slide por gráfico: imagem em card + painel de insight ao lado ──
  for (const t of charts) {
    const s = prs.addSlide({ masterName: "DIA" });
    head(s, t.title);
    const hasIns = !!t.insight;
    const maxW = hasIns ? 8.1 : 10.8, maxH = 5.35, ratio = Math.min(Math.max(Number(t._chartRatio) || 0.56, 0.3), 1.2);
    let w = maxW, h = w * ratio; if (h > maxH) { h = maxH; w = h / ratio; }
    const x = hasIns ? 0.55 + (maxW - w) / 2 : (13.33 - w) / 2, y = 1.3 + (maxH - h) / 2;
    s.addShape(prs.ShapeType.roundRect, { x: x - 0.13, y: y - 0.13, w: w + 0.26, h: h + 0.26, rectRadius: 0.09, fill: { color: imgBg }, line: { color: LINE, width: 0.75 } });
    if (t._chartImage) s.addImage({ data: t._chartImage, x, y, w, h });
    if (hasIns) {
      s.addShape(prs.ShapeType.roundRect, { x: 8.95, y: 1.25, w: 3.85, h: 5.45, rectRadius: 0.09, fill: { color: PANEL }, line: { color: LINE, width: 0.75 } });
      s.addText("INSIGHT", { x: 9.22, y: 1.5, w: 3.3, h: 0.3, fontSize: 10, bold: true, color: ACCENT2, charSpacing: 3, fontFace: FONT });
      s.addText(String(t.insight), { x: 9.22, y: 1.88, w: 3.32, h: 4.6, fontSize: 11.5, color: TEXT2, fontFace: FONT, lineSpacingMultiple: 1.3, valign: "top" });
    }
    if (t._filt) s.addText("Recorte: " + t._filt, { x: 0.55, y: 6.86, w: 11.5, h: 0.3, fontSize: 9.5, italic: true, color: MUTED, fontFace: FONT });
  }

  // ── tabelas estilizadas ──
  for (const t of tabs) {
    if (!t._rows?.length) continue;
    const s = prs.addSlide({ masterName: "DIA" });
    head(s, t.title);
    const cols = (t.columns && t.columns.length ? t.columns : Object.keys(t._rows[0] || {})).slice(0, 8);
    const header = cols.map((c) => ({ text: String(c), options: { bold: true, color: ACCENT2, fill: { color: "2A2825" }, fontSize: 10 } }));
    const rows = t._rows.slice(0, 12).map((r, ri) => cols.map((c) => ({
      text: String(r[c] ?? ""), options: { fontSize: 9.5, color: TEXT2, fill: { color: ri % 2 ? "1D1C1A" : PANEL } },
    })));
    s.addTable([header, ...rows], { x: 0.55, y: 1.3, w: 12.2, border: { pt: 0.5, color: LINE }, fontFace: FONT, valign: "middle", rowH: 0.34, autoPage: false });
    if (t._rows.length > 12) s.addText(`… e mais ${t._rows.length - 12} linha(s) no dashboard interativo`, { x: 0.55, y: 6.6, w: 8, h: 0.3, fontSize: 10, italic: true, color: MUTED, fontFace: FONT });
    if (t._filt) s.addText("Recorte: " + t._filt, { x: 0.55, y: 6.9, w: 11.5, h: 0.3, fontSize: 9.5, italic: true, color: MUTED, fontFace: FONT });
  }

  // ── encerramento ──
  const fim = prs.addSlide();
  fim.background = { color: BG };
  drawMark(fim, 6.17, 2.5, 1.0);
  fim.addText([{ text: "Gerado com ", options: { color: TEXT } }, { text: "Dash.IA", options: { color: ACCENT2 } }],
    { x: 0, y: 3.85, w: 13.33, h: 0.6, align: "center", fontSize: 22, bold: true, fontFace: FONT });
  fim.addText(`${tiles.length} painéis · ${hoje}${fileName ? ` · ${fileName}` : ""}`,
    { x: 0, y: 4.55, w: 13.33, h: 0.4, align: "center", fontSize: 12, color: MUTED, fontFace: FONT });
  return prs.write({ outputType: "nodebuffer" });
}
