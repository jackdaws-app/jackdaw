import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

// ---------------------------------------------------------------------------
// Public HTTP surface
//
// One route, and the bar for a second is high: everything else Jackdaw does is
// a Convex function called by a client that can hold a session, which is a
// smaller and better-understood surface than an open URL. This route exists
// because it is the one thing that CANNOT work that way — an unsubscribe link
// is clicked from a mail client, by a person who is not signed in, quite
// possibly on a phone that has never run the extension.
//
// It is deliberately the only capability the token grants. See alerts.ts for
// why the worst a forged one can do is stop mail the forger was not getting.
// ---------------------------------------------------------------------------

const http = httpRouter();

/**
 * A page a person lands on.
 *
 * Plain and self-contained: no stylesheet to fetch, no script, nothing that
 * needs the site to be up. A mail client's in-app browser is the worst
 * rendering environment this project targets and this is the page that has to
 * work in it. `body` is already-escaped HTML for the paragraph; `extra` is
 * already-escaped HTML placed after it (the confirmation form).
 *
 * No page names the account's email address any more. See unsubscribeByToken.
 */
function page(title: string, body: string, extra = ""): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Jackdaw</title></head>
<body style="margin:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1c1e21">
<div style="max-width:420px;margin:0 auto;padding:64px 24px">
<p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8a8a80">Jackdaw</p>
<h1 style="margin:0 0 14px;font-size:20px;font-weight:600;line-height:1.3">${title}</h1>
<p style="margin:0;font-size:14px;line-height:1.6;color:#4b5563">${body}</p>
${extra}
</div></body></html>`;
}

const BAD_LINK = page(
  "That link didn't work",
  "It may have been truncated by your mail client, or the account may no longer exist. " +
    "You can turn email alerts off directly from the Jackdaw toolbar icon.",
);

const ALERTS_OFF = page(
  "Email alerts are off",
  "We won't email you about price alerts again. Your watches are untouched and still fire in the browser. " +
    "Turn email back on any time from the Jackdaw toolbar icon.",
);

/**
 * The question a GET asks. The form posts back to the SAME URL, token and
 * all, so the POST handler reads the token from one place whichever door it
 * came through; `confirm=1` is what tells it a person pressed the button.
 */
function confirmPage(token: string): string {
  const action = escapeHtml(`/unsubscribe?token=${encodeURIComponent(token)}`);
  return page(
    "Turn off email alerts?",
    "Jackdaw will stop emailing you when one of your alerts fires. Your watches stay as they are and still alert in the browser.",
    `<form method="post" action="${action}" style="margin:24px 0 0">
<input type="hidden" name="confirm" value="1">
<button type="submit" style="display:inline-block;border:0;border-radius:8px;background:#16233a;color:#ffffff;font:inherit;font-size:14px;font-weight:600;padding:11px 18px;cursor:pointer">Turn off email alerts</button>
</form>`,
  );
}

/**
 * Every HTML answer this route gives, with the same headers.
 *
 * `no-store` because the URL carries a token. `no-referrer` so the token never
 * rides out in a Referer header. The CSP says what the page is: no scripts, no
 * fetches, inline styles only, and one form that may only post back here.
 * `frame-ancestors 'none'` because a page whose one button turns something off
 * must not be framed under someone else's.
 */
function htmlResponse(status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function tokenOf(request: Request): string {
  return new URL(request.url).searchParams.get("token") ?? "";
}

/**
 * GET — a person, or something fetching links on a person's behalf.
 *
 * WRITES NOTHING, and that is a reversal of what this route used to argue.
 * The old comment held that GET had to be final; it does not, and making it
 * final was the bug. RFC 8058 governs only the POST: it is the POST that must
 * be one-click and final, and it still is. GET is a human who is owed a
 * question, and it is also every mail security scanner and link previewer
 * that fetches each URL in a message on delivery — so a GET that unsubscribed
 * turned people's alerts off before they had read the mail, and the first they
 * knew of it was a price drop they never heard about.
 *
 * So the token is checked read-only, and a good one gets one button that
 * POSTs back. A bad one gets the same "didn't work" page it always did.
 */
const unsubscribeGet = httpAction(async (ctx, request) => {
  const token = tokenOf(request);
  const { ok } = await ctx.runQuery(internal.alerts.checkUnsubToken, { token });
  return ok ? htmlResponse(200, confirmPage(token)) : htmlResponse(400, BAD_LINK);
});

// The form body is a single short field. Anything longer is not our form, and
// there is no reason to hand it to a parser.
const MAX_FORM_BODY = 1024;

/**
 * POST — the action itself, from one of two senders.
 *
 *   The mail client, acting on List-Unsubscribe-Post (Gmail's own
 *   "Unsubscribe" button), with body `List-Unsubscribe=One-Click` and no human
 *   watching. RFC 8058 requires this to be final, and it is owed a status and
 *   nothing else — a provider that gets a page back has not been answered.
 *
 *   A person, pressing the button on the page GET rendered. Their form carries
 *   `confirm=1`, and they are owed a page saying it worked.
 *
 * Both unsubscribe; only the body they get back differs. A missing, oversized
 * or unparseable body is read as the one-click case: the unsubscribe still
 * happens, and the answer is the bare status a machine expects.
 *
 * Never reveals whether a token was merely wrong or belonged to a deleted
 * account. Both answer the same way, for the same reason auth:requestCode
 * refuses to say whether an address has an account.
 */
const unsubscribePost = httpAction(async (ctx, request) => {
  const token = tokenOf(request);

  let confirmed = false;
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    const body = await request.text();
    if (body.length <= MAX_FORM_BODY) {
      confirmed = new URLSearchParams(body).get("confirm") === "1";
    }
  }

  const { ok } = await ctx.runMutation(internal.alerts.unsubscribeByToken, {
    token,
  });

  if (!confirmed) {
    // One-click. The body is never rendered; the status is the whole answer.
    return new Response(null, { status: ok ? 200 : 400 });
  }
  return ok ? htmlResponse(200, ALERTS_OFF) : htmlResponse(400, BAD_LINK);
});

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

http.route({ path: "/unsubscribe", method: "GET", handler: unsubscribeGet });
http.route({ path: "/unsubscribe", method: "POST", handler: unsubscribePost });

export default http;
