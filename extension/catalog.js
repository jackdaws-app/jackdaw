// The catalog surface — ISOLATED world, category and search grids only.
//
// Two halves over one reading of the grid. The COLLECTOR reports what the page
// already rendered; the BADGES annotate each card with what shoppers have seen
// that product cost before. They share `readGrid()` on purpose — a badge and the
// batch quoting different prices for the same card would be one of them lying,
// and reading the DOM twice is how that happens. Each half has its own switch
// in the popup, because contributing and reading are different consents.
//
// WHAT THIS IS. Somebody browsing a category page has, on their screen, the
// current price and shelf state of every product in the grid. The product-page
// reader learns one product per visit; this learns whatever the page already
// rendered, which is the same information the same person already loaded. That
// is the entire idea, and every rule below exists to keep it that way.
//
// WHAT THIS NEVER DOES, and none of these are performance choices:
//   * it never opens a page, prefetches, or requests anything from Micro
//     Center. Not the next page of results, not a product page, not an image.
//     Zero additional traffic — the byte count of a browsing session is
//     identical with the extension installed and without it.
//   * it never changes "items per page". If the shopper's grid shows 24, this
//     sees 24. Rewriting rpp to 96 on their behalf would mean Jackdaw asking
//     Micro Center for four times the page a person wanted, which is fetching
//     for our own benefit wearing a user's session as a costume.
//   * it never touches Quick View. That control fires /quickViewConfigurator,
//     which Micro Center's robots.txt disallows — an automated click there
//     would be a machine requesting a path they asked machines not to.
//   * it never runs on a signed-in surface (account, cart, order history). The
//     content-script match patterns keep it to public browse pages.
//
// Contributing is off until it is turned on in the popup, which is where it is
// disclosed in plain language and where the consent card asks. `jdCatalog ===
// true` is the only on state; absent means the question hasn't been answered,
// and an unanswered question sends nothing.

(() => {
  const CATALOG_KEY = "jdCatalog";
  const MAX_ITEMS = 96; // Micro Center's largest "items per page"; the backend caps identically

  // Page-local completion receipt: this page's own verdict, written to a data
  // attribute on the page's root so Jackdaw's verification tooling can read what
  // happened on a page a tester opened themselves. It holds only ids the page
  // had already rendered, plus the collector version and the backend verdict.
  // Nothing is sent to Micro Center and nothing is stored in Jackdaw's database
  // — but the attribute is readable by any script on the page, which makes the
  // extension detectable there.
  const RECEIPT_ATTR = "data-jackdaw-catalog-receipt";
  const COLLECTOR_VERSION = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return "unknown";
    }
  })();

  // Recently-reported suppression. `store:product` -> [sentAtMs, fullSignature]
  const SENT_KEY = "jdSent";
  const SENT_WINDOW_MS = 10 * 60 * 1000;
  // Sized for a long browsing session at the largest results-per-page, with
  // headroom. Entries still expire on time; the cap keeps the earliest pages of
  // one session from being evicted while they are still inside the window,
  // which would turn one browser into apparent corroborating readers.
  const SENT_MAX = 2200;

  // Reloading or auto-updating Jackdaw orphans an already-injected content
  // script: it keeps running, and every `chrome.*` call it makes from then on
  // throws "Extension context invalidated". This surface is silent by design —
  // there is nothing a browse page should tell a shopper about any of it — so
  // the guard just stops, quietly, instead of throwing into Micro Center's
  // console. The next page load gets the new script and works normally.
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  // One round trip to the service worker, resolving null rather than throwing
  // on any failure — an orphaned context, an unknown type, a worker that died
  // mid-reply. Every caller here treats null as "no answer" and falls back to
  // its own default, which is the same contract the raw storage reads had.
  //
  // Storage is behind this now. storage.local is restricted to trusted contexts
  // so the session token cannot be read from inside the retailer's page, and an
  // access level covers a whole area rather than one key, so the collector's own
  // suppression cache and switches come through the settings gateway instead.
  const ask = (msg) =>
    new Promise((resolve) => {
      if (!alive()) return resolve(null);
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          void chrome.runtime.lastError;
          resolve(r || null);
        });
      } catch {
        resolve(null);
      }
    });

  function emitReceipt(receipt) {
    try {
      document.documentElement.setAttribute(
        RECEIPT_ATTR,
        JSON.stringify({
          receiptVersion: 1,
          collectorVersion: COLLECTOR_VERSION,
          observedAt: Date.now(),
          ...receipt,
        }),
      );
    } catch {
      // Navigation can detach the document while a reply is landing. The next
      // rendered page gets its own receipt, so there is nothing to retry here.
    }
  }

  function pageFingerprint(storeNum, productIds) {
    const joined = productIds.slice().sort().join(",");
    let h = 0x811c9dc5;
    for (let i = 0; i < joined.length; i++) {
      h ^= joined.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return `${storeNum}:${productIds.length}:${(h >>> 0).toString(36)}`;
  }

  function receiptContext(storeNum, shown, visibleProductIds) {
    const readable = new Set(shown.map((item) => item.productId));
    return {
      storeNum,
      pageFingerprint: pageFingerprint(storeNum, visibleProductIds),
      visibleCount: visibleProductIds.length,
      readableCount: shown.length,
      visibleProductIds,
      unreadableProductIds: visibleProductIds.filter((id) => !readable.has(id)),
    };
  }

  // ---------------------------------------------------------------------------
  // Card reading
  // ---------------------------------------------------------------------------

  /** Every $x.xx in the card's own rendered text, as numbers. */
  function shownPrices(card) {
    const out = [];
    const matches = card.textContent.match(/\$\s*[\d,]+(?:\.\d{2})?/g) || [];
    for (const m of matches) {
      const v = parseFloat(m.replace(/[$,\s]/g, ""));
      if (isFinite(v)) out.push(v);
    }
    return out;
  }

  /**
   * Selector health for ONE grid read, filled in as the cards are read.
   *
   * Three numbers per reader — see `recordSelectorHealth` in `convex/lib.ts`
   * for what they mean and why they are only advisory. In short: `found`
   * collapsing to zero means Micro Center renamed an element, `bad` climbing
   * means it kept the element and changed the wording. Both are conditions the
   * three-state reads handle SAFELY and therefore SILENTLY, which is exactly
   * why they have to be counted somewhere.
   *
   * `seen` is not the same denominator for every reader, deliberately. A card
   * that bails out early (no price attribute, illegible stock) was never in a
   * position to look at its clearance div, and counting it as a miss would
   * blame the open-box reader for a failure one selector upstream. So each
   * reader's `seen` is incremented at the point the reader actually runs, and
   * `card.found / card.seen` is what catches the upstream break.
   */
  function newTally() {
    const z = () => ({ seen: 0, found: 0, bad: 0 });
    return { card: z(), price: z(), clearance: z(), discount: z() };
  }
  let tally = newTally();

  /**
   * Read one grid card, or null if anything about it is unclear.
   *
   * Null is the common and correct outcome, not a failure: a card we cannot
   * read confidently is one we do not report. Every check below turns a
   * possible silent wrong number into an obvious absent one.
   */
  function readCard(card) {
    const idAnchor = card.querySelector("a[data-id]");
    if (!idAnchor) return null;
    const productId = (idAnchor.getAttribute("data-id") || "").trim();
    if (!/^\d{1,20}$/.test(productId)) return null;

    // The FIRST a[data-id] in a card is the wishlist action, whose href points
    // at account.microcenter.com/auth/signin — using it as the product URL
    // would file every product under the sign-in page. The product link is the
    // one whose href actually says /product/.
    const link = card.querySelector('a[href*="/product/"]');
    if (!link) return null;
    let urlPath;
    try {
      const u = new URL(link.getAttribute("href"), location.origin);
      if (u.hostname !== location.hostname) return null;
      urlPath = u.pathname;
    } catch {
      return null;
    }
    if (!urlPath.startsWith("/product/")) return null;

    const attr = (n) => {
      const v = idAnchor.getAttribute(n);
      return v && v.trim() ? v.trim() : undefined;
    };

    const name = (attr("data-name") || "").slice(0, 300);
    if (!name) return null;

    const sku = (card.textContent.match(/SKU:\s*([A-Za-z0-9-]{1,40})/) || [])[1];
    if (!sku) return null;

    // Price: the attribute is the machine-readable figure, the card text is
    // what the shopper actually sees, and we only believe the two together.
    // A grid card sits beside a member price, a bundle total and a $x/mo
    // financing figure; any of those landing in `price` writes a fake low that
    // an alert then fires on. Requiring the attribute to appear in the visible
    // text is selector-independent, so a Micro Center markup change makes this
    // collect nothing rather than collect nonsense.
    const price = parseFloat(attr("data-price") || "");
    if (!isFinite(price) || price <= 0 || price >= 100000) return null;
    if (!shownPrices(card).some((v) => Math.abs(v - price) < 0.005)) return null;

    // Stock. `.stock` shares its container with the Bazaarvoice rating, so its
    // text reads "4.7 19 IN STOCK" — anchoring the match on "IN STOCK" and
    // taking the digits immediately before it is what keeps the star rating
    // out of the unit count.
    const stockText = ((card.querySelector(".stock") || card).textContent || "")
      .replace(/\s+/g, " ");
    let inStock;
    let units;
    let atLeast;
    if (/SOLD OUT|OUT OF STOCK/i.test(stockText)) {
      inStock = false;
    } else if (card.querySelector(".msgInStock") || /IN STOCK/i.test(stockText)) {
      inStock = true;
      const m = stockText.match(/(\d+)(\+?)\s*IN STOCK/i);
      if (m) {
        units = parseInt(m[1], 10);
        // "25+ IN STOCK" is Micro Center capping its own display. The number is
        // a floor, and every surface that shows it has to say so.
        atLeast = m[2] === "+";
        if (!Number.isInteger(units) || units < 0 || units > 10000) {
          units = undefined;
          atLeast = undefined;
        }
      }
    } else {
      // Neither state is legible ("check other stores", a shipping-only card,
      // a layout we don't know). Not a sighting.
      return null;
    }

    // Open box, from `.clearance` inside `.price_wrapper`. EVERY card carries
    // the div — 96 of 96 on the page this was verified against, 83 of them
    // empty — and that is what makes the field reportable from a grid at all:
    // an empty div is the store saying "no open-box unit here", not the reader
    // failing to find one. That distinction is the entire safety property, so
    // it is encoded as three states rather than two:
    //
    //   div absent            unknown. Report nothing; the server keeps
    //                         whatever the last reading held.
    //   div present, empty    observed absent. Reported, and it CLEARS a stale
    //                         open-box price for this store.
    //   div present, unparsed unknown, deliberately. A phrasing we don't
    //                         recognise must not be read as "none" — that
    //                         would clear a real price on markup we simply
    //                         don't understand yet.
    //
    // Store-scoped, verified 2026-08-15 by re-reading the same seven products
    // under two store selections: four present at 065 and absent at 045, and
    // one showing 1 unit at 065 against 2 at 045 at the same price. A national
    // pooled figure would have been unusable here — it would arm open-box
    // alerts against units sitting in another state.
    let openBoxSeen;
    let openBoxPrice;
    let openBoxUnits;
    tally.clearance.seen++;
    const clearance = card.querySelector(".clearance");
    if (clearance) {
      tally.clearance.found++;
      const clearanceText = (clearance.textContent || "").replace(/\s+/g, " ").trim();
      if (!clearanceText) {
        openBoxSeen = true;
      } else {
        const ob = clearanceText.match(/^(\d{1,4}) open box from \$([\d,]+\.\d{2})$/i);
        if (ob) {
          const u = parseInt(ob[1], 10);
          const p = parseFloat(ob[2].replace(/,/g, ""));
          // An open-box unit is a used unit, so it has to undercut the new
          // price — the same sanity test the product-page reader applies to
          // `#opCostNew`, and what keeps a bundle total or a financing figure
          // out of this field.
          if (
            Number.isInteger(u) && u > 0 && u <= 1000 &&
            isFinite(p) && p > 0 && p < price
          ) {
            openBoxSeen = true;
            openBoxPrice = p;
            openBoxUnits = u;
          }
        }
        // Non-empty and we still could not read it. `openBoxSeen` is true on
        // both good paths — empty div, or a parsed-and-sane figure — so its
        // absence here is exactly the "present but unparseable" third state,
        // the one that deliberately keeps the old value rather than clear it.
        // Safe, and silent without this line.
        if (openBoxSeen !== true) tally.clearance.bad++;
      }
    }

    // List price, from `div.standardDiscount` — the retailer's own struck-out
    // "Original price $799.99" beside a "Save $120.00". Same three states as
    // open box, and one structural difference that decides where the flag comes
    // from: `.clearance` is on every card and merely EMPTY when there is no
    // open-box unit, but `.standardDiscount` is ABSENT when there is no
    // discount — 118 present and 0 empty across a category page and a search
    // page. So its own absence cannot be the observability signal; it would be
    // indistinguishable from "this reader never looked".
    //
    // The anchor is therefore the card's own `.price` block, present on 96 of
    // 96 cards. Finding it is what licenses `listSeen`, and only then does a
    // missing discount div mean "none advertised" rather than "unknown".
    //
    //   .price absent          unknown. The server keeps the last reading.
    //   .price, no discount    observed absent. CLEARS a stale list price.
    //   .price, unparsed       unknown, deliberately — same reasoning as above.
    //
    // Only the struck figure is sent. "Save $120.00" is exactly `strike − price`
    // on all 118 blocks surveyed, so storing it too would be storing the same
    // fact twice and inviting the two to disagree after a rounding change.
    let listSeen;
    let listPrice;
    tally.price.seen++;
    const priceEl = card.querySelector(".price_wrapper .price");
    if (priceEl) {
      // This one carries the whole list-price contract: `listSeen` is licensed
      // by finding THIS element, so if it ever stops matching, the flag stops
      // being set and every discount on the site silently becomes uncollected
      // rather than wrong. Expected ratio is 1.00 — anything else is the alarm.
      tally.price.found++;
      tally.discount.seen++;
      // Descendant, not `:scope >`. Every block surveyed was a direct child,
      // but the failure directions are not symmetric: if the markup ever nests
      // one level deeper, a direct-child selector reads "no discount" and
      // CLEARS a real list price, while a descendant selector keeps working.
      // Scoping to `.price` rather than `.price_wrapper` is what keeps a
      // discount line nested inside `.clearance` out of this field.
      const sd = priceEl.querySelector(".standardDiscount");
      if (!sd) {
        listSeen = true;
      } else {
        // NOT a fault: about a third of cards carry a discount, so `found` is
        // expected around 0.35 here and only a hard zero across a large sample
        // means the element moved. The panel labels this reader accordingly so
        // the low ratio is never read as a break.
        tally.discount.found++;
        // `strike.textContent` carries a screen-reader prefix, so it reads
        // "Original price $799.99" — match the money rather than parsing the
        // whole string, and require exactly one figure so a markup change that
        // puts two prices in there is unparsed rather than guessed at.
        const strike = sd.querySelector("strike");
        const money = ((strike && strike.textContent) || "").match(/\$[\d,]+\.\d{2}/g);
        if (money && money.length === 1) {
          const v = parseFloat(money[0].slice(1).replace(/,/g, ""));
          // A list price is the figure the shelf price is discounted FROM, so
          // it must exceed it. Equal is not a discount, it is a misread of the
          // price itself; the server applies the same test.
          if (isFinite(v) && v > price && v < 1000000) {
            listSeen = true;
            listPrice = v;
          }
        }
        // The discount block was there and yielded nothing usable — a second
        // money figure inside the strike, a missing strike, or a value that
        // failed the "must exceed the shelf price" test. Kept as unknown, which
        // is correct and invisible; counted here so it stops being invisible.
        if (listSeen !== true) tally.discount.bad++;
      }
    }

    return {
      productId,
      sku,
      name,
      urlPath,
      price,
      inStock,
      ...(units !== undefined ? { units } : {}),
      ...(atLeast ? { atLeast: true } : {}),
      ...(listSeen ? { listSeen: true } : {}),
      ...(listPrice !== undefined ? { listPrice } : {}),
      ...(openBoxSeen ? { openBoxSeen: true } : {}),
      ...(openBoxPrice !== undefined ? { openBoxPrice } : {}),
      ...(openBoxUnits !== undefined ? { openBoxUnits } : {}),
      ...(attr("data-brand") ? { brand: attr("data-brand").slice(0, 100) } : {}),
      ...(attr("data-category") ? { category: attr("data-category").slice(0, 200) } : {}),
    };
  }

  /**
   * Whatever the page has rendered right now, deduped, capped.
   *
   * Returns the card elements alongside the readings, in the same order: the
   * badge writer needs somewhere to put each badge, and reading the grid twice
   * would let the number a badge shows drift from the number the batch
   * reported. One read, one truth.
   */
  function readGrid() {
    const cards = document.querySelectorAll("li.product_wrapper");
    // Fresh per pass. The tally describes THIS reading of the grid; carrying it
    // across passes would double-count a re-render and make every number a sum
    // over an unknown number of grid reads.
    tally = newTally();
    const seen = new Set();
    const visible = new Set();
    const items = [];
    const els = [];
    for (const card of cards) {
      if (items.length >= MAX_ITEMS) break;
      // Counted before the read, so a card that bails out on any of readCard's
      // early returns lands in `seen` without landing in `found`. That gap IS
      // the container-level health signal.
      tally.card.seen++;
      const idAnchor = card.querySelector("a[data-id]");
      const visibleId = ((idAnchor && idAnchor.getAttribute("data-id")) || "").trim();
      if (/^\d{1,20}$/.test(visibleId)) visible.add(visibleId);
      const item = readCard(card);
      if (!item || seen.has(item.productId)) continue;
      tally.card.found++;
      seen.add(item.productId);
      items.push(item);
      els.push(card);
    }
    // Clamped to what the server will accept, so a page that somehow rendered
    // more than the cap is reported as the cap rather than being refused
    // wholesale — a rejected tally tells us nothing, and this is the one number
    // we most want to survive an unexpected page.
    for (const k of Object.keys(tally)) {
      const t = tally[k];
      t.seen = Math.min(t.seen, MAX_ITEMS);
      t.found = Math.min(t.found, t.seen);
      t.bad = Math.min(t.bad, t.found);
    }
    return { items, els, tally, visibleProductIds: [...visible] };
  }

  function emitNoStoreReceipt(status, storeNum) {
    const { items, visibleProductIds } = readGrid();
    emitReceipt({
      ...receiptContext(storeNum, items, visibleProductIds),
      status,
      offeredCount: 0,
      acceptedCount: 0,
      skippedCount: 0,
      acceptedProductIds: [],
      skippedItems: [],
      suppressedProductIds: [],
      selectorsRejected: false,
    });
  }

  // ---------------------------------------------------------------------------
  // Recently-reported suppression
  // ---------------------------------------------------------------------------
  //
  // A shopper working through a category sends overlapping sets: page 1, page
  // 2, back to page 1, a filter change that leaves most of the grid standing.
  // The backend's batch fingerprint only catches a byte-identical repeat inside
  // 60s, so without this the same card is reported over and over inside one
  // session.
  //
  // The waste is not why this exists. `products.history` treats
  // `reportCount > 1` as CORROBORATION — it is the rule that decides whether a
  // catalog-only reading may be NAMED the all-time low. One person scrolling a
  // category five times would carry a single unverified sighting to
  // reportCount 5, where it would present as five shoppers independently
  // agreeing. This is what keeps that number meaning what the read path says it
  // means.
  //
  // It suppresses a REPEAT, never a CHANGE. The remembered entry carries every
  // reading that was sent — shelf price, stock, open-box price, list price — and
  // a difference in any one of them re-reports at once. The rule for what
  // belongs in that tuple is the server's: whatever can open a new price point
  // has to be able to defeat this cache, or the cache would suppress the very
  // change an alert is waiting on.

  async function readSent() {
    const reply = await ask({ type: "settings:get", keys: SENT_KEY });
    const sent = reply && reply.result && reply.result[SENT_KEY];
    return sent && typeof sent === "object" && !Array.isArray(sent) ? sent : {};
  }

  // The remembered signature carries every field reportBatch can update. Shelf
  // depth and the observability flags matter even when price and Boolean stock
  // do not move; identity text matters because the same mutation repairs it.
  // Old array entries contain a number at [1], so the first page after this
  // upgrade deliberately reports once and replaces them with full signatures.
  const slot = (v) => v ?? null;

  function readingSignature(item) {
    return JSON.stringify([
      item.price,
      item.inStock ? 1 : 0,
      slot(item.units),
      item.atLeast === true ? 1 : 0,
      item.openBoxSeen === true ? 1 : 0,
      slot(item.openBoxPrice),
      slot(item.openBoxUnits),
      item.listSeen === true ? 1 : 0,
      slot(item.listPrice),
      item.sku,
      item.name,
      item.urlPath,
      slot(item.brand),
      slot(item.category),
    ]);
  }

  function isRepeat(entry, item, now) {
    return (
      Array.isArray(entry) &&
      now - entry[0] < SENT_WINDOW_MS &&
      entry[1] === readingSignature(item)
    );
  }

  /** Drop expired entries, then the oldest, until the map fits. */
  function prune(sent, now) {
    for (const k of Object.keys(sent)) {
      const e = sent[k];
      if (!Array.isArray(e) || typeof e[0] !== "number" || now - e[0] >= SENT_WINDOW_MS) {
        delete sent[k];
      }
    }
    const keys = Object.keys(sent);
    if (keys.length > SENT_MAX) {
      keys.sort((a, b) => sent[a][0] - sent[b][0]);
      for (const k of keys.slice(0, keys.length - SENT_MAX)) delete sent[k];
    }
    return sent;
  }

  // ---------------------------------------------------------------------------
  // Submission
  // ---------------------------------------------------------------------------

  async function submit(storeNum, shown, tally, visibleProductIds) {
    const now = Date.now();
    const sent = prune(await readSent(), now);
    // The store is part of the key. Price is national but the shelf is not, so
    // the same card seen after switching stores is a genuinely different
    // reading and must not be suppressed by the first one.
    const keyOf = (item) => `${storeNum}:${item.productId}`;
    const items = [];
    const suppressedProductIds = [];
    for (const item of shown) {
      if (isRepeat(sent[keyOf(item)], item, now)) suppressedProductIds.push(item.productId);
      else items.push(item);
    }
    const context = receiptContext(storeNum, shown, visibleProductIds);
    // Every card on this page was already reported at these prices, minutes
    // ago. Nothing to add, so nothing is sent — which also leaves the device's
    // rate-limit budget for a page that does carry something new.
    //
    // ONE EXCEPTION, and it is the case the tally exists for: a page where not
    // a single card produced a reading. That is what a break in
    // `li.product_wrapper` — or in any of readCard's gates — looks like from
    // in here, and it is indistinguishable from "nobody browsed" unless
    // something is sent. So an empty batch goes out carrying only the health
    // numbers. Genuine no-result searches take this path too and cannot be
    // separated from a break at this level; the ratio over many pages is what
    // carries the signal, and the panel says so rather than pretending.
    //
    // A page whose cards were merely SUPPRESSED as recent stays silent: the
    // readers demonstrably worked, so there is no question to raise, and
    // spending a rate-limit token to say "all fine" is the wrong trade.
    if (items.length === 0 && tally.card.found > 0) {
      emitReceipt({
        ...context,
        status: "suppressed",
        offeredCount: 0,
        acceptedCount: 0,
        skippedCount: 0,
        acceptedProductIds: [],
        skippedItems: [],
        suppressedProductIds,
        selectorsRejected: false,
      });
      return;
    }

    // Fire and forget, exactly like the product-page report: the backend
    // refuses in band (throttled, rate limited, no store) and there is nothing
    // a browse page should show a shopper about any of it. The reply is read
    // only to decide what may be forgotten.
    if (!alive()) return;
    emitReceipt({
      ...context,
      status: "submitting",
      offeredCount: items.length,
      acceptedCount: 0,
      skippedCount: 0,
      acceptedProductIds: [],
      skippedItems: [],
      suppressedProductIds,
      selectorsRejected: false,
    });
    try {
      chrome.runtime.sendMessage(
        { type: "catalog:batch", storeNum, items, selectors: tally },
        (reply) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            emitReceipt({
              ...context,
              status: "error",
              offeredCount: items.length,
              acceptedCount: 0,
              skippedCount: 0,
              acceptedProductIds: [],
              skippedItems: [],
              suppressedProductIds,
              selectorsRejected: false,
              errorCode: "RUNTIME",
            });
            return;
          }
          // background.js answers in an envelope — `{result}` on success,
          // `{error}` on failure — so the backend's own verdict is one level
          // down. Reading `reply.ok` here instead found `undefined`, took the
          // early return every single time, and left `jdSent` permanently
          // empty: the suppression above existed but never suppressed anything.
          const res = reply && reply.result;
          if (!res) {
            emitReceipt({
              ...context,
              status: "error",
              offeredCount: items.length,
              acceptedCount: 0,
              skippedCount: 0,
              acceptedProductIds: [],
              skippedItems: [],
              suppressedProductIds,
              selectorsRejected: false,
              errorCode: (reply && reply.code) || "NO_RESULT",
            });
            return;
          }

          let status = "refused";
          if (res.reason === "CONTRIBUTION_OFF") status = "contribution_off";
          else if (res.reason === "NO_STORE") status = "no_store";
          else if (res.rateLimited === true) status = "rate_limited";
          else if (res.throttled === true) status = "throttled";
          else if (res.ok === true) status = "accepted";
          emitReceipt({
            ...context,
            status,
            offeredCount: items.length,
            acceptedCount: res.accepted || 0,
            skippedCount: res.skipped || 0,
            acceptedProductIds: res.acceptedProductIds || [],
            skippedItems: res.skippedItems || [],
            suppressedProductIds,
            selectorsRejected: res.selectorsRejected === true,
          });

          // Remember only what the backend actually took. A throttled or
          // rate-limited batch wrote nothing, and recording it would suppress
          // the retry that should carry it. Cards the server SKIPPED are
          // recorded deliberately: a reading it clamped as implausible at this
          // price will be clamped again at the same price, and re-offering it
          // every page is the behaviour this whole block exists to stop.
          if (!res || res.ok !== true || res.throttled === true) return;
          const stamp = Date.now();
          for (const item of items) {
            sent[keyOf(item)] = [stamp, readingSignature(item)];
          }
          // Nothing to write for a health-only batch, and `prune` on an
          // unchanged object would rewrite storage for no reason.
          if (items.length === 0) return;
          // The reply can land after the extension was reloaded, so this write
          // needs its own guard even though the send above passed one. `ask`
          // carries it, and swallows an orphan between send and reply — the
          // next page load simply re-reports.
          void ask({ type: "settings:set", values: { [SENT_KEY]: prune(sent, stamp) } });
        },
      );
    } catch {
      emitReceipt({
        ...context,
        status: "error",
        offeredCount: items.length,
        acceptedCount: 0,
        skippedCount: 0,
        acceptedProductIds: [],
        skippedItems: [],
        suppressedProductIds,
        selectorsRejected: false,
        errorCode: "SEND_FAILED",
      });
    }
  }

  // ===========================================================================
  // Badges — the read half of the same surface
  // ===========================================================================
  //
  // The grid already tells the shopper what everything costs today. What it
  // cannot tell them is whether today is a good day, and that is the one thing
  // a price history knows. So each card gets a range and a marker showing where
  // its current price sits inside it.
  //
  // A badge appears ONLY where there is a range to show — `high > low`. A
  // product we have seen at exactly one price has nothing to add to a card that
  // is already displaying that price, and, worse, that single sighting is
  // usually one WE wrote minutes ago from a previous grid view: a badge there
  // would quote the extension's own reading back as though it were history.
  // Requiring a range makes badges rarer and makes every one of them carry
  // something the page does not.
  //
  // Everything renders inside a per-card shadow root, for the same reason the
  // panel does: Micro Center's CSS cannot reach in, ours cannot leak out, and
  // nothing we add can disturb the layout of a page we are a guest on.

  const BADGES_OFF_KEY = "jdBadges";
  // A price record is not a shelf signal and the two do not age alike. The
  // popup ambers a store's stock reading at 48h because one physical shelf
  // changes hourly; a national price range is still describing something real a
  // week later. Past that, the range is history rather than news and says so.
  const BADGE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

  // The overhead silhouette, byte-for-byte the artwork the popup and the
  // arrival already use — one bird, one brand. It is here so a badge on
  // somebody else's page can never be mistaken for that page's own: Jackdaw
  // disclaims affiliation on every surface, and an unsigned annotation inside
  // Micro Center's card would put our words in their mouth.
  //
  // A reduced version was drawn first, on the theory that the fingered
  // primaries and the notched tail would turn to fuzz at badge size. Rendered
  // at 4x against the real grid it read as a paper aeroplane: squaring off the
  // wing tips is exactly what stops a bird looking like a bird from overhead.
  // The notches are the artwork, so the real bird is given the room it needs
  // (11x14, the viewBox's own proportion) instead of being redrawn to fit a
  // square — the same lesson v1–v4 of the bird taught.
  const MARK_SVG =
    '<svg viewBox="8 2 76 96" fill="none" aria-hidden="true" focusable="false">' +
    '<path d="M55 46.2 Q51 38 47.5 30.5 Q44.5 23.5 40.5 15.5 L38.6 21.5 L35.2 17.5 L34.6 24 L31.6 21.5 L32 28 L29.5 26.5 Q32.5 34 36 40.5 Q38.5 44.6 40 47.8 Z"/>' +
    '<path d="M55 53.8 Q51 62 47.5 69.5 Q44.5 76.5 40.5 84.5 L38.6 78.5 L35.2 82.5 L34.6 76 L31.6 78.5 L32 72 L29.5 73.5 Q32.5 66 36 59.5 Q38.5 55.4 40 52.2 Z"/>' +
    '<path d="M31.5 47.6 L20 42.5 L21.8 45.8 L17.5 44.8 L19.6 48 L16.8 50 L19.6 52 L17.5 55.2 L21.8 54.2 L20 57.5 L31.5 52.4 Q30.6 50 31.5 47.6 Z"/>' +
    '<path d="M31 49.9 Q34 47.6 41 46.6 Q50 45.4 57 46.6 Q62.5 47.4 66.5 48.7 L74 49.9 L66.5 51.2 Q62.5 52.6 57 53.4 Q50 54.6 41 53.4 Q34 52.4 31 50.1 Z"/>' +
    "</svg>";

  // Inline rather than fetched from web_accessible_resources like panel.css:
  // one panel per page can afford a round trip, ninety-six badges opening at
  // once should not each wait on one. Parsed once into a constructable sheet
  // and adopted by every shadow root below.
  const BADGE_CSS = `
/* Custom properties ONLY. A :host rule loses the cascade to any rule in the
   outer page that matches the host element — that is how shadow hosts are
   sorted — so nothing load-bearing may live here. What the badge looks like is
   set on .b below, inside the shadow tree, where Micro Center's stylesheet
   cannot reach at all; what the host element itself needs is written inline,
   where nothing outranks it. Custom properties are safe here because the outer
   page declares none of them. */
:host {
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --b-ink: #1c1e21;
  --b-muted: #6b7280;
  /* Deeper than a divider hairline would be, and deliberately: the panel's own
     meter can afford a 1.2:1 track because its FILL is what you read, but here
     the rail is the scale the pin is measured against — a pin at 40% of an
     invisible line says nothing. 3.18:1 on white, which clears the 3:1
     non-text threshold at the 2px it is actually drawn. */
  --b-rail: #959086;
  --b-pin: #16233a;
  --b-green: #0e7a37;
  --b-warn: #8a5a09;
  --d: 0ms;
}
/* The badge sits inside the retailer's card, so it takes the CARD's palette,
   not Jackdaw's own theme setting: a dark panel is our surface to darken, this
   one is theirs. Set from the first opaque background above the insertion
   point, so a Micro Center dark mode would carry the badge with it. */
:host(.jd-on-dark) {
  --b-ink: #e6eaf2;
  --b-muted: #97a1b5;
  /* 3.1–3.9:1 across every dark card colour worth guessing at (#0f1115 through
     #222831). Speculative until Micro Center ships a dark mode, but a token
     that would fail the moment it fired is not worth writing. */
  --b-rail: #63719b;
  --b-pin: #cbd5e6;
  --b-green: #4ade80;
  --b-warn: #e0a83c;
}
* { box-sizing: border-box; }
.sr {
  position: absolute; width: 1px; height: 1px; margin: -1px;
  padding: 0; border: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}
/* A shadow root isolates SELECTORS, not inheritance: the host page's font,
   colour, letter-spacing and text-transform all still cross the boundary. The
   host is reset with all:initial inline, which leaves this to restate every
   inheritable property rather than assume one. */
.b {
  position: relative;
  margin: 7px 0 3px;
  font: 400 11px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
  letter-spacing: 0;
  word-spacing: 0;
  text-align: left;
  text-transform: none;
  text-indent: 0;
  color: var(--b-ink);
  animation: b-in 200ms var(--ease-out) var(--d) backwards;
}
.rail {
  position: relative;
  height: 2px;
  border-radius: 1px;
  background: var(--b-rail);
  transform-origin: left center;
  animation: b-rail 320ms var(--ease-out) calc(var(--d) + 40ms) backwards;
}
/* The pin is CENTRED on its position, so at 0% and 100% half of it would hang
   off the end of the rail it is supposed to be measured against — measured at
   1.5px past the left edge on a record and 1px past the right on a price above
   the range, which is exactly where the pin matters most. Clamping the travel
   by the half-width keeps both extremes flush inside the rail instead. */
.pin {
  --hw: 1px;
  position: absolute;
  top: -3px;
  left: clamp(var(--hw), var(--p), calc(100% - var(--hw)));
  width: calc(var(--hw) * 2);
  height: 8px;
  margin-left: calc(var(--hw) * -1);
  border-radius: 1px;
  background: var(--b-pin);
  transform-origin: center;
  animation: b-pin 220ms var(--ease-out) calc(var(--d) + 300ms) backwards;
}
.rec .pin { --hw: 1.5px; background: var(--b-green); }
.cap {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 5px;
  animation: b-cap 240ms var(--ease-out) calc(var(--d) + 160ms) backwards;
}
/* Sized to the artwork's own 76x96 viewBox rather than to a square, so the
   bird fills the box instead of letterboxing inside one. 14px tall against an
   11px caption puts the mark a little above cap height, which is where a
   signature sits. */
.mk { flex: 0 0 auto; width: 11px; height: 14px; color: var(--b-muted); opacity: 0.85; }
.mk svg { display: block; width: 100%; height: 100%; }
.mk path { fill: currentColor; }
.lead {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
}
.rec .lead {
  color: var(--b-green);
  font-weight: 600;
  font-size: 9.5px;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}
.rec .mk { color: var(--b-green); opacity: 1; }
.age {
  flex: 0 0 auto;
  font-size: 9.5px;
  letter-spacing: 0.03em;
  color: var(--b-muted);
}
.age.warn { color: var(--b-warn); }
@keyframes b-in { from { opacity: 0; } }
@keyframes b-rail { from { transform: scaleX(0); } }
@keyframes b-pin { from { transform: scaleY(0); opacity: 0; } }
@keyframes b-cap { from { opacity: 0; transform: translateY(3px); } }
@media (prefers-reduced-motion: reduce) {
  .b, .rail, .pin, .cap { animation: none !important; }
}
`;

  let sheet = null;
  /** One parsed stylesheet for the whole grid, adopted by every badge. */
  function badgeSheet() {
    if (sheet !== null) return sheet;
    try {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(BADGE_CSS);
    } catch {
      sheet = false; // no constructable sheets — each root gets its own <style>
    }
    return sheet;
  }

  const fmtPrice = (v) =>
    "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function ago(ms) {
    const d = Date.now() - ms;
    if (d < 60_000) return "just now";
    if (d < 3_600_000) return Math.round(d / 60_000) + "m ago";
    if (d < 86_400_000) return Math.round(d / 3_600_000) + "h ago";
    const days = Math.round(d / 86_400_000);
    if (days < 30) return days + "d ago";
    if (days < 365) return Math.round(days / 30) + "mo ago";
    return Math.round(days / 365) + "y ago";
  }

  /**
   * Is the card's own background dark?
   *
   * Walks up for the first background that actually paints — every ancestor of
   * a Micro Center grid card is transparent until <body>. Read once per page,
   * not once per card: it is the same answer ninety-six times, and resolving
   * computed style that often to learn it would be a waste.
   */
  function onDarkBackdrop(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const m = (getComputedStyle(n).backgroundColor || "").match(
        /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/,
      );
      if (!m) continue;
      if (m[4] !== undefined && parseFloat(m[4]) <= 0.5) continue; // see-through
      // Rec. 709 luminance — the same weighting a contrast ratio uses.
      return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255 < 0.5;
    }
    return false;
  }

  /**
   * Build one badge, or return null if this product has nothing to say.
   *
   * `s` is a row from products:summaries. `provisional` there means no extreme
   * has been corroborated — every reading behind the range is a lone catalog
   * sighting. The number is still the best evidence held, so the range is
   * shown; what it may not do is claim a RECORD, which is why the all-time-low
   * wording is gated on it. Same rule the panel applies, same words it uses.
   */
  function buildBadge(item, s, dark, index) {
    if (typeof s.low !== "number" || typeof s.high !== "number") return null;
    if (s.high <= s.low) return null;

    const atLow = item.price <= s.low && !s.provisional;
    const seen = `${fmtPrice(s.low)}–${fmtPrice(s.high)}`;
    const age = typeof s.observedAt === "number" ? ago(s.observedAt) : null;
    const stale = typeof s.observedAt === "number" && Date.now() - s.observedAt > BADGE_STALE_MS;

    const host = document.createElement("div");
    host.className = "jd-badge-host" + (dark ? " jd-on-dark" : "");
    // The host element lives in Micro Center's DOM, where their rules reach it
    // and outrank anything :host says. `all: initial` is the only reliable way
    // to stop a stray `.price_wrapper div { float; margin; display }` from
    // reshaping it — and inline is the only place that reset outranks them.
    // (`all` deliberately does not touch custom properties, so the tokens the
    // shadow sheet sets on :host survive it.)
    host.style.cssText = "all:initial;display:block;width:100%;contain:layout style";
    host.setAttribute("data-jd-badge", "1");
    host.title = s.provisional
      ? `Jackdaw — seen between ${seen}, but not yet confirmed by a second sighting` +
        (age ? ` (last seen ${age})` : "")
      : `Jackdaw — shoppers have seen this between ${seen}` + (age ? `, last ${age}` : "");

    const root = host.attachShadow({ mode: "open" });
    const s0 = badgeSheet();
    if (s0) root.adoptedStyleSheets = [s0];
    else {
      const style = document.createElement("style");
      style.textContent = BADGE_CSS;
      root.append(style);
    }

    const b = document.createElement("div");
    b.className = "b" + (atLow ? " rec" : "");
    // The stagger is what turns ninety-six simultaneous appearances into a
    // sweep, but it is capped: the last card must not sit blank for two seconds
    // waiting for its turn.
    b.style.setProperty("--d", Math.min(index, 12) * 18 + "ms");

    const rail = document.createElement("div");
    rail.className = "rail";
    const pin = document.createElement("i");
    pin.className = "pin";
    const span = s.high - s.low;
    const at = Math.max(0, Math.min(1, (item.price - s.low) / span));
    pin.style.setProperty("--p", (at * 100).toFixed(2) + "%");
    rail.append(pin);

    const cap = document.createElement("div");
    cap.className = "cap";
    const mk = document.createElement("span");
    mk.className = "mk";
    mk.innerHTML = MARK_SVG;
    const sr = document.createElement("span");
    sr.className = "sr";
    sr.textContent = "Jackdaw price history: ";
    const lead = document.createElement("span");
    lead.className = "lead";
    lead.textContent = atLow ? "All-time low" : seen;
    const when = document.createElement("span");
    when.className = "age" + (stale ? " warn" : "");
    // A range nothing has confirmed is a weaker claim than a stale one, so it
    // takes the slot: which of the two the reader most needs is not close.
    when.textContent = s.provisional ? "unconfirmed" : (age ?? "");
    cap.append(mk, sr, lead, when);

    b.append(rail, cap);
    root.append(b);
    return host;
  }

  /** Where a badge goes: under the price block, above the buttons. */
  function anchor(card) {
    const wrap = card.querySelector(".price_wrapper");
    if (!wrap) return null;
    return { wrap, before: wrap.querySelector(".cartActions") };
  }

  async function paintBadges(shown, els) {
    const ids = shown.map((i) => i.productId);
    // orphaned resolves null — the grid keeps its own prices, just unbadged
    const reply = await ask({ type: "catalog:summaries", productIds: ids });
    const rows = reply && reply.result;
    if (!Array.isArray(rows) || rows.length === 0) return;
    const byId = new Map(rows.map((r) => [r.productId, r]));

    let dark = null;
    let drawn = 0;
    for (let i = 0; i < shown.length; i++) {
      const s = byId.get(shown[i].productId);
      if (!s) continue;
      const card = els[i];
      if (!card || card.querySelector("[data-jd-badge]")) continue;
      const spot = anchor(card);
      if (!spot) continue;
      if (dark === null) dark = onDarkBackdrop(spot.wrap);
      const host = buildBadge(shown[i], s, dark, drawn);
      if (host === null) continue;
      if (spot.before) spot.wrap.insertBefore(host, spot.before);
      else spot.wrap.append(host);
      drawn++;
    }
  }

  // ---------------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------------

  let ran = false;

  async function run(storeNum) {
    if (ran) return;
    ran = true;

    // One read of the grid, shared by both halves — see readGrid().
    const { items, els, tally, visibleProductIds } = readGrid();

    // There is deliberately no `items.length === 0` bail here any more. A page
    // that produced no readings is the one page whose selector tally matters,
    // and `submit` decides whether it is worth sending — see the note there.
    // The badge half below still skips an empty grid, because there is nothing
    // to paint on.

    // The badges switch still defaults to on when absent, so an orphaned
    // context must not fall through to `{}` here the way the other reads do —
    // that would paint badges from a dead context. Stop instead; the next load
    // works normally. (Contributing reads `{}` as unanswered, which is off.)
    const reply = await ask({ type: "settings:get", keys: [CATALOG_KEY, BADGES_OFF_KEY] });
    if (!reply || !reply.result) return;
    const settings = reply.result;
    // Contributing takes an explicit true and nothing else: absent means the
    // popup's consent card hasn't been answered, and an unanswered question
    // sends nothing. The tally rides this switch with the sightings —
    // telemetry about our own readers is still data leaving the browser, and
    // anything short of "yes" has to mean nothing leaves.
    if (settings[CATALOG_KEY] === true) {
      await submit(storeNum, items, tally, visibleProductIds);
    } else {
      emitReceipt({
        ...receiptContext(storeNum, items, visibleProductIds),
        status: "contribution_off",
        offeredCount: 0,
        acceptedCount: 0,
        skippedCount: 0,
        acceptedProductIds: [],
        skippedItems: [],
        suppressedProductIds: [],
        selectorsRejected: false,
      });
    }
    // Independent of contributing. That switch governs what leaves this browser
    // as an observation; withholding price history from somebody who turned it
    // off would make reading a toll rather than a choice.
    if (items.length > 0 && settings[BADGES_OFF_KEY] !== false) {
      await paintBadges(items, els);
    }
  }

  window.addEventListener(
    "jackdaw:catalog-store",
    (e) => {
      window.dispatchEvent(new CustomEvent("jackdaw:catalog-ack"));
      let storeNum;
      try {
        storeNum = JSON.parse(e.detail).storeNum;
      } catch {
        return;
      }
      if (!/^\d{1,10}$/.test(storeNum) || storeNum === "000") {
        emitNoStoreReceipt("no_store", String(storeNum || "000"));
        return;
      }
      // One grid read, shortly after the store is known, so the initial render
      // has settled. Deliberately not observing the DOM for later additions:
      // a report describes what was on screen when somebody looked at it, and
      // a collector that kept watching would be measuring the page rather than
      // the visit.
      setTimeout(() => run(storeNum), 1200);
    },
    { once: true },
  );

  window.addEventListener(
    "jackdaw:catalog-store-missing",
    () => {
      emitNoStoreReceipt("no_store_signal", "000");
    },
    { once: true },
  );
})();
