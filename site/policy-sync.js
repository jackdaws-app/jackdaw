#!/usr/bin/env node
/* Bring the committed floor up to what is published.
 *
 *   node site/policy-sync.js            # report drift, write nothing
 *   node site/policy-sync.js --write    # rewrite the .md and the .html
 *   node site/policy-sync.js --write privacy
 *
 * THIS IS THE OTHER HALF OF THE STATIC FLOOR. Publishing from the admin panel
 * puts the new text in front of readers immediately; it does not put it in git.
 * Until someone runs this, the repository, the printed page, the no-JavaScript
 * reader and the Chrome Web Store listing all still show the previous text —
 * which is the deliberate safety property right up until it becomes a lie
 * nobody remembered to correct. The panel shows the gap; this closes it.
 *
 * It regenerates the HTML from the same renderer the page uses, so the floor is
 * by construction what a reader with JavaScript would have seen. There is no
 * second implementation to drift.
 *
 * Read-only against Convex — one anonymous `policy:current` query per document.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const P = require("./policy.js");

const ROOT = path.resolve(__dirname, "..");
const DOCS = {
  privacy: { md: "PRIVACY.md", html: "site/privacy.html" },
  terms: { md: "TERMS.md", html: "site/terms.html" },
};

function deploymentUrl() {
  const cfg = fs.readFileSync(path.join(ROOT, "site/config.js"), "utf8");
  const m = /JACKDAW_CONVEX_URL\s*=\s*"([^"]+)"/.exec(cfg);
  if (!m) throw new Error("no JACKDAW_CONVEX_URL in site/config.js");
  return m[1].replace(/\/+$/, "");
}

async function fetchCurrent(url, slug) {
  const res = await fetch(url + "/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "policy:current", args: { slug }, format: "json" }),
  });
  if (!res.ok) throw new Error(`${slug}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== "success") {
    throw new Error(`${slug}: ${body.errorMessage || JSON.stringify(body)}`);
  }
  return body.value;
}

/* Replace one region of the page, and fail loudly if the anchor moved.
   The test is whether the PATTERN matched — never whether the result changed.
   Bytes that come out identical are the EXPECTED outcome whenever the published
   text is the text already committed, which is the ordinary case: publish an
   amendment, sync it, sync it again. An earlier version of this compared
   `out === src` and so read that success as a missing anchor, aborting a run
   that had already rewritten the markdown. */
function splice(src, re, replacement, what) {
  if (!re.test(src)) {
    throw new Error(`could not find ${what} — has the page changed shape?`);
  }
  return src.replace(re, replacement);
}

function hostOf(u) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(String(u || ""));
  return m ? m[1].toLowerCase() : "";
}

function rebuild(html, doc, version, host) {
  let s = html;
  s = splice(
    s,
    /(<h1 class="doc-title">)[\s\S]*?(<\/h1>)/,
    (_, a, b) => a + P.escapeHtml(doc.title) + b,
    "the <h1>",
  );
  if (doc.meta) {
    s = splice(
      s,
      /(<p class="doc-meta">)[\s\S]*?(<\/p>)/,
      (_, a, b) => a + P.escapeHtml(doc.meta) + b,
      "the date line",
    );
  }
  s = splice(
    s,
    /(<nav class="doc-index"[\s\S]*?<ol>\n)[\s\S]*?(\n *<\/ol>)/,
    (_, a, b) => a + P.renderToc(doc.toc, 12) + b,
    "the table of contents",
  );
  s = splice(
    s,
    /(<main class="doc"[^>]*>\n)[\s\S]*?(\n *<\/main>)/,
    (_, a, b) => a + doc.html + b,
    "the <main> body",
  );
  // The version and the deployment that issued it are written together, and the
  // stamp is rewritten even when it is already present — a floor synced from one
  // deployment and then from another must not keep the first one's name.
  s = splice(
    s,
    /(<main class="doc"[^>]*?)data-policy-version="\d+"(?:\s+data-policy-deployment="[^"]*")?/,
    (_, a) =>
      `${a}data-policy-version="${version}" data-policy-deployment="${host}"`,
    "data-policy-version",
  );
  return s;
}

(async () => {
  const argv = process.argv.slice(2);
  const write = argv.includes("--write");
  const only = argv.filter((a) => !a.startsWith("--"));
  const slugs = only.length ? only : Object.keys(DOCS);
  const url = deploymentUrl();
  const host = hostOf(url);

  console.log(`deployment ${url}`);
  console.log(write ? "mode: WRITE\n" : "mode: check only (pass --write to apply)\n");

  let drifted = 0;
  for (const slug of slugs) {
    const spec = DOCS[slug];
    if (!spec) throw new Error(`unknown document ${JSON.stringify(slug)}`);
    const htmlPath = path.join(ROOT, spec.html);
    const html = fs.readFileSync(htmlPath, "utf8");
    // Same rule the page applies: a version from another deployment is not a
    // floor here either, or this would report "in step" against a number that
    // means nothing on the deployment it is about to query.
    const stamped =
      (/<main class="doc"[^>]*data-policy-deployment="([^"]*)"/.exec(html) || [, ""])[1];
    const floor =
      stamped === host
        ? Number((/<main class="doc"[^>]*data-policy-version="(\d+)"/.exec(html) || [, "0"])[1])
        : 0;

    const row = await fetchCurrent(url, slug);
    if (!row) {
      console.log(`${slug.padEnd(8)} floor v${floor} · nothing published — in step`);
      continue;
    }
    if (row.version <= floor) {
      console.log(`${slug.padEnd(8)} floor v${floor} · published v${row.version} — in step`);
      continue;
    }

    drifted++;
    const doc = P.render(row.markdown, { indent: 10 });
    if (!doc) {
      console.log(
        `${slug.padEnd(8)} floor v${floor} · published v${row.version} — WILL NOT PARSE, skipped`,
      );
      continue;
    }
    const when = new Date(row.publishedAt).toISOString().slice(0, 10);
    console.log(
      `${slug.padEnd(8)} floor v${floor} · published v${row.version} (${when}) — BEHIND`,
    );

    if (!write) continue;
    // Both outputs are built before either is written. `rebuild` throws when the
    // page has changed shape, and a throw between the two writes would leave the
    // markdown updated and the page it is supposed to match stale — a repository
    // whose .md and .html disagree, produced by the script whose whole job is
    // keeping them the same.
    const nextMd = row.markdown.replace(/\n*$/, "\n");
    const nextHtml = rebuild(html, doc, row.version, host);
    fs.writeFileSync(path.join(ROOT, spec.md), nextMd);
    fs.writeFileSync(htmlPath, nextHtml);
    console.log(`         wrote ${spec.md} and ${spec.html}`);
  }

  if (drifted && !write) {
    console.log("\nRe-run with --write, then review the diff and commit.");
  }
  // A non-zero exit on drift, so this can gate a release later.
  process.exit(drifted && !write ? 1 : 0);
})().catch((e) => {
  console.error("policy-sync failed:", e.message);
  process.exit(2);
});
