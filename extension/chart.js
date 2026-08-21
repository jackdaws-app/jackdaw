// Interactive price-history chart: range filtering, crosshair tooltip,
// typical-price and range-low annotations, observation-density ticks, and
// a one-time draw-in animation. Canvas-based, no dependencies.
// Exposed as window.__jackdawChart for content.js (both run in the isolated world).
(() => {
  const RANGES = [
    { key: "1M", ms: 30 * 86400000 },
    { key: "3M", ms: 91 * 86400000 },
    { key: "6M", ms: 182 * 86400000 },
    { key: "1Y", ms: 365 * 86400000 },
    { key: "All", ms: Infinity },
  ];

  const AXIS_FONT = "10px ui-monospace, SFMono-Regular, Menlo, monospace";

  // Micro Center prints "$15,299.99"; every price string in Jackdaw matches it.
  const fmtPrice = (p) =>
    "$" + p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const fmtDateFull = (ms) =>
    new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  // Duration-weighted median: what this product "typically" costs.
  function typicalPrice(points) {
    const rows = points
      .map((p) => ({ price: p.price, w: Math.max(p.lastSeenAt - p.firstSeenAt, 3600000) }))
      .sort((a, b) => a.price - b.price);
    const total = rows.reduce((s, r) => s + r.w, 0);
    let acc = 0;
    for (const r of rows) {
      acc += r.w;
      if (acc >= total / 2) return r.price;
    }
    return rows.length ? rows[rows.length - 1].price : 0;
  }

  const PALETTES = {
    light: {
      grid: "rgba(120, 130, 145, 0.14)",
      axis: "#6b7280",
      tick: "rgba(22, 35, 58, 0.18)",
      typicalLine: "rgba(22, 35, 58, 0.3)",
      typicalText: "rgba(22, 35, 58, 0.78)",
      cross: "rgba(22, 35, 58, 0.35)",
      crossDot: "#16233a",
      crossRing: "#fff",
      line: "#16a34a",
      fillTop: "rgba(22, 163, 74, 0.18)",
      fillBottom: "rgba(22, 163, 74, 0)",
      oos: "#dc2626",
      ob: "#d97706",
      lowLine: "rgba(22, 163, 74, 0.55)",
      lowText: "#0e7a37",
      tagBg: "#15803d",
      tagText: "#fff",
    },
    dark: {
      grid: "rgba(148, 163, 184, 0.12)",
      axis: "#98a2b5",
      tick: "rgba(203, 213, 225, 0.22)",
      typicalLine: "rgba(203, 213, 225, 0.3)",
      typicalText: "rgba(203, 213, 225, 0.85)",
      cross: "rgba(203, 213, 225, 0.4)",
      crossDot: "#e6eaf2",
      crossRing: "#0f1726",
      line: "#22c55e",
      fillTop: "rgba(34, 197, 94, 0.16)",
      fillBottom: "rgba(34, 197, 94, 0)",
      oos: "#f87171",
      ob: "#f59e0b",
      lowLine: "rgba(74, 222, 128, 0.5)",
      lowText: "#4ade80",
      tagBg: "#22c55e",
      tagText: "#0c1220",
    },
  };

  function build(points, opts = {}) {
    const pal = PALETTES[opts.theme === "dark" ? "dark" : "light"];
    const root = document.createElement("div");
    root.className = "jd-chart" + (opts.reveal ? " mk-chart-reveal" : "");

    const toolbar = document.createElement("div");
    toolbar.className = "jd-chart-toolbar";
    const legend = document.createElement("div");
    legend.className = "jd-legend";
    const rangeWrap = document.createElement("div");
    rangeWrap.className = "jd-ranges";
    toolbar.append(legend, rangeWrap);

    // Prices are national, so the price line pools every store's readings —
    // the same pooling the alert path uses. What varies by location is the
    // open-box unit, so that overlay is scoped to the store the shopper has
    // already selected on the page (none for pseudo-stores like 029).
    const shelfStore = opts.shelfStore || null;
    const obAt = (p) => (shelfStore && p.storeNum === shelfStore ? p.openBoxPrice : null);

    // Legend doubles as series toggles (New is the primary line and stays on).
    const hasOpenBox = points.some((p) => obAt(p) != null);
    let showOpenBox = true;
    let showTypical = true;
    const key = (label, color, toggleable) => {
      const b = document.createElement(toggleable ? "button" : "span");
      b.className = "jd-key" + (toggleable ? " jd-key-toggle" : "");
      b.innerHTML = `<i class="jd-swatch" style="background:${color}"></i>${label}`;
      legend.append(b);
      return b;
    };
    key("New", pal.line, false);
    if (hasOpenBox) {
      const obKey = key("Open-box · " + (opts.shelfStoreName || "#" + shelfStore), pal.ob, true);
      obKey.addEventListener("click", () => {
        showOpenBox = !showOpenBox;
        obKey.classList.toggle("jd-key-off", !showOpenBox);
        update();
      });
    }
    const typKey = key("Typical", "currentColor", true);
    typKey.addEventListener("click", () => {
      showTypical = !showTypical;
      typKey.classList.toggle("jd-key-off", !showTypical);
      update();
    });

    const stage = document.createElement("div");
    stage.className = "jd-chart-stage";
    const canvas = document.createElement("canvas");
    const tooltip = document.createElement("div");
    tooltip.className = "jd-tooltip";
    const liveDot = document.createElement("span");
    liveDot.className = "jd-live-dot";
    stage.append(canvas, tooltip, liveDot);

    // Drag handle: resize the chart's height (clamped), persisted by the caller.
    let chartH = Math.min(Math.max(opts.height || 190, 140), 340);
    const resizer = document.createElement("div");
    resizer.className = "jd-resizer";
    resizer.title = "Drag to resize";
    resizer.innerHTML = "<span></span>";
    resizer.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      resizer.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startH = chartH;
      const move = (ev) => {
        chartH = Math.min(Math.max(startH + (ev.clientY - startY), 140), 340);
        update();
      };
      const up = () => {
        resizer.removeEventListener("pointermove", move);
        resizer.removeEventListener("pointerup", up);
        if (opts.onHeightChange) opts.onHeightChange(chartH);
      };
      resizer.addEventListener("pointermove", move);
      resizer.addEventListener("pointerup", up);
    });

    root.append(toolbar, stage, resizer);

    let range = null;
    let hover = null;
    let drawProgress = opts.reveal ? 0 : 1; // one-time draw-in
    let drawAnimStart = null;

    function segsFor(pts) {
      const all = pts
        .slice()
        .sort((a, b) => a.firstSeenAt - b.firstSeenAt)
        .map((p) => ({
          t0: p.firstSeenAt,
          t1: Math.max(p.lastSeenAt, p.firstSeenAt),
          price: p.price,
          inStock: p.inStock,
          openBox: obAt(p),
          // The same rule products.ts and computeStats apply: a lone grid card
          // may be DRAWN, but it may not name the record. `source` is absent on
          // responses from an older backend, and absent-is-not-catalog keeps
          // those deployments reading exactly as they did.
          corrob: p.reportCount > 1 || p.source !== "catalog",
        }));
      if (all.length) all[all.length - 1].t1 = Math.max(all[all.length - 1].t1, Date.now());
      return all;
    }

    // Range pills — only ranges the data can fill (plus the first that covers it)
    const btns = new Map();
    function syncRanges() {
      rangeWrap.textContent = "";
      btns.clear();
      const all = segsFor(points);
      const spanAll = all.length ? all[all.length - 1].t1 - all[0].t0 : 0;
      const usable = RANGES.filter((_, i) => i === 0 || RANGES[i - 1].ms < spanAll);
      if (!range || !usable.includes(range)) range = usable.find((r) => r.ms >= spanAll) || usable[usable.length - 1];
      for (const r of usable) {
        const b = document.createElement("button");
        b.className = "jd-range-btn";
        b.textContent = r.key;
        b.addEventListener("click", () => {
          range = r;
          update();
        });
        btns.set(r.key, b);
        rangeWrap.append(b);
      }
    }
    syncRanges();

    function visibleSegs() {
      const all = segsFor(points);
      if (!all.length) return [];
      const end = all[all.length - 1].t1;
      const start = range.ms === Infinity ? all[0].t0 : end - range.ms;
      return all.filter((s) => s.t1 >= start).map((s) => ({ ...s, t0: Math.max(s.t0, start) }));
    }

    let geom = null;

    function draw(ts) {
      const segs = visibleSegs();
      if (!segs.length) return;

      // draw-in animation clock
      if (drawProgress < 1) {
        if (drawAnimStart == null) drawAnimStart = ts || performance.now();
        const t = Math.min(((ts || performance.now()) - drawAnimStart) / 650, 1);
        drawProgress = 1 - Math.pow(1 - t, 3); // ease-out cubic
      }

      const W = stage.clientWidth || 420;
      const H = chartH;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);
      ctx.font = AXIS_FONT;

      const padL = 8, padT = 14, padB = 24;
      const t0 = segs[0].t0;
      const t1 = segs[segs.length - 1].t1;
      const span = Math.max(t1 - t0, 60_000);
      let pMin = Infinity, pMax = -Infinity, lowest = Infinity;
      for (const s of segs) {
        pMin = Math.min(pMin, s.price, s.openBox != null ? s.openBox : Infinity);
        pMax = Math.max(pMax, s.price);
        // Corroborated readings only — an uncorroborated sighting is still
        // plotted, it just cannot define the annotated low.
        if (s.corrob) lowest = Math.min(lowest, s.price);
      }
      const typical = typicalPrice(points);
      const pad = Math.max((pMax - pMin) * 0.18, pMax * 0.03, 1);
      const yMin = pMin - pad, yMax = pMax + pad;

      // The right gutter is measured from the labels that will actually be
      // drawn, not fixed. It was 52px, which gave the text 42px of room —
      // enough for "$999.99" (42.14px, already 0.14 over) and nothing above it.
      // Every four-figure price on the site clipped against the canvas edge,
      // and the thousands separator adds another 6px per comma. A magic number
      // cannot survive a product costing more than the one it was tuned on.
      const ticks = [];
      for (let i = 0; i <= 3; i++) ticks.push(fmtPrice(yMin + ((yMax - yMin) * i) / 3));
      ctx.font = "600 " + AXIS_FONT; // the endpoint tag is bold — measure worst case
      const labelW = Math.max(...ticks.map((s) => ctx.measureText(s).width));
      ctx.font = AXIS_FONT;
      // 10 clears the gridline overhang the label sits beside, 4 keeps it off
      // the edge; floored at the old value so short-price charts are unchanged.
      const padR = Math.max(Math.ceil(labelW) + 14, 52);

      const x = (t) => padL + ((t - t0) / span) * (W - padL - padR);
      const y = (p) => padT + (1 - (p - yMin) / (yMax - yMin)) * (H - padT - padB);
      geom = { x, y, t0, t1, W, H, padL, padR, padT, padB, segs };

      ctx.clearRect(0, 0, W, H);

      // 1px strokes land on half-pixels so they cover one device row, not a
      // fuzzy two. Only hairlines are snapped; the data line keeps true coords.
      const crisp = (v) => Math.round(v) + 0.5;

      // grid + right-axis labels — drawn from the same `ticks` the gutter was
      // measured from, so the width that was reserved is the width that lands.
      // Labels right-align against one rail (ragged left edges read untidy).
      ctx.font = AXIS_FONT;
      ctx.strokeStyle = pal.grid;
      ctx.fillStyle = pal.axis;
      ctx.lineWidth = 1;
      ctx.textAlign = "right";
      for (let i = 0; i <= 3; i++) {
        const yy = crisp(y(yMin + ((yMax - yMin) * i) / 3));
        ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR + 6, yy); ctx.stroke();
        ctx.fillText(ticks[i], W - 4, yy + 3);
      }
      ctx.textAlign = "left";
      // x labels: start, middle, end
      ctx.fillText(fmtDate(t0), padL, H - 8);
      const midLabel = fmtDate(t0 + span / 2);
      ctx.fillText(midLabel, (padL + W - padR) / 2 - ctx.measureText(midLabel).width / 2, H - 8);
      const ll = fmtDate(t1);
      ctx.fillText(ll, W - padR - ctx.measureText(ll).width, H - 8);

      // observation-density ticks: one per sighting window start (data honesty)
      ctx.strokeStyle = pal.tick;
      ctx.lineWidth = 1;
      for (const s of segs) {
        const tx = crisp(x(s.t0));
        ctx.beginPath(); ctx.moveTo(tx, H - padB + 2); ctx.lineTo(tx, H - padB + 5); ctx.stroke();
      }

      // clip for the draw-in sweep
      ctx.save();
      const sweepW = padL + drawProgress * (W - padL - padR + 8);
      ctx.beginPath();
      ctx.rect(0, 0, sweepW, H);
      ctx.clip();

      // area fill
      const grad = ctx.createLinearGradient(0, padT, 0, H - padB);
      grad.addColorStop(0, pal.fillTop);
      grad.addColorStop(1, pal.fillBottom);
      ctx.beginPath();
      ctx.moveTo(x(segs[0].t0), y(segs[0].price));
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        ctx.lineTo(x(s.t0), y(s.price));
        ctx.lineTo(x(s.t1), y(s.price));
        if (i + 1 < segs.length) ctx.lineTo(x(segs[i + 1].t0), y(s.price));
      }
      ctx.save();
      ctx.lineTo(x(t1), H - padB);
      ctx.lineTo(x(segs[0].t0), H - padB);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();

      // step line
      ctx.beginPath();
      ctx.moveTo(x(segs[0].t0), y(segs[0].price));
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        ctx.lineTo(x(s.t0), y(s.price));
        ctx.lineTo(x(s.t1), y(s.price));
        if (i + 1 < segs.length) ctx.lineTo(x(segs[i + 1].t0), y(s.price));
      }
      ctx.strokeStyle = pal.line;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();

      // out-of-stock overlay
      ctx.strokeStyle = pal.oos;
      ctx.lineWidth = 2;
      for (const s of segs) {
        if (!s.inStock) {
          ctx.beginPath();
          ctx.moveTo(x(s.t0), y(s.price));
          ctx.lineTo(x(s.t1), y(s.price));
          ctx.stroke();
        }
      }

      // open-box series (a second line over the same axes; gaps where none was seen)
      ctx.strokeStyle = pal.ob;
      ctx.fillStyle = pal.ob;
      ctx.lineWidth = 1.75;
      for (let i = 0; showOpenBox && i < segs.length; i++) {
        const s = segs[i];
        if (s.openBox == null) continue;
        ctx.beginPath();
        ctx.moveTo(x(s.t0), y(s.openBox));
        ctx.lineTo(x(s.t1), y(s.openBox));
        const n = segs[i + 1];
        if (n && n.openBox != null && n.t0 - s.t1 < 86400000) {
          ctx.lineTo(x(n.t0), y(n.openBox));
        }
        ctx.stroke();
        // sighting dot: where this open-box reading began
        ctx.beginPath();
        ctx.arc(x(s.t0), y(s.openBox), 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore(); // end sweep clip

      // typical-price dotted line (only once it separates visually from LOW)
      ctx.letterSpacing = "0.5px";
      // No corroborated reading in range means no low line to separate from —
      // and without this guard y(Infinity) is NaN, which silently kills TYPICAL too.
      const hasLow = isFinite(lowest);
      // The window tag below is a DISCLOSURE, not decoration: name the range
      // only when it is actually hiding a lower corroborated price. The range
      // pills offer the first range that covers the data, so most charts open
      // on a window that hides nothing — tagging those would imply history
      // outside the window that does not exist.
      let lowestAll = Infinity;
      for (const p of points) {
        if (p.reportCount > 1 || p.source !== "catalog") lowestAll = Math.min(lowestAll, p.price);
      }
      const lowIsAllTime = !isFinite(lowestAll) || lowest <= lowestAll;
      if (showTypical && (!hasLow || Math.abs(y(typical) - y(lowest)) > 9)) {
        ctx.setLineDash([2, 5]);
        ctx.strokeStyle = pal.typicalLine;
        ctx.lineWidth = 1;
        const ty = crisp(y(typical));
        ctx.beginPath(); ctx.moveTo(padL, ty); ctx.lineTo(W - padR + 6, ty); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = pal.typicalText;
        ctx.font = "600 9px system-ui, sans-serif";
        ctx.fillText("TYPICAL " + fmtPrice(typical), padL + 2, y(typical) - 4);
      }

      // Low annotation: the lowest CORROBORATED price inside the VISIBLE range.
      // Both qualifiers are load-bearing, and this canvas asserted neither — it
      // travels into the share image, where no reader can check it.
      if (hasLow) {
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = pal.lowLine;
        ctx.lineWidth = 1;
        const wy = crisp(y(lowest));
        ctx.beginPath(); ctx.moveTo(padL, wy); ctx.lineTo(W - padR + 6, wy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = pal.lowText;
        ctx.font = "600 9px system-ui, sans-serif";
        // The window is part of the claim: an unlabelled LOW on a 1M chart
        // reads as a record when it is a one-month minimum.
        ctx.fillText(
          (lowIsAllTime ? "LOW " : `LOW (${range.key}) `) + fmtPrice(lowest),
          padL + 2, y(lowest) - 4,
        );
      }
      ctx.letterSpacing = "0px";

      // live price marker: DOM dot (CSS pulse) pinned to the line's end
      const lineEnd = { x: x(t1), y: y(segs[segs.length - 1].price) };
      liveDot.style.opacity = drawProgress >= 1 ? "1" : "0";
      liveDot.style.transform = `translate(${lineEnd.x - 4}px, ${lineEnd.y - 4}px)`;

      // current-price tag on the axis rail (arrives with the dot, after the
      // sweep — a tag showing the ending before the line gets there spoils it)
      if (drawProgress >= 1) {
        const tagText = fmtPrice(segs[segs.length - 1].price);
        ctx.font = "600 " + AXIS_FONT;
        const tw2 = ctx.measureText(tagText).width;
        const tagH = 16;
        const tagY = Math.min(Math.max(lineEnd.y - tagH / 2, padT), H - padB - tagH);
        ctx.fillStyle = pal.tagBg;
        ctx.beginPath();
        ctx.roundRect(W - padR + 6, tagY, Math.min(tw2 + 10, padR - 8), tagH, 4);
        ctx.fill();
        ctx.fillStyle = pal.tagText;
        ctx.fillText(tagText, W - padR + 11, tagY + 11.5);
        ctx.font = AXIS_FONT;
      }

      // crosshair
      if (hover != null) {
        const t = hover;
        const seg =
          segs.find((s) => t >= s.t0 && t <= s.t1) ||
          segs.reduce((a, b) => (Math.abs(t - (a.t0 + a.t1) / 2) < Math.abs(t - (b.t0 + b.t1) / 2) ? a : b));
        const hx = Math.min(Math.max(x(t), x(seg.t0)), x(seg.t1));
        const hy = y(seg.price);
        ctx.strokeStyle = pal.cross;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        const cx2 = crisp(hx);
        ctx.beginPath(); ctx.moveTo(cx2, padT); ctx.lineTo(cx2, H - padB); ctx.stroke();
        ctx.setLineDash([]);
        if (showOpenBox && seg.openBox != null) {
          ctx.beginPath(); ctx.arc(hx, y(seg.openBox), 3, 0, Math.PI * 2);
          ctx.fillStyle = pal.ob; ctx.fill();
          ctx.lineWidth = 1.5; ctx.strokeStyle = pal.crossRing; ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = pal.crossDot; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = pal.crossRing; ctx.stroke();

        tooltip.style.opacity = "1";
        tooltip.textContent = "";
        const priceEl = document.createElement("div");
        priceEl.className = "jd-tt-price";
        priceEl.textContent = fmtPrice(seg.price);
        tooltip.append(priceEl);
        if (showOpenBox && seg.openBox != null) {
          const obEl = document.createElement("div");
          obEl.className = "jd-tt-ob";
          obEl.textContent = "Open-box " + fmtPrice(seg.openBox);
          tooltip.append(obEl);
        }
        const dateEl = document.createElement("div");
        dateEl.className = "jd-tt-date";
        // "Seen", because a chart segment is recorded history, not live truth —
        // the same idiom as "last seen" on every other stock figure.
        dateEl.textContent = fmtDateFull(t) + (seg.inStock ? "" : " · seen out of stock");
        if (!seg.inStock) dateEl.classList.add("jd-tt-oos");
        tooltip.append(dateEl);
        const tw = tooltip.offsetWidth;
        tooltip.style.transform = `translate(${Math.min(Math.max(hx - tw / 2, 4), W - tw - 4)}px, 0)`;
      } else {
        tooltip.style.opacity = "0";
      }

      for (const [k, b] of btns) b.classList.toggle("jd-range-active", k === range.key);

      if (drawProgress < 1) requestAnimationFrame(draw);
    }

    const update = () => requestAnimationFrame(draw);

    stage.addEventListener("mousemove", (e) => {
      if (!geom) return;
      const rect = canvas.getBoundingClientRect();
      const frac = (e.clientX - rect.left - geom.padL) / (geom.W - geom.padL - geom.padR);
      hover = geom.t0 + Math.min(Math.max(frac, 0), 1) * (geom.t1 - geom.t0);
      update();
    });
    stage.addEventListener("mouseleave", () => {
      hover = null;
      update();
    });

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) drawProgress = 1;
    update();
    // The first paint is a rAF away and the draw-in runs 650ms; anything
    // that copies these pixels (the share button) needs the finished frame
    // now, not the blank pre-first-frame canvas or a mid-animation one.
    root.__finishDraw = () => { drawProgress = 1; draw(); };
    return root;
  }

  window.__jackdawChart = { build, typicalPrice };
})();
