import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { bump, requireLength, resolveSession } from "./lib";

// Epsilon guarding float noise: fire when current <= target + 0.009.
const DROP_EPSILON = 0.009;

// Dashboard bounds. A caller reads at most 50 active watches, and Convex allows
// ~16k document reads per function — so the per-product history scan is
// budgeted rather than a flat 500, or a full watch list would blow the
// limit once history accumulates.
const POINT_BUDGET = 12_000;
const MAX_POINTS_PER_PRODUCT = 500;
const MIN_POINTS_PER_PRODUCT = 60;
const MAX_TREND_POINTS = 24;
const WATCH_WINDOW = 50;

// Rows one account can hold for one product: one per browser that watched it
// before signing in. Bounded because a write patches all of them, and because
// a number larger than the browsers a person owns would mean something else
// has gone wrong.
const MAX_ROWS_PER_PRODUCT = 10;

/** Evenly sample `values` down to at most `max`, keeping first and last. */
function downsample(values: number[], max: number): number[] {
  if (values.length <= max) return values;
  const step = (values.length - 1) / (max - 1);
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(values[Math.round(i * step)]);
  return out;
}

// ---------------------------------------------------------------------------
// Scope: the device by default, the account when a session resolves
//
// Anonymous stays exact. No sessionToken — or one that doesn't resolve —
// behaves precisely as this file did before accounts existed. resolveSession
// answers null for a malformed, expired or orphaned token, and null means
// anonymous rather than an error: a signed-out client is the normal state of
// this product, not a failure to report.
//
// When a session does resolve the ACCOUNT is the scope, not a filter laid over
// one device's rows — that is what makes the second browser see the first
// browser's alerts, which is the entire promise. Rows written while signed in
// carry accountId from birth, so they sync without waiting for another sign-in
// to adopt them. deviceId stays on every row either way: it is the anonymous
// owner, and it has to survive auth:deleteAccount clearing accountId back off.
//
// ONE ACTIVE ROW per (account, product) is an invariant every account-scoped
// write maintains, and never one a read may assume. Two browsers that each
// armed the same product before signing in arrive as two rows the moment
// adoption stamps them, so the read paths dedupe as well.
// ---------------------------------------------------------------------------

/** The account this call speaks for, or null for anonymous. */
async function scopeAccount(
  ctx: QueryCtx,
  sessionToken: string | undefined,
): Promise<Id<"accounts"> | null> {
  if (sessionToken === undefined || sessionToken.length === 0) return null;
  const resolved = await resolveSession(ctx, sessionToken);
  return resolved === null ? null : resolved.account._id;
}

type WatchSet = {
  /** The rows the caller's scope treats as this one watch. */
  rows: Doc<"watches">[];
  /** This device's row while no account has claimed it — see below. */
  unclaimed: Doc<"watches"> | null;
};

/**
 * Every row that counts as "this caller's watch on this product".
 *
 * Anonymous: the device's row, exactly as before.
 *
 * Signed in: the account's rows across every browser, because a second
 * browser's row for the same product is the same watch. `unclaimed` is
 * deliberately NOT one of them — a row this device holds that no account has
 * claimed still belongs to the anonymous device, and the account is the scope.
 * It comes back separately because a write must reuse it rather than insert a
 * second row for the same (device, product): the anonymous path resolves that
 * pair with .first(), so a duplicate would be permanently invisible to the
 * device that owns it the moment they sign out.
 */
async function watchSet(
  ctx: QueryCtx,
  accountId: Id<"accounts"> | null,
  deviceId: string,
  productDocId: Id<"products">,
): Promise<WatchSet> {
  const deviceRow = await ctx.db
    .query("watches")
    .withIndex("by_device_product", (q) =>
      q.eq("deviceId", deviceId).eq("productDocId", productDocId),
    )
    .first();

  if (accountId === null) {
    return { rows: deviceRow === null ? [] : [deviceRow], unclaimed: null };
  }

  // Newest first, so a bounded window always contains the rows canonical()
  // prefers rather than the oldest ten.
  const rows = await ctx.db
    .query("watches")
    .withIndex("by_account_product", (q) =>
      q.eq("accountId", accountId).eq("productDocId", productDocId),
    )
    .order("desc")
    .take(MAX_ROWS_PER_PRODUCT);

  // A row already claimed by a DIFFERENT account is left alone: two accounts
  // sharing one browser profile is somebody else's watch, not this one's.
  const unclaimed =
    deviceRow !== null && deviceRow.accountId === undefined ? deviceRow : null;
  return { rows, unclaimed };
}

/**
 * Which row speaks for a watch when an account holds more than one.
 *
 * Active first — someone who armed this product on any browser is watching it,
 * and a dead row must never answer for a live one. Then the newest, because
 * watches carry no updatedAt and `_creationTime` is the only ordering a row
 * has. That is exact for the case duplicates actually come from (two browsers
 * that each armed the product before signing in, merged by adoption): the
 * later arming is the later intent. It could only be wrong for an older row
 * retargeted after a newer one existed, which no write can leave behind any
 * more — every account-scoped write below converges the set to one active row.
 */
function canonical(rows: Doc<"watches">[]): Doc<"watches"> | null {
  let best: Doc<"watches"> | null = null;
  for (const row of rows) {
    if (best === null) {
      best = row;
      continue;
    }
    if (row.active !== best.active) {
      if (row.active) best = row;
      continue;
    }
    if (row._creationTime > best._creationTime) best = row;
  }
  return best;
}

/**
 * Arm `keep` at `priceAtWatch`, and quiet every other row in the set.
 *
 * Converging to one active row is what keeps the list paths honest: they read
 * a window of active rows, so a product holding a live row per browser would
 * both push other products out of that window and fire a notification per row.
 * The losing rows keep their deviceId and their target and are merely
 * disarmed — deleting them would take an alert away from a browser that may
 * yet sign out and want it back.
 *
 * The cost, named: a browser whose duplicate row loses is left with a disarmed
 * watch if it later signs out. One click re-arms it, and the alternative —
 * leaving it live — is a watchlist that shows the same product twice and
 * refuses to be turned off.
 */
async function armOne(
  ctx: MutationCtx,
  rows: Doc<"watches">[],
  keep: Doc<"watches">,
  priceAtWatch: number,
): Promise<void> {
  await ctx.db.patch(keep._id, { active: true, priceAtWatch });
  for (const row of rows) {
    if (row._id === keep._id) continue;
    if (row.active) await ctx.db.patch(row._id, { active: false });
  }
}

/**
 * Disarm every armed row in the set; report whether anything was armed.
 * Already-disarmed rows are left untouched, so a repeated dismissal writes
 * nothing and cannot be counted twice.
 */
async function disarmAll(
  ctx: MutationCtx,
  rows: Doc<"watches">[],
): Promise<boolean> {
  let disarmed = false;
  for (const row of rows) {
    if (!row.active) continue;
    await ctx.db.patch(row._id, { active: false });
    disarmed = true;
  }
  return disarmed;
}

/**
 * The row a signed-in write arms when the account holds none for this product:
 * this device's unclaimed row, linked on the spot. Exactly what the next
 * sign-in's adoption would do to it, done at the moment the account first
 * touches the product instead of a sign-in later.
 */
async function claimForWrite(
  ctx: MutationCtx,
  set: WatchSet,
  accountId: Id<"accounts">,
): Promise<Doc<"watches"> | null> {
  if (set.unclaimed === null) return null;
  await ctx.db.patch(set.unclaimed._id, { accountId });
  return set.unclaimed;
}

/**
 * The caller's armed watches, one row per product.
 *
 * Scoped to active rows by the index rather than filtered in JS afterwards:
 * watches are soft-deactivated (toggle/ack set active:false rather than
 * deleting), so a take() over a bare owner prefix would fill with dead rows —
 * both indexes are [owner, active] and `false` sorts below `true`, which puts
 * every dead row ahead of every live one. The equality on `active` is what
 * makes the window live.
 *
 * The dedupe is not only for account scope: a product must never appear twice
 * in a watchlist, whatever produced the second row.
 */
async function armedWatches(
  ctx: QueryCtx,
  accountId: Id<"accounts"> | null,
  deviceId: string,
): Promise<Doc<"watches">[]> {
  const rows =
    accountId === null
      ? await ctx.db
          .query("watches")
          .withIndex("by_device_active", (q) =>
            q.eq("deviceId", deviceId).eq("active", true),
          )
          .take(WATCH_WINDOW)
      : await ctx.db
          .query("watches")
          .withIndex("by_account_active", (q) =>
            q.eq("accountId", accountId).eq("active", true),
          )
          .take(WATCH_WINDOW);

  // Same rule the write paths pick with, so what the popup shows and what a
  // toggle acts on can't disagree.
  const byProduct = new Map<Id<"products">, Doc<"watches">>();
  for (const row of rows) {
    const seen = byProduct.get(row.productDocId);
    if (seen === undefined || canonical([seen, row]) === row) {
      byProduct.set(row.productDocId, row);
    }
  }
  return [...byProduct.values()];
}

export const toggle = mutation({
  args: {
    deviceId: v.string(),
    productId: v.string(),
    // Optional forever: absent, malformed or expired is anonymous, never an
    // error. Same for every function in this file.
    sessionToken: v.optional(v.string()),
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

    const accountId = await scopeAccount(ctx, args.sessionToken);
    const set = await watchSet(ctx, accountId, deviceId, product._id);
    const existing = canonical(set.rows);

    if (existing !== null && existing.active) {
      // Every row, not just the canonical one: leaving a sibling armed would
      // mean "unwatch" didn't, on the browser that owns the sibling.
      await disarmAll(ctx, set.rows);
      return { watching: false };
    }

    // Latest price across stores (most recent pricePoint by creation time).
    const latest = await ctx.db
      .query("pricePoints")
      .withIndex("by_product", (q) => q.eq("productDocId", product._id))
      .order("desc")
      .first();
    const priceAtWatch = latest === null ? 0 : latest.price;

    const claimed =
      existing === null && accountId !== null
        ? await claimForWrite(ctx, set, accountId)
        : null;
    const keep = existing ?? claimed;

    if (keep !== null) {
      await armOne(ctx, set.rows, keep, priceAtWatch);
    } else {
      await ctx.db.insert("watches", {
        deviceId,
        productDocId: product._id,
        priceAtWatch,
        active: true,
        // Linked from birth, so the second browser sees it without waiting for
        // another sign-in to adopt it.
        accountId: accountId ?? undefined,
      });
    }

    // Reaching this branch means nothing in the scope was armed — canonical()
    // prefers active rows and the armed case returned above — so this is the
    // same "alert armed" event setTarget records, and the bell arms watches
    // too, so counting only setTarget would undercount. The one exception is a
    // claimed row that was already armed anonymously: the account gained a
    // handle on an existing alert, which is not a new one.
    if (keep === null || !keep.active) await bump(ctx, "alerts:armed");
    return { watching: true };
  },
});

export const setTarget = mutation({
  args: {
    deviceId: v.string(),
    productId: v.string(),
    targetPrice: v.number(),
    sessionToken: v.optional(v.string()),
  },
  returns: v.object({ watching: v.literal(true), target: v.number() }),
  handler: async (ctx, args) => {
    if (
      !Number.isFinite(args.targetPrice) ||
      args.targetPrice <= 0 ||
      args.targetPrice >= 100_000
    ) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "targetPrice must be a finite number between 0 and 100000",
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

    const accountId = await scopeAccount(ctx, args.sessionToken);
    const set = await watchSet(ctx, accountId, deviceId, product._id);
    const existing = canonical(set.rows);
    const claimed =
      existing === null && accountId !== null
        ? await claimForWrite(ctx, set, accountId)
        : null;
    const keep = existing ?? claimed;

    // Arming is create-or-reactivate; re-pricing an already-armed watch is an
    // edit, not a new alert, so it must not bump the tally.
    const armed = keep === null || !keep.active;

    if (keep !== null) {
      await armOne(ctx, set.rows, keep, args.targetPrice);
    } else {
      await ctx.db.insert("watches", {
        deviceId,
        productDocId: product._id,
        priceAtWatch: args.targetPrice,
        active: true,
        accountId: accountId ?? undefined,
      });
    }

    if (armed) await bump(ctx, "alerts:armed");

    return { watching: true as const, target: args.targetPrice };
  },
});

export const status = query({
  args: {
    deviceId: v.string(),
    productId: v.string(),
    sessionToken: v.optional(v.string()),
  },
  returns: v.object({
    watching: v.boolean(),
    target: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    const product = await ctx.db
      .query("products")
      .withIndex("by_productId", (q) => q.eq("productId", args.productId))
      .unique();
    if (product === null) return { watching: false, target: null };

    const accountId = await scopeAccount(ctx, args.sessionToken);
    const set = await watchSet(ctx, accountId, args.deviceId, product._id);
    const watch = canonical(set.rows);
    const watching = watch !== null && watch.active;
    return { watching, target: watching ? watch.priceAtWatch : null };
  },
});

/**
 * Watches whose target has been met, for the client's hourly notification pass.
 *
 * ONE ALERT PER PERSON, NOT PER BROWSER. This is the one behaviour account
 * scope changes rather than widens, so it is a decision rather than a
 * side effect. Every signed-in browser polls the same armed rows on its own
 * hourly alarm and ack is one-shot (it disarms the watch), so the first browser
 * to look notifies and disarms, and the rest find nothing. That is the right
 * semantic for a price alert: the person asked to be told once, and three
 * toasts for one drop is noise rather than redundancy — the same reason the
 * watchlist itself is now one list instead of three.
 *
 * What it costs, plainly: the toast lands on whichever signed-in browser
 * happened to poll first, which needn't be the one in front of you, and since
 * ack disarms the watch the row also leaves the watchlist — so a missed toast
 * becomes a drop you only find by looking. Two things blunt it: a browser that
 * isn't running doesn't poll at all, and Chrome keeps the notification in the
 * OS centre of whichever browser did.
 *
 * Per-browser delivery was the alternative and it isn't a small one. It needs a
 * record of which devices have seen which firing, plus a window to keep a fired
 * watch deliverable in — and no completion condition exists, because nothing
 * can know how many browsers an account has, so it is a fan-out ledger with a
 * TTL rather than a flag. That is not worth building for a one-shot alert whose
 * payload is on the product page anyway. If it is ever wanted, the shape is a
 * firedAt column plus a per-device seen list read through its own index, not a
 * change to the scope here.
 */
export const check = query({
  args: {
    deviceId: v.string(),
    sessionToken: v.optional(v.string()),
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
    const accountId = await scopeAccount(ctx, args.sessionToken);
    const watches = await armedWatches(ctx, accountId, args.deviceId);

    const drops: {
      productId: string;
      name: string;
      urlPath: string;
      priceAtWatch: number;
      currentPrice: number;
      storeNum: string;
    }[] = [];

    for (const watch of watches) {
      const latest = await ctx.db
        .query("pricePoints")
        .withIndex("by_product", (q) => q.eq("productDocId", watch.productDocId))
        .order("desc")
        .first();
      if (latest === null) continue;
      // Fire when current <= target + epsilon (at-or-below the chosen target).
      if (latest.price > watch.priceAtWatch + DROP_EPSILON) continue;

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

const dashboardRowValidator = v.object({
  productId: v.string(),
  name: v.string(),
  urlPath: v.string(),
  storeNum: v.string(),
  target: v.number(),
  currentPrice: v.number(),
  inStock: v.boolean(),
  lowest: v.number(),
  trend: v.array(v.number()),
  met: v.boolean(),
});

type DashboardRow = {
  productId: string;
  name: string;
  urlPath: string;
  storeNum: string;
  target: number;
  currentPrice: number;
  inStock: boolean;
  lowest: number;
  trend: number[];
  met: boolean;
};

/**
 * Everything the toolbar popup needs in one round trip: every active watch
 * with its target, current price, all-time low, and a downsampled series for a
 * mini sparkline. Met alerts sort first, then the watches closest to their
 * target.
 *
 * Signed in, that is the account's watchlist rather than this browser's — the
 * same list on every browser, which is the whole reason accounts exist.
 */
export const dashboard = query({
  args: {
    deviceId: v.string(),
    sessionToken: v.optional(v.string()),
  },
  returns: v.array(dashboardRowValidator),
  handler: async (ctx, args) => {
    const accountId = await scopeAccount(ctx, args.sessionToken);
    const active = await armedWatches(ctx, accountId, args.deviceId);

    if (active.length === 0) return [];

    const perProduct = Math.min(
      MAX_POINTS_PER_PRODUCT,
      Math.max(
        MIN_POINTS_PER_PRODUCT,
        Math.floor(POINT_BUDGET / active.length),
      ),
    );

    const rows: DashboardRow[] = [];

    for (const watch of active) {
      const product = await ctx.db.get(watch.productDocId);
      if (product === null) continue;

      // Newest-first, so currentPrice / lowest / trend all describe the same
      // window (an oldest-first scan could report a "lowest" above the
      // current price once a product exceeds the cap). Reversed below for a
      // chronological sparkline.
      const recent = await ctx.db
        .query("pricePoints")
        .withIndex("by_product", (q) => q.eq("productDocId", watch.productDocId))
        .order("desc")
        .take(perProduct);

      const latest = recent.length > 0 ? recent[0] : null;
      const currentPrice = latest === null ? 0 : latest.price;

      let lowestSoFar: number | null = null;
      for (const p of recent) {
        if (lowestSoFar === null || p.price < lowestSoFar) lowestSoFar = p.price;
      }

      const chronological = recent
        .slice()
        .reverse()
        .map((p) => p.price);

      rows.push({
        productId: product.productId,
        name: product.name,
        urlPath: product.urlPath,
        storeNum: latest === null ? "000" : latest.storeNum,
        target: watch.priceAtWatch,
        currentPrice,
        inStock: latest === null ? false : latest.inStock,
        lowest: lowestSoFar ?? 0,
        trend: downsample(chronological, MAX_TREND_POINTS),
        met: currentPrice > 0 && currentPrice <= watch.priceAtWatch + DROP_EPSILON,
      });
    }

    rows.sort((a, b) => {
      // Met alerts first.
      if (a.met !== b.met) return a.met ? -1 : 1;
      // Then anything with a known price, closest-to-target first; watches
      // with no price data yet sink to the bottom rather than sorting as if
      // they were the biggest bargain.
      const aKnown = a.currentPrice > 0;
      const bKnown = b.currentPrice > 0;
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return a.currentPrice - a.target - (b.currentPrice - b.target);
    });

    return rows;
  },
});

export const ack = mutation({
  args: {
    deviceId: v.string(),
    productId: v.string(),
    newPrice: v.number(),
    sessionToken: v.optional(v.string()),
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

    const accountId = await scopeAccount(ctx, args.sessionToken);
    const set = await watchSet(ctx, accountId, deviceId, product._id);

    // One-shot alert: acknowledging turns the watch off, preserving the user's
    // chosen target. Re-arm via setTarget/toggle. `newPrice` is accepted (and
    // validated) only for wire compatibility. Signed in, it disarms the whole
    // set — the person has been told, on whichever browser told them, and a
    // sibling row left armed would notify them again an hour later.
    //
    // Only an armed row can fire, so acking an already-off watch is a duplicate
    // notification dismissal rather than a second alert. Two browsers racing
    // the same ack land on the same answer: Convex serializes them, and the
    // loser re-runs against rows that are already off.
    const fired = await disarmAll(ctx, set.rows);
    if (fired) await bump(ctx, "alerts:fired");
    return null;
  },
});
