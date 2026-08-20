# Licence exceptions

Jackdaw is licensed under the GNU Affero General Public License, version 3; the full
text is in [LICENSE](LICENSE). This file records the one place that grant does not
reach, so that anyone forking this repository knows exactly what they did and did not
receive under the AGPL.

"The Project Owner" has the meaning given in [CLA.md](CLA.md).

## 1. Scope of the AGPL-3.0 grant

The AGPL-3.0 licence in `LICENSE` applies to the Jackdaw project's own source: everything
in this repository other than the files identified in section 2.

The files in section 2 are third-party works, redistributed here unmodified and under
their own licences. The Project Owner does not hold copyright in them, and does not
license, sublicense, relicense or purport to relicense them under the AGPL-3.0 or under
any other terms.

## 2. Excepted files

Everything in `site/vendor/`:

| Path | Work | Licence |
| --- | --- | --- |
| `site/vendor/gsap.min.js` | GSAP 3.13.0 | GreenSock Standard "No Charge" License, <https://gsap.com/standard-license> |
| `site/vendor/ScrollTrigger.min.js` | GSAP ScrollTrigger 3.13.0 | GreenSock Standard "No Charge" License, <https://gsap.com/standard-license> |
| `site/vendor/lenis.min.js` | Lenis 1.3.11 | MIT, `site/vendor/lenis-LICENSE.txt` |
| `site/vendor/fonts/instrument-serif-*.woff2` | Instrument Serif | SIL Open Font License 1.1, `site/vendor/fonts/OFL.txt` |
| `site/vendor/fonts/la-belle-aurore-latin.woff2` | La Belle Aurore | SIL Open Font License 1.1, `site/vendor/fonts/OFL.txt` |

[`site/vendor/NOTICE.md`](site/vendor/NOTICE.md) carries the same table together with the
reasoning behind each file, and is the copy to update when a version changes. The licence
banner inside each minified file is authoritative over both.

## 3. Additional permission under AGPL-3.0 section 7

To the extent that any file identified in section 2 would otherwise be treated as part of
a covered work conveyed under the AGPL-3.0, the Project Owner grants the following
additional permission under section 7 of that licence:

> You have permission to use, propagate and convey the third-party files identified in
> section 2 of `LICENSE-EXCEPTIONS.md` under the terms of their own respective licences,
> in combination with the Jackdaw project, without those files thereby becoming subject
> to the requirements of the GNU Affero General Public License.

This is an additional *permission*, not an additional restriction: it removes a
requirement rather than imposing one, and section 7 lets you strip it from any copy you
convey.

## 4. What this does not do

It does not alter the third-party licences, and it cannot.

GSAP is the one to read before you rely on it. It is **not** an OSI-approved open-source
licence; the banner inside the file says "All rights reserved". GreenSock's Standard
"No Charge" terms permit redistribution inside a work distributed at no charge, which is
what Jackdaw is. They forbid selling GSAP itself, or shipping it inside a product whose
paid value is the GSAP functionality. **If you fork Jackdaw and intend to charge for the
result, read <https://gsap.com/standard-license> first.** The AGPL's permissions do not
extend to that file and never could, because they were never the Project Owner's to give.

GSAP and Lenis are used by the marketing site only; `site/index.html` is the sole page
that loads them. The Chrome extension in `extension/` has no third-party dependencies
and is covered by the AGPL-3.0 in full; nothing in `site/vendor/` ships inside it. That
is deliberate: the extension is the code that runs inside a page you did not write, so
it is where the "read the source yourself" claim has to hold.
