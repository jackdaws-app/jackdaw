import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  bump,
  enforceRateLimit,
  handleFilterForm,
  handleKeyOf,
  isReservedHandleKey,
  requireCleanContent,
  requireLength,
  resolveSession,
  utcDay,
} from "./lib";

const AUTO_HIDE_REPORT_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Who a comment is from
//
// Three states, and the whole identity model lives in the gap between them:
//
//  1. Signed in with a handle — the SERVER writes the name. The client's
//     displayName argument is not read at all, because a caller who could
//     choose the name on a ticked comment could wear anyone's.
//  2. Signed in without one — NEED_HANDLE, and nothing is written. The claim
//     step is a fork in the flow, not an error, but it does have to happen
//     before there is a comment to attribute.
//  3. Anonymous — free-text name, no tick, exactly as it has always worked.
//     Three refusals stand between the typed string and the byline, checked in
//     this order:
//
//       · The content filter, on the name AND on its separator-folded form.
//         "_" is a word character to JavaScript's `\b`, so a word-boundary
//         blocklist catches "shit-head" and waves "shit_head" through; the
//         second pass is what closes that. Both forms, the same two checks
//         auth:claimHandle does — a name is a name whichever door it came in
//         by, and the fix belonged on both or neither.
//
//       · NAME_RESERVED, when the fold lands in RESERVED_HANDLE_KEYS —
//         "Jackdaw Support", "Micro Center Staff", "M-o-d". Checked on the
//         folded key, so every spelling goes at once. This one is NOT about the
//         tick: nobody may claim these names either, so no ticked/unticked pair
//         can form. It is here because impersonating support is worth refusing
//         on its own terms — the reader most likely to be taken in by a comment
//         signed "Jackdaw Support" is exactly the reader who doesn't yet know
//         what the marker means. Pure set membership with no database read,
//         which is why it precedes the lookups below: a reserved name should
//         never cost two index probes.
//
//       · NAME_CLAIMED, when the fold is a live or retired handle key. THIS is
//         the refusal the tick depends on; without it an unticked "hex_byte"
//         sits in the same thread as the ticked one and the reader learns to
//         ignore the marker.
//
//     RESERVED and CLAIMED stay separate codes rather than one stretched
//     NAME_CLAIMED because they are different facts about the name — nobody may
//     ever hold this one, versus somebody already does — and only the second
//     has "sign in and claim it yourself" as an answer.
//
// What the reservation does NOT cover, and no key-folding scheme could: a
// visually confusable name built from characters the fold can't map, e.g. a
// Cyrillic "е" in "hеx_byte" (key "hxbyte"). Handles themselves are ASCII-only
// so no such name can ever be *claimed* — the tick stays trustworthy — but a
// lookalike can still be typed anonymously. The marker is the guarantee; the
// spelling is not.
// ---------------------------------------------------------------------------

/** Name and account for a new comment, per the three paths above. */
async function resolveAuthor(
  ctx: MutationCtx,
  sessionToken: string | undefined,
  submittedName: string,
): Promise<{ displayName: string; accountId: Id<"accounts"> | undefined }> {
  // An absent, malformed or expired token is the anonymous path and never an
  // error — a signed-out client is the normal state of this product.
  const resolved =
    sessionToken === undefined || sessionToken.length === 0
      ? null
      : await resolveSession(ctx, sessionToken);

  if (resolved !== null) {
    if (resolved.account.handle === undefined) {
      throw new ConvexError({
        code: "NEED_HANDLE",
        message: "Pick a handle before posting",
      });
    }
    return {
      displayName: resolved.account.handle,
      accountId: resolved.account._id,
    };
  }

  const displayName = requireLength("displayName", submittedName, 1, 40);
  requireCleanContent(displayName);
  // Second pass with separators as spaces: "_" is a word character to `\b`, so
  // the raw form alone lets "shit_head" past the blocklist. See handleFilterForm.
  requireCleanContent(handleFilterForm(displayName));

  const handleKey = handleKeyOf(displayName);
  if (handleKey.length > 0) {
    // No database read, so it goes first — a reserved name never reaches the
    // two index probes below.
    if (isReservedHandleKey(handleKey)) {
      throw new ConvexError({
        code: "NAME_RESERVED",
        message: "That name is reserved — pick another",
      });
    }
    const claimed = await ctx.db
      .query("accounts")
      .withIndex("by_handleKey", (q) => q.eq("handleKey", handleKey))
      .first();
    const retired =
      claimed !== null
        ? null
        : await ctx.db
            .query("retiredHandles")
            .withIndex("by_handleKey", (q) => q.eq("handleKey", handleKey))
            .first();
    if (claimed !== null || retired !== null) {
      throw new ConvexError({
        code: "NAME_CLAIMED",
        message: "That name is claimed — pick another",
      });
    }
  }

  return { displayName, accountId: undefined };
}

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
      hidden: v.boolean(),
      // True only for a comment posted through a session holding a claimed
      // handle. This is the marker: it says the name beside it is one nobody
      // else can type, not that the words are endorsed.
      verified: v.boolean(),
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
        const hidden = c.hidden === true;
        const myVoteRow = await ctx.db
          .query("votes")
          .withIndex("by_comment_device", (q) =>
            q.eq("commentId", c._id).eq("deviceId", args.deviceId),
          )
          .unique();
        return {
          _id: c._id,
          _creationTime: c._creationTime,
          // Hidden comments keep their slot in the thread but expose no
          // content (and never the report count).
          displayName: hidden ? "" : c.displayName,
          body: hidden ? "" : c.body,
          score: c.score,
          myVote: myVoteRow === null ? (0 as const) : myVoteRow.value,
          parentId: c.parentId ?? null,
          hidden,
          // A hidden row leaks nothing, identity included: with the name and
          // body blanked, a surviving tick would still say "a signed-in member
          // wrote this", which is a fact about the author the moderation
          // action was meant to take off the page.
          verified: hidden ? false : c.accountId !== undefined,
        };
      }),
    );
  },
});

/**
 * Post a comment.
 *
 * `displayName` is what an anonymous commenter is called. A signed-in caller's
 * copy is IGNORED — see resolveAuthor — so the argument stays required for the
 * anonymous path without becoming a way to choose the name on a ticked comment.
 *
 * Throws ConvexError { code: "NEED_HANDLE" } when the session resolves to an
 * account that hasn't claimed a handle; { code: "NAME_RESERVED" } when an
 * anonymous caller types a name nobody may hold; and { code: "NAME_CLAIMED" }
 * when they type one that belongs to someone.
 *
 * These THROW, where auth:claimHandle answers the same kind of refusal in band.
 * The asymmetry is deliberate rather than an oversight. claimHandle's bucket is
 * its only defence, so a thrown refusal — rolling that token back — would erase
 * the limit; it has to commit its verdict. Here the throw does roll the
 * commentAdd token back too, so a caller retyping refused names is never
 * throttled for it, and that is accepted: every refusal above is decided from
 * the argument plus at most two point lookups, and a name already spoken for is
 * visible on the face of any thread it was used in. There is no oracle here
 * worth the grinding.
 */
export const add = mutation({
  args: {
    productId: v.string(),
    deviceId: v.string(),
    displayName: v.string(),
    body: v.string(),
    parentId: v.optional(v.id("comments")),
    sessionToken: v.optional(v.string()),
  },
  returns: v.id("comments"),
  handler: async (ctx, args) => {
    const deviceId = requireLength("deviceId", args.deviceId, 1, 100);
    const body = requireLength("body", args.body, 1, 2000);

    await enforceRateLimit(ctx, "commentAdd", deviceId);

    requireCleanContent(body);

    const { displayName, accountId } = await resolveAuthor(
      ctx,
      args.sessionToken,
      args.displayName,
    );

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

    const commentId = await ctx.db.insert("comments", {
      productDocId: product._id,
      deviceId,
      displayName,
      body,
      score: 0,
      voteCount: 0,
      parentId: args.parentId,
      // undefined for an anonymous comment, which is what makes `verified`
      // false on read. Never set from an argument.
      accountId,
    });

    await bump(ctx, "comments:total");
    await bump(ctx, `comments:day:${utcDay(Date.now())}`);

    return commentId;
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

    await enforceRateLimit(ctx, "commentVote", deviceId);

    const comment = await ctx.db.get(args.commentId);
    if (comment === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "unknown comment" });
    }
    if (comment.hidden === true) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "cannot vote on a hidden comment",
      });
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

export const report = mutation({
  args: {
    commentId: v.id("comments"),
    deviceId: v.string(),
  },
  returns: v.object({ ok: v.boolean(), alreadyReported: v.boolean() }),
  handler: async (ctx, args) => {
    const deviceId = requireLength("deviceId", args.deviceId, 1, 100);

    const comment = await ctx.db.get(args.commentId);
    if (comment === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "unknown comment" });
    }

    // Dedupe per (commentId, deviceId): a repeat report is a no-op and does
    // not consume a rate-limit token.
    const existing = await ctx.db
      .query("reports")
      .withIndex("by_comment_device", (q) =>
        q.eq("commentId", args.commentId).eq("deviceId", deviceId),
      )
      .unique();
    if (existing !== null) {
      return { ok: true, alreadyReported: true };
    }

    await enforceRateLimit(ctx, "commentReport", deviceId);

    await ctx.db.insert("reports", { commentId: args.commentId, deviceId });
    const reportCount = (comment.reportCount ?? 0) + 1;
    await ctx.db.patch(args.commentId, {
      reportCount,
      ...(reportCount >= AUTO_HIDE_REPORT_THRESHOLD ? { hidden: true } : {}),
    });

    await bump(ctx, "reports:total");
    // Count the transition, not the state: a comment already hidden (or
    // re-reported past the threshold) must not bump the tally again.
    if (reportCount >= AUTO_HIDE_REPORT_THRESHOLD && comment.hidden !== true) {
      await bump(ctx, "comments:hidden");
    }

    return { ok: true, alreadyReported: false };
  },
});
