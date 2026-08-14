import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { flaggedComments, resolveCommentReport } from "./lib";

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
    const rows = await flaggedComments(ctx);
    return rows.map((c) => ({
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
 *
 * The implementation lives in lib.ts so the CLI path here and the key-gated
 * `dashboard:resolve` used by the web panel can never drift apart.
 */
export const resolve = internalMutation({
  args: {
    commentId: v.id("comments"),
    action: v.union(v.literal("unhide"), v.literal("delete")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await resolveCommentReport(ctx, args.commentId, args.action);
    return null;
  },
});
