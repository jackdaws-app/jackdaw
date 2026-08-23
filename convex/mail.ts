// ---------------------------------------------------------------------------
// The shape every Jackdaw email shares: wordmark, one card, one footer.
//
// Text only, on purpose. An image in an email is a request to our server the
// moment it is opened, which is open tracking whether or not anybody reads the
// log, so the wordmark is set in type and the green dot is a styled span.
// Everything is inline styles in a single table, because that is what mail
// clients render; the one <style> block exists only for dark mode, where a
// client that honours it gets matching colours and one that strips it still
// reads fine against its own inversion.
// ---------------------------------------------------------------------------

export const SITE_URL = "https://jackdaws.app";
export const TAGLINE = "Community price history for Micro Center.";
export const DISCLAIMER = "Not affiliated with Micro Center.";

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

// Light palette, taken from the site's own tokens. Kept away from pure black
// and pure white so a client that inverts rather than honours the media query
// lands on something readable either way.
const C = {
  ground: "#f3f4f1",
  card: "#ffffff",
  line: "#dcdfe4",
  ink: "#16233a",
  soft: "#4a5568",
  muted: "#6b7280",
  // The footer sits on the ground, not the card, and the card's muted grey
  // measures 4.38:1 there. One step darker clears 5.4.
  foot: "#5b6472",
  green: "#16a34a",
};

const DARK = {
  ground: "#0a1120",
  card: "#131d33",
  line: "#263247",
  ink: "#f0f4fa",
  soft: "#c2ccdb",
  muted: "#98a2b5",
  foot: "#98a2b5",
  green: "#4ade80",
};

export function esc(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `$1,299.99`, as every other Jackdaw surface prints it. */
export function money(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

type FooterLink = { label: string; href: string };

/**
 * A complete HTML document around `body` (already-escaped HTML for the inside
 * of the card). `eyebrow` is the small-caps line under the wordmark that names
 * what this mail is. `links` are the footer's links; pass none for a mail that
 * must carry no links at all.
 */
export function layout(opts: {
  eyebrow: string;
  body: string;
  links?: FooterLink[];
  preheader?: string;
}): string {
  const links = opts.links ?? [];
  const footerLinks =
    links.length === 0
      ? `<span class="jd-foot" style="color:${C.foot}">jackdaws.app</span>`
      : links
          .map(
            (l) =>
              `<a class="jd-foot" href="${esc(l.href)}" style="color:${C.foot};text-decoration:underline">${esc(l.label)}</a>`,
          )
          .join(`<span class="jd-foot" style="color:${C.foot}">&nbsp;&nbsp;&middot;&nbsp;&nbsp;</span>`);
  const preheader =
    opts.preheader === undefined
      ? ""
      : `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(opts.preheader)}</div>`;
  return [
    `<!doctype html><html><head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<meta name="color-scheme" content="light dark">`,
    `<meta name="supported-color-schemes" content="light dark">`,
    `<style>`,
    `:root{color-scheme:light dark;supported-color-schemes:light dark}`,
    `@media (prefers-color-scheme:dark){`,
    `.jd-ground{background:${DARK.ground}!important}`,
    `.jd-card{background:${DARK.card}!important;border-color:${DARK.line}!important}`,
    `.jd-ink{color:${DARK.ink}!important}`,
    `.jd-soft{color:${DARK.soft}!important}`,
    `.jd-muted{color:${DARK.muted}!important}`,
    `.jd-foot{color:${DARK.foot}!important}`,
    `.jd-dot{background:${DARK.green}!important}`,
    `.jd-rule{border-color:${DARK.line}!important}`,
    `.jd-btn{background:${DARK.ink}!important;color:${DARK.ground}!important}`,
    `}`,
    `</style></head>`,
    `<body class="jd-ground" style="margin:0;padding:0;background:${C.ground};font-family:${FONT};-webkit-text-size-adjust:100%">`,
    preheader,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="jd-ground" style="background:${C.ground}">`,
    `<tr><td align="center" style="padding:36px 16px">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px">`,
    // Wordmark: the name, then the live dot, the same mark the extension wears.
    `<tr><td style="padding:0 8px 14px">`,
    `<span class="jd-ink" style="font-size:13px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:${C.ink}">Jackdaw</span>`,
    `<span class="jd-dot" style="display:inline-block;width:7px;height:7px;margin-left:7px;border-radius:50%;background:${C.green};vertical-align:2px"></span>`,
    `</td></tr>`,
    `<tr><td class="jd-card" style="background:${C.card};border:1px solid ${C.line};border-radius:12px;padding:26px 28px 24px">`,
    `<div class="jd-muted" style="font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${C.muted}">${esc(opts.eyebrow)}</div>`,
    opts.body,
    `</td></tr>`,
    `<tr><td style="padding:18px 8px 0;font-size:12px;line-height:1.6">`,
    `<div class="jd-foot" style="color:${C.foot}">${esc(TAGLINE)} ${esc(DISCLAIMER)}</div>`,
    `<div style="margin-top:4px">${footerLinks}</div>`,
    `</td></tr>`,
    `</table></td></tr></table></body></html>`,
  ].join("");
}

/** A paragraph inside the card, in the body colour. */
export function para(html: string, opts: { muted?: boolean; top?: number } = {}): string {
  const cls = opts.muted ? "jd-soft" : "jd-ink";
  const color = opts.muted ? C.soft : C.ink;
  const size = opts.muted ? 13 : 15;
  return `<p class="${cls}" style="margin:${opts.top ?? 14}px 0 0;font-size:${size}px;line-height:1.55;color:${color}">${html}</p>`;
}

/** The one button a mail may carry. */
export function button(label: string, href: string): string {
  return `<p style="margin:20px 0 0"><a class="jd-btn" href="${esc(href)}" style="display:inline-block;background:${C.ink};color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;letter-spacing:.02em;padding:11px 18px;border-radius:8px">${esc(label)}</a></p>`;
}

/** The plain-text footer, mirroring the HTML one. */
export function textFooter(links: FooterLink[] = []): string[] {
  const lines = ["", `Jackdaw. ${TAGLINE} ${DISCLAIMER}`];
  if (links.length === 0) lines.push(SITE_URL);
  else for (const l of links) lines.push(`${l.label}: ${l.href}`);
  return lines;
}

export const POLICY_LINKS: FooterLink[] = [
  { label: "jackdaws.app", href: SITE_URL },
  { label: "Privacy", href: `${SITE_URL}/privacy.html` },
  { label: "Terms", href: `${SITE_URL}/terms.html` },
];
