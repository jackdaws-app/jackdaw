# Jackdaw

Community price tracking for Micro Center. Chrome extension + Convex backend, free and open source.

**How data is gathered (no scraping):** when a user visits a Micro Center product page, the extension reads the product facts already rendered for that visitor (`window.dataLayer`: product ID, SKU, price, selected store, stock status) and reports one observation to the shared database. On a search or category page it does the same for the cards already on screen and sends them as one batch — a page of results the user opened anyway refreshes up to 96 records at once. The database grows only from pages users were already viewing: the extension opens nothing, follows no links, prefetches no next page, and never changes the results-per-page setting on the user's behalf. No crawling; no product images stored or hotlinked. Contributing is a single switch in the toolbar popup, and turning it off leaves every other feature working. See [DATA-POLICY.md](DATA-POLICY.md) for the full posture and the reasoning.

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
- `PRIVACY.md` / `TERMS.md` — Web Store policy drafts. `CLA.md` + cla-assistant workflow — contributions require signing.

## Run it

```bash
npm install
npx convex dev        # starts/pushes the backend (local anonymous deployment by default)
```

1. Set `extension/config.js` → `CONVEX_URL` to your deployment URL (local default `http://127.0.0.1:3210`; cloud: `https://<name>.convex.cloud`).
2. Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** → select the `extension/` folder.
3. Visit any Micro Center product page. The Jackdaw panel appears bottom-right. Search and category pages have no visible UI — the collector runs silently and can be switched off in the toolbar popup.
