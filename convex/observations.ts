import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { requireLength, sanitize } from "./lib";

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
  returns: v.object({ ok: v.boolean(), throttled: v.boolean() }),
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
    const sku = requireLength("sku", args.sku, 1, 40);
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
      return { ok: true, throttled: true };
    }
    if (device === null) {
      await ctx.db.insert("devices", {
        deviceId,
        lastReportKey: reportKey,
        lastReportAt: now,
      });
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
        mpn,
        ean,
        urlPath,
      });
    } else {
      productDocId = existing._id;
      const patch: Record<string, string> = {};
      if (existing.sku !== sku) patch.sku = sku;
      if (existing.name !== name) patch.name = name;
      if (existing.urlPath !== urlPath) patch.urlPath = urlPath;
      if (brand !== undefined && existing.brand !== brand) patch.brand = brand;
      if (category !== undefined && existing.category !== category)
        patch.category = category;
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
    }

    return { ok: true, throttled: false };
  },
});
