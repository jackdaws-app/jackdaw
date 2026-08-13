import { v } from "convex/values";
import { query } from "./_generated/server";

const pointValidator = v.object({
  storeNum: v.string(),
  price: v.number(),
  inStock: v.boolean(),
  availability: v.union(v.string(), v.null()),
  firstSeenAt: v.number(),
  lastSeenAt: v.number(),
  reportCount: v.number(),
});

export const history = query({
  args: {
    productId: v.string(),
    storeNum: v.optional(v.string()),
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
      }),
      points: v.array(pointValidator),
      stats: v.object({
        lowestPrice: v.union(v.number(), v.null()),
        highestPrice: v.union(v.number(), v.null()),
        currentPrice: v.union(v.number(), v.null()),
      }),
    }),
  ),
  handler: async (ctx, args) => {
    const product = await ctx.db
      .query("products")
      .withIndex("by_productId", (q) => q.eq("productId", args.productId))
      .unique();
    if (product === null) return null;

    const storeNum = args.storeNum;
    const rows =
      storeNum !== undefined
        ? await ctx.db
            .query("pricePoints")
            .withIndex("by_product_store", (q) =>
              q.eq("productDocId", product._id).eq("storeNum", storeNum),
            )
            .order("asc")
            .take(1000)
        : await ctx.db
            .query("pricePoints")
            .withIndex("by_product", (q) => q.eq("productDocId", product._id))
            .order("asc")
            .take(1000);

    const points = rows.map((r) => ({
      storeNum: r.storeNum,
      price: r.price,
      inStock: r.inStock,
      availability: r.availability ?? null,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
      reportCount: r.reportCount,
    }));

    let lowestPrice: number | null = null;
    let highestPrice: number | null = null;
    let currentPrice: number | null = null;
    let currentLastSeen = -1;
    for (const p of points) {
      if (lowestPrice === null || p.price < lowestPrice) lowestPrice = p.price;
      if (highestPrice === null || p.price > highestPrice) highestPrice = p.price;
      if (p.lastSeenAt > currentLastSeen) {
        currentLastSeen = p.lastSeenAt;
        currentPrice = p.price;
      }
    }

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
      },
      points,
      stats: { lowestPrice, highestPrice, currentPrice },
    };
  },
});
