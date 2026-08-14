import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  products: defineTable({
    productId: v.string(),
    sku: v.string(),
    name: v.string(),
    brand: v.optional(v.string()),
    category: v.optional(v.string()),
    mpn: v.optional(v.string()),
    ean: v.optional(v.string()),
    urlPath: v.string(),
  }).index("by_productId", ["productId"]),

  pricePoints: defineTable({
    productDocId: v.id("products"),
    storeNum: v.string(),
    price: v.number(),
    inStock: v.boolean(),
    availability: v.optional(v.string()),
    openBoxPrice: v.optional(v.number()),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
    reportCount: v.number(),
  })
    .index("by_product", ["productDocId"])
    .index("by_product_store", ["productDocId", "storeNum"]),

  comments: defineTable({
    productDocId: v.id("products"),
    deviceId: v.string(),
    displayName: v.string(),
    body: v.string(),
    score: v.number(),
    voteCount: v.number(),
    parentId: v.optional(v.id("comments")),
    hidden: v.optional(v.boolean()),
    reportCount: v.optional(v.number()),
  })
    .index("by_product", ["productDocId"])
    .index("by_parent", ["parentId"])
    .index("by_reportCount", ["reportCount"]),

  reports: defineTable({
    commentId: v.id("comments"),
    deviceId: v.string(),
  })
    .index("by_comment_device", ["commentId", "deviceId"])
    .index("by_comment", ["commentId"]),

  votes: defineTable({
    commentId: v.id("comments"),
    deviceId: v.string(),
    value: v.union(v.literal(1), v.literal(-1)),
  })
    .index("by_comment_device", ["commentId", "deviceId"])
    .index("by_comment", ["commentId"]),

  watches: defineTable({
    deviceId: v.string(),
    productDocId: v.id("products"),
    priceAtWatch: v.number(),
    active: v.boolean(),
  })
    // Watches are soft-deactivated (toggle/ack set active:false rather than
    // deleting), so a device's row count grows without bound. Scoping the
    // read window to active rows keeps a long tail of dead watches from
    // pushing live ones out of check/dashboard's take(50).
    .index("by_device_active", ["deviceId", "active"])
    .index("by_device_product", ["deviceId", "productDocId"]),

  devices: defineTable({
    deviceId: v.string(),
    lastReportKey: v.optional(v.string()),
    lastReportAt: v.optional(v.number()),
  }).index("by_deviceId", ["deviceId"]),
});
