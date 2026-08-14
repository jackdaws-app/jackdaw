import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { bump, rateLimiter, utcDay } from "./lib";

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
