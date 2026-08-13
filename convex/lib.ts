import { ConvexError } from "convex/values";
import { HOUR, MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";

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
