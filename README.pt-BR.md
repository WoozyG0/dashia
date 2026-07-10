# Dash.IA

**Seus dados têm uma história. A IA conta ela para você.**

*[English](README.md) · Português (Brasil)*

Anexe uma planilha (ou PDF) e peça em português. Um **orquestrador de IA** entende os dados,
monta uma **equipe de agentes** — cada um analisa a sua fatia das colunas — e entrega um
dashboard com **insights prontos** em cada painel. Tudo roda **na sua máquina**.

## Como funciona

```
arquivo → entendimento (orquestrador) → agentes em paralelo (um por ângulo)
        → montagem → revisão do orquestrador (dedup + validade + pedido coberto)
        → dashboard com insights prontos
```

- **Entende antes de montar** — domínio, granularidade e papel de cada coluna são inferidos
  do conteúdo; o card "Como a IA entendeu seus dados" mostra o raciocínio e o mapeamento do
  seu pedido (termo → coluna real).
- **Pedido é contrato** — "percentual do faturamento por estado em 2024" vira share por UF
  com o período aplicado em *todos* os painéis; o recorte fica escrito em cada um
  ("34.518 de 100.000 linhas").
- **Lê tudo** — Excel com **todas as abas** (mesmo esquema = empilhadas com coluna `ABA`;
  abas de legenda viram contexto para a IA) e **PDF página a página** (texto extraído
  localmente com pdf.js; a IA estrutura em colunas/linhas).
- **Números pt-BR à prova de bala** — `1.234.567`, `R$ 1.234,56`, `(1.234,56)`, `1.234,56-`,
  datas `dd/mm/aaaa`, encoding Windows-1252 de ERP.
- **Insights já vêm prontos** — a lâmpada de cada painel acende no build, com números reais.
- **Exportação de verdade** — PowerPoint de alta fidelidade (capa, resumo executivo com KPIs,
  um slide por gráfico com o insight ao lado, tabela estilizada) e página HTML.
- **Edição conversacional** — com o dashboard aberto, digite o ajuste ("transforma o gráfico
  de estados em percentual") e a IA aplica sem refazer tudo.

## Requisitos

- **Node.js 20.6+**
- IA — escolha **um** dos dois caminhos:
  1. **Claude Code** instalado e logado (`claude` no terminal) — não precisa de chave; ou
  2. **Chave da API Anthropic** ([console.anthropic.com](https://console.anthropic.com)) no `.env`.

## Instalação

```bash
git clone https://github.com/WoozyG0/dashia.git
cd dashia
npm install
cp .env.example .env    # edite se for usar chave de API
npm start
```

Abra **http://localhost:4000** — a landing page tem o botão "Abrir o app".
Anexe um CSV/XLSX/PDF, descreva a análise (ou envie em branco para a visão geral) e pronto.

## Configuração (`.env` — tudo opcional)

| Variável | Default | O que faz |
|---|---|---|
| `ANTHROPIC_API_KEY` | *(vazia)* | Chave da API; vazia = usa a sessão do Claude Code |
| `PORT` | `4000` | Porta do servidor |
| `HOST` | `127.0.0.1` | `0.0.0.0` expõe na rede local (**sem autenticação — cuidado**) |
| `DASH_ORCHESTRATE` | `1` | `0` = build em chamada única (mais rápido, menos profundo) |
| `DASH_MODEL` | `sonnet` | Modelo padrão (`sonnet` \| `opus` \| `haiku`) |
| `DASH_ORCH_MODEL` | `DASH_MODEL` | Modelo do orquestrador/revisor |
| `DASH_AGENT_MODEL` | `DASH_MODEL` | Modelo dos agentes de fatia |
| `DASH_AGENT_CONCURRENCY` | `3` | Agentes rodando em paralelo |
| `DASH_AI_TIMEOUT` | `240` | Teto em segundos por chamada de IA |
| `AI_CONCURRENCY` | `2` | Análises simultâneas aceitas pelo servidor |

## Privacidade e segurança

- O servidor escuta **só em localhost** por padrão; dados não saem da máquina.
- A planilha é lida **no navegador**; ao servidor (e à IA) vão apenas nomes de colunas,
  estatísticas agregadas e uma amostra mínima de linhas — nunca o arquivo inteiro.
- Dashboards salvos ficam em `data/` (fora do git).
- Sem CORS aberto, caminhos sanitizados, gate de concorrência e timeout em toda chamada de IA.

## Limitações conhecidas

- PDF escaneado (imagem, sem camada de texto) não tem o que extrair.
- Extração de PDF limitada a ~800 linhas por documento (o app avisa quando corta).
- Uma fonte de dados por dashboard (um arquivo por vez).

## Stack

Node HTTP puro (zero framework) · [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) ·
ECharts · SheetJS · pdf.js · pptxgenjs — vendorizados, funciona offline (exceto a IA).

## Licença

[MIT](LICENSE)
