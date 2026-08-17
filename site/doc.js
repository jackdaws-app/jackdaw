/* The document pages' motion, and there is deliberately very little of it.
   These are the terms, the privacy policy and the letter — pages whose job is
   to be read, not to perform — so the whole file is three small things:

     · the nav pill's `stuck` state, so the chrome behaves the way it does on
       the landing page;
     · `--scroll-prog`, which the pill's own bottom border reads as a brass
       reading rail. On the landing page motion.js writes it off Lenis; here
       there is no Lenis and no GSAP, so it is one scroll listener;
     · the chapter handover, so a page that changes ground mid-scroll takes the
       chrome with it;
     · a quiet reveal per section.

   NO GSAP, NO LENIS, NO SCROLLTRIGGER. A privacy policy that pulls 90KB of
   animation library to fade a heading in has its priorities inverted, and the
   page a visitor reaches when they want to know what is collected should be
   the lightest page on the site rather than the heaviest.

   THE REVEAL IS HIDDEN BY A CLASS THE HEAD SETS, NOT BY THE STYLESHEET ALONE.
   `doc.css` hides `.doc-sec` only under `html.reveal`, and only this file's
   companion one-liner in <head> adds it — so with JavaScript off the sections
   were never hidden in the first place. Everything below is failure-tolerant in
   the same direction: if the observer never fires, `SAFETY` reveals the lot. A
   legal document that can be invisible is a worse bug than one that never
   animates. Printing is guarded in the stylesheet for the same reason. */
(function () {
  var root = document.documentElement;
  var nav = document.querySelector(".nav");
  var secs = [].slice.call(document.querySelectorAll(".doc-sec"));
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ── The chrome ──────────────────────────────────────────────────────────
     Both values come off one listener and one rAF, because they are read in
     the same frame by the same element and two listeners would be two chances
     to disagree about where the page is. */
  var queued = false;
  function measure() {
    queued = false;
    if (nav) nav.classList.toggle("stuck", window.scrollY > 12);
    var max = root.scrollHeight - window.innerHeight;
    var p = max > 0 ? window.scrollY / max : 0;
    root.style.setProperty("--scroll-prog", (p < 0 ? 0 : p > 1 ? 1 : p).toFixed(4));
  }
  function onScroll() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(measure);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  measure();

  /* ── Chapters ────────────────────────────────────────────────────────────
     Same contract as motion.js's: a section declares its ground with
     `data-ground`, and the ground of whichever section is under the middle of
     the viewport becomes the page's chapter. Terms and privacy have exactly
     one such section, so this resolves to a no-op there; the letter's page has
     three, and without this the floating nav would keep the palette of the
     chapter it was authored in while the ground behind it changed.

     A ZERO-HEIGHT ROOT AT THE VIEWPORT'S MIDDLE. Inset the observation area by
     50% top and bottom and what is left is a line, so `isIntersecting` means
     exactly "this section is crossing the midpoint" — which is the same
     boundary motion.js picks, and it gets the way back for free. GSAP needs a
     separate `onLeaveBack` to restore the previous ground; a line does not,
     because scrolling up crosses it again in the other direction. */
  var grounds = document.querySelectorAll("[data-ground]");
  if (grounds.length && "IntersectionObserver" in window) {
    var chapters = new IntersectionObserver(
      function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (!entries[i].isIntersecting) continue;
          root.setAttribute("data-chapter", entries[i].target.getAttribute("data-ground"));
        }
      },
      { rootMargin: "-50% 0px -50% 0px" }
    );
    for (var g = 0; g < grounds.length; g++) chapters.observe(grounds[g]);
  }

  /* ── The reveal ──────────────────────────────────────────────────────────
     Sections rise 9px and fade over half a second, once, and never move again.
     A document is not a landing page: the motion is there to give the eye a
     downbeat as each clause arrives, not to stage anything. */
  function showAll() {
    for (var i = 0; i < secs.length; i++) secs[i].classList.add("in");
  }
  if (!secs.length || reduced.matches || !("IntersectionObserver" in window)) {
    showAll();
    return;
  }

  var io = new IntersectionObserver(
    function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isIntersecting) continue;
        entries[i].target.classList.add("in");
        io.unobserve(entries[i].target);
      }
    },
    /* Negative bottom margin so a section commits once it is properly in the
       page rather than the instant its first pixel appears; generous top margin
       so a deep link (or a find-in-page hit) lands on something already shown. */
    { rootMargin: "200px 0px -8% 0px" }
  );
  for (var i = 0; i < secs.length; i++) io.observe(secs[i]);

  /* The backstop. Anything still hidden after this was not going to be revealed
     by scrolling either — an observer that silently never fires would otherwise
     take the document with it. */
  setTimeout(showAll, 2500);
})();
