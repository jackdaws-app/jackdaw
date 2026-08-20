// Jackdaw admin — the policies editor.
//
// The gate, the Convex transport, the power-on choreography and the plate
// stagger belong to the console and live in admin-shell.js; this file is only
// the bench that sits on it. See that file's head note for the security posture.
//
// ── WHAT PUBLISHING ACTUALLY DOES ───────────────────────────────────────────
// It appends a row, and readers running JavaScript see it on their next load.
// It does not touch git — so the repository, the printed page, a reader with
// JavaScript off and anyone reading the copy filed with the Web Store keep the
// committed text until someone runs `node site/policy-sync.js --write` and
// commits the result. That gap is the static floor's whole safety property (a
// policy whose visible text depends on a network call is a policy that can be
// blank) and it is only safe while it is short, so the state strip reports it
// permanently rather than in a toast that scrolls away.
//
// ── THE CHECK IS MIRRORED, THE SERVER DECIDES ───────────────────────────────
// `structuralFault` below is a copy of convex/policy.ts's, deliberately: the
// operator is told at the moment of the mistake rather than after a round trip.
// A copy can drift, and the two directions fail differently — laxer here means
// an unexplained refusal from the server, stricter here means a legal amendment
// the panel will not send. Neither is silent, and the server's answer is the one
// that governs. The renderer is NOT mirrored: policy.js is loaded on this page,
// so the preview is the same code the reader's browser runs.
(() => {
  const A = window.JackdawAdmin;
  if (!A || !A.ok) return;
  const P = window.JackdawPolicy;
  const { query, el, toast, ago } = A;
  const creds = () => A.creds();
  const $ = (id) => document.getElementById(id);

  const MIN_BODY = 400;
  const MAX_BODY = 64000;
  const MAX_NOTE = 200;
  // The indent policy-sync.js renders the <main> children at. The round-trip
  // check below compares against the committed file byte for byte, so this has
  // to be that number and not merely a plausible one.
  const FLOOR_INDENT = 10;

  const DOCS = {
    privacy: { label: "Privacy Policy", short: "Privacy", page: "privacy.html", md: "PRIVACY.md" },
    terms: { label: "Terms of Service", short: "Terms", page: "terms.html", md: "TERMS.md" },
  };

  let slug = "privacy";
  let view = "preview";
  // Per-document state. Switching documents must not lose an edit in progress,
  // so each keeps its own body and its own baseline.
  const blank = () => ({ live: null, floor: null, history: null, body: "", baseline: "", loaded: false });
  const S = {};
  for (const k of Object.keys(DOCS)) S[k] = blank();
  const cur = () => S[slug];

  /* ── The structure check, mirrored ─────────────────────────────────────── */
  function structuralFault(body) {
    const lines = body.split("\n");
    if (!lines[0].startsWith("# ") || lines[0].length < 4) {
      return "must start with a single '# Title' line";
    }
    if (lines.filter((l) => l.startsWith("# ")).length !== 1) {
      return "must contain exactly one '# Title' line";
    }
    const heads = lines.filter((l) => l.startsWith("## "));
    if (!heads.length) return "must contain at least one '## N. Heading'";
    for (const h of heads) {
      if (!/^## \d+\. \S/.test(h)) {
        return "section heading must be numbered, e.g. '## 1. Title' — found " +
          JSON.stringify(h.slice(0, 40));
      }
    }
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

  // The server normalizes before it measures, so the byte count under the
  // editor has to be measured on the same string or it is not the one the
  // length bounds will be applied to. Newline and tab are deliberately kept.
  const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
  function normalize(raw) {
    return String(raw == null ? "" : raw).replace(/\r\n?/g, "\n").replace(CONTROL, "").trim();
  }
  // Characters, because that is the unit `policy:publish` enforces against
  // MAX_BODY. UTF-8 bytes would put a second number on the same screen as
  // the fault line's count and a larger one on every document here — the em
  // dashes and curly quotes alone separate the privacy policy's two by 8.
  const sizeOf = (s) => s.length;

  /* ── The committed floor, un-rendered ───────────────────────────────────────
     The editor has to be able to start from the text that is in git: that is
     the ordinary state of a document nobody has published from the panel yet,
     and it is where a "put it back" ends. The markdown itself is not served —
     PRIVACY.md and TERMS.md sit at the repository root and only site/ is
     deployed — and shipping a servable copy would make three copies of the
     legal text, which is a drift surface rather than a fix.

     So it is recovered from the shipped page. That is a parse rather than a
     guess for one reason: policy-sync.js writes those pages by running THIS
     renderer at THIS indent, so the committed HTML is a pure function of the
     markdown over a closed grammar. It is still checked — the recovered
     markdown is re-rendered and compared byte for byte with what the page
     carries, and anything short of an exact match is reported as a failure to
     read rather than offered as text to publish. A wrong seed here would be an
     operator publishing a legal document they did not write.

     One known lossy case, and it is visible rather than silent: a link whose
     href policy.js refuses keeps its text and loses its anchor, so the recovered
     markdown loses the URL — and still round-trips, because rendering the plain
     text reproduces the same page. Every link in both documents is https. */
  const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'" };
  const unescapeHtml = (s) => s.replace(/&(#x27|#39|amp|lt|gt|quot);/g, (_, k) => ENT[k]);

  // Inverts policy.js's `inline()`. Nesting works because each pass leaves the
  // inner HTML for the next one, and the single unescape at the end is what
  // keeps `&amp;amp;` from collapsing twice.
  function unInline(html) {
    return unescapeHtml(
      html
        .replace(/<code>([\s\S]*?)<\/code>/g, (_, t) => "`" + t + "`")
        .replace(/<a href="([^"]*)"(?: target="_blank" rel="noopener")?>([\s\S]*?)<\/a>/g,
          (_, url, t) => "[" + t + "](" + url + ")")
        .replace(/<strong>([\s\S]*?)<\/strong>/g, (_, t) => "**" + t + "**")
        .replace(/<em>([\s\S]*?)<\/em>/g, (_, t) => "*" + t + "*"),
    );
  }

  // The children of <main class="doc"> back to markdown blocks. Returns null on
  // the first line it does not recognise — a partial recovery is exactly the
  // failure this function exists to avoid.
  function unRenderBody(html) {
    const lines = html.split("\n");
    const out = [];
    let i = 0;
    const gap = () => { if (out.length && out[out.length - 1] !== "") out.push(""); };

    function readBlocks(stop) {
      while (i < lines.length) {
        const line = lines[i].trim();
        if (!line) { i++; continue; }
        if (stop && line === stop) return true;
        const p = /^<p>([\s\S]*)<\/p>$/.exec(line);
        if (p) {
          gap();
          out.push(unInline(p[1]));
          out.push("");
          i++;
          continue;
        }
        if (line === "<ul>") {
          gap();
          i++;
          while (i < lines.length && lines[i].trim() !== "</ul>") {
            const li = /^<li>([\s\S]*)<\/li>$/.exec(lines[i].trim());
            if (!li) return false;
            out.push("- " + unInline(li[1]));
            i++;
          }
          if (i >= lines.length) return false;
          i++;
          out.push("");
          continue;
        }
        // Anything else ends the preamble, and is a fault inside a section.
        return !stop;
      }
      return !stop;
    }

    if (!readBlocks(null)) return null;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line) { i++; continue; }
      const sec = /^<section class="doc-sec" id="s(\d+)">$/.exec(line);
      if (!sec) return null;
      i++;
      const h = /^<h2><span class="doc-num">(\d+)\.<\/span> ([\s\S]*)<\/h2>$/.exec(
        (lines[i] || "").trim(),
      );
      if (!h || h[1] !== sec[1]) return null;
      i++;
      gap();
      out.push("## " + h[1] + ". " + unInline(h[2]));
      out.push("");
      if (!readBlocks("</section>")) return null;
      i++;
    }
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // One page fetch, answering both questions the strip asks: which version git
  // carries, and what its words are.
  async function readFloor(page) {
    let html;
    try {
      const res = await fetch(page, { cache: "no-store" });
      if (!res.ok) return { version: 0, unknown: true };
      html = await res.text();
    } catch {
      return { version: 0, unknown: true };
    }
    const tag = /<main class="doc"[^>]*>/.exec(html);
    if (!tag) return { version: 0, unknown: true };
    const dep = (/data-policy-deployment="([^"]*)"/.exec(tag[0]) || [, ""])[1];
    const stamped = Number((/data-policy-version="(\d+)"/.exec(tag[0]) || [, "0"])[1]);
    // A version number means nothing except on the deployment that issued it —
    // the same rule policy.js and policy-sync.js apply, and if the three
    // disagreed about it one of them would be lying to somebody.
    const foreign = dep && dep !== A.host ? dep : null;
    const out = { version: foreign ? 0 : stamped, stamped, foreign, markdown: null };

    const body = /<main class="doc"[^>]*>\n([\s\S]*?)\n *<\/main>/.exec(html);
    const title = /<h1 class="doc-title">([\s\S]*?)<\/h1>/.exec(html);
    if (!body || !title || !P) return out;
    const meta = /<p class="doc-meta">([\s\S]*?)<\/p>/.exec(html);

    const recovered = unRenderBody(body[1]);
    if (recovered === null) return out;
    const md =
      "# " + unescapeHtml(title[1].trim()) +
      (meta ? "\n\n*" + unescapeHtml(meta[1].trim()) + "*" : "") +
      "\n\n" + recovered + "\n";

    // The round trip. Nothing is offered to the operator that does not rebuild
    // the committed page exactly.
    const doc = P.render(md, { indent: FLOOR_INDENT });
    if (!doc || doc.html !== body[1]) return out;
    if (doc.title !== unescapeHtml(title[1].trim())) return out;
    out.markdown = normalize(md);
    return out;
  }

  /* ── Diff ──────────────────────────────────────────────────────────────────
     Line-level LCS with a hard ceiling: above it, trim the common head and tail
     and show the middle as one replacement. A diff that hangs the console on a
     long paste would be worse than a coarse one, and the coarseness is printed
     rather than applied silently. */
  const LCS_MAX = 1400;
  function diffLines(a, b) {
    if (a.length + b.length > LCS_MAX) {
      let s = 0;
      while (s < a.length && s < b.length && a[s] === b[s]) s++;
      let e = 0;
      while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
      const rows = [];
      for (let i = 0; i < s; i++) rows.push(["ctx", a[i]]);
      for (let i = s; i < a.length - e; i++) rows.push(["del", a[i]]);
      for (let i = s; i < b.length - e; i++) rows.push(["add", b[i]]);
      for (let i = a.length - e; i < a.length; i++) rows.push(["ctx", a[i]]);
      rows.coarse = true;
      return rows;
    }
    const n = a.length;
    const m = b.length;
    const w = m + 1;
    const dp = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    const rows = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { rows.push(["ctx", a[i]]); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { rows.push(["del", a[i]]); i++; }
      else { rows.push(["add", b[j]]); j++; }
    }
    while (i < n) { rows.push(["del", a[i]]); i++; }
    while (j < m) { rows.push(["add", b[j]]); j++; }
    return rows;
  }

  const MARK = { add: "+", del: "−", ctx: " " };
  function renderDiff() {
    const wrap = $("diff");
    wrap.textContent = "";
    const c = cur();
    const base = c.live ? c.live.markdown : c.floor && c.floor.markdown;
    if (base == null) {
      wrap.append(el("p", "pol-empty",
        "Nothing to compare against: no version is published, and the committed text could not be read back."));
      return;
    }
    const against = c.live ? `the live text (v${c.live.version})` : "the committed text";
    const rows = diffLines(normalize(base).split("\n"), normalize(c.body).split("\n"));
    if (!rows.some((r) => r[0] !== "ctx")) {
      wrap.append(el("p", "pol-empty", "Identical to " + against + "."));
      return;
    }
    wrap.append(el("div", "pol-dgap", "Against " + against + "." +
      (rows.coarse ? " Long document — shown as one combined change rather than line by line." : "")));
    // Context collapses to three lines either side: a legal document is mostly
    // unchanged, and the change is what this view exists to show.
    const keep = new Array(rows.length).fill(false);
    for (let k = 0; k < rows.length; k++) {
      if (rows[k][0] === "ctx") continue;
      for (let d = -3; d <= 3; d++) if (rows[k + d]) keep[k + d] = true;
    }
    let skipped = 0;
    const flush = () => {
      if (!skipped) return;
      wrap.append(el("div", "pol-dgap", `⋯ ${skipped} unchanged line${skipped === 1 ? "" : "s"}`));
      skipped = 0;
    };
    for (let k = 0; k < rows.length; k++) {
      if (!keep[k]) { skipped++; continue; }
      flush();
      const line = el("div", "pol-dline " + rows[k][0]);
      line.append(el("span", "pol-dmark", MARK[rows[k][0]]));
      line.append(el("span", "pol-dtext", rows[k][1] || " "));
      wrap.append(line);
    }
    flush();
  }

  /* ── Preview ───────────────────────────────────────────────────────────── */
  function renderPreview(doc) {
    const wrap = $("preview");
    wrap.textContent = "";
    if (!doc) {
      wrap.append(el("p", "pol-empty",
        "The preview appears once the document parses. The lamp above says what is in the way."));
      return;
    }
    wrap.append(el("h1", "pol-doc-title", doc.title));
    if (doc.meta) wrap.append(el("p", "pol-doc-meta", doc.meta));
    // policy.js escapes every value before it emits, and the only tags it can
    // produce are the ones written literally in it — which is the reason the
    // stored document is markdown and not HTML.
    const holder = el("div");
    holder.innerHTML = doc.html;
    while (holder.firstChild) wrap.append(holder.firstChild);
  }

  /* ── The state strip ───────────────────────────────────────────────────── */
  function setStat(id, value, cls, sub) {
    const v = $(id);
    const moved = v.textContent !== "" && v.textContent !== value;
    v.textContent = value;
    v.className = "pol-stat-value" + (cls ? " " + cls : "");
    if (moved) {
      void v.offsetWidth; // a finished animation never restarts under its own name
      v.classList.add("changed");
    }
    $(id + "Sub").textContent = sub;
  }

  function renderState() {
    const c = cur();
    const d = DOCS[slug];

    if (!c.loaded) {
      setStat("stLive", "…", "", "Reading.");
      setStat("stFloor", "…", "", "Reading.");
    } else {
      if (!c.live) {
        setStat("stLive", "none", "", "Nothing published from the panel; readers see the committed text.");
      } else {
        setStat("stLive", "v" + c.live.version, "ok", "Published " + ago(c.live.publishedAt) + ".");
      }
      const f = c.floor || {};
      const behind = c.live && c.live.version > f.version;
      if (f.unknown) {
        setStat("stFloor", "?", "warn", `Couldn't read ${d.page} from this server.`);
      } else if (f.foreign) {
        setStat("stFloor", "—", "warn",
          `${d.page} is stamped v${f.stamped} from ${f.foreign}, a different deployment — that number says nothing here.`);
      } else if (behind) {
        setStat("stFloor", f.version ? "v" + f.version : "none", "warn",
          "Behind the live text. Run policy-sync, then commit.");
      } else {
        setStat("stFloor", f.version ? "v" + f.version : "none", "",
          f.version ? "In step with the live text." : "Nothing published has been synced back yet.");
      }
    }

    const dirty = normalize(c.body) !== normalize(c.baseline);
    if (!c.body) {
      setStat("stDirty", "empty", "", "Nothing loaded.");
    } else if (dirty) {
      setStat("stDirty", "edited", "warn",
        sizeOf(normalize(c.body)).toLocaleString("en-US") + " characters, unpublished.");
    } else {
      setStat("stDirty", "clean", "",
        sizeOf(normalize(c.body)).toLocaleString("en-US") + " characters, as loaded.");
    }
    // The only unsaved work on this page is a legal document, so the browser's
    // own guard is worth the interruption.
    window.onbeforeunload = dirty ? () => "" : null;
  }

  /* ── Validation ────────────────────────────────────────────────────────── */
  function check() {
    const c = cur();
    const body = normalize(c.body);
    let state;
    let msg;
    let doc = null;

    if (!body) {
      state = "idle";
      msg = "Nothing loaded yet.";
    } else if (body.length < MIN_BODY) {
      state = "fault";
      msg = `Too short to publish: ${body.length} characters against a ${MIN_BODY} minimum. A policy this short is almost always a paste that went wrong.`;
    } else if (body.length > MAX_BODY) {
      state = "fault";
      msg = `Too long to publish: ${body.length.toLocaleString("en-US")} characters against a ${MAX_BODY.toLocaleString("en-US")} maximum.`;
    } else {
      const fault = structuralFault(body);
      if (fault) {
        state = "fault";
        msg = "Structure: " + fault;
      } else {
        doc = P ? P.render(body, { indent: FLOOR_INDENT }) : null;
        if (!doc) {
          // Both checks describe the same grammar from two sides, so this is
          // reachable only where they disagree — worth saying plainly rather
          // than dressing up as a structural fault it is not.
          state = "fault";
          msg = "The structure passes but the renderer refused the body, so readers would fall back to the committed page. This will not be sent.";
        } else {
          state = "ok";
          msg = `${doc.toc.length} section${doc.toc.length === 1 ? "" : "s"}, ${body.length.toLocaleString("en-US")} characters. Ready to publish.`;
        }
      }
    }

    $("lamp").setAttribute("data-state", state);
    const fault = $("fault");
    fault.textContent = msg;
    fault.className = "pol-fault" + (state === "ok" ? " ok" : state === "fault" ? " bad" : "");
    $("editor").classList.toggle("faulted", state === "fault");

    const same = c.live && normalize(c.live.markdown) === body;
    const btn = $("publish");
    btn.disabled = state !== "ok" || !!same;
    btn.title = same ? "This is already the live text." : "";

    if (view === "preview") renderPreview(doc);
    else renderDiff();
    renderState();
  }

  let checkTimer = null;
  function scheduleCheck() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(check, 140);
  }

  /* ── History ───────────────────────────────────────────────────────────── */
  function renderHistory() {
    const wrap = $("history");
    const note = $("historyNote");
    wrap.textContent = "";
    const c = cur();
    if (!c.loaded) { note.textContent = ""; return; }
    if (!c.history || !c.history.length) {
      note.textContent = "";
      wrap.append(el("p", "pol-empty",
        "Nothing has been published from the panel. The committed text is what readers see."));
      return;
    }
    note.textContent = `${c.history.length} version${c.history.length === 1 ? "" : "s"}, newest first`;
    for (const v of c.history) {
      const live = !!c.live && v.version === c.live.version;
      const row = el("div", "pol-ver" + (live ? " is-live" : ""));
      row.append(el("div", "pol-ver-n", "v" + v.version));
      const main = el("div", "pol-ver-main");
      main.append(v.note
        ? el("div", "pol-ver-note", v.note)
        : el("div", "pol-ver-note none", "No note"));
      main.append(el("div", "pol-ver-when",
        `${ago(v.publishedAt)} · ${v.chars.toLocaleString("en-US")} chars${live ? " · live" : ""}`));
      row.append(main);
      const btns = el("div", "pol-ver-btns");
      const open = el("button", "btn btn-ghost pol-btn-sm", "Open");
      open.type = "button";
      open.addEventListener("click", () => openVersion(v.version));
      btns.append(open);
      if (!live) {
        const back = el("button", "btn btn-ghost pol-btn-sm", "Restore");
        back.type = "button";
        back.addEventListener("click", () => armRestore(v.version));
        btns.append(back);
      }
      row.append(btns);
      wrap.append(row);
    }
  }

  async function openVersion(version) {
    try {
      const row = await query("policy:at", { ...creds(), slug, version });
      if (!row) { toast("That version is gone."); return; }
      setBody(row.markdown, row.markdown);
      toast(`v${version} is in the editor. Nothing is published until you press Publish.`);
    } catch (e) {
      toast(refusal(e, "Couldn't read that version."));
    }
  }

  /* ── Arm → confirm ─────────────────────────────────────────────────────────
     One panel, two uses. Both are irreversible from where the operator sits,
     and both name the document, the version and what stays stale afterwards —
     which is a paragraph, and a paragraph is what a `confirm()` string cannot
     lay out and nobody reads. */
  let armed = null;
  function arm(html, label, run) {
    armed = run;
    $("confirmText").innerHTML = html;
    $("confirmYes").querySelector(".btn-label").textContent = label;
    $("confirm").hidden = false;
    $("confirmYes").focus();
  }
  function disarm() {
    armed = null;
    $("confirm").hidden = true;
  }

  function armPublish() {
    const c = cur();
    const body = normalize(c.body);
    const next = c.live ? c.live.version + 1 : 1;
    arm(
      `Publish <strong>${DOCS[slug].label}</strong> as <strong>v${next}</strong>, ` +
        `${sizeOf(body).toLocaleString("en-US")} characters. Readers get it on their next page load. ` +
        `Git does not: <strong>${DOCS[slug].page}</strong>, the printed page and readers without ` +
        `JavaScript keep the committed text until policy-sync is run and the result committed.`,
      "Publish now",
      doPublish,
    );
  }

  function armRestore(version) {
    arm(
      `Restore <strong>v${version}</strong> of <strong>${DOCS[slug].label}</strong>. ` +
        `Its text is republished under a new number rather than replacing anything — nothing in ` +
        `the history is deleted, so what was live between any two dates stays answerable.`,
      "Restore it",
      () => doRestore(version),
    );
  }

  // The server's refusals name the rule they enforced, so they are shown as
  // written rather than translated into something friendlier that would hide
  // which rule that was.
  const refusal = (e, fallback) => e.detail || fallback;

  async function doPublish() {
    const c = cur();
    const body = normalize(c.body);
    const note = $("noteInput").value.trim().slice(0, MAX_NOTE);
    disarm();
    A.setLoading(true);
    try {
      const res = await A.mutate("policy:publish", {
        ...creds(),
        slug,
        markdown: body,
        ...(note ? { note } : {}),
      });
      if (res.unchanged) {
        toast(`No change — that is already v${res.version}.`);
      } else {
        toast(`Published v${res.version}. Run policy-sync to bring git up with it.`);
        $("noteInput").value = "";
      }
      c.baseline = body;
      await refresh();
    } catch (e) {
      toast(refusal(e, "Publish failed."));
    } finally {
      A.setLoading(false);
    }
  }

  async function doRestore(version) {
    disarm();
    A.setLoading(true);
    try {
      const res = await A.mutate("policy:revert", { ...creds(), slug, version });
      toast(`v${res.restored} republished as v${res.version}.`);
      await refresh();
      const c = cur();
      if (c.live) setBody(c.live.markdown, c.live.markdown);
    } catch (e) {
      toast(refusal(e, "Restore failed."));
    } finally {
      A.setLoading(false);
    }
  }

  /* ── Loading ───────────────────────────────────────────────────────────── */
  function setBody(text, baseline) {
    const c = cur();
    c.body = text;
    if (baseline !== undefined) c.baseline = baseline;
    $("editor").value = text;
    check();
  }

  async function refresh() {
    const c = cur();
    const d = DOCS[slug];
    const [live, floor, history] = await Promise.all([
      query("policy:current", { slug }),
      readFloor(d.page),
      query("policy:history", { ...creds(), slug }),
    ]);
    c.live = live;
    c.floor = floor;
    c.history = history;
    c.loaded = true;
    $("editNote").textContent = d.label;
    // Seed once, and only into an editor nobody has typed in: re-seeding over
    // an edit is how an operator loses a paragraph they were part way through.
    if (!c.body) {
      const seed = (live && live.markdown) || floor.markdown || "";
      c.body = seed;
      c.baseline = seed;
      $("editor").value = seed;
    }
    renderHistory();
    check();
  }

  // The shell's single-flight entry point. Only the document on screen is
  // fetched: the other one's numbers are not on screen either, and a strip
  // refreshed while hidden would be stale by the time it appeared.
  async function load() {
    try {
      await refresh();
      A.showPanel();
      A.afterRender();
      return true;
    } catch (e) {
      if (e.code === "UNAUTHORIZED") A.showGate("Access was refused.");
      else if (e.code === "RATE_LIMITED") A.showGate("Too many attempts. Wait a minute and try again.");
      else A.showGate("Couldn't reach the backend. Check your connection.");
      return false;
    } finally {
      A.setLoading(false);
    }
  }

  /* ── Wiring ────────────────────────────────────────────────────────────── */
  $("editor").addEventListener("input", (e) => {
    cur().body = e.target.value;
    scheduleCheck();
  });

  for (const b of $("docPick").querySelectorAll(".seg-btn")) {
    b.addEventListener("click", () => {
      const next = b.dataset.slug;
      if (next === slug) return;
      const c = cur();
      // A dirty editor is not discarded by a switch — each document keeps its
      // own body, so switching back finds the edit intact. The only thing that
      // needs saying is that it was not published.
      if (normalize(c.body) !== normalize(c.baseline)) {
        toast(`${DOCS[slug].short} has unpublished edits — they are kept here.`);
      }
      slug = next;
      for (const o of $("docPick").querySelectorAll(".seg-btn")) {
        const on = o.dataset.slug === slug;
        o.classList.toggle("is-on", on);
        o.setAttribute("aria-pressed", String(on));
      }
      disarm();
      $("editor").value = cur().body;
      $("noteInput").value = "";
      $("editNote").textContent = DOCS[slug].label;
      renderHistory();
      check();
      if (!cur().loaded) load();
    });
  }

  for (const b of $("viewPick").querySelectorAll(".seg-btn")) {
    b.addEventListener("click", () => {
      view = b.dataset.view;
      for (const o of $("viewPick").querySelectorAll(".seg-btn")) {
        const on = o.dataset.view === view;
        o.classList.toggle("is-on", on);
        o.setAttribute("aria-pressed", String(on));
      }
      $("previewWrap").hidden = view !== "preview";
      $("diffWrap").hidden = view !== "diff";
      check();
    });
  }

  $("loadLive").addEventListener("click", () => {
    const c = cur();
    if (!c.live) { toast("Nothing is published for this document."); return; }
    setBody(c.live.markdown, c.live.markdown);
    toast(`Live text (v${c.live.version}) loaded.`);
  });

  $("loadFloor").addEventListener("click", () => {
    const c = cur();
    const f = c.floor;
    if (!f || !f.markdown) {
      toast(f && f.unknown
        ? `Couldn't read ${DOCS[slug].page} from this server.`
        : `${DOCS[slug].page} could not be read back as markdown — paste it from ${DOCS[slug].md} instead.`);
      return;
    }
    setBody(f.markdown, f.markdown);
    toast("Committed text loaded.");
  });

  $("publish").addEventListener("click", armPublish);
  $("confirmNo").addEventListener("click", disarm);
  $("confirmYes").addEventListener("click", () => { if (armed) armed(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && armed) disarm();
  });

  A.init({
    load,
    onSignOut: () => {
      // The key is gone, so the text goes with it. A draft of a legal document
      // left in a textarea behind a locked gate is a signed-out console still
      // holding the work.
      for (const k of Object.keys(DOCS)) S[k] = blank();
      $("editor").value = "";
      $("noteInput").value = "";
      $("editor").classList.remove("faulted");
      disarm();
      window.onbeforeunload = null;
    },
  });
})();
