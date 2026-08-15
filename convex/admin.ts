import { internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { categoryKey, initCounter, setCounter, utcDay } from "./lib";

// Dev utility: wipe all data. Run with `npx convex run admin:clearAll`.
export const clearAll = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const tables = ["votes", "comments", "pricePoints", "devices", "products"] as const;
    let deleted = 0;
    for (const table of tables) {
      const rows = await ctx.db.query(table).take(1000);
      for (const row of rows) {
        await ctx.db.delete(row._id);
        deleted++;
      }
    }
    return deleted;
  },
});

// Per-table scan cap for the backfill. Deliberately bounded: the point of the
// counters is that nothing ever scans a growing table.
const SCAN_LIMIT = 1000;

/**
 * One-shot baseline for the metrics counters, so data written before they
 * existed still shows up in the admin panel. Run with
 * `npx convex run admin:backfillCounters` (add --prod for production).
 *
 * Idempotent: derived counters are SET from the current data, not incremented,
 * so a second run recomputes the same values rather than doubling them.
 *
 * Two caveats worth knowing before re-running it later:
 *
 * 1. It refuses to write anything if any source table exceeds SCAN_LIMIT rows
 *    (throws TRUNCATED). A partial scan would clobber an accurate live counter
 *    with an undercount, which is worse than not running — by then the
 *    counters are being maintained on write anyway and need no repair.
 * 2. alerts:armed / alerts:fired / alerts:clicked are event tallies with no
 *    ground truth left in the data (arming is a transition; acking clears the
 *    flag; a click writes nothing but the counter). They are seeded only when
 *    missing — armed from the watches row count, which is the lower bound, and
 *    the other two at 0 — and never overwritten afterwards. The evt:* client
 *    health counters are the same kind of thing and are not touched at all:
 *    nothing derives them, they aren't in the list below, and the only stale
 *    key sweep is scoped to comments:day:, so a re-run cannot zero them.
 *
 * Note that obs:day is an approximation (see below), so a re-run re-derives
 * the daily observation series rather than preserving what live traffic
 * measured. comments:day is exact and gets fully reconciled, stale keys
 * included.
 */
export const backfillCounters = internalMutation({
  args: {},
  returns: v.object({
    products: v.number(),
    pricePoints: v.number(),
    devices: v.number(),
    comments: v.number(),
    reports: v.number(),
    watches: v.number(),
    countersWritten: v.number(),
  }),
  handler: async (ctx) => {
    const products = await ctx.db.query("products").take(SCAN_LIMIT);
    const pricePoints = await ctx.db.query("pricePoints").take(SCAN_LIMIT);
    const devices = await ctx.db.query("devices").take(SCAN_LIMIT);
    const comments = await ctx.db.query("comments").take(SCAN_LIMIT);
    const reports = await ctx.db.query("reports").take(SCAN_LIMIT);
    const watches = await ctx.db.query("watches").take(SCAN_LIMIT);

    // Compute everything before writing anything, so a truncated scan can't
    // leave half the counters overwritten with undercounts.
    const truncated = (
      [
        ["products", products.length],
        ["pricePoints", pricePoints.length],
        ["devices", devices.length],
        ["comments", comments.length],
        ["reports", reports.length],
        ["watches", watches.length],
      ] as const
    )
      .filter(([, count]) => count >= SCAN_LIMIT)
      .map(([table]) => table);
    if (truncated.length > 0) {
      throw new ConvexError({
        code: "TRUNCATED",
        message: `refusing to backfill: ${truncated.join(", ")} exceed ${SCAN_LIMIT} rows, so counters would be undercounted`,
      });
    }

    // A sighting either opens a price point (reportCount 1) or increments an
    // existing one's reportCount, so the sum is the observation total.
    const categoryOf = new Map(
      products.map((p) => [p._id, categoryKey(p.category)]),
    );
    let observations = 0;
    const byStore = new Map<string, number>();
    const byCategory = new Map<string, number>();
    const obsByDay = new Map<string, number>();
    for (const p of pricePoints) {
      observations += p.reportCount;
      byStore.set(p.storeNum, (byStore.get(p.storeNum) ?? 0) + p.reportCount);
      const cat = categoryOf.get(p.productDocId) ?? null;
      if (cat !== null) {
        byCategory.set(cat, (byCategory.get(cat) ?? 0) + p.reportCount);
      }
      // Approximation: repeat sightings of one price are attributed to the day
      // the point first appeared (the individual timestamps were never kept).
      // The daily series therefore still sums exactly to obs:total.
      const day = utcDay(p.firstSeenAt);
      obsByDay.set(day, (obsByDay.get(day) ?? 0) + p.reportCount);
    }

    let commentsHidden = 0;
    const commentsByDay = new Map<string, number>();
    for (const c of comments) {
      if (c.hidden === true) commentsHidden++;
      const day = utcDay(c._creationTime);
      commentsByDay.set(day, (commentsByDay.get(day) ?? 0) + 1);
    }

    const derived: [string, number][] = [
      ["obs:total", observations],
      ["pricepoints:total", pricePoints.length],
      ["products:total", products.length],
      ["devices:total", devices.length],
      ["comments:total", comments.length],
      ["comments:hidden", commentsHidden],
      ["reports:total", reports.length],
      ...[...byStore].map(
        ([storeNum, count]): [string, number] => [
          `obs:store:${storeNum}`,
          count,
        ],
      ),
      ...[...byCategory].map(
        ([category, count]): [string, number] => [
          `obs:cat:${category}`,
          count,
        ],
      ),
      ...[...obsByDay].map(
        ([day, count]): [string, number] => [`obs:day:${day}`, count],
      ),
      ...[...commentsByDay].map(
        ([day, count]): [string, number] => [`comments:day:${day}`, count],
      ),
    ];

    for (const [key, value] of derived) {
      await setCounter(ctx, key, value);
    }

    // A day whose comments were all moderated away keeps a stale count,
    // because the loop above only writes keys it derived. comments:day is
    // exact (every row carries its _creationTime), so any key in the
    // namespace that the scan didn't produce is genuinely zero now.
    //
    // Deliberately not done for obs:day: that series is approximate, so a key
    // missing from the derived map can still be a correct live measurement
    // (sightings that only incremented points first seen on an earlier day),
    // and zeroing it would destroy real data.
    const COMMENT_DAY_PREFIX = "comments:day:";
    const staleDays = await ctx.db
      .query("counters")
      .withIndex("by_key", (q) =>
        q.gte("key", COMMENT_DAY_PREFIX).lt("key", `${COMMENT_DAY_PREFIX}~`),
      )
      .take(500);
    let zeroed = 0;
    for (const row of staleDays) {
      const day = row.key.slice(COMMENT_DAY_PREFIX.length);
      if (!commentsByDay.has(day) && row.value !== 0) {
        await setCounter(ctx, row.key, 0);
        zeroed++;
      }
    }

    // Event tallies: seed once, never clobber (see the note above).
    await initCounter(ctx, "alerts:armed", watches.length);
    await initCounter(ctx, "alerts:fired", 0);
    await initCounter(ctx, "alerts:clicked", 0);

    // The catalog split belongs here rather than in `derived`, because it
    // cannot be reconstructed from rows at all. `pricePoints.source` records
    // which path OPENED a row, but `reportCount` accumulates sightings from
    // both onto that one row — a point opened by a product page and then
    // confirmed forty times by grid readings is `source: "product"` with
    // reportCount 41, and nothing stored says where the other forty came from.
    // So obs:catalog is only knowable at write time, like alerts:clicked.
    //
    // This matters more than it looks: `derived` above recomputes obs:total
    // from reportCount, so setCounter-ing these to a derivable-looking value
    // would move one half of the split and not the other, and the panel would
    // render a plausible, wrong ratio with nothing to flag it.
    await initCounter(ctx, "obs:catalog", 0);
    await initCounter(ctx, "obs:batches", 0);
    // `obs:gridday:*` and `obs:gridday:from` are deliberately NOT seeded here.
    // Zeroing the per-day keys would assert "no grid sightings that day" for
    // days that predate the counter, and stamping `from` would date the split
    // to whenever someone happened to run a backfill. Only `reportBatch` may
    // write either, so an unsplit day stays legibly unsplit.

    return {
      products: products.length,
      pricePoints: pricePoints.length,
      devices: devices.length,
      comments: comments.length,
      reports: reports.length,
      watches: watches.length,
      countersWritten: derived.length + 3 + zeroed,
    };
  },
});

// The evt: namespace holds only counter keys minted by metrics:events, whose
// names come from a closed union of lowercase identifiers and whose day
// suffixes are digits and hyphens. Every one of those characters sorts below
// "~", so this is a bounded range over that namespace and nothing else.
const EVENT_PREFIX = "evt:";
const EVENT_PREFIX_END = "evt:~";

/**
 * Delete every evt:* counter row. Run with
 * `npx convex run admin:clearEventCounters`.
 *
 * DEV UTILITY — there is no reason to run this against production. Client
 * health events are the one metric with no ground truth anywhere else (an
 * event is a moment, not a row), so anything deleted here is gone, and
 * `backfillCounters` cannot rebuild it.
 *
 * What it is for: a deployment that has been used for testing carries
 * synthetic values, and a fabricated `panel_error` on the health card is worse
 * than an empty one — the card exists to be believed, and one that cries wolf
 * teaches the operator to ignore the real spike. Clearing it puts the panel
 * back to honest zeroes.
 *
 * Bounded like every other scan here: a year of daily buckets across six names
 * is ~2,200 rows, more than SCAN_LIMIT, so `truncated` reports whether rows
 * remain. Run again while it is true.
 */
export const clearEventCounters = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number(), truncated: v.boolean() }),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("counters")
      .withIndex("by_key", (q) =>
        q.gte("key", EVENT_PREFIX).lt("key", EVENT_PREFIX_END),
      )
      .take(SCAN_LIMIT);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return { deleted: rows.length, truncated: rows.length >= SCAN_LIMIT };
  },
});
