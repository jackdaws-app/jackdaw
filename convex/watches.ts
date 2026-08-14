import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireLength } from "./lib";

// Epsilon guarding float noise: fire when current <= target + 0.009.
const DROP_EPSILON = 0.009;

// Dashboard bounds. A device is capped at 50 watches, and Convex allows
// ~16k document reads per function — so the per-product history scan is
// budgeted rather than a flat 500, or a full watch list would blow the
// limit once history accumulates.
const POINT_BUDGET = 12_000;
const MAX_POINTS_PER_PRODUCT = 500;
const MIN_POINTS_PER_PRODUCT = 60;
const MAX_TREND_POINTS = 24;

/** Evenly sample `values` down to at most `max`, keeping first and last. */
function downsample(values: number[], max: number): number[] {
  if (values.length <= max) return values;
  const step = (values.length - 1) / (max - 1);
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(values[Math.round(i * step)]);
  return out;
}

export const toggle = mutation({
  args: {
    deviceId: v.string(),
    productId: v.string(),
  },
  returns: v.object({ watching: v.boolean() }),
  handler: async (ctx, args) => {
    const deviceId = requireLength("deviceId", args.deviceId, 1, 100);

    const product = await ctx.db
      .query("products")
      .withIndex("by_productId", (q) => q.eq("productId", args.productId))
      .unique();
    if (product === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "unknown product" });
    }

    const existing = await ctx.db
      .query("watches")
      .withIndex("by_device_product", (q) =>
        q.eq("deviceId", deviceId).eq("productDocId", product._id),
      )
      .first();

    if (existing !== null && existing.active) {
      await ctx.db.patch(existing._id, { active: false });
      return { watching: false };
    }

    // Latest price across stores (most recent pricePoint by creation time).
    const latest = await ctx.db
      .query("pricePoints")
      .withIndex("by_product", (q) => q.eq("productDocId", product._id))
      .order("desc")
      .first();
    const priceAtWatch = latest === null ? 0 : latest.price;

    if (existing !== null) {
      await ctx.db.patch(existing._id, { active: true, priceAtWatch });
    } else {
      await ctx.db.insert("watches", {
        deviceId,
        productDocId: product._id,
        priceAtWatch,
        active: true,
      });
    }
    return { watching: true };
  },
});

export const setTarget = mutation({
  args: {
    deviceId: v.string(),
    productId: v.string(),
    targetPrice: v.number(),
  },
  returns: v.object({ watching: v.literal(true), target: v.number() }),
  handler: async (ctx, args) => {
    if (
      !Number.isFinite(args.targetPrice) ||
      args.targetPrice <= 0 ||
      args.targetPrice >= 100_000
    ) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "targetPrice must be a finite number between 0 and 100000",
      });
    }
    const deviceId = requireLength("deviceId", args.deviceId, 1, 100);

    const product = await ctx.db
      .query("products")
      .withIndex("by_productId", (q) => q.eq("productId", args.productId))
      .unique();
    if (product === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "unknown product" });
    }

    const existing = await ctx.db
      .query("watches")
      .withIndex("by_device_product", (q) =>
        q.eq("deviceId", deviceId).eq("productDocId", product._id),
      )
      .first();

    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        priceAtWatch: args.targetPrice,
        active: true,
      });
    } else {
      await ctx.db.insert("watches", {
        deviceId,
        productDocId: product._id,
        priceAtWatch: args.targetPrice,
        active: true,
      });
    }
    return { watching: true as const, target: args.targetPrice };
  },
});

export const status = query({
  args: {
    deviceId: v.string(),
    productId: v.string(),
  },
  returns: v.object({
    watching: v.boolean(),
    target: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    const product = await ctx.db
      .query("products")
      .withIndex("by_productId", (q) => q.eq("productId", args.productId))
      .unique();
    if (product === null) return { watching: false, target: null };

    const watch = await ctx.db
      .query("watches")
      .withIndex("by_device_product", (q) =>
        q.eq("deviceId", args.deviceId).eq("productDocId", product._id),
      )
      .first();
    const watching = watch !== null && watch.active;
    return { watching, target: watching ? watch.priceAtWatch : null };
  },
});

export const check = query({
  args: {
    deviceId: v.string(),
  },
  returns: v.array(
    v.object({
      productId: v.string(),
      name: v.string(),
      urlPath: v.string(),
      priceAtWatch: v.number(),
      currentPrice: v.number(),
      storeNum: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const watches = await ctx.db
      .query("watches")
      .withIndex("by_device", (q) => q.eq("deviceId", args.deviceId))
      .take(50);

    const drops: {
      productId: string;
      name: string;
      urlPath: string;
      priceAtWatch: number;
      currentPrice: number;
      storeNum: string;
    }[] = [];

    for (const watch of watches) {
      if (!watch.active) continue;
      const latest = await ctx.db
        .query("pricePoints")
        .withIndex("by_product", (q) => q.eq("productDocId", watch.productDocId))
        .order("desc")
        .first();
      if (latest === null) continue;
      // Fire when current <= target + epsilon (at-or-below the chosen target).
      if (latest.price > watch.priceAtWatch + DROP_EPSILON) continue;

      const product = await ctx.db.get(watch.productDocId);
      if (product === null) continue;

      drops.push({
        productId: product.productId,
        name: product.name,
        urlPath: product.urlPath,
        priceAtWatch: watch.priceAtWatch,
        currentPrice: latest.price,
        storeNum: latest.storeNum,
      });
    }
    return drops;
  },
});

const dashboardRowValidator = v.object({
  productId: v.string(),
  name: v.string(),
  urlPath: v.string(),
  storeNum: v.string(),
  target: v.number(),
  currentPrice: v.number(),
  inStock: v.boolean(),
  lowest: v.number(),
  trend: v.array(v.number()),
  met: v.boolean(),
});

type DashboardRow = {
  productId: string;
  name: string;
  urlPath: string;
  storeNum: string;
  target: number;
  currentPrice: number;
  inStock: boolean;
  lowest: number;
  trend: number[];
  met: boolean;
};

/**
 * Everything the toolbar popup needs for one device, in one round trip:
 * every active watch with its target, current price, all-time low, and a
 * downsampled series for a mini sparkline. Met alerts sort first, then the
 * watches closest to their target.
 */
export const dashboard = query({
  args: {
    deviceId: v.string(),
  },
  returns: v.array(dashboardRowValidator),
  handler: async (ctx, args) => {
    const watches = await ctx.db
      .query("watches")
      .withIndex("by_device", (q) => q.eq("deviceId", args.deviceId))
      .take(50);

    const active = watches.filter((w) => w.active);
    if (active.length === 0) return [];

    const perProduct = Math.min(
      MAX_POINTS_PER_PRODUCT,
      Math.max(
        MIN_POINTS_PER_PRODUCT,
        Math.floor(POINT_BUDGET / active.length),
      ),
    );

    const rows: DashboardRow[] = [];

    for (const watch of active) {
      const product = await ctx.db.get(watch.productDocId);
      if (product === null) continue;

      // Newest-first, so currentPrice / lowest / trend all describe the same
      // window (an oldest-first scan could report a "lowest" above the
      // current price once a product exceeds the cap). Reversed below for a
      // chronological sparkline.
      const recent = await ctx.db
        .query("pricePoints")
        .withIndex("by_product", (q) => q.eq("productDocId", watch.productDocId))
        .order("desc")
        .take(perProduct);

      const latest = recent.length > 0 ? recent[0] : null;
      const currentPrice = latest === null ? 0 : latest.price;

      let lowestSoFar: number | null = null;
      for (const p of recent) {
        if (lowestSoFar === null || p.price < lowestSoFar) lowestSoFar = p.price;
      }

      const chronological = recent
        .slice()
        .reverse()
        .map((p) => p.price);

      rows.push({
        productId: product.productId,
        name: product.name,
        urlPath: product.urlPath,
        storeNum: latest === null ? "000" : latest.storeNum,
        target: watch.priceAtWatch,
        currentPrice,
        inStock: latest === null ? false : latest.inStock,
        lowest: lowestSoFar ?? 0,
        trend: downsample(chronological, MAX_TREND_POINTS),
        met: currentPrice > 0 && currentPrice <= watch.priceAtWatch + DROP_EPSILON,
      });
    }

    rows.sort((a, b) => {
      // Met alerts first.
      if (a.met !== b.met) return a.met ? -1 : 1;
      // Then anything with a known price, closest-to-target first; watches
      // with no price data yet sink to the bottom rather than sorting as if
      // they were the biggest bargain.
      const aKnown = a.currentPrice > 0;
      const bKnown = b.currentPrice > 0;
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return a.currentPrice - a.target - (b.currentPrice - b.target);
    });

    return rows;
  },
});

export const ack = mutation({
  args: {
    deviceId: v.string(),
    productId: v.string(),
    newPrice: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (
      !Number.isFinite(args.newPrice) ||
      args.newPrice < 0 ||
      args.newPrice >= 100_000
    ) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "newPrice must be a finite number between 0 and 100000",
      });
    }
    const deviceId = requireLength("deviceId", args.deviceId, 1, 100);

    const product = await ctx.db
      .query("products")
      .withIndex("by_productId", (q) => q.eq("productId", args.productId))
      .unique();
    if (product === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "unknown product" });
    }

    const watch = await ctx.db
      .query("watches")
      .withIndex("by_device_product", (q) =>
        q.eq("deviceId", deviceId).eq("productDocId", product._id),
      )
      .first();
    // One-shot alert: acknowledging turns the watch off, preserving the
    // user's chosen target. Re-arm via setTarget/toggle. `newPrice` is
    // accepted (and validated) only for wire compatibility.
    if (watch !== null) {
      await ctx.db.patch(watch._id, { active: false });
    }
    return null;
  },
});
