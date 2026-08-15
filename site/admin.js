// Jackdaw admin panel.
// Security posture: the admin key is a 256-bit bearer secret held in
// sessionStorage (cleared when the tab closes, never in localStorage, never in
// a URL), sent over HTTPS and compared server-side without early return.
// NOTE: failed attempts are NOT rate limited — a Convex mutation that throws
// rolls back its own transaction (including the limiter's write), and queries
// cannot write at all. The key's entropy is the lock; put the page behind edge
// SSO (see DEPLOY.md) for identity. noindex + robots Disallow'd. Single
// operator tool, not a multi-user auth system.
(() => {
  // set in config.js so the site and the extension are swapped together
  const CONVEX_URL = window.JACKDAW_CONVEX_URL;
  if (!CONVEX_URL) {
    document.body.innerHTML =
      '<p style="font:14px system-ui;padding:40px">config.js is missing: no Convex deployment configured.</p>';
    return;
  }
  const KEY_STORE = "jd_admin_key";

  const $ = (id) => document.getElementById(id);
  const gate = $("gate");
  const gateForm = $("gateForm");
  const keyInput = $("keyInput");
  const gateError = $("gateError");
  const panelWrap = $("panelWrap");
  const signOut = $("signOut");

  let adminKey = sessionStorage.getItem(KEY_STORE) || "";

  // ── Convex HTTP ──
  async function call(kind, path, args) {
    const res = await fetch(`${CONVEX_URL}/api/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    const json = await res.json();
    if (json.status === "success") return json.value;
    const code = json.errorData && json.errorData.code;
    const err = new Error(json.errorMessage || "Request failed");
    err.code = code;
    throw err;
  }
  const query = (path, args) => call("query", path, args);
  const mutate = (path, args) => call("mutation", path, args);

  // ── Helpers ──
  const fmt = (n) => (n == null ? "—" : n.toLocaleString());
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  let toastEl = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = el("div", "toast");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    requestAnimationFrame(() => toastEl.classList.add("in"));
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove("in"), 2400);
  }

  // ── Gate ──
  function showGate(message) {
    panelWrap.hidden = true;
    signOut.hidden = true;
    gate.hidden = false;
    if (message) {
      gateError.textContent = message;
      gateError.hidden = false;
      // retrigger the shake
      gateError.style.animation = "none";
      void gateError.offsetWidth;
      gateError.style.animation = "";
    }
    keyInput.focus();
  }

  function showPanel() {
    gate.hidden = true;
    gateError.hidden = true;
    panelWrap.hidden = false;
    signOut.hidden = false;
  }

  gateForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const val = keyInput.value.trim();
    if (!val) return;
    adminKey = val;
    const ok = await load();
    if (ok) {
      sessionStorage.setItem(KEY_STORE, adminKey);
      keyInput.value = "";
    } else {
      adminKey = "";
    }
  });

  signOut.addEventListener("click", () => {
    sessionStorage.removeItem(KEY_STORE);
    adminKey = "";
    showGate();
  });

  $("refresh").addEventListener("click", () => load());

  // ── Rendering ──
  const money = (n) =>
    "$" + Math.round(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

  function renderKpis(stats) {
    const t = stats.totals;
    const wrap = $("kpis");
    wrap.textContent = "";
    const cards = [
      // The two the partnership conversation actually turns on, first.
      ["Shoppers sent", t.alertsClicked, "alert clicks to a product page", true],
      [
        "Watched value",
        money(stats.watchedValue),
        stats.watchedValueTruncated ? "inventory awaited (floor)" : "inventory awaited",
        true,
      ],
      // Split, not summed. One product-page sighting is one shopper on one
      // product; one catalog sighting is one card on a page of up to 96, so a
      // combined total tracks results-per-page more than it tracks reach.
      // There is no honest label for the sum, so it is not shown.
      // Labels are kept short enough to sit on one line at the 155px minimum
      // tile width — "Product sightings" measures 128px against 123px of
      // content box and wraps. The subs carry the disambiguation.
      [
        "Page sightings",
        fmt(Math.max(0, t.observations - t.observationsCatalog)),
        "one shopper, one product",
      ],
      [
        "Grid sightings",
        fmt(t.observationsCatalog),
        `across ${fmt(t.catalogBatches)} result pages`,
      ],
      ["Products", fmt(t.products), "tracked at least once"],
      ["Contributors", fmt(t.devices), "browsers feeding the flock"],
      ["Alerts armed", fmt(t.alertsArmed), `${fmt(t.alertsFired)} fired`],
      ["Comments", fmt(t.comments), `${fmt(t.commentsHidden || 0)} hidden`],
      ["Reports", fmt(t.reports), "community flags raised"],
    ];
    for (const [label, value, sub, accent] of cards) {
      const card = el("div", "kpi" + (accent ? " kpi-accent" : ""));
      card.append(
        el("div", "kpi-label", label),
        el("div", "kpi-value", typeof value === "number" ? fmt(value) : value),
        el("div", "kpi-sub", sub),
      );
      wrap.append(card);
    }
  }

  function renderCategories(cats) {
    const wrap = $("categories");
    wrap.textContent = "";
    if (!cats || !cats.length) {
      wrap.append(el("div", "flag-empty", "No category data yet."));
      return;
    }
    const max = Math.max.apply(null, cats.map((c) => c.observations));
    for (const c of cats) {
      const row = el("div", "store-row");
      const name = el("div", "store-num cat-name", c.category);
      name.title = c.category;
      row.append(name);
      const bar = el("div", "store-bar");
      const fill = el("i");
      bar.append(fill);
      row.append(bar, el("div", "store-count", fmt(c.observations)));
      wrap.append(row);
      requestAnimationFrame(() => {
        fill.style.width = ((c.observations / max) * 100).toFixed(1) + "%";
      });
    }
    // A grid page is one category by construction, so a single visit to a
    // category page adds up to 96 here while a product visit adds 1. These
    // bars rank browsing format as much as they rank interest.
    wrap.append(
      el(
        "div",
        "admin-note",
        "Counts both sighting kinds, so grid-browsed categories rank higher.",
      ),
    );
  }

  function renderHealth(h) {
    const wrap = $("health");
    const note = $("healthNote");
    wrap.textContent = "";
    if (!h || !h.sampleSize) {
      note.textContent = "";
      wrap.append(el("div", "flag-empty", "No products sampled yet."));
      return;
    }
    note.textContent = `based on ${fmt(h.sampleSize)} products`;
    const pct = (n) => ((n / h.sampleSize) * 100).toFixed(0) + "%";
    const rows = [
      ["Chart-worthy", h.chartWorthy, "5+ price points", "good"],
      ["Thin", h.thin, "under 5 points", "warn"],
      // stale overlaps the two above; it is not a slice of the same pie
      ["Stale", h.stale, "no sighting in 30 days", "warn"],
    ];
    for (const [label, value, sub, tone] of rows) {
      const row = el("div", "health-row");
      row.append(
        el("div", "health-label", label),
        el("div", "health-value " + tone, `${fmt(value)} · ${pct(value)}`),
        el("div", "health-sub", sub),
      );
      wrap.append(row);
    }
    wrap.append(
      el("div", "admin-note", "Chart-worthy and thin split the sample; stale overlaps both."),
    );
  }

  // ── Category price movement ──
  // The only card here describing a MARKET rather than describing Jackdaw, and
  // therefore the only figure a retail partner has any reason to care about
  // beyond a row count. It is also the easiest one to overstate, so the
  // denominator is printed on every row rather than once in a footnote: the
  // median rests on `measured` products, out of `sampled` that we looked at,
  // out of a category whose real size we cannot know — we see what our users
  // happen to browse, never Micro Center's catalogue.
  let indexDays = 90;

  // U+2212, not a hyphen: it is the same width as a digit, so a column of
  // signed percentages stays aligned under tabular-nums.
  const signedPct = (n) =>
    (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(1) + "%";

  function renderPriceIndex(idx) {
    const wrap = $("priceIndex");
    const note = $("indexNote");
    wrap.textContent = "";
    const cats = (idx && idx.categories) || [];
    if (!cats.length) {
      note.textContent = "";
      wrap.append(el("div", "flag-empty", "No categories recorded yet."));
      return;
    }
    const measurable = cats.filter((c) => c.medianChangePct != null);
    note.textContent = measurable.length
      ? `${measurable.length} of ${cats.length} categories have enough history`
      : "no category has history reaching back that far yet";

    // Scaled to the largest movement on screen, with a floor so a quiet window
    // doesn't render a 0.3% drift as a full-width swing.
    const span = Math.max(
      5,
      ...measurable.map((c) => Math.abs(c.medianChangePct)),
    );

    for (const c of cats) {
      const row = el("div", "idx-row");
      const name = el("div", "idx-name", c.category);
      name.title = c.category;
      row.append(name);

      const bar = el("div", "idx-bar");
      const fill = el("i");
      const moved = c.medianChangePct != null && c.medianChangePct !== 0;
      if (moved) fill.className = c.medianChangePct < 0 ? "down" : "up";
      bar.append(fill);
      row.append(bar);

      const value = el(
        "div",
        "idx-value" + (moved ? (c.medianChangePct < 0 ? " down" : " up") : ""),
        c.medianChangePct == null ? "—" : signedPct(c.medianChangePct),
      );
      row.append(value);

      // "of 30+" when the category has more products than we sampled: the
      // denominator is a floor there, and rounding it off would read as a size.
      const cover = el(
        "div",
        "idx-cover",
        `${fmt(c.measured)} of ${fmt(c.sampled)}${c.atCap ? "+" : ""}`,
      );
      const why = [];
      if (c.tooNew) why.push(`${c.tooNew} newer than the window`);
      if (c.dense) why.push(`${c.dense} changed price too often to reach back`);
      if (c.noHistory) why.push(`${c.noHistory} with no readings`);
      // Assembled as whole sentences and joined, not concatenated fragments —
      // the fragment version ran the exclusion list straight into the direction
      // split with no stop between them ("1 with no readings 3 fell").
      const why_ = why.length ? ` — ${why.join(", ")}` : "";
      const said = [
        `${c.measured} of ${c.sampled} sampled ${c.sampled === 1 ? "product" : "products"} ` +
          `had a price at both ends of the window${why_}.`,
      ];
      if (c.atCap) said.push("More products exist in this category than were sampled.");
      said.push(
        c.medianChangePct == null
          ? `No median is shown below ${idx.minMeasured} measurable products.`
          : `${c.fell} fell, ${c.flat} held, ${c.rose} rose.`,
      );
      cover.title = said.join(" ");
      row.append(cover);

      wrap.append(row);
      requestAnimationFrame(() => {
        fill.style.width = moved
          ? (Math.min(Math.abs(c.medianChangePct) / span, 1) * 50).toFixed(1) + "%"
          : "0%";
      });
    }

    wrap.append(
      el(
        "div",
        "admin-note",
        `Median per-product change over ${idx.windowDays} days, from up to ${idx.sampleCap} ` +
          `long-tracked products per category; withheld below ${idx.minMeasured} measurable ones. ` +
          `The denominator is products Jackdaw has seen, not Micro Center's catalogue.`,
      ),
    );
  }

  document.getElementById("indexWindow").addEventListener("click", async (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn || btn.classList.contains("is-on")) return;
    const days = Number(btn.dataset.days);
    for (const b of e.currentTarget.querySelectorAll(".seg-btn")) {
      const on = b === btn;
      b.classList.toggle("is-on", on);
      // "false", never removed: an unpressed toggle still has to announce as a
      // toggle. Dropping the attribute turns the other two windows back into
      // plain buttons, so the group reads as one toggle and two unrelated
      // controls instead of a three-way choice.
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
    indexDays = days;
    // Re-queries this card alone. The counters above cost nothing to leave
    // alone and a full reload would redraw the chart for a window change that
    // has nothing to do with it.
    try {
      renderPriceIndex(
        await query("dashboard:categoryIndex", { adminKey, days: indexDays }),
      );
    } catch (err) {
      toast(err.code === "UNAUTHORIZED" ? "Session expired" : "Couldn't load that window");
      if (err.code === "UNAUTHORIZED") showGate("That key was rejected.");
    }
  });

  // Client-reported failures. The point of this card is early warning: if
  // Micro Center changes their markup, no_datalayer spikes and every panel is
  // silently broken. Rates are shown against panel_ok, never raw counts alone.
  const SIGNALS = {
    no_datalayer: ["Product data not found", "their markup may have changed"],
    report_failed: ["Price report failed", "backend unreachable or rejecting"],
    history_failed: ["History load failed", "chart could not be shown"],
    comments_failed: ["Comments load failed", "discussion could not be shown"],
    panel_error: ["Panel crashed", "uncaught error while rendering"],
  };

  function renderSignals(errors) {
    const card = $("signalsCard");
    const wrap = $("signals");
    const note = $("signalsNote");
    if (!errors || !errors.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    wrap.textContent = "";

    const by = Object.fromEntries(errors.map((e) => [e.name, e]));
    const ok = (by.panel_ok && by.panel_ok.last7) || 0;
    const bad = Object.keys(SIGNALS).reduce((a, k) => a + ((by[k] && by[k].last7) || 0), 0);
    const rate = ok + bad > 0 ? (bad / (ok + bad)) * 100 : 0;

    note.textContent = ok
      ? `${rate.toFixed(1)}% of ${fmt(ok + bad)} panel loads failed this week`
      : "no panel loads recorded this week";

    for (const [name, [label, meaning]] of Object.entries(SIGNALS)) {
      const e = by[name] || { last7: 0, total: 0 };
      const row = el("div", "health-row signal-row");
      const tone = e.last7 === 0 ? "good" : e.last7 > Math.max(3, ok * 0.02) ? "bad" : "warn";
      row.append(
        el("div", "health-label", label),
        el("div", "health-value " + tone, `${fmt(e.last7)} · 7d`),
        el("div", "health-sub", `${fmt(e.total)} all time — ${meaning}`),
      );
      wrap.append(row);
    }
    if (bad === 0 && ok > 0) {
      wrap.append(el("div", "admin-note", "Nothing failing. This card is the canary for a Micro Center redesign."));
    }
  }

  function renderStores(stores) {
    const wrap = $("stores");
    wrap.textContent = "";
    if (!stores || !stores.length) {
      wrap.append(el("div", "flag-empty", "No store activity yet."));
      return;
    }
    const max = Math.max.apply(null, stores.map((s) => s.observations));
    for (const s of stores) {
      const row = el("div", "store-row");
      row.append(el("div", "store-num", "Store #" + s.storeNum));
      const bar = el("div", "store-bar");
      const fill = el("i");
      bar.append(fill);
      row.append(bar, el("div", "store-count", fmt(s.observations)));
      wrap.append(row);
      requestAnimationFrame(() => {
        fill.style.width = ((s.observations / max) * 100).toFixed(1) + "%";
      });
    }
  }

  function renderTrend(daily, gridSplitFrom) {
    const canvas = $("trend");
    const note = $("trendNote");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 700;
    const h = 190;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!daily || !daily.length) {
      note.textContent = "No data yet";
      return;
    }
    const total = daily.reduce((a, d) => a + d.observations, 0);
    const clicks = daily.reduce((a, d) => a + (d.clicked || 0), 0);
    const limited = daily.reduce((a, d) => a + (d.rateLimited || 0), 0);
    // Days before the split was recorded carry grid: 0 because nothing was
    // counting, not because nobody browsed a grid. They are drawn as one
    // undifferentiated bar and excluded from the grid total, which is
    // therefore a floor over the whole window whenever any of them are here.
    // Infinity, not null, for the missing case: it makes every day fall on the
    // "unknown" side, which is what a panel talking to a backend that predates
    // the split should do rather than reporting a confident zero.
    const splitFrom = typeof gridSplitFrom === "number" ? gridSplitFrom : Infinity;
    const isSplit = (d) => Date.parse(d.date + "T00:00:00Z") >= splitFrom;
    const gridOf = (d) => Math.min(Math.max(d.grid || 0, 0), d.observations);
    const unsplitDays = daily.filter((d) => !isSplit(d)).length;
    const gridTotal = daily.reduce((a, d) => a + (isSplit(d) ? gridOf(d) : 0), 0);
    const pageTotal = daily.reduce(
      (a, d) => a + (isSplit(d) ? d.observations - gridOf(d) : 0),
      0,
    );
    note.textContent =
      (unsplitDays === daily.length
        ? `${fmt(total)} sightings, both kinds`
        : `${fmt(pageTotal)} page · ${fmt(gridTotal)} grid` +
          (unsplitDays ? ` · ${unsplitDays} days unsplit` : "")) +
      ` · ${fmt(clicks)} clicks in ${daily.length} days` +
      (limited ? ` · ${fmt(limited)} price reports rate-limited` : "");

    const padL = 6, padR = 42, padT = 28, padB = 24;
    const max = Math.max(1, ...daily.map((d) => d.observations));
    const bw = (w - padL - padR) / daily.length;

    // gridlines
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.strokeStyle = "rgba(120,130,145,0.16)";
    ctx.fillStyle = "#9aa1ab";
    for (let g = 0; g <= 2; g++) {
      const v = (max * g) / 2;
      const y = padT + (1 - v / max) * (h - padT - padB);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR + 4, y);
      ctx.stroke();
      ctx.fillText(String(Math.round(v)), w - padR + 8, y + 3);
    }
    // ONE hue at two weights, not two hues: grid sightings are a SHARE of the
    // bar, not a second series beside it, and a contrasting colour would read
    // as an independent quantity. The weight is carried by ALPHA rather than by
    // a second colour because it has to be — measured over this card, ANY two
    // colours drawn at the same low alpha composite to within ~1.1:1 of each
    // other (alpha compression toward white flattens the luminance gap, and no
    // hue escapes it), so the first draft's mint-on-deep-green stack was a
    // boundary nobody could see. Solid on pale measures 3.18:1.
    // Grey is reserved for the days that predate the split, where the
    // composition is genuinely unknown.
    const HUE = "14,122,55";       // --green-deep
    const PAGE_A = 0.36;           // 1.77:1 against the card
    const GRID_A = 1;              // 5.44:1 against the card, 3.18:1 against PAGE
    const UNKNOWN = "107,114,128"; // --muted
    // Heavier than it looks like it needs to be: at 0.5 the grey composited to
    // within 1.16:1 of the pale page fill, so the "we never counted this"
    // caveat was the one thing on the chart you couldn't see. 0.78 puts it
    // 1.87:1 from the page fill and 1.71:1 from the grid fill — roughly
    // equidistant from both, which is what a third state should be.
    const UNKNOWN_A = 0.78;

    const bwi = Math.max(bw - 2, 1);
    const r = Math.min(3, bwi / 2 - 0.5);
    // Rounds the top only, so a stacked segment sits flat against the one below
    // it while the bar as a whole keeps its cap.
    const seg = (x, y, hgt, rgb, alpha, roundTop) => {
      if (hgt <= 0) return;
      ctx.fillStyle = `rgba(${rgb},${alpha})`;
      ctx.beginPath();
      if (roundTop && r > 0 && hgt > r) {
        ctx.moveTo(x, y + hgt);
        ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.lineTo(x + bwi - r, y);
        ctx.arcTo(x + bwi, y, x + bwi, y + r, r);
        ctx.lineTo(x + bwi, y + hgt);
      } else {
        ctx.rect(x, y, bwi, hgt);
      }
      ctx.closePath();
      ctx.fill();
    };

    // bars
    const plot = h - padT - padB;
    daily.forEach((d, i) => {
      const bh = Math.max((d.observations / max) * plot, d.observations > 0 ? 1 : 0);
      const x = padL + i * bw;
      if (!isSplit(d)) {
        seg(x, h - padB - bh, bh, UNKNOWN, UNKNOWN_A, true);
        return;
      }
      // A single grid sighting on a 500-sighting day rounds to nothing, so a
      // nonzero share always keeps a 2px cap — and the page portion gives up
      // that height rather than the bar growing to accommodate it.
      const g = gridOf(d);
      const gridH = g > 0 ? Math.min(Math.max((g / max) * plot, 2), bh) : 0;
      seg(x, h - padB - (bh - gridH), bh - gridH, HUE, PAGE_A, gridH === 0);
      seg(x, h - padB - bh, gridH, HUE, GRID_A, true);
    });
    // Recency used to be carried by alpha too (every bar but the newest at
    // 0.42), which is the channel the split now needs. Moved to a rule under
    // the newest bar so the two encodings cannot collide — a heavily-sampled
    // grid day and "today" are different facts and must not look alike.
    ctx.fillStyle = `rgba(${HUE},1)`;
    ctx.fillRect(padL + (daily.length - 1) * bw, h - padB + 3, bwi, 2);

    // legend
    {
      // A key for colours that aren't on the chart is worse than no key: before
      // the first batch every day is grey, and listing the two greens there
      // would invite the reader to hunt for a split that was never recorded.
      const items =
        unsplitDays === daily.length
          ? [["Composition not counted", UNKNOWN, UNKNOWN_A]]
          : [
              ["Product pages", HUE, PAGE_A],
              ["Grid pages", HUE, GRID_A],
              ...(unsplitDays ? [["Before split", UNKNOWN, UNKNOWN_A]] : []),
            ];
      let lx = padL;
      ctx.font = "10px ui-monospace, Menlo, monospace";
      for (const [label, rgb, alpha] of items) {
        ctx.fillStyle = `rgba(${rgb},${alpha})`;
        ctx.beginPath();
        ctx.rect(lx, padT - 17, 8, 8);
        ctx.fill();
        ctx.fillStyle = "#6b7280";
        ctx.fillText(label, lx + 12, padT - 10);
        lx += 12 + ctx.measureText(label).width + 16;
      }
    }
    // first/last date labels
    ctx.fillStyle = "#9aa1ab";
    const short = (iso) => iso.slice(5).replace("-", "/");
    ctx.fillText(short(daily[0].date), padL, h - 8);
    const lastLabel = short(daily[daily.length - 1].date);
    ctx.fillText(lastLabel, w - padR - ctx.measureText(lastLabel).width, h - 8);
  }

  function renderFlagged(rows) {
    const wrap = $("flagged");
    const note = $("modNote");
    wrap.textContent = "";
    if (!rows || !rows.length) {
      note.textContent = "Clear";
      wrap.append(el("div", "flag-empty", "Nothing reported. The aisle is tidy."));
      return;
    }
    const hidden = rows.filter((r) => r.hidden).length;
    note.textContent = `${rows.length} flagged · ${hidden} hidden`;
    for (const r of rows) {
      const card = el("div", "flag" + (r.hidden ? " hidden-flag" : ""));
      const meta = el("div", "flag-meta");
      meta.append(
        el("span", "flag-author", r.displayName || "(hidden)"),
        el("span", "flag-count", `${r.reportCount} report${r.reportCount === 1 ? "" : "s"}`),
      );
      if (r.hidden) meta.append(el("span", null, "auto-hidden"));
      card.append(meta, el("div", "flag-body", r.body || "(hidden)"));

      const actions = el("div", "flag-actions");
      const unhide = el("button", "flag-btn", r.hidden ? "Restore" : "Clear reports");
      unhide.addEventListener("click", () => act(r._id, "unhide", unhide));
      const del = el("button", "flag-btn danger", "Delete");
      del.addEventListener("click", () => {
        if (!confirm("Delete this comment? Replies are kept and re-parented.")) return;
        act(r._id, "delete", del);
      });
      actions.append(unhide, del);
      card.append(actions);
      wrap.append(card);
    }
  }

  async function act(commentId, action, btn) {
    btn.disabled = true;
    try {
      await mutate("dashboard:resolve", { adminKey, commentId, action });
      toast(action === "delete" ? "Comment deleted" : "Comment restored");
      await load();
    } catch (e) {
      toast(e.code === "UNAUTHORIZED" ? "Session expired" : "Action failed");
      btn.disabled = false;
      if (e.code === "UNAUTHORIZED") showGate("That key was rejected.");
    }
  }

  // ── Load ──
  async function load() {
    if (!adminKey) {
      showGate();
      return false;
    }
    try {
      // Three queries, not one. The index reads price points and costs roughly
      // 7k documents; folding it into `stats` would put the counters — which
      // cost nothing and never fail — behind the one query here that can.
      const [stats, flagged, index] = await Promise.all([
        query("dashboard:stats", { adminKey }),
        query("dashboard:flagged", { adminKey }),
        query("dashboard:categoryIndex", { adminKey, days: indexDays }),
      ]);
      showPanel();
      renderKpis(stats);
      renderStores(stats.stores);
      renderCategories(stats.categories);
      renderPriceIndex(index);
      renderSignals(stats.errors);
      renderHealth(stats.health);
      renderTrend(stats.daily, stats.gridSplitFrom ?? null);
      renderFlagged(flagged);
      return true;
    } catch (e) {
      if (e.code === "UNAUTHORIZED") showGate("That key was rejected.");
      else if (e.code === "RATE_LIMITED") showGate("Too many attempts. Wait a minute and try again.");
      else showGate("Couldn't reach the backend. Check your connection.");
      return false;
    }
  }

  window.addEventListener("resize", () => {
    if (!panelWrap.hidden) load();
  });

  if (adminKey) load();
  else showGate();
})();
