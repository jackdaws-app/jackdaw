import { defineApp } from "convex/server";
import { v } from "convex/values";
import rateLimiter from "@convex-dev/rate-limiter/convex.config";

const app = defineApp({
  env: {
    // Shared secret for the jackdaws.app/admin.html panel. Optional so a
    // deployment without it still pushes — requireAdmin() in lib.ts fails
    // closed (every admin call is UNAUTHORIZED) when it is unset.
    ADMIN_KEY: v.optional(v.string()),

    // Optional accounts. All three are optional so a deployment that has never
    // heard of accounts still pushes, and every consumer degrades explicitly
    // rather than throwing at import time.

    // Resend API key for delivering sign-in codes. Unset is a supported state:
    // auth:sendCode stores the code and stops, and `npx convex run
    // auth:devPeekCode` becomes the only way to read it. That is the whole
    // development story — no mail account needed to work on sign-in.
    RESEND_API_KEY: v.optional(v.string()),
    // From address for those emails. Defaults to noreply@jackdaws.app, which
    // has to be a domain verified in Resend before anything sends.
    JACKDAW_FROM_EMAIL: v.optional(v.string()),
    // Pepper mixed into every code/session hash (HMAC key). Optional so
    // deploys never fail on it, but it is the difference between a stolen
    // database being useless and a stolen database being a live sign-in code:
    // a 6-digit code has a million preimages, so an unpeppered digest of one
    // is reversible in milliseconds. Set it on both deployments. Rotating it
    // invalidates every outstanding code and session, which is a feature.
    AUTH_PEPPER: v.optional(v.string()),
  },
});
app.use(rateLimiter);
export default app;
