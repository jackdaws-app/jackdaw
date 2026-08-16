// jackdaws.app — hero choreography, charts, reveals.
//
// THE HERO'S ONE IDEA. The chart line is a wire and every price point is a
// sighting that flies in and lands on it. Each mark is a bird while it travels
// and a data point once it settles — one thing becoming another, which is the
// house animation rule (CONVENTIONS.md). The line only exists between points
// that have already landed, so the record assembles rather than draws on.
//
// Nothing here is decorative in the sense that matters: the fourteen marks are
// fourteen readings, the last one to land is the all-time low, and the counter
// in the caption counts the same fourteen.
(() => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── The demo series: the shape of a real tracked part ────────────────────
  const SERIES = [
    124.99, 124.99, 119.99, 119.99, 114.99, 109.99, 109.99,
    114.99, 109.99, 104.99, 104.99, 99.99, 99.99, 94.99,
  ];
  const OPEN_BOX = [
    null, null, null, 89.99, 89.99, null, null,
    null, 79.99, 79.99, null, 74.99, 74.99, 72.99,
  ];
  const TYPICAL = 109.99;

  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

  // ── Chart geometry, shared by the hero and the feature chart ─────────────
  function geometry(canvas, height, withOpenBox) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 480;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);

    const padL = 4, padT = 14, padB = 18;
    // The right gutter is derived from the widest label that will actually be
    // drawn, not hard-coded — a fixed gutter is what silently clipped the cents
    // off every four-figure price in the extension's chart for the life of the
    // file (CONVENTIONS.md).
    const vals = SERIES.concat(withOpenBox ? OPEN_BOX.filter((v) => v != null) : []);
    const lo = Math.min.apply(null, vals) - 7;
    const hi = Math.max.apply(null, vals) + 7;
    const ticks = [];
    for (let g = 0; g <= 3; g++) ticks.push("$" + Math.round(lo + ((hi - lo) * g) / 3));
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    const padR = Math.ceil(Math.max.apply(null, ticks.map((s) => ctx.measureText(s).width))) + 14;

    return {
      ctx, w, height, padL, padR, padT, padB, lo, hi, ticks,
      X: (i) => padL + (i / (SERIES.length - 1)) * (w - padL - padR),
      Y: (v) => padT + (1 - (v - lo) / (hi - lo)) * (height - padT - padB),
    };
  }

  function drawFrame(g) {
    const { ctx, w, padL, padR, lo, hi, ticks, Y } = g;
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    for (let i = 0; i < ticks.length; i++) {
      const y = Y(lo + ((hi - lo) * i) / 3);
      ctx.strokeStyle = "rgba(120,130,145,0.14)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(y) + 0.5);
      ctx.lineTo(w - padR + 4, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = "#9aa1ab";
      ctx.fillText(ticks[i], w - padR + 9, y);
    }
  }

  // The step path through the first `n` points, optionally cut part-way to the
  // next one so the line reaches toward a bird still in the air.
  function stepPath(g, n, partial) {
    const { ctx, X, Y } = g;
    ctx.beginPath();
    ctx.moveTo(X(0), Y(SERIES[0]));
    for (let i = 1; i < n; i++) {
      ctx.lineTo(X(i), Y(SERIES[i - 1]));
      ctx.lineTo(X(i), Y(SERIES[i]));
    }
    if (partial > 0 && n < SERIES.length) {
      const x = X(n - 1) + (X(n) - X(n - 1)) * partial;
      ctx.lineTo(x, Y(SERIES[n - 1]));
    }
  }

  // A sighting in flight: a pair of wing strokes while it travels, a filled dot
  // once it lands. `life` runs 0 to 1 and is the whole state — the wingbeat, the
  // fade-in and the shrink toward the wire all read off it, so the bird cannot
  // get out of step with its own arrival.
  function drawSighting(ctx, x, y, angle, life) {
    ctx.save();
    ctx.translate(x, y);
    if (life < 1) {
      // In the air: two short strokes, rotated along the flight path, opening
      // and closing. Size falls as it nears the wire — the bird resolving into
      // the point it is about to become.
      const beat = Math.sin(life * Math.PI * 9);
      const s = 1 - life * 0.45;
      ctx.rotate(angle);
      ctx.globalAlpha = Math.min(1, life * 6);
      ctx.strokeStyle = "#16233a";
      ctx.lineWidth = 1.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-4.5 * s, -beat * 2.6 * s);
      ctx.lineTo(0, 0);
      ctx.lineTo(4.5 * s, -beat * 2.6 * s);
      ctx.stroke();
    } else {
      ctx.fillStyle = "#16a34a";
      ctx.beginPath();
      ctx.arc(0, 0, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ── Hero chart ───────────────────────────────────────────────────────────
  const stage = document.getElementById("stage");
  const chart = document.getElementById("chart");
  const counter = document.getElementById("sightCount");

  const FLIGHT = 780;   // how long one sighting is in the air
  const STAGGER = 92;   // between departures
  const HERO_H = 168;

  function heroFlight(canvas, elapsed) {
    const g = geometry(canvas, HERO_H, false);
    const { ctx, w, X, Y, padB, height } = g;
    drawFrame(g);

    // How far each sighting has come.
    const lives = SERIES.map((_v, i) => clamp01((elapsed - i * STAGGER) / FLIGHT));
    let landed = 0;
    while (landed < lives.length && lives[landed] >= 1) landed++;
    const partial = landed < lives.length ? easeOut(lives[landed]) : 0;

    // The wire, only as far as the record actually reaches.
    if (landed >= 1) {
      ctx.save();
      stepPath(g, landed, partial);
      ctx.lineTo(X(Math.max(0, landed - 1)) + (X(landed) - X(landed - 1)) * partial, height - padB);
      ctx.lineTo(X(0), height - padB);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, g.padT, 0, height - padB);
      grad.addColorStop(0, "rgba(22,163,74,0.18)");
      grad.addColorStop(1, "rgba(22,163,74,0.01)");
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();

      stepPath(g, landed, partial);
      ctx.strokeStyle = "#16a34a";
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    }

    // The marks themselves.
    for (let i = 0; i < SERIES.length; i++) {
      const life = lives[i];
      if (life <= 0) continue;
      const tx = X(i), ty = Y(SERIES[i]);
      if (life >= 1) {
        // Landed points stay as quiet dots; only the low keeps a halo.
        if (i === SERIES.length - 1) {
          ctx.beginPath();
          ctx.arc(tx, ty, 7, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(22,163,74,0.16)";
          ctx.fill();
        }
        drawSighting(ctx, tx, ty, 0, 1);
      } else {
        // Comes in from the upper left, on a shallow path — the flat cruise the
        // nav bird uses, for the same reason: a steep swoop reads as a missile.
        const e = easeOut(life);
        const fromX = tx - 150 - i * 6;
        const fromY = ty - 74 - (i % 3) * 15;
        const x = fromX + (tx - fromX) * e;
        const y = fromY + (ty - fromY) * (e * e * 0.35 + e * 0.65);
        drawSighting(ctx, x, y, Math.atan2(ty - fromY, tx - fromX) * (1 - e) * 0.8, life);
      }
    }

    // The all-time-low rule, once the last sighting is down.
    if (landed >= SERIES.length) {
      const y = Y(SERIES[SERIES.length - 1]);
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = "rgba(22,163,74,0.45)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(g.padL, y);
      ctx.lineTo(w - g.padR + 4, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (counter) counter.textContent = String(landed);
    return landed >= SERIES.length;
  }

  function heroStatic(canvas) {
    heroFlight(canvas, 1e6);
  }

  function runHero() {
    if (!stage || !chart) return;
    stage.classList.add("play");
    // rAF is frozen in a background tab, so an animation started there would
    // never advance and the panel would sit empty until the tab was fronted.
    if (reduce || document.hidden) {
      heroStatic(chart);
      return;
    }
    const begin = performance.now() + 620; // let the panel finish opening first
    const tick = (now) => {
      const done = heroFlight(chart, now - begin);
      if (!done) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ── Feature chart: the finished article, with the open-box line ──────────
  const fchart = document.getElementById("fchart");
  let fdrawn = false;

  function drawFeature(canvas, progress) {
    const g = geometry(canvas, 200, true);
    const { ctx, w, X, Y, padL, padR, padT, padB, height } = g;
    drawFrame(g);

    const cut = padL + progress * (w - padL - padR + 4);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cut, height);
    ctx.clip();

    // typical band
    ctx.strokeStyle = "rgba(203,208,216,0.95)";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, Y(TYPICAL));
    ctx.lineTo(w - padR + 4, Y(TYPICAL));
    ctx.stroke();
    ctx.setLineDash([]);

    stepPath(g, SERIES.length, 0);
    ctx.lineTo(X(SERIES.length - 1), height - padB);
    ctx.lineTo(X(0), height - padB);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, height - padB);
    grad.addColorStop(0, "rgba(22,163,74,0.18)");
    grad.addColorStop(1, "rgba(22,163,74,0.01)");
    ctx.fillStyle = grad;
    ctx.fill();

    stepPath(g, SERIES.length, 0);
    ctx.strokeStyle = "#16a34a";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();

    ctx.strokeStyle = "#d97706";
    ctx.lineWidth = 1.7;
    ctx.lineCap = "round";
    for (let i = 1; i < OPEN_BOX.length; i++) {
      if (OPEN_BOX[i] == null || OPEN_BOX[i - 1] == null) continue;
      ctx.beginPath();
      ctx.moveTo(X(i - 1), Y(OPEN_BOX[i - 1]));
      ctx.lineTo(X(i), Y(OPEN_BOX[i]));
      ctx.stroke();
    }
    for (let i = 0; i < OPEN_BOX.length; i++) {
      if (OPEN_BOX[i] == null) continue;
      ctx.beginPath();
      ctx.arc(X(i), Y(OPEN_BOX[i]), 2, 0, Math.PI * 2);
      ctx.fillStyle = "#d97706";
      ctx.fill();
    }
    ctx.restore();

    if (progress > 0.98) {
      const last = SERIES.length - 1;
      ctx.beginPath();
      ctx.arc(X(last), Y(SERIES[last]), 7, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(22,163,74,0.16)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(X(last), Y(SERIES[last]), 2.6, 0, Math.PI * 2);
      ctx.fillStyle = "#16a34a";
      ctx.fill();
    }
  }

  function runFeature() {
    if (!fchart) return;
    if (reduce || document.hidden) return drawFeature(fchart, 1);
    const start = performance.now();
    const tick = (now) => {
      const t = clamp01((now - start) / 1300);
      drawFeature(fchart, easeOut(t));
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ── The closing wire: the same idea, settled ─────────────────────────────
  // A flock at rest on a line across the dark band. It breathes very slightly
  // and never resolves into anything — the hero's image after the fact.
  const ctaWire = document.getElementById("ctaWire");
  function drawWire(t) {
    if (!ctaWire) return;
    const dpr = window.devicePixelRatio || 1;
    const w = ctaWire.clientWidth || 800;
    const h = ctaWire.clientHeight || 300;
    if (!w || !h) return;
    ctaWire.width = Math.round(w * dpr);
    ctaWire.height = Math.round(h * dpr);
    const ctx = ctaWire.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Low in the band, clear of the headline and the button. Crossing the copy
    // made it read as a stray rule rather than as a wire with weight on it.
    const y = h * 0.82;
    const sag = Math.min(22, h * 0.05);
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y - sag);
    ctx.quadraticCurveTo(w / 2, y + sag, w, y - sag);
    ctx.stroke();

    // Positions are deterministic, not random: a layout that reshuffles on
    // every resize reads as noise rather than as a place. Spacing is uneven on
    // purpose — birds bunch and leave gaps, and a perfectly even row reads as a
    // dotted border.
    const n = 26;
    for (let i = 0; i < n; i++) {
      const jitter = Math.sin(i * 12.9898) * 0.5;
      const p = (i + 0.5 + jitter) / n;
      const bx = p * w;
      const by = (1 - p) * (1 - p) * (y - sag) + 2 * (1 - p) * p * (y + sag) + p * p * (y - sag);
      // Each sits at its own height above the wire and breathes on its own
      // phase, so the row has depth instead of reading as one object.
      const bob = Math.sin(t / 1600 + i * 1.7) * 1.1;
      const size = 1.7 + Math.abs(Math.sin(i * 3.7)) * 1.1;
      ctx.globalAlpha = 0.3 + 0.45 * Math.abs(Math.sin(i * 2.3));
      ctx.fillStyle = "#86efac";
      ctx.beginPath();
      ctx.arc(bx, by - 3.5 + bob, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  let wireRaf = 0;
  function startWire() {
    if (!ctaWire) return;
    if (reduce) return drawWire(0);
    const loop = (now) => {
      drawWire(now);
      wireRaf = requestAnimationFrame(loop);
    };
    wireRaf = requestAnimationFrame(loop);
  }
  function stopWire() {
    if (wireRaf) cancelAnimationFrame(wireRaf);
    wireRaf = 0;
  }

  // ── Reveals ──────────────────────────────────────────────────────────────
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        // The alert meters fill on reveal; the width lives in the markup so the
        // reduced-motion rule can pin it without JS.
        e.target.querySelectorAll("[data-meter]").forEach((el) => {
          el.style.width = el.getAttribute("data-meter") + "%";
        });
        if (e.target.querySelector("#fchart") && !fdrawn) { fdrawn = true; runFeature(); }
        io.unobserve(e.target);
      }
    },
    { threshold: 0.2, rootMargin: "0px 0px -8% 0px" },
  );
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

  // The closing wire only runs while it is on screen — an animation nobody can
  // see is a battery cost with no upside.
  if (ctaWire) {
    new IntersectionObserver((entries) => {
      for (const e of entries) (e.isIntersecting ? startWire : stopWire)();
    }, { threshold: 0 }).observe(ctaWire);
  }

  // ── Canvas upkeep ────────────────────────────────────────────────────────
  // A canvas loses its contents when the backing store is resized, and rAF is
  // frozen while a tab is hidden — so redraw whole on both, rather than trying
  // to resume an animation that never ran.
  let resizeTimer = 0;
  const redrawAll = () => {
    if (chart) heroStatic(chart);
    if (fchart && fdrawn) drawFeature(fchart, 1);
    if (ctaWire && !wireRaf) drawWire(0);
  };
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redrawAll, 120);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) redrawAll();
  });

  // ── Nav hairline ─────────────────────────────────────────────────────────
  const nav = document.getElementById("nav");
  if (nav) {
    const onScroll = () => nav.classList.toggle("stuck", window.scrollY > 10);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  // ── Install CTA (Web Store listing pending) ──────────────────────────────
  const installBtn = document.getElementById("installBtn");
  if (installBtn) {
    installBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const label = installBtn.querySelector("span");
      if (label.dataset.busy) return;
      const original = label.textContent;
      label.dataset.busy = "1";
      label.textContent = "Coming to the Web Store";
      setTimeout(() => {
        label.textContent = original;
        delete label.dataset.busy;
      }, 2200);
    });
  }

  // ── Go ───────────────────────────────────────────────────────────────────
  if (document.readyState === "complete") runHero();
  else window.addEventListener("load", runHero);
})();
