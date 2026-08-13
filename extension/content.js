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
    updateTabSparkline();
    if (drawerEl && drawerEl.classList.contains("jd-open")) render();
  }

  // Once real history exists, the tab's glyph becomes this product's actual trend.
  function updateTabSparkline() {
    if (!tabEl || !history || history.points.length < 3) return;
    const pts = history.points.slice().sort((a, b) => a.firstSeenAt - b.firstSeenAt);
    const t0 = pts[0].firstSeenAt;
    const t1 = Math.max(pts[pts.length - 1].lastSeenAt, t0 + 1);
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) { lo = Math.min(lo, p.price); hi = Math.max(hi, p.price); }
    const spread = Math.max(hi - lo, 0.01);
    const X = (t) => 1 + ((t - t0) / (t1 - t0)) * 20;
    const Y = (p) => 15 - ((p - lo) / spread) * 11;
    let d = `M${X(pts[0].firstSeenAt).toFixed(1)} ${Y(pts[0].price).toFixed(1)}`;
    for (const p of pts) {
      d += ` L${X(p.firstSeenAt).toFixed(1)} ${Y(p.price).toFixed(1)} L${X(p.lastSeenAt).toFixed(1)} ${Y(p.price).toFixed(1)}`;
    }
    const path = tabEl.querySelector(".jd-spark path");
    if (path) path.setAttribute("d", d);
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

    // The carousel clips overflow, so the tab lives in <body> and is
    // positioned against the image box's outer left edge.
    const host = document.querySelector(".slides-container");
    if (host) {
      document.body.appendChild(tabEl);
      const place = () => {
        const r = host.getBoundingClientRect();
        tabEl.style.left = r.left + window.scrollX + "px";
        tabEl.style.top = r.top + window.scrollY + r.height / 2 + "px";
      };
      place();
      window.addEventListener("resize", place);
      // late layout shifts (carousel init, images loading)
      setTimeout(place, 800);
      setTimeout(place, 2500);
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
      const animateNums = pendingReveal;
      const current = stat("Current", product.price, product.inStock ? "in stock" : "out of stock", animateNums);
      if (atLow) current.classList.add("jd-at-low");
      s.append(
        current,
        stat("Lowest seen", stats.lowest, fmtDate(stats.lowestAt), animateNums),
        stat("Highest seen", stats.highest, fmtDate(stats.highestAt), animateNums),
      );
      left.append(s);

      // Verdict chip: the one-line answer a shopper actually wants,
      // judged against the duration-weighted typical price.
      const typical = window.__jackdawChart.typicalPrice(history.points);
      const chip = el("div", "jd-chip");
      if (atLow) {
        chip.classList.add("jd-chip-low");
        chip.textContent = "All-time low — as good as the flock has ever seen it";
      } else if (product.price <= typical * 0.97) {
        chip.classList.add("jd-chip-low");
        chip.textContent = `Good price — ${fmtPrice(typical - product.price)} below typical`;
      } else if (product.price < typical * 1.03) {
        chip.textContent = `Fair price — right around the typical ${fmtPrice(typical)}`;
      } else {
        chip.classList.add("jd-chip-high");
        chip.textContent = `${fmtPrice(product.price - typical)} above typical — patience may pay`;
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

  function stat(label, price, sub, animate) {
    const d = el("div", "mk-stat");
    const valueEl = el("div", "mk-stat-value", fmtPrice(animate ? price * 0.9 : price));
    d.append(el("div", "mk-stat-label", label), valueEl, el("div", "mk-stat-sub", sub));
    if (animate) countUp(valueEl, price);
    return d;
  }

  // Numbers roll up to their value on first open (tabular-nums: no layout shift).
  function countUp(node, target) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      node.textContent = fmtPrice(target);
      return;
    }
    const from = target * 0.9;
    const start = performance.now();
    const dur = 450;
    const tick = (now) => {
      const t = Math.min((now - start) / dur, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      node.textContent = fmtPrice(from + (target - from) * eased);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
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
