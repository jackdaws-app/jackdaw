# Jackdaw

Community price tracking for Micro Center — like the jackdaw, we collect shiny things and never forget a price. Chrome extension + Convex backend, free and open source.

**How data is gathered (no scraping):** when an extension user visits a Micro Center product page, the extension reads the product facts Micro Center already renders for that visitor (`window.dataLayer`: product ID, SKU, price, selected store, stock status) and reports one observation to the shared database. The database grows purely from pages members were already viewing. No crawling, no product images stored or hotlinked. See [LEGAL-NOTES.md](LEGAL-NOTES.md) for the legal posture behind these rules.

## Layout

- `extension/` — Manifest V3 Chrome extension, no build step.
  - `page-world.js` reads the page's `dataLayer` (MAIN world) and relays it via a CustomEvent.
  - `content.js` renders the panel: price stats, canvas step-chart of price history, discussion with up/down votes.
  - `background.js` owns the anonymous device ID and all Convex HTTP calls.
  - `config.js` — set `CONVEX_URL` here.
- `convex/` — backend: `observations.report`, `products.history`, `comments.list/add/vote`.

## Run it

```bash
npm install
npx convex dev        # starts/pushes the backend (local anonymous deployment by default)
```

1. Set `extension/config.js` → `CONVEX_URL` to your deployment URL (local default `http://127.0.0.1:3210`; cloud: `https://<name>.convex.cloud`).
2. Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** → select the `extension/` folder.
3. Visit any Micro Center product page. The Jackdaw panel appears bottom-right.
