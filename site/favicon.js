// Animated favicon. Chrome doesn't animate SVG favicons, so we draw frames
// to a canvas and swap the icon href. The loop is the project's transformation
// language at 16px: the bird collapses into a dot, the dot stretches into a
// price line that draws itself, then it all folds back into the bird.
(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const SIZE = 64;
  const INK = "#16233a";
  const PAPER = "#fcfbf9";
  const GREEN = "#16a34a";

  // Overhead jackdaw silhouette (same artwork as the extension), viewBox 8 2 76 96
  const BIRD = [
    "M55 46.2 Q51 38 47.5 30.5 Q44.5 23.5 40.5 15.5 L38.6 21.5 L35.2 17.5 L34.6 24 L31.6 21.5 L32 28 L29.5 26.5 Q32.5 34 36 40.5 Q38.5 44.6 40 47.8 Z",
    "M55 53.8 Q51 62 47.5 69.5 Q44.5 76.5 40.5 84.5 L38.6 78.5 L35.2 82.5 L34.6 76 L31.6 78.5 L32 72 L29.5 73.5 Q32.5 66 36 59.5 Q38.5 55.4 40 52.2 Z",
    "M31.5 47.6 L20 42.5 L21.8 45.8 L17.5 44.8 L19.6 48 L16.8 50 L19.6 52 L17.5 55.2 L21.8 54.2 L20 57.5 L31.5 52.4 Q30.6 50 31.5 47.6 Z",
    "M31 49.9 Q34 47.6 41 46.6 Q50 45.4 57 46.6 Q62.5 47.4 66.5 48.7 L74 49.9 L66.5 51.2 Q62.5 52.6 57 53.4 Q50 54.6 41 53.4 Q34 52.4 31 50.1 Z",
  ];
  let birdPath = null;
  try {
    birdPath = new Path2D();
    BIRD.forEach((d) => birdPath.addPath(new Path2D(d)));
  } catch {
    return; // Path2D.addPath unsupported — keep the static icon
  }

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d");

  // Chrome picks the "best" declared icon and prefers SVG, so a leftover
  // static <link rel=icon> silently wins over the animated one. Take over
  // completely: drop every existing icon link first.
  document
    .querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]')
    .forEach((l) => l.remove());

  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/png";
  link.sizes = "any";
  document.head.appendChild(link);

  // The price series the line draws — a fall to an all-time low.
  const SERIES = [0.18, 0.18, 0.34, 0.34, 0.52, 0.46, 0.62, 0.62, 0.8];
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  function tile() {
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = INK;
    const r = 14;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(SIZE, 0, SIZE, SIZE, r);
    ctx.arcTo(SIZE, SIZE, 0, SIZE, r);
    ctx.arcTo(0, SIZE, 0, 0, r);
    ctx.arcTo(0, 0, SIZE, 0, r);
    ctx.closePath();
    ctx.fill();
  }

  function drawBird(scale, alpha) {
    if (alpha <= 0.01 || scale <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(SIZE / 2, SIZE / 2);
    ctx.scale(scale * 0.58, scale * 0.58);
    ctx.translate(-46, -50); // centre of the bird's viewBox
    ctx.fillStyle = PAPER;
    ctx.fill(birdPath);
    ctx.restore();
  }

  function drawDot(scaleX, scaleY, alpha) {
    if (alpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(SIZE / 2, SIZE / 2);
    ctx.scale(scaleX, scaleY);
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0, Math.PI * 2);
    ctx.fillStyle = GREEN;
    ctx.fill();
    ctx.restore();
  }

  // step line, drawn to `progress` (0..1)
  function drawLine(progress, alpha) {
    if (alpha <= 0.01 || progress <= 0) return;
    const padX = 10, top = 16, bottom = 48;
    const X = (i) => padX + (i / (SERIES.length - 1)) * (SIZE - padX * 2);
    const Y = (v) => top + v * (bottom - top);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.rect(0, 0, padX + progress * (SIZE - padX * 2) + 1, SIZE);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(X(0), Y(SERIES[0]));
    for (let i = 1; i < SERIES.length; i++) {
      ctx.lineTo(X(i), Y(SERIES[i - 1]));
      ctx.lineTo(X(i), Y(SERIES[i]));
    }
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 6;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.restore();
    // the live end point
    if (progress > 0.98) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(X(SERIES.length - 1), Y(SERIES[SERIES.length - 1]), 5, 0, Math.PI * 2);
      ctx.fillStyle = PAPER;
      ctx.fill();
      ctx.restore();
    }
  }

  // ── Timeline (ms), looping continuously ──
  const T = {
    birdHold: 900,    // bird visible at the top of each cycle
    collapse: 1160,   // bird -> dot
    settle: 1320,     // dot impact
    stretch: 1520,    // dot -> line start
    draw: 2400,       // line draws across
    hold: 3000,       // chart holds
    fold: 3350,       // line -> dot
    bloom: 3700,      // dot -> bird
    end: 4200,        // brief rest, then the cycle repeats
  };

  function frame(t) {
    tile();
    if (t < T.birdHold) {
      drawBird(1, 1);
    } else if (t < T.collapse) {
      drawBird(1, 1);
    } else if (t < T.settle) {
      const k = easeOut((t - T.collapse) / (T.settle - T.collapse));
      drawBird(1 - k, 1 - k);
      drawDot(0.3 + k * 0.8, 0.3 + k * 0.6, k);
    } else if (t < T.stretch) {
      const k = (t - T.settle) / (T.stretch - T.settle);
      drawDot(1.1 - k * 0.2, 1.1 - k * 0.5, 1); // squash toward a line
    } else if (t < T.draw) {
      const k = easeOut((t - T.stretch) / (T.draw - T.stretch));
      drawDot(0.9 * (1 - k), 0.6 * (1 - k), 1 - k);
      drawLine(k, 1);
    } else if (t < T.hold) {
      drawLine(1, 1);
    } else if (t < T.fold) {
      const k = easeOut((t - T.hold) / (T.fold - T.hold));
      drawLine(1, 1 - k);
      drawDot(0.4 + k * 0.6, 0.3 + k * 0.7, k);
    } else if (t < T.bloom) {
      const k = easeOut((t - T.fold) / (T.bloom - T.fold));
      drawDot(1 - k, 1 - k, 1 - k);
      drawBird(0.3 + k * 0.7, k);
    } else {
      drawBird(1, 1);
    }
    link.href = canvas.toDataURL("image/png");
  }

  // The cycle runs on wall-clock time, so it stays coherent no matter which
  // clock is driving it. While the tab is visible we use rAF (smooth, capped
  // at ~12fps — plenty for a 16px icon). While it's hidden, browsers freeze
  // rAF and throttle timers to about 1/second, so we fall back to an interval:
  // the animation keeps going in a background tab, just at a coarser step.
  const started = Date.now();
  const at = () => (Date.now() - started) % T.end;

  let raf = 0;
  let timer = 0;
  let lastPaint = 0;

  function paint() {
    frame(at());
  }

  function rafLoop(now) {
    if (now - lastPaint > 80) {
      lastPaint = now;
      paint();
    }
    raf = requestAnimationFrame(rafLoop);
  }

  function useRaf() {
    clearInterval(timer);
    timer = 0;
    if (!raf) raf = requestAnimationFrame(rafLoop);
  }

  function useTimer() {
    cancelAnimationFrame(raf);
    raf = 0;
    if (!timer) timer = setInterval(paint, 400); // browsers clamp this to ~1s when hidden
  }

  paint();
  if (document.hidden) useTimer();
  else useRaf();

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) useTimer();
    else useRaf();
  });
})();
