import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  bump,
  categoryKey,
  initCounter,
  normalizeSku,
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
  },
  // `rateLimited` refuses the write in-band instead of throwing, which is what
  // makes the abuse counter below possible. Safe here because the only caller
  // discards the result (content.js fires `send({type:"report"})` without
  // awaiting it); anything the UI shows an error for must keep throwing.
  returns: v.object({
    ok: v.boolean(),
    throttled: v.boolean(),
    rateLimited: v.boolean(),
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
    const urlPath = requireLength("urlPath", args.urlPath, 1, 500);
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
      return { ok: true, throttled: true, rateLimited: false };
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
      return { ok: false, throttled: false, rateLimited: true };
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
    const existing = await ctx.db
      .query("products")
      .withIndex("by_productId", (q) => q.eq("productId", productId))
      .unique();
    let productDocId;
    if (existing === null) {
      productDocId = await ctx.db.insert("products", {
        productId,
        sku,
        name,
        brand,
        category,
        categoryKey: categoryKey(category) ?? undefined,
        mpn,
        ean,
        urlPath,
      });
      await bump(ctx, "products:total");
    } else {
      productDocId = existing._id;
      const patch: Record<string, string> = {};
      if (existing.sku !== sku) patch.sku = sku;
      if (existing.name !== name) patch.name = name;
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

    // Open-box prices are the "same" when both absent or within $0.01.
    const openBoxSame =
      latest !== null &&
      (latest.openBoxPrice === undefined
        ? args.openBoxPrice === undefined
        : args.openBoxPrice !== undefined &&
          Math.abs(latest.openBoxPrice - args.openBoxPrice) <= 0.01);

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
        openBoxPrice: args.openBoxPrice,
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
    // Category mix, for the partnership pitch. Keyed off the normalized
    // category so "Solid State Drives" and "solid state drives" are one row.
    const catKey = categoryKey(category);
    if (catKey !== null) await bump(ctx, `obs:cat:${catKey}`);

    return { ok: true, throttled: false, rateLimited: false };
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

// A catalog price more than 5x, or less than a fifth of, the last price known
// for that (product, store) is refused. Both directions are far likelier to be
// a misread than a real move: a grid card sits next to a member price, a
// financing figure and a bundle total, and any of those landing in `price`
// would otherwise write a fake all-time low that a watch then fires on. A
// genuine clearance that deep still lands the moment anyone opens the product
// page, which is the higher-fidelity source; a parse error never gets to
// impersonate one. Skipped items are counted and returned, never silent.
const CATALOG_MIN_RATIO = 0.2;
const CATALOG_MAX_RATIO = 5;

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
        brand: v.optional(v.string()),
        category: v.optional(v.string()),
      }),
    ),
  },
  // Refused in band for the same reason `report` is: the caller discards the
  // result, so a refusal can be counted instead of rolling itself back. The
  // per-item outcome is returned as counts because there is nothing useful a
  // content script could do with a list of which cards were skipped, and a
  // list would be a much larger response to no purpose.
  returns: v.object({
    ok: v.boolean(),
    accepted: v.number(),
    skipped: v.number(),
    throttled: v.boolean(),
    rateLimited: v.boolean(),
    reason: v.union(v.literal("NO_STORE"), v.null()),
  }),
  handler: async (ctx, args) => {
    const nothing = {
      accepted: 0,
      skipped: args.items.length,
      throttled: false,
      rateLimited: false,
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
    if (args.items.length === 0) {
      return { ok: true, ...nothing, skipped: 0, reason: null };
    }

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
        raw.urlPath.length === 0 ||
        raw.urlPath.length > 500
      ) {
        skipped++;
        continue;
      }
      if (
        raw.units !== undefined &&
        (!Number.isInteger(raw.units) || raw.units < 0 || raw.units > 10_000)
      ) {
        skipped++;
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
          urlPath: raw.urlPath,
        });
        newProducts++;
      } else {
        productDocId = existing._id;
        const patch: Record<string, string> = {};
        if (existing.sku !== sku) patch.sku = sku;
        if (existing.name !== name) patch.name = name;
        if (existing.urlPath !== raw.urlPath) patch.urlPath = raw.urlPath;
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
        (raw.price < latest.price * CATALOG_MIN_RATIO ||
          raw.price > latest.price * CATALOG_MAX_RATIO)
      ) {
        skipped++;
        continue;
      }

      // A re-sighting carries the row's reportCount past one, which is exactly
      // the read path's corroboration test — so the price this row has been
      // holding is now allowed to name a record, even though both sightings
      // came off grid cards. A first sighting widens the ANY pair only.
      let corroborated: boolean;
      if (latest !== null && latest.price === raw.price && latest.inStock === raw.inStock) {
        await ctx.db.patch(latest._id, {
          lastSeenAt: now,
          reportCount: latest.reportCount + 1,
        });
        corroborated = true;
      } else {
        // CARRY-FORWARD. openBoxPrice and availability are not observable from
        // a grid card, so the new row inherits whatever the last row held
        // rather than asserting their absence. Writing `undefined` here would
        // manufacture an open-box DISAPPEARANCE out of a non-observation, and
        // the next product-page visit would then read as an open-box arrival
        // and fire everyone's open-box alerts on a unit that never moved.
        await ctx.db.insert("pricePoints", {
          productDocId,
          storeNum,
          price: raw.price,
          inStock: raw.inStock,
          availability: latest?.availability,
          openBoxPrice: latest?.openBoxPrice,
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
        observedAt: now,
      };
      if (shelf === null) {
        await ctx.db.insert("storeStock", { productDocId, storeNum, ...shelfRow });
      } else {
        // replace, not merge: this row is a snapshot, and a shelf that no
        // longer shows a number must not keep yesterday's.
        await ctx.db.patch(shelf._id, shelfRow);
      }

      accepted++;
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

    return { ok: true, accepted, skipped, throttled: false, rateLimited: false, reason: null };
  },
});
