import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireLength } from "./lib";

// A drop must exceed this epsilon to notify (guards float noise).
const DROP_EPSILON = 0.009;

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

export const status = query({
  args: {
    deviceId: v.string(),
    productId: v.string(),
  },
  returns: v.object({ watching: v.boolean() }),
  handler: async (ctx, args) => {
    const product = await ctx.db
      .query("products")
      .withIndex("by_productId", (q) => q.eq("productId", args.productId))
      .unique();
    if (product === null) return { watching: false };

    const watch = await ctx.db
      .query("watches")
      .withIndex("by_device_product", (q) =>
        q.eq("deviceId", args.deviceId).eq("productDocId", product._id),
      )
      .first();
    return { watching: watch !== null && watch.active };
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
      if (latest.price >= watch.priceAtWatch - DROP_EPSILON) continue;

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
    if (watch !== null) {
      await ctx.db.patch(watch._id, { priceAtWatch: args.newPrice });
    }
    return null;
  },
});
