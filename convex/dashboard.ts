import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  checkAdminRateLimit,
  enforceAdminRateLimit,
  flaggedComments,
  readCounter,
  requireAdmin,
  resolveCommentReport,
  utcDay,
} from "./lib";

// Public surface for the owner-only web panel at jackdaws.app/admin.html.
// These are `query`/`mutation` (not internal) because a static page calls them
// over the plain HTTP API; the shared ADMIN_KEY is the only thing standing
// between them and the internet, so every handler gates on requireAdmin before
// touching a row.

const DAY_MS = 86_400_000;
const DAILY_DAYS = 30;
const MAX_STORES = 25;
// Prefix-range ceiling: "~" (0x7e) sorts above every character a store number
// can contain, so this scan is bounded to the obs:store: namespace.
const STORE_PREFIX = "obs:store:";
const STORE_PREFIX_END = "obs:store:~";

export const stats = query({
  args: { adminKey: v.string() },
  returns: v.object({
    totals: v.object({
      observations: v.number(),
      pricePoints: v.number(),
      products: v.number(),
      comments: v.number(),
      commentsHidden: v.number(),
      reports: v.number(),
      alertsArmed: v.number(),
      alertsFired: v.number(),
      devices: v.number(),
    }),
    stores: v.array(
      v.object({ storeNum: v.string(), observations: v.number() }),
    ),
    daily: v.array(
      v.object({
        date: v.string(),
        observations: v.number(),
        comments: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    await checkAdminRateLimit(ctx);
    requireAdmin(args.adminKey);

    // Every number below is a counter maintained on write. Nothing here scans
    // a growing table, so the panel costs the same at 1k rows and at 10M.
    const [
      observations,
      pricePoints,
      products,
      comments,
      commentsHidden,
      reports,
      alertsArmed,
      alertsFired,
      devices,
    ] = await Promise.all([
      readCounter(ctx, "obs:total"),
      readCounter(ctx, "pricepoints:total"),
      readCounter(ctx, "products:total"),
      readCounter(ctx, "comments:total"),
      readCounter(ctx, "comments:hidden"),
      readCounter(ctx, "reports:total"),
      readCounter(ctx, "alerts:armed"),
      readCounter(ctx, "alerts:fired"),
      readCounter(ctx, "devices:total"),
    ]);

    // Bounded indexed range over one key namespace — not a table scan.
    const storeRows = await ctx.db
      .query("counters")
      .withIndex("by_key", (q) =>
        q.gte("key", STORE_PREFIX).lt("key", STORE_PREFIX_END),
      )
      .take(200);
    const stores = storeRows
      .map((row) => ({
        storeNum: row.key.slice(STORE_PREFIX.length),
        observations: row.value,
      }))
      .sort((a, b) => b.observations - a.observations)
      .slice(0, MAX_STORES);

    // Explicit key list for the window, oldest first, missing days as 0 — so
    // the chart has a continuous x-axis without a scan over day keys.
    const todayUtc = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const daily = await Promise.all(
      Array.from({ length: DAILY_DAYS }, async (_unused, i) => {
        const date = utcDay(todayUtc - (DAILY_DAYS - 1 - i) * DAY_MS);
        const [dayObs, dayComments] = await Promise.all([
          readCounter(ctx, `obs:day:${date}`),
          readCounter(ctx, `comments:day:${date}`),
        ]);
        return { date, observations: dayObs, comments: dayComments };
      }),
    );

    return {
      totals: {
        observations,
        pricePoints,
        products,
        comments,
        commentsHidden,
        reports,
        alertsArmed,
        alertsFired,
        devices,
      },
      stores,
      daily,
    };
  },
});

export const flagged = query({
  args: { adminKey: v.string() },
  returns: v.array(
    v.object({
      _id: v.id("comments"),
      _creationTime: v.number(),
      productId: v.union(v.string(), v.null()),
      displayName: v.string(),
      body: v.string(),
      reportCount: v.number(),
      hidden: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    await checkAdminRateLimit(ctx);
    requireAdmin(args.adminKey);

    const rows = await flaggedComments(ctx);
    return await Promise.all(
      rows.map(async (c) => {
        // Resolved to the Micro Center productId so the panel can link out;
        // null when the product row is gone rather than dropping the report.
        const product = await ctx.db.get(c.productDocId);
        return {
          _id: c._id,
          _creationTime: c._creationTime,
          productId: product === null ? null : product.productId,
          displayName: c.displayName,
          body: c.body,
          reportCount: c.reportCount ?? 0,
          hidden: c.hidden === true,
        };
      }),
    );
  },
});

/**
 * Same implementation as `moderation:resolve` (both call resolveCommentReport),
 * reachable with the admin key instead of a CLI session.
 */
export const resolve = mutation({
  args: {
    adminKey: v.string(),
    commentId: v.id("comments"),
    action: v.union(v.literal("unhide"), v.literal("delete")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Rate limit first, so a wrong key still costs a token.
    await enforceAdminRateLimit(ctx);
    requireAdmin(args.adminKey);

    await resolveCommentReport(ctx, args.commentId, args.action);
    return null;
  },
});
