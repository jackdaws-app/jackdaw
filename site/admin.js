// Jackdaw admin panel — the numbers half of the console.
//
// The gate, the Convex transport, the power-on choreography and the plate
// stagger belong to the console rather than to this page, and live in
// admin-shell.js so the policies editor runs on exactly the same ones. See its
// head note for the security posture; nothing about the key is decided here.
(() => {
  const A = window.JackdawAdmin;
  if (!A || !A.ok) return;
  const { query, el, fmt, toast, still } = A;
  const creds = () => A.creds();

  const $ = (id) => document.getElementById(id);
  const panelWrap = A.panelWrap;

  let lastStats = null;
  const kpiPrev = new Map();
  let trendRun = 0;

  // ── Rendering ──
  const money = A.money;

  function renderKpis(stats) {
    const t = stats.totals;
    const wrap = $("kpis");
    wrap.textContent = "";
    const cards = [
      // The two most defensible figures in the panel, first.
      ["Shoppers sent", t.alertsClicked, "alert clicks to a product page", true],
      [
        "Watched value",
        stats.watchedValue,
        stats.watchedValueTruncated
          ? "sum of active alert targets (floor)"
          : "sum of active alert targets",
        true,
        money,
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
        Math.max(0, t.observations - t.observationsCatalog),
        "one shopper, one product",
      ],
      [
        "Grid sightings",
        t.observationsCatalog,
        `across ${fmt(t.catalogBatches)} result pages`,
      ],
      ["Products", t.products, "tracked at least once"],
      ["Contributors", t.devices, "browsers feeding the flock"],
      ["Alerts armed", t.alertsArmed, `${fmt(t.alertsFired)} fired`],
      ["Comments", t.comments, `${fmt(t.commentsHidden || 0)} hidden`],
      ["Reports", t.reports, "community flags raised"],
    ];
    // Every tile now carries a NUMBER and its formatter, where two of them used
    // to arrive pre-formatted. That is what makes both behaviours below
    // possible at all: you cannot count a string up, and you cannot tell
    // "$41,204" from "$41,205" without parsing back out of the presentation.
    for (const [label, value, sub, accent, format = fmt] of cards) {
      const card = el("div", "kpi" + (accent ? " kpi-accent" : ""));
      const val = el("div", "kpi-value", format(value));
      const prev = kpiPrev.get(label);
      if (!A.booted() && !still.matches && !document.hidden && typeof value === "number") {
        countUp(val, value, format);
      } else if (prev != null && prev !== value && !still.matches) {
        // A refresh redraws nine tiles at once; without this the one that moved
        // is indistinguishable from the eight that didn't. The flash is the
        // whole point of pressing Refresh, so it survives — it is state, not
        // decoration — but it is still motion, so reduced motion drops it.
        val.classList.add("changed");
        val.dataset.dir = value > prev ? "up" : "down";
      }
      if (typeof value === "number") kpiPrev.set(label, value);
      card.append(el("div", "kpi-label", label), val, el("div", "kpi-sub", sub));
      wrap.append(card);
    }
  }

  // Counts to the real figure through the SAME formatter the final value uses,
  // so the digits never reflow at the end and a thousands separator appears
  // where it belongs the whole way up. Values under 3 are not animated: a
  // count-up from 0 to 2 reads as a glitch, not as a gauge coming up.
  //
  // Not started at all in a backgrounded tab — the caller checks
  // `document.hidden` for the same reason renderTrend does. rAF does not fire
  // there, so a run begun in the background would paint `format(0)` and stop:
  // nine tiles reading zero, on a console whose whole job is to be trusted.
  // An ops page opened and left in a background tab is the ordinary case, not
  // an edge one.
  function countUp(node, target, format) {
    if (!(target > 2)) return;
    const dur = 900;
    let t0 = null;
    node.textContent = format(0);
    const step = (t) => {
      if (t0 == null) t0 = t;
      const k = Math.min(1, (t - t0) / dur);
      // Same curve as --ease-out, so a number arriving beside a plate that is
      // still settling shares its deceleration.
      const e = 1 - Math.pow(1 - k, 3);
      node.textContent = format(Math.round(target * e));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
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
  // The only card here describing a MARKET rather than describing Jackdaw. It
  // is also the easiest one to overstate, so the
  // denominator is printed on every row rather than once in a footnote: the
  // median rests on `measured` products, out of `sampled` that we looked at,
  // out of a category whose real size we cannot know — we see what our users
  // happen to browse, never Micro Center's catalog.
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
      const why_ = why.length ? `; excluded: ${why.join(", ")}` : "";
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
          `The denominator is products Jackdaw has seen, not Micro Center's catalog.`,
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
        await query("dashboard:categoryIndex", { ...creds(), days: indexDays }),
      );
    } catch (err) {
      toast(err.code === "UNAUTHORIZED" ? "Session expired" : "Couldn't load that window");
      if (err.code === "UNAUTHORIZED") A.showGate("Access was refused.");
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
        el("div", "health-sub", `${fmt(e.total)} all time · ${meaning}`),
      );
      wrap.append(row);
    }
    if (bad === 0 && ok > 0) {
      wrap.append(el("div", "admin-note", "Nothing failing. This card is the canary for a Micro Center redesign."));
    }
  }

  // Selector health. What each reader looks for, and — the part that decides
  // whether a number is alarming — what its healthy ratio actually IS.
  //
  // `expect` is not decoration. `.clearance` sits on every card and should read
  // ~1.00; `.standardDiscount` is absent whenever there is no discount and
  // reads ~0.35 on a normal page. Without that distinction the discount row
  // looks permanently broken and the real break, when it comes, is invisible
  // inside the noise. `null` means "no expected rate" — judge it against its
  // own lifetime figure instead.
  const SELECTORS = {
    card: [
      "Grid card",
      "li.product_wrapper",
      // NOT 1. Measured at 92 of 96 on a live page: four cards rendered no
      // price at all — `data-price` said $549.99 and nothing in the card's
      // visible text did — so the corroboration gate refused them, which is
      // the gate working. A few percent unread is the healthy state here, and
      // an expectation of 1.00 would have flagged a normal page forever.
      0.95,
      "the container. If this breaks, every reader below reports nothing",
    ],
    price: [
      "Card price",
      ".price_wrapper .price",
      1,
      "anchors the list-price read; if it stops matching, discounts go uncollected",
    ],
    clearance: [
      "Open box (grid)",
      ".clearance",
      1,
      "on every card, empty when there is no unit",
    ],
    discount: [
      "Advertised list",
      "div.standardDiscount",
      null,
      "absent when nothing is discounted, so a low rate is normal; only zero is a signal",
    ],
    openBox: [
      "Open box (product)",
      "#opCostNew",
      null,
      "absent on most products; this reader matched nothing for its entire life once",
    ],
  };

  function renderSelectors(selectors, rejected, recentDays) {
    const card = $("selectorsCard");
    const wrap = $("selectors");
    const note = $("selectorsNote");
    const foot = $("selectorsFoot");
    if (!selectors || !selectors.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    wrap.textContent = "";

    const by = Object.fromEntries(selectors.map((s) => [s.name, s]));
    const anyData = selectors.some((s) => s.seen > 0);
    note.textContent = anyData
      ? `last ${recentDays} days vs. all time`
      : "no readings reported yet";

    for (const [name, [label, selector, expect, meaning]] of Object.entries(SELECTORS)) {
      const s = by[name] || {
        seen: 0, found: 0, bad: 0, recentSeen: 0, recentFound: 0, recentBad: 0,
      };
      const row = el("div", "health-row signal-row");

      // The recent ratio is the number being judged; the lifetime one is the
      // yardstick. A reader with no recent readings is not broken — nobody
      // browsed — so it reads "—" rather than 0%, which would be a claim.
      const recentRate = s.recentSeen > 0 ? s.recentFound / s.recentSeen : null;
      const lifeRate = s.seen > 0 ? s.found / s.seen : null;

      // Judged against the expected rate where there is one, and otherwise
      // against this reader's own history — a reader that used to find
      // something and now finds nothing is the alarm regardless of what the
      // absolute rate was.
      //
      // NO YARDSTICK MEANS NO VERDICT. A reader with no expected rate that has
      // also never found anything (`lifeRate` 0) leaves the value untinted
      // rather than green. Measured against dev, the earlier version painted
      // "Open box (product) — 0%" as GOOD, on a single reading, which is the
      // one colour it must never be: the whole point of this table is that a
      // reader finding nothing is the failure it cannot otherwise announce.
      // Untinted says "not enough to judge", which is the truth at n=1.
      //
      // UNREADABLE IS JUDGED AS A RATE, not as a boolean. This read
      // `if (s.recentBad > 0) tone = "bad"` and therefore painted `.clearance`
      // red at 5,120 of 5,120 found — one card in five thousand carrying a
      // phrasing we don't parse, tinting the healthiest possible reading with
      // the one colour reserved for a reader that has stopped working. The
      // caveat this table is built on is that `bad` CLIMBING means the wording
      // changed; a single instance is not a climb, and a verdict that cannot be
      // supported by the number it is attached to trains the operator to
      // discount the colour everywhere else on the page.
      //
      // It escalates from whatever the found-rate concluded, including from
      // untinted: an element that was there and could not be parsed is an
      // observation in its own right, and it does not need a yardstick to be
      // worth reporting.
      const BAD_ALARM = 0.02; // ~2 cards on a 96-card page — no longer a one-off
      let tone = "";
      if (recentRate !== null) {
        const target = expect !== null ? expect : lifeRate;
        const judgeable = target !== null && target > 0;
        if (!judgeable) tone = "";
        else if (recentRate < target * 0.5) tone = "bad";
        else if (recentRate < target * 0.9) tone = "warn";
        else tone = "good";

        const badRate = s.recentSeen > 0 ? s.recentBad / s.recentSeen : 0;
        if (badRate >= BAD_ALARM) tone = "bad";
        else if (s.recentBad > 0 && tone !== "bad") tone = "warn";
      }

      const pct = (r) => (r === null ? "—" : (r * 100).toFixed(0) + "%");
      const life =
        lifeRate === null
          ? "nothing recorded"
          : `${pct(lifeRate)} of ${fmt(s.seen)} all time`;
      // The RECENT unreadable count has to be on screen, because it is now the
      // thing that can turn this row amber or red. The sub-line reported the
      // lifetime figure alone, which was survivable while unreadable was a
      // footnote and is not survivable now that it is a verdict: `openBox`
      // could go red on 3 of 96 in the window while the row said nothing at
      // all about 3. A colour whose evidence is off-screen is the defect this
      // whole card exists to catch, one level up.
      //
      // `max` because the lifetime counter is the superset in real data and a
      // client sending otherwise should not make the row print "0 unreadable,
      // 3 in 7d".
      const badTotal = Math.max(s.bad, s.recentBad);
      let bad = "";
      if (badTotal > 0) {
        bad = ` · ${fmt(badTotal)} unreadable`;
        if (s.recentBad > 0) bad += `, ${fmt(s.recentBad)} in ${recentDays}d`;
      }
      row.append(
        el("div", "health-label", label),
        el("div", "health-value " + tone, `${pct(recentRate)} · ${recentDays}d`),
        el("div", "health-sub", `${life}${bad} · ${selector}, ${meaning}`),
      );
      wrap.append(row);
    }

    // Everything this table cannot support, stated in place rather than left
    // for someone to infer from a number that looks authoritative.
    foot.textContent =
      "Found = the element was on the page; unreadable = it was there and could not be parsed, " +
      "which the readers treat as unknown and keep the last value for. These counts come from the " +
      "extension describing its own behavior, so they are advisory, not evidence. They raise a " +
      "question, and the answer always comes from driving a real page. A grid page that rendered " +
      "no readable card is reported with zero items so it is visible here; genuine no-result " +
      "searches land in that same number and cannot be separated from a broken selector." +
      (rejected > 0
        ? ` ${fmt(rejected)} tallies were refused as internally inconsistent. A client is sending numbers it cannot have measured, so read the whole table with that in mind.`
        : "");
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

    // ONE hue at two weights, not two hues: grid sightings are a SHARE of the
    // bar, not a second series beside it, and a contrasting colour would read
    // as an independent quantity. The weight is carried by ALPHA rather than by
    // a second colour because it has to be — measured over this plate, ANY two
    // colours drawn at the same low alpha composite to within ~1.1:1 of each
    // other, so a mint-on-deep-green stack is a boundary nobody can see.
    //
    // These are NOT the paper figures re-tinted. Alpha on paper compresses
    // toward white and here it compresses toward black, which inverts every
    // margin, and the base hue had to change with it: --accent (#4ade80) spans
    // only 9.63:1 against this plate, so a pale/solid split off it tops out at
    // 3.21 / 3.00 with the second number sitting exactly on the floor.
    // --accent-deep is the LIGHTER of the night pair ("deep" means more
    // emphatic, not darker — see the token block in styles.css) and spans
    // 11.95:1, which is what buys both weights a real margin.
    //
    // PAGE_A is specified against the PLATE and not merely against GRID_A
    // because on any day with zero grid sightings the pale fill is the entire
    // bar. The paper version missed that: its 0.36 measured 1.77:1 against the
    // card, so an all-product-page day was drawn below the 3:1 a meaningful
    // graphic owes, and the defect was invisible precisely on the days the
    // chart had the least to say.
    const HUE = "134,239,172";     // --accent-deep
    const PAGE_A = 0.42;           // 3.19:1 on the plate, 3.06 at its lit top
    const GRID_A = 1;              // 11.95:1 on the plate, 3.75:1 over PAGE
    const UNKNOWN = "154,168,189"; // --muted
    // Grey is reserved for days that predate the split, where the composition
    // is genuinely unknown — and it has to sit clear of BOTH greens, not just
    // be visible. At 0.92 it measures 1.91:1 from the pale fill and 1.96:1 from
    // the solid: near-equidistant, which is what a third state should be.
    const UNKNOWN_A = 0.92;
    const AXIS = "#9aa8bd";                  // --muted, 6.96:1 on the plate
    const GRIDLINE = "rgba(255,255,255,0.10)"; // reference ruling, not data

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

    const plot = h - padT - padB;
    // `k` runs 0 → 1 for the first draw only. The frame — gridlines, ticks,
    // legend, dates — is painted at full strength from the first frame: the
    // instrument is already there, and what arrives is the trace on it.
    const paint = (k) => {
      ctx.clearRect(0, 0, w, h);
      ctx.font = "10px ui-monospace, Menlo, monospace";
      ctx.strokeStyle = GRIDLINE;
      ctx.fillStyle = AXIS;
      for (let g = 0; g <= 2; g++) {
        const v = (max * g) / 2;
        const y = padT + (1 - v / max) * plot;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(w - padR + 4, y);
        ctx.stroke();
        ctx.fillText(String(Math.round(v)), w - padR + 8, y + 3);
      }

      const n = daily.length;
      const span = 0.55; // each bar's own rise, as a fraction of the run
      daily.forEach((d, i) => {
        const t0 = (i / Math.max(n - 1, 1)) * (1 - span);
        const kb = Math.min(1, Math.max(0, (k - t0) / span));
        const grow = 1 - Math.pow(1 - kb, 3); // matches --ease-out
        if (grow <= 0) return;
        const full = Math.max((d.observations / max) * plot, d.observations > 0 ? 1 : 0);
        const bh = full * grow;
        const x = padL + i * bw;
        if (!isSplit(d)) {
          seg(x, h - padB - bh, bh, UNKNOWN, UNKNOWN_A, true);
          return;
        }
        // A single grid sighting on a 500-sighting day rounds to nothing, so a
        // nonzero share always keeps a 2px cap — and the page portion gives up
        // that height rather than the bar growing to accommodate it.
        const g = gridOf(d);
        const gridH = g > 0 ? Math.min(Math.max((g / max) * plot, 2), full) * grow : 0;
        seg(x, h - padB - (bh - gridH), bh - gridH, HUE, PAGE_A, gridH === 0);
        seg(x, h - padB - bh, gridH, HUE, GRID_A, true);
      });

      // Recency used to be carried by alpha too (every bar but the newest at
      // 0.42), which is the channel the split now needs. Moved to a rule under
      // the newest bar so the two encodings cannot collide — a heavily-sampled
      // grid day and "today" are different facts and must not look alike.
      ctx.fillStyle = `rgba(${HUE},1)`;
      ctx.fillRect(padL + (n - 1) * bw, h - padB + 3, bwi * k, 2);

      // legend
      {
        // A key for colours that aren't on the chart is worse than no key:
        // before the first batch every day is grey, and listing the two greens
        // there would invite the reader to hunt for a split never recorded.
        const items =
          unsplitDays === daily.length
            ? [["Composition not counted", UNKNOWN, UNKNOWN_A]]
            : [
                ["Product pages", HUE, PAGE_A],
                ["Grid pages", HUE, GRID_A],
                ...(unsplitDays ? [["Before split", UNKNOWN, UNKNOWN_A]] : []),
              ];
        let lx = padL;
        for (const [label, rgb, alpha] of items) {
          ctx.fillStyle = `rgba(${rgb},${alpha})`;
          ctx.beginPath();
          ctx.rect(lx, padT - 17, 8, 8);
          ctx.fill();
          ctx.fillStyle = AXIS;
          ctx.fillText(label, lx + 12, padT - 10);
          lx += 12 + ctx.measureText(label).width + 16;
        }
      }

      // first/last date labels
      ctx.fillStyle = AXIS;
      const short = (iso) => iso.slice(5).replace("-", "/");
      ctx.fillText(short(daily[0].date), padL, h - 8);
      const lastLabel = short(daily[n - 1].date);
      ctx.fillText(lastLabel, w - padR - ctx.measureText(lastLabel).width, h - 8);
    };

    // The trace is drawn on once, on the first load, left to right — the same
    // "data-true, drawn on" gesture the landing page's sparkline uses. A
    // refresh or a resize repaints finished, because a chart that re-animates
    // every time you touch the window is a toy.
    //
    // `document.hidden` is not a nicety: rAF does not fire in a backgrounded
    // tab, so starting a run there would leave the canvas at k=0 — an empty
    // chart — until the tab was fronted. Same gotcha the panel's bar widths hit.
    trendRun++;
    if (A.booted() || still.matches || document.hidden) {
      paint(1);
      return;
    }
    const run = trendRun;
    const dur = 820;
    let t0 = null;
    const step = (t) => {
      if (run !== trendRun) return; // a refresh landed mid-draw; it owns the canvas now
      if (t0 == null) t0 = t;
      const k = Math.min(1, (t - t0) / dur);
      paint(k);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
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
      await A.mutate("dashboard:resolve", { ...creds(), commentId, action });
      toast(action === "delete" ? "Comment deleted" : "Comment restored");
      await load();
    } catch (e) {
      toast(e.code === "UNAUTHORIZED" ? "Session expired" : "Action failed");
      btn.disabled = false;
      if (e.code === "UNAUTHORIZED") A.showGate("Access was refused.");
    }
  }

  // ── Published policies ──
  // The one card on this page that reads two sources and compares them. It is
  // NOT a copy of the policy text — it answers "is what readers see the text
  // that is in git", which is the question the live-publish design creates and
  // nothing else on the site can answer.
  //
  // Both queries are public and unauthenticated on purpose: `policy:current` is
  // what every reader's browser calls to hydrate privacy.html. Sending the
  // admin key with them would add nothing and widen where it travels.
  const POLICY_DOCS = [
    { slug: "privacy", label: "Privacy Policy", page: "privacy.html" },
    { slug: "terms", label: "Terms of Service", page: "terms.html" },
  ];
  const { host: HOST, ago } = A;

  // The committed floor, read out of the shipped page itself rather than out of
  // a build manifest — the page IS the artefact, so nothing can drift between
  // what this reports and what a no-JavaScript reader receives.
  //
  // Version numbers are per-deployment counters, so one stamped by a different
  // deployment is not a floor here: dev v9 says nothing about prod. Same rule
  // policy-sync.js applies; if the two disagreed, one of them would be lying.
  async function readFloor(page) {
    try {
      const res = await fetch(page, { cache: "no-store" });
      if (!res.ok) return { version: 0, unknown: true };
      const html = await res.text();
      const tag = /<main class="doc"[^>]*>/.exec(html);
      if (!tag) return { version: 0, unknown: true };
      const dep = (/data-policy-deployment="([^"]*)"/.exec(tag[0]) || [, ""])[1];
      const ver = Number((/data-policy-version="(\d+)"/.exec(tag[0]) || [, "0"])[1]);
      if (dep && dep !== HOST) return { version: 0, foreign: dep };
      return { version: ver };
    } catch {
      return { version: 0, unknown: true };
    }
  }

  // The only renderer on the page that awaits before it paints, and therefore
  // the only one two overlapping `load()`s can interleave. `#refresh` calls
  // `load()` with no re-entry guard, so a double-click on a slow reply ran this
  // twice: both cleared, both appended, four policy rows. The generation token
  // makes a superseded run drop its own result, and the clear moved BELOW the
  // await so the card holds the previous answer while a refresh is in flight
  // rather than blanking — this card reports whether the live text matches git,
  // and an empty gap reads as "nothing published", which is a different claim.
  let policyRun = 0;
  async function renderPolicies() {
    const run = ++policyRun;
    const wrap = $("policies");
    let rows;
    try {
      rows = await Promise.all(
        POLICY_DOCS.map(async (d) => ({
          ...d,
          live: await query("policy:current", { slug: d.slug }),
          floor: await readFloor(d.page),
        })),
      );
    } catch {
      if (run !== policyRun) return;
      wrap.textContent = "";
      wrap.append(el("div", "flag-empty", "Couldn't read the published policies."));
      return;
    }
    if (run !== policyRun) return;
    wrap.textContent = "";

    let behind = 0;
    for (const r of rows) {
      const row = el("div", "policy-row");
      const version = el("div", "policy-version");
      const sub = el("div", "policy-sub");

      if (!r.live) {
        // Nothing published is the ordinary state before the first amendment,
        // and it is not drift: the committed text is what readers get, which is
        // exactly what the static floor is for.
        version.textContent = "—";
        sub.textContent = "Nothing published from the panel; readers see the committed text.";
      } else if (r.live.version > r.floor.version) {
        behind++;
        version.textContent = `v${r.live.version}`;
        version.classList.add("warn");
        sub.append(
          document.createTextNode(
            `Live since ${ago(r.live.publishedAt)}, ` +
              // v0 is the state of a page that has never been stamped, which is
              // every page today. "git has v0" invites the reading that some
              // zeroth version was published; nothing was.
              (r.floor.version
                ? `git has v${r.floor.version}. `
                : `git carries no published version. `) +
              `The repository, the printed page and readers without JavaScript still ` +
              `show the older text; run `,
          ),
          el("code", "policy-cmd", "node site/policy-sync.js --write"),
          document.createTextNode(", then commit."),
        );
      } else {
        version.textContent = `v${r.live.version}`;
        version.classList.add("ok");
        sub.textContent = `Published ${ago(r.live.publishedAt)} and committed.`;
      }
      if (r.floor.foreign) {
        sub.append(
          document.createTextNode(
            ` The committed stamp came from ${r.floor.foreign}, a different deployment, so it is not a floor here.`,
          ),
        );
      } else if (r.floor.unknown) {
        sub.append(document.createTextNode(" The committed page could not be read."));
      }

      row.append(el("div", "policy-name", r.label), version, sub);
      wrap.append(row);
    }
    // The card earns attention only when something is actually behind it. A
    // permanent badge is a badge nobody reads.
    $("policyCard").classList.toggle("has-drift", behind > 0);
  }

  // ── Load ──
  async function load() {
    if (!A.hasCreds()) {
      A.showGate();
      return false;
    }
    // Drives the refresh arrow's spin. Set before the await so the button
    // responds to the click and not to the reply.
    A.setLoading(true);
    try {
      // Three queries, not one. The index reads price points and costs roughly
      // 7k documents; folding it into `stats` would put the counters — which
      // cost nothing and never fail — behind the one query here that can.
      const [stats, flagged, index] = await Promise.all([
        query("dashboard:stats", creds()),
        query("dashboard:flagged", creds()),
        query("dashboard:categoryIndex", { ...creds(), days: indexDays }),
      ]);
      lastStats = stats;
      A.showPanel();
      renderKpis(stats);
      renderStores(stats.stores);
      renderCategories(stats.categories);
      renderPriceIndex(index);
      renderSignals(stats.errors);
      renderSelectors(
        stats.selectors,
        stats.selectorsRejected ?? 0,
        stats.selectorRecentDays ?? 7,
      );
      renderHealth(stats.health);
      renderTrend(stats.daily, stats.gridSplitFrom ?? null);
      renderFlagged(flagged);
      // Stamped AFTER every renderer, because two of the cards decide whether
      // they are hidden while rendering.
      A.afterRender();
      // Its own request, deliberately not awaited with the three above: it hits
      // a different (public) endpoint and reads two files off this origin, and
      // a slow policy read must not hold the numbers back.
      renderPolicies();
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

  // The canvas is sized from its client width, so it genuinely has to be
  // redrawn on resize — but it was doing that by re-running `load()`, which
  // fires three Convex queries per resize tick, one of them the ~7k-document
  // category index. Dragging a window edge was a sustained query storm against
  // the deployment, from the page whose own footnote explains why reads here
  // are kept bounded. Redraw from the stats already in hand instead; nothing
  // else on the page measures in JavaScript.
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (panelWrap.hidden || !lastStats) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      renderTrend(lastStats.daily, lastStats.gridSplitFrom ?? null);
    }, 120);
  });

  A.init({ load });
})();
