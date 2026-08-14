import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { EVENT_NAMES, bump, rateLimiter, utcDay } from "./lib";
import type { EventName } from "./lib";

/**
 * A notification click — the one moment Jackdaw can honestly claim it sent
 * someone to a Micro Center product page.
 *
 * Deliberately takes NO arguments. Not a device id, not a product id, nothing
 * that could reconstitute a person's browsing from the aggregate. The
 * extension calls it as `metrics:alertClicked {}` and discards the result.
 *
 * Two properties of this endpoint the number must be read with:
 *
 * 1. Anonymity costs verifiability. With no identifier there is nothing to
 *    key a per-device limit on, so the bucket below is global — and because
 *    the endpoint is public, unauthenticated and open source, anyone can call
 *    it. The rate limit bounds fabrication, it does not prevent it. Treat this
 *    as "clicks recorded", not "clicks proven".
 * 2. That same global bucket caps the metric at 60/hour (~1,440/day) across
 *    all users. Real clicks beyond that are dropped, not queued, so the figure
 *    reads low once click volume gets real.
 */
export const alertClicked = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const { ok } = await rateLimiter.limit(ctx, "alertClick", {
      key: "global",
    });
    // Over budget: drop it silently. Throwing would roll back the transaction
    // anyway, and the caller is a fire-and-forget beacon that ignores errors.
    if (!ok) return null;

    await bump(ctx, "alerts:clicked");
    await bump(ctx, `alerts:clicked:day:${utcDay(Date.now())}`);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Client health telemetry
// ---------------------------------------------------------------------------

// A batch carries one entry per event kind, so six is the natural maximum;
// twelve leaves room for a client that sends duplicates without inventing a
// reason to reject an otherwise honest report.
const MAX_EVENTS = 12;
// Per-name ceiling within one batch. The extension buffers while offline and
// flushes on the next load, so a count well above 1 is normal — but a number
// larger than this is a bug or a fabrication, not a measurement.
const MAX_COUNT = 500;
const MIN_COUNT = 1;

/**
 * Closed union of the six names in EVENT_NAMES, built from that list so the
 * set the backend accepts and the set the dashboard renders cannot drift
 * apart. Anything else is rejected by Convex's argument validation before the
 * handler runs, which is what stops a caller from writing arbitrary keys into
 * the shared counters table.
 */
const eventNameValidator = v.union(
  ...EVENT_NAMES.map((name) => v.literal(name)),
);

/**
 * Clamp a client-supplied count into [1, 500] instead of rejecting the batch.
 *
 * A wrong count is a telemetry inaccuracy; a thrown error loses the whole
 * batch, including the events that were fine — the opposite of what an early
 * warning signal is for. Rounding handles fractions, the min/max handle zero,
 * negatives and ±Infinity, and NaN (which no comparison can order) falls to
 * the floor: "this happened at least once" is the honest reading of a count
 * the client managed to corrupt.
 */
function clampCount(raw: number): number {
  if (Number.isNaN(raw)) return MIN_COUNT;
  return Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(raw)));
}

/**
 * Aggregate client health, batched by the extension and flushed on load.
 *
 * WHAT THIS CARRIES: six fixed names and a count each. No device id, no
 * product, no store, no URL, no message, no stack — nothing free-form at all.
 * The name is a closed union (see above), so the only thing a caller can
 * influence is how much six known counters advance. That is deliberate: this
 * endpoint exists because a silent breakage is currently invisible until a
 * review shows up, not because per-user debugging would be convenient.
 *
 * Two properties the numbers must be read with, both inherited from being
 * anonymous and public:
 *
 * 1. Fabrication is bounded, not prevented. As with metrics:alertClicked
 *    there is no identifier to key a per-device bucket on, so the limit is one
 *    global bucket and anyone can call this. Treat a spike as "worth looking
 *    at", never as a proven count.
 * 2. That bucket caps the whole deployment at 3,000 batches/hour. A client
 *    flushes once per hourly alarm, so that is roughly the supported user
 *    count — and past it reports are dropped rather than queued, so a
 *    breakage large enough to saturate the bucket reads LOW at exactly the
 *    moment it should spike. A flat line is not evidence of health.
 *
 * With the fold clamp below, one accepted batch can move the counters by at
 * most 500 per name (3,000 across all six) — the same ceiling an honest client
 * observes for itself. A deliberate poisoner still has the rate limit as their
 * only real bound, which is the price of an anonymous endpoint; the counters
 * are advisory, and a spike is a prompt to go look, never a measurement.
 *
 * Over budget returns { ok: false, rateLimited: true } instead of throwing: a
 * mutation that throws rolls back its own writes (see lib.ts's tryRateLimit),
 * and the caller is a fire-and-forget beacon that discards the result anyway,
 * so an in-band refusal costs nothing and keeps the door open to counting
 * these drops later.
 */
export const events = mutation({
  args: {
    events: v.array(v.object({ name: eventNameValidator, count: v.number() })),
  },
  returns: v.object({ ok: v.boolean(), rateLimited: v.boolean() }),
  handler: async (ctx, args) => {
    if (args.events.length > MAX_EVENTS) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `at most ${MAX_EVENTS} events per batch`,
      });
    }

    const { ok } = await rateLimiter.limit(ctx, "clientEvents", {
      key: "global",
    });
    if (!ok) return { ok: false, rateLimited: true };

    // Fold duplicates first so the write count is bounded by the number of
    // names (6 keys × 2 rows), not by the batch length — then clamp the fold
    // itself, not just the individual entries.
    //
    // MAX_COUNT is a per-name ceiling for the whole batch, and clamping only
    // per entry lets a caller route around it by repeating a name: twelve
    // entries of 500 would land 6,000 on one counter. No honest client can do
    // that — the extension buffers in an object keyed by name, so one entry
    // per name is the most it can produce — which makes anything above 500 for
    // a single name in a single batch a bug or an attempt to inflate the
    // number. Clamped rather than rejected, so a malformed batch still reports
    // the events it got right.
    const totals = new Map<EventName, number>();
    for (const event of args.events) {
      const folded = (totals.get(event.name) ?? 0) + clampCount(event.count);
      totals.set(event.name, Math.min(MAX_COUNT, folded));
    }

    const day = utcDay(Date.now());
    for (const [name, count] of totals) {
      await bump(ctx, `evt:${name}`, count);
      await bump(ctx, `evt:${name}:day:${day}`, count);
    }

    return { ok: true, rateLimited: false };
  },
});
