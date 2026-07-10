# Dash.IA

**Your data has a story. AI tells it for you.**

*English · [Português (Brasil)](README.pt-BR.md)*

Attach a spreadsheet (or PDF) and ask in plain language. An **AI orchestrator** understands your
data, assembles a **team of agents** — each one analyzing its own slice of the columns — and
delivers a dashboard with **ready-made insights** on every panel. Everything runs **on your machine**.

> The app UI is currently in Brazilian Portuguese.

## How it works

```
file → understanding (orchestrator) → agents in parallel (one per angle)
     → assembly → orchestrator review (dedup + validity + request coverage)
     → dashboard with ready-made insights
```

- **Understands before building** — domain, granularity and the role of every column are
  inferred from the content; the "How the AI understood your data" card shows the reasoning
  and how your request was mapped (term → actual column).
- **Your request is a contract** — "revenue share by state in 2024" becomes a share-by-state
  chart with the period filter applied to *every* panel; the applied filter is written on each
  one ("34,518 of 100,000 rows").
- **Reads everything** — Excel with **all sheets** (same schema = stacked with an `ABA` column;
  legend/lookup sheets become AI context) and **PDFs page by page** (text extracted locally
  with pdf.js; the AI structures it into columns/rows).
- **Bulletproof pt-BR numbers** — `1.234.567`, `R$ 1.234,56`, `(1.234,56)`, `1.234,56-`,
  `dd/mm/yyyy` dates, Windows-1252 ERP encodings.
- **Insights come pre-generated** — each panel's lightbulb is lit at build time, with real numbers.
- **Real exports** — high-fidelity PowerPoint deck (cover, executive summary with KPIs, one
  slide per chart with its insight alongside, styled table) and a standalone HTML page.
- **Conversational editing** — with a dashboard open, type the change ("turn the states chart
  into percentages") and the AI applies it without rebuilding everything.

## Requirements

- **Node.js 20.6+**
- AI — pick **one** of two paths:
  1. **Claude Code** installed and logged in (`claude` in your terminal) — no API key needed; or
  2. An **Anthropic API key** ([console.anthropic.com](https://console.anthropic.com)) in `.env`.

## Installation

```bash
git clone https://github.com/WoozyG0/dashia.git
cd dashia
npm install
cp .env.example .env    # edit it if you're using an API key
npm start
```

Open **http://localhost:4000** — the landing page has an "Open the app" button.
Attach a CSV/XLSX/PDF, describe the analysis (or send it empty for a general overview), done.

## Configuration (`.env` — all optional)

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | *(empty)* | API key; empty = use the local Claude Code session |
| `PORT` | `4000` | Server port |
| `HOST` | `127.0.0.1` | `0.0.0.0` exposes it on your LAN (**no authentication — be careful**) |
| `DASH_ORCHESTRATE` | `1` | `0` = single-call build (faster, shallower) |
| `DASH_MODEL` | `sonnet` | Default model (`sonnet` \| `opus` \| `haiku`) |
| `DASH_ORCH_MODEL` | `DASH_MODEL` | Orchestrator/reviewer model |
| `DASH_AGENT_MODEL` | `DASH_MODEL` | Slice-agent model |
| `DASH_AGENT_CONCURRENCY` | `3` | Agents running in parallel |
| `DASH_AI_TIMEOUT` | `240` | Per-AI-call timeout in seconds |
| `AI_CONCURRENCY` | `2` | Concurrent analyses accepted by the server |

## Privacy & security

- The server listens on **localhost only** by default; your data never leaves the machine.
- Spreadsheets are parsed **in the browser**; the server (and the AI) only receive column
  names, aggregate statistics and a minimal row sample — never the whole file.
- Saved dashboards live in `data/` (outside git).
- No open CORS, sanitized paths, DNS-rebinding guard, AI concurrency gate and a timeout on
  every AI call.

## Known limitations

- Scanned PDFs (images, no text layer) have nothing to extract.
- PDF extraction is capped at ~800 rows per document (the app tells you when it truncates).
- One data source per dashboard (one file at a time).

## Stack

Plain Node HTTP (zero frameworks) · [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) ·
ECharts · SheetJS · pdf.js · pptxgenjs — all vendored; works offline (except the AI).

## License

[MIT](LICENSE)
