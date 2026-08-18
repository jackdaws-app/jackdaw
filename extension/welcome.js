// The welcome page: opened once by the service worker on a fresh install.
// Its one job with consequences is the consent card — the same jdCatalog key
// every other surface reads, written here with the same two answers.
//
// A welcome tab can outlive the extension that opened it (an update or a
// reload at chrome://extensions orphans it, same as a content script), so
// every chrome.* call is wrapped: a dead context degrades to a page that
// still reads fine, and a failed consent write says so instead of settling.
(() => {
  // Split the wordmark so the flight can deposit it a letter at a time.
  // Runs before first paint (script sits at the end of body); without JS the
  // whole-word fallback animation in welcome.css covers the page.
  const mark = document.querySelector(".wel-mark");
  if (mark) {
    const word = mark.textContent.trim();
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", word);
    mark.textContent = "";
    for (let i = 0; i < word.length; i++) {
      const letter = document.createElement("i");
      letter.style.setProperty("--i", String(i));
      letter.textContent = word[i];
      mark.appendChild(letter);
    }
    mark.classList.add("split");
  }

  // ---------- The hero bird ----------
  // The arrival and the idle repertoire share one canvas mover, drawn frame
  // by frame the way the site hero draws its flock: the same four paths as
  // the static glyph, flown along the same authored flight paths the old
  // CSS mover rode, with a real three-phase wingbeat instead of two frozen
  // poses. JS still only ADDS classes to the DOM half (glyph, letters,
  // tree, perched bird) — their motion lives behind welcome.css's
  // reduced-motion gate, and the canvas engine checks the same query.
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const hero = document.querySelector(".wel-hero");
  const sky = document.querySelector(".wel-sky");
  const bird = document.querySelector(".wel-bird");
  const canvas = document.querySelector(".wel-canvas");
  if (!reduced.matches && hero && sky && bird && canvas && mark) {
    const wings = bird.querySelector("g");
    const perchBody = document.querySelector(".wel-perched-body");
    const letters = Array.from(mark.querySelectorAll("i"));

    // The glyph's own artwork as Path2D: head at +x, tail at -x, wings
    // +-y about the body line at y 50; registration centre (46, 50).
    const BIRD_PARTS = {
      wingUp: new Path2D("M55 46.2 Q51 38 47.5 30.5 Q44.5 23.5 40.5 15.5 L38.6 21.5 L35.2 17.5 L34.6 24 L31.6 21.5 L32 28 L29.5 26.5 Q32.5 34 36 40.5 Q38.5 44.6 40 47.8 Z"),
      wingDn: new Path2D("M55 53.8 Q51 62 47.5 69.5 Q44.5 76.5 40.5 84.5 L38.6 78.5 L35.2 82.5 L34.6 76 L31.6 78.5 L32 72 L29.5 73.5 Q32.5 66 36 59.5 Q38.5 55.4 40 52.2 Z"),
      tail: new Path2D("M31.5 47.6 L20 42.5 L21.8 45.8 L17.5 44.8 L19.6 48 L16.8 50 L19.6 52 L17.5 55.2 L21.8 54.2 L20 57.5 L31.5 52.4 Q30.6 50 31.5 47.6 Z"),
      body: new Path2D("M31 49.9 Q34 47.6 41 46.6 Q50 45.4 57 46.6 Q62.5 47.4 66.5 48.7 L74 49.9 L66.5 51.2 Q62.5 52.6 57 53.4 Q50 54.6 41 53.4 Q34 52.4 31 50.1 Z"),
    };

    // One bird, one frame. Wings first, under a vertical squash about the
    // body line — foreshortening, the way the site hero beats its wings —
    // then tail and body on top. The artwork is symmetric about the body
    // axis, so heading is pure rotation: no mirror, in any direction.
    function drawBird(g, x, y, ang, k, spread, alpha) {
      g.save();
      g.globalAlpha = alpha;
      g.translate(x, y);
      g.rotate(ang);
      g.scale(k, k);
      g.translate(-46, -50);
      g.save();
      g.translate(0, 50);
      g.scale(1, Math.max(spread, 0.05));
      g.translate(0, -50);
      g.fill(BIRD_PARTS.wingUp);
      g.fill(BIRD_PARTS.wingDn);
      g.restore();
      g.fill(BIRD_PARTS.tail);
      g.fill(BIRD_PARTS.body);
      g.restore();
    }

    // ---------- Path sampling ----------
    // CSS offset-distance progresses by arc length, so the port does too:
    // each authored "M … C …" path is sampled once into a cumulative-length
    // table, and pathAt inverts it. Heading comes from the derivative.
    const ARC_STEPS = 32;
    function cubicAt(s, t) {
      const u = 1 - t;
      return [
        u * u * u * s[0] + 3 * u * u * t * s[2] + 3 * u * t * t * s[4] + t * t * t * s[6],
        u * u * u * s[1] + 3 * u * u * t * s[3] + 3 * u * t * t * s[5] + t * t * t * s[7],
      ];
    }
    function cubicDeriv(s, t) {
      const u = 1 - t;
      return [
        3 * u * u * (s[2] - s[0]) + 6 * u * t * (s[4] - s[2]) + 3 * t * t * (s[6] - s[4]),
        3 * u * u * (s[3] - s[1]) + 6 * u * t * (s[5] - s[3]) + 3 * t * t * (s[7] - s[5]),
      ];
    }
    function measurePath(d) {
      const n = (d.match(/-?[\d.]+/g) || []).map(Number);
      const segs = [];
      let sx = n[0], sy = n[1];
      for (let i = 2; i + 5 < n.length; i += 6) {
        segs.push([sx, sy, n[i], n[i + 1], n[i + 2], n[i + 3], n[i + 4], n[i + 5]]);
        sx = n[i + 4];
        sy = n[i + 5];
      }
      const lens = [0];
      const samples = [];
      let total = 0;
      let px = segs[0][0], py = segs[0][1];
      for (const seg of segs) {
        for (let k = 1; k <= ARC_STEPS; k++) {
          const [x, y] = cubicAt(seg, k / ARC_STEPS);
          total += Math.hypot(x - px, y - py);
          lens.push(total);
          samples.push([seg, k / ARC_STEPS]);
          px = x;
          py = y;
        }
      }
      return { lens, samples, total };
    }
    function pathAt(path, f) {
      const target = Math.min(Math.max(f, 0), 1) * path.total;
      let lo = 0, hi = path.lens.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (path.lens[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      const i = Math.max(lo, 1);
      const [seg, t1] = path.samples[i - 1];
      const span = path.lens[i] - path.lens[i - 1] || 1;
      const t = t1 - 1 / ARC_STEPS + ((target - path.lens[i - 1]) / span) * (1 / ARC_STEPS);
      const [x, y] = cubicAt(seg, t);
      const [dx, dy] = cubicDeriv(seg, t);
      return { x, y, ang: Math.atan2(dy, dx) };
    }

    // ---------- Timing ----------
    // The CSS keyframes named an easing per bracket; the tables below keep
    // both the marks and the curves, so each stretch between two marks is
    // shaped exactly the way the @keyframes shaped it.
    function bezierEase(x1, y1, x2, y2) {
      const ax = 3 * x1 - 3 * x2 + 1, bx = 3 * x2 - 6 * x1, cx = 3 * x1;
      const ay = 3 * y1 - 3 * y2 + 1, by = 3 * y2 - 6 * y1, cy = 3 * y1;
      const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
      const sampleY = (t) => ((ay * t + by) * t + cy) * t;
      const slopeX = (t) => (3 * ax * t + 2 * bx) * t + cx;
      return (x) => {
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        let t = x;
        for (let i = 0; i < 5; i++) {
          const s = slopeX(t);
          if (Math.abs(s) < 1e-6) break;
          t -= (sampleX(t) - x) / s;
        }
        if (t < 0 || t > 1 || Math.abs(sampleX(t) - x) > 1e-4) {
          let lo = 0, hi = 1;
          t = x;
          for (let i = 0; i < 24; i++) {
            if (sampleX(t) < x) lo = t;
            else hi = t;
            t = (lo + hi) / 2;
          }
        }
        return sampleY(t);
      };
    }
    const LINEAR = (x) => x;
    const EASE_IN_OUT = bezierEase(0.42, 0, 0.58, 1);
    // marks: [progress, value, easing-to-next-mark] — @keyframes semantics.
    function profileAt(marks, p) {
      if (p <= marks[0][0]) return marks[0][1];
      const last = marks[marks.length - 1];
      if (p >= last[0]) return last[1];
      for (let i = 1; i < marks.length; i++) {
        if (p <= marks[i][0]) {
          const prev = marks[i - 1];
          const u = (p - prev[0]) / (marks[i][0] - prev[0]);
          return prev[1] + (prev[2] || LINEAR)(u) * (marks[i][1] - prev[1]);
        }
      }
      return last[1];
    }
    const smooth = (u) => {
      const c = Math.min(Math.max(u, 0), 1);
      return c * c * (3 - 2 * c);
    };

    const cbEntry = bezierEase(0.3, 0.4, 0.6, 1);
    const cbSettle = bezierEase(0.2, 0.6, 0.3, 1);
    const cbClimb = bezierEase(0.4, 0, 0.6, 1);
    const cbSweep = bezierEase(0.4, 0, 0.5, 1);
    const cbFlare = bezierEase(0.25, 0.6, 0.35, 1);
    const cbLaunch = bezierEase(0.4, 0.1, 0.7, 1);
    const cbHook = bezierEase(0.3, 0.3, 0.4, 1);

    const CIRCUIT_D = "M 236 48 C 290 33 350 15 404 22 C 448 28 462 62 436 88 C 420 100 380 102 330 101 C 260 100 160 100 96 98 C 56 96 30 84 34 58 C 38 34 90 26 140 32 C 180 36 212 42 236 48";

    // Each flight is the old CSS pair (fly + pose) as data: dist/alpha/size
    // carry the keyframe marks verbatim, path is the same authored path,
    // and the wingbeat fields are new — take (spread at launch), rampIn
    // (blend away from it), flare (brake to the glyph's own full spread),
    // level (blend heading to 0 at the end — the glyph flies level), glide
    // (a fixed-wing stretch mid-sweep), cue (where the old glyph-return
    // animation began; JS fires the .return swap there).
    const FLIGHTS = {
      arrive: {
        path: measurePath("M -640 -30 C -430 4 -250 92 -30 112 C 40 119 120 121 200 118 C 260 116 330 108 396 86 C 452 68 476 30 448 -6 C 420 -18 330 -26 240 -24 C 180 -23 120 -18 92 -8 C 76 18 120 44 176 48 C 200 50 220 50 236 48"),
        dur: 2.6, delay: 0.2,
        dist: [[0, 0, cbEntry], [0.3, 0.39, LINEAR], [0.62, 0.64, EASE_IN_OUT], [0.7, 0.69, LINEAR], [0.84, 0.88, cbSettle], [1, 1]],
        alpha: [[0, 0], [0.06, 1], [0.92, 1], [1, 0]],
        size: [[0, 0.58], [0.3, 0.8], [0.61, 0.88], [0.67, 0.9], [0.82, 0.94], [0.92, 0.97], [1, 1]],
        take: null, rampIn: 0, flare: 0.88, level: 0.9,
      },
      circuit: {
        path: measurePath(CIRCUIT_D),
        dur: 2.8, delay: 0,
        dist: [[0, 0, cbEntry], [0.22, 0.26, cbClimb], [0.32, 0.425, EASE_IN_OUT], [0.68, 0.685, cbSweep], [0.76, 0.73, cbSettle], [1, 1]],
        alpha: [[0, 0], [0.04, 1], [0.95, 1], [1, 0]],
        size: [[0, 1], [0.12, 0.82], [0.22, 0.72], [0.28, 0.62], [0.32, 0.56], [0.68, 0.56], [0.76, 0.6], [0.82, 0.7], [1, 1]],
        take: 1, rampIn: 0.08, flare: 0.9, level: 0.9, glide: [0.36, 0.6], cue: 0.93,
      },
      land: {
        path: measurePath(CIRCUIT_D + " C 282 38 334 46 366 60 C 386 68 396 76 383 71"),
        dur: 4.1, delay: 0,
        dist: [[0, 0, cbEntry], [0.15, 0.22, cbClimb], [0.219, 0.359, EASE_IN_OUT], [0.464, 0.58, cbSweep], [0.519, 0.618, cbSettle], [0.683, 0.846, cbFlare], [1, 1]],
        alpha: [[0, 0], [0.027, 1], [0.98, 1], [1, 0]],
        size: [[0, 1], [0.082, 0.82], [0.15, 0.72], [0.191, 0.62], [0.219, 0.56], [0.464, 0.56], [0.519, 0.6], [0.56, 0.7], [0.683, 0.78], [0.8, 0.74], [0.9, 0.68], [1, 0.61]],
        take: 1, rampIn: 0.08, flare: 0.9, level: null, glide: [0.24, 0.44],
      },
      depart: {
        path: measurePath("M 383 71 C 352 50 300 30 258 26 C 222 23 206 34 218 44 C 226 49 232 49 236 48"),
        dur: 1.6, delay: 0.35,
        dist: [[0, 0, cbLaunch], [0.55, 0.62, cbHook], [1, 1]],
        alpha: [[0, 0], [0.08, 1], [0.9, 1], [1, 0]],
        size: [[0, 0.62], [0.2, 0.72], [0.5, 0.78], [0.68, 0.8], [0.8, 0.88], [1, 1]],
        take: 0.45, rampIn: 0.1, flare: 0.9, level: 0.92, cue: 0.781,
      },
    };

    // The wingbeat: a cruise flap at ~195ms a beat, a fixed-wing glide
    // through the marked window, a blend from the launch pose at the start,
    // and a flare that brakes to full spread — the static glyph's own pose,
    // which is what makes each end's crossfade invisible.
    function spreadAt(spec, p, ms) {
      let s = 0.3 + 0.7 * Math.abs(Math.sin(ms / 62));
      if (spec.glide) {
        const w = smooth((p - spec.glide[0]) / 0.05) * (1 - smooth((p - spec.glide[1]) / 0.05));
        s += (0.88 - s) * w;
      }
      if (spec.rampIn > 0 && p < spec.rampIn) {
        s = spec.take + (s - spec.take) * smooth(p / spec.rampIn);
      }
      if (p > spec.flare) {
        s += (1 - s) * smooth((p - spec.flare) / (1 - spec.flare));
      }
      return s;
    }

    // ---------- The runner ----------
    // One rAF loop per flight, wall-clock (t0 is the first frame's
    // timestamp — the clock the surrounding CSS animations ride, so a
    // hidden tab skips ahead on refront rather than drifting). CV is
    // welcome.css's .wel-canvas rect — change both together.
    const CV = { left: -700, top: -64, w: 1250, h: 240 };
    const cx2d = canvas.getContext("2d");
    let dpr = 0;
    let flightRaf = 0;
    let flightState = null;
    function ensureCanvas() {
      const want = Math.min(window.devicePixelRatio || 1, 2);
      if (want !== dpr) {
        dpr = want;
        canvas.width = Math.round(CV.w * dpr);
        canvas.height = Math.round(CV.h * dpr);
      }
    }
    function cancelFlight() {
      if (flightRaf) cancelAnimationFrame(flightRaf);
      flightRaf = 0;
      flightState = null;
      cx2d.setTransform(1, 0, 0, 1, 0, 0);
      cx2d.clearRect(0, 0, canvas.width, canvas.height);
    }
    function startFlight(name, hooks) {
      cancelFlight();
      ensureCanvas();
      flightState = { spec: FLIGHTS[name], hooks: hooks || {}, t0: 0, cued: false, prevX: null };
      flightRaf = requestAnimationFrame(flightFrame);
    }
    function flightFrame(ts) {
      const st = flightState;
      if (!st) return;
      if (!st.t0) st.t0 = ts;
      const spec = st.spec;
      const p = ((ts - st.t0) / 1000 - spec.delay) / spec.dur;
      cx2d.setTransform(1, 0, 0, 1, 0, 0);
      cx2d.clearRect(0, 0, canvas.width, canvas.height);
      if (p >= 1) {
        if (spec.cue != null && !st.cued && st.hooks.onCue) st.hooks.onCue();
        const done = st.hooks.onDone;
        flightRaf = 0;
        flightState = null;
        if (done) done();
        return;
      }
      if (p > 0) {
        const pt = pathAt(spec.path, profileAt(spec.dist, p));
        let ang = pt.ang;
        if (spec.level != null && p > spec.level) {
          ang *= 1 - smooth((p - spec.level) / (1 - spec.level));
        }
        cx2d.setTransform(dpr, 0, 0, dpr, -CV.left * dpr, -CV.top * dpr);
        // Ink re-read per frame: the theme class lands asynchronously from
        // the storage read, and the old SVG's currentColor was live too.
        cx2d.fillStyle = getComputedStyle(sky).color;
        drawBird(cx2d, pt.x, pt.y, ang, profileAt(spec.size, p),
                 spreadAt(spec, p, ts - st.t0), profileAt(spec.alpha, p));
        if (spec.cue != null && !st.cued && p >= spec.cue) {
          st.cued = true;
          if (st.hooks.onCue) st.hooks.onCue();
        }
        if (st.hooks.onPos) st.hooks.onPos(pt.x, pt.y, p, st.prevX);
        st.prevX = pt.x;
      }
      flightRaf = requestAnimationFrame(flightFrame);
    }

    // ---------- The wake ----------
    // Letter positions in sky space, measured lazily per flight — the sky
    // is centred, so a letter's x is its centre minus the sky's left edge.
    let letterXs = null;
    function measureLetters() {
      const skyLeft = sky.getBoundingClientRect().left;
      letterXs = letters.map((el) => {
        const r = el.getBoundingClientRect();
        return r.left + r.width / 2 - skyLeft;
      });
    }
    // The arrival's low sweep raises each letter as the bird's x passes it.
    // The gates keep the high return leg (y < 95) and the final approach
    // (p > 0.75) from raising letters ahead of the wave.
    function riseUnder(x, y, p) {
      if (y < 95 || p > 0.75) return;
      if (!letterXs) measureLetters();
      for (let i = 0; i < letters.length; i++) {
        if (x >= letterXs[i] && !letters[i].classList.contains("rise")) {
          letters[i].classList.add("rise");
        }
      }
    }
    // A circuit's leftward sweep ducks each letter as the bird crosses it.
    // Rightward motion never triggers; the class comes off on animationend
    // below, so the next pass is a fresh play.
    function duckUnder(x, y, prevX) {
      if (prevX == null || y < 85) return;
      if (!letterXs) measureLetters();
      for (let i = 0; i < letters.length; i++) {
        if (prevX > letterXs[i] && x <= letterXs[i]) {
          letters[i].classList.add("duck");
        }
      }
    }
    mark.addEventListener("animationend", (e) => {
      if (e.animationName === "wel-duck") e.target.classList.remove("duck");
    });

    // ---------- Glyph handoff ----------
    // The static glyph leaves (.away holds it out) while the canvas bird
    // has the mass, and returns (.return squash) at each flight's cue.
    function glyphAway() {
      bird.classList.remove("return");
      bird.classList.add("away");
    }
    function glyphReturn() {
      bird.classList.remove("away");
      bird.classList.add("return");
    }

    let flying = false;
    let lastFlight = 0;
    let flyTimer = 0;
    let adjustTimer = 0;
    // The repertoire alternates: a plain circuit, then a circuit that lands
    // in the sapling. Cycle state lives here so the hover handler and the
    // reduced-motion teardown can both reach it.
    let nextCircuitLands = false;
    let perchPhase = null; // null | "flight" | "perched" | "depart"
    let cycleTimers = [];
    let lastPeck = 0;

    const settleIdle = () => {
      if (bird.classList.contains("aloft")) return;
      // A tab hidden through the arrival never pumped a frame (rAF parks);
      // the scene must still settle complete, so the flight dies here.
      cancelFlight();
      sky.classList.add("settled");
      mark.classList.add("settled");
      mark.classList.remove("pending");
      letters.forEach((el) => el.classList.remove("rise"));
      bird.classList.add("aloft");
      scheduleFly(9000 + Math.random() * 5000);
      scheduleAdjust();
    };

    // Idle begins where the arrival ends: the glyph's touchdown. The timeout
    // is a backstop — a background tab can throttle animation events, and a
    // missed one must not leave the hero frozen forever.
    bird.addEventListener("animationend", (e) => {
      if (e.animationName === "wel-land") settleIdle();
      else if (e.animationName === "wel-return") bird.classList.remove("return");
    });
    setTimeout(settleIdle, 4200);

    function scheduleFly(ms) {
      clearTimeout(flyTimer);
      flyTimer = setTimeout(tryFly, ms);
    }

    // The flick's class is removed on its own animationend, so the next add
    // is a fresh animation — no reflow tricks needed to restart it. The
    // perched bird's business classes follow the same pattern.
    if (wings) wings.addEventListener("animationend", () => wings.classList.remove("adjust"));
    if (perchBody) {
      perchBody.addEventListener("animationend", (e) => {
        if (e.animationName === "wel-perch-shift" || e.animationName === "wel-perch-peck") {
          perchBody.classList.remove("shift", "peck");
        }
      });
    }
    function scheduleAdjust() {
      clearTimeout(adjustTimer);
      adjustTimer = setTimeout(() => {
        if (!flying && !document.hidden && wings) wings.classList.add("adjust");
        scheduleAdjust();
      }, 9000 + Math.random() * 7000);
    }

    function tryFly() {
      if (flying || document.hidden || !bird.classList.contains("aloft")) {
        scheduleFly(6000);
        return;
      }
      flying = true;
      letterXs = null; // the tab may have been resized since the last pass
      const lands = nextCircuitLands;
      nextCircuitLands = !lands;
      if (lands) {
        runPerchCycle();
        return;
      }
      glyphAway();
      // Cleanup on the flight's own end, with a timeout backstop so a missed
      // frame can never leave the flag stuck and the repertoire dead. The
      // glyph must be brought back by whichever path runs — a cue that never
      // fired (backstop path) would otherwise strand it held away.
      const done = () => {
        if (!flying) return;
        flying = false;
        lastFlight = performance.now();
        if (bird.classList.contains("away")) glyphReturn();
        scheduleFly(22000 + Math.random() * 16000);
      };
      startFlight("circuit", {
        onCue: glyphReturn,
        onPos: (x, y, p, prevX) => duckUnder(x, y, prevX),
        onDone: done,
      });
      setTimeout(() => {
        if (flying && perchPhase === null) {
          cancelFlight();
          done();
        }
      }, 3400);
    }

    // Variant B: circuit -> land in the sapling -> perch (10–16s, with the
    // odd shift or peck) -> launch -> back to the glyph. Phases advance on
    // the flights' own completions, each with a timeout backstop and a
    // phase guard, so a missed or doubled trigger can neither stall the
    // cycle nor run a phase twice. The furniture (tree, perched bird) is
    // all CSS: JS adds .idle-perch, then .idle-depart ALONGSIDE it, and
    // removes both at the end.
    function runPerchCycle() {
      perchPhase = "flight";
      glyphAway();
      hero.classList.add("idle-perch");
      const later = (fn, ms) => cycleTimers.push(setTimeout(fn, ms));

      function scheduleBusiness() {
        later(() => {
          if (perchPhase !== "perched") return;
          if (perchBody && !perchBody.classList.contains("peck") && !perchBody.classList.contains("shift")) {
            perchBody.classList.add(Math.random() < 0.35 ? "peck" : "shift");
          }
          scheduleBusiness();
        }, 3500 + Math.random() * 3000);
      }

      const land = () => {
        if (perchPhase !== "flight") return;
        perchPhase = "perched";
        scheduleBusiness();
        later(depart, 10000 + Math.random() * 6000);
      };
      const depart = () => {
        if (perchPhase !== "perched") return;
        perchPhase = "depart";
        hero.classList.add("idle-depart");
        startFlight("depart", { onCue: glyphReturn, onDone: finish });
        later(finish, 2400);
      };
      const finish = () => {
        if (perchPhase === null) return;
        perchPhase = null;
        cancelFlight();
        cycleTimers.forEach(clearTimeout);
        cycleTimers = [];
        if (perchBody) perchBody.classList.remove("shift", "peck");
        hero.classList.remove("idle-perch", "idle-depart");
        if (bird.classList.contains("away")) glyphReturn();
        flying = false;
        lastFlight = performance.now();
        scheduleFly(22000 + Math.random() * 16000);
      };
      startFlight("land", {
        onPos: (x, y, p, prevX) => duckUnder(x, y, prevX),
        onDone: land,
      });
      later(land, 4800);
    }

    // Hover jumps the queue — a reader leaning in deserves the show — but
    // never mid-flight and never twice in quick succession. A hover over a
    // PERCHED bird gets a peck instead of a flight, on its own cooldown.
    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      hero.addEventListener("pointerenter", () => {
        if (perchPhase === "perched") {
          const now = performance.now();
          if (perchBody && now - lastPeck > 2500 &&
              !perchBody.classList.contains("peck") && !perchBody.classList.contains("shift")) {
            lastPeck = now;
            perchBody.classList.add("peck");
          }
          return;
        }
        if (flying || !bird.classList.contains("aloft")) return;
        if (performance.now() - lastFlight < 6000) return;
        tryFly();
      });
    }

    // Motion switched off mid-session: kill the mover, stop scheduling, and
    // strike every idle class — the CSS half already went quiet the moment
    // the media query flipped, but a stray class must not resume anything
    // if it flips back.
    if (reduced.addEventListener) {
      reduced.addEventListener("change", (e) => {
        if (e.matches) {
          clearTimeout(flyTimer);
          clearTimeout(adjustTimer);
          cycleTimers.forEach(clearTimeout);
          cycleTimers = [];
          perchPhase = null;
          flying = false;
          cancelFlight();
          if (perchBody) perchBody.classList.remove("shift", "peck");
          bird.classList.remove("away", "return");
          mark.classList.remove("pending");
          letters.forEach((el) => el.classList.remove("rise", "duck"));
          hero.classList.remove("idle-perch", "idle-depart");
        }
      });
    }

    // ---------- The arrival ----------
    // The letters hide behind .pending until the sweep writes them; the
    // glyph's own touchdown stays on its CSS delay (2.62s), which the
    // flight's fade is authored to meet.
    mark.classList.add("pending");
    startFlight("arrive", {
      onPos: riseUnder,
      onDone: () => {
        // Any letter the sweep somehow missed still rises — the arrival
        // must never end with a hole in the wordmark.
        letters.forEach((el) => {
          if (!el.classList.contains("rise")) el.classList.add("rise");
        });
      },
    });
  }

  const store = {
    async get(keys) {
      try {
        return await chrome.storage.local.get(keys);
      } catch {
        return {};
      }
    },
    async set(obj) {
      try {
        await chrome.storage.local.set(obj);
        return true;
      } catch {
        return false;
      }
    },
  };

  const yes = document.getElementById("yes");
  const no = document.getElementById("no");
  const note = document.getElementById("note");

  // The answered state: buttons go, one line confirms, and the popup is named
  // as the place to change it — this page never opens again.
  function settle(on) {
    yes.hidden = true;
    no.hidden = true;
    note.hidden = false;
    note.textContent = on
      ? "You're contributing. Change it any time in the Jackdaw popup, under Settings."
      : "Nothing will be shared. Change your mind any time in the Jackdaw popup, under Settings.";
  }

  async function answer(on) {
    const ok = await store.set({ jdCatalog: on });
    if (ok) settle(on);
    else {
      note.hidden = false;
      note.textContent = "Couldn't save that. Open the Jackdaw popup from the toolbar to answer.";
    }
  }

  yes.addEventListener("click", () => answer(true));
  no.addEventListener("click", () => answer(false));

  store.get(["jdTheme", "jdCatalog"]).then(({ jdTheme, jdCatalog }) => {
    // The popup's stored choice wins; a fresh install follows the OS.
    const dark = jdTheme
      ? jdTheme === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.body.classList.toggle("dark", dark);
    // Already answered elsewhere (popup, tour) — show the settled state.
    if (jdCatalog !== undefined) settle(jdCatalog === true);
  });

  // Answered in another surface while this tab sat open: settle live rather
  // than leave a question standing that has already been answered.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.jdCatalog && changes.jdCatalog.newValue !== undefined) {
        settle(changes.jdCatalog.newValue === true);
      }
    });
  } catch {
    // dead context: the buttons' own failure path already covers it
  }
})();
