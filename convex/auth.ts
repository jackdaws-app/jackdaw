import { ConvexError, v } from "convex/values";
import {
  action,
  env,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  SESSION_TTL_MS,
  bump,
  separatorFoldedForm,
  handleKeyOf,
  hashSecret,
  isCleanContent,
  isReservedHandleKey,
  isWellFormedHandle,
  normalizeEmail,
  rateLimiter,
  requireLength,
  resolveSession,
  sanitize,
  secretsMatch,
  sessionByToken,
} from "./lib";

// ---------------------------------------------------------------------------
// Optional accounts — passwordless sign-in by emailed 6-digit code
//
// Jackdaw is anonymous by default and stays that way. An account is additive:
// it gives a person's alerts somewhere to live that survives clearing browser
// data, and signing in ADOPTS the watches the device already has rather than
// starting them over on an empty shelf. Nothing here is required to use
// anything, and no read path in the rest of the backend depends on it.
//
// A code, not a link, because the client is a browser extension: a magic link
// opens a tab that has no way to hand a session back to the extension. Six
// digits is what a person can retype from their phone.
//
// TWO STRUCTURAL DECISIONS worth understanding before editing this file, both
// forced by the same property of Convex — a mutation that throws rolls back
// its own writes (lib.ts's tryRateLimit and observations.ts document where
// this was proven on dev):
//
//  1. `verifyCode` is an ACTION, not a mutation. A wrong guess has to leave a
//     mark — the attempts counter and the rate-limit token are the entire
//     defence of a one-in-a-million secret — and a mutation that throws
//     BAD_CODE discards both, handing an attacker unlimited guesses. So the
//     decision is made by an internal mutation that returns its verdict
//     in-band and commits, and the action throws afterwards, outside the
//     transaction. The client still sees ConvexError { code: "BAD_CODE" }.
//
//  2. `requestCode` NEVER throws on rate limiting, for the same reason: a
//     throw would roll back the very token consumption that is supposed to be
//     the limit. It returns { ok: true } regardless — which is also what
//     enumeration-safety wants, since success and refusal are then
//     indistinguishable.
//
// Secrets are minted in actions (sendCode, verifyCode) rather than mutations.
// Queries and mutations are re-executable by design, so their randomness is
// bound up with determinism guarantees; an action has no such constraint and
// its crypto.getRandomValues is unambiguously the platform CSPRNG. Only the
// hash ever crosses back into a mutation.
// ---------------------------------------------------------------------------

const CODE_LENGTH = 6;
const CODE_SHAPE = new RegExp(`^\\d{${CODE_LENGTH}}$`);
const CODE_TTL_MS = 10 * 60 * 1000;
/** Wrong guesses a single code tolerates before it is dead. */
const MAX_CODE_ATTEMPTS = 5;

// There should only ever be 0 or 1 rows per email (storeCode replaces), so
// this bound exists to make a bug bounded rather than to permit a backlog.
const MAX_CODE_ROWS = 10;

// Watches adopted on sign-in, and rows swept per batch when an account is
// deleted. Both are bounded because a Convex transaction is; the delete path
// reschedules itself rather than truncating.
const ADOPT_LIMIT = 200;
const SWEEP_LIMIT = 500;
const SESSION_SCAN_LIMIT = 100;

// `isAdmin` is not indexed (see the schema note), so listAdmins scans. The cap
// is what keeps that scan inside a transaction's read budget, and the result
// says when it hit — a truncated answer cannot prove there is no admin further
// down the table, and a list of privileged accounts is the last place to let a
// silent cutoff pass for a complete one.
const ADMIN_SCAN_LIMIT = 2000;

// Sliding expiry, at day granularity: a session in daily use is refreshed at
// most once a day, so `touch` is a no-op write almost every time it is called
// rather than a write per panel load.
const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

const MAIL_TIMEOUT_MS = 10_000;
// Has to be a domain verified in Resend before anything actually sends.
const DEFAULT_FROM = "Jackdaw <noreply@jackdaws.app>";

/** Hex-encode bytes. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * A 6-digit code from the platform CSPRNG.
 *
 * Rejection sampling rather than a plain `byte % 10`: 256 is not a multiple of
 * 10, so bytes 250-255 would make 0-5 slightly likelier than 6-9 and hand an
 * attacker a better-than-uniform guess. Redrawing those costs nothing.
 */
function generateCode(): string {
  const digits: string[] = [];
  const buffer = new Uint8Array(CODE_LENGTH * 2);
  while (digits.length < CODE_LENGTH) {
    crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      if (byte >= 250) continue;
      digits.push(String(byte % 10));
      if (digits.length === CODE_LENGTH) break;
    }
  }
  return digits.join("");
}

/** 256 bits of session token, hex encoded. Returned to the client once. */
function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

// ---------------------------------------------------------------------------
// Requesting a code
// ---------------------------------------------------------------------------

/**
 * Ask for a sign-in code. Always answers { ok: true }.
 *
 * NO ACCOUNT ENUMERATION, by construction rather than by care: this handler
 * never reads the accounts table at all, so there is no branch, no extra
 * round trip and no error shape that could differ between an address that has
 * an account and one that doesn't. (Accounts are created on first successful
 * verify, so "does this address have an account" isn't even a question the
 * flow needs to answer.) A refusal — malformed rate limit, drained budget —
 * looks exactly like a send.
 *
 * The cost of that is real and accepted: a rate-limited caller is told the
 * code is on its way and no code arrives. Five an hour per address is well
 * clear of what a person retrying a typo can hit.
 */
export const requestCode = mutation({
  args: { email: v.string() },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx, args) => {
    // Shape validation throws, and that is fine here: whether a string is a
    // syntactically valid address is independent of whether anyone owns it.
    const email = normalizeEmail(args.email);

    // Per-address first, deployment-wide second, and the global token is only
    // consumed once the per-address bucket has allowed the request — so one
    // hammered address can't drain the budget everyone else shares.
    const perEmail = await rateLimiter.limit(ctx, "authCodeRequest", {
      key: email,
    });
    if (!perEmail.ok) return { ok: true as const };

    const global = await rateLimiter.limit(ctx, "authCodeGlobal", {
      key: "global",
    });
    if (!global.ok) return { ok: true as const };

    // The code itself is minted inside the action (see the header note), so
    // nothing secret is ever parked in this scheduled call's arguments.
    await ctx.scheduler.runAfter(0, internal.auth.sendCode, { email });
    return { ok: true as const };
  },
});

/**
 * Mint, store and deliver one code. Internal, scheduled by requestCode.
 *
 * It mints as well as sends because this is the runtime with unquestionable
 * randomness, and because the plaintext then never leaves the action except as
 * the body of an email — not through scheduler arguments, not through a log
 * line, and (with mail configured) not into the database either.
 *
 * With RESEND_API_KEY unset this stores the code and stops. That is the
 * supported development path: no mail account required, and
 * `npx convex run auth:devPeekCode '{"email":"..."}'` reads the code back.
 */
export const sendCode = internalAction({
  args: { email: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const code = generateCode();
    const codeHash = await hashSecret(code);
    const apiKey = env.RESEND_API_KEY ?? "";
    const mailConfigured = apiKey.length > 0;

    await ctx.runMutation(internal.auth.storeCode, {
      email: args.email,
      codeHash,
      expiresAt: Date.now() + CODE_TTL_MS,
      // Only when there is no way to deliver it. See the schema comment.
      devCode: mailConfigured ? undefined : code,
    });

    if (!mailConfigured) {
      // Never the code, and never at info level. A deployment that has lost
      // its Resend key should say so loudly in the logs; it must not also
      // print live credentials into them.
      console.warn(
        "auth: RESEND_API_KEY is unset — sign-in code stored but NOT sent. Read it with `npx convex run auth:devPeekCode`.",
      );
      return null;
    }

    const from = env.JACKDAW_FROM_EMAIL ?? DEFAULT_FROM;
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [args.email],
          subject: `Jackdaw sign-in code: ${code}`,
          text: codeEmailText(code),
          html: codeEmailHtml(code),
        }),
        // Without this a hung connection holds the action open to its limit.
        signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
      });
      if (!response.ok) {
        const body = await response.text();
        console.error(
          `auth: Resend refused the send (${response.status}): ${body.slice(0, 300)}`,
        );
      }
    } catch (error) {
      // Swallowed deliberately: the code is already stored, the caller has
      // already been told to check their mail, and a thrown scheduled action
      // would add nothing a logged error doesn't. Visible in `npx convex logs`.
      console.error(`auth: sign-in mail failed to send: ${String(error)}`);
    }
    return null;
  },
});

/** Plain-text body. No links — the whole point of a code is that there aren't any. */
function codeEmailText(code: string): string {
  return [
    code,
    "",
    "That's your Jackdaw sign-in code. It works once, and expires in 10 minutes.",
    "",
    "If you didn't ask for it, ignore this — nothing has changed, and no account was created.",
    "",
    "Jackdaw — community price history for Micro Center.",
  ].join("\n");
}

/** Same words, set in a single self-contained table. No images, no tracking. */
function codeEmailHtml(code: string): string {
  return `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#f6f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1c1a">
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:420px;margin:0 auto;background:#ffffff;border:1px solid #dcdcd6;border-radius:10px">
<tr><td style="padding:28px 28px 22px">
<div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6b6b63">Jackdaw sign-in</div>
<div style="margin:18px 0;font-size:34px;letter-spacing:.22em;font-weight:600;font-variant-numeric:tabular-nums">${code}</div>
<p style="margin:0 0 14px;font-size:14px;line-height:1.55">It works once, and expires in 10 minutes.</p>
<p style="margin:0;font-size:13px;line-height:1.55;color:#6b6b63">If you didn't ask for it, ignore this — nothing has changed, and no account was created.</p>
</td></tr></table>
</body></html>`;
}

/**
 * Replace this address's outstanding code, so requesting a new one retires the
 * old one instead of leaving two live secrets in the world.
 */
export const storeCode = internalMutation({
  args: {
    email: v.string(),
    codeHash: v.string(),
    expiresAt: v.number(),
    devCode: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("loginCodes")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .take(MAX_CODE_ROWS);
    for (const row of existing) {
      await ctx.db.delete(row._id);
    }
    await ctx.db.insert("loginCodes", {
      email: args.email,
      codeHash: args.codeHash,
      expiresAt: args.expiresAt,
      attempts: 0,
      devCode: args.devCode,
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Verifying a code
// ---------------------------------------------------------------------------

type CodeVerdict =
  | { status: "ok" }
  | { status: "bad" }
  | { status: "locked" }
  | { status: "rateLimited"; retryAfter: number };

/**
 * What completeSignIn hands back, and (with the token) what verifyCode
 * returns. Written out rather than inferred because verifyCode is an action in
 * the same module as the mutations it calls, so `internal.auth.*` refers to a
 * type TypeScript is still deriving — every hop through ctx.runMutation here
 * needs its own annotation or the whole file collapses to `any`.
 */
type SignInResult = {
  accountId: Id<"accounts">;
  email: string;
  adoptedWatches: number;
};

/**
 * Sign in with the emailed code. Creates the account on first use, opens a
 * session, and adopts this device's watches.
 *
 * Returns the session token EXACTLY ONCE — only its hash is stored, so a
 * client that loses it has to sign in again, and a database dump is not a pile
 * of live credentials.
 *
 * Throws ConvexError { code } for BAD_CODE (wrong, expired, already used, or
 * never issued — one answer for all four, so a guess learns nothing beyond
 * "not that"), CODE_LOCKED (this code is spent) and RATE_LIMITED.
 *
 * An action, not a mutation — see decision 1 in the header. The consequence
 * worth naming: the two mutations below are separate transactions, so a crash
 * between them consumes the code without opening a session. That fails closed
 * (the user requests another code) and is the right way round.
 */
export const verifyCode = action({
  args: {
    email: v.string(),
    code: v.string(),
    deviceId: v.string(),
  },
  returns: v.object({
    sessionToken: v.string(),
    accountId: v.id("accounts"),
    email: v.string(),
    adoptedWatches: v.number(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<SignInResult & { sessionToken: string }> => {
    const email = normalizeEmail(args.email);
    const deviceId = requireLength("deviceId", args.deviceId, 1, 100);
    // People paste "123 456" out of a mail client; that is not a wrong code.
    // Truncated first so a megabyte of junk is a cheap rejection rather than a
    // megabyte-wide regex — nothing past the first few characters could ever
    // make a 6-digit code anyway.
    const code = args.code.slice(0, 64).replace(/\s+/g, "");

    if (!CODE_SHAPE.test(code)) {
      // Same error a wrong code gets. A malformed guess consumes no attempt,
      // which costs nothing: only well-formed guesses could ever be right.
      throw new ConvexError({
        code: "BAD_CODE",
        message: "That code isn't right. Check the email, or request a new one.",
      });
    }

    // Only the hash crosses into the mutation.
    const codeHash = await hashSecret(code);
    const verdict: CodeVerdict = await ctx.runMutation(
      internal.auth.consumeCode,
      { email, codeHash },
    );

    if (verdict.status === "rateLimited") {
      throw new ConvexError({
        code: "RATE_LIMITED",
        message: "Too many attempts — try again later",
        retryAfter: verdict.retryAfter,
      });
    }
    if (verdict.status === "locked") {
      throw new ConvexError({
        code: "CODE_LOCKED",
        message: "Too many wrong guesses. Request a new code.",
      });
    }
    if (verdict.status !== "ok") {
      throw new ConvexError({
        code: "BAD_CODE",
        message: "That code isn't right. Check the email, or request a new one.",
      });
    }

    const sessionToken = generateSessionToken();
    const tokenHash = await hashSecret(sessionToken);
    const result: SignInResult = await ctx.runMutation(
      internal.auth.completeSignIn,
      { email, tokenHash, deviceId },
    );

    return { sessionToken, ...result };
  },
});

/**
 * Decide a guess and record it. Returns its verdict in-band and NEVER throws
 * for a rejection — the whole point is that the attempts increment and the
 * rate-limit token survive, which a throw would undo (header, decision 1).
 *
 * Order matters: the lock is checked before the comparison, so the attempt
 * that trips the limit is refused rather than answered.
 */
export const consumeCode = internalMutation({
  args: { email: v.string(), codeHash: v.string() },
  returns: v.union(
    v.object({ status: v.literal("ok") }),
    v.object({ status: v.literal("bad") }),
    v.object({ status: v.literal("locked") }),
    v.object({
      status: v.literal("rateLimited"),
      retryAfter: v.number(),
    }),
  ),
  handler: async (ctx, args): Promise<CodeVerdict> => {
    const limit = await rateLimiter.limit(ctx, "authVerify", {
      key: args.email,
    });
    if (!limit.ok) {
      return { status: "rateLimited", retryAfter: limit.retryAfter };
    }

    const row = await ctx.db
      .query("loginCodes")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
    const now = Date.now();

    // Never issued, already spent, or expired — all "bad", so a guesser can't
    // tell an address with a live code from one without.
    if (row === null) return { status: "bad" };
    if (row.consumedAt !== undefined) return { status: "bad" };
    if (row.expiresAt <= now) return { status: "bad" };
    if (row.attempts >= MAX_CODE_ATTEMPTS) return { status: "locked" };

    // Full-sweep comparison, no early return: same reasoning as requireAdmin.
    if (!secretsMatch(args.codeHash, row.codeHash)) {
      await ctx.db.patch(row._id, { attempts: row.attempts + 1 });
      return { status: "bad" };
    }

    // Single use. Marked spent in the same transaction that accepts it, and
    // the development plaintext goes at the same moment.
    await ctx.db.patch(row._id, { consumedAt: now, devCode: undefined });
    return { status: "ok" };
  },
});

/**
 * Upsert the account, open the session, adopt the device's watches.
 *
 * Internal and reachable only from verifyCode, which is the only thing that
 * has established the caller controls the address. Nothing here re-checks
 * that, so it must never become public.
 */
export const completeSignIn = internalMutation({
  args: {
    email: v.string(),
    tokenHash: v.string(),
    deviceId: v.string(),
  },
  returns: v.object({
    accountId: v.id("accounts"),
    email: v.string(),
    adoptedWatches: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();

    const existing = await ctx.db
      .query("accounts")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
    let accountId: Id<"accounts">;
    if (existing === null) {
      accountId = await ctx.db.insert("accounts", {
        email: args.email,
        createdAt: now,
        lastLoginAt: now,
      });
    } else {
      accountId = existing._id;
      await ctx.db.patch(accountId, { lastLoginAt: now });
    }

    // Signing in is the natural moment to drop this account's dead sessions —
    // nothing else walks them, and they are otherwise immortal.
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .take(SESSION_SCAN_LIMIT);
    for (const session of sessions) {
      if (session.expiresAt <= now) await ctx.db.delete(session._id);
    }

    await ctx.db.insert("sessions", {
      accountId,
      tokenHash: args.tokenHash,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      lastUsedAt: now,
    });

    const adoptedWatches = await adoptDeviceWatches(ctx, args.deviceId, accountId);
    return { accountId, email: args.email, adoptedWatches };
  },
});

/**
 * Attach this device's unclaimed watches to the account.
 *
 * Read active-first, in two indexed passes rather than one: by_device_active
 * is ["deviceId","active"] and `false` sorts below `true`, so a single
 * take(ADOPT_LIMIT) over the deviceId prefix would fill up with the device's
 * dead watches and adopt none of its live alerts. Same trap watches.ts calls
 * out for check()/dashboard(), one index further along.
 *
 * Only rows with no accountId are touched, so a second device signing into the
 * same account cannot steal watches already claimed by another account, and
 * re-signing in is a no-op rather than a re-adoption.
 */
async function adoptDeviceWatches(
  ctx: MutationCtx,
  deviceId: string,
  accountId: Id<"accounts">,
): Promise<number> {
  const active = await ctx.db
    .query("watches")
    .withIndex("by_device_active", (q) =>
      q.eq("deviceId", deviceId).eq("active", true),
    )
    .take(ADOPT_LIMIT);

  const remaining = ADOPT_LIMIT - active.length;
  const inactive =
    remaining > 0
      ? await ctx.db
          .query("watches")
          .withIndex("by_device_active", (q) =>
            q.eq("deviceId", deviceId).eq("active", false),
          )
          .take(remaining)
      : [];

  let adopted = 0;
  for (const watch of [...active, ...inactive]) {
    if (watch.accountId !== undefined) continue;
    await ctx.db.patch(watch._id, { accountId });
    adopted++;
  }
  return adopted;
}

// ---------------------------------------------------------------------------
// Using and ending a session
// ---------------------------------------------------------------------------

/**
 * Who this token belongs to, or null.
 *
 * Never throws. An unknown, malformed, expired or orphaned token is "signed
 * out", which is a normal state for a client that has simply never signed in —
 * making it an error would mean every anonymous user's first call looked like
 * a failure.
 */
export const me = query({
  args: { sessionToken: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      accountId: v.id("accounts"),
      email: v.string(),
      createdAt: v.number(),
      handle: v.union(v.string(), v.null()),
      isAdmin: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const resolved = await resolveSession(ctx, args.sessionToken);
    if (resolved === null) return null;
    return {
      accountId: resolved.account._id,
      email: resolved.account.email,
      createdAt: resolved.account.createdAt,
      // null means "signed in, no handle yet" — a real state, not an error.
      // It is the one thing standing between this account and commenting
      // (comments:add answers NEED_HANDLE), so the client reads it to decide
      // whether to route into the claim step.
      handle: resolved.account.handle ?? null,
      // Flattened to a real boolean here, because a client cannot be trusted
      // to remember the `=== true` rule and `undefined` crossing the wire as a
      // missing key is exactly how a truthiness check gets written on the far
      // side. This is a HINT, never a gate: the panel uses it to decide what to
      // render, and every admin function re-checks the account itself through
      // requireAdmin. Nothing here becomes true because a client said so.
      isAdmin: resolved.account.isAdmin === true,
    };
  },
});

/**
 * Keep a session alive: mark it used and push its expiry out another 90 days.
 *
 * This exists because `me` is a query and queries cannot write, so "expiry
 * refreshed on use" has nowhere else to live. Call it alongside `me` on
 * client startup. Cheap by design — the write only happens once a day per
 * session (TOUCH_INTERVAL_MS), so an active user is refreshed indefinitely
 * while a client that polls hourly costs one write a day, not one per poll.
 *
 * Returns { ok: false } for a dead session rather than throwing, same as `me`.
 */
export const touch = mutation({
  args: { sessionToken: v.string() },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const resolved = await resolveSession(ctx, args.sessionToken);
    if (resolved === null) return { ok: false };

    const now = Date.now();
    if (now - resolved.session.lastUsedAt >= TOUCH_INTERVAL_MS) {
      await ctx.db.patch(resolved.session._id, {
        lastUsedAt: now,
        expiresAt: now + SESSION_TTL_MS,
      });
    }
    return { ok: true };
  },
});

/**
 * End this session. Idempotent and silent — signing out twice, or with a token
 * that already expired, is a success, because from the client's point of view
 * the desired state (not signed in) is the state it ends up in either way.
 *
 * Only this session: other devices stay signed in.
 */
export const signOut = mutation({
  args: { sessionToken: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Deliberately the expiry-blind lookup: a stale row is still worth
    // deleting, and refusing to clean it up would be pure pedantry.
    const session = await sessionByToken(ctx, args.sessionToken);
    if (session !== null) await ctx.db.delete(session._id);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Claimed handles
//
// A handle is the only thing an account gives a *reader* rather than its owner:
// a name shown with a verified marker that exactly one person can hold. The
// reservation is what makes the marker mean anything — the key is reserved
// against anonymous commenters too (comments:add answers NAME_CLAIMED), so an
// unticked "hex_byte" cannot appear beside the ticked one and let the reader
// think the tick is decoration.
//
// PERMANENT ONCE CLAIMED. There is no rename path anywhere in this file, and
// adding one would be a change to the data model rather than a feature: every
// comment stores its author's handle as text at post time (that is what keeps a
// thread readable after an account is deleted), so a rename would strand every
// earlier comment under a name its author no longer holds. Permanence is what
// lets the copy be trusted.
// ---------------------------------------------------------------------------

/** Refusals claimHandle answers in band. */
type ClaimRefusal = "NO_SESSION" | "LOCKED" | "INVALID" | "RESERVED" | "TAKEN";

/**
 * Claim this account's one permanent handle.
 *
 * ANSWERS IN BAND, never throwing for an expected outcome — the same structural
 * decision as consumeCode, for the same reason (header, decision 1). The
 * handleClaim bucket is consumed before any verdict is reached, and a mutation
 * that threw its refusal would roll that consumption back and hand a loop
 * unlimited attempts at the two index lookups below. So every refusal here is a
 * returned value that commits.
 *
 * The one exception is exhausting the bucket itself, which throws RATE_LIMITED
 * like every other rate-limited endpoint in the codebase. That is safe for the
 * exact reason the others are not: a refused `limit()` consumed nothing, so
 * there is nothing for the throw to roll back.
 *
 * Reasons, in the order they are checked:
 *   NO_SESSION — not signed in (expired and garbage tokens included).
 *   LOCKED     — this account already has a handle. Checked before the string
 *                is even looked at, because nothing about it could matter.
 *   INVALID    — wrong shape, or the content filter refused it.
 *   RESERVED   — a name nobody may hold (lib.ts RESERVED_HANDLE_KEYS).
 *   TAKEN      — another account holds this key, or a deleted account did.
 */
export const claimHandle = mutation({
  args: {
    sessionToken: v.string(),
    deviceId: v.string(),
    handle: v.string(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), handle: v.string() }),
    v.object({
      ok: v.literal(false),
      reason: v.union(
        v.literal("NO_SESSION"),
        v.literal("LOCKED"),
        v.literal("INVALID"),
        v.literal("RESERVED"),
        v.literal("TAKEN"),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const deviceId = requireLength("deviceId", args.deviceId, 1, 100);

    // Before anything else, so every attempt that reaches a verdict has paid
    // for it. Throwing here is the safe case — see the note above.
    const limit = await rateLimiter.limit(ctx, "handleClaim", { key: deviceId });
    if (!limit.ok) {
      throw new ConvexError({
        code: "RATE_LIMITED",
        message: "Too many attempts — try again later",
        retryAfter: limit.retryAfter,
      });
    }

    const refuse = (reason: ClaimRefusal) => ({ ok: false as const, reason });

    const resolved = await resolveSession(ctx, args.sessionToken);
    if (resolved === null) return refuse("NO_SESSION");
    if (resolved.account.handle !== undefined) return refuse("LOCKED");

    // Length is part of the shape test, so a 5,000-character argument is
    // rejected by the regex rather than by a separate ceiling. Sanitized first
    // so a trailing newline is a trim, not a refusal.
    const handle = sanitize(args.handle);
    if (!isWellFormedHandle(handle)) return refuse("INVALID");
    // Profanity, links and contact info, through the same filter comments use.
    // INVALID rather than a reason of its own: the union is the client's
    // contract and a rejected word is, from the picker's point of view, simply
    // a name it may not have.
    //
    // Both forms, because "_" is a word character to `\b` and would otherwise
    // walk a slur straight past the blocklist — see separatorFoldedForm.
    if (!isCleanContent(handle)) return refuse("INVALID");
    if (!isCleanContent(separatorFoldedForm(handle))) return refuse("INVALID");

    const handleKey = handleKeyOf(handle);
    // Unreachable while the shape test demands alphanumeric ends, and kept
    // because an empty key would match every row that has no handle at all.
    if (handleKey.length === 0) return refuse("INVALID");
    if (isReservedHandleKey(handleKey)) return refuse("RESERVED");

    // Two point lookups, both indexed. A live holder and a retired one are one
    // answer — the name is spoken for either way, and saying which would leak
    // that an account once existed.
    const live = await ctx.db
      .query("accounts")
      .withIndex("by_handleKey", (q) => q.eq("handleKey", handleKey))
      .first();
    if (live !== null) return refuse("TAKEN");
    const retired = await ctx.db
      .query("retiredHandles")
      .withIndex("by_handleKey", (q) => q.eq("handleKey", handleKey))
      .first();
    if (retired !== null) return refuse("TAKEN");

    // Two claims of the same free key race on this write: both read the empty
    // index range, both patch, and Convex's OCC invalidates the loser's read
    // set and re-runs it — where it now finds the winner's row and answers
    // TAKEN. The uniqueness invariant holds without a lock.
    await ctx.db.patch(resolved.account._id, {
      handle,
      handleKey,
    });

    // Lifetime claims, not live handles: nothing decrements it, and a deleted
    // account's handle stays retired rather than returning to the pool. Label
    // it that way anywhere it is displayed.
    await bump(ctx, "handles:claimed");

    return { ok: true as const, handle };
  },
});

/**
 * Delete the account, every session it has, and its outstanding sign-in code.
 * Required by the Chrome Web Store, and the honest reading of GDPR/CCPA
 * erasure for the one piece of personal data Jackdaw holds.
 *
 * WATCHES ARE UNLINKED, NOT DELETED. The device that owns them is still the
 * anonymous owner it was before anyone signed in, and taking someone's alerts
 * away as a side effect of removing their email address would be a bug wearing
 * a privacy costume. Clearing accountId puts the row back exactly as it was.
 *
 * COMMENTS ARE UNLINKED TOO, and for a second reason on top of that one: the
 * words stay because deleting an account must not silently delete other
 * people's threads, and the accountId goes because the verified marker is a
 * claim about an identity nobody can prove any more. The displayName stays as
 * written — it is what the thread said at the time.
 *
 * THE HANDLE IS RETIRED, NOT RELEASED. See the retiredHandles comment in
 * schema.ts: returning it to the pool would let the next claimant's ticked
 * comments sit beside the old unticked ones under one name.
 *
 * Requires a live session — deletion is the one operation here that must not
 * be a silent no-op on a bad token, because a client that believes it deleted
 * an account that still exists is worse off than one told it failed.
 */
export const deleteAccount = mutation({
  args: { sessionToken: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const resolved = await resolveSession(ctx, args.sessionToken);
    if (resolved === null) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "not signed in",
      });
    }
    const accountId = resolved.account._id;

    const codes = await ctx.db
      .query("loginCodes")
      .withIndex("by_email", (q) => q.eq("email", resolved.account.email))
      .take(MAX_CODE_ROWS);
    for (const code of codes) {
      await ctx.db.delete(code._id);
    }

    // Retire the handle before the row holding it goes. Nothing else can have
    // written this key (a live account holds it exclusively, and a retired key
    // is never claimable again), so there is no duplicate to guard against.
    if (resolved.account.handleKey !== undefined) {
      await ctx.db.insert("retiredHandles", {
        handleKey: resolved.account.handleKey,
        retiredAt: Date.now(),
      });
    }

    const swept = await sweepAccountRows(ctx, accountId);
    await ctx.db.delete(accountId);

    // A transaction is bounded; erasure shouldn't be. If either sweep filled
    // its batch, hand the rest to a continuation that reschedules itself until
    // there is nothing left — rather than quietly leaving rows pointed at an
    // account that no longer exists.
    if (swept.more) {
      await ctx.scheduler.runAfter(0, internal.auth.purgeAccountRows, {
        accountId,
      });
    }
    return null;
  },
});

/**
 * One batch of account teardown: sessions deleted, watches and comments
 * unlinked. Every operation removes its rows from the range being read, so
 * repeated batches always make progress and the continuation terminates.
 */
async function sweepAccountRows(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
): Promise<{
  sessions: number;
  watches: number;
  comments: number;
  more: boolean;
}> {
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .take(SWEEP_LIMIT);
  for (const session of sessions) {
    await ctx.db.delete(session._id);
  }

  // Prefix range over ["accountId","active"], so both active and inactive
  // watches are unlinked in one pass.
  const watches = await ctx.db
    .query("watches")
    .withIndex("by_account_active", (q) => q.eq("accountId", accountId))
    .take(SWEEP_LIMIT);
  for (const watch of watches) {
    await ctx.db.patch(watch._id, { accountId: undefined });
  }

  // The comment text and its displayName stay; only the link that produces the
  // verified marker goes. Bounded and continued exactly like the two above
  // rather than truncated, because a comment left pointing at a deleted account
  // would keep a tick nobody can stand behind.
  const comments = await ctx.db
    .query("comments")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .take(SWEEP_LIMIT);
  for (const comment of comments) {
    await ctx.db.patch(comment._id, { accountId: undefined });
  }

  return {
    sessions: sessions.length,
    watches: watches.length,
    comments: comments.length,
    more:
      sessions.length >= SWEEP_LIMIT ||
      watches.length >= SWEEP_LIMIT ||
      comments.length >= SWEEP_LIMIT,
  };
}

/** Continuation for {@link deleteAccount}; reschedules itself while work remains. */
export const purgeAccountRows = internalMutation({
  args: { accountId: v.id("accounts") },
  returns: v.object({
    sessions: v.number(),
    watches: v.number(),
    comments: v.number(),
    more: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const swept = await sweepAccountRows(ctx, args.accountId);
    if (swept.more) {
      await ctx.scheduler.runAfter(0, internal.auth.purgeAccountRows, {
        accountId: args.accountId,
      });
    }
    return swept;
  },
});

// ---------------------------------------------------------------------------
// Admin privilege (internal — the only writers of accounts.isAdmin)
// ---------------------------------------------------------------------------

/**
 * THESE THREE ARE THE ENTIRE WRITE SURFACE FOR `accounts.isAdmin`, and keeping
 * it that small is the point of the field. They are internal, so they are
 * reachable from a CLI session already holding the deployment's admin key and
 * from nowhere else — not the extension, not the panel, not the public HTTP
 * API. No public function takes an argument that reaches this field, which is
 * what bounds the damage a bug in the sign-in surface could do: the worst a
 * broken verify path can hand out is a session on an ordinary account, and an
 * ordinary account is not an admin.
 *
 * Granting is therefore deliberately out of band. There is no invite flow, no
 * first-user-wins bootstrap and no self-promotion — someone with deployment
 * access types an address:
 *
 *   npx convex run auth:grantAdmin '{"email":"you@example.com"}'
 *   npx convex run auth:listAdmins
 *   npx convex run auth:revokeAdmin '{"email":"you@example.com"}'
 */

/**
 * Make an existing account an admin.
 *
 * Requires the account to exist, and says so plainly when it does not — this
 * is a CLI chore run by someone who can read the error, so the enumeration
 * caution that governs `requestCode` does not apply. Creating the account here
 * instead would be worse: an address typo would silently mint a privileged
 * account nobody ever signs into, and it would put account creation on a path
 * that never verified the address.
 *
 * Idempotent, and reports which it was — running it twice is a normal thing to
 * do when you are unsure whether the first one landed.
 */
export const grantAdmin = internalMutation({
  args: { email: v.string() },
  returns: v.object({
    accountId: v.id("accounts"),
    email: v.string(),
    isAdmin: v.boolean(),
    changed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (account === null) {
      throw new ConvexError({
        code: "NO_ACCOUNT",
        message: `no account for ${email} — they have to sign in once first`,
      });
    }
    const already = account.isAdmin === true;
    if (!already) await ctx.db.patch(account._id, { isAdmin: true });
    return {
      accountId: account._id,
      email: account.email,
      isAdmin: true,
      changed: !already,
    };
  },
});

/**
 * Take admin away again.
 *
 * Writes `false` rather than deleting the key. Absent and false mean the same
 * thing to every reader — `isAdmin === true` — so this is not about the answer
 * but about the record: a row that says false was considered and refused,
 * where an absent field says only that nobody ever looked. That distinction is
 * the whole value of this table for the one question anyone will ask of it
 * later, which is who used to be able to open the panel.
 *
 * Sessions are deliberately left alone. Privilege is read from the account on
 * every admin call, so revoking takes effect on the revoked person's next
 * request without ending the sign-in they still legitimately hold — they stay
 * an ordinary user, with their watches, exactly as if they had never been
 * granted it.
 */
export const revokeAdmin = internalMutation({
  args: { email: v.string() },
  returns: v.object({
    accountId: v.id("accounts"),
    email: v.string(),
    isAdmin: v.boolean(),
    changed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (account === null) {
      throw new ConvexError({
        code: "NO_ACCOUNT",
        message: `no account for ${email}`,
      });
    }
    const was = account.isAdmin === true;
    if (was) await ctx.db.patch(account._id, { isAdmin: false });
    return {
      accountId: account._id,
      email: account.email,
      isAdmin: false,
      changed: was,
    };
  },
});

/**
 * Who can open the panel: `npx convex run auth:listAdmins`
 *
 * The answer to "did that grant land" and to "who still has this", which is a
 * question worth being able to ask without opening the data browser.
 *
 * `truncated` is not decoration. The scan is capped and `isAdmin` is not
 * indexed, so a full table means this list is a floor rather than the set —
 * and a floor is the wrong shape for a privilege audit, which is why it is
 * flagged in band instead of being left for the reader to infer from a round
 * number.
 */
export const listAdmins = internalQuery({
  args: {},
  returns: v.object({
    admins: v.array(
      v.object({
        accountId: v.id("accounts"),
        email: v.string(),
        handle: v.union(v.string(), v.null()),
        createdAt: v.number(),
      }),
    ),
    scanned: v.number(),
    truncated: v.boolean(),
  }),
  handler: async (ctx) => {
    const rows = await ctx.db.query("accounts").take(ADMIN_SCAN_LIMIT);
    return {
      admins: rows
        .filter((r) => r.isAdmin === true)
        .map((r) => ({
          accountId: r._id,
          email: r.email,
          handle: r.handle ?? null,
          createdAt: r.createdAt,
        })),
      scanned: rows.length,
      truncated: rows.length >= ADMIN_SCAN_LIMIT,
    };
  },
});

// ---------------------------------------------------------------------------
// Development and housekeeping (internal — unreachable from any client)
// ---------------------------------------------------------------------------

/**
 * Read back the outstanding code for an address:
 * `npx convex run auth:devPeekCode '{"email":"you@example.com"}'`
 *
 * This is what makes sign-in developable with no mail provider attached. It is
 * an internalQuery, so it is reachable from a CLI session holding the
 * deployment's admin key and from nothing else — not the extension, not the
 * site, not the public HTTP API.
 *
 * The plaintext is returned only when RESEND_API_KEY is unset, and it is only
 * ever written under that same condition, so a deployment with mail configured
 * has nothing to hand back even if this were somehow called.
 */
export const devPeekCode = internalQuery({
  args: { email: v.string() },
  returns: v.object({
    exists: v.boolean(),
    expiresAt: v.union(v.number(), v.null()),
    expired: v.boolean(),
    consumed: v.boolean(),
    attempts: v.number(),
    code: v.union(v.string(), v.null()),
    mailConfigured: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    const mailConfigured = (env.RESEND_API_KEY ?? "").length > 0;

    const row = await ctx.db
      .query("loginCodes")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (row === null) {
      return {
        exists: false,
        expiresAt: null,
        expired: false,
        consumed: false,
        attempts: 0,
        code: null,
        mailConfigured,
      };
    }
    return {
      exists: true,
      expiresAt: row.expiresAt,
      expired: row.expiresAt <= Date.now(),
      consumed: row.consumedAt !== undefined,
      attempts: row.attempts,
      code: mailConfigured ? null : (row.devCode ?? null),
      mailConfigured,
    };
  },
});

/**
 * Delete spent sign-in codes and dead sessions:
 * `npx convex run auth:purgeExpired`
 *
 * Neither table has a read path that would clear them on its own — a consumed
 * code is inert but immortal, and a session only gets swept if its account
 * signs in again or is deleted — so without this they grow forever. Bounded
 * per run and reports `more`, in the same shape as admin.ts's other sweeps;
 * run it again while that is true.
 *
 * Unindexed take() on purpose: rows come back oldest-first, which for a
 * garbage collector is exactly the order worth scanning, and an index on
 * expiresAt would cost a write on every sign-in to serve a manual chore.
 */
export const purgeExpired = internalMutation({
  args: {},
  returns: v.object({
    codes: v.number(),
    sessions: v.number(),
    more: v.boolean(),
  }),
  handler: async (ctx) => {
    const now = Date.now();

    const codeRows = await ctx.db.query("loginCodes").take(SWEEP_LIMIT);
    let codes = 0;
    for (const row of codeRows) {
      if (row.expiresAt > now && row.consumedAt === undefined) continue;
      await ctx.db.delete(row._id);
      codes++;
    }

    const sessionRows = await ctx.db.query("sessions").take(SWEEP_LIMIT);
    let sessions = 0;
    for (const row of sessionRows) {
      if (row.expiresAt > now) continue;
      await ctx.db.delete(row._id);
      sessions++;
    }

    return {
      codes,
      sessions,
      more:
        codeRows.length >= SWEEP_LIMIT || sessionRows.length >= SWEEP_LIMIT,
    };
  },
});
