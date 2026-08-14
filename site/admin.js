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
  const CONVEX_URL = "https://insightful-wren-655.convex.cloud"; // production
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
      ["Sightings", fmt(t.observations), "price observations logged"],
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

  function renderTrend(daily) {
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
    note.textContent =
      `${fmt(total)} sightings · ${fmt(clicks)} clicks in ${daily.length} days` +
      (limited ? ` · ${fmt(limited)} price reports rate-limited` : "");

    const padL = 6, padR = 42, padT = 12, padB = 24;
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
    // bars
    daily.forEach((d, i) => {
      const bh = (d.observations / max) * (h - padT - padB);
      const x = padL + i * bw;
      const y = h - padB - bh;
      ctx.fillStyle = i === daily.length - 1 ? "#16a34a" : "rgba(22,163,74,0.42)";
      const r = Math.min(3, bw / 2 - 1);
      const bwi = Math.max(bw - 2, 1);
      ctx.beginPath();
      if (bh > r) {
        ctx.moveTo(x, h - padB);
        ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.lineTo(x + bwi - r, y);
        ctx.arcTo(x + bwi, y, x + bwi, y + r, r);
        ctx.lineTo(x + bwi, h - padB);
      } else {
        ctx.rect(x, h - padB - Math.max(bh, 1), bwi, Math.max(bh, 1));
      }
      ctx.closePath();
      ctx.fill();
    });
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
      const [stats, flagged] = await Promise.all([
        query("dashboard:stats", { adminKey }),
        query("dashboard:flagged", { adminKey }),
      ]);
      showPanel();
      renderKpis(stats);
      renderStores(stats.stores);
      renderCategories(stats.categories);
      renderHealth(stats.health);
      renderTrend(stats.daily);
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
