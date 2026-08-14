import { defineApp } from "convex/server";
import { v } from "convex/values";
import rateLimiter from "@convex-dev/rate-limiter/convex.config";

const app = defineApp({
  env: {
    // Shared secret for the jackdaws.app/admin.html panel. Optional so a
    // deployment without it still pushes — requireAdmin() in lib.ts fails
    // closed (every admin call is UNAUTHORIZED) when it is unset.
    ADMIN_KEY: v.optional(v.string()),
  },
});
app.use(rateLimiter);
export default app;
