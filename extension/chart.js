// Interactive price-history chart: range + store filtering, crosshair tooltip,
// typical-price and all-time-low annotations, observation-density ticks, and
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

  const fmtPrice = (p) => "$" + p.toFixed(2);
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
      axis: "#8a92a0",
      tick: "rgba(22, 35, 58, 0.18)",
      typicalLine: "rgba(22, 35, 58, 0.3)",
      typicalText: "rgba(22, 35, 58, 0.55)",
      cross: "rgba(22, 35, 58, 0.35)",
      crossDot: "#16233a",
      crossRing: "#fff",
    },
    dark: {
      grid: "rgba(148, 163, 184, 0.12)",
      axis: "#7c8598",
      tick: "rgba(203, 213, 225, 0.22)",
      typicalLine: "rgba(203, 213, 225, 0.3)",
      typicalText: "rgba(203, 213, 225, 0.6)",
      cross: "rgba(203, 213, 225, 0.4)",
      crossDot: "#e6eaf2",
      crossRing: "#0f1726",
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
    const storeWrap = document.createElement("div");
    storeWrap.className = "jd-ranges";
    const rangeWrap = document.createElement("div");
    rangeWrap.className = "jd-ranges";
    toolbar.append(legend, storeWrap, rangeWrap);

    const hasOpenBox = points.some((p) => p.openBoxPrice != null);
    legend.innerHTML =
      `<span class="jd-key"><i class="jd-swatch" style="background:#16a34a"></i>New</span>` +
      (hasOpenBox ? `<span class="jd-key"><i class="jd-swatch" style="background:#d97706"></i>Open-box</span>` : "");

    const stage = document.createElement("div");
    stage.className = "jd-chart-stage";
    const canvas = document.createElement("canvas");
    const tooltip = document.createElement("div");
    tooltip.className = "jd-tooltip";
    const liveDot = document.createElement("span");
    liveDot.className = "jd-live-dot";
    stage.append(canvas, tooltip, liveDot);
    root.append(toolbar, stage);

    const stores = [...new Set(points.map((p) => p.storeNum))].sort();
    let store = "All";
    let range = null;
    let hover = null;
    let drawProgress = opts.reveal ? 0 : 1; // one-time draw-in
    let drawAnimStart = null;

    function activePoints() {
      return store === "All" ? points : points.filter((p) => p.storeNum === store);
    }

    function segsFor(pts) {
      const all = pts
        .slice()
        .sort((a, b) => a.firstSeenAt - b.firstSeenAt)
        .map((p) => ({
          t0: p.firstSeenAt,
          t1: Math.max(p.lastSeenAt, p.firstSeenAt),
          price: p.price,
          inStock: p.inStock,
          openBox: p.openBoxPrice != null ? p.openBoxPrice : null,
        }));
      if (all.length) all[all.length - 1].t1 = Math.max(all[all.length - 1].t1, Date.now());
      return all;
    }

    // Store pills (only when the flock has seen more than one store)
    if (stores.length > 1) {
      const mk = (key, label) => {
        const b = document.createElement("button");
        b.className = "jd-range-btn";
        b.textContent = label;
        b.addEventListener("click", () => {
          store = key;
          syncRanges();
          update();
        });
        storeWrap.append(b);
        return b;
      };
      const storeBtns = new Map([["All", mk("All", "All stores")]]);
      for (const s of stores) storeBtns.set(s, mk(s, "#" + s));
      storeWrap.addEventListener("click", () => {
        for (const [k, b] of storeBtns) b.classList.toggle("jd-range-active", k === store);
      });
      storeBtns.get("All").classList.add("jd-range-active");
    }

    // Range pills — only ranges the data can fill (plus the first that covers it)
    const btns = new Map();
    function syncRanges() {
      rangeWrap.textContent = "";
      btns.clear();
      const all = segsFor(activePoints());
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
      const all = segsFor(activePoints());
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
      const H = 190;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);

      const padL = 8, padR = 52, padT = 14, padB = 24;
      const t0 = segs[0].t0;
      const t1 = segs[segs.length - 1].t1;
      const span = Math.max(t1 - t0, 60_000);
      let pMin = Infinity, pMax = -Infinity, lowest = Infinity;
      for (const s of segs) {
        pMin = Math.min(pMin, s.price, s.openBox != null ? s.openBox : Infinity);
        pMax = Math.max(pMax, s.price);
        lowest = Math.min(lowest, s.price); // LOW line tracks the new-price series
      }
      const typical = typicalPrice(activePoints());
      const pad = Math.max((pMax - pMin) * 0.18, pMax * 0.03, 1);
      const yMin = pMin - pad, yMax = pMax + pad;

      const x = (t) => padL + ((t - t0) / span) * (W - padL - padR);
      const y = (p) => padT + (1 - (p - yMin) / (yMax - yMin)) * (H - padT - padB);
      geom = { x, y, t0, t1, W, H, padL, padR, padT, padB, segs };

      ctx.clearRect(0, 0, W, H);

      // grid + right-axis labels
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.strokeStyle = pal.grid;
      ctx.fillStyle = pal.axis;
      for (let i = 0; i <= 3; i++) {
        const p = yMin + ((yMax - yMin) * i) / 3;
        const yy = y(p);
        ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR + 6, yy); ctx.stroke();
        ctx.fillText(fmtPrice(p), W - padR + 10, yy + 3);
      }
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
        const tx = x(s.t0);
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
      grad.addColorStop(0, "rgba(22, 163, 74, 0.20)");
      grad.addColorStop(1, "rgba(22, 163, 74, 0.01)");
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
      ctx.strokeStyle = "#16a34a";
      ctx.lineWidth = 1.75;
      ctx.lineJoin = "round";
      ctx.stroke();

      // out-of-stock overlay
      ctx.strokeStyle = "#dc2626";
      ctx.lineWidth = 1.75;
      for (const s of segs) {
        if (!s.inStock) {
          ctx.beginPath();
          ctx.moveTo(x(s.t0), y(s.price));
          ctx.lineTo(x(s.t1), y(s.price));
          ctx.stroke();
        }
      }

      // open-box series (Keepa-style second line; gaps where none was seen)
      ctx.strokeStyle = "#d97706";
      ctx.lineWidth = 1.5;
      for (let i = 0; i < segs.length; i++) {
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
      }
      ctx.restore(); // end sweep clip

      // typical-price dotted line (only once it separates visually from LOW)
      if (Math.abs(y(typical) - y(lowest)) > 9) {
        ctx.setLineDash([2, 5]);
        ctx.strokeStyle = pal.typicalLine;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, y(typical)); ctx.lineTo(W - padR + 6, y(typical)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = pal.typicalText;
        ctx.font = "600 9px system-ui, sans-serif";
        ctx.fillText("TYPICAL " + fmtPrice(typical), padL + 2, y(typical) - 4);
      }

      // all-time-low dotted annotation
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = "rgba(22, 163, 74, 0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y(lowest)); ctx.lineTo(W - padR + 6, y(lowest)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#0e7a37";
      ctx.font = "600 9px system-ui, sans-serif";
      ctx.fillText("LOW " + fmtPrice(lowest), padL + 2, y(lowest) - 4);

      // live price marker: DOM dot (CSS pulse) pinned to the line's end
      const lineEnd = { x: x(t1), y: y(segs[segs.length - 1].price) };
      liveDot.style.opacity = drawProgress >= 1 ? "1" : "0";
      liveDot.style.transform = `translate(${lineEnd.x - 4}px, ${lineEnd.y - 4}px)`;

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
        ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, H - padB); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = pal.crossDot; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = pal.crossRing; ctx.stroke();

        tooltip.style.opacity = "1";
        tooltip.textContent = "";
        const priceEl = document.createElement("div");
        priceEl.className = "jd-tt-price";
        priceEl.textContent = fmtPrice(seg.price);
        tooltip.append(priceEl);
        if (seg.openBox != null) {
          const obEl = document.createElement("div");
          obEl.className = "jd-tt-ob";
          obEl.textContent = "Open-box " + fmtPrice(seg.openBox);
          tooltip.append(obEl);
        }
        const dateEl = document.createElement("div");
        dateEl.className = "jd-tt-date";
        dateEl.textContent = fmtDateFull(t) + (seg.inStock ? "" : " · out of stock");
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
    return root;
  }

  window.__jackdawChart = { build, typicalPrice };
})();
