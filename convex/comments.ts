import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  bump,
  enforceRateLimit,
  separatorFoldedForm,
  requireCleanContent,
  requireLength,
  resolveSession,
  utcDay,
} from "./lib";

const AUTO_HIDE_REPORT_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Who a comment is from
//
// Participation moved behind sign-in on 2026-08-20 (owner's call). Reading a
// thread stays anonymous — comments:list takes no identity at all beyond an
// optional token used to mark the caller's own votes — but posting, voting and
// reporting all require a session that resolves to an account, because a
// deviceId is a string the client invents: "one vote per device" was one vote
// per curl call, and the auto-hide threshold was five of them. The account is
// the only identity here the caller cannot mint.
//
// What the sign-in gate replaced: the anonymous author path — a free-text
// displayName run through the content filter (both forms), NAME_RESERVED for
// the reserved-handle set, and NAME_CLAIMED for live or retired handle keys.
// All three refusals existed to keep an untyped name from impersonating a
// ticked one, and they are unreachable now that every byline is a claimed
// handle written by the server. The claim machinery itself (handleKey
// uniqueness, retiredHandles, the reserved list) is untouched in auth.ts —
// it is what makes the handle worth writing.
//
// Two states remain:
//
//  1. Signed in with a handle — the SERVER writes the name. There is no
//     displayName argument any more: a caller who could choose the name on a
//     ticked comment could wear anyone's, and every comment is ticked now.
//  2. Signed in without one — NEED_HANDLE, and nothing is written. The claim
//     step is a fork in the flow, not an error, but it does have to happen
//     before there is a comment to attribute.
//
// No session — or a malformed, expired or orphaned token — is SIGN_IN_REQUIRED,
// thrown in the same style as every other refusal in this file. The client
// keeps the typed body on any thrown refusal (the panel returns before
// re-render), so the cost of the gate is a sign-in, never a retype.
// ---------------------------------------------------------------------------

/**
 * The account this call speaks for, or a thrown SIGN_IN_REQUIRED.
 *
 * Thrown BEFORE any rate-limit token is consumed, deliberately: a signed-out
 * client is not spending anyone's bucket, and the throw rolls back nothing
 * because nothing has been written yet.
 */
async function requireAccount(
  ctx: MutationCtx,
  sessionToken: string | undefined,
): Promise<Doc<"accounts">> {
  const resolved =
    sessionToken === undefined || sessionToken.length === 0
      ? null
      : await resolveSession(ctx, sessionToken);
  if (resolved === null) {
    throw new ConvexError({
      code: "SIGN_IN_REQUIRED",
      message: "Sign in to do that",
    });
  }
  return resolved.account;
}

/** The rate-limit key for an account. Never a deviceId: the account is the
 * caller's identity now, and two browsers signed into one account share one
 * bucket — which is the point. */
function acctKey(account: Doc<"accounts">): string {
  return `acct:${account._id}`;
}

/** The caller's account for vote-marking in `list`, or null. Never throws:
 * an anonymous reader is the normal state of a public thread. */
async function optionalAccount(
  ctx: QueryCtx,
  sessionToken: string | undefined,
): Promise<Doc<"accounts"> | null> {
  if (sessionToken === undefined || sessionToken.length === 0) return null;
  const resolved = await resolveSession(ctx, sessionToken);
  return resolved === null ? null : resolved.account;
}

export const list = query({
  args: {
    productId: v.string(),
    // Only used to mark the caller's own votes. Absent, malformed or expired
    // reads the thread exactly as any anonymous visitor does, with myVote 0
    // everywhere — reading stays public.
    sessionToken: v.optional(v.string()),
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

    const account = await optionalAccount(ctx, args.sessionToken);

    const comments = await ctx.db
      .query("comments")
      .withIndex("by_product", (q) => q.eq("productDocId", product._id))
      .order("desc")
      .take(200);

    return await Promise.all(
      comments.map(async (c) => {
        const hidden = c.hidden === true;
        // Account-keyed: a vote cast in one browser shows as "mine" in every
        // browser signed into the same account. Legacy device-keyed vote rows
        // have accountId undefined and match nobody, which is the accepted
        // cost of the move — the score they built still counts.
        const myVoteRow =
          account === null
            ? null
            : await ctx.db
                .query("votes")
                .withIndex("by_comment_account", (q) =>
                  q.eq("commentId", c._id).eq("accountId", account._id),
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
 * Post a comment. Requires a session resolving to an account with a claimed
 * handle; the SERVER writes the byline from that handle. There is no
 * displayName argument — the anonymous author path is gone, and a signed-in
 * caller's copy was never read anyway.
 *
 * Throws ConvexError { code: "SIGN_IN_REQUIRED" } for no/invalid session, and
 * { code: "NEED_HANDLE" } when the session resolves to an account that hasn't
 * claimed one. Both are decided before the rate-limit token is consumed, so
 * neither refusal can burn the bucket — and neither needs the in-band answer
 * claimHandle uses, because nothing has been written when they throw.
 */
export const add = mutation({
  args: {
    productId: v.string(),
    // Stored on the row as the posting browser, exactly as before — the
    // author is the account, but a device column that survives
    // auth:deleteAccount is what keeps old threads attributable to *a*
    // browser after the tick is gone.
    deviceId: v.string(),
    body: v.string(),
    parentId: v.optional(v.id("comments")),
    // Optional in the validator so a signed-out client gets the clean
    // SIGN_IN_REQUIRED refusal rather than an ArgumentValidationError.
    sessionToken: v.optional(v.string()),
  },
  returns: v.id("comments"),
  handler: async (ctx, args) => {
    const deviceId = requireLength("deviceId", args.deviceId, 1, 100);
    const body = requireLength("body", args.body, 1, 2000);

    const account = await requireAccount(ctx, args.sessionToken);
    if (account.handle === undefined) {
      throw new ConvexError({
        code: "NEED_HANDLE",
        message: "Pick a handle before posting",
      });
    }

    await enforceRateLimit(ctx, "commentAdd", acctKey(account));

    requireCleanContent(body);
    // Both forms, the same pair of passes a handle claim gets. The body filter
    // used to check only the raw text, which meant "shit_head" posted and
    // "shit-head" did not — the underscore is a word character to `\b`, so it
    // hid the word from the blocklist. A filter the careless can step over by
    // accident is just an inconsistent one.
    requireCleanContent(separatorFoldedForm(body));

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
      // The server signs the comment. Never set from an argument.
      displayName: account.handle,
      body,
      score: 0,
      voteCount: 0,
      parentId: args.parentId,
      accountId: account._id,
    });

    await bump(ctx, "comments:total");
    await bump(ctx, `comments:day:${utcDay(Date.now())}`);

    return commentId;
  },
});

export const vote = mutation({
  args: {
    commentId: v.id("comments"),
    value: v.union(v.literal(1), v.literal(-1), v.literal(0)),
    sessionToken: v.optional(v.string()),
  },
  returns: v.object({ score: v.number() }),
  handler: async (ctx, args) => {
    // Voting needs an account but not a handle: nothing it writes carries a
    // byline. SIGN_IN_REQUIRED lands before the rate-limit token is spent.
    const account = await requireAccount(ctx, args.sessionToken);

    await enforceRateLimit(ctx, "commentVote", acctKey(account));

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

    // One vote per ACCOUNT per comment: two browsers signed into the same
    // account resolve to the same row, so they cannot double-vote. Legacy
    // device-keyed rows have accountId undefined and never match here — they
    // stand as counted history, not as anyone's current vote.
    const existing = await ctx.db
      .query("votes")
      .withIndex("by_comment_account", (q) =>
        q.eq("commentId", args.commentId).eq("accountId", account._id),
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
        accountId: account._id,
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
    sessionToken: v.optional(v.string()),
  },
  returns: v.object({ ok: v.boolean(), alreadyReported: v.boolean() }),
  handler: async (ctx, args) => {
    const account = await requireAccount(ctx, args.sessionToken);

    const comment = await ctx.db.get(args.commentId);
    if (comment === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "unknown comment" });
    }

    // Dedupe per (commentId, accountId): a repeat report is a no-op and does
    // not consume a rate-limit token. The threshold below therefore means
    // five distinct ACCOUNTS — each behind an email sign-in — where it used
    // to mean five strings a client invented.
    const existing = await ctx.db
      .query("reports")
      .withIndex("by_comment_account", (q) =>
        q.eq("commentId", args.commentId).eq("accountId", account._id),
      )
      .unique();
    if (existing !== null) {
      return { ok: true, alreadyReported: true };
    }

    await enforceRateLimit(ctx, "commentReport", acctKey(account));

    await ctx.db.insert("reports", {
      commentId: args.commentId,
      accountId: account._id,
    });
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
