// Wrapper IA — Agent SDK keyless (usa autenticação do Claude Code, sem API key).
// Para deploy SaaS com API key própria: trocar por @anthropic-ai/sdk (client.messages.create).
import { query } from "@anthropic-ai/claude-agent-sdk";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

const MODELS = {
  opus:   "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  haiku:  "claude-haiku-4-5-20251001",
};
const resolve = (m) => MODELS[m] ?? m;

/** Chamada one-shot: system + prompt → texto. maxTokens ignorado (Agent SDK gerencia).
 *  Timeout obrigatório (DASH_AI_TIMEOUT, padrão 240s): chamada travada NUNCA pode reter
 *  a vaga do gate de concorrência do servidor para sempre. */
const AI_TIMEOUT_MS = Math.max(30, Number(process.env.DASH_AI_TIMEOUT ?? 240)) * 1000;
export async function agentText(system, prompt, model = "sonnet", extra = {}) {
  const ac = new AbortController();
  let timer = null;
  const run = (async () => {
    let text = "";
    const q = query({
      prompt,
      options: {
        cwd: here,
        model: resolve(model),
        systemPrompt: system,
        permissionMode: "bypassPermissions",
        allowedTools: [],
        maxTurns: 1,
        abortController: ac,
        ...(extra.thinking ? { thinking: extra.thinking } : {}),
        ...(extra.effort ? { effort: extra.effort } : {}),
      },
    });
    for await (const msg of q) {
      if (msg.type === "assistant") {
        for (const b of msg.message.content ?? []) {
          if (b.type === "text") text += b.text;
        }
      }
    }
    return text;
  })();
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => {
      try { ac.abort(); } catch {}
      rej(new Error(`IA não respondeu em ${AI_TIMEOUT_MS / 1000}s — tente novamente`));
    }, AI_TIMEOUT_MS);
  });
  try { return await Promise.race([run, timeout]); }
  finally { clearTimeout(timer); run.catch(() => {}); } // não deixa rejeição órfã derrubar o processo
}

/** Extrai o primeiro objeto JSON de uma string (tolerante a markdown e trailing commas). */
export function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("IA não retornou JSON: " + text.slice(0, 300));
  let raw = m[0];
  raw = raw.replace(/,(\s*[}\]])/g, "$1");
  raw = raw.replace(/"((?:[^"\\]|\\.)*)"/g, (_, inner) => {
    const fixed = inner.split("").map((c) => {
      const code = c.charCodeAt(0);
      if (code > 31) return c;
      if (code === 10) return "\\n";
      if (code === 13) return "\\r";
      if (code === 9)  return "\\t";
      return "\\u" + code.toString(16).padStart(4, "0");
    }).join("");
    return '"' + fixed + '"';
  });
  return JSON.parse(raw);
}

/**
 * Leitura de PDF via Claude (requer API key — modo keyless não suporta document blocks).
 * Retorna erro claro para que o servidor possa informar o usuário.
 */
export async function readPdfWithClaude(_pdfBuffer, _prompt, _model) {
  throw new Error("Leitura de PDF requer modo API key (ANTHROPIC_API_KEY). Por enquanto use CSV ou XLSX.");
}
