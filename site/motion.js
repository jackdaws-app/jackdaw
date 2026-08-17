/* Jackdaw — jackdaws.app
   ────────────────────────────────────────────────────────────────────────────
   THE MOTION SUBSTRATE. Everything on this page that moves in response to the
   scroll position runs off the three values this file publishes, and nothing
   else is allowed to read the scroll position directly. That is the whole
   point of the file: a long page with four independent scroll listeners is a
   page with four slightly different opinions about where it is, and the
   disagreement shows up as a shudder on exactly the surfaces you most wanted
   to be smooth.

   ONE CLOCK. Lenis owns the scroll, GSAP's ticker owns the frame, and
   ScrollTrigger recomputes only when Lenis says the position moved. Lenis is
   the right smoother for this page specifically because it drives the REAL
   document scroll rather than transforming a wrapper — so `position: sticky`,
   `scrollY`, anchor links, find-in-page and the browser's own scrollbar all
   keep working, and main.js's existing canvas scrubbing needs no changes.

   THREE PUBLISHED VALUES, all as CSS custom properties on <html>, because the
   cheapest possible consumer of a scroll signal is a CSS rule that already
   knows how to interpolate:
     --scroll-vel   signed, roughly -1..1, how fast and which way (skew, lag)
     --scroll-prog  0..1 through the whole document (progress rails)
     data-chapter   which ground the page is standing on (night / paper)

   WHAT THIS FILE WILL NOT DO. It will not animate anything itself. Sections
   register their own ScrollTriggers; this only guarantees they are all being
   asked the same question at the same instant.

   REDUCED MOTION IS A DIFFERENT PAGE, NOT A SLOWER ONE. Lenis never boots,
   the velocity signal is pinned at zero, and every consumer is expected to
   land on its finished state. The page must be COMPLETE when still — that is
   the house rule and it is the reason the chapter attribute is still set: the
   grounds still change, they just change instantly.
   ──────────────────────────────────────────────────────────────────────────── */

(() => {
  "use strict";

  const root = document.documentElement;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* A no-op stand-in published under the same name, so a consumer never has to
     ask whether motion booted — it asks the substrate for a value and gets a
     truthful one either way. A module that has to branch on `if (window.JD)`
     will eventually forget to, and the failure lands in the reduced-motion
     path, which is the one nobody looks at. */
  const JD = (window.JD = {
    lenis: null,
    reduced: reduced.matches,
    /* Fires when a chapter boundary is crossed. Canvas palettes need it —
       CSS custom properties do not reach into a 2D context. */
    onChapter: (fn) => chapterSubs.push(fn),
    chapter: "night",
    scrollTo: (target, opts) => {
      const el = typeof target === "string" ? document.querySelector(target) : target;
      if (!el) return;
      if (JD.lenis) JD.lenis.scrollTo(el, { offset: -24, duration: 1.1, ...opts });
      /* Asked for on the call, not inherited from the stylesheet: `has-motion`
         turns CSS `scroll-behavior` off page-wide because ScrollTrigger cannot
         measure through it (see styles.css), and this is the one path that had
         been getting its smoothing from there — GSAP present, Lenis missing. */
      else el.scrollIntoView({ block: "start", behavior: JD.reduced ? "auto" : "smooth" });
    },
  });

  const chapterSubs = [];

  /* ── Chapters ────────────────────────────────────────────────────────────
     The page's ground colour is a chapter marker, not a decoration: night for
     the opening title card, paper for the explanatory middle where the ledger
     material lives, night again for the close. It is set as an attribute on
     <html> so the entire cascade can respond — a card, a rule, an eyebrow and
     the scrollbar all shift together off one write, and no JS has to know
     which elements exist.

     The attribute is authored by the sections themselves (below), not by a
     hardcoded scroll table, because a table of pixel offsets is wrong the
     moment a paragraph is edited. */
  function setChapter(name) {
    if (name === JD.chapter) return;
    JD.chapter = name;
    root.setAttribute("data-chapter", name);
    for (const fn of chapterSubs) fn(name);
  }
  setChapter("night");
  root.setAttribute("data-chapter", "night");

  /* ── Boot ────────────────────────────────────────────────────────────────
     Three ways this can fail and all three must land on a page that works: a
     blocked script, an old browser, and reduced motion. So the guard is on the
     globals actually being there rather than on a version check, and the
     fallback is a native scroll page with every scroll-linked effect resolved
     to its end state by the `no-motion` class. */
  const haveGsap = typeof window.gsap !== "undefined" && typeof window.ScrollTrigger !== "undefined";
  const haveLenis = typeof window.Lenis !== "undefined";

  if (!haveGsap) {
    root.classList.add("no-motion");
    return;
  }

  const { gsap, ScrollTrigger } = window;
  gsap.registerPlugin(ScrollTrigger);
  root.classList.add("has-motion");

  /* GSAP pauses its ticker after a long frame gap and then catches up — which
     is right for a game loop and wrong for a scroll page, where a tab that was
     backgrounded for a minute should resume at the position it is at, not
     replay a minute of scrolling. */
  gsap.ticker.lagSmoothing(0);

  if (!JD.reduced && haveLenis) {
    const lenis = new window.Lenis({
      /* 1.05 is a long glide — deliberately. The reference page this bar was
         set against runs a similarly heavy one, and it is most of why a page
         "feels expensive": the pointer stops and the page keeps arriving. Any
         shorter and the smoothing reads as lag rather than mass. */
      duration: 1.05,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      /* Touch is left alone. A phone's own scroll physics are better than any
         JS approximation and fighting them is what makes a site feel broken on
         mobile — the smoothing is a desktop-pointer affordance. */
      smoothWheel: true,
      syncTouch: false,
      wheelMultiplier: 1,
    });
    JD.lenis = lenis;

    /* The two halves of the integration. Without the first, ScrollTrigger
       samples on the browser's scroll event — which Lenis fires from inside a
       rAF callback, one frame stale — and every pinned element trails the
       content it is pinned to by a visible amount at speed. */
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add((time) => lenis.raf(time * 1000));
  }

  /* ── Velocity ────────────────────────────────────────────────────────────
     Published, not consumed here. The uses are all the same shape — something
     with mass lagging behind something without it — and they belong in the
     stylesheet next to the element they bend.

     Normalised against a full viewport per second rather than against pixels,
     so the same rule behaves the same on a laptop and a 4K display. Smoothed
     on the way out because raw wheel deltas are spiky enough to read as jitter
     when they drive a transform; the asymmetry (fast to rise, slow to fall) is
     what makes it feel like inertia rather than a meter. */
  let vel = 0;
  let prog = 0;
  const NORM = () => Math.max(600, window.innerHeight) * 1.0;

  function writeProg() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const p = max > 0 ? (JD.lenis ? JD.lenis.scroll : window.scrollY) / max : 0;
    prog = Math.max(0, Math.min(1, p));
    root.style.setProperty("--scroll-prog", prog.toFixed(4));
  }

  if (!JD.reduced) {
    gsap.ticker.add(() => {
      const raw = JD.lenis ? JD.lenis.velocity : 0;
      const target = Math.max(-1, Math.min(1, raw / NORM()));
      /* Rise fast, settle slow. Equal rates give a value that snaps back to
         zero the instant the wheel stops, which kills the follow-through that
         is the entire reason for having the signal. */
      vel += (target - vel) * (Math.abs(target) > Math.abs(vel) ? 0.28 : 0.09);
      if (Math.abs(vel) < 0.0005) vel = 0;

      /* Rounded before writing. A custom property write is cheap but a style
         recalc on every consumer is not, and past three decimals nothing on
         screen can tell the difference. */
      root.style.setProperty("--scroll-vel", vel.toFixed(3));
      writeProg();
    });
  } else {
    /* THE TWO SIGNALS PART COMPANY HERE, AND ONLY ONE OF THEM IS MOTION.
       Velocity is: it exists to make things lag, and a reader who asked for no
       motion is asking for exactly that not to happen, so it is pinned at zero
       and every consumer resolves to its resting shape.
       PROGRESS IS NOT. It is a fact about where the document is — the same fact
       the scrollbar states — and pinning it at 0 does not remove an animation,
       it removes an instrument and leaves a gauge reading empty at the bottom
       of the page. That is the file's own rule ("the page must be COMPLETE when
       still") failing in the direction nobody checks: still, and wrong.
       So it is published either way, off the browser's own scroll event since
       there is no ticker to hang it on, coalesced to one write per frame
       because a scroll event can outrun the compositor. */
    root.style.setProperty("--scroll-vel", "0");
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        writeProg();
      });
    };
    writeProg();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", writeProg, { passive: true });
  }

  /* ── Chapter registration ────────────────────────────────────────────────
     A section declares its own ground with `data-ground`, and crossing the
     midpoint of the viewport hands the page over. Midpoint and not the top
     edge, because a ground that changes when a section's first pixel appears
     changes while the previous section still fills most of the screen — the
     eye reads that as a flicker, not a transition. */
  function registerChapters() {
    const marked = document.querySelectorAll("[data-ground]");
    for (const el of marked) {
      const ground = el.getAttribute("data-ground");
      ScrollTrigger.create({
        trigger: el,
        start: "top 50%",
        end: "bottom 50%",
        onToggle: (self) => self.isActive && setChapter(ground),
        /* Scrubbing back up must restore the previous ground, and the only
           thing that knows what it was is the section above. Handing it back
           on leave-back is what makes the arc symmetrical. */
        onLeaveBack: () => {
          const prev = previousGround(el);
          if (prev) setChapter(prev);
        },
      });
    }
  }

  function previousGround(el) {
    const all = [...document.querySelectorAll("[data-ground]")];
    const i = all.indexOf(el);
    return i > 0 ? all[i - 1].getAttribute("data-ground") : null;
  }

  /* ── Magnetic controls ───────────────────────────────────────────────────
     Gated on a real pointer, and on reduced motion being off. A magnet on a
     touch device is a control that moves out from under the finger already
     pressing it. */
  const fine = window.matchMedia("(hover: hover) and (pointer: fine)");

  function magnetise(el) {
    const pull = parseFloat(el.dataset.magnet || "0.28");
    const qx = gsap.quickTo(el, "x", { duration: 0.5, ease: "power3.out" });
    const qy = gsap.quickTo(el, "y", { duration: 0.5, ease: "power3.out" });
    /* The inner label moves further than its container, so the button reads as
       a surface with something floating inside it rather than a whole object
       sliding — the same reason a physical key's legend and its cap are not
       the same piece of plastic. */
    const label = el.querySelector("[data-magnet-label]");
    const qlx = label ? gsap.quickTo(label, "x", { duration: 0.6, ease: "power3.out" }) : null;
    const qly = label ? gsap.quickTo(label, "y", { duration: 0.6, ease: "power3.out" }) : null;

    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      qx(dx * pull);
      qy(dy * pull);
      if (qlx) {
        qlx(dx * pull * 0.45);
        qly(dy * pull * 0.45);
      }
    });
    el.addEventListener("pointerleave", () => {
      /* Springs home rather than easing home. A magnet that lets go should
         overshoot slightly — it is the difference between released and
         switched off. */
      gsap.to(el, { x: 0, y: 0, duration: 0.8, ease: "elastic.out(1, 0.4)" });
      if (label) gsap.to(label, { x: 0, y: 0, duration: 0.9, ease: "elastic.out(1, 0.36)" });
    });
  }

  function registerMagnets() {
    if (JD.reduced || !fine.matches) return;
    for (const el of document.querySelectorAll("[data-magnet]")) magnetise(el);
  }

  /* ── Anchor links ────────────────────────────────────────────────────────
     Native smooth scrolling and Lenis are two smoothers fighting for the same
     scroll position, and the browser wins the first frame and Lenis wins the
     rest, which reads as a stutter at the start of every jump. So in-page
     anchors are handed to Lenis explicitly. */
  function registerAnchors() {
    document.addEventListener("click", (e) => {
      const a = e.target.closest?.('a[href^="#"]');
      if (!a) return;
      const id = a.getAttribute("href");
      if (!id || id === "#") return;
      const el = document.querySelector(id);
      if (!el) return;
      e.preventDefault();
      JD.scrollTo(el);
      /* The URL still changes — a jump the user cannot bookmark or go back
         from is a downgrade, and preventDefault() removed both. */
      history.pushState(null, "", id);
    });
  }

  function boot() {
    registerChapters();
    registerMagnets();
    registerAnchors();
    /* Fonts land after first paint and every trigger measured against text
       is wrong until they do. One refresh at that point is cheaper and more
       reliable than making each section defer its own measurement. */
    if (document.fonts?.ready) document.fonts.ready.then(() => ScrollTrigger.refresh());
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
