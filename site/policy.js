/* The policy renderer, and the hydration that lets a published amendment reach
   privacy.html and terms.html without a deploy.

   ── THE COMMITTED HTML IS THE FLOOR ────────────────────────────────────────
   Both documents ship with their full text baked into the page and a
   `data-policy-version` on <main>. This file asks Convex for the newest
   published version and swaps the document in ONLY when that version is higher
   AND the markdown parses. Every other outcome — no row, an unreachable
   deployment, a body this renderer will not accept, an equal or older version —
   leaves the reader on text that is in git.

   That ordering is the whole design. A privacy policy whose visible text
   depends on a network call is a privacy policy that can be blank, and the
   audiences who most need to read it (a reader with JavaScript off, a printer,
   a Chrome Web Store reviewer) are exactly the ones a fetch cannot serve.

   ── IT REVEALS WHAT IT BUILDS ──────────────────────────────────────────────
   `doc.css` hides `.doc-sec` under `html.reveal`, and doc.js reveals the
   sections it found at load. Sections built here arrive after that, so this
   file adds `in` to each one as it creates it rather than handing them to
   doc.js's observer. Nothing about whether a clause is visible is allowed to
   depend on a second file's timing: an invisible legal document is a worse
   failure than an unanimated one, which is a rule doc.js already states and
   this is the same rule seen from the other side.

   ── THE GRAMMAR IS CLOSED ──────────────────────────────────────────────────
   One `# Title`, an optional `*italic*` date line, `## N. Heading` sections,
   paragraphs and `- ` bullets, with `**bold**`, `` `code` `` and `[text](url)`
   inline. That is exactly what the two documents use and nothing more.
   convex/policy.ts refuses anything outside it at publish time so the operator
   is told at the moment of the mistake; this file refuses it again on the way
   in, because the page has no way of knowing which version of the validator
   wrote the row it just fetched.

   Everything is escaped before any markup is emitted, and the only tags that
   can appear are the ones written literally below. A body is admin-authored,
   but "the author is trusted" is not a reason to build an HTML injection into
   a page — the whole point of storing markdown rather than HTML is that the
   document cannot carry script. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.JackdawPolicy = api;
  // The hydration only exists in a browser, so a node round-trip check can
  // require this file for the renderer alone.
  if (typeof document !== "undefined") api.hydrate();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ── Escaping ────────────────────────────────────────────────────────────
     `'` as `&#x27;` and `"` as `&quot;` to match what the committed documents
     already carry, so the round-trip check compares like with like. */
  var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ESC[c];
    });
  }

  /* A URL we are willing to put in an href. An allow-list of schemes, not a
     block-list of bad ones: `javascript:`, `data:` and `vbscript:` are the ones
     anybody thinks of, and the next scheme a browser ships is one nobody
     updated the block-list for. A fragment, a relative path and a bare filename
     carry no scheme and are fine.

     A refused link keeps its text and loses only the anchor. Dropping the words
     as well would silently delete a clause from a legal document, which is a
     larger failure than a dead link. */
  function safeHref(url) {
    if (/^(https?:)?\/\//i.test(url)) return true;
    if (/^mailto:[^\s@]+@[^\s@]+$/i.test(url)) return true;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
    return true;
  }

  /* ── Inline ──────────────────────────────────────────────────────────────
     Code spans are split out first and never re-entered, so a backtick span
     containing an asterisk stays literal. The remaining segments get links,
     then bold, then italic — bold before italic so `**x**` is not read as an
     empty emphasis wrapping `*x*`. */
  function inline(src) {
    var parts = String(src).split(/`([^`]+)`/);
    var out = "";
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        out += "<code>" + escapeHtml(parts[i]) + "</code>";
        continue;
      }
      out += emphasis(escapeHtml(parts[i]));
    }
    return out;
  }

  function emphasis(s) {
    return s
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (_, text, url) {
        if (!safeHref(url)) return text;
        var ext = /^(https?:)?\/\//i.test(url)
          ? ' target="_blank" rel="noopener"'
          : "";
        return '<a href="' + url + '"' + ext + ">" + text + "</a>";
      })
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,;:])/g, "$1<em>$2</em>");
  }

  /* ── Blocks ──────────────────────────────────────────────────────────────
     A line indented by two or more spaces continues the block above it, which
     is how DATA-POLICY.md wraps its bullets and how anything pasted out of a
     wrapped editor will arrive. */
  function blocks(lines) {
    var out = [];
    var para = null;
    var list = null;

    function flushPara() {
      if (para !== null) out.push({ kind: "p", text: para });
      para = null;
    }
    function flushList() {
      if (list !== null) out.push({ kind: "ul", items: list });
      list = null;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim()) {
        flushPara();
        flushList();
        continue;
      }
      var bullet = /^[-*] +(.*)$/.exec(line);
      if (bullet) {
        flushPara();
        if (list === null) list = [];
        list.push(bullet[1].trim());
        continue;
      }
      // A continuation of whatever is open.
      if (/^ {2,}\S/.test(line)) {
        if (list !== null) {
          list[list.length - 1] += " " + line.trim();
          continue;
        }
        if (para !== null) {
          para += " " + line.trim();
          continue;
        }
      }
      flushList();
      para = para === null ? line.trim() : para + " " + line.trim();
    }
    flushPara();
    flushList();
    return out;
  }

  function renderBlocks(list, pad) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (b.kind === "p") {
        out.push(pad + "<p>" + inline(b.text) + "</p>");
      } else {
        out.push(pad + "<ul>");
        for (var j = 0; j < b.items.length; j++) {
          out.push(pad + "  <li>" + inline(b.items[j]) + "</li>");
        }
        out.push(pad + "</ul>");
      }
    }
    return out;
  }

  function spaces(n) {
    return new Array(n + 1).join(" ");
  }

  /**
   * Parse a policy body.
   *
   * Returns null — never a partial document — when the body does not fit the
   * grammar. A half-rendered policy is the failure this whole file exists to
   * prevent, so there is no "best effort" path: the caller falls back to the
   * committed text and the reader is none the wiser.
   *
   * `indent` is the column the <main> children sit at in the committed files,
   * so the emitted string can be diffed against them directly. In the browser
   * it is only whitespace.
   */
  function render(markdown, opts) {
    if (typeof markdown !== "string" || !markdown.trim()) return null;
    var indent = (opts && opts.indent) || 0;
    var lines = markdown.replace(/\r\n?/g, "\n").trim().split("\n");

    if (!/^# \S/.test(lines[0])) return null;
    var title = lines[0].slice(2).trim();

    var i = 1;
    while (i < lines.length && !lines[i].trim()) i++;

    // The date line, if there is one: a whole line wrapped in single asterisks.
    var meta = "";
    var metaMatch = i < lines.length ? /^\*([^*].*)\*$/.exec(lines[i].trim()) : null;
    if (metaMatch) {
      meta = metaMatch[1].trim();
      i++;
    }

    // Everything before the first heading is the preamble.
    var lead = [];
    for (; i < lines.length; i++) {
      if (/^## /.test(lines[i])) break;
      if (/^#{1,6} /.test(lines[i])) return null; // a stray h1 or an h3
      lead.push(lines[i]);
    }

    var sections = [];
    var open = null;
    for (; i < lines.length; i++) {
      var head = /^## (\d+)\. +(\S.*)$/.exec(lines[i]);
      if (head) {
        open = { n: Number(head[1]), title: head[2].trim(), lines: [] };
        sections.push(open);
        continue;
      }
      if (/^#{1,6} /.test(lines[i])) return null;
      if (open === null) return null;
      open.lines.push(lines[i]);
    }
    if (!sections.length) return null;
    for (var s = 0; s < sections.length; s++) {
      if (sections[s].n !== s + 1) return null;
    }

    var pad = spaces(indent);
    var chunks = renderBlocks(blocks(lead), pad);
    var toc = [];
    for (var k = 0; k < sections.length; k++) {
      var sec = sections[k];
      var id = "s" + sec.n;
      toc.push({ id: id, label: sec.title, n: sec.n });
      var body = renderBlocks(blocks(sec.lines), pad + "  ");
      if (!body.length) return null; // a heading with nothing under it
      chunks.push(
        pad +
          '<section class="doc-sec" id="' +
          id +
          '">\n' +
          pad +
          '  <h2><span class="doc-num">' +
          sec.n +
          ".</span> " +
          inline(sec.title) +
          "</h2>\n" +
          body.join("\n") +
          "\n" +
          pad +
          "</section>"
      );
    }

    return {
      title: title,
      meta: meta,
      toc: toc,
      // The children of <main class="doc">, blank-line separated the way the
      // committed files write them.
      html: chunks.join("\n\n"),
    };
  }

  /* The table of contents, at the indent the committed <ol> uses. Derived from
     the headings verbatim rather than hand-written, so a published amendment
     that adds or renames a section cannot leave the index pointing at the old
     shape — which is the one part of a legal document nobody proof-reads. */
  function renderToc(toc, indent) {
    var pad = spaces(indent || 0);
    var out = [];
    for (var i = 0; i < toc.length; i++) {
      out.push(
        pad + '<li><a href="#' + toc[i].id + '">' + inline(toc[i].label) + "</a></li>"
      );
    }
    return out.join("\n");
  }

  /* ── Hydration ───────────────────────────────────────────────────────────
     One anonymous query, no arguments beyond the slug, nothing sent about the
     reader. Convex's plain HTTP API rather than its client library, for the
     same reason background.js uses it: the whole call is four lines and the
     library is 40KB on a page whose job is to be read. */
  /* The host of a deployment URL, or "" if it does not look like one. Written
     as a regex rather than `new URL` so a malformed value degrades to "" (which
     matches no stamp) instead of throwing inside the hydration. */
  function hostOf(u) {
    var m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(String(u || ""));
    return m ? m[1].toLowerCase() : "";
  }

  function hydrate() {
    var main = document.querySelector("main.doc[data-policy-slug]");
    if (!main) return;
    var slug = main.getAttribute("data-policy-slug");
    var floor = Number(main.getAttribute("data-policy-version") || "0");
    var url = window.JACKDAW_CONVEX_URL;
    if (!url || !slug) return;

    /* A version number means nothing except on the deployment that issued it.
       Versions are per-deployment counters, so a floor stamped by running
       policy-sync against dev claims "v1" on a page that ships pointing at
       prod — where the first publish is ALSO v1, fails `> floor`, and never
       reaches the reader. The operator would press publish, be told it
       succeeded, and find yesterday's policy on the site.

       So the stamp travels with the number, and a floor from a different
       deployment counts for nothing. Falling back to 0 is the safe direction:
       every published version then looks newer, and the swap is still gated on
       the renderer parsing it. */
    if ((main.getAttribute("data-policy-deployment") || "") !== hostOf(url)) {
      floor = 0;
    }

    fetch(url.replace(/\/+$/, "") + "/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "policy:current",
        args: { slug: slug },
        format: "json",
      }),
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (res) {
        if (!res || res.status !== "success" || !res.value) return;
        var row = res.value;
        if (!(Number(row.version) > floor)) return;
        var doc = render(row.markdown, { indent: 10 });
        if (!doc) {
          // The operator published something this page will not render. Say so
          // where a developer will see it; the reader keeps the committed text.
          if (window.console && console.warn) {
            console.warn(
              "[jackdaw] policy v" +
                row.version +
                " (" +
                slug +
                ") did not parse — showing the committed text"
            );
          }
          return;
        }
        apply(main, doc, row.version, hostOf(url));
      })
      .catch(function () {
        /* Offline, blocked, or the deployment is down. The floor stands. */
      });
  }

  function apply(main, doc, version, host) {
    var titleEl = document.querySelector(".doc-title");
    if (titleEl && doc.title) titleEl.textContent = doc.title;

    var metaEl = document.querySelector(".doc-meta");
    if (metaEl) {
      if (doc.meta) metaEl.textContent = doc.meta;
      else metaEl.remove();
    }

    var tocEl = document.querySelector(".doc-index ol");
    if (tocEl) tocEl.innerHTML = renderToc(doc.toc, 0);

    main.innerHTML = doc.html;
    // Built after doc.js ran, so they are revealed here. See the head note.
    var secs = main.querySelectorAll(".doc-sec");
    for (var i = 0; i < secs.length; i++) secs[i].classList.add("in");

    /* So a second call — a re-render, a future live-update — is a no-op. The
       deployment goes on too, and not only for symmetry: the floor is scored
       against its stamp, so a live DOM that recorded the number without the
       name would read as floor 0 next time round and swap again. */
    main.setAttribute("data-policy-version", String(version));
    main.setAttribute("data-policy-deployment", host || "");
    main.setAttribute("data-policy-live", "1");
  }

  return {
    render: render,
    renderToc: renderToc,
    escapeHtml: escapeHtml,
    hydrate: hydrate,
  };
});
