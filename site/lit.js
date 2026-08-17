/* `.lit` while on screen — the smallest possible utility, and the reason it is
   a utility at all.

   THE RULE IT ENFORCES IS THE PROJECT'S, NOT THIS FILE'S. An animation that
   runs where nobody can watch it is work spent for nothing (CONVENTIONS.md),
   and `brand.js` already refuses to fidget a mark that is out of view for
   exactly that reason. Two more surfaces now want the same guarantee — the
   heart in every footer, and the hero-sized copy of it on the letter's own page
   — so the choice was one shared observer or the same eight lines pasted twice.

   Any element that carries `data-lit` gets `.lit` while it is on screen and
   loses it when it leaves. Nothing here knows what `.lit` means; the stylesheet
   decides that, which is what lets a third surface opt in later without this
   file changing.

   THE STILL FRAME IS DELIBERATE, NOT A FALLBACK. With JavaScript off nothing is
   ever lit, and the heart is simply a white heart — which is what a heart looks
   like when it is not beating, and a perfectly good mark. Nothing here can
   leave the page in a worse state than not running at all, which is the only
   licence a decorative script has to exist on a page like this.

   Reduced motion is answered in the stylesheet, not here. `.lit` still lands
   and the media query switches the animations off. A `matchMedia` check in this
   file would only re-test the half CSS already owns, and would drift from it. */
(function () {
  var marks = document.querySelectorAll("[data-lit]");
  if (!marks.length) return;

  /* No IntersectionObserver: light everything and stop thinking about it. Being
     generous here costs one small animation on an old browser; being clever
     would cost the animation entirely. */
  if (!("IntersectionObserver" in window)) {
    for (var i = 0; i < marks.length; i++) marks[i].classList.add("lit");
    return;
  }

  var io = new IntersectionObserver(
    function (entries) {
      for (var i = 0; i < entries.length; i++) {
        entries[i].target.classList.toggle("lit", entries[i].isIntersecting);
      }
    },
    /* A little early, so a footer's beat is already running by the time it has
       finished scrolling up — arriving to a heart mid-cycle reads as alive,
       arriving to one that starts on your entrance reads as a trigger. */
    { rootMargin: "120px 0px 0px 0px" }
  );
  for (var j = 0; j < marks.length; j++) io.observe(marks[j]);
})();
