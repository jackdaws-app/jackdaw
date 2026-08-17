# Third-party code in `site/vendor/`

These files are **not** Jackdaw's work and are **not** covered by Jackdaw's AGPL-3.0
licence. They are vendored — committed to this repository and served from
jackdaws.app — rather than loaded from a CDN, and that is a privacy decision, not a
build-tooling one: a `<script src="cdn…">` makes every visitor's browser announce its
IP address to a third party before the page has drawn anything. Jackdaw's whole
posture is that it collects the minimum and hands nothing to anyone; a CDN tag would
quietly break that on the marketing site while `PRIVACY.md` claimed otherwise.

They are used on the **marketing site only**. The extension stays dependency-free —
that is where the "read the source yourself" claim actually has to hold, because that
is the code that runs inside a page you did not write.

| File | Version | Licence |
| --- | --- | --- |
| `gsap.min.js` | GSAP 3.13.0 | GreenSock Standard "No Charge" Licence |
| `ScrollTrigger.min.js` | GSAP ScrollTrigger 3.13.0 | GreenSock Standard "No Charge" Licence |
| `lenis.min.js` | Lenis 1.3.11 | MIT — see `lenis-LICENSE.txt` |
| `fonts/instrument-serif-*.woff2` | Instrument Serif v5 | SIL OFL 1.1 — see `fonts/OFL.txt` |

## GSAP

© GreenSock. Subject to the terms at <https://gsap.com/standard-license>. The full
text is not reproduced here because GreenSock host it themselves and revise it; the
banner inside each minified file is the authoritative pointer and has been left
intact.

The Standard licence permits use and redistribution inside a website or application
distributed at no charge, which is what Jackdaw is and will remain. What it forbids
is selling GSAP itself, or shipping it inside a product whose paid value *is* the GSAP
functionality — neither of which is in scope here or anywhere on the roadmap.

**It is not an OSI-approved licence, and that is a loose end worth naming rather than
burying.** Jackdaw's own source is AGPL-3.0, and the AGPL's terms are about the work
you distribute *as a whole*. Vendoring a non-copyleft-compatible file into an AGPL
repository is extremely common practice and nothing about it is unusual, but the tidy
fix is the one the AGPL itself provides: an additional-permission note under section
7 stating that Jackdaw's licence does not extend to the files in this directory and
does not attempt to relicense them. See the task tracker — this is filed, not
forgotten, and it wants doing before the repository goes public rather than after.

## Lenis

© 2024 darkroom.engineering. MIT. Full text in `lenis-LICENSE.txt`.

## Instrument Serif

© 2022 The Instrument Serif Project Authors. SIL Open Font License 1.1, full text in
`fonts/OFL.txt`.

The four `.woff2` subsets are byte-identical to the ones Google Fonts serves — they
were fetched from `fonts.gstatic.com` and are here for the same reason GSAP is. The
`<link href="fonts.googleapis.com">` this replaces was, on a site whose entire pitch
is that it does not report you to anyone, a request to Google on every page load
before a single word rendered. Self-hosting also removes the render-blocking
round-trip to a second origin, so it is faster as well as quieter — but the reason is
the first one.

Roman and italic, `latin` and `latin-ext`, 47 KB total. The `unicode-range` values in
`styles.css` were copied verbatim from Google's own stylesheet, so a page that only
ever sets Latin text never downloads the `latin-ext` pair.

## Updating

Replace the file, update the version in the table above, and re-check the licence
banner inside the new file — GreenSock's terms have changed materially before (the
plugins became free in 2025) and the version that matters is the one on disk.
