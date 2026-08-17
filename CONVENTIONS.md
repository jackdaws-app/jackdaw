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

## Visual rules

- **No emoji in product UI.** SVG icons, small-caps letterspaced labels.
- **`tabular-nums` on every price**, and prices carry thousands separators to match what
  the retailer prints (`$15,299.99`, not `$15299.99`). Use `toLocaleString("en-US", {
  minimumFractionDigits: 2, maximumFractionDigits: 2 })`. The two exceptions are a CSS
  percentage and a `type="number"` input, where a comma isn't a valid value.
- **Verify both themes on every visual change**, and measure computed contrast against the
  resolved backdrop rather than trusting that inherited text inherited anything. Two
  regressions shipped past a visual check this way. Two traps when measuring: an element
  painting a `linear-gradient` reports `backgroundColor: rgba(0,0,0,0)`, so walk to the
  gradient's first stop; and a hidden collapsed subtree still reports a non-null
  `offsetParent`, so it surfaces as a false low-contrast hit.
- **A muted token passes on the surface it was tuned for and can fail one layer out.** The
  admin panel's grey measures 4.83 on its white cards and 4.37 on the warm page ground
  behind them — under AA for the small labels that sit there. Same colour, same page, and
  only the handful of elements outside a card were affected. Sweep *every* text node
  against its own resolved backdrop rather than checking a token once; and fix it at the
  usage site, because the token was right everywhere else.
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
- **Measure alignment between separately-positioned SVGs; don't nudge.** Contact points
  need viewBox-scale arithmetic against the actual geometry underneath, which may not be
  flat.
- **Draw artwork from references, never from memory.** Extract the dominant shapes first
  — for a bird in flight the wings are 3–4× the body's area, and getting that ratio wrong
  produces something confidently wrong rather than roughly right.

## Measuring an animation

A probe written to check an animation is itself a program, written quickly, against a
moving target. In our last verification pass four of the five apparent defects were in the
probe. **When a measurement surprises you, suspect the measurement first, and go read the
code it claims to describe.**

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
  and applied unconditionally — check how many there are; ours is three, and taking only
  the first left eight infinite animations running.

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

A CI workflow will eventually run the mechanical half of this automatically. Until then it
is on you, and a PR that hasn't had it done is a PR that isn't ready.
