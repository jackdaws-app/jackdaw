# Data Policy

How Jackdaw gets its data and the rules it holds itself to. This is the collection
posture; [PRIVACY.md](PRIVACY.md) covers personal data, retention, and deletion. They are
meant to be read together.

Jackdaw is not affiliated with, endorsed by, or connected to Micro Center. The retailer's
name appears here only to describe what the extension works on.

## 1. Every reading comes from a page a user opened

There is no crawler, no scheduled job, and no server of ours that visits Micro Center. The
database grows only when someone running the extension loads a page themselves.

Two surfaces produce readings:

- **Product pages.** The extension reads the Google Tag Manager `dataLayer` object the
  page publishes to its own visitors — product ID, SKU, price, brand, category, MPN, EAN,
  the selected store number, and stock status — plus the open-box price rendered in the
  page's own pricing block. One observation per visit.
- **Search and category pages.** The extension reads the result cards already rendered on
  screen (`li.product_wrapper`: id, price, name, brand, category, the printed SKU, a stock
  string, the card's own open-box line where it has one — "2 open box from $339.96" — and
  the struck-out original price where the card advertises a discount) and submits them as a
  single bounded batch, capped at 96 items — the largest page of results Micro Center
  itself offers.

Everything collected is text the retailer had already painted onto the user's screen.

## 2. Zero additional requests

This is the rule the rest of the document hangs on, and it is enforced in code rather than
left to good intentions. Jackdaw never:

- opens a page, tab, or iframe the user did not open;
- follows a product link, or fetches a page to fill in a field it could not see;
- prefetches the next page of results;
- changes the results-per-page setting on the user's behalf — if someone browses 24 per
  page, Jackdaw sees 24;
- issues any XHR or `fetch` to Micro Center at all.

Reading more of a page someone opened is not crawling. Opening one more page is. A single
prefetch would move Jackdaw from the first category into the second, so the collector has
no code path that can make a request.

## 3. robots.txt is honoured even though it does not bind us

`robots.txt` governs crawlers, and the collector is not one — it reads pages a person
chose to visit. The directives are followed anyway, because staying outside the argument
is cheaper than winning it.

The path that matters in practice is `/quickViewConfigurator`, which Micro Center
disallows and which sits behind the "Quick View" button on every result card. Jackdaw
never clicks, fetches, or otherwise triggers it. The same goes for `/sendConfigurator.aspx`.

## 4. No product images

No product image is stored, copied, hotlinked, or re-served, on any surface. Prices and
stock levels are facts; photographs and marketing copy are the retailer's work. Jackdaw's
interface is drawn entirely from its own SVG and canvas. Micro Center's logos and branding
appear nowhere in the extension, the site, or the store listing.

## 5. What is sent, and what is deliberately not

Sent with an observation: the product's own identifiers and price, the store number the
page had selected, stock status, and an anonymous per-install device ID.

Not sent, from either surface:

- **The URL.** Products are identified by product ID, not by address. Search and category
  pages transmit no URL at all, which means **no search terms and no filters** — Jackdaw
  records the products that were displayed, never the query that displayed them.
- Anything about other tabs, other sites, or browsing history.
- Any account, cart, order, or checkout data. The content scripts are registered only for
  `/product/`, `/search/`, and `/category/` URLs; the extension does not load on those
  pages at all.

## 6. Contributing is one switch, and turning it off leaves the product working

The toolbar popup carries a single "Share what I browse" switch. It gates both sighting
paths at one choke point in the service worker, so switching it off silences product pages
and result pages together — a switch that quietly left one path reporting would be a lie.
Price history, charts, alerts, and discussion all keep working while it is off. Reading is
never gated on contributing.

## 7. No ads, no paywall, no data sales

Jackdaw is free and open source under the AGPL-3.0. There is no advertising, no paid tier,
and no sale or licensing of collected data to anyone. If donations are ever accepted they
cover hosting costs, and no feature sits behind them.

## 8. Changes

This document describes current, shipped behaviour. If a future feature would require a
request Jackdaw does not make today, this file changes first and says so plainly.
