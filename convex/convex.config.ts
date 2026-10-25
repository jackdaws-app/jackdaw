import { defineApp } from "convex/server";
import { v } from "convex/values";
import rateLimiter from "@convex-dev/rate-limiter/convex.config";

const app = defineApp({
  env: {
    // Fallback secret for the jackdaws.app/admin.html panel, and the escape
    // hatch during the move to account-based admin. Optional so a deployment
    // without it still pushes: requireAdmin() in lib.ts refuses the key path
    // when it is unset. That is no longer the same as closing the panel — an
    // account with isAdmin true still gets in through the session door, which
    // is exactly how this variable is meant to be retired.
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
    // Pepper mixed into every code/session hash (HMAC key). It is the
    // difference between a stolen database being useless and a stolen
    // database being a live sign-in code: a 6-digit code has a million
    // preimages, so an unpeppered digest of one is reversible in milliseconds.
    //
    // Optional HERE so a deploy never fails on it — but every call that
    // hashes a secret does. lib.ts hashSecret refuses SERVER_MISCONFIGURED
    // when this is unset, so on such a deployment requesting a code, signing
    // in and resolving any session all fail loudly instead of hashing under a
    // key from the public source, which is what they used to do. Anonymous
    // reads never hash and keep working. Set it on both deployments to 256
    // bits of hex (`openssl rand -hex 32`); the length is not enforced, so it
    // is on whoever sets it. Rotating it invalidates every outstanding code,
    // session and unsubscribe link, which is a feature.
    AUTH_PEPPER: v.optional(v.string()),
  },
});
app.use(rateLimiter);
export default app;
