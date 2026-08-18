import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { enforceAdminRateLimit, requireAdmin } from "./lib";

// The published bodies of the privacy policy and the terms of service.
//
// `current` is public and unauthenticated because the two doc pages call it
// anonymously on load; everything that writes is gated on the shared ADMIN_KEY
// exactly like dashboard.ts, which sits on the same plain HTTP surface.
//
// Nothing here is required for the pages to render. See the schema note: the
// committed HTML is the floor and this is an amendment on top of it, so every
// failure mode below — no row, a body that will not parse, an unreachable
// deployment — lands the reader on text that is in git.

const SLUG = v.union(v.literal("privacy"), v.literal("terms"));

// A policy shorter than this is a mistake (an empty editor, a truncated
// paste); the ceiling is roughly seven times the longer of the two real
// documents and well inside Convex's 1 MB per-document limit.
const MIN_BODY = 400;
const MAX_BODY = 64_000;
const MAX_NOTE = 200;
// History is metadata only, so this cap is about the panel's list length
// rather than the response size. Bodies come one at a time from `at`.
const MAX_HISTORY = 50;

const VERSION_ROW = v.object({
  version: v.number(),
  publishedAt: v.number(),
  note: v.union(v.string(), v.null()),
  // So the panel can show a version's weight without fetching its body.
  // Characters rather than bytes, because that is the count `publish`
  // enforces against MAX_BODY. A second unit here would disagree with the
  // editor's own readout on any document containing an em dash.
  chars: v.number(),
});

/**
 * Normalize a multi-line body. Deliberately NOT lib.ts's `sanitize`, which
 * strips U+0000–U+001F — a range containing `\n`. Running a policy document
 * through it would fold the whole thing onto one line and destroy every
 * heading, which is exactly the kind of silent corruption this project keeps
 * having to write down. The control characters that are genuinely unwanted are
 * removed one range at a time instead, with `\n` and `\t` cut out of the range.
 *
 * Line endings are normalized because the editor is a browser textarea and a
 * paste from a Windows source arrives with CRLF; a body differing from the
 * live one only in invisible characters would otherwise publish as a new
 * version that reads identically to the one before it.
 */
function normalizeBody(raw: string): string {
  return (
    raw
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
      .trim()
  );
}

/**
 * The contract the renderer needs, checked at the boundary.
 *
 * The site's markdown renderer understands one small grammar: a single `#`
 * title, an italic "Last updated" line, numbered `## N. Heading` sections,
 * paragraphs and bullets. It has to be defensive anyway — it refuses to
 * hydrate a body it cannot parse, which is what keeps a bad publish off the
 * page — but refusing here as well means the panel says why, in band, at the
 * moment the mistake was made, rather than the operator discovering it by
 * reading the live site and finding yesterday's text still on it.
 *
 * Structure only. Nothing here validates that the words are correct, and
 * nothing could.
 */
function structuralFault(body: string): string | null {
  const lines = body.split("\n");
  if (!lines[0].startsWith("# ") || lines[0].length < 4) {
    return "must start with a single '# Title' line";
  }
  if (lines.filter((l) => l.startsWith("# ")).length !== 1) {
    return "must contain exactly one '# Title' line";
  }
  const heads = lines.filter((l) => l.startsWith("## "));
  if (heads.length === 0) return "must contain at least one '## N. Heading'";
  for (const h of heads) {
    if (!/^## \d+\. \S/.test(h)) {
      return `section heading must be numbered, e.g. '## 1. Title' — found ${JSON.stringify(h.slice(0, 40))}`;
    }
  }
  // The numbering is what the rendered `.doc-num` and the `#sN` anchors are
  // built from, so a duplicate or a gap would produce two sections claiming
  // one number and a table of contents linking to the wrong one.
  const nums = heads.map((h) => Number(h.slice(3, h.indexOf("."))));
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] !== i + 1) {
      return `sections must be numbered 1..${nums.length} in order — found ${nums.join(", ")}`;
    }
  }
  if (lines.some((l) => l.startsWith("###"))) {
    return "sub-headings ('###') are not supported by the document layout";
  }
  return null;
}

/** The newest published version of one document, or null if none was ever published. */
export const current = query({
  args: { slug: SLUG },
  returns: v.union(
    v.object({
      slug: SLUG,
      version: v.number(),
      markdown: v.string(),
      publishedAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("policyDocs")
      .withIndex("by_slug_version", (q) => q.eq("slug", args.slug))
      .order("desc")
      .first();
    if (row === null) return null;
    return {
      slug: row.slug,
      version: row.version,
      markdown: row.markdown,
      publishedAt: row.publishedAt,
    };
  },
});

/**
 * Publish a new version.
 *
 * Idempotent against its own body: republishing text identical to what is
 * already live inserts nothing and reports `published: false`. A version that
 * changed nothing is worse than no entry at all — it turns the history into a
 * log of button presses rather than a log of amendments, and the first
 * question anyone asks of this table is what actually changed, and when.
 */
export const publish = mutation({
  args: {
    adminKey: v.string(),
    slug: SLUG,
    markdown: v.string(),
    note: v.optional(v.string()),
  },
  returns: v.object({
    published: v.boolean(),
    version: v.number(),
    unchanged: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await enforceAdminRateLimit(ctx);
    requireAdmin(args.adminKey);

    const body = normalizeBody(args.markdown);
    if (body.length < MIN_BODY || body.length > MAX_BODY) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `policy body must be between ${MIN_BODY} and ${MAX_BODY} characters (got ${body.length})`,
      });
    }
    const fault = structuralFault(body);
    if (fault !== null) {
      throw new ConvexError({ code: "INVALID_POLICY", message: fault });
    }
    const note = args.note === undefined ? "" : normalizeBody(args.note);
    if (note.length > MAX_NOTE) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `note must be at most ${MAX_NOTE} characters`,
      });
    }

    const latest = await ctx.db
      .query("policyDocs")
      .withIndex("by_slug_version", (q) => q.eq("slug", args.slug))
      .order("desc")
      .first();

    if (latest !== null && latest.markdown === body) {
      return { published: false, version: latest.version, unchanged: true };
    }

    const version = latest === null ? 1 : latest.version + 1;
    await ctx.db.insert("policyDocs", {
      slug: args.slug,
      version,
      markdown: body,
      publishedAt: Date.now(),
      ...(note.length > 0 ? { note } : {}),
    });
    return { published: true, version, unchanged: false };
  },
});

/** Every version of one document, newest first — metadata only. */
export const history = query({
  args: { adminKey: v.string(), slug: SLUG },
  returns: v.array(VERSION_ROW),
  handler: async (ctx, args) => {
    requireAdmin(args.adminKey);
    const rows = await ctx.db
      .query("policyDocs")
      .withIndex("by_slug_version", (q) => q.eq("slug", args.slug))
      .order("desc")
      .take(MAX_HISTORY);
    return rows.map((r) => ({
      version: r.version,
      publishedAt: r.publishedAt,
      note: r.note ?? null,
      chars: r.markdown.length,
    }));
  },
});

/** One version's body, for the diff view and the revert preview. */
export const at = query({
  args: { adminKey: v.string(), slug: SLUG, version: v.number() },
  returns: v.union(
    v.object({
      version: v.number(),
      markdown: v.string(),
      publishedAt: v.number(),
      note: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    requireAdmin(args.adminKey);
    const row = await ctx.db
      .query("policyDocs")
      .withIndex("by_slug_version", (q) =>
        q.eq("slug", args.slug).eq("version", args.version),
      )
      .unique();
    if (row === null) return null;
    return {
      version: row.version,
      markdown: row.markdown,
      publishedAt: row.publishedAt,
      note: row.note ?? null,
    };
  },
});

/**
 * Restore an earlier body by republishing it as a new version.
 *
 * Not a delete and not a pointer move: the versions in between stay exactly
 * where they are and the restored text arrives with a number of its own. What
 * was live between two dates stays answerable afterwards, which is the only
 * reason to keep a history at all.
 */
export const revert = mutation({
  args: { adminKey: v.string(), slug: SLUG, version: v.number() },
  returns: v.object({ version: v.number(), restored: v.number() }),
  handler: async (ctx, args) => {
    await enforceAdminRateLimit(ctx);
    requireAdmin(args.adminKey);

    const source = await ctx.db
      .query("policyDocs")
      .withIndex("by_slug_version", (q) =>
        q.eq("slug", args.slug).eq("version", args.version),
      )
      .unique();
    if (source === null) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: `no version ${args.version} of the ${args.slug} policy`,
      });
    }

    const latest = await ctx.db
      .query("policyDocs")
      .withIndex("by_slug_version", (q) => q.eq("slug", args.slug))
      .order("desc")
      .first();
    // `latest` cannot be null here — `source` exists — but the same check also
    // covers reverting to the version that is already live, which would insert
    // a duplicate saying nothing.
    if (latest !== null && latest.markdown === source.markdown) {
      throw new ConvexError({
        code: "NO_CHANGE",
        message: `version ${args.version} is already the live text`,
      });
    }

    const version = (latest?.version ?? 0) + 1;
    await ctx.db.insert("policyDocs", {
      slug: args.slug,
      version,
      markdown: source.markdown,
      publishedAt: Date.now(),
      note: `Restored version ${args.version}`,
    });
    return { version, restored: args.version };
  },
});
