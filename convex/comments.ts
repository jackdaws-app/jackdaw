import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireLength } from "./lib";

export const list = query({
  args: {
    productId: v.string(),
    deviceId: v.string(),
  },
  returns: v.array(
    v.object({
      _id: v.id("comments"),
      _creationTime: v.number(),
      displayName: v.string(),
      body: v.string(),
      score: v.number(),
      myVote: v.union(v.literal(0), v.literal(1), v.literal(-1)),
      parentId: v.union(v.id("comments"), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const product = await ctx.db
      .query("products")
      .withIndex("by_productId", (q) => q.eq("productId", args.productId))
      .unique();
    if (product === null) return [];

    const comments = await ctx.db
      .query("comments")
      .withIndex("by_product", (q) => q.eq("productDocId", product._id))
      .order("desc")
      .take(200);

    return await Promise.all(
      comments.map(async (c) => {
        const myVoteRow = await ctx.db
          .query("votes")
          .withIndex("by_comment_device", (q) =>
            q.eq("commentId", c._id).eq("deviceId", args.deviceId),
          )
          .unique();
        return {
          _id: c._id,
          _creationTime: c._creationTime,
          displayName: c.displayName,
          body: c.body,
          score: c.score,
          myVote: myVoteRow === null ? (0 as const) : myVoteRow.value,
          parentId: c.parentId ?? null,
        };
      }),
    );
  },
});

export const add = mutation({
  args: {
    productId: v.string(),
    deviceId: v.string(),
    displayName: v.string(),
    body: v.string(),
    parentId: v.optional(v.id("comments")),
  },
  returns: v.id("comments"),
  handler: async (ctx, args) => {
    const deviceId = requireLength("deviceId", args.deviceId, 1, 100);
    const displayName = requireLength("displayName", args.displayName, 1, 40);
    const body = requireLength("body", args.body, 1, 2000);

    const product = await ctx.db
      .query("products")
      .withIndex("by_productId", (q) => q.eq("productId", args.productId))
      .unique();
    if (product === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "unknown product" });
    }

    if (args.parentId !== undefined) {
      const parent = await ctx.db.get(args.parentId);
      if (parent === null) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "unknown parent comment",
        });
      }
      if (parent.productDocId !== product._id) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: "parent comment belongs to a different product",
        });
      }
      // Walk the parent chain to enforce max thread depth of 4 (a top-level
      // comment is depth 1; the new reply counts as one more level).
      const MAX_DEPTH = 4;
      let depth = 2; // new comment + its direct parent
      let ancestorId = parent.parentId;
      while (ancestorId !== undefined) {
        depth++;
        if (depth > MAX_DEPTH) {
          throw new ConvexError({
            code: "INVALID_ARGUMENT",
            message: `thread depth may not exceed ${MAX_DEPTH}`,
          });
        }
        const ancestor = await ctx.db.get(ancestorId);
        if (ancestor === null) break;
        ancestorId = ancestor.parentId;
      }
    }

    return await ctx.db.insert("comments", {
      productDocId: product._id,
      deviceId,
      displayName,
      body,
      score: 0,
      voteCount: 0,
      parentId: args.parentId,
    });
  },
});

export const vote = mutation({
  args: {
    commentId: v.id("comments"),
    deviceId: v.string(),
    value: v.union(v.literal(1), v.literal(-1), v.literal(0)),
  },
  returns: v.object({ score: v.number() }),
  handler: async (ctx, args) => {
    const deviceId = requireLength("deviceId", args.deviceId, 1, 100);

    const comment = await ctx.db.get(args.commentId);
    if (comment === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "unknown comment" });
    }

    const existing = await ctx.db
      .query("votes")
      .withIndex("by_comment_device", (q) =>
        q.eq("commentId", args.commentId).eq("deviceId", deviceId),
      )
      .unique();

    const oldValue = existing === null ? 0 : existing.value;
    const newValue = args.value;
    if (oldValue === newValue) {
      return { score: comment.score };
    }

    if (newValue === 0) {
      if (existing !== null) await ctx.db.delete(existing._id);
    } else if (existing === null) {
      await ctx.db.insert("votes", {
        commentId: args.commentId,
        deviceId,
        value: newValue,
      });
    } else {
      await ctx.db.patch(existing._id, { value: newValue });
    }

    const scoreDelta = newValue - oldValue;
    const voteCountDelta = (newValue === 0 ? 0 : 1) - (oldValue === 0 ? 0 : 1);
    const newScore = comment.score + scoreDelta;
    await ctx.db.patch(args.commentId, {
      score: newScore,
      voteCount: comment.voteCount + voteCountDelta,
    });

    return { score: newScore };
  },
});
