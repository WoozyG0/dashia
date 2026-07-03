// Lógica de gráfico compartilhada. Sem módulos: expõe window.FMChart.
// chartOption() devolve a option do ECharts + uma nota ("top N de M") com limite de categorias
// p/ legibilidade. tok(name, default) lê os tokens CSS do tema (passado por quem chama).
(function () {
  const isNum = (v) => v !== null && v !== "" && v !== undefined && !isNaN(Number(v));
  function numericCols(columns, rows) {
    return columns.filter((c) => rows.length && rows.slice(0, 20).every((r) => r[c] == null || isNum(r[c])));
  }
  function pickAxes({ columns, rows, xField, yFields }) {
    const nums = numericCols(columns, rows);
    const x = xField && columns.includes(xField) ? xField : columns.find((c) => !nums.includes(c)) || columns[0];
    let ys = (yFields || []).filter((y) => columns.includes(y));
    if (!ys.length) ys = nums.filter((c) => c !== x);
    if (!ys.length) ys = columns.filter((c) => c !== x).slice(0, 1);
    return { x, ys };
  }
  // paleta da marca: laranja lidera, tons frios equilibram (harmonia, não arco-íris)
  const PALETTE = ["#f97316", "#8b5cf6", "#38bdf8", "#34d399", "#fbbf24", "#fb7185", "#2dd4bf", "#a78bfa"];

  function chartOption({ chartType, columns, rows, xField, yFields, stacked, percent }, tok) {
    const { x, ys } = pickAxes({ columns, rows, xField, yFields });
    const MAX = chartType === "pie" ? 12 : 30;
    const all = rows || [];
    const measure = (r) => ys.reduce((s, y) => s + (Number(r[y]) || 0), 0);
    let rws = all, pieRest = 0, note = "";
    if (all.length > MAX) {
      const sorted = [...all].sort((a, b) => measure(b) - measure(a));
      rws = sorted.slice(0, MAX);
      if (chartType === "pie") pieRest = sorted.slice(MAX).reduce((s, r) => s + (Number(r[ys[0]]) || 0), 0);
      note = `top ${MAX} de ${all.length}`;
    }
    const cMuted = tok("--muted", "#9b9ba1"), cText = tok("--text", "#f2f2f3"),
          cPanel = tok("--panel", "#211f1e"), cLine = tok("--panel-border", "#33302d"),
          cFaint = tok("--faint", "#6c6c72");
    const base = {
      color: PALETTE, backgroundColor: "transparent",
      textStyle: { color: cMuted, fontFamily: "Inter" },
      tooltip: {
        trigger: chartType === "pie" ? "item" : "axis",
        backgroundColor: cPanel, borderColor: cLine, textStyle: { color: cText, fontSize: 12.5 },
        padding: [10, 14], extraCssText: "border-radius:12px;box-shadow:0 12px 34px rgba(0,0,0,.30);",
        axisPointer: { type: "shadow", shadowStyle: { opacity: 0.06 } },
        valueFormatter: (v) => (v != null && !isNaN(v) ? Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + (percent ? "%" : "") : v),
      },
      legend: { show: ys.length > 1 || chartType === "pie", type: "scroll", icon: "circle",
        itemWidth: 9, itemHeight: 9, itemGap: 14, textStyle: { color: cMuted, fontSize: 11.5 }, top: 0, pageTextStyle: { color: cMuted } },
      grid: { left: 46, right: 16, top: chartType === "pie" ? 26 : 34, bottom: 44, containLabel: true },
    };
    const valueAxis = {
      type: "value",
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: cFaint, fontSize: 10.5, formatter: percent ? "{value}%" : undefined },
      splitLine: { lineStyle: { color: cLine, opacity: 0.45, type: "dashed" } },
    };
    let option;
    if (chartType === "pie") {
      const data = rws.map((r) => ({ name: String(r[x]), value: Number(r[ys[0]]) }));
      if (pieRest > 0) data.push({ name: "Outros", value: pieRest });
      option = { ...base, series: [{
        type: "pie", radius: ["46%", "72%"], center: ["50%", "54%"], data,
        itemStyle: { borderRadius: 7, borderColor: cPanel, borderWidth: 2 },
        label: { color: cMuted, fontSize: 11 }, labelLine: { lineStyle: { color: cLine } },
        emphasis: { scaleSize: 6, itemStyle: { shadowBlur: 18, shadowColor: "rgba(0,0,0,.28)" } },
      }] };
    } else {
      const isArea = chartType === "area";
      const cats = rws.map((r) => String(r[x]));
      // rótulos longos (nomes de fornecedor/cliente) numa barra => vira BARRA HORIZONTAL (legível)
      const horizontal = chartType === "bar" && cats.some((s) => s.length > 16);
      if (horizontal) {
        const ord = [...rws].reverse(); // maior no topo (eixo Y de categoria desenha de baixo p/ cima)
        option = {
          ...base,
          grid: { left: 8, right: 30, top: ys.length > 1 ? 30 : 12, bottom: 18, containLabel: true },
          yAxis: { type: "category", data: ord.map((r) => String(r[x])),
            axisLabel: { color: cMuted, width: 180, overflow: "truncate", fontSize: 11 },
            axisLine: { show: false }, axisTick: { show: false } },
          xAxis: { ...valueAxis },
          series: ys.map((y) => ({ name: y, type: "bar", data: ord.map((r) => Number(r[y])),
            stack: stacked ? "total" : undefined,
            barMaxWidth: 20, itemStyle: { borderRadius: stacked ? 2 : [0, 7, 7, 0] },
            emphasis: { itemStyle: { shadowBlur: 12, shadowColor: "rgba(0,0,0,.2)" } } })),
        };
      } else {
        option = {
          ...base,
          xAxis: { type: "category", data: cats,
            axisLabel: { rotate: cats.length > 8 ? 35 : 0, color: cMuted, hideOverlap: true, fontSize: 10.5 },
            axisLine: { lineStyle: { color: cLine } }, axisTick: { show: false } },
          yAxis: { ...valueAxis },
          series: ys.map((y) => ({
            name: y,
            type: isArea ? "line" : chartType,
            smooth: isArea || chartType === "line",
            stack: stacked && (chartType === "bar" || isArea) ? "total" : undefined,
            showSymbol: false, symbolSize: 7, lineStyle: chartType === "line" || isArea ? { width: 3 } : undefined,
            areaStyle: isArea ? { opacity: stacked ? 0.32 : 0.16 } : undefined,
            data: rws.map((r) => Number(r[y])),
            barMaxWidth: 42, itemStyle: chartType === "bar" ? { borderRadius: stacked ? 2 : [7, 7, 0, 0] } : undefined,
            emphasis: chartType === "bar" ? { itemStyle: { shadowBlur: 12, shadowColor: "rgba(0,0,0,.2)" } } : { focus: "series" },
          })),
        };
      }
    }
    return { option, note };
  }
  // formatação de KPI
  function fmtKpi(v, format) {
    const n = Number(v);
    if (!isNum(v)) return v == null ? "—" : String(v);
    if (format === "currency") return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: n >= 1000 ? 0 : 2 });
    if (format === "percent") return (n <= 1 ? n * 100 : n).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%";
    return n.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  }
  // ── Mapa do Brasil (choropleth por estado) ──
  let _brReady = null;
  const _brByNorm = {};
  const normState = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();
  function ensureBrazilMap() {
    if (_brReady) return _brReady;
    _brReady = fetch("/vendor/brazil-states.geojson").then((r) => r.json()).then((geo) => {
      echarts.registerMap("BR", geo);
      for (const f of geo.features) {
        const c = f.properties.name; // nome canônico do GeoJSON (ex.: "São Paulo")
        _brByNorm[normState(c)] = c;
        if (f.properties.sigla) _brByNorm[normState(f.properties.sigla)] = c; // UF (SP) -> nome
      }
      return true;
    });
    return _brReady;
  }
  function mapOption({ columns, rows, xField, yFields }, tok) {
    const { x, ys } = pickAxes({ columns, rows, xField, yFields });
    const y = ys[0];
    const data = [];
    for (const r of rows || []) {
      const nm = _brByNorm[normState(r[x])]; // casa nome OU sigla do estado com o GeoJSON
      if (nm) data.push({ name: nm, value: Number(r[y]) || 0 });
    }
    const vals = data.map((d) => d.value);
    const cMuted = tok("--muted", "#9b9ba1"), cText = tok("--text", "#f2f2f3"),
          cPanel = tok("--panel", "#211f1e"), cLine = tok("--panel-border", "#33302d");
    const accent = tok("--accent", "#f97316"), baseCol = tok("--sunken", cPanel);
    return {
      backgroundColor: "transparent", textStyle: { color: cMuted, fontFamily: "Inter" },
      tooltip: { trigger: "item", backgroundColor: cPanel, borderColor: cLine, textStyle: { color: cText },
        padding: [10, 14], extraCssText: "border-radius:12px;box-shadow:0 12px 34px rgba(0,0,0,.30);",
        formatter: (p) => `${p.name}: ${p.value != null && !isNaN(p.value) ? Number(p.value).toLocaleString("pt-BR") : "—"}` },
      visualMap: { left: "left", bottom: 12, min: Math.min(0, ...vals), max: Math.max(1, ...vals),
        inRange: { color: [baseCol, accent] }, textStyle: { color: cMuted }, calculable: true, itemWidth: 14, itemHeight: 110 },
      series: [{
        type: "map", map: "BR", roam: false, nameProperty: "name",
        label: { show: false }, itemStyle: { borderColor: cPanel, borderWidth: 0.8, areaColor: baseCol },
        emphasis: { label: { show: true, color: cText, fontSize: 11 }, itemStyle: { areaColor: accent, shadowBlur: 16, shadowColor: "rgba(0,0,0,.3)" } },
        select: { itemStyle: { areaColor: accent } }, data,
      }],
    };
  }

  window.FMChart = { numericCols, pickAxes, chartOption, mapOption, ensureBrazilMap, fmtKpi, isNum };
})();
