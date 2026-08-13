# Jackdaw

Community price tracking for Micro Center — like the jackdaw, we collect shiny things and never forget a price. Chrome extension + Convex backend, free and open source.

**How data is gathered (no scraping):** when an extension user visits a Micro Center product page, the extension reads the product facts Micro Center already renders for that visitor (`window.dataLayer`: product ID, SKU, price, selected store, stock status) and reports one observation to the shared database. The database grows purely from pages members were already viewing. No crawling, no product images stored or hotlinked. See [LEGAL-NOTES.md](LEGAL-NOTES.md) for the legal posture behind these rules.

## Layout

- `extension/` — Manifest V3 Chrome extension, no build step, all UI in a Shadow DOM (immune to host-page CSS).
  - `page-world.js` reads the page's `dataLayer` + open-box price (MAIN world), relays via CustomEvent with an ack handshake.
  - `content.js` — the "Price history" tab on the product image and the bottom drawer: stats, verdict chips, threaded reddit-style discussion (collapse, votes, replies, reports), price-target alerts, dark mode, expand mode, share-as-image.
  - `chart.js` — dependency-free canvas chart: range + store filters, open-box series, typical/low lines, crosshair tooltip, drag-resize.
  - `background.js` — anonymous device ID, all Convex HTTP calls, hourly price-drop alert notifications.
  - `config.js` — `CONVEX_URL`: dev (seeded demo data) vs prod, one-line swap.
- `convex/` — backend: observations (dedupe + throttle), products.history, threaded comments with votes/reports/auto-hide, watches (price targets), rate limiting, content filters, internal moderation tools, `seed:demo` for dev.
- `PRIVACY.md` / `TERMS.md` — Web Store policy drafts. `CLA.md` + cla-assistant workflow — contributions require signing.

## Run it

```bash
npm install
npx convex dev        # starts/pushes the backend (local anonymous deployment by default)
```

1. Set `extension/config.js` → `CONVEX_URL` to your deployment URL (local default `http://127.0.0.1:3210`; cloud: `https://<name>.convex.cloud`).
2. Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** → select the `extension/` folder.
3. Visit any Micro Center product page. The Jackdaw panel appears bottom-right.
