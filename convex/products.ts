import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import {
  categoryKey,
  conditionFromName,
  isPhysicalStore,
  normalizeSku,
  readSummary,
  resolveSession,
  widenSummary,
} from "./lib";
import type { PriceSummary } from "./lib";

const pointValidator = v.object({
  storeNum: v.string(),
  price: v.number(),
  inStock: v.boolean(),
  availability: v.union(v.string(), v.null()),
  openBoxPrice: v.union(v.number(), v.null()),
  // The retailer's own "Original price" at the time of this reading, when a
  // grid card advertised one. Per-point rather than per-product because a
  // promotion starts and ends, so it belongs to the reading that saw it.
  listPrice: v.union(v.number(), v.null()),
  firstSeenAt: v.number(),
  lastSeenAt: v.number(),
  reportCount: v.number(),
  // "catalog" for a grid-card reading, null for a product page (and for every
  // row written before catalog collection existed). Sent so the panel can
  // apply the same corroboration rule the handler does — it computes its own
  // stats from these points rather than using the ones returned below.
  source: v.union(v.literal("catalog"), v.null()),
});

/**
 * Price summaries for a page of grid cards, in one query.
 *
 * The badge on a category page needs a range for up to 96 products at once.
 * Reading each one's points would be tens of thousands of documents against a
 * 16,384 ceiling, so this reads ONE row per product — the rolling summary
 * maintained on write (see `products` in schema.ts). Cost is bounded by the
 * caller's id count, and that count is bounded at Micro Center's own largest
 * "items per page".
 *
 * Products we have never seen are simply absent from the reply rather than
 * returned as empty rows: the grid should show a badge where there is history
 * and nothing at all where there is none, and a "no data" marker on 60 cards
 * is noise the shopper did not ask for.
 */
export const summaries = query({
  args: { productIds: v.array(v.string()) },
  returns: v.array(
    v.object({
      productId: v.string(),
      low: v.union(v.number(), v.null()),
      high: v.union(v.number(), v.null()),
      // Same meaning as in `history`: the extremes rest on lone catalog
      // sightings, so they are the best evidence we hold but may not be called
      // a record. The badge drops its record language when this is true.
      provisional: v.boolean(),
      lastPrice: v.union(v.number(), v.null()),
      observedAt: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    // Micro Center's largest page is 96 cards; the collector caps there too.
    // This bounds the read cost of ONE call and matches the largest real grid.
    // It is not an export control: a caller who already holds product ids can
    // paginate. What it does guarantee is that no single call can scan.
    if (args.productIds.length > 96) {
      throw new Error("TOO_MANY_PRODUCTS");
    }
    const seen = new Set<string>();
    const out = [];
    for (const productId of args.productIds) {
      if (seen.has(productId)) continue;
      seen.add(productId);
      const product = await ctx.db
        .query("products")
        .withIndex("by_productId", (q) => q.eq("productId", productId))
        .unique();
      if (product === null) continue;
      const s = readSummary(product);
      // A product row with no summary at all predates this field and has not
      // been seen since. It has nothing to show, and showing a badge with
      // empty numbers would be worse than showing none.
      if (s.low === null && s.lastPrice === null) continue;
      out.push({ productId, ...s });
    }
    return out;
  },
});

/**
 * Rebuild every product's summary from its points.
 *
 * Two jobs. It backfills rows written before the summary existed, and — because
 * it recomputes rather than repairs — it is the consistency check on the
 * incremental maintenance: run it against a deployment that has been taking
 * observations and `changed` should be zero. A nonzero count on a deployment
 * where nothing deletes points means a write path and the read path have drifted
 * apart, which is the one failure mode a denormalized summary has.
 *
 * Internal and cursor-driven: it reads points, so it is the one thing here that
 * genuinely scans, and it must never be reachable from a page.
 */
export const recompute = internalMutation({
  args: { cursor: v.optional(v.string()), batch: v.optional(v.number()) },
  returns: v.object({
    scanned: v.number(),
    changed: v.number(),
    isDone: v.boolean(),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("products").paginate({
      cursor: args.cursor ?? null,
      numItems: Math.min(Math.max(args.batch ?? 50, 1), 200),
    });
    let changed = 0;
    for (const product of page.page) {
      // Same reason as `history` above, and it matters more here: on a product
      // past 1000 points an ascending take would rebuild the summary from stale
      // rows and write lastPrice/lastSeenAt BACKWARDS over correct
      // incrementally-maintained values, then report the drift it just created.
      const rows = (
        await ctx.db
          .query("pricePoints")
          .withIndex("by_product", (q) => q.eq("productDocId", product._id))
          .order("desc")
          .take(1000)
      ).reverse();
      // Built with the same helper the write paths use, from an empty start —
      // so this compares two independent routes to the same numbers rather
      // than re-deriving one from the other.
      let fresh: PriceSummary = {};
      for (const r of rows) {
        const widen = widenSummary(
          fresh,
          r.price,
          r.lastSeenAt,
          r.reportCount > 1 || r.source !== "catalog",
        );
        if (widen !== null) fresh = { ...fresh, ...widen };
      }
      const patch: PriceSummary & {
        categoryKey?: string;
        sku?: string;
        condition?: "refurbished";
      } = {};
      const keys = [
        "lowCorrob",
        "highCorrob",
        "lowAny",
        "highAny",
        "lastPrice",
        "lastSeenAt",
      ] as const;
      for (const k of keys) {
        if (product[k] !== fresh[k]) patch[k] = fresh[k];
      }
      // The lookup key is derived from `category` exactly as the counter keys
      // are, so it belongs to the same recompute-owns-derived-fields rule: this
      // is the backfill for rows written before the field existed, and the only
      // path allowed to CLEAR a key, because the write paths cannot tell a
      // category that normalizes to nothing from one that was never sent.
      const freshKey = categoryKey(product.category) ?? undefined;
      if (product.categoryKey !== freshKey) patch.categoryKey = freshKey;
      // Rows written before `normalizeSku` existed hold whichever spelling their
      // last visit happened to use — the dataLayer's stripped "44594" or the
      // printed "044594". Both write paths now agree, so a row only converges on
      // its next sighting, and a product nobody revisits never converges at all.
      // Same class of backfill as categoryKey, so it lives on the same pass.
      const freshSku = normalizeSku(product.sku);
      if (product.sku !== freshSku) patch.sku = freshSku;
      // And the third of the same class. The write paths re-derive `condition`
      // only when the NAME changes, which is right — it is the sole input — but
      // it leaves every product last seen before the field existed unflagged.
      // This pass is the backfill, and it stays correct afterwards for free:
      // re-deriving from the stored name can only ever agree with the write
      // paths, which is what makes a second pass change nothing.
      const freshCondition = conditionFromName(product.name);
      if (product.condition !== freshCondition) patch.condition = freshCondition;
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(product._id, patch);
        changed++;
      }
    }
    return {
      scanned: page.page.length,
      changed,
      isDone: page.isDone,
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const history = query({
  args: {
    productId: v.string(),
    // Filters the price series. Rarely used: Micro Center prices nationally, so
    // scoping the chart to one store thins it for no gain.
    storeNum: v.optional(v.string()),
    // Selects which shelf snapshot comes back, and nothing else. Deliberately
    // NOT `storeNum` above — the shelf is the one thing that genuinely varies
    // by location, so the panel asks about the store being browsed while the
    // chart keeps every store's prices.
    shelfStore: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({
      product: v.object({
        productId: v.string(),
        sku: v.string(),
        name: v.string(),
        brand: v.union(v.string(), v.null()),
        category: v.union(v.string(), v.null()),
        mpn: v.union(v.string(), v.null()),
        ean: v.union(v.string(), v.null()),
        urlPath: v.string(),
        // Refurbished or not. It qualifies every number on the panel — a used
        // unit's history is not comparable to a new one's — so it travels with
        // the product rather than being left for the reader to spot in `name`.
        condition: v.union(v.literal("refurbished"), v.null()),
      }),
      points: v.array(pointValidator),
      stats: v.object({
        lowestPrice: v.union(v.number(), v.null()),
        highestPrice: v.union(v.number(), v.null()),
        // True when the extremes rest on uncorroborated catalog sightings
        // alone — no price here has been seen twice or read from a product
        // page. The number is still the best evidence we have; this says not
        // to call it a record. See the corroboration rule in the handler.
        provisional: v.boolean(),
        currentPrice: v.union(v.number(), v.null()),
        // When somebody last actually saw that price, and where. Every surface
        // that shows `currentPrice` shows these beside it: the number is the
        // most recent SIGHTING, not a live feed, and a shopper who drives
        // somewhere on a three-week-old reading was misled by the omission.
        observedAt: v.union(v.number(), v.null()),
        observedStore: v.union(v.string(), v.null()),
      }),
      // Present only when `shelfStore` was asked for and that store has been
      // seen. `units` is what one shopper's screen said; `atLeast` marks Micro
      // Center's own capped display ("25+"). `openBoxUnits` is how many used
      // units that store had — null on a product this store has only ever been
      // seen through a product page, which shows the open-box price with no
      // count beside it.
      shelf: v.union(
        v.null(),
        v.object({
          storeNum: v.string(),
          inStock: v.boolean(),
          units: v.union(v.number(), v.null()),
          atLeast: v.boolean(),
          openBoxUnits: v.union(v.number(), v.null()),
          observedAt: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const product = await ctx.db
      .query("products")
      .withIndex("by_productId", (q) => q.eq("productId", args.productId))
      .unique();
    if (product === null) return null;

    const storeNum = args.storeNum;
    // DESC then reverse, never ASC: `take` truncates at the far end of the scan,
    // so ascending order would hand back the OLDEST 1000 rows and freeze the
    // chart, `currentPrice` and `observedAt` on ancient data while every surface
    // went on labelling them fresh. Callers still receive them oldest-first.
    const rows = (
      storeNum !== undefined
        ? await ctx.db
            .query("pricePoints")
            .withIndex("by_product_store", (q) =>
              q.eq("productDocId", product._id).eq("storeNum", storeNum),
            )
            .order("desc")
            .take(1000)
        : await ctx.db
            .query("pricePoints")
            .withIndex("by_product", (q) => q.eq("productDocId", product._id))
            .order("desc")
            .take(1000)
    ).reverse();

    const points = rows.map((r) => ({
      storeNum: r.storeNum,
      price: r.price,
      inStock: r.inStock,
      availability: r.availability ?? null,
      openBoxPrice: r.openBoxPrice ?? null,
      listPrice: r.listPrice ?? null,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
      reportCount: r.reportCount,
      source: r.source ?? null,
    }));

    // A price extreme is a claim every surface repeats: the chart annotates it,
    // the panel headline quotes it, and a watch can fire on it. A lone catalog
    // card is the weakest evidence we hold — one number read off a card that
    // also renders a member price, a bundle total and a $x/mo financing figure,
    // admitted by a write-path clamp that only rejects below 0.2x the last
    // known price. So a single uncorroborated grid reading is not allowed to
    // DEFINE an extreme. It still appears in `points` and on the chart; it just
    // doesn't get to name the record.
    //
    // Corroborated means either:
    //   - reportCount > 1        — that same price was seen again, or
    //   - source !== "catalog"   — a product-page reading, taken from Micro
    //     Center's own dataLayer rather than matched out of card text.
    //
    // Read-path on purpose: lowestPrice is derived per query, never stored, so
    // this needs no migration AND it repairs rows already collected. The
    // fallback carries equal weight — a product only ever seen on grids has no
    // corroborated point at all, and returning null there would hide a real if
    // thin reading behind a technicality, so its own evidence stands and
    // `provisional` says so out loud.
    const isCorroborated = (r: (typeof rows)[number]) =>
      r.reportCount > 1 || r.source !== "catalog";

    let lowestPrice: number | null = null;
    let highestPrice: number | null = null;
    let lowestAny: number | null = null;
    let highestAny: number | null = null;
    let currentPrice: number | null = null;
    let observedStore: string | null = null;
    let currentLastSeen = -1;
    for (const r of rows) {
      if (lowestAny === null || r.price < lowestAny) lowestAny = r.price;
      if (highestAny === null || r.price > highestAny) highestAny = r.price;
      if (isCorroborated(r)) {
        if (lowestPrice === null || r.price < lowestPrice) lowestPrice = r.price;
        if (highestPrice === null || r.price > highestPrice) {
          highestPrice = r.price;
        }
      }
      // `currentPrice` deliberately keeps taking the newest row whatever its
      // provenance. The extremes are a historical claim and can afford to wait
      // for confirmation; "what does it cost right now" cannot, and every
      // surface already prints observedAt beside it, so a fresh lone reading is
      // shown as exactly what it is rather than withheld in favour of a stale
      // corroborated one.
      if (r.lastSeenAt > currentLastSeen) {
        currentLastSeen = r.lastSeenAt;
        currentPrice = r.price;
        observedStore = r.storeNum;
      }
    }
    const provisional = lowestPrice === null && lowestAny !== null;
    if (lowestPrice === null) lowestPrice = lowestAny;
    if (highestPrice === null) highestPrice = highestAny;

    const shelfStore = args.shelfStore;
    const shelfRow =
      shelfStore === undefined
        ? null
        : await ctx.db
            .query("storeStock")
            .withIndex("by_product_store", (q) =>
              q.eq("productDocId", product._id).eq("storeNum", shelfStore),
            )
            .unique();

    return {
      product: {
        productId: product.productId,
        sku: product.sku,
        name: product.name,
        brand: product.brand ?? null,
        category: product.category ?? null,
        mpn: product.mpn ?? null,
        ean: product.ean ?? null,
        urlPath: product.urlPath,
        // The STORED value, not `conditionFromName(product.name)` re-run here.
        // Deriving on read would paper over a missing backfill and make
        // `recompute`'s change count worthless as evidence — the same reason
        // `categoryKey` is read from the row rather than recomputed. Until that
        // pass runs, an old row reads null and the panel simply shows no chip,
        // which is the safe direction.
        condition: product.condition ?? null,
      },
      points,
      stats: {
        lowestPrice,
        highestPrice,
        provisional,
        currentPrice,
        observedAt: currentLastSeen < 0 ? null : currentLastSeen,
        observedStore,
      },
      shelf:
        shelfRow === null
          ? null
          : {
              storeNum: shelfRow.storeNum,
              inStock: shelfRow.inStock,
              units: shelfRow.units ?? null,
              atLeast: shelfRow.atLeast === true,
              openBoxUnits: shelfRow.openBoxUnits ?? null,
              observedAt: shelfRow.observedAt,
            },
    };
  },
});

// ---------------------------------------------------------------------------
// Open box, across every store at once
// ---------------------------------------------------------------------------

// Stores considered per product. Micro Center operates ~28 locations, so 64 is
// generous headroom rather than a working limit — it exists so this read can
// never scale with a table.
const OPEN_BOX_MAX_STORES = 64;
// Window over the product's price series used only to ENUMERATE stores that
// have no shelf row. Same budget as `history`'s series read.
const OPEN_BOX_POINT_WINDOW = 1000;

/**
 * Which physical stores currently hold an open-box unit of one product — a
 * snapshot of today's belief, never a series.
 *
 * The open-box price is the one genuinely per-store price on the page (one
 * physical returned unit at one location), so unlike everything else in this
 * file the answer is a list of stores. The per-store belief is carried by the
 * NEWEST pricePoints row for that (product, store): a number means "an
 * open-box unit at this price", absent means observed-absent or never-seen —
 * the carry-forward rule in observations.ts. Unit counts come from storeStock,
 * the one-row-per-(product, store) snapshot, and stay a snapshot: nothing here
 * can reconstruct a history, by the same schema constraint that makes the
 * table safe to have at all.
 *
 * ACCOUNT-GATED, in the watches.dashboard style: a cross-store shopping view
 * belongs to the participation tier, and a signed-out caller gets the empty
 * signed-out shape rather than a throw, so a signed-out surface renders an
 * invitation instead of a console error. Reading one product's own page data
 * stays anonymous (`history` above); this is the aggregation, not the reading.
 *
 * BOUNDED BY CONSTRUCTION. Stores are enumerated from the product's shelf rows
 * (at most one per store) plus the store numbers appearing in the newest
 * OPEN_BOX_POINT_WINDOW points, both take-capped; then ONE newest-row read per
 * store. A store whose last sighting of any kind has fallen out of the window
 * is not enumerated — its belief is older than anything this snapshot should
 * relay anyway. Pseudo-stores (029/000) have no shelves and are filtered the
 * same way every shelf read filters them.
 *
 * NO unitsAtLeast FIELD, deliberately: storeStock.atLeast qualifies `units`
 * (the "25+ IN STOCK" cap on general stock), not `openBoxUnits` — the open-box
 * count on a grid card ("2 open box from $339.96") is never displayed capped,
 * so relaying the flag here would attach a caveat to the wrong number.
 */
export const openBoxAcross = query({
  args: {
    productId: v.string(),
    sessionToken: v.optional(v.string()),
  },
  returns: v.object({
    signedIn: v.boolean(),
    stores: v.array(
      v.object({
        storeNum: v.string(),
        openBoxPrice: v.number(),
        // From the store's shelf snapshot; null when only a product page has
        // ever seen this store's unit (a product page shows the price with no
        // count beside it).
        openBoxUnits: v.union(v.number(), v.null()),
        // When the price belief was last confirmed: the newest price point's
        // own lastSeenAt. Every surface shows age beside a per-store fact — the
        // freshness is the honesty.
        lastSeenAt: v.number(),
        // When the shelf count was taken, when a shelf row exists. Reported
        // separately because the two readings can come from different visits.
        shelfObservedAt: v.union(v.number(), v.null()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    // Signed out is an empty list, not an error — same rule as
    // watches.dashboard, so a signed-out panel renders a sign-in card.
    const signedOut = { signedIn: false, stores: [] };
    if (args.sessionToken === undefined || args.sessionToken.length === 0) {
      return signedOut;
    }
    const resolved = await resolveSession(ctx, args.sessionToken);
    if (resolved === null) return signedOut;

    const product = await ctx.db
      .query("products")
      .withIndex("by_productId", (q) => q.eq("productId", args.productId))
      .unique();
    if (product === null) return { signedIn: true, stores: [] };

    // Every store this product has a shelf snapshot for. One row per store by
    // construction, so the cap is headroom, not truncation.
    const shelfRows = await ctx.db
      .query("storeStock")
      .withIndex("by_product_store", (q) => q.eq("productDocId", product._id))
      .take(OPEN_BOX_MAX_STORES);
    const shelfByStore = new Map(shelfRows.map((r) => [r.storeNum, r]));

    // Plus every store appearing in the recent price series — a store a
    // product page has seen holds an open-box belief with no shelf row.
    const recentPoints = await ctx.db
      .query("pricePoints")
      .withIndex("by_product", (q) => q.eq("productDocId", product._id))
      .order("desc")
      .take(OPEN_BOX_POINT_WINDOW);

    const candidateStores = new Set<string>(shelfByStore.keys());
    for (const point of recentPoints) {
      if (candidateStores.size >= OPEN_BOX_MAX_STORES) break;
      candidateStores.add(point.storeNum);
    }

    const stores = [];
    for (const storeNum of candidateStores) {
      // A pseudo-store (029 "Shippable Items", 000 unknown) names no shelf,
      // so it can hold no open-box unit — same filter as every shelf read.
      if (!isPhysicalStore(storeNum)) continue;
      // The newest row for this (product, store) carries the current belief,
      // exactly as the write paths' carry-forward maintains it.
      const newest = await ctx.db
        .query("pricePoints")
        .withIndex("by_product_store", (q) =>
          q.eq("productDocId", product._id).eq("storeNum", storeNum),
        )
        .order("desc")
        .first();
      if (newest === null || newest.openBoxPrice === undefined) continue;
      const shelf = shelfByStore.get(storeNum);
      stores.push({
        storeNum,
        openBoxPrice: newest.openBoxPrice,
        openBoxUnits: shelf?.openBoxUnits ?? null,
        lastSeenAt: newest.lastSeenAt,
        shelfObservedAt: shelf?.observedAt ?? null,
      });
    }

    // Cheapest first: the row a cross-store shopper acts on is the low one.
    stores.sort((a, b) => a.openBoxPrice - b.openBoxPrice);
    return { signedIn: true, stores };
  },
});
