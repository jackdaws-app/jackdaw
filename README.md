# Jackdaw

Community price tracking for Micro Center. Chrome extension + Convex backend, free and open source.

**How data is gathered (no scraping):** when a user visits a Micro Center product page, the extension reads the product facts already rendered for that visitor (`window.dataLayer`: product ID, SKU, price, selected store, stock status) and reports one observation to the shared database. On a search or category page it does the same for the cards already on screen and sends them as one batch — a page of results the user opened anyway refreshes up to 96 records at once. The database grows only from pages users were already viewing: the extension opens nothing, follows no links, prefetches no next page, and never changes the results-per-page setting on the user's behalf. No crawling; no product images stored or hotlinked. Contributing is a single opt-in switch in the toolbar popup — off until the user turns it on — and every other feature works either way. See [DATA-POLICY.md](DATA-POLICY.md) for the full posture and the reasoning.

## Layout

- `extension/` — Manifest V3 Chrome extension, no build step, all UI in a Shadow DOM (immune to host-page CSS).
  - `page-world.js` reads the page's `dataLayer` + open-box price (MAIN world), relays via CustomEvent with an ack handshake.
  - `catalog-world.js` / `catalog.js` — the same pair for search and category pages: harvests the rendered grid once, dedupes, and submits one bounded batch.
  - `content.js` — the "Price history" tab on the product image and the bottom drawer: stats, verdict chips, threaded reddit-style discussion (collapse, votes, replies, reports), price-target alerts, dark mode, expand mode, share-as-image.
  - `chart.js` — dependency-free canvas chart: range + store filters, open-box series, typical/low lines, crosshair tooltip, drag-resize.
  - `background.js` — anonymous device ID, all Convex HTTP calls, hourly price-drop alert notifications.
  - `config.js` — `CONVEX_URL`: dev (seeded demo data) vs prod, one-line swap.
- `convex/` — backend: observations (dedupe + throttle), products.history, threaded comments with votes/reports/auto-hide, watches (price targets), rate limiting, content filters, internal moderation tools, `seed:demo` for dev.
- `DATA-POLICY.md` — where every reading comes from, the zero-additional-requests rule, and what is deliberately never sent.
- `CONVENTIONS.md` — the house style: code shape, visual and motion rules, and the gotchas worth not rediscovering. `CONTRIBUTING.md` covers scope and process.
- `PRIVACY.md` / `TERMS.md` — Web Store policy drafts. `CLA.md` + cla-assistant workflow — contributions require signing.
- `LICENSE` — AGPL-3.0. [`LICENSE-EXCEPTIONS.md`](LICENSE-EXCEPTIONS.md) records what that grant does *not* cover: the third-party files in `site/vendor/`.

## Run it

```bash
npm install
npx convex dev        # starts/pushes the backend (local anonymous deployment by default)
```

1. Set `extension/config.js` → `CONVEX_URL` to your deployment URL (local default `http://127.0.0.1:3210`; cloud: `https://<name>.convex.cloud`).
2. Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** → select the `extension/` folder.
3. Visit any Micro Center product page. The Jackdaw panel appears bottom-right. Search and category pages have no visible UI — the collector runs silently and can be switched off in the toolbar popup.

## Supporting it

Jackdaw is free, and every part of it stays free — there is no paid tier, no supporter
build, and no perk that a donation unlocks. Donations cover hosting, the domain and the
Chrome Web Store fee, nothing more. If that is worth a coffee to you, there is a Sponsor
button at the top of this repository; if it isn't, use the extension anyway, and consider
the price history you contribute by browsing to be the whole of what's owed.

Donations are ordinary income to the maintainer and are **not** tax-deductible.

## Licence

Jackdaw's own source is licensed under **AGPL-3.0** — see [LICENSE](LICENSE). Anyone who
distributes Jackdaw, or runs a modified version as a network service, has to share their
changes under the same terms.

That grant covers Jackdaw's code and stops at `site/vendor/`, which holds third-party
files redistributed unmodified under their own licences — GSAP (a proprietary GreenSock
licence, not OSI-approved), Lenis (MIT) and two SIL OFL fonts.
[LICENSE-EXCEPTIONS.md](LICENSE-EXCEPTIONS.md) states the scope, lists the files and
carries the AGPL section 7 permission; [`site/vendor/NOTICE.md`](site/vendor/NOTICE.md)
explains why each one is vendored rather than loaded from a CDN. **If you fork this and
intend to charge for the result, read the GSAP terms first** — they are the one licence
here that restricts that, and the AGPL cannot override them.
