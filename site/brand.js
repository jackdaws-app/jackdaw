/* ════════════════════════════════════════════════════════════════════════════
   THE MARK — every page, every footer, one bird at a time
   ════════════════════════════════════════════════════════════════════════════

   The brand is a cycle rather than a logo: a green dot that BECOMES the bird,
   flies the width of the word, banks, comes home and lands as the dot again —
   with the letters ducking as it passes over them. Between flights it is not
   idle; it shifts its weight, pecks at the J, hops. Four behaviours on one
   never-metronomic scheduler, weighted, the loud ones held back by a cooldown
   rather than by their odds.

   IT LIVED IN main.js AND HAD TO MOVE, because that file owns exactly one
   page. Two things forced the extraction and neither is tidiness:

     · There are now marks in FOOTERS, so a page carries two or three, and the
       old code was written against one — `$("navBrand")` and a single
       module-scoped `idleBusy` flag between them.
     · There are now pages besides the landing page. Copying the scheduler into
       each is the two-sources-of-truth problem the feature chart was rewritten
       to eliminate, arriving on a second surface.

   WHAT GENERALISING FROM ONE TO N ACTUALLY CHANGED — three rules, all of them
   consequences of the project's own conventions rather than new inventions:

     1. ONE bird moves at a time, page-wide. "Never two at once" is the rule the
        extension's header icons already follow, and two marks fidgeting in
        sync would read as a screensaver rather than as something alive. So the
        busy flag is global and the scheduler picks a mark, then a behaviour.
     2. Only marks IN THE VIEWPORT are eligible. An animation on an off-screen
        footer burns invisibly (CONVENTIONS.md) — and worse, it holds the
        global flag while it does, so the visible mark in the nav goes quiet
        for the duration. The footer's bird is not a second bird; it is the
        same bird, wherever you happen to be looking.
     3. Hover jumps the queue on the mark you are pointing at, which is what it
        always did, now with somewhere to put the answer.

   THE MARKUP IS BUILT HERE, from a two-element stub in the HTML:

       <a class="brand-mark" href="…" aria-label="Jackdaw, home">
         <span class="brand-perch"><span class="brand-dot"></span></span>
         <span class="brand-word">Jackdaw</span>
       </a>

   The stub is what a reader with no JavaScript gets: the dot and the word, in
   the right colours, sitting still. Everything this file adds — the silhouette
   and the per-letter spans — exists only to move, so there is nothing to lose
   by making it conditional on the thing that moves it.

   GEOMETRY IS SHARED, WHICH MEANS THE BOX SIZE IS NOT NEGOTIABLE. Every offset
   in `fly-go` is a measured pixel distance against a 15px "JACKDAW" (see the
   corridor note in styles.css). The footer mark is therefore set at the same
   15px as the nav's, and any future placement has to be too, or it needs its
   own flight tuned against its own box. */

(function () {
  "use strict";

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* Overhead flying silhouette, drawn to the measured proportion rather than by
     eye: a jackdaw's wingspan is ~2x its body length and the two blades carry
     ~3.5x the body's area. The first version had a long heavy lozenge and
     stubby swept wings — a ratio of 1.2 — which at this size rendered as a dark
     smudge with spikes. Wings are drawn FIRST so the body overlaps their roots;
     the hop reuses the same silhouette, retinted and pushed behind the dot, so
     the flick reads as the dot's own wings opening. */
  var FLIT_SVG =
    '<svg class="brand-flit" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true">' +
    '<g class="brand-flit-wings">' +
    '<path d="M63 45.6 C61.5 34 56.5 19.5 49.5 6.5 L46.2 15.2 L42.8 10.2 L41.2 19.4 L37.4 16.4 L36.8 25.8 L32.8 24.2 L34 33.2 C38.4 38.4 43 42.4 46 45.6 Z" />' +
    '<path d="M63 54.4 C61.5 66 56.5 80.5 49.5 93.5 L46.2 84.8 L42.8 89.8 L41.2 80.6 L37.4 83.6 L36.8 74.2 L32.8 75.8 L34 66.8 C38.4 61.6 43 57.6 46 54.4 Z" />' +
    "</g>" +
    '<path d="M38 47 L23 41.4 L25.4 45.8 L20.6 44.8 L23.2 48.8 L19.2 50 L23.2 51.2 L20.6 55.2 L25.4 54.2 L23 58.6 L38 53 Z" />' +
    '<path d="M79 50 C73.5 46.2 67 44.8 59 44.6 C51 44.4 43 45.6 37.5 47.2 L37.5 52.8 C43 54.4 51 55.6 59 55.4 C67 55.2 73.5 53.8 79 50 Z" />' +
    "</svg>";

  /* The repertoire. `w` is the relative chance on a tick, `gap` the minimum time
     since that behaviour last ran ANYWHERE on the page, and `end` the one
     animation in its set whose finish means the behaviour is over.

     Keying the handler on `animationName` rather than on the target's class is
     what makes `end` a statement instead of a hope: each set fires several
     animationend events across three different elements and the handler must
     ignore all but the last. Every `end` is therefore the longest in its set —
     `fly-go` 2.2s over `wing-go`'s 2.14 and the ducks' 2.156 — and the
     durations in styles.css cannot be raised past it without moving this.

     The hop is the one that TIES rather than leads: all three of its animations
     run 0.74s with no delay, because sharing a timebase is what pins the wings
     to the body. Co-terminal is safe where merely-shorter would also have been
     — whichever of the three the engine reports first, the other two have
     already reached 100% — but lengthening either of the other two past
     `dot-hop` would strand the flag on an event nobody is listening for.

     `gap` does most of the shaping, and not the way the weights suggest.
     Measured over 250s at the first numbers the mix came out shift 49% / peck
     26% / hop 23% / flit 3%: a behaviour on a long gap competes against a
     SMALLER ready pool every time it re-enters one, which inflates it. So the
     loud one is held back by its gap rather than by its weight. */
  var IDLE = [
    { cls: "shift", end: "dot-shift", w: 46, gap: 3400 },
    { cls: "peck", end: "dot-peck", w: 30, gap: 8000 },
    { cls: "hop", end: "dot-hop", w: 11, gap: 26000 },
    { cls: "flit", end: "fly-go", w: 5, gap: 36000 },
    /* Doing nothing is a behaviour and needs a weight of its own, or the mark
       fidgets on every single tick. Roughly one tick in four is a rest. */
    { cls: "", end: "", w: 30, gap: 0 },
  ];

  var IDLE_END = {};
  IDLE.forEach(function (b) {
    if (b.end) IDLE_END[b.end] = b.cls;
  });

  var marks = [];
  var timer = 0;
  /* Page-global, not per-mark: rule 1 above. `busy` is the class currently
     running and `busyMark` the element running it. */
  var busy = "";
  var busyMark = null;
  var busyAt = 0;
  var last = Object.create(null);

  /* Adds the class and nothing else. The flag is cleared by the animationend
     below, by a hover taking over, or by the watchdog in `tick` — a class
     removed mid-animation fires `animationcancel`, NOT `animationend`, so every
     path that removes one early has to clear the flag itself. */
  function play(mark, cls) {
    if (busy || reduced.matches) return;
    busy = cls;
    busyMark = mark;
    busyAt = performance.now();
    last[cls] = busyAt;
    mark.classList.add(cls);
  }

  function stop() {
    if (busyMark) busyMark.classList.remove(busy);
    busy = "";
    busyMark = null;
  }

  /* A mark is eligible if any part of it is on screen. Cheap enough to do on a
     tick — there are two or three of these, not two hundred — and honest in a
     way an IntersectionObserver would not be here: the answer is wanted at the
     instant of the decision, not as of the last time the browser looked. */
  function onScreen(el) {
    var r = el.getBoundingClientRect();
    return (
      r.bottom > 0 &&
      r.top < (window.innerHeight || document.documentElement.clientHeight) &&
      r.right > 0 &&
      r.left < (window.innerWidth || document.documentElement.clientWidth)
    );
  }

  function flit(mark) {
    if (reduced.matches) return;
    if (busy === "flit" && busyMark === mark) return;
    /* Hover jumps the queue, including over a running idle — on any mark, since
       only one runs at a time and the pointer is the more recent evidence about
       where the reader is looking. */
    if (busy) stop();
    play(mark, "flit");
  }

  function tick() {
    /* Watchdog. A backgrounded tab can swallow the animationend that would have
       cleared the flag — the same class of hazard as rAF not firing there — and
       a stuck flag is silent: the mark simply never moves again. Nothing here
       runs longer than 2.2s, so 4s is unambiguous. */
    if (busy && performance.now() - busyAt > 4000) stop();

    if (!document.hidden && !reduced.matches && !busy) {
      var visible = marks.filter(onScreen);
      if (visible.length) {
        /* Mark first, then behaviour. Picking the behaviour first and then
           looking for somewhere to put it would let a cooled-down flit choose a
           mark that has just scrolled out from under the reader. */
        var mark = visible[(Math.random() * visible.length) | 0];
        var now = performance.now();
        var ready = IDLE.filter(function (b) {
          return now - (last[b.cls] || -1e9) >= b.gap;
        });
        var total = 0;
        ready.forEach(function (b) {
          total += b.w;
        });
        var r = Math.random() * total;
        for (var i = 0; i < ready.length; i++) {
          r -= ready[i].w;
          if (r <= 0) {
            if (ready[i].cls) play(mark, ready[i].cls);
            break;
          }
        }
      }
    }
    schedule();
  }

  /* Never on a metronome — a rhythm you can predict is one you stop seeing. */
  function schedule(first) {
    clearTimeout(timer);
    timer = setTimeout(tick, first ? 7000 + Math.random() * 4200 : 3400 + Math.random() * 4800);
  }

  /* The bird notices you before it goes: the perch leans a couple of pixels
     toward the cursor while it is near, and returns when you leave. Two pixels
     deliberately — enough to register, not enough to look like a bug.

     The lean lives on `.brand-perch` and never on `.brand-dot`, because the
     dot's squash-and-stretch is an animation and a running animation overrides
     the cascade: the two would fight over one transform. */
  function trackCursor(e) {
    for (var i = 0; i < marks.length; i++) {
      var perch = marks[i].querySelector(".brand-perch");
      if (!perch) continue;
      var r = perch.getBoundingClientRect();
      var dx = e.clientX - (r.left + r.width / 2);
      var dy = e.clientY - (r.top + r.height / 2);
      var d = Math.hypot(dx, dy) || 1;
      var reach = 190;
      if (d > reach) {
        perch.style.setProperty("--lx", "0px");
        perch.style.setProperty("--ly", "0px");
        continue;
      }
      var k = (1 - d / reach) * 2.6;
      perch.style.setProperty("--lx", ((dx / d) * k).toFixed(2) + "px");
      perch.style.setProperty("--ly", ((dy / d) * k).toFixed(2) + "px");
    }
  }

  /* One letter per span, because the duck is a WAVE: `--i` is the letter's index
     and the delay is computed from it, so the dip travels under the bird rather
     than happening to the word all at once. The return leg runs the other way,
     which is the subtraction in the delay pair in styles.css. */
  function splitWord(word) {
    var text = (word.textContent || "").trim();
    if (!text || word.querySelector("i")) return;
    word.setAttribute("aria-hidden", "true");
    word.textContent = "";
    for (var i = 0; i < text.length; i++) {
      var span = document.createElement("i");
      span.style.setProperty("--i", String(i));
      span.textContent = text[i];
      word.appendChild(span);
    }
  }

  function upgrade(mark) {
    var word = mark.querySelector(".brand-word");
    if (!word) return;
    /* The anchor must carry the name for a screen reader before the visible
       word is split into seven meaningless letters and hidden. */
    if (!mark.getAttribute("aria-label")) mark.setAttribute("aria-label", (word.textContent || "").trim());
    splitWord(word);
    if (!mark.querySelector(".brand-flit")) {
      var perch = mark.querySelector(".brand-perch");
      var frag = document.createElement("template");
      frag.innerHTML = FLIT_SVG;
      /* After the perch and before the word: the SVG is absolutely positioned
         off the mark, so document order decides nothing about where it lands —
         but it does decide the paint order against siblings at the same
         z-index, and the flight has to be over the letters. */
      mark.insertBefore(frag.content.firstChild, word);
      if (perch) perch.style.setProperty("--lx", "0px");
    }
    mark.addEventListener("animationend", function (e) {
      var cls = IDLE_END[e.animationName];
      if (!cls) return;
      mark.classList.remove(cls);
      if (busy === cls && busyMark === mark) {
        busy = "";
        busyMark = null;
      }
    });
    mark.addEventListener("pointerenter", function () {
      flit(mark);
    });
    marks.push(mark);
  }

  function start(opts) {
    var held = opts && opts.hold;
    if (held) {
      /* The loud two are held back past whatever the page is assembling in its
         opening seconds: "never two at once" again, one level up. A nav circuit
         crossing the landing page's own title card is exactly the collision the
         rule exists to prevent, and stamping the cooldowns is how you say "not
         yet" without inventing a second gate to forget about later. */
      last.hop = last.flit = performance.now();
    }
    schedule(true);
  }

  function boot() {
    var found = document.querySelectorAll(".brand-mark");
    for (var i = 0; i < found.length; i++) upgrade(found[i]);
    if (!marks.length || reduced.matches) return;
    window.addEventListener("pointermove", trackCursor, { passive: true });
    /* The landing page holds the loud behaviours itself, once its hero has
       finished assembling. Every other page has nothing to wait for. */
    if (!document.documentElement.hasAttribute("data-brand-hold")) start();
  }

  window.JackdawBrand = {
    /* main.js calls this when the landing page's own opening is done with the
       screen. Idempotent, and safe to call before or after boot. */
    hold: function () {
      start({ hold: true });
    },
    marks: marks,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
