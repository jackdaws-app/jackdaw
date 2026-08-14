import { ConvexError } from "convex/values";
import { HOUR, MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";
import { env } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/** Strip C0/C1 control characters (incl. DEL) and trim. */
export function sanitize(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
}

export function requireLength(
  field: string,
  value: string,
  min: number,
  max: number,
): string {
  const cleaned = sanitize(value);
  if (cleaned.length < min || cleaned.length > max) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${field} must be between ${min} and ${max} characters`,
    });
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Rate limiting (token bucket, keyed per deviceId)
// ---------------------------------------------------------------------------

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  commentAdd: { kind: "token bucket", rate: 5, period: 10 * MINUTE },
  commentVote: { kind: "token bucket", rate: 30, period: MINUTE },
  commentReport: { kind: "token bucket", rate: 10, period: HOUR },
  priceReport: { kind: "token bucket", rate: 120, period: HOUR },
  // Global (not per-device) ceiling on admin traffic. Read the note above
  // enforceAdminRateLimit before treating this as anti-guessing protection.
  adminAuth: { kind: "token bucket", rate: 20, period: MINUTE },
});

export type RateLimitName =
  | "commentAdd"
  | "commentVote"
  | "commentReport"
  | "priceReport";

/**
 * Consume one token from the named per-device bucket, or throw
 * ConvexError { code: "RATE_LIMITED", retryAfter } (retryAfter in ms).
 */
export async function enforceRateLimit(
  ctx: MutationCtx,
  name: RateLimitName,
  deviceId: string,
): Promise<void> {
  const { ok, retryAfter } = await rateLimiter.limit(ctx, name, {
    key: deviceId,
  });
  if (!ok) {
    throw new ConvexError({
      code: "RATE_LIMITED",
      message: "Too many requests — slow down",
      retryAfter,
    });
  }
}

// ---------------------------------------------------------------------------
// Admin authentication (shared secret, for the jackdaws.app/admin.html panel)
// ---------------------------------------------------------------------------

// One fixed bucket key: the point is to cap admin attempts deployment-wide,
// not per caller (a brute-forcer would just rotate their own key).
const ADMIN_BUCKET_KEY = "admin";

/**
 * Length check, then a full XOR sweep of every char code — no early return, so
 * the comparison doesn't leak the matching prefix length through timing.
 */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Gate an admin function on the shared secret. Fails closed: when ADMIN_KEY is
 * unset on the deployment, every call is UNAUTHORIZED rather than open.
 * Throws ConvexError { code: "UNAUTHORIZED" }.
 */
export function requireAdmin(key: string): void {
  const expected = env.ADMIN_KEY;
  if (expected === undefined || expected.length === 0) {
    throw new ConvexError({
      code: "UNAUTHORIZED",
      message: "admin access is not configured",
    });
  }
  if (!secretsMatch(key, expected)) {
    throw new ConvexError({
      code: "UNAUTHORIZED",
      message: "invalid admin key",
    });
  }
}

/**
 * Consume one adminAuth token (mutations only — this writes).
 *
 * WHAT THIS DOES NOT DO: throttle key guessing. It is called before
 * requireAdmin so a wrong key would drain the bucket, but a Convex mutation
 * that throws rolls back its whole transaction — including this component's
 * write — so a rejected attempt costs the attacker nothing. Verified against
 * the dev deployment: 26 consecutive wrong-key calls all returned
 * UNAUTHORIZED and none were ever rate limited, while successful mutations do
 * consume tokens normally.
 *
 * Recording a failed attempt is impossible from inside a query or mutation for
 * that reason; it would take a non-transactional action wrapping the whole
 * admin surface. What actually keeps the panel shut is the 256-bit ADMIN_KEY
 * compared by requireAdmin — this bucket is a ceiling on sustained *authorized*
 * traffic (a runaway polling panel), not a lock.
 */
export async function enforceAdminRateLimit(ctx: MutationCtx): Promise<void> {
  const { ok, retryAfter } = await rateLimiter.limit(ctx, "adminAuth", {
    key: ADMIN_BUCKET_KEY,
  });
  if (!ok) {
    throw new ConvexError({
      code: "RATE_LIMITED",
      message: "Too many admin requests — slow down",
      retryAfter,
    });
  }
}

/**
 * Read-only variant for admin queries. Queries cannot write at all, so this
 * never consumes a token — it only refuses to serve while admin mutations have
 * already drained the shared bucket. Same caveat as
 * {@link enforceAdminRateLimit}: the key is the lock, this is a ceiling.
 */
export async function checkAdminRateLimit(ctx: QueryCtx): Promise<void> {
  const { ok, retryAfter } = await rateLimiter.check(ctx, "adminAuth", {
    key: ADMIN_BUCKET_KEY,
  });
  if (!ok) {
    throw new ConvexError({
      code: "RATE_LIMITED",
      message: "Too many admin requests — slow down",
      retryAfter,
    });
  }
}

// ---------------------------------------------------------------------------
// Metrics counters
// ---------------------------------------------------------------------------

/** UTC calendar day (YYYY-MM-DD) for a millisecond timestamp. */
export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Add `delta` to the named counter, creating the row on first sighting.
 * Negative deltas are allowed (moderation removes rows the state counters
 * track) and the result is floored at 0 — a count below zero is never a true
 * reading, only a sign the counter started behind the data.
 */
export async function bump(
  ctx: MutationCtx,
  key: string,
  delta = 1,
): Promise<void> {
  const row = await ctx.db
    .query("counters")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (row === null) {
    await ctx.db.insert("counters", { key, value: Math.max(0, delta) });
  } else {
    await ctx.db.patch(row._id, { value: Math.max(0, row.value + delta) });
  }
}

/** Overwrite the named counter (used by the idempotent backfill). */
export async function setCounter(
  ctx: MutationCtx,
  key: string,
  value: number,
): Promise<void> {
  const row = await ctx.db
    .query("counters")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (row === null) {
    await ctx.db.insert("counters", { key, value });
  } else if (row.value !== value) {
    await ctx.db.patch(row._id, { value });
  }
}

/**
 * Create the counter at `value` if it doesn't exist yet; leave an existing row
 * untouched. For event tallies the current data can't reconstruct, so a repeat
 * backfill can't wipe what live traffic has since accumulated.
 */
export async function initCounter(
  ctx: MutationCtx,
  key: string,
  value: number,
): Promise<void> {
  const row = await ctx.db
    .query("counters")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (row === null) {
    await ctx.db.insert("counters", { key, value });
  }
}

/** Read a counter, treating a missing row as 0. */
export async function readCounter(ctx: QueryCtx, key: string): Promise<number> {
  const row = await ctx.db
    .query("counters")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  return row === null ? 0 : row.value;
}

// ---------------------------------------------------------------------------
// Moderation (shared by the internal moderation:* CLI functions and the
// authenticated dashboard:* panel functions — one implementation, two doors)
// ---------------------------------------------------------------------------

/**
 * Comments with at least one report, newest first, up to 100. The index range
 * excludes never-reported comments (their reportCount is undefined, which
 * sorts below 1), so this stays bounded as the table grows.
 */
export async function flaggedComments(ctx: QueryCtx) {
  const rows = await ctx.db
    .query("comments")
    .withIndex("by_reportCount", (q) => q.gte("reportCount", 1))
    .take(500);
  rows.sort((a, b) => b._creationTime - a._creationTime);
  return rows.slice(0, 100);
}

/**
 * - "unhide": clear hidden + reportCount and delete the comment's reports.
 * - "delete": remove the comment, its reports and votes, and re-parent its
 *   direct children to the deleted comment's parent (or top level).
 *
 * Moderation is the only path that deletes these rows, so it is also the only
 * path that has to walk the counters back down. Keeping them in step here is
 * what makes `admin:backfillCounters` a no-op on a healthy deployment instead
 * of a correction: comments:total, comments:hidden and reports:total always
 * equal what a fresh count of the tables would produce.
 */
export async function resolveCommentReport(
  ctx: MutationCtx,
  commentId: Id<"comments">,
  action: "unhide" | "delete",
): Promise<void> {
  const comment = await ctx.db.get(commentId);
  if (comment === null) {
    throw new ConvexError({ code: "NOT_FOUND", message: "unknown comment" });
  }

  const reports = await ctx.db
    .query("reports")
    .withIndex("by_comment", (q) => q.eq("commentId", commentId))
    .collect();
  for (const r of reports) {
    await ctx.db.delete(r._id);
  }
  if (reports.length > 0) await bump(ctx, "reports:total", -reports.length);
  // Both actions clear the hidden state, so a hidden comment leaves the
  // hidden tally exactly once either way.
  if (comment.hidden === true) await bump(ctx, "comments:hidden", -1);

  if (action === "unhide") {
    await ctx.db.patch(commentId, {
      hidden: undefined,
      reportCount: undefined,
    });
    return;
  }

  // action === "delete"
  const votes = await ctx.db
    .query("votes")
    .withIndex("by_comment", (q) => q.eq("commentId", commentId))
    .collect();
  for (const voteRow of votes) {
    await ctx.db.delete(voteRow._id);
  }

  // Re-parent direct children so threads don't orphan.
  const children = await ctx.db
    .query("comments")
    .withIndex("by_parent", (q) => q.eq("parentId", commentId))
    .collect();
  for (const child of children) {
    await ctx.db.patch(child._id, { parentId: comment.parentId });
  }

  await ctx.db.delete(commentId);
  await bump(ctx, "comments:total", -1);
  await bump(ctx, `comments:day:${utcDay(comment._creationTime)}`, -1);
}

// ---------------------------------------------------------------------------
// Write-time content filters
// ---------------------------------------------------------------------------

// URLs: explicit scheme, www., or a bare domain.tld on a common TLD.
const URL_PATTERNS = [
  /https?:\/\//i,
  /\bwww\.[a-z0-9-]/i,
  /\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|co|gg|xyz|info|biz|me|tv|app|dev|shop|store|online|site|club|link|ly|to|us|uk|ca|de|fr|ru|cn|top|cc)(?=[\s/:?#)\].,!;"']|$)/i,
];

// 10+ consecutive digits, allowing common separators between them.
const PHONE_PATTERN = /(?:\d[\s\-().+]{0,2}){9}\d/;

const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i;

// Modest word-boundary blocklist of unambiguous profanity/slurs (lowercase).
const PROFANITY = [
  "fuck",
  "fucker",
  "fucking",
  "motherfucker",
  "shit",
  "bullshit",
  "bitch",
  "asshole",
  "cunt",
  "dickhead",
  "twat",
  "wanker",
  "whore",
  "slut",
  "nigger",
  "nigga",
  "faggot",
  "retard",
  "kike",
  "spic",
  "tranny",
];
const PROFANITY_PATTERN = new RegExp(`\\b(?:${PROFANITY.join("|")})\\b`, "i");

/**
 * Reject links, contact info, and profanity in user-visible text.
 * Throws ConvexError with codes LINKS_NOT_ALLOWED / CONTACT_INFO_NOT_ALLOWED /
 * CONTENT_REJECTED. Call with already-sanitized text.
 */
export function requireCleanContent(text: string): void {
  if (URL_PATTERNS.some((re) => re.test(text))) {
    throw new ConvexError({
      code: "LINKS_NOT_ALLOWED",
      message: "Links aren't allowed in comments",
    });
  }
  if (PHONE_PATTERN.test(text) || EMAIL_PATTERN.test(text)) {
    throw new ConvexError({
      code: "CONTACT_INFO_NOT_ALLOWED",
      message: "Contact info isn't allowed in comments",
    });
  }
  if (PROFANITY_PATTERN.test(text.toLowerCase())) {
    throw new ConvexError({
      code: "CONTENT_REJECTED",
      message: "Keep it civil — comment rejected",
    });
  }
}
