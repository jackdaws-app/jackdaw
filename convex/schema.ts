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
    // Set when the device signs in (auth:verifyCode adopts the device's
    // existing watches) and on anything written while signed in, so a row is
    // account-linked from birth rather than at the next sign-in. Optional
    // forever: anonymous use is the default and keeps working untouched, and a
    // call with no session still reads and writes by deviceId alone. When a
    // session does resolve this field is the scope watches.ts reads by — a
    // second, wider handle on the same row, never a replacement for the first,
    // which is why auth:deleteAccount can clear it back off and leave the
    // device owning its watches exactly as before.
    accountId: v.optional(v.id("accounts")),
  })
    // Watches are soft-deactivated (toggle/ack set active:false rather than
    // deleting), so a device's row count grows without bound. Scoping the
    // read window to active rows keeps a long tail of dead watches from
    // pushing live ones out of check/dashboard's take(50).
    .index("by_device_active", ["deviceId", "active"])
    .index("by_device_product", ["deviceId", "productDocId"])
    // Deployment-wide active watches, for the admin panel's aggregate watched
    // value. Targets change, so that figure is a bounded live sum rather than
    // a counter.
    .index("by_active", ["active"])
    // Account-scoped reads: the delete-account unlink sweep, and the watchlist
    // a signed-in caller sees on every browser. Same active-first shape as
    // by_device_active, for the same reason.
    .index("by_account_active", ["accountId", "active"])
    // The account's row for one product, for the same reason by_device_product
    // exists one owner up: a signed-in write has to find the alert the person
    // already set on another browser, rather than minting a second row for a
    // product they are already watching.
    .index("by_account_product", ["accountId", "productDocId"]),

  devices: defineTable({
    deviceId: v.string(),
    lastReportKey: v.optional(v.string()),
    lastReportAt: v.optional(v.number()),
  }).index("by_deviceId", ["deviceId"]),

  // -------------------------------------------------------------------------
  // Optional accounts
  //
  // Identity in Jackdaw is the anonymous deviceId in browser storage, and it
  // stays that way: nothing below is required to use anything. An account
  // exists for exactly one reason — clearing browser data currently destroys a
  // person's alerts with no way back — so it is a durable handle that ADOPTS
  // what the device already has (auth:verifyCode), never a gate in front of it.
  //
  // The email address is the only personal data Jackdaw has ever stored, which
  // is why deleteAccount removes the row outright and merely unlinks the
  // watches: deleting the account must not cost an anonymous user the alerts
  // they had before they ever signed in.
  // -------------------------------------------------------------------------

  accounts: defineTable({
    // Lowercased and trimmed before both storage and lookup, so "A@b.com" and
    // "a@b.com " are one account rather than two.
    email: v.string(),
    createdAt: v.number(),
    lastLoginAt: v.number(),
  }).index("by_email", ["email"]),

  // A session is a bearer token: whoever holds it is the account. Only the
  // hash is ever stored, so a database dump is not a pile of live credentials —
  // the token itself is returned to the client exactly once, by verifyCode.
  sessions: defineTable({
    accountId: v.id("accounts"),
    tokenHash: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    lastUsedAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_account", ["accountId"]),

  // One live code per email (storeCode replaces rather than appends), hashed
  // the same way sessions are. `attempts` is what makes a 6-digit secret
  // defensible at all: the code dies after MAX_CODE_ATTEMPTS wrong guesses,
  // which is why auth:consumeCode returns its verdict in-band instead of
  // throwing — a throwing mutation would roll the increment back and hand an
  // attacker unlimited guesses at a one-in-a-million number.
  loginCodes: defineTable({
    email: v.string(),
    codeHash: v.string(),
    expiresAt: v.number(),
    attempts: v.number(),
    consumedAt: v.optional(v.number()),
    // DEVELOPMENT ONLY. Written by auth:sendCode solely when RESEND_API_KEY is
    // unset — i.e. when there is no mail provider to deliver the code and
    // `npx convex run auth:devPeekCode` is the only way to read it. A
    // deployment with mail configured never populates this field, so the
    // plaintext of a live code is never at rest in production.
    devCode: v.optional(v.string()),
  }).index("by_email", ["email"]),

  // Incremental metrics for the admin panel. Every number the dashboard shows
  // is maintained on write, because counting on demand (e.g. all pricePoints)
  // would blow the ~16k document read limit as history accumulates.
  //
  // Keys are namespaced and ordered so a prefix range read is possible:
  //   obs:total · obs:store:<storeNum> · obs:day:<YYYY-MM-DD>
  //   pricepoints:total · products:total · devices:total
  //   comments:total · comments:day:<YYYY-MM-DD> · comments:hidden
  //   reports:total · alerts:armed · alerts:fired
  //   evt:<name> · evt:<name>:day:<YYYY-MM-DD>
  //
  // The evt: namespace is client health telemetry. <name> is one of the six
  // fixed names in lib.ts's EVENT_NAMES and can only ever be one of those —
  // metrics:events validates against a closed union, so no caller can mint a
  // key here. Nothing in the namespace is derivable from the tables (an event
  // is a moment, not a row), so admin:backfillCounters leaves it alone.
  //
  // These are plain documents, so a single key is a contention point under
  // heavy concurrent writes. At Jackdaw's volume (one report per device per
  // product per minute) that's far from an issue; if "obs:total" ever starts
  // throwing OCC conflicts, move the hot keys to @convex-dev/sharded-counter.
  counters: defineTable({
    key: v.string(),
    value: v.number(),
  }).index("by_key", ["key"]),
});
