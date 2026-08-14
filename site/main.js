// jackdaws.app — hero choreography, chart drawing, scroll reveals.
(() => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── Demo series: the shape of a real tracked part ──
  const SERIES = [124.99, 124.99, 119.99, 119.99, 114.99, 109.99, 109.99, 114.99, 109.99, 104.99, 104.99, 99.99, 99.99, 94.99];
  const OPEN_BOX = [null, null, null, 89.99, 89.99, null, null, null, 79.99, 79.99, null, 74.99, 74.99, 72.99];

  // ── Step chart, drawn progressively (the seed becomes the line) ──
  function drawChart(canvas, opts) {
    const { progress = 1, openBox = false, height = 180 } = opts || {};
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 480;
    canvas.width = w * dpr;
    canvas.height = height * dpr;
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);

    const padL = 6, padR = 46, padT = 12, padB = 20;
    const vals = SERIES.concat(openBox ? OPEN_BOX.filter((v) => v != null) : []);
    const lo = Math.min.apply(null, vals) - 6;
    const hi = Math.max.apply(null, vals) + 6;
    const X = (i) => padL + (i / (SERIES.length - 1)) * (w - padL - padR);
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (height - padT - padB);

    // gridlines + right axis
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.strokeStyle = "rgba(120,130,145,0.16)";
    ctx.fillStyle = "#9aa1ab";
    for (let g = 0; g <= 3; g++) {
      const v = lo + ((hi - lo) * g) / 3;
      const y = Y(v);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR + 4, y); ctx.stroke();
      ctx.fillText("$" + v.toFixed(0), w - padR + 8, y + 3);
    }

    const cut = padL + progress * (w - padL - padR + 4);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cut, height);
    ctx.clip();

    // area
    const grad = ctx.createLinearGradient(0, padT, 0, height - padB);
    grad.addColorStop(0, "rgba(22,163,74,0.20)");
    grad.addColorStop(1, "rgba(22,163,74,0.01)");
    ctx.beginPath();
    ctx.moveTo(X(0), Y(SERIES[0]));
    for (let i = 1; i < SERIES.length; i++) { ctx.lineTo(X(i), Y(SERIES[i - 1])); ctx.lineTo(X(i), Y(SERIES[i])); }
    ctx.lineTo(X(SERIES.length - 1), height - padB);
    ctx.lineTo(X(0), height - padB);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // step line
    ctx.beginPath();
    ctx.moveTo(X(0), Y(SERIES[0]));
    for (let i = 1; i < SERIES.length; i++) { ctx.lineTo(X(i), Y(SERIES[i - 1])); ctx.lineTo(X(i), Y(SERIES[i])); }
    ctx.strokeStyle = "#16a34a";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();

    // open-box series
    if (openBox) {
      ctx.strokeStyle = "#d97706";
      ctx.lineWidth = 1.6;
      for (let i = 1; i < OPEN_BOX.length; i++) {
        if (OPEN_BOX[i] == null || OPEN_BOX[i - 1] == null) continue;
        ctx.beginPath();
        ctx.moveTo(X(i - 1), Y(OPEN_BOX[i - 1]));
        ctx.lineTo(X(i), Y(OPEN_BOX[i]));
        ctx.stroke();
      }
    }
    ctx.restore();

    // all-time-low marker, once the line has arrived
    if (progress > 0.97) {
      const last = SERIES.length - 1;
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = "rgba(22,163,74,0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, Y(SERIES[last])); ctx.lineTo(w - padR + 4, Y(SERIES[last])); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(X(last), Y(SERIES[last]), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = "#16a34a"; ctx.fill();
      ctx.beginPath(); ctx.arc(X(last), Y(SERIES[last]), 7, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(22,163,74,0.18)"; ctx.fill();
    }
  }

  // ── Hero: bird flies → becomes seed → seed becomes panel → line draws ──
  const stage = document.getElementById("stage");
  const chart = document.getElementById("chart");

  function runHero() {
    if (reduce) {
      stage.classList.add("play");
      drawChart(chart, { progress: 1 });
      return;
    }
    stage.classList.add("play");
    // the line draws as the panel finishes opening — the seed's momentum
    // carried into the data itself
    const start = performance.now() + 3600;
    const dur = 1500;
    const tick = (now) => {
      const t = Math.min(Math.max((now - start) / dur, 0), 1);
      drawChart(chart, { progress: 1 - Math.pow(1 - t, 3) });
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  if (stage && chart) {
    if (document.readyState === "complete") runHero();
    else window.addEventListener("load", runHero);
  }

  // ── Feature chart (draws when scrolled into view) ──
  const fchart = document.getElementById("fchart");
  let fdrawn = false;
  function drawFeature() {
    if (!fchart) return;
    // if the tab is hidden the animation frames won't run — draw it whole
    if (reduce || document.hidden) return drawChart(fchart, { progress: 1, openBox: true, height: 190 });
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min((now - start) / 1400, 1);
      drawChart(fchart, { progress: 1 - Math.pow(1 - t, 3), openBox: true, height: 190 });
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // Canvases lose their drawing when the layout changes, and RAF is frozen
  // while a tab is hidden — redraw both on resize and on becoming visible.
  const redrawAll = () => {
    if (chart) drawChart(chart, { progress: 1 });
    if (fchart && fdrawn) drawChart(fchart, { progress: 1, openBox: true, height: 190 });
  };
  window.addEventListener("resize", redrawAll);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) redrawAll();
  });

  // ── Scroll reveals ──
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        if (e.target.querySelector("#fchart") && !fdrawn) { fdrawn = true; drawFeature(); }
        io.unobserve(e.target);
      }
    },
    { threshold: 0.25 },
  );
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

  // ── Nav hairline on scroll ──
  const nav = document.querySelector(".nav");
  const onScroll = () => nav.classList.toggle("stuck", window.scrollY > 8);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  // ── Install CTA (Web Store listing pending) ──
  const installBtn = document.getElementById("installBtn");
  if (installBtn) {
    installBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const label = installBtn.querySelector("span");
      const original = label.textContent;
      label.textContent = "Coming to the Web Store";
      setTimeout(() => { label.textContent = original; }, 2200);
    });
  }
})();
