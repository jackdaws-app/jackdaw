# Jackdaw

Community price tracking for Micro Center. Chrome extension + Convex backend, free and open source.

**How data is gathered (no scraping):** when a user visits a Micro Center product page, the extension reads the product facts already rendered for that visitor (product ID, SKU, price, selected store, stock status) and reports one observation to the shared database. On a search or category page it does the same for the cards already on screen and sends them as one bounded batch. The database grows only from pages users were already viewing: the extension opens nothing, follows no links, prefetches no next page, and never changes the results-per-page setting on the user's behalf. No crawling, and no product images stored or hotlinked. Contributing is a single opt-in switch in the toolbar popup, off until the user turns it on, and every other feature works either way. See [DATA-POLICY.md](DATA-POLICY.md) for the full posture and the reasoning.

## Layout

- `extension/`: Manifest V3 Chrome extension. No build step, and all UI renders in a Shadow DOM, so host-page styles cannot reach it.
  - `page-world.js` reads the page's own `dataLayer` and open-box price in the MAIN world and relays them with an ack handshake.
  - `catalog-world.js` / `catalog.js`: the same pair for search and category pages. They read the rendered grid once, dedupe, and submit one bounded batch.
  - `content.js`: the "Price history" tab on the product image and the bottom drawer: stats, a verdict on today's price, threaded discussion, alerts (price target, open box, back in stock), dark mode, expand mode, share-as-image.
  - `chart.js`: dependency-free canvas chart with range and store filters, an open-box series, typical and low lines, a crosshair tooltip, and drag-resize.
  - `background.js`: anonymous device ID, all backend calls, hourly alert notifications.
  - `config.js`: `CONVEX_URL`, the one line to point at your own deployment.
- `convex/`: the backend. Observations with dedupe and throttling, price history, threaded comments with votes and moderation, watches and alert triggers, optional email-code accounts with claimed comment handles, rate limiting, and content filters.
- `site/`: the marketing site (jackdaws.app), the policy pages, and `admin.html`, the maintainer's metrics and moderation panel. `site/vendor/` holds third-party files; see the licence note below.
- `DATA-POLICY.md`: where every reading comes from, the zero-additional-requests rule, and what is deliberately never sent.
- `CONVENTIONS.md`: the house style. [CONTRIBUTING.md](CONTRIBUTING.md) covers scope and process.
- `PRIVACY.md` / `TERMS.md`: drafts of the extension's policy documents. `CLA.md`: contributions require signing it.
- `LICENSE`: AGPL-3.0. [LICENSE-EXCEPTIONS.md](LICENSE-EXCEPTIONS.md) records what that grant does not cover: the third-party files in `site/vendor/`.

## Run it

```bash
npm install
npx convex dev        # starts and pushes the backend (local anonymous deployment by default)
```

1. Set `CONVEX_URL` in `extension/config.js` to your deployment URL (local default `http://127.0.0.1:3210`; cloud `https://<name>.convex.cloud`).
2. In Chrome, open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select the `extension/` folder.
3. Visit any Micro Center product page. The Jackdaw panel appears bottom-right. Search and category pages have no visible UI; the collector runs silently and can be switched off in the toolbar popup.

## Supporting it

Jackdaw is free, and every part of it stays free. There is no paid tier, no supporter build, and no perk a donation unlocks. Donations cover hosting, the domain, and the Chrome Web Store fee, nothing more. If that is worth a coffee to you, there is a Sponsor button at the top of this repository. If not, use the extension anyway, and consider the price history you contribute by browsing to be the whole of what's owed.

Donations are ordinary income to the maintainer and are not tax-deductible.

## Security

Found a vulnerability? Please report it privately, through the *Security* tab above or `security@jackdaws.app`. [SECURITY.md](SECURITY.md) covers scope, what to expect, and one project-specific request: test against your own deployment, never production.

## Licence

Jackdaw's own source is licensed under AGPL-3.0; see [LICENSE](LICENSE). Anyone who distributes Jackdaw, or runs a modified version as a network service, has to share their changes under the same terms.

That grant covers Jackdaw's code and stops at `site/vendor/`, which holds third-party files redistributed unmodified under their own licences: GSAP (a proprietary GreenSock licence), Lenis (MIT), and two SIL OFL fonts. [LICENSE-EXCEPTIONS.md](LICENSE-EXCEPTIONS.md) states the scope, lists the files, and carries the AGPL section 7 permission; [`site/vendor/NOTICE.md`](site/vendor/NOTICE.md) explains why each one is vendored rather than loaded from a CDN. **If you fork this and intend to charge for the result, read the GSAP terms first.** They are the one licence here that restricts that, and the AGPL cannot override them.
