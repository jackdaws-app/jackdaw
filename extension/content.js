// Isolated-world content script: receives product data from page-world.js,
// reports the observation, and renders the Jackdaw panel (price history
// chart + community discussion) on Micro Center product pages.
(() => {
  let product = null;
  let history = null;
  let comments = [];
  let panelEl = null;
  let collapsed = false;
  let pendingReveal = false; // one-time stagger + chart reveal on first data render

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
          else resolve(res || { error: "no response" });
        });
      } catch (e) {
        resolve({ error: String(e) });
      }
    });

  window.addEventListener("jackdaw:product", async (ev) => {
    try {
      product = JSON.parse(ev.detail);
    } catch {
      return;
    }
    if (!product || panelEl) return;
    buildPanel();
    // Report what this browser already sees, then load community data.
    send({ type: "report", data: product });
    await refreshAll();
  });

  async function refreshAll() {
    const [h, c] = await Promise.all([
      send({ type: "history", productId: product.productId }),
      send({ type: "comments:list", productId: product.productId }),
    ]);
    history = h && !h.error ? h.result : null;
    comments = c && !c.error && Array.isArray(c.result) ? c.result : [];
    pendingReveal = true;
    render();
  }

  // ---------- UI ----------

  function buildPanel() {
    panelEl = document.createElement("div");
    panelEl.id = "jackdaw-panel";
    document.body.appendChild(panelEl);
    render();
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtPrice(p) {
    return "$" + p.toFixed(2);
  }

  function fmtDate(ms) {
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function render() {
    if (!panelEl) return;
    panelEl.textContent = "";
    panelEl.classList.toggle("mk-collapsed", collapsed);

    const header = el("div", "mk-header");
    const title = el("div", "mk-title");
    title.append(el("span", "mk-logo", "JD"), el("span", null, "Jackdaw"));
    const toggle = el("button", "mk-toggle", collapsed ? "Price history ▴" : "▾");
    toggle.addEventListener("click", () => {
      collapsed = !collapsed;
      render();
    });
    header.append(title, toggle);
    panelEl.append(header);
    if (collapsed) return;

    const body = el("div", "mk-body" + (pendingReveal ? " mk-stagger" : ""));
    panelEl.append(body);

    // Price summary
    if (history && history.points.length) {
      const s = el("div", "mk-stats");
      const stats = history.stats || computeStats(history.points);
      s.append(
        stat("Current", fmtPrice(product.price), product.inStock ? "in stock" : "out of stock"),
        stat("Lowest seen", fmtPrice(stats.lowest), fmtDate(stats.lowestAt)),
        stat("Highest seen", fmtPrice(stats.highest), fmtDate(stats.highestAt)),
      );
      body.append(s);
      body.append(renderChart(history.points));
      const note = el("div", "mk-note");
      note.textContent = `${history.points.length} price point${history.points.length === 1 ? "" : "s"} from the community · store #${product.storeNum}`;
      body.append(note);
    } else {
      const empty = el("div", "mk-empty");
      empty.append(
        el("div", "mk-empty-title", "You're the first one here 🎉"),
        el("div", null, "Your visit just recorded today's price. Come back — or spread the word — and a price history chart will grow here."),
      );
      body.append(empty);
    }

    // Comments
    body.append(renderComments());
    pendingReveal = false;
  }

  function stat(label, value, sub) {
    const d = el("div", "mk-stat");
    d.append(el("div", "mk-stat-label", label), el("div", "mk-stat-value", value), el("div", "mk-stat-sub", sub));
    return d;
  }

  function computeStats(points) {
    let lowest = Infinity, highest = -Infinity, lowestAt = 0, highestAt = 0;
    for (const p of points) {
      if (p.price < lowest) { lowest = p.price; lowestAt = p.firstSeenAt; }
      if (p.price > highest) { highest = p.price; highestAt = p.firstSeenAt; }
    }
    return { lowest, highest, lowestAt, highestAt };
  }

  // Price-history step chart on canvas.
  function renderChart(points) {
    const wrap = el("div", "mk-chart-wrap" + (pendingReveal ? " mk-chart-reveal" : ""));
    const canvas = document.createElement("canvas");
    wrap.append(canvas);

    // Build a single series: use each point's [firstSeenAt..lastSeenAt] at its price.
    const segs = points
      .slice()
      .sort((a, b) => a.firstSeenAt - b.firstSeenAt)
      .map((p) => ({ t0: p.firstSeenAt, t1: Math.max(p.lastSeenAt, p.firstSeenAt), price: p.price, inStock: p.inStock }));
    const now = Date.now();
    if (segs.length) segs[segs.length - 1].t1 = Math.max(segs[segs.length - 1].t1, now);

    requestAnimationFrame(() => {
      const W = wrap.clientWidth || 360;
      const H = 160;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);

      const padL = 44, padR = 8, padT = 10, padB = 22;
      const t0 = segs[0].t0;
      const t1 = segs[segs.length - 1].t1;
      const span = Math.max(t1 - t0, 60_000);
      let pMin = Infinity, pMax = -Infinity;
      for (const s of segs) { pMin = Math.min(pMin, s.price); pMax = Math.max(pMax, s.price); }
      const pad = Math.max((pMax - pMin) * 0.15, pMax * 0.03, 1);
      pMin -= pad; pMax += pad;

      const x = (t) => padL + ((t - t0) / span) * (W - padL - padR);
      const y = (p) => padT + (1 - (p - pMin) / (pMax - pMin)) * (H - padT - padB);

      // grid + y labels
      ctx.font = "10px system-ui, sans-serif";
      ctx.fillStyle = "#8a8f98";
      ctx.strokeStyle = "rgba(128,128,128,0.18)";
      for (let i = 0; i <= 3; i++) {
        const p = pMin + ((pMax - pMin) * i) / 3;
        const yy = y(p);
        ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
        ctx.fillText("$" + p.toFixed(p >= 100 ? 0 : 2), 4, yy + 3);
      }
      // x labels: first and last date
      ctx.fillText(fmtDate(t0), padL, H - 6);
      const lastLabel = fmtDate(t1);
      ctx.fillText(lastLabel, W - padR - ctx.measureText(lastLabel).width, H - 6);

      // step line + fill
      ctx.beginPath();
      ctx.moveTo(x(segs[0].t0), y(segs[0].price));
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        ctx.lineTo(x(s.t0), y(s.price));
        ctx.lineTo(x(s.t1), y(s.price));
        if (i + 1 < segs.length) ctx.lineTo(x(segs[i + 1].t0), y(s.price));
      }
      ctx.strokeStyle = "#16a34a";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineTo(x(t1), H - padB);
      ctx.lineTo(x(segs[0].t0), H - padB);
      ctx.closePath();
      ctx.fillStyle = "rgba(22,163,74,0.12)";
      ctx.fill();

      // out-of-stock segments overlaid in red
      ctx.strokeStyle = "#dc2626";
      ctx.lineWidth = 2;
      for (const s of segs) {
        if (!s.inStock) {
          ctx.beginPath();
          ctx.moveTo(x(s.t0), y(s.price));
          ctx.lineTo(x(s.t1), y(s.price));
          ctx.stroke();
        }
      }
    });
    return wrap;
  }

  function renderComments() {
    const sec = el("div", "mk-comments");
    sec.append(el("div", "mk-section-title", `Discussion (${comments.length})`));

    const list = el("div", "mk-comment-list");
    if (!comments.length) {
      list.append(el("div", "mk-note", "No comments yet. Seen a deal, an open-box unit, or low shelf stock? Tell people."));
    }
    for (const c of comments) {
      const row = el("div", "mk-comment");
      const voteBox = el("div", "mk-votes");
      const up = el("button", "mk-vote-btn" + (c.myVote === 1 ? " mk-active-up" : ""), "▲");
      const score = el("div", "mk-score" + (c._pulse ? " mk-pop" : ""), String(c.score));
      delete c._pulse;
      const down = el("button", "mk-vote-btn" + (c.myVote === -1 ? " mk-active-down" : ""), "▼");
      up.addEventListener("click", () => castVote(c, c.myVote === 1 ? 0 : 1));
      down.addEventListener("click", () => castVote(c, c.myVote === -1 ? 0 : -1));
      voteBox.append(up, score, down);
      const main = el("div", "mk-comment-main");
      const meta = el("div", "mk-comment-meta");
      meta.append(el("span", "mk-author", c.displayName), el("span", null, " · " + fmtDate(c._creationTime)));
      main.append(meta, el("div", "mk-comment-body", c.body));
      row.append(voteBox, main);
      list.append(row);
    }
    sec.append(list);

    // form
    const form = el("div", "mk-form");
    const nameInput = el("input", "mk-input");
    nameInput.placeholder = "Display name";
    nameInput.maxLength = 40;
    chrome.storage.local.get("displayName").then((v) => { if (v.displayName) nameInput.value = v.displayName; });
    const bodyInput = el("textarea", "mk-input mk-textarea");
    bodyInput.placeholder = "Share intel about this product…";
    bodyInput.maxLength = 2000;
    const btn = el("button", "mk-post", "Post");
    btn.addEventListener("click", async () => {
      const displayName = nameInput.value.trim();
      const body = bodyInput.value.trim();
      if (!displayName || !body) return;
      btn.disabled = true;
      await chrome.storage.local.set({ displayName });
      const res = await send({ type: "comments:add", productId: product.productId, displayName, body });
      btn.disabled = false;
      if (!res.error) {
        bodyInput.value = "";
        const c = await send({ type: "comments:list", productId: product.productId });
        comments = c && !c.error ? c.result : comments;
        render();
      }
    });
    form.append(nameInput, bodyInput, btn);
    sec.append(form);
    return sec;
  }

  async function castVote(comment, value) {
    const res = await send({ type: "comments:vote", commentId: comment._id, value });
    if (!res.error) {
      comment.score = res.result.score;
      comment.myVote = value;
      comment._pulse = true;
      render();
    }
  }
})();
