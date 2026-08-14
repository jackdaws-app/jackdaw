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
  hashSecret,
  normalizeEmail,
  rateLimiter,
  requireLength,
  resolveSession,
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
    }),
  ),
  handler: async (ctx, args) => {
    const resolved = await resolveSession(ctx, args.sessionToken);
    if (resolved === null) return null;
    return {
      accountId: resolved.account._id,
      email: resolved.account.email,
      createdAt: resolved.account.createdAt,
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
 * One batch of account teardown: sessions deleted, watches unlinked. Both
 * operations remove their rows from the range being read, so repeated batches
 * always make progress and the continuation terminates.
 */
async function sweepAccountRows(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
): Promise<{ sessions: number; watches: number; more: boolean }> {
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

  return {
    sessions: sessions.length,
    watches: watches.length,
    more: sessions.length >= SWEEP_LIMIT || watches.length >= SWEEP_LIMIT,
  };
}

/** Continuation for {@link deleteAccount}; reschedules itself while work remains. */
export const purgeAccountRows = internalMutation({
  args: { accountId: v.id("accounts") },
  returns: v.object({
    sessions: v.number(),
    watches: v.number(),
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
