import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  ADMIN_ARGS,
  EVENT_NAMES,
  SELECTOR_NAMES,
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
// over the plain HTTP API, so a credential is the only thing standing between
// them and the internet and every handler awaits requireAdmin before touching a
// row. Which credential is requireAdmin's business, not this file's: it takes
// either an admin account's session token or the legacy shared key, both spread
// in as ADMIN_ARGS so no handler here can accidentally accept a narrower or
// wider set than the gate reads.

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

// Client error window. Six names × seven days is 42 point reads, cheap enough
// to sit alongside the health sample — and point reads specifically, not a
// prefix range: a range over "evt:" would also sweep every day key ever
// written, which grows without bound while this window does not.
const ERROR_DAYS = 7;

export const stats = query({
  args: ADMIN_ARGS,
  returns: v.object({
    totals: v.object({
      observations: v.number(),
      // The catalog share of `observations`, so the panel can state the unit
      // instead of implying a uniform one. A product-page sighting is one
      // person on one product; a catalog sighting is one card on a page of up
      // to 96, so an undifferentiated total is dominated by page size and says
      // more about results-per-page than about reach.
      observationsCatalog: v.number(),
      catalogBatches: v.number(),
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
        // Both sighting kinds. `grid` is the catalog share OF `observations`,
        // not a sibling total — the product-page share is the difference.
        observations: v.number(),
        grid: v.number(),
        comments: v.number(),
        clicked: v.number(),
        rateLimited: v.number(),
      }),
    ),
    // UTC midnight of the first day the daily split was recorded, or null if it
    // never has been. Days before it carry grid: 0 because nothing was counting,
    // which reads identically to a real zero — so the panel draws them as one
    // undifferentiated bar instead of crediting the whole day to product pages.
    gridSplitFrom: v.union(v.number(), v.null()),
    // Client health (metrics:events). Always all six names, zero-filled, so the
    // panel renders a stable table and can divide the failure names by
    // panel_ok for an error rate. `name` is one of the six literals in
    // EVENT_NAMES — v.string() here only because the panel treats it as a
    // label; the write path is what keeps the set closed.
    errors: v.array(
      v.object({
        name: v.string(),
        total: v.number(),
        last7: v.number(),
      }),
    ),
    // Selector health — can the readers still find what they look for on Micro
    // Center's pages? Always all five readers, zero-filled, for the same reason
    // `errors` is. `name` is one of SELECTOR_NAMES; v.string() here because the
    // panel treats it as a label and the write path keeps the set closed.
    //
    // Two windows per reader on purpose: the lifetime ratio says what healthy
    // looked like, the recent one says whether it still does. Neither is
    // readable alone.
    selectors: v.array(
      v.object({
        name: v.string(),
        seen: v.number(),
        found: v.number(),
        bad: v.number(),
        recentSeen: v.number(),
        recentFound: v.number(),
        recentBad: v.number(),
      }),
    ),
    // Tallies refused as internally inconsistent (found > seen, and friends).
    // Should be 0; anything else means a client is sending numbers it cannot
    // have measured, and the whole table above should be read with that in mind.
    selectorsRejected: v.number(),
    selectorRecentDays: v.number(),
  }),
  handler: async (ctx, args) => {
    await checkAdminRateLimit(ctx);
    await requireAdmin(ctx, args);

    // Every number below is a counter maintained on write. Nothing here scans
    // a growing table, so the panel costs the same at 1k rows and at 10M.
    const [
      observations,
      observationsCatalog,
      catalogBatches,
      pricePoints,
      products,
      comments,
      commentsHidden,
      reports,
      alertsArmed,
      alertsFired,
      alertsClicked,
      devices,
      gridSplitAt,
    ] = await Promise.all([
      readCounter(ctx, "obs:total"),
      readCounter(ctx, "obs:catalog"),
      readCounter(ctx, "obs:batches"),
      readCounter(ctx, "pricepoints:total"),
      readCounter(ctx, "products:total"),
      readCounter(ctx, "comments:total"),
      readCounter(ctx, "comments:hidden"),
      readCounter(ctx, "reports:total"),
      readCounter(ctx, "alerts:armed"),
      readCounter(ctx, "alerts:fired"),
      readCounter(ctx, "alerts:clicked"),
      readCounter(ctx, "devices:total"),
      // A timestamp parked in the counters table, not a tally. `readCounter`
      // answers 0 for a missing row, which here means "no batch has ever been
      // recorded" rather than "the epoch" — normalised to null below.
      readCounter(ctx, "obs:gridday:from"),
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
        const [dayObs, dayGrid, dayComments, dayClicked, dayRateLimited] =
          await Promise.all([
            readCounter(ctx, `obs:day:${date}`),
            readCounter(ctx, `obs:gridday:${date}`),
            readCounter(ctx, `comments:day:${date}`),
            readCounter(ctx, `alerts:clicked:day:${date}`),
            readCounter(ctx, `abuse:ratelimited:day:${date}`),
          ]);
        return {
          date,
          observations: dayObs,
          // Clamped because the two counters are independent rows: a restore, a
          // backfill or a partial write could leave the share above the total,
          // and a negative page-sightings bar is a worse failure than a flat one.
          grid: Math.min(dayGrid, dayObs),
          comments: dayComments,
          clicked: dayClicked,
          rateLimited: dayRateLimited,
        };
      }),
    );

    // Every name every time, missing keys as 0 — a name that has never been
    // reported is a row of zeroes, not an absent row, so the panel's table
    // doesn't reshuffle the first time a new failure mode appears.
    const errorDays = Array.from({ length: ERROR_DAYS }, (_unused, i) =>
      utcDay(todayUtc - i * DAY_MS),
    );
    const errors = await Promise.all(
      EVENT_NAMES.map(async (name) => {
        const [total, ...days] = await Promise.all([
          readCounter(ctx, `evt:${name}`),
          ...errorDays.map((date) => readCounter(ctx, `evt:${name}:day:${date}`)),
        ]);
        return {
          name: name as string,
          total,
          last7: days.reduce((sum, n) => sum + n, 0),
        };
      }),
    );
    // Recent trouble first, lifetime volume as the tiebreak. Sort is stable, so
    // an all-zero deployment comes back in EVENT_NAMES order rather than an
    // arbitrary one.
    errors.sort((a, b) => b.last7 - a.last7 || b.total - a.total);

    // Can the readers still find what they look for? See recordSelectorHealth
    // in lib.ts for what the three numbers mean.
    //
    // BOTH WINDOWS, and the pair is the point. A lifetime ratio moves far too
    // slowly to show a break: a selector that worked for ten thousand cards and
    // died yesterday still reads 10,000/10,300 and will look healthy for weeks.
    // The recent window is what falls off a cliff the day it happens, and the
    // lifetime figure is what tells you what the healthy value used to be. One
    // without the other is unreadable — 0 of 500 means nothing if you don't
    // know the reader has ever found anything.
    //
    // Same explicit-key-list shape as `errors` above: every reader every time,
    // missing keys as 0, so the table doesn't reshuffle the first time a new
    // reader reports.
    const selectorDays = Array.from({ length: ERROR_DAYS }, (_unused, i) =>
      utcDay(todayUtc - i * DAY_MS),
    );
    const selectors = await Promise.all(
      SELECTOR_NAMES.map(async (name) => {
        const fields = ["seen", "found", "bad"] as const;
        const [lifetime, recent] = await Promise.all([
          Promise.all(fields.map((f) => readCounter(ctx, `sel:${name}:${f}`))),
          Promise.all(
            fields.map(async (f) =>
              (
                await Promise.all(
                  selectorDays.map((d) => readCounter(ctx, `sel:day:${d}:${name}:${f}`)),
                )
              ).reduce((sum, n) => sum + n, 0),
            ),
          ),
        ]);
        return {
          name: name as string,
          seen: lifetime[0],
          found: lifetime[1],
          bad: lifetime[2],
          recentSeen: recent[0],
          recentFound: recent[1],
          recentBad: recent[2],
        };
      }),
    );
    const selectorsRejected = await readCounter(ctx, "sel:rejected");

    return {
      totals: {
        observations,
        observationsCatalog,
        catalogBatches,
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
      gridSplitFrom: gridSplitAt > 0 ? gridSplitAt : null,
      errors,
      selectors,
      selectorsRejected,
      // The recent window's length, so the panel can label the column instead
      // of hard-coding a number that would silently drift from this one.
      selectorRecentDays: ERROR_DAYS,
    };
  },
});

// ---------------------------------------------------------------------------
// Category price index
// ---------------------------------------------------------------------------

// The one figure in this panel that is a statement about a MARKET rather than
// about Jackdaw. "Median price in Networking moved -2.4% over 90 days" is a
// derived aggregate; the readings behind it are not, and no endpoint here
// exports them. That distinction is the whole reason the aggregate is worth
// showing at all — see DATA-POLICY.md for what is and isn't collected.
//
// NOT SCOPED TO A STORE, though the original sketch was ("movement in
// Networking at Duluth"). Micro Center prices nationally: the same SKU carries
// the same price at every location, which is why `watches.fireFor` takes the
// newest point from ANY store. A store-scoped price index would therefore be
// the same number computed from a fraction of the readings — thinner, not more
// local. What genuinely varies by store is the open-box price and the shelf,
// and neither of those is a price movement.

// Read budget, same arithmetic as `health` above: CATEGORIES * (SAMPLE + SAMPLE
// * POINTS) = 8 * (30 + 900) = 7,440 documents, plus the counter range. That is
// why this is its own query rather than another section of `stats` — stats has
// no room for it, and keeping them separate means a category with pathological
// history can never delay or break the counters.
const INDEX_CATEGORIES = 8;
const INDEX_SAMPLE = 30;
const INDEX_POINTS = 30;
// Below this the median is withheld rather than printed. Three products is not
// a market, and a headline percentage resting on two of them is exactly the
// mistake the rest of this panel's labelling exists to prevent.
const INDEX_MIN_MEASURED = 4;
const WINDOW_DEFAULT_DAYS = 90;
const WINDOW_MIN_DAYS = 7;
const WINDOW_MAX_DAYS = 365;

/** Median of a sorted, non-empty list. Even lengths average the two middles. */
function medianOf(sorted: number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export const categoryIndex = query({
  args: { ...ADMIN_ARGS, days: v.optional(v.number()) },
  returns: v.object({
    windowDays: v.number(),
    from: v.number(),
    to: v.number(),
    // The method, returned rather than hardcoded in the panel, so the footnote
    // cannot drift away from the numbers it is describing.
    sampleCap: v.number(),
    pointCap: v.number(),
    minMeasured: v.number(),
    categories: v.array(
      v.object({
        category: v.string(),
        // THE COVERAGE DENOMINATORS, and there are two because there are two
        // different ways this number is thinner than it looks.
        //   sampled  — products examined in this category
        //   atCap    — true when there are more of them than we looked at, so
        //              `sampled` is a floor and not the category's size
        //   measured — of those, the ones with a price at BOTH ends of the
        //              window; the median rests on these and nothing else
        // Neither denominator is the number of products Micro Center sells in
        // the category. That figure is unknowable from here — we see what our
        // users happen to browse — so the panel must never imply a census.
        sampled: v.number(),
        atCap: v.boolean(),
        measured: v.number(),
        // Why the rest dropped out, never pooled into one "excluded" number.
        // tooNew: no reading old enough, so the product is younger than the
        // window. dense: the product changed price more than `pointCap` times
        // inside the window, so the older reading exists but fell off a capped
        // read — a limitation of this query, not a fact about the product.
        // noHistory: a product row with no points at all.
        tooNew: v.number(),
        dense: v.number(),
        noHistory: v.number(),
        // Null when `measured` is under `minMeasured`. The counts above still
        // come back, so the panel can say why there is no number instead of
        // printing a confident one from four readings.
        medianChangePct: v.union(v.number(), v.null()),
        // Median of the CURRENT prices in the sample — the category's scale, so
        // a percentage can be read against the kind of money it moves.
        medianPrice: v.union(v.number(), v.null()),
        fell: v.number(),
        rose: v.number(),
        flat: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    await checkAdminRateLimit(ctx);
    await requireAdmin(ctx, args);

    const requested = Math.round(args.days ?? WINDOW_DEFAULT_DAYS);
    const windowDays = Number.isFinite(requested)
      ? Math.min(Math.max(requested, WINDOW_MIN_DAYS), WINDOW_MAX_DAYS)
      : WINDOW_DEFAULT_DAYS;
    const to = Date.now();
    const from = to - windowDays * DAY_MS;

    // Category NAMES come from the counters, not from a scan of products —
    // same bounded prefix range `stats` uses, so the two cards always agree on
    // what a category is called and on which ones exist. These keys are the
    // normalized form, which is what `products.categoryKey` is indexed on.
    const categoryRows = await ctx.db
      .query("counters")
      .withIndex("by_key", (q) =>
        q.gte("key", CATEGORY_PREFIX).lt("key", CATEGORY_PREFIX_END),
      )
      .take(300);
    const names = categoryRows
      .map((row) => ({
        category: row.key.slice(CATEGORY_PREFIX.length),
        observations: row.value,
      }))
      .sort((a, b) => b.observations - a.observations)
      .slice(0, INDEX_CATEGORIES)
      .map((c) => c.category);

    const categories = [];
    for (const category of names) {
      // Ascending _creationTime, i.e. the products we discovered EARLIEST in
      // this category. Convex has no random sample, so the bias is chosen
      // rather than accidental: these are the rows most likely to hold a
      // reading from before the window opened, and a newest-first sample would
      // maximise `tooNew` and measure almost nothing. It does mean the index
      // tracks long-tracked products rather than the category as a whole.
      const sample = await ctx.db
        .query("products")
        .withIndex("by_categoryKey", (q) => q.eq("categoryKey", category))
        .take(INDEX_SAMPLE);

      const changes: number[] = [];
      const prices: number[] = [];
      let tooNew = 0;
      let dense = 0;
      let noHistory = 0;
      let fell = 0;
      let rose = 0;
      let flat = 0;

      for (const product of sample) {
        const points = await ctx.db
          .query("pricePoints")
          .withIndex("by_product", (q) => q.eq("productDocId", product._id))
          .order("desc")
          .take(INDEX_POINTS);
        if (points.length === 0) {
          noHistory++;
          continue;
        }

        // The price in effect at an instant is the newest row that had already
        // been created by then: a row is inserted only when the price CHANGES,
        // so the last one before the cutoff was still standing at the cutoff.
        // Scanned rather than read off the array's order — `.order("desc")`
        // sorts by creation time, and firstSeenAt only usually agrees with it
        // (seeded rows carry backdated timestamps).
        let nowAt = -1;
        let nowPrice = 0;
        let thenAt = -1;
        let thenPrice = 0;
        for (const p of points) {
          if (p.price <= 0) continue;
          if (p.firstSeenAt > nowAt) {
            nowAt = p.firstSeenAt;
            nowPrice = p.price;
          }
          if (p.firstSeenAt <= from && p.firstSeenAt > thenAt) {
            thenAt = p.firstSeenAt;
            thenPrice = p.price;
          }
        }

        if (nowAt < 0) {
          noHistory++;
          continue;
        }
        if (thenAt < 0) {
          // Two different reasons, kept apart. A full read means the reading we
          // needed may exist and simply fell off the end; a short one means the
          // product genuinely has nothing that old.
          if (points.length >= INDEX_POINTS) dense++;
          else tooNew++;
          continue;
        }

        changes.push(((nowPrice - thenPrice) / thenPrice) * 100);
        prices.push(nowPrice);
        if (nowPrice < thenPrice) fell++;
        else if (nowPrice > thenPrice) rose++;
        else flat++;
      }

      changes.sort((a, b) => a - b);
      prices.sort((a, b) => a - b);
      const measured = changes.length;
      categories.push({
        category,
        sampled: sample.length,
        atCap: sample.length >= INDEX_SAMPLE,
        measured,
        tooNew,
        dense,
        noHistory,
        medianChangePct:
          measured >= INDEX_MIN_MEASURED
            ? Math.round(medianOf(changes) * 10) / 10
            : null,
        medianPrice:
          measured >= INDEX_MIN_MEASURED
            ? Math.round(medianOf(prices) * 100) / 100
            : null,
        fell,
        rose,
        flat,
      });
    }

    return {
      windowDays,
      from,
      to,
      sampleCap: INDEX_SAMPLE,
      pointCap: INDEX_POINTS,
      minMeasured: INDEX_MIN_MEASURED,
      categories,
    };
  },
});

export const flagged = query({
  args: ADMIN_ARGS,
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
    await requireAdmin(ctx, args);

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
    ...ADMIN_ARGS,
    commentId: v.id("comments"),
    action: v.union(v.literal("unhide"), v.literal("delete")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Rate limit before the key check by intent, though the throw below rolls
    // the token back — see enforceAdminRateLimit's note.
    await enforceAdminRateLimit(ctx);
    await requireAdmin(ctx, args);

    await resolveCommentReport(ctx, args.commentId, args.action);
    return null;
  },
});
