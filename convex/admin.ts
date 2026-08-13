import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

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
