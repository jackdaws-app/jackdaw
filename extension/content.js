// Isolated-world content script: receives product data from page-world.js,
// reports the observation, anchors a "Price history" tab to the product image,
// and opens a bottom drawer with the interactive chart + community discussion.
(() => {
  let product = null;
  let history = null;
  let comments = [];
  let tabEl = null;
  let drawerEl = null;
  let drawerBody = null;
  let everOpened = false;
  let pendingReveal = false; // one-time stagger + chart reveal on first drawer open

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
    window.dispatchEvent(new CustomEvent("jackdaw:ack"));
    if (tabEl) return;
    try {
      product = JSON.parse(ev.detail);
    } catch {
      return;
    }
    if (!product) return;
    buildTab();
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
    if (drawerEl && drawerEl.classList.contains("jd-open")) render();
  }

  // ---------- Tab on the product image (left edge) ----------

  const SPARK_PATH = "M1 15 L6 15 L6 9 L11 9 L11 12 L16 12 L16 4 L21 4";

  function buildTab() {
    tabEl = document.createElement("button");
    tabEl.id = "jackdaw-tab";
    tabEl.setAttribute("aria-label", "Price history");
    tabEl.innerHTML =
      `<svg class="jd-spark" viewBox="0 0 22 18" fill="none" aria-hidden="true">` +
      `<path d="${SPARK_PATH}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" pathLength="100"/></svg>` +
      `<span class="jd-tab-text">Price history</span>`;
    tabEl.addEventListener("click", openDrawer);

    const host = document.querySelector(".slides-container");
    if (host) {
      if (getComputedStyle(host).position === "static") host.style.position = "relative";
      host.appendChild(tabEl);
    } else {
      tabEl.classList.add("jd-tab-fixed");
      document.body.appendChild(tabEl);
    }
  }

  // ---------- Bottom drawer ----------

  function buildDrawer() {
    drawerEl = document.createElement("div");
    drawerEl.id = "jackdaw-drawer";

    const header = el("div", "jd-header");
    const brand = el("div", "jd-brand");
    brand.innerHTML =
      `<span class="jd-live" title="Live community data"></span>` +
      `<span class="jd-wordmark">Jackdaw</span>`;
    const prodName = el("div", "jd-product-name", product.name);
    const minimize = el("button", "jd-minimize", "Minimize");
    minimize.addEventListener("click", closeDrawer);
    header.append(brand, prodName, minimize);

    drawerBody = el("div", "jd-drawer-body");
    drawerEl.append(header, drawerBody);
    document.body.appendChild(drawerEl);
  }

  function openDrawer() {
    if (!drawerEl) buildDrawer();
    pendingReveal = !everOpened;
    everOpened = true;
    render();
    tabEl.classList.add("jd-hidden");
    requestAnimationFrame(() => requestAnimationFrame(() => drawerEl.classList.add("jd-open")));
  }

  function closeDrawer() {
    drawerEl.classList.remove("jd-open");
    tabEl.classList.remove("jd-hidden");
  }

  // ---------- Rendering ----------

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
    if (!drawerBody) return;
    drawerBody.textContent = "";

    const left = el("div", "jd-col" + (pendingReveal ? " mk-stagger" : ""));
    if (history && history.points.length) {
      const stats = computeStats(history.points);
      const atLow = product.price <= stats.lowest;

      const s = el("div", "mk-stats");
      const current = stat("Current", fmtPrice(product.price), product.inStock ? "in stock" : "out of stock");
      if (atLow) current.classList.add("jd-at-low");
      s.append(
        current,
        stat("Lowest seen", fmtPrice(stats.lowest), fmtDate(stats.lowestAt)),
        stat("Highest seen", fmtPrice(stats.highest), fmtDate(stats.highestAt)),
      );
      left.append(s);

      // Delta chip: the one-line verdict a shopper actually wants.
      const chip = el("div", "jd-chip");
      if (atLow) {
        chip.classList.add("jd-chip-low");
        chip.textContent = "All-time low — as good as the flock has ever seen it";
      } else {
        const diff = stats.highest - product.price;
        chip.textContent = diff > 0.005
          ? `${fmtPrice(diff)} under the recorded high`
          : "At the recorded high";
      }
      left.append(chip);

      left.append(window.__jackdawChart.build(history.points, { reveal: pendingReveal }));

      const note = el("div", "mk-note");
      const first = history.points.reduce((m, p) => Math.min(m, p.firstSeenAt), Infinity);
      const sightings = history.points.reduce((n, p) => n + (p.reportCount || 1), 0);
      note.textContent = `Community-tracked since ${fmtDate(first)} · ${sightings} sighting${sightings === 1 ? "" : "s"} · store #${product.storeNum}`;
      left.append(note);
    } else {
      const empty = el("div", "mk-empty");
      empty.append(
        el("div", "mk-empty-title", "No sightings yet"),
        el("div", null, "Your visit just logged today's price — the first in the flock's memory. The chart begins here."),
      );
      left.append(empty);
    }

    const right = el("div", "jd-col" + (pendingReveal ? " mk-stagger" : ""));
    right.append(renderComments());

    drawerBody.append(left, right);
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

  function renderComments() {
    const sec = el("div", "mk-comments");
    sec.append(el("div", "mk-section-title", comments.length ? `Aisle intel (${comments.length})` : "Aisle intel"));

    const list = el("div", "mk-comment-list");
    if (!comments.length) {
      list.append(el("div", "mk-note", "Quiet aisle. Spotted an open-box deal, a price match, or empty shelves? Leave a note for the flock."));
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
    bodyInput.placeholder = "What did you see in store?";
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
