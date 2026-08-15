import { ConvexError, v } from "convex/values";
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
  // Catalog batches, keyed per device. ONE TOKEN PER PAGE, not per item — the
  // whole reason a batch exists is that a grid page is a single thing a person
  // looked at, and charging it 96 tokens would make the honest heavy browser
  // indistinguishable from an attacker. The per-item ceiling is CATALOG_MAX_ITEMS
  // in observations.ts, which is what actually bounds the write cost.
  //
  // 60/hour is one grid page a minute sustained, well above real browsing (a
  // person reading a category page spends far longer than a minute on it) and
  // still a hard cap of 60 x 96 = 5,760 rows an hour from one device. Note this
  // is a much better forgery target than priceReport: one accepted call moves 96
  // products at once. What bounds the damage today is the plausibility clamp in
  // observations.reportBatch (0.2x-5x the last known price for that product and
  // store), which kills the crude forgery and the common misparse but still
  // admits a lone batch as low as one fifth of the last price — and
  // products.stats takes lowestPrice as a plain minimum over every row, so that
  // lone batch WOULD open an all-time low. `pricePoints.source: "catalog"` is
  // recorded so a corroboration rule can be added there later; none exists yet.
  catalogBatch: { kind: "token bucket", rate: 60, period: HOUR },
  // Global (not per-device) ceiling on admin traffic. Read the note above
  // enforceAdminRateLimit before treating this as anti-guessing protection.
  adminAuth: { kind: "token bucket", rate: 20, period: MINUTE },
  // Alert click-throughs carry no identifier at all (by design — see
  // metrics.ts), so there is nothing to key a per-device bucket on. A single
  // global bucket is the only option, which also makes it a ceiling on the
  // metric itself: at most 1,440 clicks/day can ever be recorded.
  alertClick: { kind: "token bucket", rate: 60, period: HOUR },
  // Client error telemetry (metrics:events) has the same shape and the same
  // trade-off: no identifier in the payload, so no per-device key exists and
  // the bucket has to be global.
  //
  // Sized against real traffic rather than a round number: a client flushes on
  // its hourly alarm, so steady state is about one request per user per hour
  // and this is the supported user count before the ceiling binds. Too low is
  // the dangerous direction — overflow is dropped, not queued, and the moment
  // every panel breaks at once is the moment every client has something to
  // flush. Raise this before the user base reaches it, not after.
  clientEvents: { kind: "token bucket", rate: 3000, period: HOUR },
  // Sign-in codes, keyed on the normalized email. Five an hour is generous for
  // a human who mistyped or lost the first mail, and low enough that this
  // endpoint can't be used to mailbomb a stranger — requestCode sends to any
  // syntactically valid address, so the address itself is the only thing worth
  // keying on.
  authCodeRequest: { kind: "token bucket", rate: 5, period: HOUR },
  // Deployment-wide ceiling on the same endpoint, consumed only after the
  // per-email bucket allows the request, so one hammered address can never
  // drain everyone else's budget. This is the bill-shock stop: 200 sends/hour
  // is the most Jackdaw can ever be made to pay Resend for.
  authCodeGlobal: { kind: "token bucket", rate: 200, period: HOUR },
  // Verify attempts per email. The per-code `attempts` field (5, then the code
  // is dead) is the real defence; this is the outer bound that stops an
  // attacker cycling fresh codes to buy fresh attempt budgets.
  authVerify: { kind: "token bucket", rate: 10, period: HOUR },
  // Handle claims, keyed on deviceId. Sized for a person picking a name — the
  // first few tries are genuinely expected to come back TAKEN or INVALID — and
  // it is not really an anti-guessing control: an account may hold exactly one
  // handle (LOCKED thereafter), and which handles are taken is public on every
  // comment anyway. It exists so a loop can't hammer the two index lookups.
  //
  // This bucket only works because auth:claimHandle answers in band: a mutation
  // that threw its refusal would roll back the token it just consumed and the
  // limit would not exist. Same reasoning as the code-attempt counter above.
  handleClaim: { kind: "token bucket", rate: 20, period: HOUR },
});

export type RateLimitName =
  | "commentAdd"
  | "commentVote"
  | "commentReport"
  | "priceReport"
  | "catalogBatch";

/**
 * Consume one token from the named per-device bucket and report whether the
 * caller is within budget, WITHOUT throwing.
 *
 * This exists so a rejection can be counted. A mutation that throws rolls back
 * its whole transaction, so a counter bumped on the way out of a throwing
 * handler is discarded (proven on dev — see enforceAdminRateLimit's note and
 * the abuse-counter comment in observations.ts). Returning the verdict instead
 * lets the handler record the rejection and still refuse the write.
 *
 * Only use this where the caller tolerates a structured refusal; anything the
 * UI surfaces an error message for should keep using enforceRateLimit.
 */
export async function tryRateLimit(
  ctx: MutationCtx,
  name: RateLimitName,
  deviceId: string,
): Promise<boolean> {
  const { ok } = await rateLimiter.limit(ctx, name, { key: deviceId });
  return ok;
}

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
 *
 * Exported because every secret comparison in the codebase has to go through
 * one implementation: the admin key here, and the sign-in code hash in
 * auth.ts.
 */
export function secretsMatch(a: string, b: string): boolean {
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
// Optional accounts: email normalization, secret hashing, session lookup
// ---------------------------------------------------------------------------

const MAX_EMAIL_LENGTH = 254; // RFC 5321 practical ceiling
// Deliberately permissive: one @, no whitespace, a dot-bearing domain. The
// authoritative validity test for an address is whether a code sent to it ever
// comes back, and a regex strict enough to satisfy a spec lawyer mostly
// succeeds at rejecting real people's real addresses.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/**
 * Lowercase, trim, and shape-check an address. One normalization used by both
 * storage and lookup, so "A@B.com " and "a@b.com" can never become two
 * accounts. Throws ConvexError { code: "INVALID_ARGUMENT" }.
 */
export function normalizeEmail(raw: string): string {
  const cleaned = sanitize(raw).toLowerCase();
  if (
    cleaned.length === 0 ||
    cleaned.length > MAX_EMAIL_LENGTH ||
    !EMAIL_SHAPE.test(cleaned)
  ) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "that doesn't look like an email address",
    });
  }
  return cleaned;
}

const encoder = new TextEncoder();

// HMAC needs a key, and a zero-length one is rejected outright by some Web
// Crypto implementations — so an unset pepper falls back to this constant
// rather than "". It is in the public source and provides exactly no secrecy;
// it exists so the unconfigured path is a weaker hash, not a crash.
const UNPEPPERED = "jackdaw-no-pepper-configured";

/**
 * Keyed digest of a secret, hex encoded. HMAC-SHA256 with AUTH_PEPPER as the
 * key, so the stored hash is only reversible by someone who has the pepper as
 * well as the database.
 *
 * That distinction is the whole point for sign-in codes: a plain SHA-256 of a
 * 6-digit number is a table of a million entries anybody can build, which is
 * to say no protection at all. Session tokens carry 256 bits of entropy and
 * would be safe unhashed-but-unguessable either way; they go through the same
 * function so there is one construction to reason about instead of two.
 */
export async function hashSecret(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.AUTH_PEPPER ?? UNPEPPERED),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(secret));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** 90 days, refreshed on use — see auth:touch. */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// A real token is 64 hex characters. The cap is only here so a caller can't
// make the server hash a megabyte of junk.
const MAX_SESSION_TOKEN_LENGTH = 200;

/**
 * The session row for a bearer token, expired or not. Only signOut should want
 * this — deleting a stale row is still worth doing. Everything else wants
 * {@link resolveSession}.
 */
export async function sessionByToken(ctx: QueryCtx, sessionToken: string) {
  if (
    sessionToken.length === 0 ||
    sessionToken.length > MAX_SESSION_TOKEN_LENGTH
  ) {
    return null;
  }
  const tokenHash = await hashSecret(sessionToken);
  return await ctx.db
    .query("sessions")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
}

/**
 * Resolve a bearer token to its live session and account, or null.
 *
 * Null covers every failure the same way — malformed, unknown, expired, or
 * pointing at an account that has since been deleted — because the caller's
 * only useful question is "is this person signed in", and a signed-out client
 * is a normal state rather than an error.
 */
export async function resolveSession(ctx: QueryCtx, sessionToken: string) {
  const session = await sessionByToken(ctx, sessionToken);
  if (session === null || session.expiresAt <= Date.now()) return null;
  const account = await ctx.db.get(session.accountId);
  if (account === null) return null;
  return { session, account };
}

// ---------------------------------------------------------------------------
// Metrics counters
// ---------------------------------------------------------------------------

/** UTC calendar day (YYYY-MM-DD) for a millisecond timestamp. */
export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Every client-side event the extension may report, as a closed list. This is
 * the single definition: `metrics:events` builds its argument validator from
 * it (so a caller can never invent a counter key) and `dashboard:stats`
 * zero-fills every name from it (so the panel's table has stable rows even
 * before anything has been reported).
 *
 * Each name is a *state*, never a message. No free-form strings, no device id,
 * no product, no store, nothing that could narrow an aggregate back to a
 * person — the counters answer exactly one question, "is the panel working out
 * there", which is the question a silent breakage (Micro Center reshaping
 * dataLayer, a mutation starting to fail) currently makes unanswerable until
 * someone leaves a bad review.
 *
 * `panel_ok` is the denominator: an error count means nothing without the
 * number of loads that went fine.
 */
export const EVENT_NAMES = [
  "panel_ok",
  "no_datalayer",
  "report_failed",
  "history_failed",
  "comments_failed",
  "panel_error",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/**
 * Normalize a Micro Center category into a counter key segment: trimmed,
 * lowercased, capped at 60 chars. Returns null when there's nothing usable,
 * so callers skip the bump rather than creating an "obs:cat:" empty bucket.
 */
export function categoryKey(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const cleaned = sanitize(raw).toLowerCase().slice(0, 60).trim();
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * One spelling of a SKU, because the two readers were reading two.
 *
 * Micro Center PRINTS a six-digit zero-padded SKU on both surfaces
 * ("SKU: 044594"), and its dataLayer carries the same number unpadded
 * ("44594"). The catalog reader takes the printed form off the card; the
 * product-page reader takes the dataLayer's. So the two surfaces disagreed
 * about the identity of the same product, and each alternating visit patched
 * `sku` back to whichever surface was seen last: a wasted write every time,
 * and a stored value that matches what the retailer prints only half the time
 * — for the one field a shopper would paste into Micro Center's own search.
 *
 * Found by driving the real extension (2026-08-15): product 711665 read
 * "044594" from its grid card and "44594" from its product page, and the row
 * flipped between them. 164 of 1,471 products on dev held a stripped form.
 *
 * Normalizing at the WRITE BOUNDARY rather than inside either reader settles
 * it for every client version at once, including installs that never update.
 * Digits only and shorter than six: pad. Everything else is passed through
 * untouched — padding a shape we have never seen would be inventing an
 * identifier rather than repairing one.
 */
export function normalizeSku(raw: string): string {
  return /^\d{1,5}$/.test(raw) ? raw.padStart(6, "0") : raw;
}

/**
 * The product's condition, read off the one place Micro Center states it: a
 * trailing "(Refurbished)" on the product NAME.
 *
 * Derived rather than collected. Nothing new is read from any page — the name
 * is already stored on every product from both surfaces — so this costs no
 * request, no field in the payload, and works retroactively on rows collected
 * before it existed (see `products:recompute`).
 *
 * ONE VALUE, and that is an empirical finding rather than a placeholder.
 * "Open Box" looked like the obvious second one and is not: the Open Box facet
 * on a category page returns ordinary products whose names carry no suffix at
 * all, because open box is a per-store SHELF state on a normal listing — which
 * is exactly what `storeStock.openBoxUnits` and the open-box price already
 * record. There is no open-box product record to label. Refurbished is
 * different: it is a distinct listing with its own productId, its own price
 * history, and its own name.
 *
 * PARENTHESISED, AND THE GROUP MUST END WITH THE WORD. Those are the two
 * conditions, and the first draft of this function added a third — that the
 * marker be TRAILING — which was wrong and would have matched nothing.
 * Surveyed against the live refurbished laptop grid: 25 of 25 cards carry the
 * marker, 0 of 25 carry it at the end of the string. The real shape is
 *
 *   IdeaPad Slim 3i 15.6" Laptop Computer (Refurbished) - Abyss Blue; Intel...
 *
 * — the marker terminates the TITLE, and a colour and a semicolon-delimited
 * spec blob follow it (" - " on 23 of 24, ";" on the 24th). It was always in
 * the first segment, and the bare word never appeared outside the parentheses.
 *
 * So parentheses do the work the trailing anchor was supposed to do: they are
 * what makes this a condition label rather than prose about what a machine can
 * do. Requiring the word to END the group is the second half of that — a
 * hypothetical "(Refurbished Battery Included)" is a description of a part, not
 * of this unit — while an optional prefix inside the group admits the variant
 * family rather than one spelling of it. That matters: the 25th card read
 * "(Certified Refurbished)", so an enumeration of exact strings would already
 * have been one short on the first page it met.
 *
 * Every variant collapses to ONE value. The chip's job is to warn that this
 * unit's price history is not comparable to a new one's, which is equally true
 * of "certified" and plain refurbished; recording the retailer's marketing tier
 * would mean displaying a claim ("certified by whom?") we have no way to check.
 *
 * Anything unrecognised returns undefined, so the failure direction is a
 * missing badge and never a wrong one.
 */
export function conditionFromName(name: string): "refurbished" | undefined {
  return /\((?:[^()]*\s)?refurbished\s*\)/i.test(name) ? "refurbished" : undefined;
}

// ---------------------------------------------------------------------------
// Which store numbers name an actual building
// ---------------------------------------------------------------------------

/**
 * Store numbers that name no shelf.
 *
 *   "029" — Micro Center's "Shippable Items" pseudo-store, and the default for
 *           anyone who has never picked a location. It has no shelves, so it
 *           has no open-box unit and no local stock.
 *   "000" — page-world.js's fallback when the dataLayer offers neither
 *           storeNum nor closestStoreId. It means "we don't know".
 *
 * This lives here, not beside its first caller, because THREE places need the
 * same answer and they were drifting: `watches.setTriggers` refuses to arm a
 * store-scoped trigger on one of these, `watches.fireFor` refuses to read one,
 * and `observations.reportBatch` must refuse to WRITE a shelf row for one. The
 * third was missing — the batch writer would happily record "3 units in stock"
 * against a store that does not physically exist, and the only thing preventing
 * it was that `content.js` never asked for such a row back. That is a rule
 * living in the client, one caller away from being violated, which is the shape
 * of every silent-write bug in this codebase.
 *
 * A price reading under "029" is perfectly good and is NOT filtered here:
 * Micro Center prices nationally, so an online-only shopper's sighting is the
 * same fact as anyone else's and serves every watcher. What a pseudo-store
 * cannot produce is anything about a *shelf* — stock depth or an open-box unit.
 *
 * `extension/content.js` keeps its own copy (a content script cannot import
 * from `convex/`), but that copy now only decides what to *display*. This one
 * decides what may be *stored*, which is the half that has to hold.
 */
const NON_PHYSICAL_STORES = new Set(["029", "000"]);

/** Does this store number name an actual building with shelves in it? */
export function isPhysicalStore(storeNum: string | undefined): storeNum is string {
  return storeNum !== undefined && !NON_PHYSICAL_STORES.has(storeNum);
}

// ---------------------------------------------------------------------------
// Selector health
// ---------------------------------------------------------------------------

/**
 * Whether the readers can still find what they are looking for on the page.
 *
 * WHY THIS EXISTS. Four times now a reader has silently matched nothing and
 * stayed that way, because a selector that finds nothing produces no error, no
 * log line and no missing row — just a field that is quietly always absent:
 *
 *   - `#opCostNew` — the open-box extractor demanded a node saying "Open Box"
 *     beside the price. No such node exists, so it matched NOTHING on every
 *     product page for its entire life, and nobody could have noticed.
 *   - `conditionFromName` — anchored the marker to the end of the name; the
 *     live shape puts it mid-name. Would have matched nothing, on every
 *     refurbished page. Caught by driving one, not by any test.
 *   - `.clearance` — written up as unreadable from a grid card when it is
 *     present on 96 of 96, so the field went uncollected for months.
 *   - `.standardDiscount` — nearly anchored to the wrong element, which would
 *     have cleared real list prices site-wide.
 *
 * Fixtures cannot catch this class. A fixture is markup I wrote, and I write it
 * to match the selector I just wrote; the live site is the only authority, and
 * it changes without telling us. So the readers count what they saw and the
 * counts come here, where a ratio going to zero is visible.
 *
 * THREE NUMBERS PER READER, because two failure modes need telling apart:
 *
 *   seen   the reader ran and was in a position to look
 *   found  the element it looks for was actually present
 *   bad    the element WAS present and could not be parsed
 *
 * `found` collapsing toward zero means the element was renamed or removed.
 * `bad` climbing means the element is still there and its wording changed —
 * the case where the three-state reads deliberately keep the old value rather
 * than write a wrong one, which is safe but silent, and this is what breaks the
 * silence. The original `#opCostNew` bug had the signature `found` high with
 * `bad` equally high: the anchor was right there and nothing could be read out
 * of it.
 *
 * WHAT IT IS NOT. These are numbers a content script supplies about its own
 * behaviour, so they are advisory telemetry and not evidence of anything. They
 * are clamped and consistency-checked below, but a client that lies within the
 * clamp can still make the readers look healthier than they are. Nothing
 * depends on them; they exist to raise a question, and the answer always comes
 * from driving a real page. The admin panel says this in place.
 *
 * NOT per store, per category or per page. A selector is a property of Micro
 * Center's markup, and it either works or it does not — slicing these would add
 * dimensions that cannot change the answer while multiplying the row count.
 */
export const SELECTOR_NAMES = [
  // Grid cards. `card` is the container itself (`li.product_wrapper`): seen is
  // how many the page rendered, found is how many produced a usable reading.
  // It is the one reader whose failure hides all the others — if the container
  // selector breaks, the batch is empty and nothing downstream ever runs — so
  // catalog.js reports a batch with ZERO items rather than staying silent, and
  // this counter is the only thing that arrives.
  "card",
  // The card's own `.price_wrapper .price`, which anchors the list-price read.
  // Expected ~1.00; anything else means the anchor moved and `listSeen` has
  // stopped being licensed by anything.
  "price",
  // `.clearance` — open box. Expected ~1.00 found (it is on every card, empty
  // when there is no unit), and ~0 bad.
  "clearance",
  // `div.standardDiscount` — the advertised list price. UNLIKE the others this
  // is legitimately absent most of the time (about a third of cards carry a
  // discount), so a low found/seen is NORMAL here and only zero is a signal.
  // The panel labels it so nobody reads the ratio as a fault.
  "discount",
  // Product page: `#opCostNew` / `.openBoxModal .pricing`. seen is one per
  // product-page sighting; found means the element was on the page at all.
  "openBox",
] as const;

export type SelectorName = (typeof SELECTOR_NAMES)[number];

const selectorTally = v.object({
  seen: v.number(),
  found: v.number(),
  bad: v.number(),
});

/** Optional on every call: an old client sends none and is simply not counted. */
export const selectorHealthValidator = v.optional(
  v.object({
    card: v.optional(selectorTally),
    price: v.optional(selectorTally),
    clearance: v.optional(selectorTally),
    discount: v.optional(selectorTally),
    openBox: v.optional(selectorTally),
  }),
);

export type SelectorHealth = Partial<
  Record<SelectorName, { seen: number; found: number; bad: number }>
>;

/**
 * Validate a client's tally and fold it into the counters. Returns false if the
 * block was refused.
 *
 * ALL OR NOTHING. One inconsistent tally rejects the whole block rather than
 * the offending reader, because a client that can produce `found > seen` is a
 * client whose other numbers mean nothing either — accepting the rest would
 * mix trustworthy and untrustworthy counts into rows that can never be
 * separated again. Counters have no decrement path; the only safe direction is
 * to refuse.
 *
 * REFUSED IN BAND, never thrown. A tally is a side note attached to a real
 * sighting, and a throw would roll back the sighting — and its counters — over
 * a number nothing depends on. The refusal is counted (`sel:rejected`) and
 * returned to the caller so it cannot vanish.
 */
export async function recordSelectorHealth(
  ctx: MutationCtx,
  health: SelectorHealth | undefined,
  cap: number,
  now: number,
): Promise<boolean> {
  if (health === undefined) return true;

  for (const name of SELECTOR_NAMES) {
    const t = health[name];
    if (t === undefined) continue;
    // `found <= seen` and `bad <= found` are the shape's own invariants — the
    // reader cannot find an element on a card it never looked at, nor fail to
    // parse one it never found. A payload breaking either is not a client with
    // a bug, it is a client whose numbers are fabricated.
    if (
      !Number.isInteger(t.seen) || !Number.isInteger(t.found) || !Number.isInteger(t.bad) ||
      t.seen < 0 || t.seen > cap ||
      t.found < 0 || t.found > t.seen ||
      t.bad < 0 || t.bad > t.found
    ) {
      await bump(ctx, "sel:rejected");
      return false;
    }
  }

  const day = utcDay(now);
  for (const name of SELECTOR_NAMES) {
    const t = health[name];
    if (t === undefined) continue;
    for (const field of ["seen", "found", "bad"] as const) {
      const n = t[field];
      // Zero deltas are skipped rather than written: `bump` would insert a row
      // to hold a zero, and every reader would carry a `bad` row that has never
      // been anything else. The panel reads a missing counter as 0, which is
      // the same answer without the rows.
      if (n === 0) continue;
      await bump(ctx, `sel:${name}:${field}`, n);
      // The lifetime ratio degrades only slowly once a selector breaks — ten
      // thousand good readings drown the first thousand bad ones — so the daily
      // series is what actually shows a break the day it happens. Same shape as
      // `obs:day:*`, and read take-capped by the panel.
      await bump(ctx, `sel:day:${day}:${name}:${field}`, n);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Product price summary
// ---------------------------------------------------------------------------

/** The four extremes plus the newest sighting. All optional; absent = unknown. */
export type PriceSummary = {
  lowCorrob?: number;
  highCorrob?: number;
  lowAny?: number;
  highAny?: number;
  lastPrice?: number;
  lastSeenAt?: number;
};

/**
 * Widen `cur` to admit one sighting, returning ONLY the fields that changed, or
 * null when the sighting told us nothing new.
 *
 * Pure, and shared by all three callers — the two write paths and the recompute
 * — because the one thing this must never do is disagree with itself. The
 * summary's whole job is to let a grid badge quote a range without reading the
 * points; the moment the badge's number and the panel's number are produced by
 * two different pieces of arithmetic, one of them is lying on somebody's
 * screen.
 *
 * `corroborated` is the write-time form of the read-path predicate in
 * products.history (`reportCount > 1 || source !== "catalog"`): a product-page
 * reading is corroborated on arrival, and any reading whose row now carries a
 * reportCount above one has been seen twice. A lone catalog card is not, and so
 * widens only the ANY pair — it still counts as evidence, it just may not name
 * a record. That also covers promotion: when a catalog row is re-seen its count
 * crosses two, the caller passes true, and the price it has been holding all
 * along joins the corroborated extremes.
 */
export function widenSummary(
  cur: PriceSummary,
  price: number,
  seenAt: number,
  corroborated: boolean,
): PriceSummary | null {
  const patch: PriceSummary = {};
  if (cur.lowAny === undefined || price < cur.lowAny) patch.lowAny = price;
  if (cur.highAny === undefined || price > cur.highAny) patch.highAny = price;
  if (corroborated) {
    if (cur.lowCorrob === undefined || price < cur.lowCorrob) patch.lowCorrob = price;
    if (cur.highCorrob === undefined || price > cur.highCorrob) patch.highCorrob = price;
  }
  // `>=` deliberately: two sightings inside the same millisecond should leave
  // the later caller's price standing, which is the order the points are read
  // back in.
  if (cur.lastSeenAt === undefined || seenAt >= cur.lastSeenAt) {
    if (cur.lastPrice !== price) patch.lastPrice = price;
    if (cur.lastSeenAt !== seenAt) patch.lastSeenAt = seenAt;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

/**
 * What the badge may claim, derived from a summary exactly as products.history
 * derives it from the points: the corroborated extremes when they exist, the
 * uncorroborated ones as a flagged fallback when they do not.
 */
export function readSummary(cur: PriceSummary): {
  low: number | null;
  high: number | null;
  provisional: boolean;
  lastPrice: number | null;
  observedAt: number | null;
} {
  const provisional = cur.lowCorrob === undefined && cur.lowAny !== undefined;
  return {
    low: cur.lowCorrob ?? cur.lowAny ?? null,
    high: cur.highCorrob ?? cur.highAny ?? null,
    provisional,
    lastPrice: cur.lastPrice ?? null,
    observedAt: cur.lastSeenAt ?? null,
  };
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
 * The one implementation of the filter: which rule this text breaks, or null.
 *
 * Both public entry points below are wrappers over this, so the word list and
 * the patterns exist exactly once. Two call sites need two different shapes —
 * comments throw, handle claims answer in band (auth:claimHandle must commit
 * its rate-limit token, so it cannot throw for an expected refusal) — and the
 * one thing that must never happen is a second copy of PROFANITY drifting out
 * of step with this one.
 */
function contentViolation(
  text: string,
): { code: string; message: string } | null {
  if (URL_PATTERNS.some((re) => re.test(text))) {
    return {
      code: "LINKS_NOT_ALLOWED",
      message: "Links aren't allowed in comments",
    };
  }
  if (PHONE_PATTERN.test(text) || EMAIL_PATTERN.test(text)) {
    return {
      code: "CONTACT_INFO_NOT_ALLOWED",
      message: "Contact info isn't allowed in comments",
    };
  }
  if (PROFANITY_PATTERN.test(text.toLowerCase())) {
    return {
      code: "CONTENT_REJECTED",
      message: "Keep it civil — comment rejected",
    };
  }
  return null;
}

/**
 * Does this text pass the filter? Non-throwing counterpart of
 * {@link requireCleanContent}, for callers that report a refusal in band.
 */
export function isCleanContent(text: string): boolean {
  return contentViolation(text) === null;
}

/**
 * Reject links, contact info, and profanity in user-visible text.
 * Throws ConvexError with codes LINKS_NOT_ALLOWED / CONTACT_INFO_NOT_ALLOWED /
 * CONTENT_REJECTED. Call with already-sanitized text.
 */
export function requireCleanContent(text: string): void {
  const violation = contentViolation(text);
  if (violation === null) return;
  throw new ConvexError(violation);
}

// ---------------------------------------------------------------------------
// Claimed handles
// ---------------------------------------------------------------------------

/**
 * Fold a name to its collision key: lowercase, then every character outside
 * [a-z0-9] removed.
 *
 * Separators are stripped rather than kept because the near-miss is the whole
 * attack. If "hex-byte" and "hex_byte" were different keys, the reservation
 * would protect one spelling of a name and hand out every neighbouring one —
 * and a reader skimming a thread cannot tell them apart. So Hex_Byte, hex-byte,
 * HEXBYTE and "hex byte" are one identity, claimable once and typeable by
 * nobody else.
 *
 * Used for BOTH jobs the key does: uniqueness between accounts, and the block
 * on anonymous commenters typing a claimed name. They must fold identically or
 * the second is a sieve, which is why there is one function rather than two.
 *
 * Returns "" for a string with no alphanumerics at all; callers treat that as
 * "no identity here" rather than as a key to look up.
 */
export function handleKeyOf(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * 3–20 characters, first and last alphanumeric, `_` and `-` allowed between.
 *
 * ASCII only, deliberately. handleKeyOf folds case and separators, but nothing
 * can fold a Cyrillic "а" onto a Latin "a" — so allowing non-ASCII would mean
 * handing out visually identical handles with different keys, and the
 * reservation promise would be false on the claim side as well as the typed
 * side. (It is still only a promise about *claimed* names: see the note on
 * confusables above comments:add.)
 */
const HANDLE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,18}[A-Za-z0-9]$/;

/**
 * Names nobody may claim, compared on the handleKey so every spelling of each
 * is covered at once ("m-o-d" folds to "mod").
 *
 * Three kinds of word: things that would read as Jackdaw or Micro Center
 * speaking, things that would read as a role with authority over other
 * commenters, and words the UI itself might render in place of a name — a
 * handle of "deleted" or "anonymous" impersonates a *state*, which is the same
 * trick one level down.
 */
const RESERVED_HANDLE_KEYS = new Set([
  // The project speaking for itself
  "jackdaw",
  "jackdaws",
  "jackdawapp",
  "jackdawsapp",
  "jackdawteam",
  "jackdawstaff",
  "jackdawsupport",
  "jackdawofficial",
  "jackdawbot",
  // The retailer
  "microcenter",
  "micro",
  "microcenterofficial",
  "mc",
  // Authority over other commenters
  "admin",
  "admins",
  "administrator",
  "mod",
  "mods",
  "moderator",
  "moderators",
  "staff",
  "team",
  "support",
  "help",
  "helpdesk",
  "official",
  "system",
  "sysop",
  "operator",
  "owner",
  "founder",
  "security",
  "abuse",
  "legal",
  "privacy",
  "terms",
  "billing",
  // The marker itself
  "verified",
  "verify",
  // Machine and mailbox names
  "root",
  "api",
  "bot",
  "webmaster",
  "noreply",
  "donotreply",
  "mail",
  "email",
  // States the UI may render where a name goes
  "null",
  "undefined",
  "none",
  "nil",
  "anonymous",
  "anon",
  "guest",
  "unknown",
  "deleted",
  "removed",
  "banned",
  "everyone",
  "here",
  "all",
  "me",
]);

/**
 * Brand names nobody may wear, blocked as a PREFIX rather than by enumeration.
 *
 * The set above covers "microcenter" and "staff" as separate keys, which left
 * the compound "microcenterstaff" claimable — 16 alphanumeric characters, so it
 * passes HANDLE_SHAPE and would have carried a verified marker. Enumerating the
 * compounds loses: the family is "brand + any word that sounds like a role",
 * and the one role word left off the list is the one that gets used.
 *
 * So the rule is the blunt one — no handle may BEGIN with either brand name.
 * It over-blocks the enthusiast case ("MicroCenterFan" is refused, and could be
 * "MCFan" instead), and that is the right side to err on: Jackdaw is not
 * affiliated with Micro Center and says so on every surface, so a ticked handle
 * reading as the retailer is the single most damaging name in the product.
 *
 * Only these two are long and distinctive enough to prefix-match. "mc" and
 * "micro" stay exact-match above, because prefix-blocking them would refuse
 * "mcqueen" and "microwave" for nothing.
 */
const RESERVED_HANDLE_PREFIXES = ["jackdaw", "microcenter"];

/** Is this fold a name nobody may claim? */
export function isReservedHandleKey(key: string): boolean {
  if (RESERVED_HANDLE_KEYS.has(key)) return true;
  return RESERVED_HANDLE_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * The second form the content filter has to see, with separators turned into
 * spaces. Applies to anything a person types: handles, names and comment
 * bodies alike.
 *
 * PROFANITY_PATTERN is a word-boundary blocklist, and JavaScript's `\b` counts
 * "_" as a word character — so "shit-head" is caught and "shit_head" is not.
 * One underscore anywhere beside a listed word hides it. Proven on dev before
 * this existed: the claim succeeded.
 *
 * Callers filter the raw text as well, and a violation in EITHER form rejects,
 * so folding can only ever catch more. It cannot weaken the link, contact-info
 * or phone patterns: those already treat "-" and spaces as separators, and any
 * address the fold breaks apart was caught on the raw pass first.
 *
 * What no fold reaches is a word split through its middle — "sh_it", "sh1t".
 * That defeats every blocklist there has ever been, and this one does not
 * pretend otherwise; reports and auto-hide are what catch the deliberate.
 */
export function separatorFoldedForm(text: string): string {
  return text.replace(/[_-]+/g, " ");
}

/** Does this string satisfy the handle format? Call with sanitized text. */
export function isWellFormedHandle(handle: string): boolean {
  return HANDLE_SHAPE.test(handle);
}
