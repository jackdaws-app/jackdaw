import { v } from "convex/values";
import { env, internalAction, internalMutation } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { bump, hashSecret, secretsMatch, utcDay } from "./lib";

// ---------------------------------------------------------------------------
// Email alerts — the delivery half
//
// watches.ts owns what a fire IS. This file owns getting it into an inbox, and
// exists as its own module because the two halves fail differently: a bug here
// sends the wrong words to a real person, and a bug there sends the right words
// about the wrong price. Keeping the network in one file also keeps the mail
// provider out of watches.ts entirely.
//
// WHAT THIS FILE MAY DO WITH AN ADDRESS, exhaustively: send the alert the
// person armed, after they switched email alerts on. Nothing else. PRIVACY.md
// §2 is the ceiling and CONVENTIONS.md's decided question says why it is not
// reinterpretable — no announcement, no digest, no "while we have you", not
// even a one-off. Any of those needs an amended policy and fresh consent first.
// ---------------------------------------------------------------------------

// CONVEX_SITE_URL is a Convex SYSTEM variable — the .convex.site origin this
// deployment serves http.ts from. It is not one of ours, so it is absent from
// the typed `env` convex.config.ts declares, and @types/node is deliberately
// not a dependency here: pulling Node's entire global surface into a runtime
// that is not Node, to type one string, is the worse trade. One narrow
// declaration instead.
import { POLICY_LINKS, button, esc, layout, money, para, textFooter } from "./mail";

declare const process: { env: Record<string, string | undefined> };

const DEFAULT_FROM = "Jackdaw <noreply@jackdaws.app>";
const MAIL_TIMEOUT_MS = 10_000;

/** Micro Center product URLs, for the one link an alert carries. */
const RETAILER = "https://www.microcenter.com";

/**
 * A product path, made safe to concatenate.
 *
 * Micro Center's own dataLayer can hand us a slug carrying an undecoded HTML
 * numeric character reference — product 684336 ends `...with-900&#181;m-fiber-holder`,
 * seven literal characters, because a script body is not HTML and nothing
 * decodes it. Concatenated raw, that `#` becomes a fragment delimiter and the
 * link arrives truncated. `encodeURI` does NOT fix this; it leaves `#` and `&`
 * alone as reserved characters.
 *
 * This is the third copy of this two-character fix (background.js and popup.js
 * hold the others) and it is duplicated for the same reason they are: a service
 * worker, a popup and a Convex action share no module.
 */
function productUrl(urlPath: string): string {
  return RETAILER + urlPath.replace(/#/g, "%23");
}



// ---------------------------------------------------------------------------
// Unsubscribe tokens
//
// An unsubscribe link has to work for someone who is not signed in, on a device
// that has never held a session — that is the entire point of it, and it is why
// this cannot reuse the session machinery.
//
// So the token is the account id plus a keyed digest of it, under the same
// AUTH_PEPPER everything else is hashed with. It is unguessable without the
// pepper, it is verifiable with no extra row to store or expire, and the worst
// a forged one can do is stop mail the forger was not receiving. It is scoped
// by the `:unsub:` infix so a token minted here can never be replayed as a
// session, a sign-in code, or whatever the next hashed secret turns out to be.
// ---------------------------------------------------------------------------

async function unsubDigest(accountId: string): Promise<string> {
  return hashSecret(`jackdaw:unsub:${accountId}`);
}

/** The `token` query parameter for one account's unsubscribe link. */
export async function unsubToken(accountId: string): Promise<string> {
  return `${accountId}.${await unsubDigest(accountId)}`;
}

/**
 * Turn email alerts off from an unsubscribe link.
 *
 * IN BAND, never thrown. The caller is an HTTP action rendering a page to a
 * person who clicked a link in their mail; a thrown refusal there is a 500 and
 * a dead end, where a verdict is a sentence they can act on.
 *
 * Idempotent by construction: a second click patches a row that already reads
 * false, and answers "ok" both times. An unsubscribe confirming twice is
 * correct behaviour, and one that said "already done, go away" would only make
 * a person wonder whether the first click worked.
 */
export const unsubscribeByToken = internalMutation({
  args: { token: v.string() },
  returns: v.object({
    ok: v.boolean(),
    email: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const refused = { ok: false, email: null };
    // Cap before doing any work: a token is ~100 characters and there is no
    // reason to hash a megabyte of junk somebody pasted into a query string.
    if (args.token.length === 0 || args.token.length > 200) return refused;

    const cut = args.token.lastIndexOf(".");
    if (cut <= 0) return refused;
    const rawId = args.token.slice(0, cut);
    const digest = args.token.slice(cut + 1);

    // normalizeId rather than a cast: a malformed id must be a refusal, not a
    // thrown "invalid id" out of ctx.db.get.
    const accountId = ctx.db.normalizeId("accounts", rawId);
    if (accountId === null) return refused;

    // Constant-time compare, same helper the admin key and session paths use.
    if (!secretsMatch(digest, await unsubDigest(accountId))) return refused;

    const account = await ctx.db.get(accountId);
    if (account === null) return refused;

    // Patch unconditionally rather than only when true — a row that predates
    // the field has it absent, and writing the explicit false is what records
    // that this person has now been asked and answered.
    const wasOn = account.emailAlerts === true;
    await ctx.db.patch(accountId, { emailAlerts: false });
    // Only a real on -> off transition counts. This endpoint is deliberately
    // idempotent and answers "ok" twice, and a mail client may fire the
    // one-click POST alongside a human clicking the same link — so counting
    // every call would inflate the one number that is supposed to say how many
    // people asked to stop.
    if (wasOn) {
      const now = Date.now();
      await bump(ctx, "alerts:email:unsub");
      await bump(ctx, `alerts:email:unsub:day:${utcDay(now)}`);
    }
    return { ok: true, email: account.email };
  },
});

/**
 * Record sends the provider refused.
 *
 * The sweep is an ACTION and holds no transaction, so it cannot bump anything
 * itself. Successes are counted inside `watches.markEmailed`, which each one
 * already calls; a failure calls no mutation at all, which is exactly why the
 * failed half needs its own. Called once per sweep and only when non-zero, so
 * the ordinary run costs no extra round trip.
 *
 * Separate from the success counter on purpose: `sent` climbing while `failed`
 * stays flat is a healthy mailer, and `failed` climbing alone is the shape a
 * revoked API key, a suspended domain or a provider outage makes. Neither is
 * legible from the other.
 */
export const recordSendFailures = internalMutation({
  args: { failed: v.number(), at: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.failed) || args.failed <= 0) return null;
    await bump(ctx, "alerts:email:failed", args.failed);
    await bump(ctx, `alerts:email:failed:day:${utcDay(args.at)}`, args.failed);
    return null;
  },
});

// ---------------------------------------------------------------------------
// The two passes
//
// One body, two entry points, and the difference between them is entirely in
// what they are ALLOWED TO FAIL AT.
//
//   sweep   — hourly, every armed-and-unsent row. The guarantee. If it stops
//             running, people stop being told, and that is an outage.
//   fanOut  — scheduled off a sighting that changed a price, a stock flag or an
//             open-box figure, carrying only the products that changed. An
//             accelerator. If it never runs, never fires, or dies halfway, the
//             sweep sends the same mail within the hour and nobody can tell the
//             difference except by the timestamp.
//
// Keeping them one function is deliberate: two send loops would drift, and the
// one that drifted would be the one nobody watches.
//
// THE SEND CAP IS PER PASS, NOT PER HOUR. EMAIL_SEND_LIMIT (watches.ts) bounds
// what one action tries serially, which is an action-time-limit fact, not a
// throughput decision. A pass that fills its cap and actually sent something
// schedules itself again immediately (`hop` below), up to MAX_HOPS passes
// deep, so an hour's throughput is MAX_HOPS x the cap rather than the cap —
// at 100k installs the backlog behind one price drop on a popular product is
// not a hundred rows, and a cap that only the clock could reset would have
// spread one alert over days. A pass that sent NOTHING never chains: an
// all-failed pass (provider down, key revoked) releases its claims, and a
// chain off that would loop at full speed against a dead provider until the
// hop limit and log nothing useful on the way.
// ---------------------------------------------------------------------------

// How many times one trigger (a cron tick or a sighting) may re-schedule
// itself. Twelve passes at EMAIL_SEND_LIMIT is 1,200 sends from one hourly
// tick and 300 from one fan-out, each in its own action with its own time
// budget and its own claim window; anything still owed past that is the next
// tick's, exactly as before. Bounded because a chain that could run forever is
// a chain that CAN, and the cron is the guarantee either way.
const MAX_HOPS = 12;

/**
 * One pass: claim what is owed, send it, mark what actually went out.
 *
 * An ACTION rather than a mutation because it makes network calls, which is
 * also what forces the read/send/write split — an action holds no transaction,
 * so the marker cannot ride along with the send and the ordering has to be
 * chosen deliberately. It is:
 *
 *   claim (mutation) -> send (network) -> mark, or release on failure.
 *
 * THE CLAIM IS NEW AND THE ORDERING NOTE THAT USED TO LIVE HERE WAS REVERSED BY
 * IT. With one sender on a schedule, "send first, mark second" was right: the
 * only race was against a crash, duplicates were survivable and silence was
 * not. With a second sender firing off page views the race stops being
 * crash-shaped and becomes traffic-shaped — two passes over the same row at the
 * same second, which on a popular product is not an edge case but the normal
 * one. So the row is claimed inside the read, and the marker still lands only
 * after the send. Silence stays bounded: a stranded claim clears itself after
 * EMAIL_CLAIM_TTL_MS and the next sweep sends it.
 *
 * Nothing here throws. A scheduled function that throws logs a stack nobody
 * reads and takes the rest of the batch with it, so one address the mail
 * provider refuses must not cost the other ninety-nine their mail.
 */
type SweepResult = {
  sent: number;
  failed: number;
  scanned: number;
  truncated: boolean;
  // Which pass of a chain this was (0 for the one the trigger started) and
  // whether it scheduled another. For the function log only.
  hop: number;
  chained: boolean;
};

const passResultValidator = v.object({
  sent: v.number(),
  failed: v.number(),
  scanned: v.number(),
  truncated: v.boolean(),
  hop: v.number(),
  chained: v.boolean(),
});

/** Whether a finished pass has earned another one. See MAX_HOPS. */
function shouldChain(
  result: Pick<SweepResult, "sent" | "truncated">,
  hop: number,
): boolean {
  return result.truncated && result.sent > 0 && hop < MAX_HOPS;
}

async function runPass(
  ctx: ActionCtx,
  productDocIds: Id<"products">[] | undefined,
): Promise<SweepResult> {
  const label = productDocIds === undefined ? "sweep" : "fan-out";
  const apiKey = env.RESEND_API_KEY ?? "";
  if (apiKey.length === 0) {
    // A deployment with no key configured. This was dev's steady state until
    // 2026-08-20, when the key was set there so real mail could be tested;
    // dev now takes the normal path and `auth:devPeekCode` returns no code
    // while it is set. Say so once per pass and do nothing else — and in
    // particular DO NOT CLAIM: claiming here would stamp rows nobody is going
    // to send, and every one of them would then sit unreachable until the TTL
    // expired. Nothing is counted either — a pass that never had a key did not
    // fail to send, it declined to try, and folding the two together would make
    // an unconfigured deployment look like a broken one.
    console.warn(
      `alerts: RESEND_API_KEY is unset — ${label} skipped, no rows claimed or marked.`,
    );
    return { sent: 0, failed: 0, scanned: 0, truncated: false, hop: 0, chained: false };
  }

  // The claim handle. One value for the whole pass, so releaseEmailClaim can
  // tell our claim from a later one and refuse to clear somebody else's.
  const claimedAt = Date.now();
  const due = await ctx.runMutation(internal.watches.claimDueForEmail, {
    at: claimedAt,
    ...(productDocIds === undefined ? {} : { productDocIds }),
  });
  // Only the sweep's truncation is a warning. A fan-out hitting its much
  // tighter send cap is the cap working: it is not the backstop, and the sweep
  // has whatever it left behind.
  if (due.truncated && productDocIds === undefined) {
    console.warn(
      `alerts: sweep hit its send cap with ${due.scanned} rows scanned — it will chain another pass if this one sends; if a chain runs out at MAX_HOPS, the interval is too long for the volume.`,
    );
  }
  if (due.fires.length === 0) {
    return { sent: 0, failed: 0, scanned: due.scanned, truncated: due.truncated, hop: 0, chained: false };
  }

  const from = env.JACKDAW_FROM_EMAIL ?? DEFAULT_FROM;
  // CONVEX_SITE_URL is a Convex system variable, not one of ours, so it
  // comes off process.env rather than the typed `env` that convex.config.ts
  // declares. It is the .convex.site origin that http.ts is served from —
  // the deployment knows its own address, so no config has to hold it and
  // a dev deployment mints dev links without anyone remembering to.
  const site = process.env.CONVEX_SITE_URL ?? "";
  let sent = 0;
  let failed = 0;

  for (const fire of due.fires) {
    const unsubUrl =
      site.length === 0
        ? null
        : `${site}/unsubscribe?token=${encodeURIComponent(
            await unsubToken(fire.accountId),
          )}`;
    const ok = await deliver(apiKey, from, fire, unsubUrl);
    if (!ok) {
      failed++;
      // Hand it back unsent, so the next pass can try it immediately instead
      // of waiting out the claim. Best-effort by construction: if this write
      // is the thing that failed, the TTL still frees the row.
      await ctx.runMutation(internal.watches.releaseEmailClaim, {
        watchId: fire.watchId as Id<"watches">,
        at: claimedAt,
      });
      continue;
    }
    sent++;
    // Only now. See the ordering note above.
    await ctx.runMutation(internal.watches.markEmailed, {
      watchId: fire.watchId as Id<"watches">,
      at: Date.now(),
    });
  }

  // Counted after the loop rather than inside it: a refusal writes nothing
  // else, so there is no transaction to join, and one mutation for the run
  // beats one per failure when a provider outage fails every message.
  if (failed > 0) {
    await ctx.runMutation(internal.alerts.recordSendFailures, {
      failed,
      at: Date.now(),
    });
  }

  return { sent, failed, scanned: due.scanned, truncated: due.truncated, hop: 0, chained: false };
}

/**
 * The hourly pass over every armed-and-unsent row. The guarantee.
 *
 * `hop` is the chain depth and is only ever set by this function scheduling
 * itself; the cron passes nothing and starts at 0. A pass that filled its cap
 * and sent at least one mail schedules the next pass with no delay — a fresh
 * action, so a fresh time budget, and a fresh claim stamp so the released and
 * still-unclaimed rows are simply what it finds. See the header note on why
 * the cap is per pass.
 */
export const sweep = internalAction({
  args: { hop: v.optional(v.number()) },
  returns: passResultValidator,
  // Annotated rather than inferred. An action that calls a function through
  // `internal` is part of the graph `internal` is derived from, so letting
  // TypeScript infer this makes the type reference itself and collapses to
  // `any` — with a TS7022 that names a local rather than the cycle. Same
  // annotation, for the same reason, as auth:verifyCode's.
  handler: async (ctx, args): Promise<SweepResult> => {
    const hop = args.hop ?? 0;
    const result = await runPass(ctx, undefined);
    const chained = shouldChain(result, hop);
    if (chained) {
      await ctx.scheduler.runAfter(0, internal.alerts.sweep, { hop: hop + 1 });
    }
    return { ...result, hop, chained };
  },
});

/**
 * The reactive pass, scheduled off a sighting that changed something.
 *
 * SCHEDULED FROM A MUTATION, WHICH IS WHY THE CLAIM IS NOT TAKEN HERE. Convex
 * schedules a mutation exactly once and retries it; it schedules an ACTION at
 * most once and never retries it. A claim written by the scheduling mutation
 * would therefore be stranded whenever the action it was written for failed to
 * start — rows marked as being sent by a sender that does not exist, held for
 * the whole TTL. Taking the claim as this action's first step means a job that
 * never runs leaves nothing behind at all.
 *
 * The caller passes only products whose reading actually MOVED — a re-sighting
 * that patched a row cannot change a verdict, so scheduling on one would be a
 * job that reads a few hundred rows and finds nothing every time.
 *
 * Returns the same shape the sweep does, and nothing consumes it: it exists for
 * the function log, which is the only place a fan-out is visible at all.
 */
export const fanOut = internalAction({
  args: {
    productDocIds: v.array(v.id("products")),
    hop: v.optional(v.number()),
  },
  returns: passResultValidator,
  handler: async (ctx, args): Promise<SweepResult> => {
    const hop = args.hop ?? 0;
    if (args.productDocIds.length === 0) {
      return { sent: 0, failed: 0, scanned: 0, truncated: false, hop, chained: false };
    }
    const result = await runPass(ctx, args.productDocIds);
    // Same products, next pass: the reactive index is "armed and unsent" per
    // product, so what the first pass marked has left the set and the second
    // reads what remains. Same chain rule as the sweep, same hop ceiling.
    const chained = shouldChain(result, hop);
    if (chained) {
      await ctx.scheduler.runAfter(0, internal.alerts.fanOut, {
        productDocIds: args.productDocIds,
        hop: hop + 1,
      });
    }
    return { ...result, hop, chained };
  },
});

type Fire = {
  email: string;
  name: string;
  urlPath: string;
  priceAtWatch: number;
  currentPrice: number;
  storeNum: string;
  reason: "price" | "openBox" | "restock";
  observedAt: number;
  openBoxPrice?: number;
};

/** One send. Returns whether it landed; never throws. */
async function deliver(
  apiKey: string,
  from: string,
  fire: Fire,
  unsubUrl: string | null,
): Promise<boolean> {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [fire.email],
        subject: subjectFor(fire),
        text: bodyText(fire, unsubUrl),
        html: bodyHtml(fire, unsubUrl),
        // RFC 8058 one-click. Gmail and Yahoo treat these as the difference
        // between a bulk sender and a suspected one, and the POST variant is
        // what makes the button in their UI work without opening a browser.
        // Both headers or neither: List-Unsubscribe-Post without the URL is
        // malformed and worse than sending nothing.
        ...(unsubUrl === null
          ? {}
          : {
              headers: {
                "List-Unsubscribe": `<${unsubUrl}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              },
            }),
      }),
      // Without this a hung connection holds the action open to its limit, and
      // takes the rest of the batch with it.
      signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text();
      // Never the address: a log line is not the place for one, and the account
      // id is enough to find the row.
      console.error(
        `alerts: Resend refused a send (${response.status}): ${body.slice(0, 300)}`,
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error(`alerts: send failed: ${String(error)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// The words
//
// Register: this is UI copy, not legal text, and it is read on a phone in a
// notification shade. It says WHAT WAS SEEN and WHEN, never what is in stock
// now — every figure Jackdaw holds is a dated sighting by another shopper, and
// an email that arrives an hour later and says "it's $94.99" is asserting a
// present tense nothing here can support. Same "last seen" idiom as the panel,
// the popup and the chart tooltip.
// ---------------------------------------------------------------------------

function subjectFor(fire: Fire): string {
  if (fire.reason === "openBox" && fire.openBoxPrice !== undefined) {
    return `Open box at ${money(fire.openBoxPrice)}: ${fire.name}`;
  }
  if (fire.reason === "restock") return `Back in stock: ${fire.name}`;
  return `Seen at ${money(fire.currentPrice)}: ${fire.name}`;
}

function eyebrowFor(fire: Fire): string {
  if (fire.reason === "openBox") return "Open box alert";
  if (fire.reason === "restock") return "Back in stock";
  return "Price alert";
}

/** "3 minutes ago", "2 hours ago", "yesterday". Coarse on purpose. */
function ago(observedAt: number): string {
  const mins = Math.max(0, Math.round((Date.now() - observedAt) / 60000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function headline(fire: Fire): string {
  if (fire.reason === "openBox" && fire.openBoxPrice !== undefined) {
    return `An open-box unit was seen at ${money(
      fire.openBoxPrice,
    )} at store #${fire.storeNum}, ${ago(fire.observedAt)}.`;
  }
  if (fire.reason === "restock") {
    return `It was seen in stock at store #${fire.storeNum}, ${ago(
      fire.observedAt,
    )}, at ${money(fire.currentPrice)}.`;
  }
  return `It was seen at ${money(fire.currentPrice)}, ${ago(
    fire.observedAt,
  )}. You asked to hear at ${money(fire.priceAtWatch)}.`;
}

const CAVEAT =
  "This is a sighting recorded by another shopper, not live inventory. Check with Micro Center before driving over.";

function footerLinks(unsubUrl: string | null) {
  return unsubUrl === null
    ? POLICY_LINKS
    : [...POLICY_LINKS, { label: "Turn these emails off", href: unsubUrl }];
}

export function bodyText(fire: Fire, unsubUrl: string | null): string {
  return [
    fire.name,
    "",
    headline(fire),
    "",
    productUrl(fire.urlPath),
    "",
    CAVEAT,
    ...textFooter(footerLinks(unsubUrl)),
  ].join("\n");
}

export function bodyHtml(fire: Fire, unsubUrl: string | null): string {
  return layout({
    eyebrow: eyebrowFor(fire),
    preheader: headline(fire),
    links: footerLinks(unsubUrl),
    body: [
      `<div class="jd-ink" style="margin:14px 0 0;font-size:17px;font-weight:600;line-height:1.35;color:#16233a">${esc(fire.name)}</div>`,
      para(esc(headline(fire))),
      button("See it on Micro Center", productUrl(fire.urlPath)),
      para(esc(CAVEAT), { muted: true, top: 20 }),
    ].join(""),
  });
}
