/* Jackdaw — jackdaws.app
   ────────────────────────────────────────────────────────────────────────────
   All the page's canvas work and the one scrubbed timeline, with no
   dependencies. Four surfaces:

     · the hero panel      — beat zero of the record, six January readings
     · the pinned record   — eight months, scrubbed by scroll position
     · the feature chart   — new and open-box lines, with a resting pulse
     · the CTA wire        — the flock, settled

   THE SPLIT BETWEEN JS AND CSS IS DELIBERATE, AND CSS GETS THE LARGER HALF.
   Every reveal, every strike-through, the parallax, the grain, the counters in
   the privacy column and all of the idle motion are native CSS — scroll-driven
   timelines, @property, color-mix, mask-image — and are not mentioned in this
   file at all. JS drives only what a <canvas> makes unavoidable. Where it does,
   ONE progress value feeds both the canvas and the DOM, because two timing
   systems pointed at the same moment is how they drift apart.

   Numbers on this page are illustrative of the interface, as the footer says.
   They are shaped like a real record — flat stretches, a couple of upticks, a
   list price that steps once — because a monotonic line falling to the corner
   is the one thing a real price history never looks like.
   ──────────────────────────────────────────────────────────────────────────── */

(() => {
  "use strict";

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  /* Matches the extension exactly: thousands separators and two decimals, so a
     figure here reads the way the retailer prints it. `toFixed` alone gave
     "$15299.99" beside Micro Center's own "$15,299.99". */
  const money = (n) =>
    "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /* ── Palettes ──────────────────────────────────────────────────────────────
     A canvas cannot read a CSS custom property, so the chapter arc has to be
     handed to it explicitly — this is the same split the extension's `chart.js`
     makes for dark mode, and it is worth restating why it exists rather than
     just mirroring it: the stylesheet's tokens turn over on one attribute
     write, and anything painted with `fillStyle` does not turn over at all
     until something repaints it with different numbers.

     `let`, not `const`, and swapped wholesale by `applyPalette` below. Every
     draw function reads these five names, so a swap plus a redraw is the entire
     mechanism and no drawing code knows chapters exist.

     The night values are NOT the paper ones lightened. Contrast on a canvas is
     measured against the panel it sits in, and the panel is `--surface`, which
     on night is #131d33 — `#eeeae4` gridlines there would be brighter than the
     data line and the chart would read as a grid with a price in it. */
  const PALETTES = {
    paper: {
      ink: "#16233a",
      green: "#16a34a",
      amber: "#d97706",
      /* Barely there on purpose: a gridline is a reading aid, and the moment it
         competes with the series it is furniture. */
      gridLine: "#eeeae4",
      axisInk: "#9aa1ad",
      /* What the figure is printed ON — used to rim a mark so the line running
         under it stays legible as a line. Not decoration: on ruled stock a
         2px dot sitting on a 2px stroke merges into a thicker stroke, and the
         reading you can no longer see is the one being pointed at. */
      sheet: "#f6f8fa",
    },
    night: {
      /* The series itself. On night the marks are the lit thing in the frame —
         this is the same value as the chapter's `--ink`, so a bird on the wire
         and the headline above it are struck in one colour. */
      ink: "#e8eef7",
      green: "#4ade80",
      amber: "#f0a43a",
      gridLine: "rgba(255, 255, 255, 0.08)",
      axisInk: "#8695ab",
      sheet: "#131d33",
    },
  };
  let { ink, green, amber, gridLine, axisInk, sheet } = PALETTES.paper;

  function applyPalette(name) {
    const p = PALETTES[name] || PALETTES.paper;
    ({ ink, green, amber, gridLine, axisInk, sheet } = p);
  }

  /* Palette entries are hex because that is what a human edits without error;
     a canvas gradient needs alpha. Doing this at the point of use rather than
     storing a second set of rgba strings keeps the palette one list — the
     alternative is a `greenSoft` per chapter that some future stop forgets to
     add, and a missing colour on a canvas is invisible rather than loud. */
  function withAlpha(hex, a) {
    const h = hex.replace("#", "");
    const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  /* ── The record ────────────────────────────────────────────────────────────
     Fourteen sightings of one part, January to August. The third column is how
     many readings produced that point: a product page contributes one, a page
     of search results contributes every card on it. That is why the sighting
     counter climbs faster than the number of marks — which is the product's
     actual arithmetic, not a flourish. The fourth is the open-box price when a
     reading saw one, and it lives here rather than beside the feature chart so
     the two charts cannot tell different stories about the same part.

     THE DATES ARE THE AXIS, NOT THE ROW NUMBERS, and that is the whole
     difference between a price history and a staircase. Spacing rows evenly —
     which is what this did until the shape gave it away — draws a metronome:
     every tread the same width, every riser the same distance from the last, a
     figure no real series has ever had. Priced eighteen days after the previous
     reading, a point sits eighteen days along.

     The counts are spread rather than lumped, and that is a change of claim as
     well as of shape: the old table put a 96-card grid page beside a run of
     ones, which is true of a single busy afternoon and not of eight months.
     What a part actually accumulates is a few dozen readings a fortnight from
     whoever happened to look, so that is what the column says now — and beat
     two says the same thing. */
  const RECORD = [
    ["Jan 6", 129.99, 2, null],
    ["Jan 24", 127.99, 9, null],
    ["Feb 11", 129.99, 6, null],
    ["Feb 27", 124.99, 21, 99.99],
    ["Mar 16", 124.99, 12, 99.99],
    ["Apr 2", 119.99, 28, null],
    ["Apr 21", 122.99, 17, 94.99],
    ["May 6", 119.99, 24, null],
    ["May 27", 114.99, 13, null],
    ["Jun 14", 114.99, 31, 89.99],
    ["Jun 30", 109.99, 19, 87.99],
    ["Jul 18", 104.99, 26, null],
    ["Aug 2", 99.99, 22, 79.99],
    ["Aug 15", 94.99, 20, 76.99],
  ];
  const N = RECORD.length;

  /* Day-of-year for a "Mon D" label, so the table above stays a table anybody
     can read and edit while the axis underneath it stays honest. Non-leap: the
     record does not cross a February 29, and a table that did would need a year
     printed on it before any of this meant anything. */
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTH_DAY1 = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  const dayOf = (label) => {
    const [m, d] = label.split(" ");
    return MONTH_DAY1[MONTHS.indexOf(m)] - 1 + +d;
  };
  const DAYS = RECORD.map((r) => dayOf(r[0]));
  const DAY0 = DAYS[0];
  const DAY_SPAN = DAYS[N - 1] - DAY0;
  /* Every reading's place on the axis, 0 at the first and 1 at the last. One
     array, read by the leaf, the scrub and the month ruler, so none of the
     three can disagree with the others about where a date is. */
  const AT = DAYS.map((d) => (d - DAY0) / DAY_SPAN);

  /* The advertised list price steps ONCE, at Jun 14 — and that is what lets the
     chip say "unchanged 62 days" rather than "62+". The extension's walk back
     through the record yields an exact figure only when it ends on a DIFFERENT
     advertised number, and a floor marked `+` when it merely runs out of
     points. Jun 14 to Aug 15 is 62 days — day 165 to day 227 in the array
     above, which is now something the page can be held to rather than an index
     that happened to be right — so the beat copy, the chip and the dashed line
     all say the same thing and none of them is guessing. */
  const LIST_STEP_AT = 9;
  const LIST_BEFORE = 139.99;
  const LIST_AFTER = 129.99;
  const TARGET = 95.0;

  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  /* ── Chart plumbing ─────────────────────────────────────────────────────── */

  /* Gridlines land on round numbers, not on the series' own extremes. Four
     values spaced evenly between a padded min and max gave "$134.24 / $129.74 /
     $125.24 / $120.74" — figures no shopper ever saw and no price ever was, so
     the axis read as noise beside a chart whose whole claim is that the numbers
     are real. The steps come from the 1/2/2.5/5 × 10^k family every financial
     chart uses.

     Only the ticks falling INSIDE the caller's range are drawn, and `lo`/`hi`
     are passed through untouched. The alternative — widening the range to the
     nearest round bounds so the end ticks sit flush with the plot edges — moves
     the mapping, and on the hero (whose padding is already 0.85× the span, to
     hold six points in the middle of the frame) that would flatten the line by
     up to two thirds of a step. Labels must not be able to redraw the data they
     label. The cost is that the top gridline sits below the top of the plot,
     which is what Keepa and every brokerage chart look like anyway. */
  const TICK_STEPS = [1, 2, 2.5, 5];
  function niceTicks(lo, hi, want) {
    const span = hi - lo;
    if (!(span > 0)) return [hi];
    let best = null;
    /* Start a decade below the ideal step and sweep up: the first candidate
       that fits is not necessarily the closest to `want`, so score them all. */
    const k0 = Math.floor(Math.log10(span / want)) - 1;
    for (let k = k0; k <= k0 + 3; k++) {
      for (const m of TICK_STEPS) {
        const step = m * Math.pow(10, k);
        const out = [];
        /* Indexed off `first`, never accumulated — `v += step` drifts, and a
           tick at 129.99999999 formats as $130 while sitting off the round. */
        const first = Math.ceil(lo / step - 1e-9) * step;
        for (let i = 0; out.length < 40; i++) {
          const v = +(first + i * step).toFixed(10);
          if (v > hi + 1e-9) break;
          out.push(v);
        }
        if (out.length < 2) continue;
        /* Count is the primary term, roundness the tie-break — otherwise a
           2.5 step wins on count alone and the axis reads $132.50 / $127.50
           where $130 / $125 was available for the same money. */
        const score = Math.abs(out.length - want) * 2 + (out.every(Number.isInteger) ? 0 : 1);
        if (!best || score < best.score) best = { score, ticks: out };
      }
    }
    return best ? best.ticks.reverse() : [hi, lo];
  }
  /* An axis label is a gridline's name, not a price quote: a round step prints
     round, so $130 rather than $130.00. `money()` keeps its two decimals for
     every figure the page states AS a price, which is the extension's rule. */
  const axisMoney = (v, dp) =>
    "$" + v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

  /* padR is derived from the tick labels that will ACTUALLY be drawn, not from
     a constant. It used to be a flat 52, which leaves 42px for the label — and
     "$999.99" measures 42.14 at this font, so every four-figure price on the
     site lost its cents to the canvas edge. The draw loop reads the same ticks
     array this measured, so the width reserved is the width that lands. */
  /* The height is READ from the stylesheet, not written to it. Writing it here
     meant the box was the canvas's intrinsic 300×150 until the first draw, so
     the section reflowed the instant a chart was drawn — for the feature chart,
     exactly when the reader arrived at it. CSS already knows the viewport;
     `clamp()` and the breakpoints belong there, and this reads the answer. */
  /* `opts` exists for ONE caller — the chart printed straight onto the ledger,
     which cannot be allowed to pick its own ticks or its own top padding
     because both are dictated by the ruling underneath it. Everything else
     passes nothing and gets the behaviour it always had. */
  function geom(canvas, lo, hi, opts) {
    const o = opts || {};
    const w = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    /* A surface that has not been laid out reports 0, and every number derived
       from it would be fiction. Bail; the ResizeObserver brings us back. */
    if (!w || cssH <= 0) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, cssH);
    ctx.font = "500 10px system-ui, -apple-system, sans-serif";

    const ticks = o.ticks || niceTicks(lo, hi, 4);
    /* Decimals are read off the ticks rather than off the step, so a run that
       happens to be whole numbers prints whole even if the step is 2.5. */
    const tickDp = ticks.every((t) => Number.isInteger(t)) ? 0 : 2;
    let maxW = 0;
    for (const t of ticks) maxW = Math.max(maxW, ctx.measureText(axisMoney(t, tickDp)).width);

    return {
      ctx, w, h: cssH, lo, hi, ticks, tickDp,
      /* The record's leaf sets its own horizontal pads, and they are not
         padding in the usual sense: padL is the PLAYHEAD, the fixed screen
         position the newest reading is held at, and padR is whatever is left
         over once the plot has been sized to make that true. Both fall back to
         the ordinary answers for every other chart. */
      padL: o.padL != null ? o.padL : 6,
      padR: o.padR != null ? o.padR : Math.max(52, Math.ceil(maxW) + 14),
      padT: o.padT != null ? o.padT : 12,
      padB: o.padB != null ? o.padB : 22,
      bare: !!o.bare,
      /* The series' own x fractions, when it has dates. Null is not "missing"
         — it is a series with no time in it, which `X` spaces evenly. */
      at: o.at || null,
    };
  }
  /* `XT` takes a fraction of the DOMAIN — where along the whole span of time a
     thing sits — and `X` looks that fraction up for a reading. `g.at` is the
     series' own normalised dates; without one the spacing falls back to even,
     which is the right answer only for a series that genuinely has no time in
     it. Nothing else in the file computes a plot x, so the two charts and the
     month ruler cannot drift apart.

     i is indexed against the FULL series, never against how much of it is
     visible — otherwise every existing point slides left as the next one
     arrives, and accumulation reads as jitter. The record extends rightward. */
  const XT = (g, f) => g.padL + f * (g.w - g.padL - g.padR);
  const X = (g, i, n) =>
    XT(g, g.at ? g.at[clamp(i, 0, g.at.length - 1)] : i / Math.max(1, n - 1));
  const Y = (g, v) => g.padT + (1 - (v - g.lo) / (g.hi - g.lo)) * (g.h - g.padT - g.padB);

  function drawGrid(g) {
    const { ctx } = g;
    ctx.lineWidth = 1;
    ctx.strokeStyle = gridLine;
    ctx.fillStyle = axisInk;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const v of g.ticks) {
      const y = Math.round(Y(g, v)) + 0.5;
      /* On the leaf the paper's own ruling IS the grid, so the bare chart draws
         no horizontals of its own — only the figures that name them. Drawing
         both would put a second line a fraction off the first, which is the one
         way to make deliberate alignment read as a rendering fault. */
      if (!g.bare) {
        ctx.beginPath();
        ctx.moveTo(g.padL, y);
        ctx.lineTo(g.w - g.padR + 4, y);
        ctx.stroke();
      }
      ctx.fillText(axisMoney(v, g.tickDp), g.w - g.padR + 9, y);
    }
  }

  /* A price point arriving is a bird landing: it drops in with its wings spread
     and they fold into the dot as it settles. One thing becoming another, which
     is the house rule — and it means the mark and the metaphor are the same
     object rather than an illustration sitting beside a chart. */
  function drawSighting(ctx, x, y, life, color) {
    const e = easeOut(clamp(life, 0, 1));
    const spread = (1 - e) * 8;
    ctx.save();
    ctx.translate(x, y - (1 - e) * 18);
    if (life < 0.995) {
      ctx.globalAlpha = clamp(life * 2.4, 0, 1);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(-2.2 - spread, -1.2 - spread * 0.5);
      ctx.quadraticCurveTo(-2, 0.9, 0, 0.5);
      ctx.quadraticCurveTo(2, 0.9, 2.2 + spread, -1.2 - spread * 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, 2.1 + (1 - e) * 1.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /* A price holds until somebody sees it change, so the line between two
     readings is a step, not a slope. Drawing it as a slope would assert a
     smooth drift nobody observed. */
  function stepPath(g, pts, n, count, partial) {
    const { ctx } = g;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const x = X(g, i, n);
      const y = Y(g, pts[i]);
      if (i === 0) ctx.moveTo(x, y);
      else {
        ctx.lineTo(x, Y(g, pts[i - 1]));
        ctx.lineTo(x, y);
      }
    }
    /* The newest point is still on its way down — run the line out toward where
       it will be, so the mark and the line arrive together. */
    if (partial > 0 && partial < 1 && count < n) {
      const x = lerp(X(g, count - 1, n), X(g, count, n), partial);
      ctx.lineTo(x, Y(g, pts[count - 1]));
    }
    ctx.stroke();
  }

  function dashLine(g, y, color, alpha, dash, x0, x1) {
    if (alpha <= 0.001) return;
    const { ctx } = g;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(x0 != null ? x0 : g.padL, y);
    ctx.lineTo(x1 != null ? x1 : g.w - g.padR, y);
    ctx.stroke();
    ctx.restore();
  }

  /* ══ The pinned record ═════════════════════════════════════════════════════
     Scroll position IS the date. One progress value, 0 to 1 across the track,
     drives the canvas, the panel head, the chips, the stats, the alert card and
     the nav readout — so nothing on screen can disagree about which moment you
     are looking at, and dragging back up genuinely rewinds. */

  const reel = {
    section: document.querySelector(".reel"),
    track: $("reelTrack"),
    stage: $("reelStage"),
    canvas: $("reelChart"),
    scale: $("reelScale"),
    when: $("reelWhen"),
    now: $("reelNow"),
    typical: $("reelTypical"),
    count: $("reelCount"),
    chipList: $("chipList"),
    chipAtl: $("chipAtl"),
    chipSeen: $("chipSeen"),
    alert: $("reelAlert"),
    alertBadge: $("alertBadge"),
    alertPrice: $("alertPrice"),
    alertMeter: $("alertMeter"),
    alertSub: $("alertSub"),
    head: document.querySelector(".reel-head"),
    heading: $("recordHeading"),
    panel: $("reelPanel"),
    foot: document.querySelector(".reel-foot"),
    footIndex: $("footIndex"),
    beats: [...document.querySelectorAll(".beat")],
    navWhen: $("navWhen"),
    navPrice: $("navPrice"),
  };

  const prices = RECORD.map((r) => r[1]);
  const RANGE = (() => {
    const all = prices.concat([LIST_BEFORE, LIST_AFTER, TARGET]);
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const pad = (hi - lo) * 0.14;
    return { lo: lo - pad, hi: hi + pad };
  })();

  /* Points appear across the first 90% of the track; the last two beats are the
     alert being set and the flock catching it, which need the record finished. */
  const DRAW_SPAN = 0.9;
  let lastMet = false;
  let lastShownCount = 0;

  /* How much of the domain a freshly landed mark takes to arrive — a fixed slice
     of the span, ~4 days of 221, not a fraction of the gap it opens. A gap-
     relative life would run the landing animation for as long as the wait for
     the NEXT reading, so a mark that came after a quiet fortnight would still be
     fading in a week later, and one after a busy week would snap. The arrival is
     an event, and events have their own duration. */
  const ARRIVE_SPAN = 4 / DAY_SPAN;

  /* SCROLL IS TIME, LITERALLY: `p` walks the head along the DATE axis, not along
     the row numbers. So a flat fortnight takes a fortnight of scroll and a busy
     week goes by in a week's worth — which is the other half of why the figure
     stopped reading as a staircase, and the reason `HEAD_K` is now simply
     `1/DRAW_SPAN` where it used to carry an index-vs-date correction.

     `partial` is where the head sits between the last reading and the next, and
     it drives the line running out ahead of the mark. `life` is how long the
     last mark has BEEN there, and it drives the mark's own landing. They were
     one number while the spacing was even; on a date axis they are not. */
  /* How many readings have been reached at a fraction `t` of the DOMAIN. One
     definition, read by the record's scrub and by the feature panel's reveal, so
     the two figures cannot come to different answers about the same series. */
  function countAt(t) {
    let k = 1;
    while (k < N && AT[k] <= t) k++;
    return k;
  }

  function shownAt(p) {
    const t = clamp(p / DRAW_SPAN, 0, 1);
    const count = countAt(t);
    const from = AT[count - 1];
    const to = count < N ? AT[count] : 1;
    return {
      count,
      partial: count < N ? clamp((t - from) / (to - from), 0, 1) : 1,
      life: clamp((t - from) / ARRIVE_SPAN, 0, 1),
    };
  }

  /* The tag arrives at the moment you set it, which is where `paintReel` arms
     it, and it is pinned to that date rather than following the playhead. */
  const ALERT_AT = 0.7;
  /* The one gap the beat and the tag are never allowed to close. */
  const BEAT_GAP = 34;
  const LEAF_PAD_T = 14;
  const LEAF_PAD_B = 26;
  /* How far the head travels across the plot per unit of `p`, which is what the
     strip's own travel has to be divided by for the playhead to sit still. Now
     that `p` walks the DATE axis the head's fraction of the plot IS `p`, scaled
     only by the fact that the record finishes at `DRAW_SPAN` rather than at the
     end of the track. It used to carry an index-vs-date correction on top of
     that (`N / (N-1)`), because the head reached the last READING at t=(N-1)/N;
     with dates it reaches the last DATE at t=1 and the correction is gone. Get
     this wrong and the newest mark drifts across the screen while the ground
     under it drifts the other way, which is the one reading the whole section is
     built to avoid.

     One consequence worth naming, because it is a change and not a bug: the
     playhead is now the PRESENT MOMENT rather than the newest mark. Between two
     readings the line runs out to it and the last dot sits behind, however many
     days behind it actually is. On the old even spacing those were the same
     place by construction. */
  const HEAD_K = 1 / DRAW_SPAN;

  /* Resolved geometry, recomputed on layout and read by every draw. Null until
     the stage has a width — which it does not on a `display: none` ancestor or
     before first layout, and every number derived from a zero width is fiction. */
  let leaf = null;

  /* Registered custom properties only. An unregistered one computes to its own
     token stream, so `clamp(760px, 150vw, 2200px)` comes back as that literal
     string and `parseFloat` answers NaN; `@property … <length>` is what makes
     the CSS and the maths agree on one number. */
  const cssNum = (cs, name) => parseFloat(cs.getPropertyValue(name)) || 0;

  function layoutReel() {
    const vw = reel.stage.clientWidth;
    if (!vw) { leaf = null; return; }
    const cs = getComputedStyle(reel.stage);
    const travel = cssNum(cs, "--travel");

    if (travel <= 0) {
      /* No scrub, no strip — reduced motion collapses the stage into ordinary
         flow, and the leaf goes back to being an ordinary chart. */
      leaf = { travel: 0, padL: null, padR: null, noteTravel: 0 };
    } else {
      const padL = Math.round(vw * cssNum(cs, "--head-frac"));
      leaf = {
        travel,
        padL,
        /* Whatever is left once the plot has been sized so that `HEAD_K` plot
           widths equal one travel. Derived, never chosen. */
        padR: vw + travel - padL - travel / HEAD_K,
        noteTravel: travel * (1 - cssNum(cs, "--note-lag")),
      };
    }

    /* The annotation plane travels at its own rate, so a note's resting place is
       its moment scaled by THAT distance, not by the leaf's. A beat pinned at
       `mid` sits at `noteX` exactly at its own moment and drifts either side of
       it over its life, so `noteX` has to be offset by the WIDEST of those
       excursions — otherwise the leftmost one lands outside the page and a
       paragraph whose left edge wanders past the text margin reads as a fault,
       however deliberate the drift is. Anchored on the heading's own left edge,
       measured: the terrain is full-bleed and the text column is not, so the
       page's padding is not the page's margin — they differ by the wrap's
       centring, which is 42.5px at 1265 and zero below the measure. Reading
       `--pad-x` for this (which is what the first version did) put every beat a
       gutter-width left of the heading it belongs under. */
    const stageR = reel.stage.getBoundingClientRect();
    const stageL = stageR.left;
    const textL = reel.head.getBoundingClientRect().left - stageL;
    /* Published because the price figures want the same edge and there is no
       constant to share — one measurement, or two formulas that will drift. */
    reel.stage.style.setProperty("--text-l", textL.toFixed(1) + "px");

    /* The merged band. On a short phone the heading and the marginalia are the
       same band — the title is what is written there until the record starts,
       then it hands over to the running commentary — so the heading's box has to
       reserve whichever of the two is taller, and the beats have to land exactly
       on its top edge. Both are measurements and neither can be a constant: the
       lead is the eyebrow plus its margin at whatever the type scale resolved
       to, and the tallest beat is content reflowed at whatever width the
       breakpoint left it.

       `offsetTop`/`offsetHeight` rather than rects, and that is load-bearing
       rather than idiom: the heading is TRANSFORMED as it hands over and the
       beats sit on a plane that translates every frame, so a rect would fold the
       animation into the geometry the animation is positioned by, and the band
       would creep by 14px the first time you scrolled.

       Published unconditionally and consumed only inside the breakpoint — one
       measurement that cannot disagree with the CSS about which layout is in
       force, where asking JS the same question twice can. They go out BEFORE
       `--panel-b` is read, because `--beat-h` grows the head and `--panel-b` is
       measured off the bottom of what it grew. */
    reel.stage.style.setProperty("--head-lead", reel.heading.offsetTop + "px");
    reel.stage.style.setProperty(
      "--beat-h",
      Math.max(...reel.beats.map((b) => b.offsetHeight)) + "px"
    );

    /* The two fixed-size things below the terrain, published so the short-phone
       rule can derive the leaf's height from the room they leave rather than
       from a width breakpoint. Both are `offsetHeight` and not rects on purpose:
       the tag is TILTED, so its rect is ~15px taller than the box it occupies
       (300px of card at 4.5deg mid-swing adds 23.5 to the bounding box), and
       budgeting against that would shrink the chart to buy clearance for a
       corner that is only there during the swing. The tilt's real cost lands on
       the horizontal budget below, which is where it belongs. */
    reel.stage.style.setProperty("--tag-h", reel.alert.offsetHeight + "px");
    reel.stage.style.setProperty("--foot-h", reel.foot.offsetHeight + "px");

    /* Where the instrument ends. On a wide screen the read-out sits BESIDE the
       heading and the terrain begins well below both, so `--band-leaf` can be a
       token; in one column it sits above the terrain and the token has no way to
       know how tall it got — at 390 the leaf band opened 91px inside the panel
       and took two of the three price figures behind it. So the band takes the
       larger of its token and this, and the mobile rules below are what opt in.
       Stable across the scrub only because `.panel-chips` reserves both of its
       rows: without that the panel grows 32px when the second chip lands, which
       is at `ALERT_AT`, and the whole terrain would step down at exactly the
       moment the tag arrives. */
    reel.stage.style.setProperty(
      "--panel-b",
      (reel.panel.getBoundingClientRect().bottom - stageR.top).toFixed(1) + "px"
    );
    const spans = reel.beats.map((b) => (+b.dataset.to - +b.dataset.from) / 2);
    const noteX = textL + Math.max(...spans) * leaf.noteTravel;
    for (const b of reel.beats) {
      const mid = (+b.dataset.from + +b.dataset.to) / 2;
      b.style.setProperty("--bx", (noteX + mid * leaf.noteTravel).toFixed(1) + "px");
    }
    /* The tag hangs under the playhead at the instant it is set — the same
       `padL` the leaf is drawn against, carried into the plane's coordinates. */
    const ax = (leaf.padL == null ? 0 : leaf.padL) + ALERT_AT * leaf.noteTravel;
    reel.alert.style.setProperty("--ax", ax.toFixed(1) + "px");

    /* The beat shares one horizontal band with the tag, so its width is a
       BUDGET, not a taste. And the budget is a constant, which is not obvious
       and is the whole reason this is four lines instead of a sweep: the beats
       and the tag are pinned to the SAME plane and translate by the same amount,
       so `p` cancels out of the distance between them. What is left depends only
       on the beat's own moment. The binding case is therefore the LAST beat, not
       the last scroll position — and only beats still lit after `ALERT_AT` are
       in the running at all, because before that the tag does not exist to hit.

       Measured rather than guessed because every remaining term moves: `padL`
       with the viewport, the drift with `--note-lag`, the tag's own width with
       the breakpoint. A number that is right for the geometry it was measured
       against goes wrong the moment the margin does — which is exactly what
       happened when the text margin moved 50px and the last beat landed across
       the tag it had cleared by 40px the day before. */
    /* The tag's RENDERED half-width, not its layout one. It lands tilted on a
       pivot 30px above its own top, so the corner furthest from that pivot
       swings out past the box — 2.3px on a 133px tag at 0.8deg, which is
       precisely what the first version of this budget came up short by. Both
       terms are read back out of the stylesheet (`--tilt` beside the rule that
       consumes it, the pivot from the computed origin) rather than restated
       here, and the worse of the two corners is taken so the sign of the angle
       cannot matter: a clearance is a bound, not an estimate. */
    /* `--hang-max` is the OTHER half of the angle, and leaving it out is how the
       guarantee above quietly stops being one: the tag also leans with scroll
       velocity, and the record is pinned, so it is leaning for essentially the
       whole time it is on screen. Summed rather than maxed — the lean is added
       to the rest tilt, so the worst corner is at the sum — and both terms are
       read out of the stylesheet beside the rules that declare them, so a
       change to either amplitude carries into the budget on its own. */
    const ac = getComputedStyle(reel.alert);
    const tilt =
      (Math.abs(parseFloat(ac.getPropertyValue("--tilt")) || 0) +
        Math.abs(parseFloat(ac.getPropertyValue("--hang-max")) || 0)) *
      (Math.PI / 180);
    const pivotY = parseFloat(ac.transformOrigin.split(" ")[1]) || 0;
    const arm = Math.max(Math.abs(pivotY), Math.abs(reel.alert.offsetHeight - pivotY));
    const half = (reel.alert.offsetWidth / 2) * Math.cos(tilt) + arm * Math.sin(tilt);
    const shared = reel.beats
      .filter((b) => +b.dataset.to > ALERT_AT)
      .map((b) => (+b.dataset.from + +b.dataset.to) / 2);
    const lane = shared.length
      ? ax - half - noteX - Math.max(...shared) * leaf.noteTravel - BEAT_GAP
      : 1e4;
    reel.stage.style.setProperty("--beat-w", Math.max(0, lane).toFixed(1) + "px");

    buildScale();
  }

  /* The price scale is the one part of the chart that does not travel, so it is
     the one part not drawn into the leaf. Built from the same ticks and the same
     mapping `Y()` uses, against a box CSS has already inset by the same two pads
     — which is what lets a DOM rule and a canvas line agree to the pixel. */
  let scaleKey = "";
  function buildScale() {
    const ticks = niceTicks(RANGE.lo, RANGE.hi, 4);
    const dp = ticks.every(Number.isInteger) ? 0 : 2;
    const key = ticks.join(",");
    if (key === scaleKey) return;
    scaleKey = key;
    reel.scale.replaceChildren(
      ...ticks.map((v) => {
        const row = document.createElement("i");
        row.style.top = ((1 - (v - RANGE.lo) / (RANGE.hi - RANGE.lo)) * 100).toFixed(3) + "%";
        const label = document.createElement("b");
        label.textContent = axisMoney(v, dp);
        row.appendChild(label);
        return row;
      })
    );
  }

  function drawRecord(p) {
    if (!leaf) return;
    const g = geom(reel.canvas, RANGE.lo, RANGE.hi, {
      padL: leaf.padL,
      padR: leaf.padR,
      padT: LEAF_PAD_T,
      padB: LEAF_PAD_B,
      at: AT,
    });
    if (!g) return;
    const { ctx } = g;
    const { count, partial, life } = shownAt(p);

    /* No `drawGrid` here: the horizontals and their figures are `.reel-scale`,
       pinned outside the strip. Drawing them into a surface that travels would
       walk the price labels off the side of the screen.

       The dashed lines below therefore run the full canvas width rather than
       stopping at the plot — the leaf IS the ground, and a claim that stops in
       mid-air reads as a rendering fault rather than as a boundary. */
    const edgeL = 0;
    const edgeR = g.w;

    /* The advertised list, drawn as the retailer's CLAIM rather than as data:
       dashed, unmarked by any sighting, and stepping once. The whole argument
       of beat four is visible in the gap between this line and the real one. */
    const listAlpha = clamp((p - 0.5) / 0.08, 0, 1);
    if (listAlpha > 0.001) {
      ctx.save();
      ctx.globalAlpha = listAlpha;
      ctx.strokeStyle = "#b9b3a8";
      ctx.lineWidth = 1.3;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      const stepX = X(g, LIST_STEP_AT, N);
      ctx.moveTo(edgeL, Y(g, LIST_BEFORE));
      ctx.lineTo(stepX, Y(g, LIST_BEFORE));
      ctx.lineTo(stepX, Y(g, LIST_AFTER));
      ctx.lineTo(edgeR, Y(g, LIST_AFTER));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#a49d90";
      ctx.font = "700 9px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      /* Anchored to the first reading, not to the canvas edge — the label has to
         arrive on screen with the line it names, and on the strip the canvas
         edge is a kilometre off to the left. */
      ctx.fillText("ADVERTISED LIST", X(g, 0, N) + 2, Y(g, LIST_BEFORE) - 5);
      ctx.restore();
    }

    /* Your number. It arrives at beat five, and the last reading crosses it. */
    dashLine(g, Y(g, TARGET), green, clamp((p - 0.68) / 0.06, 0, 1), [2, 3], edgeL, edgeR);

    /* A wash under the line — the record having body rather than being a wire
       drawn on nothing. */
    if (count > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(X(g, 0, N), g.h - g.padB);
      for (let i = 0; i < count; i++) {
        const x = X(g, i, N);
        if (i > 0) ctx.lineTo(x, Y(g, prices[i - 1]));
        ctx.lineTo(x, Y(g, prices[i]));
      }
      ctx.lineTo(X(g, count - 1, N), g.h - g.padB);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, g.padT, 0, g.h - g.padB);
      grad.addColorStop(0, "rgba(22,163,74,.15)");
      grad.addColorStop(1, "rgba(22,163,74,0)");
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
    }

    ctx.strokeStyle = green;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    stepPath(g, prices, N, count, partial);

    /* The calendar, printed under the brass rule in the leaf's own bottom
       padding — a ruler's numbering, on the axis you are dragging. The ticks are
       MONTH BOUNDARIES, and on a date axis that is a different place from the
       first reading of each month: a ruler whose marks sit wherever a
       measurement happened to land is not a ruler, it is a list. Jan 1 falls
       five days LEFT of the first reading and is drawn there, off the plot's
       own start, which is the correct answer and the tell that the axis is time
       rather than rows.

       Labelled from the tick rightward, the way a ruler names the interval it
       opens rather than the line it is. Every month in the span is laid out,
       not only the ones reached: a rule with numbers that stop halfway is a
       broken rule, whereas a month not yet arrived at is simply ahead of you,
       which is the whole point of a time track. What HAS been recorded is
       inked; what is still ahead is faint. */
    const floor = g.h - g.padB;
    const headDay = DAY0 + clamp(p / DRAW_SPAN, 0, 1) * DAY_SPAN;
    ctx.save();
    ctx.font = "700 9px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    for (let m = 0; m < MONTHS.length; m++) {
      const day = MONTH_DAY1[m];
      if (day > DAYS[N - 1]) break;
      const x = XT(g, (day - DAY0) / DAY_SPAN);
      ctx.globalAlpha = day <= headDay ? 0.9 : 0.32;
      ctx.strokeStyle = axisInk;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, floor + 3);
      ctx.lineTo(Math.round(x) + 0.5, floor + 8);
      ctx.stroke();
      ctx.fillStyle = axisInk;
      ctx.fillText(MONTHS[m].toUpperCase(), x + 3, floor + 11);
    }
    ctx.restore();

    for (let i = 0; i < count; i++) {
      drawSighting(
        ctx,
        X(g, i, N),
        Y(g, prices[i]),
        i === count - 1 ? life : 1,
        prices[i] <= TARGET ? green : ink
      );
    }

    /* The final reading is the all-time low AND the moment the alert fires, so
       it gets a halo — the extension's own rare-moment treatment, spent once. */
    if (count === N) {
      const a = clamp((p - 0.88) / 0.08, 0, 1);
      ctx.save();
      ctx.globalAlpha = a * 0.3;
      ctx.fillStyle = green;
      ctx.beginPath();
      ctx.arc(X(g, N - 1, N), Y(g, prices[N - 1]), 5 + a * 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function paintReel(p) {
    const { count } = shownAt(p);
    const i = count - 1;
    const sightings = RECORD.slice(0, count).reduce((a, r) => a + r[2], 0);
    const met = prices[i] <= TARGET;

    drawRecord(p);

    reel.when.textContent = RECORD[i][0];
    reel.now.textContent = money(prices[i]);
    reel.typical.textContent = money(median(prices.slice(0, count)));
    reel.count.textContent = sightings.toLocaleString("en-US");
    reel.navWhen.textContent = RECORD[i][0];
    reel.navPrice.textContent = money(prices[i]);

    reel.chipSeen.classList.toggle("on", p > 0.16);
    reel.chipList.classList.toggle("on", p > 0.52);
    reel.chipList.classList.toggle("aged", p > 0.58);
    /* Only ever true at the end: 94.99 is the record's low, and a chip that
       flickered on at every interim dip would be describing something else. */
    reel.chipAtl.classList.toggle("on", count === N && p > 0.9);

    const armed = p > 0.7;
    reel.alert.classList.toggle("on", armed);
    if (armed) {
      const start = prices[0];
      const meter = clamp((start - prices[i]) / (start - TARGET), 0, 1);
      reel.alertPrice.textContent = money(prices[i]);
      reel.alertMeter.style.width = (meter * 100).toFixed(1) + "%";
      reel.alertBadge.textContent = met ? "Target met" : "Watching";
      reel.alertBadge.classList.toggle("mini-badge-quiet", !met);
      reel.alertSub.innerHTML = met
        ? 'Seen at <span class="num">' + money(prices[i]) +
          '</span> &middot; you said <span class="num">' + money(TARGET) + "</span>"
        : '<span class="num">' + money(prices[i] - TARGET) +
          '</span> above your <span class="num">' + money(TARGET) + "</span> target";
    }

    /* Both halves of the fired state live OUTSIDE the armed branch, and that is
       the whole point: a target can only be met on a card that exists, but it
       must be UNmet the moment that card goes away again. Written inside, the
       classes survived a scroll back up the track — the card stayed green under
       an unarmed watch and the sweep could never play twice, on the one moment
       the direction is built around. A state that only ever advances is not a
       scrub. `lit` is the conjunction, so the reset is the same branch as the
       set and neither can be forgotten separately.

       The knock lands the first time it is true and only then: a class that is
       merely present cannot re-fire, so it comes off on the way back up and the
       cycle + reflow gives the sweep a fresh start. */
    const lit = armed && met;
    reel.alertPrice.classList.toggle("met", lit);
    if (lit !== lastMet) {
      reel.alert.classList.remove("met");
      if (lit) {
        void reel.alert.offsetWidth;
        reel.alert.classList.add("met");
      }
      lastMet = lit;
    }

    for (const b of reel.beats) {
      const from = +b.dataset.from;
      const to = +b.dataset.to;
      b.classList.toggle("on", p >= from && p < to);
      b.classList.toggle("past", p >= to);
    }

    if (count !== lastShownCount) {
      lastShownCount = count;
      reel.footIndex.textContent = count;
      /* Only once the rail is a control does it owe anyone a value. Written
         here rather than in the drag, because the drag is not the only thing
         that moves it — the wheel does too, and a slider whose value only
         updated when dragged would read stale to a screen reader for the
         entire scroll. */
      if (railLive) {
        rail.setAttribute("aria-valuenow", String(count));
        rail.setAttribute("aria-valuetext", `Reading ${count} of ${N}, ${RECORD[count - 1][0]}, ${money(RECORD[count - 1][1])}`);
      }
    }

    /* Published for CSS: the parallax and the stage's own depth cues read this
       rather than running a second timeline that could disagree with it.

       `--rec` is the second one because the foot rail measures the RECORD and
       `--p` measures the scroll, and they part company at DRAW_SPAN — the last
       ten percent of the track is the alert being caught, with no reading left
       to add. Derived from the same expression `shownAt` opens with, so the rail
       reaching its end and the counter reaching 24 are the same event. */
    reel.stage.style.setProperty("--p", p.toFixed(4));
    reel.stage.style.setProperty("--rec", clamp(p / DRAW_SPAN, 0, 1).toFixed(4));
  }

  function reelProgress() {
    /* Under reduced motion the record is not scrubbed, it is simply finished —
       and there is no progress to report when there is no scrub. `init()`
       already paints it at 1, but the rAF loop keeps running (the hero still
       has to resolve and the CTA wire still has to draw), so without this it
       repainted the record one frame later from a track the CSS had collapsed:
       `span <= 0` falls through to the `r.top <= 0` test, which answers 0 for
       the whole time the reader is ABOVE the section. The finished state lasted
       a single frame. Everything downstream inherited it — the canvas held six
       readings instead of twenty-two, the chips and the alert card never
       arrived, and the lit beat was the first one rather than the last. */
    if (reduced.matches) return 1;
    const r = reel.track.getBoundingClientRect();
    const span = r.height - window.innerHeight;
    if (span <= 0) return r.top <= 0 ? 1 : 0;
    return clamp(-r.top / span, 0, 1);
  }

  /* ══ The rail is the handle ════════════════════════════════════════════════
     The foot's rule is a scrubber, and the single decision that makes it safe
     is that it does not scrub anything. It WRITES THE SCROLL POSITION and lets
     the same `reelProgress()` → `paintReel()` path the wheel drives do the rest.
     A scrubber that moved the record directly would be a second opinion about
     where the section is, and the two would part company the instant you let go
     — the page sitting at one reading while the record showed another, with no
     way back except scrolling until they happened to agree. This way releasing
     mid-record simply leaves the page there, because there was never anything
     else to leave. It also means every downstream consumer comes along for
     free: the beats, the chips, the alert card, the nav readout and the ground
     colour are all functions of `p`, and none of them knows a drag happened. */
  const rail = document.querySelector(".foot-rail");
  let railLive = false;

  /* Where a reading comes to rest: a short beat AFTER its mark has landed, so
     the settled pose is the newest sighting complete with the record just
     starting to run on past it.

     Under even spacing this had to be a fraction of the GAP, and a hair short of
     the next arrival — with `partial` doing double duty as the mark's own age,
     the end of the window was the only place a mark was certain to be finished.
     Now that the landing has its own fixed duration the rest point can be what
     it always wanted to be, and it stops depending on the wait that follows it:
     resting at 96% of a three-week gap would dangle the line three weeks out
     ahead of its own last mark, a different distance at every reading, on the
     one pose the section is most often looked at in. Half the gap is a ceiling
     for the same reason and never binds — the tightest here is 13 days against
     a 6.4-day beat.

     WHICH reading a release belongs to is `shownAt`'s own answer and not the
     nearest rest point, which are different questions. Let go a fifth of the way
     into reading 9 and the nearest rest is 8's — so rounding would tick the
     counter BACKWARD at the instant you let go, which reads as a correction
     rather than a settle. Deferring to `shownAt` means the number under your
     finger is the number you get, and the throw always FINISHES the mark you
     were watching arrive. It also leaves one definition of what is on screen
     instead of an inverse that could drift from it. */
  const SETTLE = ARRIVE_SPAN * 1.6;
  const readingP = (k) => {
    const i = clamp(k, 1, N) - 1;
    const to = i + 1 < N ? AT[i + 1] : 1;
    return DRAW_SPAN * Math.min(AT[i] + SETTLE, AT[i] + (to - AT[i]) / 2, 1);
  };

  /* How far a flick carries, in milliseconds of the hand's own velocity. */
  const THROW_MS = 130;

  function trackY(p) {
    const r = reel.track.getBoundingClientRect();
    const span = r.height - window.innerHeight;
    if (span <= 0) return null;
    /* `r.top` and `scrollY` come from the same layout, so their sum is the
       track's document-space top whether or not a smooth scroll is in flight. */
    return window.scrollY + r.top + clamp(p, 0, 1) * span;
  }

  function railSeek(p) {
    const y = trackY(p);
    if (y == null) return;
    /* `force` because a settle from a previous release may still be running and
       Lenis locks itself for the duration of one. */
    if (window.JD?.lenis) window.JD.lenis.scrollTo(y, { immediate: true, force: true });
    else window.scrollTo(0, y);
  }

  function railSettle(p, dur) {
    const y = trackY(p);
    if (y == null) return;
    if (window.JD?.lenis)
      window.JD.lenis.scrollTo(y, { duration: dur, easing: (t) => 1 - Math.pow(1 - t, 3), force: true });
    else window.scrollTo({ top: y, behavior: "smooth" });
  }

  function wireRail() {
    /* Under reduced motion `reelProgress()` answers 1 unconditionally and the
       CSS has collapsed the track — there is no scrub to scrub, so the foot
       stays what it is on a no-JS page: furniture. */
    if (!rail || !reel.foot || !reel.track || reduced.matches) return;
    railLive = true;
    rail.classList.add("live");
    rail.setAttribute("role", "slider");
    rail.setAttribute("tabindex", "0");
    rail.setAttribute("aria-label", "Scrub the record");
    rail.setAttribute("aria-valuemin", "1");
    rail.setAttribute("aria-valuemax", String(N));
    /* The container is hidden from the tree and the two text spans stay hidden,
       so exposing the control does not also announce an arrow glyph and a
       counter that the slider's own `aria-valuetext` already says better. */
    reel.foot.removeAttribute("aria-hidden");
    for (const el of reel.foot.querySelectorAll(".foot-span, .foot-read")) el.setAttribute("aria-hidden", "true");
    lastShownCount = 0; // force the first aria write

    let dragging = false;
    let grabDx = 0;
    const samples = [];

    const railF = (clientX) => {
      const r = rail.getBoundingClientRect();
      return r.width > 0 ? clamp((clientX - r.left - grabDx) / r.width, 0, 1) : 0;
    };
    /* The rail measures the RECORD, so its full width is DRAW_SPAN of the
       track — the same split `--rec` is derived from. */
    const seekF = (f) => railSeek(f * DRAW_SPAN);

    rail.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      const r = rail.getBoundingClientRect();
      if (r.width <= 0) return;
      /* Pressing ON the nib keeps its offset so the handle does not jump out
         from under the finger; pressing anywhere else is a seek, which is what
         a rail is for. 15px is the nib's dot plus its ring plus a little. */
      const nibX = r.left + clamp(reelProgress() / DRAW_SPAN, 0, 1) * r.width;
      grabDx = Math.abs(e.clientX - nibX) <= 15 ? e.clientX - nibX : 0;
      dragging = true;
      samples.length = 0;
      samples.push({ x: e.clientX, t: e.timeStamp });
      rail.setPointerCapture(e.pointerId);
      rail.classList.add("grabbing");
      reel.section.classList.add("moved"); // the hint has done its job
      seekF(railF(e.clientX));
      /* Suppresses the text selection a drag across the foot would otherwise
         make. It also suppresses focus, hence the explicit call. */
      e.preventDefault();
      rail.focus({ preventScroll: true });
    });

    rail.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      samples.push({ x: e.clientX, t: e.timeStamp });
      if (samples.length > 8) samples.shift();
      seekF(railF(e.clientX));
    });

    const release = (e) => {
      if (!dragging) return;
      dragging = false;
      rail.classList.remove("grabbing");
      if (rail.hasPointerCapture(e.pointerId)) rail.releasePointerCapture(e.pointerId);

      /* Velocity over the last ~110ms rather than off the final event: one
         event is a single frame's delta, sampled at the exact moment the hand
         is decelerating to let go, so it reads near zero on a genuine flick. */
      const last = samples[samples.length - 1] || { x: e.clientX, t: e.timeStamp };
      const first = samples.find((s) => last.t - s.t <= 110) || last;
      const vx = last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
      const w = rail.getBoundingClientRect().width || 1;
      const projected = clamp(railF(last.x) + (vx * THROW_MS) / w, 0, 1);

      /* Always lands on a reading. A record is a sequence of sightings, not a
         continuum, and a throw that stopped between two of them would leave a
         half-drawn mark as the resting state of the whole section. */
      const target = readingP(shownAt(projected * DRAW_SPAN).count);
      const travel = Math.abs(target - reelProgress()) / DRAW_SPAN;
      railSettle(target, clamp(0.3 + travel * 1.5, 0.3, 0.95));
    };
    rail.addEventListener("pointerup", release);
    rail.addEventListener("pointercancel", release);

    rail.addEventListener("keydown", (e) => {
      const k = shownAt(reelProgress()).count;
      let next = null;
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = k - 1;
      else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = k + 1;
      else if (e.key === "PageDown") next = k - 4;
      else if (e.key === "PageUp") next = k + 4;
      else if (e.key === "Home") next = 1;
      else if (e.key === "End") next = N;
      if (next == null) return;
      e.preventDefault();
      reel.section.classList.add("moved");
      railSettle(readingP(clamp(next, 1, N)), 0.34);
    });

    /* Tabbing here from the top of the page focuses a control on a section that
       is not on screen — and the foot itself is invisible until the record
       starts (`--p * 14`). Bring the record to its first reading so the thing
       that just took focus is the thing you can see and operate. */
    rail.addEventListener("focus", () => {
      if (dragging) return;
      if (reelProgress() < readingP(1)) {
        reel.section.classList.add("moved");
        railSettle(readingP(1), 0.5);
      }
    });
  }

  /* ══ Hero: the night sky ═══════════════════════════════════════════════════
     A wire strung across the frame that IS the record — the same twenty-four
     readings the pinned section below plays out, drawn full-bleed instead of
     inside a panel — and the flock arriving to become its marks.

     THE METAPHOR AND THE MARK ARE ONE OBJECT. A bird flies in, brakes, folds
     its wings, and what is left standing on the wire is the price point. That
     is the same move `drawSighting` makes at 4px inside the charts; this is it
     at hero scale and roughly six times slower, which is the owner's stated
     preference for hero moments and the only reason it reads as choreography
     rather than as a transition.

     EVERYTHING MEASURES OFF ONE FUNCTION. `wireY(x)` is the wire's actual
     height at an x — step, sag, the dip under each perched bird, the lean
     toward the cursor — and the birds, the tag's string and the wire's own
     stroke all read from it. Nothing here is positioned by a number that was
     eyeballed against a screenshot; the tag hangs where the wire is, and when
     a bird lands and the wire gives under it, the tag drops with it. */

  const sky = $("heroSky");
  const heroEl = document.querySelector(".hero");
  const tagEl = $("heroTag");

  /* The verified silhouette, lifted path-for-path from the nav's flight SVG
     rather than redrawn — it is the one piece of artwork in this project that
     was built from real jackdaw references after four attempts from memory
     failed, and a second freehand version would fail the same way. viewBox is
     0..100 with the body on the y=50 axis, head at +x, tail at −x. */
  const BIRD_W = new Path2D(
    "M63 45.6 C61.5 34 56.5 19.5 49.5 6.5 L46.2 15.2 L42.8 10.2 L41.2 19.4 L37.4 16.4 L36.8 25.8 L32.8 24.2 L34 33.2 C38.4 38.4 43 42.4 46 45.6 Z" +
      "M63 54.4 C61.5 66 56.5 80.5 49.5 93.5 L46.2 84.8 L42.8 89.8 L41.2 80.6 L37.4 83.6 L36.8 74.2 L32.8 75.8 L34 66.8 C38.4 61.6 43 57.6 46 54.4 Z"
  );
  const BIRD_T = new Path2D("M38 47 L23 41.4 L25.4 45.8 L20.6 44.8 L23.2 48.8 L19.2 50 L23.2 51.2 L20.6 55.2 L25.4 54.2 L23 58.6 L38 53 Z");
  const BIRD_B = new Path2D("M79 50 C73.5 46.2 67 44.8 59 44.6 C51 44.4 43 45.6 37.5 47.2 L37.5 52.8 C43 54.4 51 55.6 59 55.4 C67 55.2 73.5 53.8 79 50 Z");

  const HERO_LO = Math.min(...prices);
  const HERO_HI = Math.max(...prices);
  /* Deterministic per-index jitter — a bird's entry height and phase have to be
     the same on every frame or it teleports, and `Math.random()` inside a draw
     loop is exactly how that happens. Same fract-of-a-big-sine trick the CTA
     wire uses. */
  const jit = (i, k) => {
    const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };

  const START = 460;
  const STAGGER = 74;
  const smooth = (t) => t * t * (3 - 2 * t);

  /* One entry per reading. `perch` is how much of this bird's weight the wire is
     currently carrying — 0 in the air, 1 settled — and it is what couples the
     flock to the wire's shape. */
  const flock = RECORD.map((r, i) => ({
    i,
    label: r[0],
    price: r[1],
    /* Earlier birds have further to travel from the right-hand edge, so they get
       longer in the air. Equal durations would make the leftmost one cross the
       whole frame at a sprint while the rightmost drifted in. */
    dur: 1360 - (i / (N - 1)) * 520,
    at: START + i * STAGGER,
    perch: 0,
    flick: -1e9,
  }));

  let sky2d = null;
  let skyW = 0;
  let skyH = 0;
  let xs = [];
  let ysBase = [];
  let dxStep = 1;
  /* THE WIRE'S SHAPE IS MEASURED IN READINGS, NOT IN PIXELS. Every one of these
     started life as a constant tuned at 1440 — a 13px step roll, a 4.6px
     scallop, a 58px sag radius, a 140px cutoff — and every one of them was
     really `dxStep` at that width times a ratio. `dxStep` is 58.2 at 1440 and
     12.2 at 375, so a figure held constant in px is a figure that quadruples
     relative to the thing it is shaping. Recomputed in measureSky; see there
     for what each ratio was measured at. */
  let stepEase = 13;
  let scallop = 4.6;
  let sagR = 58;
  let sagCut = 140;
  let heroPtr = null;
  let nextFlick = 0;

  /* The pointer in CLIENT coordinates, shared by every perched flock. Kept
     unconverted on purpose: the CTA canvas and the how-it-works rule both
     scroll, so a position converted once in the pointer handler goes stale the
     moment the page moves under a stationary cursor — a bird would think you
     had walked away because you scrolled. Each `measure*` converts it against
     the rect it is already reading that frame, so this costs no extra layout.

     Null on a coarse pointer. A touch device has no hover state to leave, so
     the last tap would freeze the nearest birds mid-turn forever; and the whole
     gesture is `(hover: hover) and (pointer: fine)` by the house motion rule. */
  let ptrClient = null;
  const ptrFine = window.matchMedia("(hover: hover) and (pointer: fine)");

  function noticePointer(e) {
    /* Re-checked per event rather than once at startup, because a hybrid laptop
       answers this differently depending on which input the visitor last used —
       and a stylus tap on a touchscreen should not leave three heads turned. */
    ptrClient = ptrFine.matches ? { x: e.clientX, y: e.clientY } : null;
  }

  /* ── Noticing ──────────────────────────────────────────────────────────────
     A perched bird turns toward the cursor as it passes and drifts back. Two
     numbers per bird, because one cannot carry it: a bird directly under the
     pointer has maximum attention and zero lean, so a single signed value would
     have the closest bird — the one that should react most — doing nothing.

     `noticeA` (0..1) is how much it has noticed: `drawPerched` spends it on a
     yaw, foreshortening the profile as the body swivels to face you. `noticeD`
     (-1..1) is which way, spent on a crane about the feet.

     NEAREST THREE ONLY, and that is the difference between attention and
     tracking. A falloff alone makes the whole wire respond in a smooth hump
     that follows the cursor — which reads as a wave passing through furniture,
     not as animals noticing something. Three is what the eye can follow as
     individuals. */
  const NOTICE_REACH = 118;
  const NOTICE_NEAR = 3;

  function updateNotice(list, ptr, yOf) {
    /* Ranked FIRST, then smoothed for everyone — including the birds that just
       fell out of the three. A bird dropped from the ranking has to decay from
       whatever it was holding; zeroing it on the spot would snap a head round
       the instant a neighbour got closer, which is the one artefact that would
       give the whole effect away. */
    let want = null;
    if (ptr) {
      want = new Map(
        list
          .filter((b) => b.perch > 0.02)
          .map((b) => [b, Math.hypot(ptr.x - b.x, ptr.y - yOf(b))])
          .sort((p, q) => p[1] - q[1])
          .slice(0, NOTICE_NEAR)
      );
    }
    for (const b of list) {
      /* `|| 0` is the initialisation, deliberately here rather than in the two
         flock constructors: it makes the function total over any list of birds,
         so a third flock cannot arrive with the fields missing and hand a NaN
         to a canvas transform — which does not throw, it just silently stops
         drawing the bird. */
      const a0 = b.noticeA || 0;
      const d0 = b.noticeD || 0;
      const d = want ? want.get(b) : undefined;
      /* Gaussian, the same shape the hero wire's own cursor lean uses, so the
         two cursor responses on the page are one falloff at two scales. */
      const aim = d === undefined ? 0 : Math.exp(-((d / NOTICE_REACH) ** 2));
      const dir = d === undefined ? 0 : clamp((ptr.x - b.x) / (NOTICE_REACH * 0.55), -1, 1);
      /* Rise fast, drift back slow — attention is caught, not faded into — and
         each bird a shade different so the three never move as one object. The
         lean is slower than the notice on purpose: the turn comes first and the
         body follows, which is the lag that makes it read as a living thing
         rather than as a slaved parameter. */
      const k = (aim > a0 ? 0.13 : 0.045) + (b.i % 3) * 0.012;
      b.noticeA = a0 + (aim - a0) * k;
      b.noticeD = d0 + (dir * aim - d0) * (k * 0.62);
      if (b.noticeA < 0.002) b.noticeA = 0;
    }
  }

  /* The band is DECLARED IN CSS and read here, never passed the other way —
     `.hero` owns `--wire-base` and `--wire-rise` and the copy's bottom padding
     is computed from the same two values, so the type and the wire cannot drift
     apart at a viewport nobody tested. Same single-owner rule `.panel-chart`'s
     height follows. */
  function measureSky() {
    if (!sky || !heroEl) return false;
    const w = sky.clientWidth;
    const h = sky.clientHeight;
    if (!w || !h) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (sky.width !== Math.round(w * dpr) || sky.height !== Math.round(h * dpr)) {
      sky.width = Math.round(w * dpr);
      sky.height = Math.round(h * dpr);
    }
    sky2d = sky.getContext("2d");
    sky2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    skyW = w;
    skyH = h;

    const cs = getComputedStyle(heroEl);
    const base = parseFloat(cs.getPropertyValue("--wire-base")) || 224;
    const rise = parseFloat(cs.getPropertyValue("--wire-rise")) || 130;
    const yLow = h - base;

    /* The record starts off-frame left because eight months is not where the
       part's life began. Where it ENDS is not a taste number and must not be
       one: the tag hangs centred on the last reading, so the last reading has
       to sit at least half a card in from the edge or the hero's `overflow:
       hidden` shaves the card's corner off. Measured at 1440 with a hardcoded
       0.90: the card's box ran to 1426 in a 1425 viewport.

       So the CARD is the owner of that number — same single-owner rule as
       `--wire-base`, in the other direction. Its width is declared in CSS
       (and changes under two media queries), read here, never passed in. The
       26px is the rotation swing plus a breath: the card sways ±1.15° about an
       origin above itself, which pushes its lower corner further out than its
       layout box suggests.

       What fills the gap that leaves is the price holding flat, which is not
       padding: a price holds until somebody sees it change, so a flat run out
       toward the edge is the most accurate thing that could be there. */
    const cardEl = tagEl && tagEl.querySelector(".tag-card");
    const rightPad = cardEl ? cardEl.offsetWidth / 2 + 26 : 130;
    const xEnd = Math.max(0.6 * w, w - rightPad);
    const xStart = -0.02 * w;
    xs = [];
    ysBase = [];
    for (let i = 0; i < N; i++) {
      xs.push(xStart + (i * (xEnd - xStart)) / (N - 1));
      ysBase.push(yLow - ((prices[i] - HERO_LO) / (HERO_HI - HERO_LO)) * rise);
    }
    dxStep = xs[1] - xs[0];
    /* The four ratios, each recovered from the figure it replaces by dividing
       through the 58.2px `dxStep` the originals were tuned against at 1440.
       Two are capped rather than purely proportional, because they describe the
       wire itself and not the record's density: a scallop deeper than 4.6px and
       a step rolled over more than 13px both stop reading as a wire however far
       apart the readings are. The sag radius has no cap on purpose — a bird's
       weight should always spread over about one reading interval, which is
       what keeps the flock's total pull on the last reading at ~9.4px instead
       of the 31.9px it reached at 375, where twelve birds fell inside a fixed
       58px Gaussian and dragged the tag through the bottom of the frame. */
    stepEase = Math.min(13, dxStep * 0.223);
    scallop = Math.min(4.6, dxStep * 0.079);
    sagR = dxStep;
    sagCut = dxStep * 2.4;
    return true;
  }

  /* A price holds until somebody sees it change, so this is a step and not a
     slope — same rule the charts obey. The change is rolled over a fifth of the
     run rather than drawn as a bare vertical because this one is also a
     physical wire, and a fifth still reads as a step from any distance a
     visitor will ever see it from. A fifth and not 13px: held at 13 the roll
     ate a whole reading interval at 375 and the staircase melted into a
     squiggle. The honest hard-edged version is drawn four times over on the
     page below. */
  function stepY(x) {
    if (x <= xs[0]) return ysBase[0];
    if (x >= xs[N - 1]) return ysBase[N - 1];
    let i = Math.ceil((x - xs[0]) / dxStep);
    if (i < 1) i = 1;
    if (i > N - 1) i = N - 1;
    const a = ysBase[i - 1];
    const b = ysBase[i];
    if (a === b) return a;
    const t = (x - (xs[i] - stepEase)) / stepEase;
    return t <= 0 ? a : a + (b - a) * smooth(clamp(t, 0, 1));
  }

  /* Everything that bends the wire, in one place: its own weight between
     readings, the birds standing on it, and a lean toward the cursor. Summed
     rather than switched between, so a bird landing next to the pointer dips
     the wire by both amounts and neither effect has to know the other exists. */
  function sagY(x, t) {
    const u = (x - xs[0]) / dxStep;
    let s = scallop * Math.sin(Math.PI * clamp(u - Math.floor(u), 0, 1));
    for (let k = 0; k < N; k++) {
      const b = flock[k];
      if (b.perch <= 0.01) continue;
      const d = x - xs[k];
      if (d < -sagCut || d > sagCut) continue;
      const g = Math.exp(-((d / sagR) * (d / sagR)));
      s += b.perch * 6.8 * g;
      /* A wing-flick unloads the wire and it springs — the neighbour reacting
         causally, which is what stops the idle reading as decoration. */
      const age = t - b.flick;
      if (age >= 0 && age < 900) {
        s -= g * 5.4 * Math.sin((age / 900) * Math.PI * 3) * (1 - age / 900);
      }
    }
    if (heroPtr) {
      const d = x - heroPtr.x;
      if (d > -190 && d < 190) {
        const near = clamp(1 - Math.abs(heroPtr.y - stepY(x)) / 150, 0, 1);
        s += near * 5 * Math.exp(-((d / 96) * (d / 96)));
      }
    }
    return s;
  }

  const wireY = (x, t) => stepY(x) + sagY(x, t);

  /* Flight. A cubic from off-frame right onto the perch, with the second
     control point placed up and to the RIGHT of the target so the approach is a
     descent onto the wire rather than a slide along it. */
  function flightAt(b, e, t) {
    const tx = xs[b.i];
    const ty = wireY(tx, t) - 3.4;
    const sx = skyW + 110 + jit(b.i, 1) * 190;
    const sy = ty - 170 - jit(b.i, 2) * 260;
    const p1x = sx + (tx - sx) * 0.32;
    const p1y = sy + (ty - sy) * 0.04;
    const p2x = tx + 130 + jit(b.i, 3) * 70;
    const p2y = ty - 92;
    const m = 1 - e;
    const a = m * m * m;
    const bb = 3 * m * m * e;
    const c = 3 * m * e * e;
    const d = e * e * e;
    const x = a * sx + bb * p1x + c * p2x + d * tx;
    const y = a * sy + bb * p1y + c * p2y + d * ty;
    /* Heading comes from the derivative of the curve it is actually flying, not
       from the straight line between endpoints — a bird banking into a turn
       while pointing at its destination is the tell. */
    const da = 3 * m * m;
    const db = 6 * m * e;
    const dc = 3 * e * e;
    const vx = da * (p1x - sx) + db * (p2x - p1x) + dc * (tx - p2x);
    const vy = da * (p1y - sy) + db * (p2y - p1y) + dc * (ty - p2y);
    return { x, y, tx, ty, ang: Math.atan2(vy, vx) };
  }

  /* Wings drawn first so the body overlaps their roots, and the fold is a
     vertical squash about the body axis rather than a fade — an overhead bird
     folding its wings foreshortens, it does not become transparent.

     `ang` IS the heading and the artwork is simply drawn along it. There used
     to be a `scale(-1, 1)` here, on the reasoning that the artwork faces +x
     while the flock flies −x — but `rotate(ang)` has already turned the artwork
     onto its heading by the time the mirror runs, so the mirror was turning it
     straight back: EVERY FLYING BIRD ON THIS PAGE FLEW TAIL-FIRST, hero, CTA
     and `how` alike, and the three perched wing-flicks were drawn facing away
     from the bodies underneath them. It survived because the silhouette is
     symmetric about its own axis, so the reversal is legible only at the two
     ends — a smooth head pod against a jagged tail fan, 24–34px, moving.

     Measured rather than eyeballed, which is the only reason it was ever
     caught: at ang = π the beak mapped to x +6.96 against the tail's −7.39, so
     the head led RIGHT while the bird travelled left, and a pose sheet drawn
     with the body and the tail fan in different colours showed the fan swept
     forward. With the mirror gone the heading and the ink agree in every
     direction, which is also what lets the CTA flock come in over both edges
     without a second facing convention to keep in step. */
  function drawBird(ctx, x, y, ang, size, spread, alpha) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    const s = size / 100;
    ctx.scale(s, s);
    ctx.translate(-50, -50);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = ink;
    if (spread > 0.02) {
      ctx.save();
      ctx.translate(0, 50);
      ctx.scale(1, spread);
      ctx.translate(0, -50);
      ctx.fill(BIRD_W);
      ctx.restore();
    }
    ctx.fill(BIRD_T);
    ctx.fill(BIRD_B);
    ctx.restore();
  }

  function drawSky(elapsed, t) {
    if (!measureSky()) return false;
    const ctx = sky2d;
    ctx.clearRect(0, 0, skyW, skyH);

    /* Perch state first, because the wire's shape depends on it and every other
       measurement in the frame depends on the wire. */
    let landed = 0;
    for (const b of flock) {
      const e = clamp((elapsed - b.at) / b.dur, 0, 1);
      b.e = e;
      b.perch = e >= 1 ? 1 : e > 0.9 ? smooth((e - 0.9) / 0.1) : 0;
      if (e >= 1) landed++;
    }

    /* The wire, sampled off the same function the birds stand on. Two passes:
       a wide soft one for the glow the lamp would throw on a taut line, then
       the line itself. */
    const STEPS = Math.max(120, Math.round(skyW / 5));
    const trace = () => {
      ctx.beginPath();
      for (let k = 0; k <= STEPS; k++) {
        const x = -40 + ((skyW + 80) * k) / STEPS;
        const y = wireY(x, t);
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    };
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    trace();
    ctx.strokeStyle = gridLine;
    ctx.lineWidth = 5;
    ctx.stroke();
    trace();
    ctx.strokeStyle = axisInk;
    ctx.lineWidth = 1.15;
    ctx.stroke();

    /* The run the record has actually reached is struck in the accent — the
       line assembles from its readings rather than being drawn on ahead of
       them, so what you see at any instant is only what has been observed. */
    if (landed > 1) {
      const x1 = xs[landed - 1];
      const seg = Math.max(24, Math.round((x1 - xs[0]) / 5));
      const runPath = () => {
        ctx.beginPath();
        for (let k = 0; k <= seg; k++) {
          const x = xs[0] - 40 + ((x1 - xs[0] + 40) * k) / seg;
          const y = wireY(x, t);
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      };

      /* THE BODY UNDER THE RUN, and it is doing a compositional job rather than
         a decorative one: without it the lower third of the frame is an empty
         gradient with a hairline across it, and the hero reads as copy floating
         above nothing. Measured on the first full-frame screenshot — 8,766
         painted pixels on a 1425×900 canvas, most of them the 8%-white glow.

         Kept to 0.10 at the wire and gone by the bottom edge, so it is the lit
         floor under a wire and never a filled area chart. The top stop is taken
         from the run's own highest point, not from 0, so the ramp is the same
         steepness whatever the price range does — a gradient anchored at the
         canvas top would flatten to nothing on a shallow record. */
      let top = skyH;
      for (let k = 0; k <= seg; k++) top = Math.min(top, wireY(xs[0] - 40 + ((x1 - xs[0] + 40) * k) / seg, t));
      runPath();
      ctx.lineTo(x1, skyH);
      ctx.lineTo(xs[0] - 40, skyH);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, top, 0, skyH);
      g.addColorStop(0, withAlpha(green, 0.1));
      g.addColorStop(0.55, withAlpha(green, 0.028));
      g.addColorStop(1, withAlpha(green, 0));
      ctx.fillStyle = g;
      ctx.fill();

      runPath();
      ctx.strokeStyle = green;
      ctx.lineWidth = 1.9;
      ctx.stroke();
    }

    for (const b of flock) {
      if (b.e <= 0) continue;
      const px = xs[b.i];
      const py = wireY(px, t);

      if (b.e < 1) {
        const f = flightAt(b, easeOut(b.e), t);
        /* Three phases in the wings, which is what makes the landing read as a
           landing: beating on the way in, held wide open through the flare, then
           folded away as the mark takes over. */
        let spread;
        if (b.e < 0.72) spread = 0.3 + 0.7 * Math.abs(Math.sin(t / 62 + b.i * 1.9));
        else if (b.e < 0.9) spread = lerp(0.3 + 0.7 * Math.abs(Math.sin(t / 62 + b.i * 1.9)), 1, smooth((b.e - 0.72) / 0.18));
        else spread = 1 - smooth((b.e - 0.9) / 0.1);
        const size = lerp(30, 15, smooth(clamp((b.e - 0.78) / 0.22, 0, 1)));
        drawBird(ctx, f.x, f.y, f.ang, size, spread, clamp(b.e * 6, 0, 1));
      }

      /* Settled: the mark. Its own phase on the breathe so the flock reads as
         many small living things, and a flick every so often — never two at
         once, and never on a beat you could predict. */
      if (b.perch > 0.02) {
        const age = t - b.flick;
        const flicking = age >= 0 && age < 620;
        const bob = Math.sin(t / 1120 + b.i * 2.3) * 0.7;
        if (flicking) {
          const u = age / 620;
          drawBird(ctx, px, py - 3.4 - bob - Math.sin(u * Math.PI) * 5, Math.PI, 15, Math.sin(u * Math.PI) * 0.8, b.perch);
        }
        const r = 2.5 + b.perch * 0.6;
        ctx.globalAlpha = b.perch;
        ctx.fillStyle = b.i === N - 1 ? green : ink;
        ctx.beginPath();
        ctx.arc(px, py - 1.4 - bob, flicking ? r * 0.55 : r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    /* The newest reading is the one the tag hangs from, so its position is
       measured — not authored — every frame. The wire gives under the flock and
       leans toward the cursor, and a tag that stayed put while its own anchor
       moved would read as pasted on. */
    if (tagEl && landed >= 1) {
      const tx = xs[N - 1];
      tagEl.style.setProperty("--tag-x", tx.toFixed(1) + "px");
      tagEl.style.setProperty("--tag-y", (wireY(tx, t) - 1).toFixed(1) + "px");
    }

    if (landed === N && t > nextFlick) {
      /* Rare, staggered, one at a time — the header icons' rule. A flock that
         all twitched together would be a loading spinner. */
      const pick = flock[Math.floor(jit(Math.round(t / 97), 7) * N)];
      if (pick) pick.flick = t;
      nextFlick = t + 2600 + jit(Math.round(t / 53), 9) * 5200;
    }
    return landed === N;
  }

  /* The tag's figures are read off the same array the wire is drawn from. Typed
     into the markup a second time they would eventually disagree with the line
     they are hanging from, and the one thing this page cannot afford is a
     number on screen that its own picture contradicts. */
  function fillTag() {
    if (!tagEl) return;
    const priceEl = tagEl.querySelector(".tag-price");
    const deltaEl = tagEl.querySelector(".tag-delta .num");
    if (priceEl) priceEl.textContent = money(prices[N - 1]);
    if (deltaEl) deltaEl.textContent = money(prices[0] - prices[N - 1]);
    const reads = $("tagReads");
    /* Held until the tag has actually arrived — a number counting up inside a
       card that is still swinging in reads as two things competing. */
    if (reads) setTimeout(() => countUp(reads, RECORD[N - 1][2]), reduced.matches ? 0 : 3700);
  }

  function heroPointer(e) {
    if (!sky) return;
    const r = sky.getBoundingClientRect();
    if (e.clientY < r.top || e.clientY > r.bottom) {
      heroPtr = null;
      return;
    }
    heroPtr = { x: e.clientX - r.left, y: e.clientY - r.top };
    /* The laminate catches the lamp from wherever the pointer is. It is the
       cheapest possible tell that the tag is a physical object under a light
       rather than a rectangle with a gradient painted on it. */
    if (tagEl) {
      const a = 96 + (heroPtr.x / Math.max(1, r.width)) * 62;
      tagEl.style.setProperty("--sheen-a", a.toFixed(1) + "deg");
    }
  }

  /* ══ Feature chart ═════════════════════════════════════════════════════════
     THE SAME PART, THE SAME EIGHT MONTHS. It used to carry a series of its own —
     a second table, near enough to the record's to read as the same product and
     different enough that the two were quietly contradicting each other about
     it: a different last price, a different low, open-box units at dates the
     record has no reading for. Nobody would have caught it, which is exactly the
     kind of thing this page cannot afford, since its whole argument is that the
     numbers came from somewhere.

     So they are read off `RECORD` now, and the fourth column exists for this.
     `FTYP` is the median of what has been seen, which is also what the record's
     own TYPICAL figure lands on — one number, one derivation. */
  const FS = RECORD.map((r) => r[1]);
  const FOB = RECORD.map((r) => r[3]);
  const FTYP = median(FS);
  const fCanvas = $("fchart");
  const fPulse = $("fpulse");

  /* ══ Printed on the leaf ═══════════════════════════════════════════════════
     THIS CHART IS NOT A CARD ON THE LEDGER, IT IS PLOTTED ONTO IT. No panel, no
     canvas background, no gridlines of its own: the paper's ruling is the grid,
     which is the entire reason ruled stock exists. That only survives contact
     with a real page if the ticks land ON the rules, so the geometry is derived
     from the ruling instead of from the box —

       · THE DOMAIN IS THE TICK RANGE, walked outward until it brackets the
         data. `niceTicks` returns ticks strictly INSIDE what it is given, so
         the extremes can otherwise sit outside the outermost tick and the axis
         ends up labelling lines the data crosses.
       · THE PLOT HEIGHT IS A WHOLE NUMBER OF PITCHES per tick interval, so every
         tick is a rule and every other rule is a labelled one — which is how a
         person actually uses ruled paper.
       · padT ABSORBS THE CANVAS'S PHASE against the section, measured after the
         height is set because the height is what moves it. padB takes the
         remainder, so the plot keeps its exact height whatever the phase was.

     The pitch is read from the cascade, not written twice. And `art-drift` is
     off for this panel (styles.css): a printed figure that slides over its own
     stock as you scroll is not printed on it. */
  function ledgerFrame(canvas, dLo, dHi) {
    const pad = (dHi - dLo) * 0.16;
    /* `niceTicks` hands back DESCENDING ticks — it ends on `.reverse()`, because
       drawGrid walks top-to-bottom. Extending them therefore has to walk the
       array from both ends the other way round; the first draft read ticks[1] -
       ticks[0] as the step, got a NEGATIVE one, and each pass pushed both ends
       further from the condition that was meant to stop it. Two unbounded loops,
       no error, renderer wedged. So: work ascending, extend ascending, and put
       the array back the way its producer promised. */
    const asc = niceTicks(dLo - pad, dHi + pad, 4).slice().sort((a, b) => a - b);
    const step = asc.length > 1 ? asc[1] - asc[0] : 0;
    /* A single-tick or degenerate answer has no step to extend BY, and the loops
       below are the one place in the file where a bad number costs the frame
       rather than the pixel. Guard the value, and bound the count regardless. */
    if (step > 0) {
      for (let i = 0; i < 24 && asc[0] > dLo; i++) asc.unshift(+(asc[0] - step).toFixed(10));
      for (let i = 0; i < 24 && asc[asc.length - 1] < dHi; i++)
        asc.push(+(asc[asc.length - 1] + step).toFixed(10));
    }
    const ticks = asc.reverse();

    const pitch =
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ledger-pitch")) || 30;
    const gaps = Math.max(1, ticks.length - 1);
    const padT0 = 12;
    const padB0 = 22;
    /* Rules per tick interval, chosen so the plot lands near 210px rather than
       being fixed at one value: if the series ever changes tick count the figure
       stays a figure instead of becoming a squat band or a tower. */
    const span = clamp(Math.round(210 / (gaps * pitch)), 1, 3);
    const plotH = gaps * pitch * span;
    /* One spare pitch of box, which is what padT has to move within. */
    const boxH = padT0 + plotH + padB0 + pitch;
    if (Math.abs(canvas.clientHeight - boxH) > 0.5) canvas.style.height = boxH + "px";

    const host = canvas.closest('[data-ground="paper"]');
    let padT = padT0;
    if (host) {
      const hr = host.getBoundingClientRect();
      /* Border box vs padding box: `::before { inset: 0 }` is laid against the
         padding box, so a section that ever grows a top border would shift the
         ruling and not the rect. clientTop is that border, and it is 0 today. */
      const off = canvas.getBoundingClientRect().top - (hr.top + host.clientTop);
      /* Rule k covers [k·pitch, k·pitch+1) in section space, so its centre is at
         +0.5. Landing the tick on the centre rather than the leading edge is the
         difference between a tick sitting on a rule and sitting just above one. */
      padT = padT0 + ((((0.5 - off - padT0) % pitch) + pitch) % pitch);
    }
    return { ticks, padT, padB: boxH - padT - plotH, bare: true };
  }

  function drawFeature(progress) {
    if (!fCanvas) return;
    const all = FS.concat(FOB.filter((v) => v !== null)).concat([FTYP]);
    const frame = ledgerFrame(fCanvas, Math.min(...all), Math.max(...all));
    /* Descending, so the LAST entry is the axis floor. Reading ticks[0] as `lo`
       fed geom an inverted range and Y() would have plotted the series upside
       down — the same wrong assumption as the loop above, one line apart. */
    const g = geom(fCanvas, frame.ticks[frame.ticks.length - 1], frame.ticks[0], { ...frame, at: AT });
    if (!g) return;
    const { ctx } = g;
    drawGrid(g);

    const n = FS.length;
    /* Revealed along the DATE axis, by the same function the record is scrubbed
       with — so the miniature fills at the pace the part was actually seen at,
       and no fraction of the story can put a different number of marks in the
       two figures. It was `round(progress * n)` while the spacing was even, and
       that is the other half of why this one read as a staircase too: evenly
       spaced marks revealed at an even rate is a metronome twice over. */
    const shown = shownAt(clamp(progress, 0, 1) * DRAW_SPAN);
    const count = progress <= 0.001 ? 0 : shown.count;
    dashLine(g, Y(g, FTYP), "#cbd0d8", clamp((progress - 0.14) / 0.2, 0, 1), [3, 4]);

    if (count > 1) {
      /* A wash under the line, at a little over half the record's weight. This
         figure is printed straight onto the ruling with no panel of its own, so
         with nothing beneath it the series reads as a wire lying across the page
         rather than as a quantity standing on it. Kept light because the ruling
         has to stay legible through it — a reading aid drawn over a reading aid.

         The area's own top edge is the step, not a slope: filling under an
         interpolation would put shading over dates nobody read. */
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(X(g, 0, n), g.h - g.padB);
      for (let i = 0; i < count; i++) {
        const x = X(g, i, n);
        if (i > 0) ctx.lineTo(x, Y(g, FS[i - 1]));
        ctx.lineTo(x, Y(g, FS[i]));
      }
      ctx.lineTo(X(g, count - 1, n), g.h - g.padB);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, g.padT, 0, g.h - g.padB);
      grad.addColorStop(0, withAlpha(green, 0.13));
      grad.addColorStop(1, withAlpha(green, 0));
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = green;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      stepPath(g, FS, n, count, shown.partial);
    }

    /* Open box is a scatter, not a line: each one is a single returned unit at a
       single store, and joining them across dates would assert a series that
       does not exist. Same reason the extension keeps the unit count off the
       price chart.

       The drop to the shelf price on the SAME day is assertable, and it is the
       only thing the amber is really for: one part, one reading, two prices, and
       the gap between them is what the copy is talking about. A hairline at a
       third of the ink, so it reads as a measurement between two marks and never
       as a third series. */
    for (let i = 0; i < count; i++) {
      if (FOB[i] == null) continue;
      const x = X(g, i, n);
      ctx.save();
      ctx.globalAlpha = 0.32;
      ctx.strokeStyle = amber;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, Y(g, FS[i]));
      ctx.lineTo(Math.round(x) + 0.5, Y(g, FOB[i]));
      ctx.stroke();
      ctx.restore();
      /* Rimmed in the sheet's own colour: the dot sits below the line, out over
         bare ruling, and a 2.6px mark on a rule it happens to land on merges
         into a thicker rule. The rim is what makes it a mark ON the paper. */
      ctx.beginPath();
      ctx.arc(x, Y(g, FOB[i]), 3.7, 0, Math.PI * 2);
      ctx.fillStyle = sheet;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, Y(g, FOB[i]), 2.6, 0, Math.PI * 2);
      ctx.fillStyle = amber;
      ctx.fill();
    }
    /* The record's own mark, at the record's own size — the miniature is the
       same instrument seen from further away, not a second chart style. */
    for (let i = 0; i < count; i++)
      drawSighting(
        ctx,
        X(g, i, n),
        Y(g, FS[i]),
        i === count - 1 ? shown.life : 1,
        i === n - 1 ? green : ink
      );

    /* Hand the all-time low's position to CSS so the resting pulse sits on the
       point through every resize rather than on a guessed percentage.

       The pulse is absolutely positioned, so its coordinates are relative to the
       containing block's padding box — NOT to the canvas. The first version
       added a bare `+ 20` to y to cross that gap and nothing to x, which put the
       ring a clean 20px to the left of the point it exists to mark, with a
       comment above it claiming the position was measured. So measure it: the
       offset is the canvas's drawing origin inside whatever element turns out to
       be the containing block, and it survives any change to that element's
       padding or border because it never assumes either. */
    if (fPulse && count === n) {
      const host = fPulse.offsetParent;
      let ox = 0;
      let oy = 0;
      if (host) {
        const cr = fCanvas.getBoundingClientRect();
        const hr = host.getBoundingClientRect();
        ox = cr.left + fCanvas.clientLeft - (hr.left + host.clientLeft);
        oy = cr.top + fCanvas.clientTop - (hr.top + host.clientTop);
      }
      fPulse.style.setProperty("--px", (ox + X(g, n - 1, n)).toFixed(1) + "px");
      fPulse.style.setProperty("--py", (oy + Y(g, FS[n - 1])).toFixed(1) + "px");
      fPulse.classList.add("on");
    }
  }

  /* ══ CTA: the flock lands ══════════════════════════════════════════════════

     The hero strings a wire across the dark and the flock arrives to become the
     price line. This closes the same sentence: the wire again, empty, and the
     flock arriving to sit on it — with one perch left open beside the button.
     "Join the flock" is the label on that gap.

     Everything here is the hero's vocabulary reused rather than restated: the
     same Gaussian bird-weight on the wire, the same wing-flick spring that makes
     a neighbour bob because something happened next to it, the same cubic
     approach from off-frame right. What is new is the PERCH, and that needed
     artwork the project did not have — see BIRD_P. */

  /* The perched silhouette, drawn from references (photographs of jackdaws on
     wires and telegraph lines), never from memory — the rule the flying bird
     cost four attempts to learn.

     The first attempt was drawn to five shapes recalled from the references
     rather than measured off them, and it rendered as a DOVE. Drawing it a
     second time to a better recollection would have been the same mistake, so
     the reference was instrumented instead: a black-on-white silhouette sheet
     through a connected-component pass, then the chosen bird's outline dumped as
     a top/bottom column profile every 2.5% of its length. THE VERTICES BELOW ARE
     THAT PROFILE — the samples that survived a 0.35-unit Douglas-Peucker, joined
     by straight segments. Nothing here was drawn by eye: rasterising this path
     and re-reading its own profile reproduces 33 of the table's 35 columns
     within 0.4 units and the other two within 0.6 — a seventh of a pixel at the
     size this ships at.

     One vertex is kept against the metric's advice. Douglas-Peucker drops the
     GAPE — the corner where the bill's underside meets the throat — on merit, at
     0.34 units off the chord. Losing it runs the bill straight into the throat
     and the bird stops having a bill at all: the head renders as one cone. A
     corner that carries a feature is worth more than a corner that carries
     error, and no tolerance can tell them apart.

     They are line segments and not curves on purpose. Fitting Catmull-Rom
     through samples this unevenly spaced overshot — it put the crown at y −0.5
     and a control point past its own endpoint — and it would have been smoothing
     data that only exists every 2.5% anyway. A vertex is never more than 0.35
     units off the measured outline: a tenth of a pixel at ship size.

     What the numbers said, and what the from-memory version had got wrong:

     · The breast is NEAR-VERTICAL and it is at the front. The underside falls
       from 12 to 46 between 10% and 25% of the length while the top edge is
       still at the crown, so head and breast are one tall block ahead of the
       body's mass. A drawing that rounds this reads as a pigeon every time.
     · The crown is the highest point of the whole bird and clears the mid-back
       by ~21 units. A head level with the back is a blob; a head above it is a
       bird.
     · The tail is a BAND for 40% of its run — 22 units deep at the vent, still
       7.5 at 90% — and then cuts away to a point over the last 8%. The from-
       memory path had it as a blunt slab 11 deep at the very tip, which is the
       line that read as a spike.
     · There is a hard step at the vent: the underside jumps 8.3 units in 2.5%
       of the length. It is the one interior detail that still lands at 24px
       (≈2px), so it is the one worth keeping crisp — it is held out of the
       simplification along with the beak tip and both corners of the tail.
     · The deepest point of the body is at 45%, well BEHIND the legs, not under
       the breast. The from-memory path was 9 units too deep at 30%, which is
       what made it plump.

     The wing is not drawn. It shows in the references as a shallow kink in the
     flank and a step over the tail, both under a pixel at the sizes this
     renders. Same 0..100 convention as the flying paths — beak at +x, tail at −x
     — so the two share `dir`/rotation logic. */
  const BIRD_P = new Path2D(
    /* Back, over the crown and down to the tail. */
    "M100 7.5L95 5.6L85 0.6L82.5 0L77.5 0L72.5 3.1L70 6.4L65 15.3L55 23.9" +
      "L47.5 28.1L45 28.3L40 30L22.5 39.7L10 44.2" +
      /* The tail's tip: the top edge cuts away over the last 8%. */
      "L7.5 45.8L5 50.6L0 53.1L2.5 53.1L5 52.2" +
      /* Undertail, flat all the way back to the vent. */
      "L10 51.7L17.5 50L25 50.3L27.5 49.7L30 50L40 49.4L45 50.6L47.5 50.3" +
      /* The vent step, then the belly down to its deepest at 45% of the length. */
      "L50 58.6L55 64.2L57.5 63.1L67.5 48.9L75 45.6L80 41.1" +
      /* Breast, gape, and the underside of the bill. */
      "L85 31.9L87.5 23.3L90 11.9L95 8.9L100 8.1Z"
  );
  /* The bird is registered on its FEET, not on a point inside it: y 73.5 is
     where the reference's toes meet the ground, so "put the bird on the wire" is
     one subtraction and the 9.3 units of leg showing under the deepest belly are
     the reference's own rather than a number picked to look right.

     x 57.5–67.5 is the one stretch of the outline that is interpolated: the
     reference's legs stand in front of the belly there, so those columns measure
     the FEET (y ≈ 73.5) and the body behind them cannot be read. It is bridged
     between the two clean reads that bracket it — 64.2 at x55 and 47.8 at x70 —
     which is also where the 73.5 comes from.

     The legs sit inside that band and show different lengths on purpose: the
     belly slopes down towards the vent, so the forward leg stands clear of more
     of it (21 units against 10 in the reference). They start at the hip, which
     is inside the outline at both x, so the fill that follows hides the join and
     no gap can open if the outline is ever re-measured. */
  const BIRD_P_GROUND = 73.5;
  const BIRD_P_BELLY = 64.2;
  const BIRD_P_CX = 62.5;
  const BIRD_P_LEGS = [59, 66];
  const BIRD_P_HIP = 44;

  /* Feet planted on the wire's real y at the bird's own x, never on a flat line.
     The wire under a settled flock is never flat, and legs that stopped short of
     it — or ran through it — would read as a sticker laid over the picture
     rather than a bird standing on it. Same rule as the hero's tag: measure the
     contact point, do not eyeball it. */
  function drawPerched(ctx, x, wy, size, lift, alpha, notice = 0, lean = 0, face = -1) {
    const s = size / 100;
    /* NOTICING, and both halves pivot on the contact point because that is the
       only place a bird standing on a wire can pivot — the same rule as the
       feet-planted registration below.

       `lean` is the crane and it is the GESTURE: a rotation of the whole
       routine — legs included — about (x, wy). The feet do travel, by
       3.5·s·sin(θ): 0.22px at 24px and the full 15 degrees, a quarter of the
       line's own width and hidden under the wire it is standing on. Rotating
       the body alone would have been exact and would have snapped the legs off
       at the hip.

       `notice` is a YAW — the profile foreshortening as the body swivels toward
       you — and its ceiling is the whole design of this effect, arrived at by
       rendering it at 8× and looking rather than by reasoning about degrees.
       The first version capped at 0.5, on the theory that half-width was still
       comfortably short of edge-on. It is not: this silhouette carries its
       entire identity horizontally — beak, crown, back, tail fan — so a 50%
       squeeze leaves a vertical smear that reads as a rendering glitch, and at
       0.65 it is still a smear. The falloff put three birds on screen at 0.65,
       0.50 and 0.79 in one frame, and 0.79 was the only one still recognisably
       a bird. Hence 0.80: the narrowing is a HINT that supports the crane, not
       the carrier of it. Do not raise this without re-rendering the sheet.

       Symmetric, so it needs no direction of its own — which is also why the
       bird directly under the cursor, whose `lean` is zero by construction,
       needs its own tell. That is the rise the callers add to `lift`: a bird
       with something right beside it stands tall rather than turning. */
    const yaw = 1 - 0.2 * Math.min(1, Math.abs(notice));
    const tilt = lean * 0.262; // ~15deg at full lean
    /* The feet never leave the line. `lift` — the slow breathe plus whatever the
       wing-flick adds — raises the BODY, and the legs straighten to absorb it:
       a bird stretching where it stands, which is what the flick is for. The
       clamp is a guard, not a shape: half again the leg's resting length is
       about as far as a bird that is already standing can push, and beyond it
       the legs read as rubber. It cost a defect once, when the lift was added to
       a belly-registered anchor and every flick tripled the leg. */
    const rest = (BIRD_P_GROUND - BIRD_P_BELLY) * s;
    const top = wy - Math.min(lift, rest * 1.5) - BIRD_P_GROUND * s;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (tilt) {
      ctx.translate(x, wy);
      ctx.rotate(tilt);
      ctx.translate(-x, -wy);
    }
    ctx.fillStyle = ink;
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(0.75, size * 0.032);
    ctx.beginPath();
    for (const lx of BIRD_P_LEGS) {
      /* Foreshortened with the body, and mirrored with it: the leg spacing is
         measured from the artwork's own axis, so a bird turned to face the
         other way has to carry its legs across with it or the forward leg —
         the long one, standing clear of the belly's slope — ends up under the
         tail. Legs that kept their spacing while the body narrowed would stand
         outside it, which is the giveaway that the yaw is a squash rather than
         a turn; legs that kept their SIDE while the body flipped is the same
         mistake read horizontally. */
      const px = x + face * (lx - BIRD_P_CX) * s * yaw;
      ctx.moveTo(px, top + BIRD_P_HIP * s);
      ctx.lineTo(px, wy);
    }
    ctx.stroke();
    ctx.translate(x, top);
    ctx.scale(s, s);
    /* The artwork faces +x, and `face` is where this bird is looking: −1 for a
       bird looking left, which is what every flock on the page did when there
       was only one direction to arrive from, and is therefore the default. The
       CTA's is the flock that needs the other sign — its two halves converge on
       the button, so which way a bird looks is a fact about which side of the
       control it landed on.

       The yaw rides on the same axis, and `translate(-BIRD_P_CX)` comes after
       it so the narrowing is about the body's own standing axis rather than the
       artwork's left edge — a bird turning on the spot, not sliding as it does. */
    ctx.scale(face * yaw, 1);
    ctx.translate(-BIRD_P_CX, 0);
    ctx.fill(BIRD_P);
    ctx.restore();
  }

  const ctaCanvas = $("ctaWire");
  const ctaBtn = $("installBtn");
  const ctaSection = $("install");

  /* Geometry is measured, never authored: the wire is strung THROUGH the button,
     so its height is the button's height and its anchor points are the button's
     edges. A hard-coded fraction of the canvas would drift the moment the copy
     rewrapped, and the whole image depends on the wire meeting the button.
     Under `.cta-narrow` it is strung OVER the button instead — see measureCta. */
  let ctaGeo = null;
  let ctaFlock = [];
  /* The shared client-coords pointer, converted into THIS canvas's space. Held
     beside the geometry rather than inside it because it changes every frame
     and the geometry deliberately does not — `measureCta` early-returns on an
     unchanged rect, and folding a per-frame value into an object guarded by a
     `same` check is how it would silently freeze. */
  let ctaPtr = null;
  const CTA_SAG_R = 62;
  const CTA_SAG_CUT = 190;

  function measureCta() {
    if (!ctaCanvas || !ctaBtn) return false;
    const w = ctaCanvas.clientWidth;
    const h = ctaCanvas.clientHeight;
    if (!w || !h) return false;
    const cr = ctaCanvas.getBoundingClientRect();
    /* Converted here, ABOVE the `same` early-return, off the rect this function
       is already reading — so noticing costs no extra layout, and the position
       is re-derived every frame from a rect measured this frame. Converting
       once in the pointer handler instead would go stale the moment the page
       scrolled under a stationary cursor: the bird would decide you had walked
       away because the wire moved. */
    ctaPtr = ptrClient && { x: ptrClient.x - cr.left, y: ptrClient.y - cr.top };
    const br = ctaBtn.getBoundingClientRect();
    const postL = br.left - cr.left;
    const postR = br.right - cr.left;
    const postCx = (postL + postR) / 2;
    const yPost = br.top - cr.top + br.height / 2;
    const same =
      ctaGeo &&
      ctaGeo.w === w &&
      ctaGeo.h === h &&
      Math.abs(ctaGeo.postL - postL) < 0.5 &&
      Math.abs(ctaGeo.yPost - yPost) < 0.5;
    if (same) return true;

    /* BELOW 640px THE BUTTON STOPS BEING THE POST. It is a fixed ~194px wide, so
       it is 15% of a desktop wire and 61% of a 320 one, and the wire either side
       of it comes to 37px of visible, unmasked line — under one perch. Measured
       across the range: 11 birds at 1280, 8 at 768, 3 at 414, and at 320 a single
       bird sitting inside the mask's own fade with the gap ring clipped by it.
       No clearance is tunable into space that is not there, so the narrow layout
       lifts the wire clear of the button and strings it end to end instead: the
       full width is perchable, the flock is ~6 strong, and the open gap sits
       directly above the button rather than squeezed beside it.

       640 rather than a phone width, because the RIGHT-hand run is the binding
       one and it stays starved long past the point the layout looks survivable.
       It has to hold the ring plus `clearR` before its first bird, so the clear
       wire on that side is 0.42w − 97 − clearR, and two perches need w >= 631.
       Measured on the wide layout: 460 gave 5 birds with 2 clear of the mask,
       560 gave 6 with 3 — one of them on the right — and 640 gave 9 with 6. The
       first two are thinner than the narrow layout at 414, so a threshold set by
       eye at a phone breakpoint would have handed the worst of both to exactly
       the widths between them.

       What it costs is the anchor conceit — below 640 the wire is held by its
       ends, not by the control. That is the right thing to give up here: there is
       no hover on touch, so the gap is already a static piece of storytelling
       rather than something you can send a bird into, and a legible flock with a
       visible hole says what the section means where an occupied line cannot. */
    const narrow = w < 640;
    ctaSection?.classList.toggle("cta-narrow", narrow);

    /* The wire runs off both edges — the mask fades it out rather than the
       viewport cutting it, so the flock reads as continuing past what is
       visible. Ends sit ABOVE the low point, which is the button when the button
       is holding the line and the wire's own middle when it is not. */
    const x0 = -60;
    const x1 = w + 60;
    /* Clearance over the button, plus the room a perched bird needs above the
       wire (~24px) — the narrow layout's whole point is that birds stand where
       the button used to be, so the band between the copy and the button has to
       hold them. The rise is flatter than the wide one: on a short wire a 34px
       drop reads as a kink rather than as perspective, and the ends' birds would
       climb into the paragraph above.

       34 and not the 16 it needs at rest, because THE WIRE IS AT ITS FLOPPIEST
       EXACTLY HERE. `ctaFree` returns 1 over the button in this layout — nothing
       is holding the line there any more — where the wide layout had the button
       itself as a rigid anchor and a sag of literally zero. Measured at 320 with
       16: the flock's standing weight pulled the line 12.3px below its own rest
       height and left 3.7px of daylight, and a landing punch is worth another
       7.5 on top, so the wire would have dropped THROUGH the primary control. */
    const yLow = narrow ? br.top - cr.top - 34 : yPost;
    const yEdge = yLow - Math.min(narrow ? 18 : 34, h * (narrow ? 0.03 : 0.09));
    const sag = Math.min(16, (postL - x0) * 0.045);

    /* One perch every ~66px, so the flock thins on a phone instead of crowding.
       Deterministic jitter, because a resize must redraw the same birds in the
       same places rather than reshuffling the flock under the reader. */
    const step = clamp(w / 13, 52, 78);
    const n = Math.max(4, Math.round((x1 - x0) / step));

    /* EVERY CLEARANCE BELOW IS MEASURED IN PERCH-STEPS, not pixels. They were
       written as 34 / 96 / 52 / 32, which are the right numbers on a 1280 canvas
       and only there: the button is a fixed ~194px wide, so it is 15% of a
       desktop wire and 52% of a phone one, and the clearances then add their own
       constant width on top of that. Measured at 375: the exclusion window ran
       56.6 to 380.4 — 86% of the canvas — and threw away 7 of the 10 perches,
       leaving ONE bird, at x 17, inside the mask's own left fade. The section's
       whole image, a flock with one space open, was a bare line on a phone.

       A step is the natural unit because that is what these distances are made
       of: keep a bird off the button, keep the flock off the ring, put the ring
       where the eye lands. All four resolve to within a third of a pixel of the
       old constants at 1280 (step is 78 there), so the desktop composition that
       was measured and approved is unchanged, and a phone now scales with it. */
    const clearL = step * 0.44;
    const clearR = step * 1.23;
    let xs2 = [];
    for (let i = 0; i < n; i++) {
      const x = x0 + ((i + 0.5) * (x1 - x0)) / n + (jit(i, 11) - 0.5) * step * 0.44;
      /* Nothing sits on the post, and nothing sits so close to it that the
         reserved gap stops reading as a gap. Narrow has no post to sit on: the
         wire passes over the button, so the whole span is perchable and the only
         thing carved out of it is the gap itself. */
      if (!narrow && x > postL - clearL && x < postR + clearR) continue;
      xs2.push(x);
    }
    /* The gap is PLACED, not chosen: it has to be the perch your eye lands on
       when it leaves the button, which means a fixed distance from the button's
       own edge rather than wherever the spacing happened to leave a hole. Beside
       the button where there is room beside it; directly over its centre where
       there is not, which is the same relationship read vertically. */
    const gapX = narrow ? postCx : Math.min(postR + step * 0.67, x1 - 40);
    xs2 = xs2.filter((x) => Math.abs(x - gapX) > step * 0.41);
    xs2.push(gapX);
    xs2.sort((a, b) => a - b);
    const gapIdx = xs2.indexOf(gapX);

    ctaGeo = { w, h, x0, x1, postL, postR, postCx, yPost, yLow, yEdge, sag, gapIdx, narrow };

    /* Rebuilt on resize, but a bird already on the wire keeps its state — a
       reflow must not restart the arrival under someone who has watched it.

       Matched by POSITION rather than by index, which is what the first version
       did and what made a reflow lose birds. The perch COUNT is a function of
       the button's width, so anything that changes it — a web font landing, a
       longer label, a window dragged wider — renumbers the whole flock: every
       bird slides one perch along, and the birds whose index no longer exists
       are replaced by fresh `away` ones that the arrival, already finished,
       never sends for. Measured: four permanently empty perches on a wire of
       fourteen. Nearest-x with the previous bird consumed is exact whenever the
       geometry barely moved, which is the case that matters, and the half-step
       cut leaves a genuinely new perch unmatched so the arrival can fill it. */
    const prev = ctaFlock.slice();
    ctaFlock = xs2.map((x, i) => {
      let bi = -1;
      let bd = step * 0.5;
      for (let k = 0; k < prev.length; k++) {
        const d = Math.abs(prev[k].x - x);
        if (d < bd) {
          bd = d;
          bi = k;
        }
      }
      const old = bi >= 0 ? prev.splice(bi, 1)[0] : null;
      /* WHICH WAY THIS BIRD LOOKS, and it is geometry rather than taste: +1 for
         a bird left of the button, −1 for one right of it, so every bird on the
         wire is looking at the control. It is also the side it comes in over —
         a bird arrives on its own edge and lands already facing the way it flew
         — so `ctaFlightAt` reads the same field rather than keeping a second
         one that could drift out of step with it.

         Re-derived on every rebuild, not carried on the matched bird: the
         button's own width sets where the halves divide, so a reflow that
         renumbers the flock can move a bird across the middle, and one that
         kept a stale sign would sit on the wire looking away from the button
         with nothing in the picture to explain why. */
      const face = x < postCx ? 1 : -1;
      return old
        ? Object.assign(old, { x, i, face, gap: i === gapIdx })
        : { i, x, face, gap: i === gapIdx, state: "away", perch: 0, e: 0, t0: 0, dur: 0, leaveAt: 0, land: -1e9, flick: -1e9 };
    });
    /* The gap can move onto an occupied perch — it is pinned to the button's
       edge, so it travels further than the flock does when the button resizes.
       Whoever inherited it is asked to leave, because a CTA whose invitation has
       quietly filled itself in is worse than one that never had a gap: the
       section still says "one perch still open" while the picture shows none. */
    const gapB = ctaFlock[gapIdx];
    if (gapB && gapB.state === "on") ctaLeave(gapB, performance.now(), 0);
    return true;
  }

  /* The button is a POST: a rigid anchor takes no dip, and the dip grows with
     distance from it. Without this the wire would sink under the flock while the
     button stayed put, and the button would read as floating beside its own
     wire rather than holding it. It also means the primary control never moves,
     which is the one thing on this page that must not. */
  function ctaFree(x) {
    const g = ctaGeo;
    /* Narrow is a single span between two fixed ends, so the only anchors are
       the ends — the button is no longer holding anything and must not stiffen
       the wire above itself. */
    const d = g.narrow
      ? Math.min(x - g.x0, g.x1 - x)
      : x < g.postCx
        ? Math.min(x - g.x0, g.postL - x)
        : Math.min(x - g.postR, g.x1 - x);
    return clamp(d / 130, 0, 1);
  }

  function ctaBaseY(x) {
    const g = ctaGeo;
    if (g.narrow) {
      /* One hang between the two ends. The dip to yLow IS the sag here, so the
         extra `sag` term is not added on top: yLow is already the clearance over
         the button and a second helping would put the wire through it. */
      const u = clamp((x - g.x0) / (g.x1 - g.x0), 0, 1);
      return g.yEdge + (g.yLow - g.yEdge) * 4 * u * (1 - u);
    }
    let u;
    if (x <= g.postCx) u = clamp((x - g.x0) / (g.postL - g.x0), 0, 1);
    else u = 1 - clamp((x - g.postR) / (g.x1 - g.postR), 0, 1);
    return lerp(g.yEdge, g.yPost, u) + g.sag * 4 * u * (1 - u);
  }

  /* Every load on the wire summed in one place, exactly as the hero does it:
     standing weight, the landing punch, and the wing-flick spring. Neighbours
     bob for free — a settled bird is drawn at the wire's y under its own feet,
     so it moves because the wire moved, which is the causal version of the
     effect rather than an animation that imitates it. */
  function ctaSag(x, t) {
    let s = 0;
    for (const b of ctaFlock) {
      if (b.perch <= 0.01) continue;
      const d = x - b.x;
      if (d < -CTA_SAG_CUT || d > CTA_SAG_CUT) continue;
      const g = Math.exp(-((d / CTA_SAG_R) * (d / CTA_SAG_R)));
      s += b.perch * 6.6 * g;
      const la = t - b.land;
      if (la >= 0 && la < 620) {
        s += g * 7.5 * Math.sin((la / 620) * Math.PI * 2) * (1 - la / 620);
      }
      const age = t - b.flick;
      if (age >= 0 && age < 900) {
        s -= g * 5.4 * Math.sin((age / 900) * Math.PI * 3) * (1 - age / 900);
      }
    }
    return s * ctaFree(x);
  }

  const ctaWireY = (x, t) => ctaBaseY(x) + ctaSag(x, t);

  /* Two approaches from one cubic, written once and mirrored, so the wire's two
     halves cannot drift apart as the numbers are tuned.

     `from` is the edge this bird comes in over — the one on its own side of the
     button, which is the opposite sign to the way it will be looking when it
     lands. Deriving it from `face` rather than storing it is what guarantees a
     bird never arrives backwards: there is one fact about which side of the
     control it belongs to, and the flight and the silhouette both read it.

     The second control point sits up and to the ARRIVAL side of the perch, so
     the approach is a descent onto the wire rather than a slide along it. Your
     bird's goes on the far side instead, which carries it past the gap and
     brings it back: the loop that makes one arrival read as deliberate where
     twelve read as weather. */
  function ctaFlightAt(b, e, t) {
    const g = ctaGeo;
    const tx = b.x;
    const ty = ctaWireY(tx, t);
    const from = -b.face;
    const sx = from > 0 ? g.x1 + 90 + jit(b.i, 1) * 200 : g.x0 - 90 - jit(b.i, 1) * 200;
    const sy = ty - 150 - jit(b.i, 2) * 240;
    const p1x = sx + (tx - sx) * 0.34;
    const p1y = sy + (ty - sy) * 0.05;
    const p2x = b.circle ? tx - from * (120 + jit(b.i, 4) * 40) : tx + from * (120 + jit(b.i, 3) * 70);
    const p2y = ty - (b.circle ? 66 : 88);
    const m = 1 - e;
    const a = m * m * m;
    const bb = 3 * m * m * e;
    const c = 3 * m * e * e;
    const d = e * e * e;
    const da = 3 * m * m;
    const db = 6 * m * e;
    const dc = 3 * e * e;
    const vx = da * (p1x - sx) + db * (p2x - p1x) + dc * (tx - p2x);
    const vy = da * (p1y - sy) + db * (p2y - p1y) + dc * (ty - p2y);
    return {
      x: a * sx + bb * p1x + c * p2x + d * tx,
      y: a * sy + bb * p1y + c * p2y + d * ty,
      ang: Math.atan2(vy, vx),
    };
  }

  function ctaLaunch(b, t, delay, dur, circle) {
    b.state = "in";
    b.circle = !!circle;
    b.t0 = t + delay;
    b.dur = dur;
    b.e = 0;
    b.leaveAt = 0;
  }

  /* A departure is BOOKED, not begun. Flipping the state here would strand a
     bird that is still flying in — its flight clock has not started, so it would
     read as landed at the instant it was told to leave and then teleport off the
     perch. Booking it lets the arrival finish first and the exit follow, which
     is also what makes the click's staggered lift work on a flock that is still
     assembling. */
  function ctaLeave(b, t, delay) {
    if (b.state === "away" || b.state === "out") return;
    b.leaveAt = t + delay;
  }

  /* THE FLOCK CONVERGES ON THE BUTTON. Each half comes in over the edge it is
     already nearest, so the two streams meet at the control instead of one of
     them crossing over it, and the arrival ends pointed at the thing the
     section is asking you to press rather than merely finishing beside it.

     Outside-in: the far ends leave first and the perches beside the button fill
     last, so the movement RESOLVES inward. Ordered the other way the flock
     would empty out of the middle, which is the same picture played backwards
     and says the opposite thing.

     Interleaved on ONE counter rather than run as two staggered groups. Two
     independent staggers land two birds on the same beat all the way through
     and read as two flocks passing; one counter alternates the sides, which is
     a single event with a left half and a right half. It also keeps the whole
     arrival the same length it was when everything came from one edge — the
     stagger is per bird, not per side.

     The gap is skipped, so what closes around the button is a line with exactly
     one hole in it, and the hole is the last thing the eye has left to land on. */
  function ctaArrive(t) {
    const waiting = ctaFlock.filter((b) => !b.gap && b.state === "away");
    const left = waiting.filter((b) => b.face > 0).sort((a, b) => a.x - b.x);
    const right = waiting.filter((b) => b.face < 0).sort((a, b) => b.x - a.x);
    let k = 0;
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      for (const b of [left[i], right[i]]) {
        if (!b) continue;
        ctaLaunch(b, t, k * 118, 1150 + jit(b.i, 5) * 260, false);
        k++;
      }
    }
  }

  let ctaNextFlick = 0;
  let ctaLift = 0;
  let ctaReleaseTick = null;

  function drawCta(t) {
    if (!measureCta()) return;
    const g = ctaGeo;
    const ctx = ctaCanvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.round(g.w * dpr);
    const ch = Math.round(g.h * dpr);
    if (ctaCanvas.width !== cw || ctaCanvas.height !== ch) {
      ctaCanvas.width = cw;
      ctaCanvas.height = ch;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, g.w, g.h);

    if (ctaReleaseTick) ctaReleaseTick(t);

    for (const b of ctaFlock) {
      if (b.state === "on" && b.leaveAt && t >= b.leaveAt) {
        b.leaveAt = 0;
        b.state = "out";
        b.t0 = t;
        b.dur = 780;
        b.e = 0;
      }
      if (b.state === "in" || b.state === "out") {
        const e = clamp((t - b.t0) / b.dur, 0, 1);
        b.e = e;
        if (b.state === "in") {
          b.perch = e < 0.9 ? 0 : (e - 0.9) / 0.1;
          if (e >= 1) {
            b.state = "on";
            b.perch = 1;
            b.land = t;
          }
        } else {
          b.perch = e > 0.08 ? 0 : 1 - e / 0.08;
          if (e >= 1) {
            b.state = "away";
            b.perch = 0;
          }
        }
      }
    }

    /* Traced in two passes like the hero's: a wide soft glow so the line has
       presence against the dark, then the line itself. */
    ctx.lineCap = "round";
    for (const pass of [0, 1]) {
      ctx.beginPath();
      ctx.strokeStyle = withAlpha(ink, pass ? 0.4 : 0.06);
      ctx.lineWidth = pass ? 1.15 : 5;
      for (let x = g.x0; x <= g.x1; x += 6) {
        const y = ctaWireY(x, t);
        if (x === g.x0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    /* Ranked against the wire's own sag, so a bird on the low middle of the span
       is measured from where it is actually standing rather than from a flat
       line through the posts. */
    updateNotice(ctaFlock, ctaPtr, (b) => ctaWireY(b.x, t));

    for (const b of ctaFlock) {
      if (b.state === "in" || b.state === "out") {
        const e = b.state === "in" ? easeOut(b.e) : b.e * b.e;
        const f = ctaFlightAt(b, b.state === "in" ? e : 1 - e, t);
        /* Wings beat on the way in, hold wide through the flare, then fold as
           the feet take the weight — the three phases that make a landing read
           as a landing rather than a fade-in at the destination. */
        const u = b.state === "in" ? b.e : 1 - b.e;
        let spread;
        if (u < 0.72) spread = 0.34 + 0.66 * Math.abs(Math.sin(t / 62 + b.i * 1.9));
        else if (u < 0.92) spread = lerp(0.34 + 0.66 * Math.abs(Math.sin(t / 62 + b.i * 1.9)), 1, smooth((u - 0.72) / 0.2));
        else spread = 1 - smooth((u - 0.92) / 0.08);
        const size = lerp(34, 24, smooth(clamp((u - 0.74) / 0.26, 0, 1)));
        /* The flying bird fades against `perch` itself rather than against its
           own clock, so the handover to the perched silhouette is a crossfade
           that cannot drift: whatever weight the wire is carrying is exactly the
           weight the picture is missing. */
        drawBird(ctx, f.x, f.y - 6, f.ang, size, spread, clamp(u * 6, 0, 1) * (1 - b.perch));
      }
      if (b.perch > 0.02) {
        const age = t - b.flick;
        const flicking = age >= 0 && age < 620;
        /* Its own phase on the breathe, so the flock reads as many small living
           things rather than one thing pulsing in unison. */
        const bob = Math.sin(t / 1180 + b.i * 2.3) * 0.6;
        const wy = ctaWireY(b.x, t);
        /* 2.2px on a body 17.6px tall: enough to read across the wire, and
           inside what the legs can straighten to without the clamp in
           `drawPerched` having to do the work. */
        const hop = flicking ? Math.sin((age / 620) * Math.PI) * 2.2 : 0;
        /* The rise is not decoration — it is the only tell the bird directly
           under the cursor has, since its crane is zero by construction and the
           yaw alone is a hint. `drawPerched` clamps the total to what the legs
           can straighten to, so a flick landing on a noticing bird saturates
           rather than stacking, which is the physically right answer. */
        drawPerched(ctx, b.x, wy, b.gap ? 26 : 24, bob + hop + b.noticeA * 2.4, b.perch, b.noticeA, b.noticeD, b.face);
        /* The flick opens the wings over the perched body rather than replacing
           it — a bird stretching where it stands, which is why the wire springs
           under it in `ctaSag` on the same clock. Heading and offset both carry
           `face`, because the overlay is the SAME bird: a spread pair of wings
           pointing one way over a body pointing the other is not a stretch, it
           is two birds in the same place. */
        if (flicking) {
          const head = b.face < 0 ? Math.PI : 0;
          drawBird(ctx, b.x + b.face, wy - 16 - hop, head, 24, Math.sin((age / 620) * Math.PI) * 0.85, b.perch * 0.85);
        }
      }
    }

    /* The empty perch, marked. A gap you cannot see is not an invitation — this
       is the one place on the wire that says something is missing, and it is
       directly beside the button that fills it. */
    const gapB = ctaFlock[g.gapIdx];
    if (gapB && gapB.perch < 0.02 && !ctaLift) {
      const gy = ctaWireY(gapB.x, t);
      const pulse = 0.5 + 0.5 * Math.sin(t / 900);
      ctx.save();
      ctx.globalAlpha = 0.34 + pulse * 0.4;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.1;
      ctx.setLineDash([2.4, 3.2]);
      ctx.beginPath();
      ctx.arc(gapB.x, gy - 11, 8.5 + pulse * 1.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    const settled = ctaFlock.filter((b) => !b.gap).every((b) => b.state === "on");
    if (settled && t > ctaNextFlick) {
      /* Rare, staggered, one at a time — the header icons' rule. A flock that
         all twitched together would be a loading spinner. */
      const pool = ctaFlock.filter((b) => b.state === "on");
      const pick = pool[Math.floor(jit(Math.round(t / 97), 7) * pool.length)];
      if (pick) pick.flick = t;
      ctaNextFlick = t + 2400 + jit(Math.round(t / 53), 9) * 5400;
    }
    /* Everything leaves, then everything comes back. The lift is the answer to a
       click on a button that has nowhere to send you yet — a dead control that
       does something honest is better than a dead control. */
    if (ctaLift && t > ctaLift) ctaLift = 0;

    /* THE FLOCK ARRIVES WHEN YOU DO. `ctaVisible` is load-bearing, not a
       performance guard: `redrawAll` paints this canvas at boot, when fonts
       land, on every chapter change and on every resize, all of which happen
       while the section is thousands of pixels below the fold. The first of
       those used to start the arrival, and since nothing advances the clock
       off screen, all thirteen flights expired unwatched — scrolling down
       revealed a flock that was simply already there. Measured: twelve birds
       on the wire in the first frame of the section, no ramp.

       Stated as a standing condition rather than a once-only flag, so it also
       covers the perches a reflow left empty and the flock's return after the
       lift. `idle` is what keeps it from firing into its own arrival, and
       `ctaArrive` skips the gap, so a wire that is merely waiting for a hover
       does not read as one that is missing a bird. */
    const idle = ctaFlock.every((b) => b.state === "away" || b.state === "on");
    if (ctaVisible && !ctaLift && idle && ctaFlock.some((b) => !b.gap && b.state === "away")) {
      ctaArrive(t);
    }
  }

  /* One static frame for readers who have asked for no motion: the flock
     already landed, the gap still open. The image is the message, and it does
     not need to move to make it. `drawCta` is skipped entirely under reduced
     motion, so without this the section would have an empty canvas. */
  function drawCtaStill() {
    if (!measureCta()) return;
    for (const b of ctaFlock) {
      b.state = b.gap ? "away" : "on";
      b.perch = b.gap ? 0 : 1;
      b.land = -1e9;
      b.flick = -1e9;
      b.leaveAt = 0;
    }
    drawCta(0);
  }

  /* Hovering the button sends YOUR bird to the open perch; clicking it joins
     and then lifts the whole flock. The gap is what makes both legible — an
     invitation you can see being accepted.

     Hover is a preview and therefore reversible: the perch is yours while you
     are there and reopens a couple of seconds after you leave, so the invitation
     renews instead of being spent on the first pointer that crosses it. The
     click is not reversible in the same way — it runs the whole sequence — but
     the flock returns afterwards, because a landing page that ends empty has
     thrown away its own closing image. */
  if (ctaCanvas && ctaBtn) {
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
    let releaseAt = 0;
    const gapBird = () => (ctaGeo ? ctaFlock[ctaGeo.gapIdx] : null);

    const join = (delay) => {
      const b = gapBird();
      if (!b || reduced.matches || ctaLift) return;
      releaseAt = 0;
      if (b.state === "away") ctaLaunch(b, performance.now(), delay || 0, 1250, true);
      else if (b.state === "out") ctaLaunch(b, performance.now(), 0, 700, true);
    };
    const release = () => {
      const b = gapBird();
      if (!b || ctaLift || b.state === "away") return;
      releaseAt = performance.now() + 2000;
    };
    /* Polled on the frame rather than run off a timer, so a pointer that comes
       back inside the grace window simply cancels it — no timer to clear, and
       no way for a stale one to fire over a click that has since happened. */
    ctaReleaseTick = (t) => {
      if (releaseAt && t > releaseAt) {
        releaseAt = 0;
        const b = gapBird();
        if (b && !ctaLift) ctaLeave(b, t, 0);
      }
    };

    if (fine.matches) {
      ctaBtn.addEventListener("pointerenter", () => join(90));
      ctaBtn.addEventListener("pointerleave", release);
    }
    /* Keyboard gets the same gesture, with no arrival delay: a pointer glances
       across a button, a tab stop is a decision. */
    ctaBtn.addEventListener("focus", () => join(0));
    ctaBtn.addEventListener("blur", release);

    ctaBtn.addEventListener("click", (e) => {
      /* The listing does not exist yet and the href is a placeholder, so the
         default would scroll the reader back to the top of the page — an
         unmistakably broken-feeling answer to the one button that matters. */
      if (ctaBtn.getAttribute("href") === "#") e.preventDefault();
      if (reduced.matches || ctaLift) return;
      const t = performance.now();
      join(0);
      /* Late enough that your bird is on the wire before anything moves: the
         flock leaves WITH you, which is the whole point of the gesture. */
      let k = 0;
      for (const b of [...ctaFlock].sort((a, c) => a.x - c.x)) ctaLeave(b, t, 1500 + k++ * 46);
      ctaLift = t + 1500 + ctaFlock.length * 46 + 780 + 900;
    });
  }

  /* ══ How it works: the flock gathers on the rule ════════════════════════════
     The section's own rule is the wire again, and this is what finally stands on
     it. Scroll summons the flock left to right: one bird by 01, a cluster
     through 02 where the copy says everyone's visits add up, the line full by
     03. The copy and the picture make the same claim, which is the only reason
     to spend a device here rather than decorate.

     THE RULE DOES NOT SAG, AND THAT IS THE POINT OF DIFFERENCE FROM THE CTA'S
     WIRE. This one is printed on ledger stock — a ruling, with the step numbers
     set as marks on it — so weight cannot bend it and a bird landing gets no
     give back. The CTA's is a strung wire that dips under every arrival. Two
     objects, two physics, appropriate to their materials; drawing them the same
     way would make the page look like it owned one trick.

     Reversible, because it is scrubbed rather than played: scrolling back up
     sends the flock off again in the order it arrived. A one-shot would be a
     worse answer to a reader who scrolls up to re-read step 02 and finds the
     illustration already spent. */

  const howSection = $("how");
  const howCanvas = $("howWire");
  const howSteps = howCanvas ? howCanvas.parentElement : null;
  /* A bird arrives bigger than it lands — the flight lerps 30 down to 22 over
     its last stretch, so it reads as coming in from depth rather than sliding
     in on the same plane. The clearance below therefore has to be figured on
     the FLIGHT size, which is the only one that is ever in the air. */
  const HOW_SIZE = 22;
  const HOW_FLY_SIZE = 30;
  /* How far ink reaches from the anchor `drawBird`/`drawPerched` are handed.
     Both translate the artwork by (-50, -50) at `size/100`, so the anchor is
     path-space (50, 50) and the drawn box extends half the artwork in every
     direction — under rotation, the corner radius, hypot(50,50)/100 ≈ 0.71.
     Measured rather than trusted: a flight clamped to an anchor ceiling of 42
     put ink at 25, and 0.8 rounds up what that implies, the spread wing leaving
     the 100-unit box. It matters because every ceiling in here is expressed as
     clearance from something a reader can see, and a margin measured to the
     registration point silently means ~24px less than it says. */
  const HOW_INK_R = HOW_FLY_SIZE * 0.8;
  let howGeo = null;
  let howFlock = [];
  /* Same reason as `ctaPtr` above: per-frame, so it is held outside the
     geometry that the `same` check freezes. */
  let howPtr = null;
  let howNextFlick = 0;

  function measureHow() {
    if (!howCanvas || !howSteps) return false;
    const w = howCanvas.clientWidth;
    const h = howCanvas.clientHeight;
    /* Zero under the 800px rule, where the canvas is `display: none` — the one
       check that covers the narrow layout without duplicating its breakpoint in
       two languages. */
    if (!w || !h) return false;

    /* THE RULE IS READ OFF THE RULE, which is not the same thing as reading it
       off a step number, and the difference is visible. `.step-n` is an
       `inline-flex` disc placed by the line box, so it lands where the type
       puts it — measured, its centre sits at 88.8 while `.steps::before` draws
       at 87. Perching on the discs would stand every bird 1.8px below the line
       it is supposed to be standing on.
       So the y comes from the pseudo-element's own computed `top`, resolved
       against the same padding box the canvas's `top` is. That is still a
       measurement rather than a copied constant — move the rule in the
       stylesheet and the flock moves with it — and unlike the disc centre it
       lands exactly on the ink. The discs are still measured, but only for the
       clearances below: what they give reliably is their x and their radius.
       Falls back to the disc centre if the pseudo-element yields nothing, since
       being 1.8px out beats not drawing. */
    const discs = [...howSteps.querySelectorAll(".step-n")];
    if (!discs.length) return false;
    const cr = howCanvas.getBoundingClientRect();
    /* Above the `same` check, off the rect already being read — see `measureCta`
       for why the conversion cannot happen in the pointer handler. */
    howPtr = ptrClient && { x: ptrClient.x - cr.left, y: ptrClient.y - cr.top };
    const d0 = discs[0].getBoundingClientRect();
    const sr = howSteps.getBoundingClientRect();
    const ruleTop = parseFloat(getComputedStyle(howSteps, "::before").top);
    const wireY = Number.isFinite(ruleTop)
      ? sr.top + ruleTop - cr.top
      : d0.top - cr.top + d0.height / 2;
    const marks = discs.map((d) => {
      const r = d.getBoundingClientRect();
      return { x: r.left - cr.left + r.width / 2, r: r.width / 2 };
    });

    /* THE FLIGHT'S CEILING IS THE HEADING'S BOTTOM EDGE, MEASURED. The canvas
       paints over the h2 — a positioned box beats a non-positioned one whatever
       their DOM order — so an arc authored in pixels would fly birds through
       "The flock does the remembering" the first time a narrower viewport
       wrapped it onto two lines and pushed its edge down. Read it instead, and
       leave the bird's own half-height under it so what clears is the artwork,
       not its registration point. */
    const head = howSection && howSection.querySelector(".h-section");
    const ceilY =
      (head ? head.getBoundingClientRect().bottom - cr.top + 20 : 24) + HOW_INK_R;

    const same =
      howGeo &&
      howGeo.w === w &&
      howGeo.h === h &&
      Math.abs(howGeo.wireY - wireY) < 0.5 &&
      Math.abs(howGeo.marks[0].x - marks[0].x) < 0.5;
    if (same) return true;

    /* One perch per ~96px. Wide enough that the settled flock reads as a
       gathering rather than a fence — measured across the range it gives 11 at
       1280 and 8 at 900, before the discs take their clearances out. */
    const n = Math.max(4, Math.round(w / 96));
    const step = w / n;
    const xs = [];
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) * step + (jit(i, 21) - 0.5) * step * 0.4;
      /* A bird standing on a step number would hide the one piece of wayfinding
         the section has. Its own half-width plus the body's, so the clearance is
         derived from what is actually there rather than nudged until it looked
         right. */
      if (marks.some((m) => Math.abs(x - m.x) < m.r + 15)) continue;
      xs.push(x);
    }
    if (!xs.length) return false;

    /* Thresholds run left to right so the flock fills the way the rule draws —
       a bird can never be standing on a stretch of line that has not been drawn
       yet, which is the whole causal chain this section is built on. The window
       stops short of 1 so the last arrival has somewhere to finish: at exactly 1
       it would still be in the air at the bottom of the scroll. */
    howFlock = xs
      .sort((a, b) => a - b)
      .map((x, i) => ({
        i,
        x,
        p: 0.06 + (0.82 * i) / Math.max(1, xs.length - 1),
        state: "away",
        perch: 0,
        e: 0,
        t0: 0,
        dur: 0,
        flick: -1e9,
        land: -1e9,
        duck: -1e9,
      }));
    howGeo = { w, h, wireY, marks, ceilY };
    return true;
  }

  /* 0 as the steps come up past 58% of the viewport, 1 as they reach 14%. The
     start is deliberately LATE: `.steps::before` finishes drawing at `entry 62%`
     on its own view() timeline, so beginning the flock before that would put
     birds ahead of the line. Verified by measuring both at the same scroll
     positions rather than by reading the two ranges and hoping they agree. */
  function howProgress() {
    if (!howSteps) return 0;
    const r = howSteps.getBoundingClientRect();
    const vh = window.innerHeight || 1;
    return clamp((vh * 0.58 - r.top) / (vh * 0.44), 0, 1);
  }

  /* Arrivals come in from the right, like the CTA's and for the same reason —
     the Record taught that newer is to the right — so a bird joining the record
     is arriving from now. Because the flock fills left to right, later arrivals
     fly OVER birds that are already down, which is what the duck below is for. */
  function howFlightAt(b, e) {
    const g = howGeo;
    const tx = b.x;
    const ty = g.wireY;
    const sx = g.w + 60 + jit(b.i, 22) * 120;
    /* Every control point is clamped under the measured ceiling, not just the
       start: a cubic runs BETWEEN its controls, so holding only the endpoints
       down still lets the curve bow up through them. */
    const hi = (y) => Math.max(g.ceilY, y);
    const sy = hi(ty - 40 - jit(b.i, 23) * 22);
    const p1x = sx + (tx - sx) * 0.32;
    const p1y = hi(sy - 8);
    const p2x = tx + 52 + jit(b.i, 24) * 34;
    const p2y = hi(ty - 46);
    const m = 1 - e;
    const a = m * m * m;
    const bb = 3 * m * m * e;
    const c = 3 * m * e * e;
    const d = e * e * e;
    const da = 3 * m * m;
    const db = 6 * m * e;
    const dc = 3 * e * e;
    const vx = da * (p1x - sx) + db * (p2x - p1x) + dc * (tx - p2x);
    const vy = da * (p1y - sy) + db * (p2y - p1y) + dc * (ty - p2y);
    return {
      x: a * sx + bb * p1x + c * p2x + d * tx,
      y: a * sy + bb * p1y + c * p2y + d * ty,
      ang: Math.atan2(vy, vx),
    };
  }

  function drawHow(t) {
    if (!measureHow()) return;
    const g = howGeo;
    const ctx = howCanvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.round(g.w * dpr);
    const ch = Math.round(g.h * dpr);
    if (howCanvas.width !== cw || howCanvas.height !== ch) {
      howCanvas.width = cw;
      howCanvas.height = ch;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, g.w, g.h);

    const p = howProgress();
    for (const b of howFlock) {
      /* The threshold is checked against the state, not against the last frame's
         progress: a fast scroll that jumps the whole section in one frame still
         resolves every bird, and a scrub that jitters across a threshold cannot
         restart a flight that is already running. */
      const wanted = p >= b.p;
      if (wanted && b.state === "away") {
        b.state = "in";
        b.t0 = t;
        b.dur = 820 + jit(b.i, 25) * 260;
        b.e = 0;
      } else if (!wanted && (b.state === "on" || b.state === "in")) {
        b.state = "out";
        b.t0 = t;
        b.dur = 560;
        b.e = 0;
      }
      if (b.state === "in" || b.state === "out") {
        const e = clamp((t - b.t0) / b.dur, 0, 1);
        b.e = e;
        if (b.state === "in") {
          b.perch = e < 0.88 ? 0 : (e - 0.88) / 0.12;
          if (e >= 1) {
            b.state = "on";
            b.perch = 1;
            b.land = t;
            /* THE NEIGHBOURS REACT TO THE LANDING, NOT TO A FLY-OVER, AND THE
               FIRST VERSION OF THIS FIRED NEVER.
               It booked the duck at take-off, on everything standing between
               the target and the right edge — which reads correctly until you
               notice the flock fills LEFT TO RIGHT while every flight comes in
               from the RIGHT. The stretch a bird crosses is therefore precisely
               the stretch nobody has landed on yet: `o.perch > 0.3 && o.x > b.x`
               had no solutions on any frame, at any width, and nothing said so,
               because an animation that never plays is indistinguishable from
               one that was never asked for. Same shape as `#opCostNew` and the
               first `conditionFromName` — a reader whose selector matches
               nothing, failing silently.
               Landing is the event that actually has witnesses, and on ruling
               that cannot sag it is also the only honest one: a rigid line
               transmits no impulse, so what a neighbour reacts to is the bird
               itself arriving beside it. Spreads outward by distance so the
               reaction travels away from the newcomer instead of striking the
               whole line at once, and 190px keeps it to the nearest two or
               three at this spacing rather than a stadium wave. */
            for (const o of howFlock) {
              if (o === b || o.perch <= 0.3) continue;
              const gap = Math.abs(o.x - b.x);
              if (gap < 190) o.duck = t + 40 + gap * 0.5;
            }
          }
        } else {
          b.perch = e > 0.1 ? 0 : 1 - e / 0.1;
          if (e >= 1) {
            b.state = "away";
            b.perch = 0;
          }
        }
      }
    }

    /* The rule is dead flat, so every bird's y is the same one. */
    updateNotice(howFlock, howPtr, () => g.wireY);

    for (const b of howFlock) {
      if (b.state === "in" || b.state === "out") {
        const e = b.state === "in" ? easeOut(b.e) : b.e * b.e;
        const f = howFlightAt(b, b.state === "in" ? e : 1 - e);
        const u = b.state === "in" ? b.e : 1 - b.e;
        /* Beat, flare, fold — the CTA's three landing phases, on a shorter
           approach because this flight crosses a rule rather than a whole
           section and a long glide over 148px reads as hanging. */
        let spread;
        if (u < 0.7) spread = 0.34 + 0.66 * Math.abs(Math.sin(t / 62 + b.i * 1.9));
        else if (u < 0.9) spread = lerp(0.34 + 0.66 * Math.abs(Math.sin(t / 62 + b.i * 1.9)), 1, smooth((u - 0.7) / 0.2));
        else spread = 1 - smooth((u - 0.9) / 0.1);
        const size = lerp(HOW_FLY_SIZE, HOW_SIZE, smooth(clamp((u - 0.72) / 0.28, 0, 1)));
        drawBird(ctx, f.x, f.y - 5, f.ang, size, spread, clamp(u * 6, 0, 1) * (1 - b.perch));
      }
      if (b.perch > 0.02) {
        const age = t - b.flick;
        const flicking = age >= 0 && age < 620;
        const bob = Math.sin(t / 1180 + b.i * 2.3) * 0.6;
        /* The rule cannot dip, so the reaction to a bird landing alongside has
           to live in the standing one instead: a duck, down and back, on the
           body the legs already know how to absorb. `drawPerched` takes lift,
           so a negative one shortens the legs and the bird crouches where it
           stands — which is the whole trick, since the feet must not leave the
           line a rigid rule is holding them on. Booked at the landing above. */
        const dage = t - b.duck;
        const duck = dage >= 0 && dage < 420 ? -Math.sin((dage / 420) * Math.PI) * 2.6 : 0;
        const hop = flicking ? Math.sin((age / 620) * Math.PI) * 2.2 : 0;
        drawPerched(ctx, b.x, g.wireY, HOW_SIZE, bob + hop + duck + b.noticeA * 2.4, b.perch, b.noticeA, b.noticeD);
        if (flicking) {
          drawBird(ctx, b.x - 1, g.wireY - 15 - hop, Math.PI, HOW_SIZE, Math.sin((age / 620) * Math.PI) * 0.85, b.perch * 0.85);
        }
      }
    }

    /* Idle flicks only once the line has settled, and only ever one at a time —
       the header icons' rule. While the flock is still assembling there is
       already something moving, and a second thing twitching under it would read
       as noise rather than as life. */
    const settled = howFlock.length && howFlock.every((b) => b.state === "away" || b.state === "on");
    if (settled && t > howNextFlick) {
      const pool = howFlock.filter((b) => b.state === "on");
      const pick = pool[Math.floor(jit(Math.round(t / 97), 27) * pool.length)];
      if (pick) pick.flick = t;
      howNextFlick = t + 2600 + jit(Math.round(t / 53), 29) * 5600;
    }
  }

  /* The finished picture, for readers who asked for no motion: the rule full,
     which is the frame the section is arguing for. Same contract as
     `drawCtaStill` — `drawHow` never runs under reduced motion, so without this
     the canvas would simply be blank. */
  function drawHowStill() {
    if (!measureHow()) return;
    for (const b of howFlock) {
      b.state = "on";
      b.perch = 1;
      b.land = -1e9;
      b.flick = -1e9;
      b.duck = -1e9;
    }
    if (!howGeo) return;
    const ctx = howCanvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    howCanvas.width = Math.round(howGeo.w * dpr);
    howCanvas.height = Math.round(howGeo.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, howGeo.w, howGeo.h);
    for (const b of howFlock) drawPerched(ctx, b.x, howGeo.wireY, HOW_SIZE, 0, 1);
  }

  /* ══ Nav ═══════════════════════════════════════════════════════════════════
     The brand is a cycle with states. The flight is a CLASS rather than a long
     infinite keyframe track, which is what makes it retriggerable at all: a
     finished animation never restarts under the same name, so the 17s version
     could not respond to a hover, or to anything else. */

  const nav = $("nav");
  const brand = $("navBrand");
  const perch = $("navPerch");

  /* The repertoire. One scheduler, four behaviours, weighted — because the
     flight alone left the mark dead for fifteen to twenty-six seconds at a
     stretch, and a bird that is only alive once a page-view is a bird nobody
     sees be alive. `w` is the relative chance on a tick, `gap` the minimum time
     since that behaviour last ran, and `end` the ONE animation in its set whose
     finish means the behaviour is over.

     Keying the handler on `animationName` rather than on the target's class is
     what makes `end` a statement instead of a hope: each set fires several
     animationend events across three different elements, and the handler must
     ignore all but the last. Every `end` is therefore the longest in its set —
     `fly-go` 2.2s over `wing-go`'s 2.14 and the ducks' 2.156 — and the durations
     in `styles.css` cannot be raised past it without moving this.

     The hop is the one that TIES rather than leads: all three of its animations
     run 0.74s with no delay, because sharing a timebase is what pins the wings
     to the body (see `flick-go` in `styles.css`). Co-terminal is safe where
     merely-shorter would also have been — whichever of the three the engine
     reports first, the other two have already reached 100%, so the pose is
     final either way and only `dot-hop` clears `idleBusy`. What is NOT safe is
     lengthening one of the other two past it: that would strand the flag on an
     event nobody is listening for. */
  const IDLE = [
    { cls: "shift", end: "dot-shift", w: 46, gap: 3400 },
    { cls: "peck", end: "dot-peck", w: 30, gap: 8000 },
    { cls: "hop", end: "dot-hop", w: 11, gap: 26000 },
    { cls: "flit", end: "fly-go", w: 5, gap: 36000 },
    /* Doing nothing is a behaviour and needs a weight of its own, or the mark
       fidgets on every single tick. Roughly one tick in four is a rest. */
    { cls: "", end: "", w: 30, gap: 0 },
  ];
  /* `gap` does most of the shaping, and it does not shape the way the weights
     suggest. Measured over 250s at the first numbers, the mix came out shift 49%
     / peck 26% / hop 23% / flit 3% — the hop nearly level with the peck, because
     a behaviour on a long gap is competing against a SMALLER ready pool every
     time it re-enters one, which inflates it. So the loud one is held back by
     its gap rather than by its weight: 26s, which is what puts it back where the
     delight budget wants it (the rare beat, not a third of them). */
  const IDLE_END = new Map(IDLE.filter((b) => b.end).map((b) => [b.end, b.cls]));
  let idleTimer = 0;
  let idleBusy = "";
  let idleAt = 0;
  const idleLast = Object.create(null);

  /* Adds the class and nothing else. `idleBusy` is cleared by the animationend
     below, or by `flit` taking over, or by the watchdog in `idleTick` — a class
     removed mid-animation fires `animationcancel`, NOT `animationend`, so every
     path that removes one early has to clear the flag itself. */
  function idlePlay(cls) {
    if (!brand || idleBusy || reduced.matches) return;
    idleBusy = cls;
    idleAt = performance.now();
    idleLast[cls] = idleAt;
    brand.classList.add(cls);
  }

  function flit() {
    if (!brand || idleBusy === "flit" || reduced.matches) return;
    /* Hover jumps the queue, including over a running idle. Strip it first. */
    if (idleBusy) {
      brand.classList.remove(idleBusy);
      idleBusy = "";
    }
    idlePlay("flit");
  }

  function idleTick() {
    /* Watchdog. A backgrounded tab can swallow the animationend that would have
       cleared the flag — the same class of hazard as rAF not firing there — and
       a stuck flag is silent: the mark simply never moves again. Nothing here
       runs longer than 2.2s, so 4s is unambiguous. */
    if (idleBusy && performance.now() - idleAt > 4000) {
      brand.classList.remove(idleBusy);
      idleBusy = "";
    }
    if (!document.hidden && !reduced.matches && !idleBusy) {
      const now = performance.now();
      const ready = IDLE.filter((b) => now - (idleLast[b.cls] || -1e9) >= b.gap);
      let total = 0;
      for (const b of ready) total += b.w;
      let r = Math.random() * total;
      for (const b of ready) {
        r -= b.w;
        if (r <= 0) {
          if (b.cls) idlePlay(b.cls);
          break;
        }
      }
    }
    scheduleIdle();
  }

  /* Never on a metronome — a rhythm you can predict is one you stop seeing. */
  function scheduleIdle(first) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(idleTick, first ? 7000 + Math.random() * 4200 : 3400 + Math.random() * 4800);
  }
  function scheduleFlit() {
    /* The loud two are held back past the hero's own assembly: "never two at
       once" is the rule the header icons already follow, and a nav circuit
       crossing the title card is exactly the collision it exists to prevent. */
    idleLast.hop = idleLast.flit = performance.now();
    scheduleIdle(true);
  }

  if (brand) {
    brand.addEventListener("animationend", (e) => {
      const cls = IDLE_END.get(e.animationName);
      if (!cls) return;
      brand.classList.remove(cls);
      if (idleBusy === cls) idleBusy = "";
    });
    brand.addEventListener("pointerenter", flit);
  }

  /* The bird notices you before it goes: the perch leans a couple of pixels
     toward the cursor while it is near, and returns when you leave. Two pixels
     deliberately — enough to register, not enough to look like a bug. */
  function trackCursor(e) {
    if (!perch) return;
    const r = perch.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy) || 1;
    const reach = 190;
    if (d > reach) {
      perch.style.setProperty("--lx", "0px");
      perch.style.setProperty("--ly", "0px");
      return;
    }
    const k = (1 - d / reach) * 2.6;
    perch.style.setProperty("--lx", ((dx / d) * k).toFixed(2) + "px");
    perch.style.setProperty("--ly", ((dy / d) * k).toFixed(2) + "px");
  }

  /* ══ What still needs JS ═══════════════════════════════════════════════════
     The reveals themselves are CSS scroll-driven timelines. What is left here
     is only what CSS cannot do: numbers that count, meters whose width is data,
     and the in-view flag that arms the bell. */

  function countUp(el, to) {
    if (reduced.matches) {
      el.textContent = to.toLocaleString("en-US");
      return;
    }
    const dur = 900;
    const t0 = performance.now();
    const tick = (t) => {
      const k = clamp((t - t0) / dur, 0, 1);
      el.textContent = Math.round(to * easeOut(k)).toLocaleString("en-US");
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  let featureDone = false;
  function animateFeature() {
    if (featureDone) return;
    featureDone = true;
    if (reduced.matches) return drawFeature(1);
    const dur = 1500;
    const t0 = performance.now();
    const tick = (t) => {
      const k = clamp((t - t0) / dur, 0, 1);
      drawFeature(easeOut(k));
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const el = en.target;
        io.unobserve(el);
        el.classList.add("in-view");
        for (const m of el.querySelectorAll("[data-meter]")) m.style.width = m.dataset.meter + "%";
        for (const c of el.querySelectorAll("[data-count]")) countUp(c, +c.dataset.count);
        if (el.querySelector(".art-chart")) animateFeature();
      }
    },
    { threshold: 0.25 }
  );

  /* ══ Boot ══════════════════════════════════════════════════════════════════ */

  let reelDirty = true;
  let heroStart = 0;
  /* Starts true rather than waiting on the observer: the hero IS the top of the
     document, so the first frames are always its frames, and an observer
     callback that lands two frames late would clip the head off the arrival. */
  let heroVisible = true;
  let ctaVisible = false;
  let howVisible = false;

  function onScroll() {
    reelDirty = true;
    if (nav) nav.classList.toggle("stuck", window.scrollY > 12);
    if (reel.section && nav) {
      const r = reel.stage.getBoundingClientRect();
      /* The nav swaps its links for the readout only while the record is
         genuinely the thing on screen. */
      const pinned = r.top <= 4 && r.bottom > window.innerHeight * 0.5;
      nav.classList.toggle("reading", pinned && !reduced.matches);
      if (window.scrollY > 40) reel.section.classList.add("moved");
    }
  }

  function frame(t) {
    /* Unlike the old hero this one never finishes — the flock goes on breathing
       and the wire goes on answering the pointer — so it is gated on being on
       screen instead of on being done. */
    if (heroVisible && !reduced.matches) {
      if (!heroStart) heroStart = t;
      drawSky(t - heroStart, t);
    }
    if (reelDirty) {
      reelDirty = false;
      paintReel(reelProgress());
    }
    if (ctaVisible && !reduced.matches) drawCta(t);
    if (howVisible && !reduced.matches) drawHow(t);
    requestAnimationFrame(frame);
  }

  function redrawAll() {
    /* Before anything is drawn, not after: the strip's playhead, the annotation
       plane's rate and the price scale are all functions of the viewport, and a
       frame painted against last size's geometry puts the marginalia under the
       wrong readings. Safe to call from the ResizeObserver — it writes only
       custom properties and the scale's contents, and observes neither. */
    layoutReel();
    reelDirty = true;
    /* Drawn finished. During the arrival this is immediately overwritten by the
       next animation frame, which is what lets a resize mid-flight repaint
       without ending the choreography early. */
    if (sky) drawSky(1e6, performance.now());
    if (featureDone) drawFeature(1);
    if (reduced.matches) {
      drawCtaStill();
      drawHowStill();
    } else {
      drawCta(performance.now());
      drawHow(performance.now());
    }
  }

  function init() {
    fillTag();

    document.body.classList.add("play");
    for (const el of document.querySelectorAll(".feature")) io.observe(el);

    if (reduced.matches) {
      /* No pin and no scrub: the CSS has already collapsed the track, so draw
         the record finished and leave the page COMPLETE rather than merely
         still. Everything gated behind an observer is resolved here too. */
      paintReel(1);
      featureDone = true;
      drawFeature(1);
      drawCtaStill();
      drawHowStill();
      for (const m of document.querySelectorAll("[data-meter]")) m.style.width = m.dataset.meter + "%";
      for (const c of document.querySelectorAll("[data-count]")) c.textContent = c.dataset.count;
    } else {
      scheduleFlit();
      window.addEventListener("pointermove", trackCursor, { passive: true });
      window.addEventListener("pointermove", heroPointer, { passive: true });
      window.addEventListener("pointermove", noticePointer, { passive: true });
      window.addEventListener(
        "pointerleave",
        () => {
          heroPtr = null;
          ptrClient = null;
        },
        { passive: true }
      );
    }

    /* The canvases join the chapter arc here. `motion.js` publishes the change
       and owns the timing, so the two never disagree about which chapter it is
       — the alternative, a second scroll listener in this file computing its
       own answer, is the exact drift the substrate exists to prevent.

       The swap is instant while the CSS ground takes 900ms to cross. That is
       the right asymmetry rather than a bug to fix: the panel these canvases
       sit inside is crossing at the same 900ms, so a chart that faded with it
       would spend half a second at a contrast neither palette was measured
       against, whereas one that switches immediately is briefly the new
       chapter's chart on the old chapter's card — legible at both ends. */
    applyPalette(window.JD?.chapter || "paper");
    redrawAll();
    window.JD?.onChapter?.((name) => {
      applyPalette(name);
      redrawAll();
    });

    wireRail();

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", redrawAll);
    /* A canvas loses its contents when its backing store is resized, and the
       layout that sets that size can settle after load (fonts, scrollbars). An
       observer per surface is the only thing that catches all of it — including
       the case where a canvas reported clientWidth 0 on the first attempt. */
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => redrawAll());
      /* The stage is in here as well as the leaf, because the record's geometry
         is a function of the STAGE's width — the playhead, the strip's travel
         and the beats' offsets are all derived from it, and the leaf's own
         width is derived from that in turn. Observing it cannot loop: every
         child of the stage is absolutely positioned inside a fixed-height,
         overflow-hidden box, so neither `buildScale`'s rows nor a wider strip
         can feed back into the size being watched. */
      for (const c of [sky, reel.stage, reel.canvas, fCanvas, ctaCanvas, howCanvas]) if (c) ro.observe(c);
    }
    /* requestAnimationFrame does not fire in a backgrounded tab, so a surface
       first reached while the tab was hidden stays blank on return. */
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) redrawAll();
    });

    if (ctaCanvas) {
      new IntersectionObserver(
        (e) => {
          ctaVisible = e[0].isIntersecting;
          if (ctaVisible) drawCta(performance.now());
        },
        { threshold: 0 }
      ).observe(ctaCanvas);
    }

    /* Watched on its own SECTION rather than on the canvas: the canvas is a
       148px band and the flock is scrubbed against the section's travel, so
       gating on the strip alone would stop the loop while the scrub still had
       most of its range left to run and freeze the flock mid-gather. */
    if (howCanvas && howSection) {
      new IntersectionObserver(
        (e) => {
          howVisible = e[0].isIntersecting;
          if (howVisible) drawHow(performance.now());
        },
        { threshold: 0 }
      ).observe(howSection);
    }

    /* Scrolled past, the flock stops costing anything. It is only ever turned
       OFF by this — see heroVisible's declaration for why it starts true. */
    if (sky) {
      new IntersectionObserver((e) => (heroVisible = e[0].isIntersecting), { threshold: 0 }).observe(sky);
    }

    reduced.addEventListener("change", () => location.reload());
    requestAnimationFrame(frame);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  /* Fonts change text metrics, which changes the axis gutter the chart reserves
     — redraw once they are in, rather than shipping a chart measured against a
     fallback face. */
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(redrawAll);
})();
