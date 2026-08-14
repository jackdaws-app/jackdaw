import { internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { initCounter, setCounter, utcDay } from "./lib";

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
 * 2. alerts:armed / alerts:fired are event tallies with no ground truth left
 *    in the data (arming is a transition; acking clears the flag). They are
 *    seeded only when missing — armed from the watches row count, which is the
 *    lower bound, and fired at 0 — and never overwritten afterwards.
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
    let observations = 0;
    const byStore = new Map<string, number>();
    const obsByDay = new Map<string, number>();
    for (const p of pricePoints) {
      observations += p.reportCount;
      byStore.set(p.storeNum, (byStore.get(p.storeNum) ?? 0) + p.reportCount);
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

    // Event tallies: seed once, never clobber (see the note above).
    await initCounter(ctx, "alerts:armed", watches.length);
    await initCounter(ctx, "alerts:fired", 0);

    return {
      products: products.length,
      pricePoints: pricePoints.length,
      devices: devices.length,
      comments: comments.length,
      reports: reports.length,
      watches: watches.length,
      countersWritten: derived.length + 2,
    };
  },
});
