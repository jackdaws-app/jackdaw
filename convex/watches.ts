import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  bump,
  isPhysicalStore,
  requireLength,
  resolveSession,
  STORE_SIGNAL_MAX_AGE_MS,
  utcDay,
} from "./lib";

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

// ---------------------------------------------------------------------------
// Store-scoped triggers
//
// STORE_SIGNAL_MAX_AGE_MS — the 48 hours a per-store observation is allowed to
// be — now lives in `lib.ts`, because `observations` needs the same number to
// decide whether re-seeing a stale row is worth an email. The rationale is
// stated there in full; the short version is that an open-box unit is a single
// physical item, so a stale "open box at your store" sends somebody driving.

// Recent observations to read per store when looking for a stock transition.
// Small because it is per-watch inside a 50-watch loop, and because a restock
// older than a few state changes is not news.
const STORE_HISTORY_WINDOW = 5;

/** Evenly sample `values` down to at most `max`, keeping first and last. */
function downsample(values: number[], max: number): number[] {
  if (values.length <= max) return values;
  const step = (values.length - 1) / (max - 1);
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(values[Math.round(i * step)]);
  return out;
}

// ---------------------------------------------------------------------------
// Scope: the account, and only the account (as of 2026-08-20)
//
// Every function in this file requires a session that resolves. A deviceId is
// a string the client invents, so device-scoped alerts were alerts anyone
// could read, disarm or forge with a curl call; the account — email + code —
// is the one identity the caller cannot mint. Queries answer a signed-out
// caller with the empty/signed-out shape rather than a throw, so a signed-out
// popup renders a sign-in state without console errors; mutations refuse
// SIGN_IN_REQUIRED in each mutation's existing refusal style (thrown where the
// mutation's other refusals throw, in band where they answer in band).
//
// The ACCOUNT is the scope, not a filter laid over one device's rows — that is
// what makes the second browser see the first browser's alerts, which is the
// entire promise. Rows written while signed in carry accountId from birth.
// deviceId stays on every row: it is what auth:verifyCode's adoption matches
// on, and it has to survive auth:deleteAccount clearing accountId back off —
// the rows it leaves behind are unreachable until a sign-in adopts them again,
// but they are not orphaned data.
//
// ONE ACTIVE ROW per (account, product) is an invariant every account-scoped
// write maintains, and never one a read may assume. Two browsers that each
// armed the same product before signing in arrive as two rows the moment
// adoption stamps them, so the read paths dedupe as well.
// ---------------------------------------------------------------------------

/** The account this call speaks for, or null for signed out. */
async function scopeAccount(
  ctx: QueryCtx,
  sessionToken: string | undefined,
): Promise<Id<"accounts"> | null> {
  if (sessionToken === undefined || sessionToken.length === 0) return null;
  const resolved = await resolveSession(ctx, sessionToken);
  return resolved === null ? null : resolved.account._id;
}

/**
 * scopeAccount for the mutations whose refusals throw: no/invalid session is
 * SIGN_IN_REQUIRED. Thrown before anything is written, so there is nothing for
 * the throw to roll back.
 */
async function requireWatchAccount(
  ctx: QueryCtx,
  sessionToken: string | undefined,
): Promise<Id<"accounts">> {
  const accountId = await scopeAccount(ctx, sessionToken);
  if (accountId === null) {
    throw new ConvexError({
      code: "SIGN_IN_REQUIRED",
      message: "Sign in to use alerts",
    });
  }
  return accountId;
}

type WatchSet = {
  /** The rows the caller's scope treats as this one watch. */
  rows: Doc<"watches">[];
  /** This device's row while no account has claimed it — see below. */
  unclaimed: Doc<"watches"> | null;
};

/**
 * Every row that counts as "this caller's watch on this product": the
 * account's rows across every browser, because a second browser's row for the
 * same product is the same watch.
 *
 * `unclaimed` is deliberately NOT one of them — a row this device holds that
 * no account has claimed still belongs to the device that armed it before
 * signing in. It comes back separately because a write must reuse it rather
 * than insert a second row for the same (device, product): adoption
 * (auth:verifyCode) resolves that pair through by_device_product, so a
 * duplicate would collide with the next sign-in's merge. Callers with no
 * device to speak for (the account-only paths: setTriggers, ack) pass null
 * and skip the probe.
 */
async function watchSet(
  ctx: QueryCtx,
  accountId: Id<"accounts">,
  deviceId: string | null,
  productDocId: Id<"products">,
): Promise<WatchSet> {
  const deviceRow =
    deviceId === null
      ? null
      : await ctx.db
          .query("watches")
          .withIndex("by_device_product", (q) =>
            q.eq("deviceId", deviceId).eq("productDocId", productDocId),
          )
          .first();

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
 *
 * Arming always turns the price trigger back on. Both doors into this function
 * are "notify me about this product" — the bell, and typing a target — and the
 * price is what that means by default. It also keeps an invariant setTriggers
 * enforces from its own side: no armed watch has zero live triggers, so nothing
 * can sit in a watchlist looking live while being unable to fire. Store-only is
 * reached by switching price off afterwards, deliberately.
 */
async function armOne(
  ctx: MutationCtx,
  rows: Doc<"watches">[],
  keep: Doc<"watches">,
  priceAtWatch: number,
): Promise<void> {
  // emailedAt cleared: arming is what "notify me about this product" means,
  // so a re-armed watch is a NEW alert and is owed its own email. Without
  // this a watch emailed once would be silent by mail forever after,
  // however many times the shopper re-armed it. See schema.ts.
  await ctx.db.patch(keep._id, {
    active: true,
    priceAtWatch,
    alertPrice: true,
    emailedAt: undefined,
  });
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
  accountId: Id<"accounts">,
): Promise<Doc<"watches">[]> {
  const rows = await ctx.db
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

/**
 * Ask for an email pass over one product now, instead of on the hour.
 *
 * Arming is the one moment an email can be owed with no new sighting behind
 * it: a shopper arms a watch on a product that is ALREADY under their target,
 * or already has an open-box unit sitting at their store. The observation that
 * would have carried it happened days ago, so the sighting-driven fan-out in
 * `observations` has nothing to fire on and the hourly sweep is the only thing
 * that would ever notice.
 *
 * Best-effort, exactly like the sighting path: the sweep sends this within the
 * hour whether or not the schedule below survives. See the email section at the
 * bottom of this file for what that guarantee is and is not.
 */
async function scheduleEmailFanOut(
  ctx: MutationCtx,
  productDocId: Id<"products">,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.alerts.fanOut, {
    productDocIds: [productDocId],
  });
}

export const toggle = mutation({
  args: {
    // Still carried by the write paths that can CLAIM: it names this
    // browser's pre-sign-in row so claimForWrite can adopt it, and it is
    // stamped on any new row so a later deleteAccount leaves the row owned.
    deviceId: v.string(),
    productId: v.string(),
    // Optional in the validator so a signed-out client gets the clean
    // SIGN_IN_REQUIRED refusal rather than an ArgumentValidationError.
    sessionToken: v.optional(v.string()),
  },
  returns: v.object({ watching: v.boolean() }),
  // Annotated because the handler reaches `internal` (through
  // scheduleEmailFanOut) and inference would otherwise have to resolve the
  // generated api type, which is built from this handler.
  handler: async (ctx, args): Promise<{ watching: boolean }> => {
    const deviceId = requireLength("deviceId", args.deviceId, 1, 100);
    const accountId = await requireWatchAccount(ctx, args.sessionToken);

    const product = await ctx.db
      .query("products")
      .withIndex("by_productId", (q) => q.eq("productId", args.productId))
      .unique();
    if (product === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "unknown product" });
    }

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
      existing === null ? await claimForWrite(ctx, set, accountId) : null;
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
        accountId,
      });
    }

    // Reaching this branch means nothing in the scope was armed — canonical()
    // prefers active rows and the armed case returned above — so this is the
    // same "alert armed" event setTarget records, and the bell arms watches
    // too, so counting only setTarget would undercount. The one exception is a
    // claimed row that was already armed anonymously: the account gained a
    // handle on an existing alert, which is not a new one.
    if (keep === null || !keep.active) await bump(ctx, "alerts:armed");

    // Newly armed, so it may already be firing. Never on the disarm branch
    // above, which returned before reaching this.
    await scheduleEmailFanOut(ctx, product._id);
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
  handler: async (ctx, args): Promise<{ watching: true; target: number }> => {
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
    const accountId = await requireWatchAccount(ctx, args.sessionToken);

    const product = await ctx.db
      .query("products")
      .withIndex("by_productId", (q) => q.eq("productId", args.productId))
      .unique();
    if (product === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "unknown product" });
    }

    const set = await watchSet(ctx, accountId, deviceId, product._id);
    const existing = canonical(set.rows);
    const claimed =
      existing === null ? await claimForWrite(ctx, set, accountId) : null;
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
        accountId,
      });
    }

    if (armed) await bump(ctx, "alerts:armed");

    // Scheduled whether or not `armed` — re-pricing an existing watch is not a
    // new alert to count, but a target moved above today's price is a fire that
    // did not exist a moment ago, which is the whole reason the field is there.
    await scheduleEmailFanOut(ctx, product._id);

    return { watching: true as const, target: args.targetPrice };
  },
});

/**
 * Set which of the three triggers an already-armed watch fires on.
 *
 * Separate from toggle/setTarget rather than folded into them: those two own
 * the "is there an alert, and at what number" question and are dense with
 * account-scope invariants. Which reasons it fires on is an edit to an
 * existing alert, so it gets its own narrow path and never bumps
 * alerts:armed — the alert was already counted when it was armed.
 *
 * Every row in the scope is patched, not just the canonical one, so a browser
 * whose row wins canonical() later still reads the preferences the person set.
 */
type SetTriggersResult = {
  ok: boolean;
  reason?: "SIGN_IN_REQUIRED" | "NOT_WATCHING" | "NOT_A_STORE" | "NO_TRIGGERS";
};

export const setTriggers = mutation({
  args: {
    // No deviceId: this function only edits rows the account already holds —
    // it never claims a pre-sign-in row and never inserts, so it has no use
    // for a device identity. NOT_WATCHING is the answer when the account has
    // nothing here, exactly as before.
    productId: v.string(),
    storeNum: v.string(),
    price: v.boolean(),
    openBox: v.boolean(),
    restock: v.boolean(),
    sessionToken: v.optional(v.string()),
  },
  returns: v.object({
    ok: v.boolean(),
    reason: v.optional(
      v.union(
        v.literal("SIGN_IN_REQUIRED"),
        v.literal("NOT_WATCHING"),
        v.literal("NOT_A_STORE"),
        v.literal("NO_TRIGGERS"),
      ),
    ),
  }),
  handler: async (ctx, args): Promise<SetTriggersResult> => {
    const storeNum = requireLength("storeNum", args.storeNum, 1, 10);

    // This mutation answers its refusals in band, so the sign-in gate does
    // too — one refusal style per function, and the panel already branches on
    // `reason`. First, before the cheaper checks: what a signed-out caller
    // needs to hear is "sign in", not a critique of their store number.
    const accountId = await scopeAccount(ctx, args.sessionToken);
    if (accountId === null) {
      return { ok: false, reason: "SIGN_IN_REQUIRED" as const };
    }

    // Refused in band rather than thrown, for the reason the rest of this
    // codebase answers in band: a throw would roll back its own writes, and a
    // caller that has to distinguish "no alert here" from "backend down" gets
    // nothing useful from an exception. Nothing is written before this point.
    if ((args.openBox || args.restock) && !isPhysicalStore(storeNum)) {
      return { ok: false, reason: "NOT_A_STORE" as const };
    }

    // An armed watch with nothing to fire on is a watchlist row that can never
    // resolve — it would sit in the popup forever looking live. Turning
    // everything off is `toggle`'s job, and saying so is more useful than
    // silently writing a watch that does nothing.
    if (!args.price && !args.openBox && !args.restock) {
      return { ok: false, reason: "NO_TRIGGERS" as const };
    }

    const product = await ctx.db
      .query("products")
      .withIndex("by_productId", (q) => q.eq("productId", args.productId))
      .unique();
    if (product === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "unknown product" });
    }

    const set = await watchSet(ctx, accountId, null, product._id);
    const watch = canonical(set.rows);
    if (watch === null || !watch.active) {
      return { ok: false, reason: "NOT_WATCHING" as const };
    }

    // Arming a trigger that was OFF gives this watch its email back, exactly
    // as `armOne` does — the alternative is a switch that reads armed and can
    // never send, because a price email spent the one allowance weeks ago and
    // nothing in the panel says so. Deliberately NARROW: only off -> on, so
    // turning a trigger off, or moving a target, restores nothing and a
    // shopper cannot re-send the same alert by flipping a switch back and
    // forth. Read off `watch` rather than per row because the whole sibling
    // set is one email — the same window `markEmailed` stamps.
    const newlyArmed =
      (args.price && watch.alertPrice === false) ||
      (args.openBox && watch.alertOpenBox !== true) ||
      (args.restock && watch.alertRestock !== true);

    for (const row of set.rows) {
      await ctx.db.patch(row._id, {
        storeNum,
        alertPrice: args.price,
        alertOpenBox: args.openBox,
        alertRestock: args.restock,
        ...(newlyArmed ? { emailedAt: undefined } : {}),
      });
    }

    // Only here, never on the `ok: false` returns above: those wrote nothing,
    // so there is nothing new that could fire. Turning a trigger ON can create
    // a fire out of an observation already on file.
    await scheduleEmailFanOut(ctx, product._id);
    return { ok: true };
  },
});

// What every watch query answers a signed-out caller with: the same shape an
// unknown product gets. Not a throw — a signed-out popup or panel renders a
// sign-in state from "you are watching nothing", and a console full of
// SIGN_IN_REQUIRED errors for the product's most common visitor would be
// noise about the normal case.
const NOT_WATCHING_STATUS = {
  watching: false,
  target: null,
  storeNum: null,
  alertPrice: false,
  alertOpenBox: false,
  alertRestock: false,
};

export const status = query({
  args: {
    productId: v.string(),
    sessionToken: v.optional(v.string()),
  },
  returns: v.object({
    watching: v.boolean(),
    target: v.union(v.number(), v.null()),
    storeNum: v.union(v.string(), v.null()),
    alertPrice: v.boolean(),
    alertOpenBox: v.boolean(),
    alertRestock: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const accountId = await scopeAccount(ctx, args.sessionToken);
    if (accountId === null) return NOT_WATCHING_STATUS;

    const product = await ctx.db
      .query("products")
      .withIndex("by_productId", (q) => q.eq("productId", args.productId))
      .unique();
    if (product === null) return NOT_WATCHING_STATUS;

    const set = await watchSet(ctx, accountId, null, product._id);
    const watch = canonical(set.rows);
    const watching = watch !== null && watch.active;
    return {
      watching,
      target: watching ? watch.priceAtWatch : null,
      storeNum: watching ? watch.storeNum ?? null : null,
      // Absent means on, so this is the one flag that is not a plain `=== true`.
      alertPrice: watching && watch.alertPrice !== false,
      alertOpenBox: watching && watch.alertOpenBox === true,
      alertRestock: watching && watch.alertRestock === true,
    };
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
type FireReason = "price" | "openBox" | "restock";

type Fire = {
  productId: string;
  name: string;
  urlPath: string;
  priceAtWatch: number;
  currentPrice: number;
  storeNum: string;
  reason: FireReason;
  /** When the observation behind this firing was last seen. */
  observedAt: number;
  /** Set only on the openBox reason. */
  openBoxPrice?: number;
};

/**
 * Why this watch should notify right now, or null.
 *
 * At most ONE reason per watch, because a watch is one alert and ack disarms
 * it: emitting two rows would produce two toasts the single ack could not
 * both answer. Price wins ties — it is the threshold the person actually
 * typed, where the per-store triggers are standing interest.
 */
async function fireFor(
  ctx: QueryCtx,
  watch: Doc<"watches">,
  now: number,
): Promise<{
  reason: FireReason;
  observedAt: number;
  storeNum: string;
  currentPrice: number;
  openBoxPrice?: number;
} | null> {
  // Price: newest observation from ANY store. Micro Center prices nationally,
  // so the freshest reading is the best reading, and narrowing this to the
  // watch's own store would only delay the alert (see schema.ts).
  //
  // `!== false` rather than a truthiness test: absent means on, for every row
  // written before the flag existed.
  const latest =
    watch.alertPrice === false
      ? null
      : await ctx.db
          .query("pricePoints")
          .withIndex("by_product", (q) => q.eq("productDocId", watch.productDocId))
          .order("desc")
          .first();

  if (latest !== null && latest.price <= watch.priceAtWatch + DROP_EPSILON) {
    return {
      reason: "price",
      observedAt: latest.lastSeenAt,
      storeNum: latest.storeNum,
      currentPrice: latest.price,
    };
  }

  const wantsStoreSignal = watch.alertOpenBox === true || watch.alertRestock === true;
  if (!wantsStoreSignal || !isPhysicalStore(watch.storeNum)) return null;

  // Newest-first at this one store. by_product_store keeps this to a handful of
  // reads per watch rather than a scan of the product's whole history.
  const atStore = await ctx.db
    .query("pricePoints")
    .withIndex("by_product_store", (q) =>
      q.eq("productDocId", watch.productDocId).eq("storeNum", watch.storeNum as string),
    )
    .order("desc")
    .take(STORE_HISTORY_WINDOW);

  const newest = atStore[0];
  if (newest === undefined) return null;

  // The staleness gate. Everything below describes what SOMEBODY SAW, not what
  // is on the shelf now, so past this age we say nothing at all.
  if (now - newest.lastSeenAt > STORE_SIGNAL_MAX_AGE_MS) return null;

  if (watch.alertOpenBox === true && newest.openBoxPrice !== undefined) {
    return {
      reason: "openBox",
      observedAt: newest.lastSeenAt,
      storeNum: newest.storeNum,
      currentPrice: newest.price,
      openBoxPrice: newest.openBoxPrice,
    };
  }

  // Restock needs the TRANSITION, not the state: "in stock" on its own would
  // fire the moment the alert was armed on anything currently available, which
  // is not news. observations.record inserts a new row when inStock changes and
  // patches when it doesn't, so an out-of-stock row inside this window is
  // exactly the evidence that the item came back.
  if (
    watch.alertRestock === true &&
    newest.inStock &&
    atStore.some((p) => !p.inStock)
  ) {
    return {
      reason: "restock",
      observedAt: newest.lastSeenAt,
      storeNum: newest.storeNum,
      currentPrice: newest.price,
    };
  }

  return null;
}

export const check = query({
  args: {
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
      reason: v.union(
        v.literal("price"),
        v.literal("openBox"),
        v.literal("restock"),
      ),
      observedAt: v.number(),
      openBoxPrice: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    // Signed out fires nothing: an empty answer, not an error, because the
    // hourly alarm runs in every browser and most browsers are signed out.
    const accountId = await scopeAccount(ctx, args.sessionToken);
    if (accountId === null) return [];
    const watches = await armedWatches(ctx, accountId);
    const now = Date.now();

    const fires: Fire[] = [];

    for (const watch of watches) {
      const hit = await fireFor(ctx, watch, now);
      if (hit === null) continue;

      const product = await ctx.db.get(watch.productDocId);
      if (product === null) continue;

      fires.push({
        productId: product.productId,
        name: product.name,
        urlPath: product.urlPath,
        priceAtWatch: watch.priceAtWatch,
        currentPrice: hit.currentPrice,
        storeNum: hit.storeNum,
        reason: hit.reason,
        observedAt: hit.observedAt,
        ...(hit.openBoxPrice === undefined ? {} : { openBoxPrice: hit.openBoxPrice }),
      });
    }
    return fires;
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
  // When that price was last actually seen by somebody. The popup shows it
  // beside every row: these numbers age, and a watchlist that renders a
  // month-old price identically to a five-minute-old one is lying by layout.
  observedAt: v.union(v.number(), v.null()),
  lowest: v.number(),
  trend: v.array(v.number()),
  met: v.boolean(),
  // Which triggers are armed, so the popup can say what each row is waiting
  // for rather than showing every watch as a price alert.
  alertPrice: v.boolean(),
  alertOpenBox: v.boolean(),
  alertRestock: v.boolean(),
  // The store the per-store triggers watch. Distinct from `storeNum` above,
  // which is wherever the latest observation happened to come from.
  watchStore: v.union(v.string(), v.null()),
});

type DashboardRow = {
  productId: string;
  name: string;
  urlPath: string;
  storeNum: string;
  target: number;
  currentPrice: number;
  inStock: boolean;
  observedAt: number | null;
  lowest: number;
  trend: number[];
  met: boolean;
  alertPrice: boolean;
  alertOpenBox: boolean;
  alertRestock: boolean;
  watchStore: string | null;
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
    sessionToken: v.optional(v.string()),
  },
  returns: v.array(dashboardRowValidator),
  handler: async (ctx, args) => {
    // Signed out is an empty watchlist, not an error — the popup renders its
    // sign-in state from [] without a console full of refusals.
    const accountId = await scopeAccount(ctx, args.sessionToken);
    if (accountId === null) return [];
    const active = await armedWatches(ctx, accountId);

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

      // Creation order is NOT observation order. `observations.record` patches
      // the newest row for a (product, store) pair when the reading has not
      // changed, so a re-observation bumps an older row's lastSeenAt without
      // inserting anything. These rows span every store, so the newest-CREATED
      // row can be stale while an older-created one carries the most recent
      // reading — which is how the popup came to show a price nobody had seen
      // most recently. Current state reads the greatest lastSeenAt; the trend
      // below stays in creation order, which is what a sparkline wants.
      //
      // Bounded, and knowingly so: past `perProduct` points a recently
      // re-observed but old-created row can fall outside the window entirely.
      // Closing that needs an index carrying lastSeenAt, not a wider take.
      let latest: Doc<"pricePoints"> | null = null;
      for (const p of recent) {
        if (latest === null || p.lastSeenAt > latest.lastSeenAt) latest = p;
      }
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
        observedAt: latest === null ? null : latest.lastSeenAt,
        lowest: lowestSoFar ?? 0,
        trend: downsample(chronological, MAX_TREND_POINTS),
        // "met" is a statement about the price trigger, so a watch whose price
        // trigger is off is never met however low the price goes — otherwise
        // the popup would sort a store-only alert to the top and badge it as
        // ready to fire when it is waiting on something else entirely.
        met:
          watch.alertPrice !== false &&
          currentPrice > 0 &&
          currentPrice <= watch.priceAtWatch + DROP_EPSILON,
        alertPrice: watch.alertPrice !== false,
        alertOpenBox: watch.alertOpenBox === true,
        alertRestock: watch.alertRestock === true,
        watchStore: watch.storeNum ?? null,
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
    // No deviceId: only check() finds fires and check answers nothing to a
    // signed-out caller, so an ack always speaks for the account whose watch
    // fired — there is no device-scoped alert left to dismiss.
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
    const accountId = await requireWatchAccount(ctx, args.sessionToken);

    const product = await ctx.db
      .query("products")
      .withIndex("by_productId", (q) => q.eq("productId", args.productId))
      .unique();
    if (product === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "unknown product" });
    }

    const set = await watchSet(ctx, accountId, null, product._id);

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

// ---------------------------------------------------------------------------
// Email alerts: the push half
//
// The browser half above is a PULL — chrome.alarms wakes hourly, calls check(),
// and raises a toast. It works only while a browser is open, which is exactly
// the case an email is for: the shopper who armed a watch and closed the laptop.
//
// So this half is a PUSH, and the difference is not only direction. check() is
// stateless and re-reports a live fire every hour on purpose (a toast may have
// been missed). Mail cannot work that way — see watches.emailedAt in schema.ts.
// One email per arming, and the marker is what enforces it.
//
// TWO CALLERS REACH IT, and only one of them is a guarantee.
//
//   - `crons.hourly` -> `alerts.sweep`, which scans every armed-and-unsent row.
//     This is the correctness path. It is what makes "you will be told" true,
//     and its interval is the worst case anyone waits.
//   - `observations.report` / `reportBatch` -> `alerts.fanOut`, scheduled off a
//     sighting that actually changed something, carrying only the products that
//     changed. This is an ACCELERATOR WITH NO CORRECTNESS OBLIGATIONS. Every
//     way it can fail — a dropped schedule, a stranded claim, a page nobody
//     visits — resolves into "the sweep sends it within the hour instead of
//     within seconds", which is the behaviour that shipped before it existed.
//
// Both go through claimDueForEmail below, so the two paths cannot both send.
// ---------------------------------------------------------------------------

// Rows a pass will look at, and sends it will prepare from them.
//
// The scan bound is the read budget: each eligible row costs its account (once,
// memoized), its product, fireFor's own reads — one price point always, plus a
// shelf row and up to STORE_HISTORY_WINDOW points when a store trigger is armed
// — and now the sibling window the claim writes over, up to
// MAX_ROWS_PER_PRODUCT more. Call it two dozen documents at the top end, so 400
// rows sits comfortably under the ~16k ceiling even if every one is eligible.
//
// The send bound is the action's: each send is a network round trip, and an
// action that tries 500 of them serially will hit its own time limit and lose
// the tail without recording it. It is a PER-PASS cap, not an hourly one:
// a pass that fills it and sent something schedules another pass at once
// (`alerts.ts`, MAX_HOPS), and anything still owed past the chain waits for
// the next sweep — nothing is dropped, because a row is only marked once it
// has actually been sent.
const EMAIL_SCAN_LIMIT = 400;
const EMAIL_SEND_LIMIT = 100;

// The reactive path's own bounds, both far tighter than the sweep's, because it
// runs off a shopper's page view rather than off a schedule.
//
// PRODUCT: how many changed products one sighting may carry into a fan-out. A
// grid page reads up to 96 cards; a fan-out asked to look at all of them would
// spend its scan budget on a page's worth of products nobody watches. Anything
// past the cap is not lost, it is simply the sweep's again.
//
// SEND: a fan-out is not the backstop and must never behave like one. If a
// single page view genuinely owes more than this many emails, the mail is going
// out anyway on the hour; taking the whole send budget off one shopper's page
// load is how a background accelerator turns into a foreground stall.
export const EMAIL_FANOUT_PRODUCT_LIMIT = 32;
const EMAIL_FANOUT_SEND_LIMIT = 25;

// How long a claim stamped by claimDueForEmail keeps other senders off a row.
//
// DERIVED, not chosen. A claim is held for at most as long as the action that
// took it can run, which is min(the deployment's action time limit, the longest
// the send loop itself can take):
//
//   Convex-runtime action time limit ... 1800s   (there is no "use node" in
//                                                 convex/, so this is the
//                                                 relevant one, not 600s)
//   EMAIL_SEND_LIMIT x MAIL_TIMEOUT_MS ... 1000s (100 sends x 10s worst case)
//
// so 1000s, and 30 minutes leaves ~800s of margin over it. THE COUPLING IS THE
// POINT: raise EMAIL_SEND_LIMIT or MAIL_TIMEOUT_MS and this has to rise with
// them, or a slow sweep begins duplicating its own tail — the claim expiring
// under a sender that is still working is exactly the case it exists to stop.
const EMAIL_CLAIM_TTL_MS = 30 * 60 * 1000;

const emailFireValidator = v.object({
  watchId: v.id("watches"),
  accountId: v.id("accounts"),
  email: v.string(),
  productId: v.string(),
  name: v.string(),
  urlPath: v.string(),
  priceAtWatch: v.number(),
  currentPrice: v.number(),
  storeNum: v.string(),
  reason: v.union(
    v.literal("price"),
    v.literal("openBox"),
    v.literal("restock"),
  ),
  observedAt: v.number(),
  openBoxPrice: v.optional(v.number()),
});

type EmailFire = typeof emailFireValidator.type;
type EmailClaim = { fires: EmailFire[]; scanned: number; truncated: boolean };

/**
 * Armed watches that are firing, have not been emailed for this arming, and
 * belong to an account that switched email alerts on — claimed for the caller
 * in the same transaction that finds them.
 *
 * A MUTATION, WHERE THIS USED TO BE A QUERY, and that is the whole change. With
 * one sender on a schedule, reading was enough: nothing else was looking. With
 * a second sender that fires off page views, two passes can hold the same row
 * at the same moment, and the only thing standing between that and two emails
 * was the marker written after the send — which is deliberately written late,
 * so it cannot arbitrate a race it happens after. Claiming stamps the row
 * inside the read, so the loser of the race reads the claim and skips.
 *
 * The read-only twin is GONE rather than kept beside this, deliberately: a
 * function that answers the same question without claiming is exactly what a
 * future sweep calls by accident.
 *
 * Two modes, one body:
 *   - `productDocIds` absent  -> the sweep. Every armed-and-unsent row.
 *   - `productDocIds` present -> a fan-out. Only rows on those products.
 *
 * Three filters and the ORDER of them is the cost model: the cheap field tests
 * come first so a deployment full of watches belonging to people who never
 * opted in costs one index scan and nothing else. fireFor is last because it is
 * the only step that reads other tables.
 *
 * `truncated` is returned rather than logged-and-forgotten because a silent cap
 * reads as "everyone who was owed mail got it". If it is ever true on the SWEEP
 * the interval is too long for the volume, and that is a fact about the
 * schedule, not about any one watch. On a fan-out it means the opposite and is
 * unremarkable: the tighter send cap did its job and the sweep has the rest.
 */
export const claimDueForEmail = internalMutation({
  args: {
    /** Stamped onto every claimed row, and the handle releaseEmailClaim needs. */
    at: v.number(),
    productDocIds: v.optional(v.array(v.id("products"))),
  },
  returns: v.object({
    fires: v.array(emailFireValidator),
    scanned: v.number(),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args): Promise<EmailClaim> => {
    const reactive = args.productDocIds !== undefined;
    const sendLimit = reactive ? EMAIL_FANOUT_SEND_LIMIT : EMAIL_SEND_LIMIT;

    // Only rows that still owe an email. `take` truncates before any filter
    // runs, so selecting on `active` alone let already-emailed watches hold
    // the first EMAIL_SCAN_LIMIT slots on every run — a watch past the cap was
    // never reached again, which is starvation rather than the delay the
    // truncation warning describes. `emailedAt: undefined` is exactly the
    // "armed and unsent" set, so the cap now bounds a draining backlog.
    let rows: Doc<"watches">[];
    if (args.productDocIds === undefined) {
      rows = await ctx.db
        .query("watches")
        .withIndex("by_active_emailed", (q) => q.eq("active", true).eq("emailedAt", undefined))
        .take(EMAIL_SCAN_LIMIT);
    } else {
      // Deduped and capped HERE rather than trusting the caller. The caps are
      // this function's own invariants, and a rule enforced only at the call
      // site is one caller away from being violated.
      const ids = [...new Set(args.productDocIds)].slice(
        0,
        EMAIL_FANOUT_PRODUCT_LIMIT,
      );
      // Evenly, so one heavily-watched product cannot eat the batch's whole
      // scan budget and leave the other 31 products of the page unread. The
      // sweep covers whatever this misses either way.
      const perProduct = Math.max(
        8,
        Math.floor(EMAIL_SCAN_LIMIT / Math.max(1, ids.length)),
      );
      rows = [];
      for (const productDocId of ids) {
        if (rows.length >= EMAIL_SCAN_LIMIT) break;
        const some = await ctx.db
          .query("watches")
          .withIndex("by_product_active_emailed", (q) =>
            q
              .eq("productDocId", productDocId)
              .eq("active", true)
              .eq("emailedAt", undefined),
          )
          .take(Math.min(perProduct, EMAIL_SCAN_LIMIT - rows.length));
        rows.push(...some);
      }
    }

    const now = args.at;
    const accounts = new Map<Id<"accounts">, Doc<"accounts"> | null>();
    const fires: EmailFire[] = [];
    // One send per (account, product): two browsers that each armed the same
    // product before signing in arrive as two rows, and the person is owed one
    // email, not one per browser. markEmailed marks the siblings too.
    const seen = new Set<string>();
    let truncated = false;

    for (const row of rows) {
      if (fires.length >= sendLimit) {
        truncated = true;
        break;
      }
      // A row with no account has nobody to email — a legacy device-scoped row
      // that no sign-in has adopted. It still fires in the browser.
      if (row.accountId === undefined) continue;
      if (row.emailedAt !== undefined) continue;

      const key = `${row.accountId}:${row.productDocId}`;
      if (seen.has(key)) continue;

      // Somebody else is already sending this one. A claim older than the TTL
      // is treated as absent: the sender that took it cannot still be running,
      // so the row is owed an email nobody is going to send.
      if (
        row.emailClaimedAt !== undefined &&
        now - row.emailClaimedAt < EMAIL_CLAIM_TTL_MS
      ) {
        continue;
      }

      const accountId = row.accountId;
      if (!accounts.has(accountId)) {
        accounts.set(accountId, await ctx.db.get(accountId));
      }
      const account = accounts.get(accountId) ?? null;
      // `=== true`, never truthiness: absent means no, for every account that
      // predates the field and for every one that has not answered.
      if (account === null || account.emailAlerts !== true) continue;

      const hit = await fireFor(ctx, row, now);
      if (hit === null) continue;

      const product = await ctx.db.get(row.productDocId);
      if (product === null) continue;

      seen.add(key);

      // THE CLAIM COVERS THE SIBLING SET, because the send it protects does.
      // markEmailed marks every unsent row an account holds for this product,
      // so a claim that covered only the row we happened to read first would
      // leave the others visible to a concurrent pass, which would fire on one
      // of them and send the second email this whole mechanism exists to stop.
      // Same window, same bound, same condition as markEmailed's loop.
      await ctx.db.patch(row._id, { emailClaimedAt: args.at });
      const siblings = await ctx.db
        .query("watches")
        .withIndex("by_account_product", (q) =>
          q.eq("accountId", accountId).eq("productDocId", row.productDocId),
        )
        .take(MAX_ROWS_PER_PRODUCT);
      for (const sibling of siblings) {
        if (sibling._id === row._id) continue;
        if (sibling.emailedAt !== undefined) continue;
        await ctx.db.patch(sibling._id, { emailClaimedAt: args.at });
      }

      fires.push({
        watchId: row._id,
        accountId,
        email: account.email,
        productId: product.productId,
        name: product.name,
        urlPath: product.urlPath,
        priceAtWatch: row.priceAtWatch,
        currentPrice: hit.currentPrice,
        storeNum: hit.storeNum,
        reason: hit.reason,
        observedAt: hit.observedAt,
        ...(hit.openBoxPrice === undefined
          ? {}
          : { openBoxPrice: hit.openBoxPrice }),
      });
    }

    return { fires, scanned: rows.length, truncated };
  },
});

/**
 * Hand a claimed watch back unsent.
 *
 * Called when the send failed, so the next pass can try again instead of
 * waiting out EMAIL_CLAIM_TTL_MS. Purely an accelerator: doing nothing here
 * would cost the shopper the TTL, never the email.
 *
 * The `at` equality guard is what makes it safe to call late. If the claim on
 * the row is no longer ours — expired, and taken by a pass that is at this
 * moment sending — clearing it would invite a third sender in behind them. So
 * a claim we do not recognise is left exactly where it is.
 */
export const releaseEmailClaim = internalMutation({
  args: { watchId: v.id("watches"), at: v.number() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const watch = await ctx.db.get(args.watchId);
    if (watch === null) return null;
    if (watch.emailClaimedAt === args.at) {
      await ctx.db.patch(watch._id, { emailClaimedAt: undefined });
    }

    // The siblings the claim covered, on the same terms.
    if (watch.accountId === undefined) return null;
    const siblings = await ctx.db
      .query("watches")
      .withIndex("by_account_product", (q) =>
        q.eq("accountId", watch.accountId).eq("productDocId", watch.productDocId),
      )
      .take(MAX_ROWS_PER_PRODUCT);
    for (const row of siblings) {
      if (row._id === watch._id) continue;
      if (row.emailClaimedAt === args.at) {
        await ctx.db.patch(row._id, { emailClaimedAt: undefined });
      }
    }
    return null;
  },
});

/**
 * Stamp a watch as emailed, and its siblings with it.
 *
 * Called only AFTER the send returns, never before: a marker written first
 * would silence a watch whose mail then failed. The claim above is what stops
 * a concurrent sender in the meantime — this marker is the durable record that
 * the message went out, and the two are deliberately different facts.
 *
 * Clears the claim in the same patch, because a marked row needs no protecting:
 * `emailedAt` already takes it out of every candidate index.
 *
 * Idempotent, and deliberately silent about a row it cannot find: the person
 * may have acked or deleted the watch during the seconds the send took, and a
 * throw here would fail a sweep over mail that already went out.
 */
export const markEmailed = internalMutation({
  args: { watchId: v.id("watches"), at: v.number() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const watch = await ctx.db.get(args.watchId);
    if (watch === null) return null;
    await ctx.db.patch(watch._id, {
      emailedAt: args.at,
      emailClaimedAt: undefined,
    });

    // Counted HERE rather than in the sweep, deliberately. This mutation is the
    // durable record that a message went out — the marker is what stops the next
    // sweep re-sending — so bumping in the same transaction makes the counter
    // and the markers incapable of disagreeing. A tally accumulated in the
    // action and written at the end would be lost by a crash that had already
    // marked rows, and would then under-report forever, counters having no
    // decrement path.
    //
    // WHAT THIS NUMBER CAN SUPPORT: sends the provider ACCEPTED, not messages
    // delivered. A 2xx from the mail provider means queued; a bounce or a spam
    // placement happens later and Jackdaw has no webhook to hear about it. It
    // is a floor on mail handed over, and must be labelled that way anywhere it
    // is shown.
    await bump(ctx, "alerts:email:sent");
    await bump(ctx, `alerts:email:sent:day:${utcDay(args.at)}`);

    // The siblings, so a second browser's row for the same product does not
    // produce a second email on the next sweep. Same scope rule the write paths
    // use: an account's rows for one product are one watch.
    if (watch.accountId === undefined) return null;
    const siblings = await ctx.db
      .query("watches")
      .withIndex("by_account_product", (q) =>
        q.eq("accountId", watch.accountId).eq("productDocId", watch.productDocId),
      )
      .take(MAX_ROWS_PER_PRODUCT);
    for (const row of siblings) {
      if (row._id === watch._id) continue;
      if (row.emailedAt !== undefined) continue;
      await ctx.db.patch(row._id, {
        emailedAt: args.at,
        emailClaimedAt: undefined,
      });
    }
    return null;
  },
});
