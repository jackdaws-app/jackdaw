// Interactive price-history chart: range filtering, crosshair + tooltip,
// all-time-low annotation. Canvas-based, no dependencies.
// Exposed as window.__jackdawChart for content.js (both run in the isolated world).
(() => {
  const RANGES = [
    { key: "1M", ms: 30 * 86400000 },
    { key: "3M", ms: 91 * 86400000 },
    { key: "6M", ms: 182 * 86400000 },
    { key: "1Y", ms: 365 * 86400000 },
    { key: "All", ms: Infinity },
  ];

  function fmtPrice(p) {
    return "$" + p.toFixed(2);
  }
  function fmtDate(ms) {
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function fmtDateFull(ms) {
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function build(points, opts = {}) {
    const root = document.createElement("div");
    root.className = "jd-chart" + (opts.reveal ? " mk-chart-reveal" : "");

    const toolbar = document.createElement("div");
    toolbar.className = "jd-chart-toolbar";
    const rangeWrap = document.createElement("div");
    rangeWrap.className = "jd-ranges";
    toolbar.append(rangeWrap);

    const stage = document.createElement("div");
    stage.className = "jd-chart-stage";
    const canvas = document.createElement("canvas");
    const tooltip = document.createElement("div");
    tooltip.className = "jd-tooltip";
    stage.append(canvas, tooltip);
    root.append(toolbar, stage);

    const all = points
      .slice()
      .sort((a, b) => a.firstSeenAt - b.firstSeenAt)
      .map((p) => ({ t0: p.firstSeenAt, t1: Math.max(p.lastSeenAt, p.firstSeenAt), price: p.price, inStock: p.inStock }));
    if (all.length) all[all.length - 1].t1 = Math.max(all[all.length - 1].t1, Date.now());

    const spanAll = all.length ? all[all.length - 1].t1 - all[0].t0 : 0;
    let range = RANGES.find((r) => r.ms >= spanAll) || RANGES[RANGES.length - 1];
    let hover = null; // {x time}

    // Only offer ranges the data can fill (plus the first that covers it all).
    const usable = RANGES.filter((_, i) => i === 0 || RANGES[i - 1].ms < spanAll);
    const btns = new Map();
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

    function visibleSegs() {
      if (!all.length) return [];
      const end = all[all.length - 1].t1;
      const start = range.ms === Infinity ? all[0].t0 : end - range.ms;
      return all
        .filter((s) => s.t1 >= start)
        .map((s) => ({ ...s, t0: Math.max(s.t0, start) }));
    }

    let geom = null; // set per draw

    function draw() {
      const segs = visibleSegs();
      if (!segs.length) return;
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
      let pMin = Infinity, pMax = -Infinity, minAt = 0;
      for (const s of segs) {
        if (s.price < pMin) { pMin = s.price; minAt = s.t0; }
        if (s.price > pMax) pMax = s.price;
      }
      const lowest = pMin;
      const pad = Math.max((pMax - pMin) * 0.18, pMax * 0.03, 1);
      const yMin = pMin - pad, yMax = pMax + pad;

      const x = (t) => padL + ((t - t0) / span) * (W - padL - padR);
      const y = (p) => padT + (1 - (p - yMin) / (yMax - yMin)) * (H - padT - padB);
      geom = { x, y, t0, t1, W, H, padL, padR, padT, padB, segs, lowest, minAt };

      ctx.clearRect(0, 0, W, H);

      // gridlines + right-side labels (brokerage style)
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.strokeStyle = "rgba(120, 130, 145, 0.14)";
      ctx.fillStyle = "#8a92a0";
      for (let i = 0; i <= 3; i++) {
        const p = yMin + ((yMax - yMin) * i) / 3;
        const yy = y(p);
        ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR + 6, yy); ctx.stroke();
        ctx.fillText(fmtPrice(p), W - padR + 10, yy + 3);
      }
      ctx.fillText(fmtDate(t0), padL, H - 8);
      const ll = fmtDate(t1);
      ctx.fillText(ll, W - padR - ctx.measureText(ll).width, H - 8);

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
      const lineEnd = { x: x(t1), y: y(segs[segs.length - 1].price) };
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

      // all-time-low dotted annotation
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = "rgba(22, 163, 74, 0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y(lowest));
      ctx.lineTo(W - padR + 6, y(lowest));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#0e7a37";
      ctx.font = "600 9px system-ui, sans-serif";
      ctx.fillText("LOW " + fmtPrice(lowest), padL + 2, y(lowest) - 4);

      // live price dot
      ctx.beginPath();
      ctx.arc(lineEnd.x, lineEnd.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#16a34a";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(lineEnd.x, lineEnd.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(22, 163, 74, 0.2)";
      ctx.fill();

      // crosshair
      if (hover != null) {
        const t = hover;
        const seg = segs.find((s) => t >= s.t0 && t <= s.t1) ||
          segs.reduce((a, b) => (Math.abs(t - (a.t0 + a.t1) / 2) < Math.abs(t - (b.t0 + b.t1) / 2) ? a : b));
        const hx = Math.min(Math.max(x(t), x(seg.t0)), x(seg.t1));
        const hy = y(seg.price);
        ctx.strokeStyle = "rgba(22, 35, 58, 0.35)";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, H - padB); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = "#16233a"; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke();

        tooltip.style.opacity = "1";
        tooltip.innerHTML = "";
        const priceEl = document.createElement("div");
        priceEl.className = "jd-tt-price";
        priceEl.textContent = fmtPrice(seg.price);
        const dateEl = document.createElement("div");
        dateEl.className = "jd-tt-date";
        dateEl.textContent = fmtDateFull(t) + (seg.inStock ? "" : " · out of stock");
        if (!seg.inStock) dateEl.classList.add("jd-tt-oos");
        tooltip.append(priceEl, dateEl);
        const tw = tooltip.offsetWidth;
        const clamped = Math.min(Math.max(hx - tw / 2, 4), W - tw - 4);
        tooltip.style.transform = `translate(${clamped}px, 0)`;
      } else {
        tooltip.style.opacity = "0";
      }

      for (const [k, b] of btns) b.classList.toggle("jd-range-active", k === range.key);
    }

    function update() {
      requestAnimationFrame(draw);
    }

    stage.addEventListener("mousemove", (e) => {
      if (!geom) return;
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const frac = (px - geom.padL) / (geom.W - geom.padL - geom.padR);
      hover = geom.t0 + Math.min(Math.max(frac, 0), 1) * (geom.t1 - geom.t0);
      update();
    });
    stage.addEventListener("mouseleave", () => {
      hover = null;
      update();
    });

    update();
    return root;
  }

  window.__jackdawChart = { build };
})();
