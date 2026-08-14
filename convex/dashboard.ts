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
const MAX_CATEGORIES = 12;
// Prefix-range ceiling: "~" (0x7e) sorts above every character a store number
// can contain, so this scan is bounded to the obs:store: namespace.
const STORE_PREFIX = "obs:store:";
const STORE_PREFIX_END = "obs:store:~";
// Categories are free text, so the ceiling is U+FFFF rather than "~".
const CATEGORY_PREFIX = "obs:cat:";
const CATEGORY_PREFIX_END = "obs:cat:￿";

// Aggregate watched value is a live sum, not a counter: a watch's target price
// changes in place, so an incremental tally would drift. Bounded instead.
const WATCH_SCAN_LIMIT = 1000;

// Data health sampling. The read budget is what sets these: a Convex function
// gets ~16k document reads, and health alone costs SAMPLE * (1 + POINTS).
// 200 * 51 = 10,200, plus ~1,500 for every other section of this query, leaves
// roughly 4k of headroom. 500 products at 50 points each would be 25,500 and
// would blow the limit outright, so the sample is smaller and `sampleSize` is
// returned to let the panel say "based on N products" honestly.
const HEALTH_SAMPLE = 200;
const HEALTH_POINTS_PER_PRODUCT = 50;
const CHART_WORTHY_MIN_POINTS = 5;
const STALE_AFTER_MS = 30 * DAY_MS;

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
      alertsClicked: v.number(),
      devices: v.number(),
    }),
    stores: v.array(
      v.object({ storeNum: v.string(), observations: v.number() }),
    ),
    categories: v.array(
      v.object({ category: v.string(), observations: v.number() }),
    ),
    watchedValue: v.number(),
    watchedValueTruncated: v.boolean(),
    health: v.object({
      chartWorthy: v.number(),
      thin: v.number(),
      stale: v.number(),
      sampleSize: v.number(),
    }),
    daily: v.array(
      v.object({
        date: v.string(),
        observations: v.number(),
        comments: v.number(),
        clicked: v.number(),
        rateLimited: v.number(),
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
      alertsClicked,
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
      readCounter(ctx, "alerts:clicked"),
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

    // Same bounded-prefix trick for the category mix.
    const categoryRows = await ctx.db
      .query("counters")
      .withIndex("by_key", (q) =>
        q.gte("key", CATEGORY_PREFIX).lt("key", CATEGORY_PREFIX_END),
      )
      .take(300);
    const categories = categoryRows
      .map((row) => ({
        category: row.key.slice(CATEGORY_PREFIX.length),
        observations: row.value,
      }))
      .sort((a, b) => b.observations - a.observations)
      .slice(0, MAX_CATEGORIES);

    // Live sum over active watches. `truncated` tells the panel the figure is
    // a floor rather than the whole picture, instead of quietly under-reporting.
    const activeWatches = await ctx.db
      .query("watches")
      .withIndex("by_active", (q) => q.eq("active", true))
      .take(WATCH_SCAN_LIMIT);
    let watchedValueRaw = 0;
    for (const watch of activeWatches) watchedValueRaw += watch.priceAtWatch;
    const watchedValue = Math.round(watchedValueRaw * 100) / 100;
    const watchedValueTruncated = activeWatches.length >= WATCH_SCAN_LIMIT;

    // Data health over a bounded sample. chartWorthy + thin === sampleSize;
    // `stale` is orthogonal to both (a product can be chart-worthy AND stale),
    // so the panel must not present these three as parts of a whole.
    const sample = await ctx.db
      .query("products")
      .withIndex("by_productId")
      .take(HEALTH_SAMPLE);
    const staleBefore = Date.now() - STALE_AFTER_MS;
    let chartWorthy = 0;
    let thin = 0;
    let stale = 0;
    for (const product of sample) {
      const points = await ctx.db
        .query("pricePoints")
        .withIndex("by_product", (q) => q.eq("productDocId", product._id))
        .order("desc")
        .take(HEALTH_POINTS_PER_PRODUCT);
      if (points.length >= CHART_WORTHY_MIN_POINTS) chartWorthy++;
      else thin++;
      // A repeat sighting patches lastSeenAt on an existing row rather than
      // adding one, so freshness is the newest lastSeenAt in the window, not
      // the newest row. Products with no points at all are counted thin but
      // not stale — never seen isn't the same as gone quiet.
      let newestSeen = 0;
      for (const point of points) {
        if (point.lastSeenAt > newestSeen) newestSeen = point.lastSeenAt;
      }
      if (points.length > 0 && newestSeen < staleBefore) stale++;
    }

    // Explicit key list for the window, oldest first, missing days as 0 — so
    // the chart has a continuous x-axis without a scan over day keys.
    const todayUtc = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const daily = await Promise.all(
      Array.from({ length: DAILY_DAYS }, async (_unused, i) => {
        const date = utcDay(todayUtc - (DAILY_DAYS - 1 - i) * DAY_MS);
        const [dayObs, dayComments, dayClicked, dayRateLimited] =
          await Promise.all([
            readCounter(ctx, `obs:day:${date}`),
            readCounter(ctx, `comments:day:${date}`),
            readCounter(ctx, `alerts:clicked:day:${date}`),
            readCounter(ctx, `abuse:ratelimited:day:${date}`),
          ]);
        return {
          date,
          observations: dayObs,
          comments: dayComments,
          clicked: dayClicked,
          rateLimited: dayRateLimited,
        };
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
        alertsClicked,
        devices,
      },
      stores,
      categories,
      watchedValue,
      watchedValueTruncated,
      health: { chartWorthy, thin, stale, sampleSize: sample.length },
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
    // Rate limit before the key check by intent, though the throw below rolls
    // the token back — see enforceAdminRateLimit's note.
    await enforceAdminRateLimit(ctx);
    requireAdmin(args.adminKey);

    await resolveCommentReport(ctx, args.commentId, args.action);
    return null;
  },
});
