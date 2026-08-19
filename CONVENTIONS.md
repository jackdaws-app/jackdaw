# Conventions

The house style. A patch that violates something here will be asked to change even if it
works, so it is worth skimming before you write code. Most of these rules cost someone a
day to learn; they are written down so they only cost that once.

[CONTRIBUTING.md](CONTRIBUTING.md) covers scope and process — what changes are wanted and
how to propose one. This file is about the code and the craft.

## The bar

The standard for anything a user sees is "immaculate." That is deliberately higher than
"works," and it is the main reason a PR gets sent back. Reference points: Keepa and
brokerage charts for data density, Reddit for threaded discussion conventions,
[designspells.com](https://designspells.com) for craft detail.

Practically, it means: measure instead of eyeballing, verify both themes, and treat motion
as something with rules rather than decoration.

## Code shape

**`extension/` is plain, no-build vanilla JavaScript.** No bundler, no transpiler, no
framework, no dependencies. What you write is what ships. Prefer small readable functions
over clever abstractions. Files are ES modules; syntax-check before you commit:

```bash
cp extension/content.js /tmp/x.mjs && node --check /tmp/x.mjs
```

**All extension UI renders inside a Shadow DOM** (`#jackdaw-root` on `documentElement`).
Host CSS cannot reach us and ours cannot reach the host — that isolation is load-bearing,
because the panel renders inside a page Micro Center controls and can restyle at will.
Don't add styles outside the shadow root.

**`convex/` follows the existing function patterns** — object-form definitions, explicit
validators, indexes rather than filters. Typecheck before you commit:

```bash
npx tsc --noEmit
```

**Counters are incremental, never scans.** A Convex function has a hard read ceiling
(~16k documents), and any query that grows with the size of the database will eventually
cross it and start failing in production for the heaviest users first. Bump a counter row
on write; cap every `take`; if a query samples, say what it sampled in its own return
value so the UI can label it.

**Escape a value at the boundary where it changes syntax.** A string that is correct at
rest can still be wrong the instant it is concatenated into something with its own
grammar. A stored product path ending `...with-900&#181;m-fiber-holder` — an undecoded
HTML numeric character reference, which is what the retailer's own tag manager emits — is
the right value to keep, and becomes a truncated path plus a stray fragment the moment it
is glued onto an origin. `encodeURI` is not the fix: it deliberately leaves `#` and `&`
alone as reserved characters. Escape the one character whose meaning changes, at the
construction site, and leave the stored value alone.

## Visual rules

- **No emoji in product UI.** SVG icons, small-caps letterspaced labels.
- **`tabular-nums` on every price**, and prices carry thousands separators to match what
  the retailer prints (`$15,299.99`, not `$15299.99`). Use `toLocaleString("en-US", {
  minimumFractionDigits: 2, maximumFractionDigits: 2 })`. The two exceptions are a CSS
  percentage and a `type="number"` input, where a comma isn't a valid value.
- **Verify both themes on every visual change**, and measure computed contrast against the
  resolved backdrop rather than trusting that inherited text inherited anything. Two
  regressions shipped past a visual check this way. Three traps when measuring: an element
  painting a `linear-gradient` reports `backgroundColor: rgba(0,0,0,0)`, so walk to the
  gradient's first stop; a hidden collapsed subtree still reports a non-null
  `offsetParent`, so it surfaces as a false low-contrast hit; and a `color-mix(in oklab,
  …)` *computes to* an `oklab()` string that no rgb parser reads — paint it to a 1×1
  canvas and read the pixel back rather than regexing the computed value.
- **A muted token passes on the surface it was tuned for and can fail one layer out.** The
  admin panel's grey measures 4.83 on its white cards and 4.37 on the warm page ground
  behind them — under AA for the small labels that sit there. Same colour, same page, and
  only the handful of elements outside a card were affected. Sweep *every* text node
  against its own resolved backdrop rather than checking a token once; and fix it at the
  usage site, because the token was right everywhere else.
- **Two token blocks that re-scope the same theme must declare the same keys, and that is
  a correctness rule rather than a tidiness one.** A key present in one block and missing
  from the other does not fall back to a neutral — it falls through to whatever an ancestor
  last said, which is the *other* theme. The site's paper block declared 18 tokens against
  night's 26, the eight missing ones sitting at plain `:root` where they read as
  equivalent and are not (`:root` loses to a theme selector on `<html>`). That held for as
  long as the theme was a property of the document, and stopped holding the first time a
  *band* carried its own: a paper leaf inside a night page came out as near-white text on
  near-white paper. It was silent in the usual way — the ground flipped, so the band
  visibly changed and looked like it had worked. Diff the two key sets; don't read them.
- **A token derived from a themed token must be re-declared wherever that theme is.**
  Custom-property substitution resolves at the element where the property is *declared*,
  and descendants inherit an already-resolved value. So `--rule: color-mix(… var(--ink) …)`
  set once at `:root` folds in the root's ink and then travels down as that literal colour
  — a band re-scoping `--ink` underneath gets its own ink for text and the root's ink for
  every hairline drawn from the derived token. Put those on the theme selector itself
  (ours is one unqualified `[data-chapter]` block, so adding a theme needs no maintenance),
  and leave tokens derived from *fixed* brand colours where they are: moving one down
  implies it varies, which is the opposite of what it is for.
- **Anything drawn to canvas needs palette entries in `chart.js` PALETTES** for both
  themes. Canvas doesn't inherit CSS custom properties.
- **Derive reserved space from measurement.** The chart's price gutter was a hard-coded 52
  px, which silently clipped the cents off every four-figure price for the life of the
  file. Reserve what `measureText` says you need, and draw from the same array you
  measured.

## Motion rules

- **Transform and opacity only.** Nothing that triggers layout.
- **UI transitions ≤300ms.** Strong curves — `--ease-out: cubic-bezier(.23,1,.32,1)`,
  `--ease-drawer`.
- **Every animation needs a `prefers-reduced-motion` fallback.** If a fallback replaces an
  animation whose `animationend` drives logic, keep a *named* 0.01s animation so the event
  still fires.
- **Hover effects gate behind `(hover:hover) and (pointer:fine)`.**
- **Delight is rare by budget.** Routine interactions stay quick and quiet; the elaborate
  moments (an all-time low, a first visit) are elaborate precisely because they are rare.
- **Hero moments are layered construction, never uniform scale.** Scaling one finished
  element up reads as "zoom" or "spawn." Build it: the surface opens, then the glyph draws
  on, then the letters cascade. Hero animations here run roughly 2× slower than typical UI
  defaults, and where they show data, the data is real.
- **Transformation, not decoration.** The project's animation language is one thing
  becoming another: every stage has its own motion, mass hands off between stages, and
  neighbours react causally. A shimmer applied over text was rejected for this reason —
  it decorates without transforming. This applies to the marketing site too.

## Animation gotchas

Each of these cost real debugging time. They look like bugs in your code and are not.

- **A running CSS animation overrides the cascade.** An entrance animation on a base rule
  will defeat an `opacity: 0` hiding class and flash a ghost element.
- **A finished animation never restarts under the same name.** Retriggering needs a
  distinct `@keyframes` name, or a class cycle plus a forced reflow (`void el.offsetWidth`).
- **Don't run reveal animations on a hidden element** — they burn invisibly. Set state
  silently before the reveal, then let the reveal choreography animate it.
- **SVG `d:` keyframes only interpolate between identically-structured paths** — same
  command sequence, same point count. QA multi-pose sequences by rendering a frozen
  pose-sheet in the browser (negative `animation-delay` plus `animation-play-state:
  paused`) before shipping.
- **`offset-path` coordinates are relative to the containing block's top-left**, not the
  element's own `top`/`left`, which it overrides. Author paths in the parent's coordinate
  space and verify frozen frames in-browser.
- **`requestAnimationFrame` never fires in a backgrounded tab.** Anything rAF-gated reads
  as never applied, and CSS transitions are suspended too — you will measure a frozen
  intermediate value and conclude the code is broken. Front the tab before measuring.
  The same trap has a second form: a surface that is not laid out at all reports
  `clientWidth: 0`, and every width, height and overflow read off it is fiction — rows
  measured 280px tall and the page "overflowed by 320px", both of which vanished at a real
  viewport. Check `document.documentElement.clientWidth` before believing a layout number.
  Computed *colours* survive this, so contrast readings taken there are still good.
  Two corollaries. **A transition in flight outranks `!important`** (transitions sit above
  author declarations in the cascade), so a suspended one defeats any override you inject
  to measure past it — three "failures" in a print check were a 0.9s background transition
  and a 0.52s opacity transition, frozen. Inject
  `*,*::before,*::after{transition:none !important;animation:none !important}` before
  measuring anything behind a media-query flip. And **resource events still fire when rAF
  does not**: a stylesheet's `onload` resolves in a hidden pane, so you can await CSS
  without awaiting a frame. Awaiting a frame there hangs until your tool times out.
- **A CSS syntax error does not throw — it eats the next rule.** A stray `}` at the top
  level is not skipped: the parser consumes it as the start of a selector, swallows the
  whole rule that follows, and carries on silently. Two of them sat in `popup.css` for two
  days, deleting `.pop-wordmark` and `.pop-icon` — the header wordmark lost its weight,
  tracking and colour, and two buttons wore the browser's default grey border — and
  nothing anywhere reported it. Nothing in a browser will tell you; CI's esbuild parse is
  the only thing that does, which is why stylesheets are gated there.
- **Measure alignment between separately-positioned SVGs; don't nudge.** Contact points
  need viewBox-scale arithmetic against the actual geometry underneath, which may not be
  flat.
- **Draw artwork from references, never from memory.** Extract the dominant shapes first
  — for a bird in flight the wings are 3–4× the body's area, and getting that ratio wrong
  produces something confidently wrong rather than roughly right.
- **When the reference is already on the page, trace it rather than imitate it.** Two
  hand-built cursive signatures were rejected as rigid before the shipped one was produced
  by tracing the letter's own typeface — skeletonised to the pen's centreline, routed in
  the order a hand writes it, refit as cubics. It cannot disagree with the prose above it
  because it *is* that prose at signature size. Imitating a hand carries your construction
  habits into it; tracing one carries the hand's.
- **Calibrate stroke weight against the ink beside it, and audition it as pixels.** A
  weight that looks fine alone reads thin next to text whose own stems you never measured.
  Render candidate widths as a row-sheet and choose from that, not from a number.
- **Take pen order and per-stroke timing from the letterforms, not from a schedule you
  like.** One stroke per pen-down, duration proportional to that stroke's arc length so
  the pen holds one speed, a short gap across each lift. That is what makes a frozen
  mid-write frame read as handwriting rather than as paths revealing in a pleasing order.

## Measuring in a driven browser

A probe written to check what a page is doing is itself a program, written quickly,
against a moving target. In one verification pass four of five apparent defects were in
the probe; in the next, three of three. **When a measurement surprises you, suspect the
measurement first, and go read the code it claims to describe.**

- **Sweep, don't guess an element per assertion.** A contrast check that asked for
  `.doc p` matched a date line first and reported its ratio as the body prose's, so the
  prose was never measured and the probe passed. Enumerate every element that owns a
  visible text node and measure all of them; a probe that names its targets can only
  verify the ones you already thought of.
- **Navigating re-serves cached CSS.** A `?v=N` on the document busts the HTML only —
  linked stylesheets with no query string come straight from cache, so you measure the
  file you just edited *and* the one you replaced, depending on which you ask for. Bust
  the sheet in the same call as the measurement; a later navigate silently restores it.
- **Reading `parentRule.conditionText` while media conditions are flipped returns the
  flipped text**, so a probe that flips conditions and then reports which rules it flipped
  is quoting itself.
- **A `Range` over an `inline-flex` element yields one client rect per flex item**, not
  per line, so `getClientRects().length` is not a line count there — which matters for
  every wrap check on a chip row or a split wordmark.
- **Test no-JS with `sandbox="allow-same-origin"` and no `allow-scripts`.** That genuinely
  blocks scripts while leaving the DOM readable from the parent, so a no-JS render can be
  measured rather than reasoned about. Any claim of the form "with scripts off, nothing
  hides this" is checkable in one call.

- **An animation gated on first reveal can't be re-measured by scrolling away and back.**
  Scrolling out of view doesn't reset the state that arms it, so the probe reports nothing
  moving — which is indistinguishable from broken. Reproduce the real sequence instead:
  a fresh page, hooked at the top, then scrolled down.
- **Don't infer ordering from event timestamps.** Elements parked at their start pose
  before a staggered delay elapses all report the same first-drawn time, so any "order"
  you read out is the sort's, not the animation's. Instrument the launch, or don't claim it.
- **Collapse sampled positions in 2-D.** Two things passing each other share one axis and
  never both; a 1-D key silently merges them and loses both tracks.
- **Reading canvas state inside a draw hook reads the *previous* value** where the state is
  set after the shape is described, and a shape drawn inside a translated context reports
  its untranslated coordinates. Both invent defects that aren't there.
- **A behaviour on a long cooldown is unreachable in any realistic observation window, and
  its absence proves nothing.** Trigger it directly, through its real entry point where
  one exists.
- **Check for clipping ancestors separately from measuring extents.**
  `getBoundingClientRect` reports the same box whether or not an ancestor cuts it, so an
  `overflow` change that decapitates an animation is invisible to a rect-based probe. Note
  `overflow: clip visible` is a legal pair that really does clip one axis and not the other.
- **A JS `matchMedia` patch cannot test the CSS half of `prefers-reduced-motion`.** Media
  queries are evaluated against the real browser setting. A faithful run needs the patch
  *and* every `@media (prefers-reduced-motion: reduce)` block in the stylesheet lifted out
  and applied unconditionally — check how many there are, and recount rather than trust
  the last number written down; ours read "three" for months and is four in the main
  stylesheet, eight across the site (47 rules, counted 2026-08-18). Taking only the first
  left eight infinite animations running.
- **When you cannot photograph a moment, re-render the measured values as a static
  pose-sheet.** Freeze the animation numerically, read the computed values at each instant
  you care about, then write those exact numbers back as inline styles on copies of the
  real markup — one row per instant, in a page that loads the shipped stylesheet and
  animates nothing. One screenshot of that is pixel proof of a whole sequence, and because
  every number came off the live engine it cannot be a flattering reconstruction.
- **Freezing with `getAnimations()` has two traps in one line.** Setting an absolute
  `currentTime` throws on a progress-based (scroll-driven) animation — and the loop has
  already paused everything it reached before it throws, so an unrelated reveal is left
  parked mid-fade and the page looks broken. Filter to exactly what you are freezing, and
  resume strays with `play()`.
- **Virtual time does not advance scroll.** A headless virtual-time budget lands an
  `IntersectionObserver`-driven reveal at an unpredictable instant, so three budgets give
  three readings that each look like a different bug. Capture end state under forced
  reduced motion, which is deterministic and is a guarded path you want checked anyway.
- **A collapsed pane reports every width as zero, and nothing warns you.** A hidden
  preview surface can report an `innerWidth`/`innerHeight` of 0, at which point every
  `getBoundingClientRect().width` on the page is 0 as well — including elements that are
  plainly fine. Read the viewport before believing any width. If it is 0, no width
  measurement on that page means anything, and a zero-sized element is not evidence of a
  layout bug.
- **A backgrounded tab suspends the rendering pipeline, so `IntersectionObserver` never
  delivers — not even its initial callback.** An IO-driven reveal then sits unrevealed
  indefinitely and is indistinguishable from a broken one. That is worst for anything
  deliberately exempt from a timed backstop, because there is no backstop left to cover
  for it. The tell is cheap: arm a *fresh* observer on an element you can see is in view;
  if it reports nothing at all, the pipeline is parked, not the page. Forcing a composite
  — a screenshot will do — delivers the queued records at once. Same family as the rAF
  rule above, one layer down: it is not only animation that stops.

## Data collection is not negotiable

These rules are the project's whole posture, not preferences.
[DATA-POLICY.md](DATA-POLICY.md) is the public statement of them; this is what it means
when you're writing code.

- **Zero additional requests.** Never open a page, follow a link, prefetch the next page of
  results, change the results-per-page setting, or issue any fetch to the retailer.
  Reading more of a page the user opened is fine; opening one more page is not. There is
  no code path in the collector that can make a request, and adding one is a rejection.
- **Never trigger `/quickViewConfigurator`** — the Quick View button on grid cards, and
  the one path `robots.txt` genuinely disallows.
- **No product images** stored, copied, hotlinked, or re-served, anywhere.
- **A source must never be able to assert a field it did not observe.** The failure this
  prevents: a reading that silently omits the open-box price would be stored as an open-box
  *disappearance*, and the next visit that did see one would read as an *arrival* and fire
  every watcher's alert over a unit that never moved. So absence has to be distinguishable
  from ignorance, structurally, in the payload — either by leaving the field out of the
  shape entirely (the batch has no `availability` key, because nothing on a grid card shows
  it) or by pairing it with a flag that says the reader could see it (`openBoxSeen`, which
  is what lets an empty open-box line count as a real "none here"). What is never
  acceptable is one shape where "absent" means both. Any new partial-observation source
  inherits this.
  - **The flag has to be anchored on something that is always there.** An empty open-box
    line proves the reader looked, so that field can vouch for itself; a "was $799.99"
    block is simply *absent* when there is no discount, so it cannot. Anchor the flag on
    the nearest element that renders unconditionally (for grid cards, the price block),
    and set it from *that* element's presence, never from the field's own.
  - **Every carried field joins the "is this the same reading?" test.** A field that is
    carried forward but left out of the comparison changes silently: the write takes the
    unchanged branch, which by definition does not store it, and the new figure is lost.
  - **A reader that stops matching must be able to say so.** A selector that finds nothing
    throws no error and writes no wrong value — it just goes quiet, and four fields have
    failed that way, one of them for the entire life of the file. So the readers count what
    they looked at, what they found, and what they found but could not parse, and those
    counts ride along with the sighting. Fixtures cannot cover this: a fixture is markup
    you wrote to match the selector you just wrote. Only the live site is authority, and
    only a counter notices when it changes.
- **A rule that only exists in the client is one caller away from being violated.** If a
  value must never be stored, the refusal belongs at the write boundary, not in the code
  that happens to read it back. A shelf row for a store with no shelves was unreachable for
  exactly as long as the one caller kept not asking for it.
- **The URL is never sent.** Products are identified by ID. Search and category pages send
  no URL, which is what keeps search terms and filters out of the database.
- **Validate and clamp what arrives, then count what you dropped.** Readings outside a
  plausible band get skipped, and the skip count is returned to the caller rather than
  silently swallowed.

## Say only what the data supports

The product's credibility rests on its numbers being honest about their own limits, and
this is enforced in the UI copy, not just in comments.

- **"Last seen," never a bare "In stock."** Every price and stock figure carries its age
  and visibly ages out past the staleness threshold. A reading is a timestamped sighting,
  not live truth; the freshness is the honesty.
- **Don't render a figure you can't label.** Two quantities that mean different things
  don't get summed just because they're both integers — if there's no honest label for the
  combined number, it isn't displayed.
- **The UI must not promise what the feature can't do.** With a trigger switched off, the
  card says so and the progress meter is removed rather than left drawing a countdown for
  something that cannot fire.
- **Flag truncation and sampling in the return value**, and surface it in the label.

## Copy has registers

Legal documents (PRIVACY, TERMS) use standard legal structure and tone — numbered
sections, defined terms, no brand voice. UI copy is conversational but stripped of needless
words. Repo docs sit between. Match the register before writing; the project's voice must
never leak into legal text.

## Before you open a PR

- `node --check` each extension file you touched (they're ES modules — copy to `.mjs`).
- `npx tsc --noEmit` if you touched `convex/`.
- Load the unpacked extension and drive the change on a real page. Click through it.
- If it's visual: check both themes and measure contrast. If it moves: check
  `prefers-reduced-motion`.
- Say in the PR what you actually verified and how. "Tested" is not information; "drove it
  on a category page at 96 results per page, both themes, contrast 4.9 light / 5.3 dark"
  is.

CI runs the mechanical half automatically on every pull request — the backend type-check,
a syntax check of every extension script, and an esbuild parse of every stylesheet. It
cannot see any of the rules above it: nothing machine-checks a contrast ratio, a
reduced-motion fallback, or whether an animation reads as handwriting. A green check means
the files parse, not that the change is right.
