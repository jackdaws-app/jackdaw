import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  bump,
  categoryKey,
  conditionFromName,
  initCounter,
  isPhysicalStore,
  normalizeSku,
  normalizeUrlPath,
  recordSelectorHealth,
  selectorHealthValidator,
  requireLength,
  sanitize,
  tryRateLimit,
  utcDay,
  widenSummary,
} from "./lib";

const THROTTLE_MS = 60_000;

export const report = mutation({
  args: {
    deviceId: v.string(),
    productId: v.string(),
    sku: v.string(),
    name: v.string(),
    urlPath: v.string(),
    price: v.number(),
    storeNum: v.string(),
    inStock: v.boolean(),
    openBoxPrice: v.optional(v.number()),
    availability: v.optional(v.string()),
    brand: v.optional(v.string()),
    category: v.optional(v.string()),
    mpn: v.optional(v.string()),
    ean: v.optional(v.string()),
    // Only `openBox` is ever populated from this path — it is the one reader on
    // a product page whose target can be absent for legitimate reasons, and the
    // one that matched nothing for its entire life without anyone noticing.
    selectors: selectorHealthValidator,
  },
  // `rateLimited` refuses the write in-band instead of throwing, which is what
  // makes the abuse counter below possible. Safe here because the only caller
  // discards the result (content.js fires `send({type:"report"})` without
  // awaiting it); anything the UI shows an error for must keep throwing.
  returns: v.object({
    ok: v.boolean(),
    throttled: v.boolean(),
    rateLimited: v.boolean(),
    implausible: v.boolean(),
    selectorsRejected: v.boolean(),
  }),
  handler: async (ctx, args) => {
    // Validate numeric input.
    if (!Number.isFinite(args.price) || args.price <= 0 || args.price >= 100_000) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "price must be a finite number greater than 0 and less than 100000",
      });
    }
    if (
      args.openBoxPrice !== undefined &&
      (!Number.isFinite(args.openBoxPrice) ||
        args.openBoxPrice <= 0 ||
        args.openBoxPrice >= 100_000)
    ) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message:
          "openBoxPrice must be a finite number greater than 0 and less than 100000",
      });
    }

    // Validate / sanitize string inputs.
    const deviceId = requireLength("deviceId", args.deviceId, 1, 100);
    const productId = requireLength("productId", args.productId, 1, 40);
    // The dataLayer's unpadded spelling becomes the printed one — see
    // normalizeSku. Without it this path and the catalog path fight over the
    // same field on every alternating visit.
    const sku = normalizeSku(requireLength("sku", args.sku, 1, 40));
    const name = requireLength("name", args.name, 1, 300);
    // Normalized BEFORE the length check, so a value that is nothing but a
    // query string fails as INVALID_ARGUMENT rather than being stored empty.
    const urlPath = requireLength(
      "urlPath",
      normalizeUrlPath(args.urlPath),
      1,
      500,
    );
    const storeNum = requireLength("storeNum", args.storeNum, 1, 10);
    const availability =
      args.availability !== undefined
        ? sanitize(args.availability).slice(0, 200)
        : undefined;
    const brand =
      args.brand !== undefined ? sanitize(args.brand).slice(0, 100) : undefined;
    const category =
      args.category !== undefined ? sanitize(args.category).slice(0, 200) : undefined;
    const mpn = args.mpn !== undefined ? sanitize(args.mpn).slice(0, 100) : undefined;
    const ean = args.ean !== undefined ? sanitize(args.ean).slice(0, 100) : undefined;

    const now = Date.now();
    const reportKey = `${productId}:${storeNum}`;

    // Throttle per device: one write per (product, store) per minute.
    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", deviceId))
      .unique();
    if (
      device !== null &&
      device.lastReportKey === reportKey &&
      device.lastReportAt !== undefined &&
      now - device.lastReportAt < THROTTLE_MS
    ) {
      return { ok: true, throttled: true, rateLimited: false, implausible: false, selectorsRejected: false };
    }

    // Global per-device cap on price reports (token bucket, 120/hour).
    //
    // Refused in-band rather than thrown, purely so the rejection can be
    // counted: a throw would roll back the transaction and take the counter
    // bump with it (verified empirically on dev — scheduling an internal
    // mutation before the throw is cancelled the same way). The write is
    // refused either way; only the signalling differs.
    if (!(await tryRateLimit(ctx, "priceReport", deviceId))) {
      await bump(ctx, `abuse:ratelimited:day:${utcDay(now)}`);
      return { ok: false, throttled: false, rateLimited: true, implausible: false, selectorsRejected: false };
    }

    // Plausibility clamp, mirroring the catalog batch's PRICE_OUTLIER skip
    // (same PRICE_MIN_RATIO / PRICE_MAX_RATIO constants below). Baseline: the
    // newest price point for this product across ANY store — Micro Center
    // prices nationally (watches.fireFor reads newest-any-store for the same
    // reason), so a reading implausible against the freshest national figure
    // is implausible, full stop. Cold start (no product or no prior point)
    // accepts, same as the batch path.
    //
    // Ordering is deliberate: AFTER the rate limit, so probing the clamp
    // costs quota, and BEFORE the device row is stamped, so a refused write
    // never throttles the legit report that follows it. Refused in-band, not
    // thrown, for the same transactional reason as `rateLimited` above.
    const existing = await ctx.db
      .query("products")
      .withIndex("by_productId", (q) => q.eq("productId", productId))
      .unique();
    if (existing !== null) {
      const baseline = await ctx.db
        .query("pricePoints")
        .withIndex("by_product", (q) => q.eq("productDocId", existing._id))
        .order("desc")
        .first();
      if (
        baseline !== null &&
        (args.price < baseline.price * PRICE_MIN_RATIO ||
          args.price > baseline.price * PRICE_MAX_RATIO)
      ) {
        await bump(ctx, `abuse:implausible:day:${utcDay(now)}`);
        return {
          ok: false,
          throttled: false,
          rateLimited: false,
          implausible: true,
          selectorsRejected: false,
        };
      }
    }

    if (device === null) {
      await ctx.db.insert("devices", {
        deviceId,
        lastReportKey: reportKey,
        lastReportAt: now,
      });
      await bump(ctx, "devices:total");
    } else {
      await ctx.db.patch(device._id, { lastReportKey: reportKey, lastReportAt: now });
    }

    // Upsert the product by Microcenter productId.
    let productDocId;
    if (existing === null) {
      productDocId = await ctx.db.insert("products", {
        productId,
        sku,
        name,
        brand,
        category,
        categoryKey: categoryKey(category) ?? undefined,
        condition: conditionFromName(name),
        mpn,
        ean,
        urlPath,
      });
      await bump(ctx, "products:total");
    } else {
      productDocId = existing._id;
      // `undefined` in the value type because `condition` is the one member
      // that can be REMOVED: a product renamed out of "(Refurbished)" must lose
      // the flag, and `ctx.db.patch` deletes a field set to undefined.
      const patch: Record<string, string | undefined> = {};
      if (existing.sku !== sku) patch.sku = sku;
      if (existing.name !== name) {
        patch.name = name;
        // Derived from the name, so it moves with the name and only with it —
        // recomputed on every rename rather than compared field-by-field,
        // because the two are the same fact and cannot be allowed to disagree.
        const nextCondition = conditionFromName(name);
        if (existing.condition !== nextCondition) patch.condition = nextCondition;
      }
      if (existing.urlPath !== urlPath) patch.urlPath = urlPath;
      if (brand !== undefined && existing.brand !== brand) patch.brand = brand;
      if (category !== undefined && existing.category !== category) {
        patch.category = category;
        // The normalized twin moves with the raw value or the index keeps
        // answering under the old category's name. A category that normalizes
        // to nothing leaves the old key in place rather than writing one that
        // matches nothing — `products:recompute` is what clears those, and it
        // is the only path that may, because it alone can tell an absent key
        // from an unwritten one.
        const nextKey = categoryKey(category);
        if (nextKey !== null) patch.categoryKey = nextKey;
      }
      if (mpn !== undefined && existing.mpn !== mpn) patch.mpn = mpn;
      if (ean !== undefined && existing.ean !== ean) patch.ean = ean;
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(existing._id, patch);
      }
    }

    // Latest price point for this (product, store).
    const latest = await ctx.db
      .query("pricePoints")
      .withIndex("by_product_store", (q) =>
        q.eq("productDocId", productDocId).eq("storeNum", storeNum),
      )
      .order("desc")
      .first();

    // Server-side twin of the extractor's own sanity check: an open-box
    // figure at or above the new price is a misread or a forgery, never a
    // real used unit. Dropped, not refused — and dropping lands on the
    // CARRY-FORWARD side (resolved from `latest`), because an unobserved
    // open box must never clear or alter a stored one.
    const openBoxPrice =
      args.openBoxPrice !== undefined && args.openBoxPrice >= args.price
        ? latest?.openBoxPrice
        : args.openBoxPrice;

    // Open-box prices are the "same" when both absent or within $0.01.
    const openBoxSame =
      latest !== null &&
      (latest.openBoxPrice === undefined
        ? openBoxPrice === undefined
        : openBoxPrice !== undefined &&
          Math.abs(latest.openBoxPrice - openBoxPrice) <= 0.01);

    if (
      latest !== null &&
      latest.price === args.price &&
      latest.inStock === args.inStock &&
      openBoxSame
    ) {
      await ctx.db.patch(latest._id, {
        lastSeenAt: now,
        reportCount: latest.reportCount + 1,
        ...(availability !== undefined ? { availability } : {}),
      });
    } else {
      await ctx.db.insert("pricePoints", {
        productDocId,
        storeNum,
        price: args.price,
        inStock: args.inStock,
        availability,
        openBoxPrice,
        // Carried, never observed. A product page states no "Original price",
        // so this path has nothing to say about the field — and writing what it
        // has (nothing) would CLEAR a figure the grid learned, which is the
        // manufactured-disappearance failure one surface over. Carrying it also
        // makes the value's absence from the corroboration test above safe: the
        // resolved value equals `latest`'s by construction, exactly as with an
        // unobserved open-box price, so it can never be the thing that decides
        // whether a row is new.
        listPrice: latest?.listPrice,
        firstSeenAt: now,
        lastSeenAt: now,
        reportCount: 1,
      });
      await bump(ctx, "pricepoints:total");
    }

    // Widen the product's rolling summary so a grid badge can quote this
    // product's range without reading its points. `existing` was read before
    // the price write and nothing since has touched the summary fields, so it
    // is the correct "before" here. Corroborated unconditionally: this is a
    // product-page reading, taken from Micro Center's own dataLayer.
    const widen = widenSummary(existing ?? {}, args.price, now, true);
    if (widen !== null) await ctx.db.patch(productDocId, widen);

    // Both branches above are a real sighting — an unchanged price bumps the
    // existing row's reportCount, a changed one opens a new row — so the
    // observation counters advance either way. Everything that returns before
    // here (throttled repeat, rate limit, validation) is deliberately silent.
    await bump(ctx, "obs:total");
    await bump(ctx, `obs:store:${storeNum}`);
    await bump(ctx, `obs:day:${utcDay(now)}`);
    // Category mix, for the admin panel's category bars. Keyed off the
    // normalized category so "Solid State Drives" and "solid state drives"
    // are one row.
    const catKey = categoryKey(category);
    if (catKey !== null) await bump(ctx, `obs:cat:${catKey}`);

    // Cap of 1: a product page is one page, so every tally on this path is a
    // single observation and anything larger is a client inventing numbers.
    const selectorsOk = await recordSelectorHealth(ctx, args.selectors, 1, now);

    return { ok: true, throttled: false, rateLimited: false, implausible: false, selectorsRejected: !selectorsOk };
  },
});

// ---------------------------------------------------------------------------
// Catalog batches
// ---------------------------------------------------------------------------
//
// One grid page a shopper was already looking at, submitted as a single call.
// Nothing here fetches anything: the extension reads the cards Micro Center
// already rendered, and if the page shows 24 items this sees 24. Reading the
// same information twice as fast is not the goal — reading what is on screen
// exactly once is.
//
// A catalog card is a THINNER SIGHTING than a product page, and the whole
// design of this function follows from that one fact:
//
//   * it has no open-box price and no availability text, so those fields do
//     not exist in the item shape at all. Unobserved is not the same as
//     absent, and the only way to keep a later reader from confusing the two
//     is to make "absent" unsayable on this path (see CARRY-FORWARD below);
//   * its stock reading is a bucket ("25+"), so the number is written to
//     storeStock as current state and never into the history;
//   * it is one call that moves up to 96 products, which makes it a far better
//     forgery target than a single report, hence the plausibility clamp.
//
// Rows written here are stamped `source: "catalog"` so none of the above has
// to be inferred later from what a row happens to be missing.

const CATALOG_MAX_ITEMS = 96; // Micro Center's largest "items per page"

// A reported price more than 5x, or less than a fifth of, the last price
// known for the product is refused — BOTH collection paths use these: the
// catalog batch clamps against the newest (product, store) row, and the
// single product-page `report` above clamps against the newest row from any
// store. Both directions are far likelier to be
// a misread than a real move: a grid card sits next to a member price, a
// financing figure and a bundle total, and any of those landing in `price`
// would otherwise write a fake all-time low that a watch then fires on. A
// genuine clearance that deep still lands the moment anyone opens the product
// page, which is the higher-fidelity source; a parse error never gets to
// impersonate one. Skipped items are counted and returned, never silent.
const PRICE_MIN_RATIO = 0.2;
const PRICE_MAX_RATIO = 5;

// A list price is bounded on one side by the shelf price it must exceed, and on
// the other by nothing at all — so it gets its own ceiling rather than reusing
// PRICE_MAX_RATIO. 5x would refuse a real 80%-off clearance; 20x refuses the
// misread that put a shelf full of digits in the strike. The two clamps answer
// different questions and are deliberately not the same number.
const CATALOG_MAX_LIST_RATIO = 20;

type CatalogSkipReason =
  | "INVALID_ITEM"
  | "INVALID_UNITS"
  | "INVALID_OPEN_BOX"
  | "INVALID_OPEN_BOX_UNITS"
  | "INVALID_LIST_PRICE"
  | "PRICE_OUTLIER";

const catalogSkipReasonValidator = v.union(
  v.literal("INVALID_ITEM"),
  v.literal("INVALID_UNITS"),
  v.literal("INVALID_OPEN_BOX"),
  v.literal("INVALID_OPEN_BOX_UNITS"),
  v.literal("INVALID_LIST_PRICE"),
  v.literal("PRICE_OUTLIER"),
);

/**
 * Throttle key for one rendered grid: the store plus a 32-bit FNV-1a fold of
 * the product IDs, sorted so card order doesn't matter. Not a security hash —
 * a collision costs one skipped batch, and it exists so the key can identify a
 * page without storing the URL that produced it.
 */
function fingerprint(storeNum: string, items: { productId: string }[]): string {
  const joined = items
    .map((i) => i.productId)
    .sort()
    .join(",");
  let h = 0x811c9dc5;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${storeNum}:${items.length}:${(h >>> 0).toString(36)}`;
}

export const reportBatch = mutation({
  args: {
    deviceId: v.string(),
    // The store the shopper had selected, taken from Micro Center's own
    // dataLayer. "000" (the extension's unknown fallback) is refused below:
    // one product mis-filed under a nonexistent store is a bad row, ninety-six
    // of them is a bad store.
    storeNum: v.string(),
    items: v.array(
      v.object({
        productId: v.string(),
        sku: v.string(),
        name: v.string(),
        urlPath: v.string(),
        price: v.number(),
        inStock: v.boolean(),
        // "4 IN STOCK" -> 4. Absent when the card said only "IN STOCK".
        units: v.optional(v.number()),
        // "25+ IN STOCK" -> units 25, atLeast true.
        atLeast: v.optional(v.boolean()),
        // Open box, and the reason these are three fields rather than one.
        //
        // `openBoxSeen` says the reader COULD read the field on this card, and
        // only a true here lets a reading assert absence. Without it, "no
        // open-box price in the payload" would mean two different things —
        // "this store has none" and "this client can't tell" — and the server
        // would have to guess which. That is the same distinction the batch
        // shape used to make structurally, by having no key at all; the field
        // is representable now because a grid card genuinely can observe it,
        // and the flag is what keeps the old client, the changed markup and the
        // unrecognised phrasing on the safe side of the line.
        //
        // So: `openBoxSeen` absent -> carry the last row forward, unchanged.
        // `openBoxSeen` true with no price -> observed absent, and it CLEARS.
        openBoxSeen: v.optional(v.boolean()),
        // "2 open box from $339.96" -> 339.96. Only meaningful with the flag.
        openBoxPrice: v.optional(v.number()),
        // …and the 2. Shelf depth at one store, so it lands in storeStock and
        // never in the price series — see the note on that table.
        openBoxUnits: v.optional(v.number()),
        // The retailer's own "Original price", and the same three-state shape
        // as open box for the same reason — with ONE structural difference that
        // is worth stating because it changes what the flag has to be driven by.
        //
        // `.clearance` is present on every card and merely EMPTY when there is
        // no open-box unit, so its own presence can carry the "I could see this"
        // signal. `div.standardDiscount` is ABSENT when there is no discount —
        // 118 present and 0 empty across two page templates — so its absence is
        // ambiguous between "no discount here" and "this reader/markup can't
        // tell", which is precisely the distinction that must not be guessed.
        //
        // So `listSeen` is anchored on a DIFFERENT element: the card's own
        // `.price` block, present on 96 of 96 cards. The reader sets the flag
        // when it found that block, which is what makes a missing discount div
        // inside it mean "none advertised" rather than "unknown". Same contract
        // as openBoxSeen at this boundary: absent -> carry forward, true with no
        // price -> observed absent, and it CLEARS.
        listSeen: v.optional(v.boolean()),
        // "Original price $799.99" -> 799.99. Only meaningful with the flag.
        listPrice: v.optional(v.number()),
        brand: v.optional(v.string()),
        category: v.optional(v.string()),
      }),
    ),
    // Did the readers still find what they look for? See recordSelectorHealth
    // in lib.ts for what the three numbers mean and why they are only advisory.
    // Optional: a client predating it sends nothing and is simply not counted.
    selectors: selectorHealthValidator,
  },
  // Refused in band for the same reason `report` is: the caller discards the
  // result, so a refusal can be counted instead of rolling itself back. The
  // Counts remain convenient for the ordinary extension UI. The bounded item
  // outcomes also let a sequential browser driver prove that every card on a
  // page either landed or had a specific refusal, instead of guessing which
  // item an aggregate skip count referred to. These are response metadata only
  // and do not add fields to any stored document.
  returns: v.object({
    ok: v.boolean(),
    accepted: v.number(),
    skipped: v.number(),
    acceptedProductIds: v.array(v.string()),
    skippedItems: v.array(
      v.object({
        productId: v.string(),
        reason: catalogSkipReasonValidator,
      }),
    ),
    throttled: v.boolean(),
    rateLimited: v.boolean(),
    // True when a selector tally arrived and was refused as inconsistent. Not
    // an error — the sighting itself still landed — but it must not be silent,
    // so it is both counted (`sel:rejected`) and returned.
    selectorsRejected: v.boolean(),
    reason: v.union(v.literal("NO_STORE"), v.null()),
  }),
  handler: async (ctx, args) => {
    const nothing = {
      accepted: 0,
      skipped: args.items.length,
      acceptedProductIds: [] as string[],
      skippedItems: [] as { productId: string; reason: CatalogSkipReason }[],
      throttled: false,
      rateLimited: false,
      selectorsRejected: false,
    };

    if (args.items.length > CATALOG_MAX_ITEMS) {
      // Not refusable in band: no page renders more than 96 cards, so this is
      // a broken client rather than a busy one, and truncating it silently
      // would hide the breakage behind a partial success.
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `items must contain at most ${CATALOG_MAX_ITEMS} entries`,
      });
    }

    const deviceId = requireLength("deviceId", args.deviceId, 1, 100);
    const storeNum = requireLength("storeNum", args.storeNum, 1, 10);
    if (storeNum === "000") {
      return { ok: false, ...nothing, reason: "NO_STORE" as const };
    }
    // NOTE there is deliberately no early return for an empty batch any more.
    //
    // A results page that yields zero readable cards is the single most
    // important thing this endpoint can hear about: it is what a break in the
    // `li.product_wrapper` container selector looks like from the outside, and
    // under the old early return it was indistinguishable from silence. The
    // batch now falls through — the item loop simply does not execute, the
    // `accepted > 0` block below is skipped, and the only thing recorded is the
    // selector tally saying "the page rendered N cards and none of them read".
    //
    // It still passes through the fingerprint throttle and the rate limiter
    // first, which is what stops a refresh loop on an empty search from
    // spending the whole budget on nothing. An empty batch fingerprints to a
    // constant for a given store, so a second identical one inside the window
    // is dropped exactly like a repeated real page.
    //
    // Genuine no-result searches land here too, and are NOT separable from a
    // broken selector at this level. The panel says so rather than pretending
    // otherwise; what makes the signal readable is the ratio over thousands of
    // pages, not any single one.

    // Does this store number name a building? "000" is already refused above,
    // so in practice this is asking about "029" — Micro Center's "Shippable
    // Items" pseudo-store, and the default for anyone who has never picked a
    // location, which makes it one of the most common values to arrive here.
    //
    // The PRICES in this batch are kept either way and are worth exactly as
    // much as anyone else's: Micro Center prices nationally, so an online-only
    // shopper's sighting serves every watcher regardless of where they live.
    // What gets dropped below is only the SHELF row — a unit count and an
    // open-box depth for a store with no shelves to count. Writing one would
    // record a fact about a place that does not exist.
    //
    // Loop-invariant, so it is resolved once here rather than per item.
    const hasShelves = isPhysicalStore(storeNum);

    const now = Date.now();

    // Page identity without the page: the store and the SET of products the
    // grid rendered, folded to a 32-bit hash. It carries nothing a person typed
    // — a search URL would put query terms in the devices table, which is not a
    // trade a price tracker should make — and it is order-independent, so a
    // sponsored slot rotating on a re-render is still the same page.
    //
    // The whole set, not just the first card: `store:count:firstId` collided
    // whenever a filter change left the leading card and the card count alone,
    // which silently dropped the other 23 sightings for a minute. Caught by the
    // dev smoke test, which is exactly the shape a person would never notice in
    // use — the batch just quietly didn't land.
    const batchKey = fingerprint(storeNum, args.items);

    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", deviceId))
      .unique();
    if (
      device !== null &&
      device.lastBatchKey === batchKey &&
      device.lastBatchAt !== undefined &&
      now - device.lastBatchAt < THROTTLE_MS
    ) {
      return { ok: true, ...nothing, throttled: true, reason: null };
    }

    // One token for the page, not one per card — see the note on the bucket in
    // lib.ts. Refused in band so the rejection survives to be counted.
    if (!(await tryRateLimit(ctx, "catalogBatch", deviceId))) {
      await bump(ctx, `abuse:ratelimited:day:${utcDay(now)}`);
      return { ok: false, ...nothing, rateLimited: true, reason: null };
    }

    if (device === null) {
      await ctx.db.insert("devices", {
        deviceId,
        lastBatchKey: batchKey,
        lastBatchAt: now,
      });
      await bump(ctx, "devices:total");
    } else {
      await ctx.db.patch(device._id, { lastBatchKey: batchKey, lastBatchAt: now });
    }

    // Counters are accumulated and written ONCE at the end. Bumping obs:total
    // ninety-six times inside one transaction would be ninety-six patches of
    // the same document to reach a number a single delta gets to in one.
    let accepted = 0;
    let skipped = 0;
    const acceptedProductIds: string[] = [];
    const skippedItems: { productId: string; reason: CatalogSkipReason }[] = [];
    let newProducts = 0;
    let newPricePoints = 0;
    const perCategory = new Map<string, number>();

    const seen = new Set<string>();

    for (const raw of args.items) {
      // A grid can repeat a card (sponsored slots, "also viewed" rails inside
      // the results container). First occurrence wins; the rest are not
      // sightings, so they are not counted as skips either.
      if (seen.has(raw.productId)) continue;
      seen.add(raw.productId);

      // Normalized before it is length-checked or written, for the reason in
      // lib.ts. The catalog reader already takes `u.pathname`, so this is the
      // backstop for clients predating that and for anything the shape of the
      // card's href changes into.
      const itemUrlPath = normalizeUrlPath(raw.urlPath);

      if (
        !Number.isFinite(raw.price) ||
        raw.price <= 0 ||
        raw.price >= 100_000 ||
        raw.productId.length === 0 ||
        raw.productId.length > 40 ||
        raw.sku.length === 0 ||
        raw.sku.length > 40 ||
        raw.name.length === 0 ||
        raw.name.length > 300 ||
        itemUrlPath.length === 0 ||
        itemUrlPath.length > 500
      ) {
        skipped++;
        skippedItems.push({
          productId: raw.productId.slice(0, 40),
          reason: "INVALID_ITEM",
        });
        continue;
      }
      if (
        raw.units !== undefined &&
        (!Number.isInteger(raw.units) || raw.units < 0 || raw.units > 10_000)
      ) {
        skipped++;
        skippedItems.push({ productId: raw.productId, reason: "INVALID_UNITS" });
        continue;
      }
      // An open-box price is a used unit's price, so it has to undercut the new
      // one — that is what keeps a member price, a bundle total or a financing
      // figure out of the field. A price arriving WITHOUT the seen flag is not
      // clamped, it is refused: the payload is incoherent, and the safe reading
      // of an incoherent payload is no reading.
      if (
        raw.openBoxPrice !== undefined &&
        (raw.openBoxSeen !== true ||
          !Number.isFinite(raw.openBoxPrice) ||
          raw.openBoxPrice <= 0 ||
          raw.openBoxPrice >= raw.price)
      ) {
        skipped++;
        skippedItems.push({ productId: raw.productId, reason: "INVALID_OPEN_BOX" });
        continue;
      }
      // A count with no price beside it cannot have come from the one string
      // that carries either ("2 open box from $339.96"), so it is refused for
      // the same reason.
      if (
        raw.openBoxUnits !== undefined &&
        (raw.openBoxPrice === undefined ||
          !Number.isInteger(raw.openBoxUnits) ||
          raw.openBoxUnits <= 0 ||
          raw.openBoxUnits > 1_000)
      ) {
        skipped++;
        skippedItems.push({
          productId: raw.productId,
          reason: "INVALID_OPEN_BOX_UNITS",
        });
        continue;
      }
      // A list price is the figure the shelf price is discounted FROM, so it
      // has to exceed it — the mirror of open box, and the same refusal for a
      // price arriving without its flag. `>` and not `>=`: a strike equal to the
      // price is not a discount, it is a misread of the price itself. The upper
      // bound catches the strike that swallowed a neighbouring figure.
      if (
        raw.listPrice !== undefined &&
        (raw.listSeen !== true ||
          !Number.isFinite(raw.listPrice) ||
          raw.listPrice <= raw.price ||
          raw.listPrice > raw.price * CATALOG_MAX_LIST_RATIO)
      ) {
        skipped++;
        skippedItems.push({ productId: raw.productId, reason: "INVALID_LIST_PRICE" });
        continue;
      }

      const name = raw.name.slice(0, 300);
      // Already the printed six-digit form on this path; normalized anyway so
      // both paths run the same function and neither can drift.
      const sku = normalizeSku(raw.sku);
      const brand = raw.brand !== undefined ? sanitize(raw.brand).slice(0, 100) : undefined;
      const category =
        raw.category !== undefined ? sanitize(raw.category).slice(0, 200) : undefined;

      // --- product upsert -------------------------------------------------
      const existing = await ctx.db
        .query("products")
        .withIndex("by_productId", (q) => q.eq("productId", raw.productId))
        .unique();
      let productDocId: Id<"products">;
      if (existing === null) {
        productDocId = await ctx.db.insert("products", {
          productId: raw.productId,
          sku,
          name,
          brand,
          category,
          categoryKey: categoryKey(category) ?? undefined,
          condition: conditionFromName(name),
          urlPath: itemUrlPath,
        });
        newProducts++;
      } else {
        productDocId = existing._id;
        // See the twin in `report` for why the value type admits `undefined`.
        const patch: Record<string, string | undefined> = {};
        if (existing.sku !== sku) patch.sku = sku;
        if (existing.name !== name) {
          patch.name = name;
          const nextCondition = conditionFromName(name);
          if (existing.condition !== nextCondition) patch.condition = nextCondition;
        }
        if (existing.urlPath !== itemUrlPath) patch.urlPath = itemUrlPath;
        if (brand !== undefined && existing.brand !== brand) patch.brand = brand;
        if (category !== undefined && existing.category !== category) {
          patch.category = category;
          const nextKey = categoryKey(category);
          if (nextKey !== null) patch.categoryKey = nextKey;
        }
        // mpn and ean are deliberately absent from the item shape: a grid card
        // does not carry them, and a patch that set them to undefined would
        // erase what a product-page visit already learned.
        if (Object.keys(patch).length > 0) await ctx.db.patch(existing._id, patch);
      }

      // --- price point ----------------------------------------------------
      const latest = await ctx.db
        .query("pricePoints")
        .withIndex("by_product_store", (q) =>
          q.eq("productDocId", productDocId).eq("storeNum", storeNum),
        )
        .order("desc")
        .first();

      if (
        latest !== null &&
        (raw.price < latest.price * PRICE_MIN_RATIO ||
          raw.price > latest.price * PRICE_MAX_RATIO)
      ) {
        skipped++;
        skippedItems.push({ productId: raw.productId, reason: "PRICE_OUTLIER" });
        continue;
      }

      // What this card says about open box, if anything. The carry-forward is
      // now conditional: a card that could read `.clearance` speaks for this
      // store and its silence means "none here", while a card that could not
      // inherits the last row and asserts nothing. Note what falls out of it —
      // when the field was NOT observed, `openBoxPrice` equals `latest`'s by
      // construction, so `openBoxSame` below is necessarily true and a
      // non-observation can never be the thing that opens a new row. The
      // manufactured-disappearance failure is unreachable rather than merely
      // avoided.
      const openBoxPrice = raw.openBoxSeen === true ? raw.openBoxPrice : latest?.openBoxPrice;

      // Same test as the product-page path: same when both absent or within a
      // cent. It has to be part of the dedupe or an open-box unit arriving,
      // repricing or selling at an unchanged shelf price would never open a
      // row — invisible in the series, and invisible to the open-box trigger,
      // which reads consecutive rows.
      const openBoxSame =
        latest !== null &&
        (latest.openBoxPrice === undefined
          ? openBoxPrice === undefined
          : openBoxPrice !== undefined &&
            Math.abs(latest.openBoxPrice - openBoxPrice) <= 0.01);

      // The list price rides on the same three states and the same inversion,
      // for the same reason: only a card that could see the discount line may
      // say there isn't one. `listSeen` is set from the card's `.price` block
      // rather than from the discount div, because that div is ABSENT when the
      // discount is — see the item validator.
      const listPrice = raw.listSeen === true ? raw.listPrice : latest?.listPrice;

      // And it has to join the dedupe test for a reason the open-box comment
      // states generally but which bites harder here: a promotion's list price
      // moves while the shelf price sits still (an "Original price" appearing,
      // changing, or ending). Without this the patch branch would win, and the
      // patch branch writes neither field — so the new figure would be dropped
      // and the stored one left stale for as long as the price held.
      const listSame =
        latest !== null &&
        (latest.listPrice === undefined
          ? listPrice === undefined
          : listPrice !== undefined && Math.abs(latest.listPrice - listPrice) <= 0.01);

      // A re-sighting carries the row's reportCount past one, which is exactly
      // the read path's corroboration test — so the price this row has been
      // holding is now allowed to name a record, even though both sightings
      // came off grid cards. A first sighting widens the ANY pair only.
      let corroborated: boolean;
      if (
        latest !== null &&
        latest.price === raw.price &&
        latest.inStock === raw.inStock &&
        openBoxSame &&
        listSame
      ) {
        await ctx.db.patch(latest._id, {
          lastSeenAt: now,
          reportCount: latest.reportCount + 1,
        });
        corroborated = true;
      } else {
        // `availability` is still carried unconditionally — no grid card shows
        // it, so the batch has no key for it and the old rule stands untouched.
        await ctx.db.insert("pricePoints", {
          productDocId,
          storeNum,
          price: raw.price,
          inStock: raw.inStock,
          availability: latest?.availability,
          openBoxPrice,
          listPrice,
          firstSeenAt: now,
          lastSeenAt: now,
          reportCount: 1,
          source: "catalog",
        });
        newPricePoints++;
        corroborated = false;
      }

      // Same widening as the product-page path, with the corroboration verdict
      // the two branches above just established.
      const widen = widenSummary(existing ?? {}, raw.price, now, corroborated);
      if (widen !== null) await ctx.db.patch(productDocId, widen);

      // --- shelf state (current only, never appended) -----------------------
      // Skipped entirely for a pseudo-store — see `hasShelves` above. Not a
      // "skip" in the sense the `skipped` counter reports: the item itself was
      // accepted and its price recorded, and there is nothing here to tell the
      // caller about. A store with no shelves simply has no shelf state.
      if (hasShelves) {
        const shelf = await ctx.db
          .query("storeStock")
          .withIndex("by_product_store", (q) =>
            q.eq("productDocId", productDocId).eq("storeNum", storeNum),
          )
          .unique();
        const shelfRow = {
          inStock: raw.inStock,
          units: raw.units,
          atLeast: raw.atLeast === true ? true : undefined,
          // Replaced like every other field here, NOT carried like the price
          // above, and the difference is what the two numbers cost when wrong.
          // The row is a snapshot under one `observedAt`; holding a count from
          // an earlier reading while stamping it `now` would make it lie about
          // its own age, which is the one thing this table is not allowed to
          // do. Nothing alerts on a count and nothing accumulates it, so an
          // unobserved one costs a missing figure until the next legible card —
          // whereas an unobserved open-box PRICE, cleared, fires every watcher.
          openBoxUnits: raw.openBoxUnits,
          observedAt: now,
        };
        if (shelf === null) {
          await ctx.db.insert("storeStock", { productDocId, storeNum, ...shelfRow });
        } else {
          // replace, not merge: this row is a snapshot, and a shelf that no
          // longer shows a number must not keep yesterday's.
          await ctx.db.patch(shelf._id, shelfRow);
        }
      }

      accepted++;
      acceptedProductIds.push(raw.productId);
      const catKey = categoryKey(category);
      if (catKey !== null) perCategory.set(catKey, (perCategory.get(catKey) ?? 0) + 1);
    }

    if (accepted > 0) {
      await bump(ctx, "obs:total", accepted);
      await bump(ctx, `obs:store:${storeNum}`, accepted);
      await bump(ctx, `obs:day:${utcDay(now)}`, accepted);
      // The catalog share of the total. Kept separate because the two are not
      // interchangeable evidence: a product-page observation is one person on
      // one product, a catalog observation is one person on a page of them.
      await bump(ctx, "obs:catalog", accepted);
      await bump(ctx, "obs:batches");
      // …and the same split per day, so the trend chart can show the mix
      // instead of one bar whose composition changes silently with how people
      // happen to browse. Deliberately NOT named `obs:cat*`: `dashboard.ts`
      // enumerates categories with a prefix range over "obs:cat:", and a key
      // one separator away from a scanned namespace is the kind of near-miss
      // that turns into a phantom category bar years later.
      await bump(ctx, `obs:gridday:${utcDay(now)}`, accepted);
      // Seed-once marker: the UTC midnight of the first day this split
      // existed. Every earlier day in the series has a zero grid counter
      // because nothing was writing one, which is indistinguishable from a
      // real zero — so the panel needs to know where the record starts and
      // draws those days undifferentiated rather than crediting them all to
      // product pages. Never clobbered; `initCounter` is the whole point.
      await initCounter(ctx, "obs:gridday:from", Math.floor(now / 86_400_000) * 86_400_000);
      for (const [key, n] of perCategory) await bump(ctx, `obs:cat:${key}`, n);
      if (newProducts > 0) await bump(ctx, "products:total", newProducts);
      if (newPricePoints > 0) await bump(ctx, "pricepoints:total", newPricePoints);
    }

    // Outside the `accepted > 0` guard on purpose: a batch that accepted
    // nothing is the batch whose health numbers matter most.
    const selectorsOk = await recordSelectorHealth(
      ctx,
      args.selectors,
      CATALOG_MAX_ITEMS,
      now,
    );

    return {
      ok: true,
      accepted,
      skipped,
      acceptedProductIds,
      skippedItems,
      throttled: false,
      rateLimited: false,
      selectorsRejected: !selectorsOk,
      reason: null,
    };
  },
});
