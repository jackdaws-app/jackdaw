import { v } from "convex/values";
import { env, internalAction, internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { hashSecret, secretsMatch } from "./lib";

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

/** `$1,299.99` — the same formatting every other Jackdaw surface uses. */
function money(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Minimal escape for values interpolated into the HTML body. */
function esc(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
    await ctx.db.patch(accountId, { emailAlerts: false });
    return { ok: true, email: account.email };
  },
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * One pass: read what is owed, send it, mark what actually went out.
 *
 * An ACTION rather than a mutation because it makes network calls, which is
 * also what forces the read/send/write split — an action holds no transaction,
 * so the marker cannot ride along with the send and the ordering has to be
 * chosen deliberately. It is: send first, mark second, per watch. A crash
 * between the two costs a duplicate email on the next sweep; the other order
 * costs a price drop nobody is ever told about. Duplicates are survivable and
 * silence is not.
 *
 * Nothing here throws. A scheduled function that throws logs a stack nobody
 * reads and takes the rest of the batch with it, so one address that Resend
 * refuses must not cost the other ninety-nine their mail.
 */
type SweepResult = {
  sent: number;
  failed: number;
  scanned: number;
  truncated: boolean;
};

export const sweep = internalAction({
  args: {},
  returns: v.object({
    sent: v.number(),
    failed: v.number(),
    scanned: v.number(),
    truncated: v.boolean(),
  }),
  // Annotated rather than inferred. An action that calls a function through
  // `internal` is part of the graph `internal` is derived from, so letting
  // TypeScript infer this makes the type reference itself and collapses to
  // `any` — with a TS7022 that names `due` rather than the cycle. Same
  // annotation, for the same reason, as auth:verifyCode's.
  handler: async (ctx): Promise<SweepResult> => {
    const apiKey = env.RESEND_API_KEY ?? "";
    if (apiKey.length === 0) {
      // The supported development state — dev deliberately has no key so that
      // auth:devPeekCode keeps working. Say so once per sweep and do nothing
      // else: marking rows here would silence alerts that were never sent.
      console.warn(
        "alerts: RESEND_API_KEY is unset — sweep skipped, no rows marked.",
      );
      return { sent: 0, failed: 0, scanned: 0, truncated: false };
    }

    const due = await ctx.runQuery(internal.watches.dueForEmail, {});
    if (due.truncated) {
      console.warn(
        `alerts: sweep hit its send cap with ${due.scanned} rows scanned — the remainder waits for the next run. If this repeats, the interval is too long for the volume.`,
      );
    }
    if (due.fires.length === 0) {
      return { sent: 0, failed: 0, scanned: due.scanned, truncated: due.truncated };
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
        continue;
      }
      sent++;
      // Only now. See the ordering note above.
      await ctx.runMutation(internal.watches.markEmailed, {
        watchId: fire.watchId as Id<"watches">,
        at: Date.now(),
      });
    }

    return { sent, failed, scanned: due.scanned, truncated: due.truncated };
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
    return `Open box seen at ${money(fire.openBoxPrice)} — ${fire.name}`;
  }
  if (fire.reason === "restock") return `Back in stock — ${fire.name}`;
  return `${money(fire.currentPrice)} — ${fire.name}`;
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

function bodyText(fire: Fire, unsubUrl: string | null): string {
  const lines = [
    fire.name,
    "",
    headline(fire),
    "",
    productUrl(fire.urlPath),
    "",
    CAVEAT,
    "",
    "— Jackdaw",
  ];
  if (unsubUrl !== null) {
    lines.push("", `Turn these emails off: ${unsubUrl}`);
  }
  return lines.join("\n");
}

function bodyHtml(fire: Fire, unsubUrl: string | null): string {
  const unsub =
    unsubUrl === null
      ? ""
      : `<p style="margin:22px 0 0;font-size:12px;line-height:1.5;color:#8a8a80"><a href="${esc(
          unsubUrl,
        )}" style="color:#8a8a80">Turn these emails off</a></p>`;
  return [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:460px;margin:0 auto;padding:28px 24px;color:#1c1e21">`,
    `<p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8a8a80">Jackdaw</p>`,
    `<p style="margin:0 0 18px;font-size:16px;font-weight:600;line-height:1.35">${esc(fire.name)}</p>`,
    `<p style="margin:0 0 22px;font-size:14px;line-height:1.55">${esc(headline(fire))}</p>`,
    `<p style="margin:0 0 22px"><a href="${esc(
      productUrl(fire.urlPath),
    )}" style="display:inline-block;background:#16233a;color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:10px 18px;border-radius:8px">See it on Micro Center</a></p>`,
    `<p style="margin:0;font-size:12px;line-height:1.55;color:#6b6b63">${CAVEAT}</p>`,
    unsub,
    `</div>`,
  ].join("");
}
