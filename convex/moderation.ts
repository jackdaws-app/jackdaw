import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

/**
 * Admin-only (run via `npx convex run moderation:flagged`): comments with at
 * least one report, newest first, up to 100.
 */
export const flagged = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("comments"),
      _creationTime: v.number(),
      productDocId: v.id("products"),
      displayName: v.string(),
      body: v.string(),
      reportCount: v.number(),
      hidden: v.boolean(),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("comments")
      .withIndex("by_reportCount", (q) => q.gte("reportCount", 1))
      .take(500);
    rows.sort((a, b) => b._creationTime - a._creationTime);
    return rows.slice(0, 100).map((c) => ({
      _id: c._id,
      _creationTime: c._creationTime,
      productDocId: c.productDocId,
      displayName: c.displayName,
      body: c.body,
      reportCount: c.reportCount ?? 0,
      hidden: c.hidden === true,
    }));
  },
});

/**
 * Admin-only (run via `npx convex run moderation:resolve`).
 * - "unhide": clear hidden + reportCount and delete the comment's reports.
 * - "delete": remove the comment, its reports and votes, and re-parent its
 *   direct children to the deleted comment's parent (or top level).
 */
export const resolve = internalMutation({
  args: {
    commentId: v.id("comments"),
    action: v.union(v.literal("unhide"), v.literal("delete")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const comment = await ctx.db.get(args.commentId);
    if (comment === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "unknown comment" });
    }

    const reports = await ctx.db
      .query("reports")
      .withIndex("by_comment", (q) => q.eq("commentId", args.commentId))
      .collect();
    for (const r of reports) {
      await ctx.db.delete(r._id);
    }

    if (args.action === "unhide") {
      await ctx.db.patch(args.commentId, {
        hidden: undefined,
        reportCount: undefined,
      });
      return null;
    }

    // action === "delete"
    const votes = await ctx.db
      .query("votes")
      .withIndex("by_comment", (q) => q.eq("commentId", args.commentId))
      .collect();
    for (const voteRow of votes) {
      await ctx.db.delete(voteRow._id);
    }

    // Re-parent direct children so threads don't orphan.
    const children = await ctx.db
      .query("comments")
      .withIndex("by_parent", (q) => q.eq("parentId", args.commentId))
      .collect();
    for (const child of children) {
      await ctx.db.patch(child._id, { parentId: comment.parentId });
    }

    await ctx.db.delete(args.commentId);
    return null;
  },
});
