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
 * The page a person lands on, in the two states it has.
 *
 * Plain and self-contained: no stylesheet to fetch, no script, nothing that
 * needs the site to be up. A mail client's in-app browser is the worst
 * rendering environment this project targets and this is the page that has to
 * work in it.
 */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Jackdaw</title></head>
<body style="margin:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1c1e21">
<div style="max-width:420px;margin:0 auto;padding:64px 24px">
<p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8a8a80">Jackdaw</p>
<h1 style="margin:0 0 14px;font-size:20px;font-weight:600;line-height:1.3">${title}</h1>
<p style="margin:0;font-size:14px;line-height:1.6;color:#4b5563">${body}</p>
</div></body></html>`;
}

/**
 * Turn email alerts off.
 *
 * BOTH VERBS, and they are not the same request. GET is a person clicking the
 * link and is owed a page saying what happened. POST is the mail client acting
 * on the List-Unsubscribe-Post header — Gmail's own "Unsubscribe" button, fired
 * with no human watching — and is owed a 200 and nothing else.
 *
 * The POST half is why this must not be a GET-only route with a confirmation
 * step. RFC 8058 requires the one click to be final: a provider that gets a
 * confirmation page back from its one-click POST has not unsubscribed the user,
 * and the next thing it does is treat the sender as one that ignores the header.
 * A person's explicit click is not a request worth double-checking anyway.
 *
 * Never reveals whether a token was merely wrong or belonged to a deleted
 * account. Both answer the same way, for the same reason auth:requestCode
 * refuses to say whether an address has an account.
 */
const unsubscribe = httpAction(async (ctx, request) => {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const result = await ctx.runMutation(internal.alerts.unsubscribeByToken, {
    token,
  });

  if (request.method === "POST") {
    // One-click. The body is never rendered; the status is the whole answer.
    return new Response(null, { status: result.ok ? 200 : 400 });
  }

  const html = result.ok
    ? page(
        "Email alerts are off",
        `We won't email ${result.email === null ? "you" : escapeHtml(result.email)} about price alerts again. ` +
          `Your watches are untouched and still fire in the browser — turn email back on any time from the Jackdaw toolbar icon.`,
      )
    : page(
        "That link didn't work",
        "It may have been truncated by your mail client, or the account may no longer exist. " +
          "You can turn email alerts off directly from the Jackdaw toolbar icon.",
      );

  return new Response(html, {
    status: result.ok ? 200 : 400,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Nothing here should sit in a shared cache: the URL carries a token and
      // the page names an address.
      "Cache-Control": "no-store",
      // The page has no scripts, no styles and no images of its own, so it can
      // afford to say so.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Referrer-Policy": "no-referrer",
    },
  });
});

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

http.route({ path: "/unsubscribe", method: "GET", handler: unsubscribe });
http.route({ path: "/unsubscribe", method: "POST", handler: unsubscribe });

export default http;
