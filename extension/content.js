// Isolated-world content script: receives product data from page-world.js,
// reports the observation, anchors a "Price history" tab to the product image,
// and opens a bottom drawer with the interactive chart + community discussion.
(() => {
  let product = null;
  let history = null;
  let comments = [];
  let historyLoaded = false;
  let tabEl = null;
  let drawerEl = null;
  let paneEl = null; // single full-width pane; content switches by tab
  let activeTab = "chart"; // "chart" | "discussion" | "alerts"
  let tabButtons = null;
  let tabIndicator = null;
  let everOpened = false;
  let pendingReveal = false; // one-time stagger + chart reveal on first drawer open
  let theme = "light";
  let chartHeight = 190;
  let watchBtn = null;
  let replyTo = null; // comment _id an open reply form belongs to
  let uiRoot = null; // ShadowRoot — isolates our UI from the host page's CSS entirely

  async function ensureRoot() {
    if (uiRoot) return uiRoot;
    const host = document.createElement("div");
    host.id = "jackdaw-root";
    host.style.cssText = "position:absolute;top:0;left:0;width:0;height:0;z-index:2147483000;";
    document.documentElement.appendChild(host);
    uiRoot = host.attachShadow({ mode: "open" });
    const css = await fetch(chrome.runtime.getURL("panel.css")).then((r) => r.text());
    const style = document.createElement("style");
    style.textContent = css;
    uiRoot.append(style);
    return uiRoot;
  }
  let watchTarget = null; // active alert target price, or null
  let commentSort = "top"; // "top" | "new"
  const collapsedThreads = new Set(); // comment _ids collapsed reddit-style

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
    await ensureRoot();
    await chrome.storage.local.get(["jdTheme", "jdChartH"]).then((v) => {
      if (v.jdTheme === "dark") theme = "dark";
      if (v.jdChartH) chartHeight = v.jdChartH;
    });
    buildTab();
    // The bird flies in, becomes the banner, and only then does the
    // coach mark speak — one thing at a time.
    chrome.storage.local.get("jdFlightDone").then(async ({ jdFlightDone }) => {
      await flightEntrance(!jdFlightDone);
      if (!jdFlightDone) chrome.storage.local.set({ jdFlightDone: true });
      tabEl.classList.remove("jd-preflight");
      tabEl.classList.add("jd-tab-reveal");
      maybeCoachMark();
    });
    // Report what this browser already sees, then load community data.
    send({ type: "report", data: product });
    await refreshAll();
  });

  // ---------- Onboarding ----------

  // First contact: a small coach mark pointing at the tab.
  async function maybeCoachMark() {
    const { jdCoachDone } = await chrome.storage.local.get("jdCoachDone");
    if (jdCoachDone || !tabEl) return;
    const mark = el("div", "jd-coach");
    mark.append(
      el("div", "jd-coach-title", "Price history lives here"),
      el("div", "jd-coach-body", "Real prices, seen by real shoppers. Open the tab to see this product's story."),
    );
    const ok = el("button", "jd-coach-btn", "Got it");
    mark.append(ok);
    uiRoot.append(mark);
    const place = () => {
      const r = tabEl.getBoundingClientRect();
      mark.style.left = r.right + window.scrollX + 12 + "px";
      mark.style.top = r.top + window.scrollY + r.height / 2 + "px";
    };
    place();
    window.addEventListener("resize", place);
    const dismiss = () => {
      mark.classList.add("jd-coach-out");
      setTimeout(() => mark.remove(), 250);
      chrome.storage.local.set({ jdCoachDone: true });
    };
    ok.addEventListener("click", dismiss);
    tabEl.addEventListener("click", dismiss, { once: true });
  }

  // First open: a three-step spotlight tour, built in our own shadow world.
  async function maybeTour() {
    const { jdTourDone } = await chrome.storage.local.get("jdTourDone");
    if (jdTourDone) return;
    const steps = [
      {
        target: () => paneEl.querySelector(".jd-chart") || paneEl,
        title: "The flock's memory",
        body: "Every point on this chart was a real shopper's visit. Hover for exact days, drag the handle below to resize, and watch the amber line for open-box steals.",
      },
      {
        target: () => tabButtons.get("discussion"),
        title: "Aisle intel",
        body: "Open-box finds, price matches, shelf reports. Your notes help the next shopper — theirs help you.",
      },
      {
        target: () => watchBtn,
        title: "Never overpay",
        body: "Set your price and close the tab. The flock keeps watching and pings you the moment someone sees it lower.",
      },
    ];
    let i = 0;
    const overlay = el("div", "jd-tour");
    const hole = el("div", "jd-tour-hole");
    const pop = el("div", "jd-tour-pop");
    overlay.append(hole, pop);

    const finish = () => {
      overlay.classList.add("jd-coach-out");
      setTimeout(() => overlay.remove(), 250);
      chrome.storage.local.set({ jdTourDone: true });
    };

    const show = () => {
      const t = steps[i].target();
      if (!t) return finish();
      const tr = t.getBoundingClientRect();
      const dr = drawerEl.getBoundingClientRect();
      const pad = 6;
      Object.assign(hole.style, {
        left: tr.left - dr.left - pad + "px",
        top: tr.top - dr.top - pad + "px",
        width: tr.width + pad * 2 + "px",
        height: tr.height + pad * 2 + "px",
      });
      pop.textContent = "";
      pop.append(el("div", "jd-coach-title", steps[i].title), el("div", "jd-coach-body", steps[i].body));
      const dots = el("div", "jd-tour-dots");
      steps.forEach((_, d) => dots.append(el("span", "jd-tour-dot" + (d === i ? " jd-tour-dot-on" : ""))));
      const row = el("div", "mk-form-row");
      const skip = el("button", "mk-cancel", "Skip");
      skip.addEventListener("click", finish);
      const next = el("button", "jd-coach-btn", i === steps.length - 1 ? "Done" : "Next");
      next.addEventListener("click", () => {
        i += 1;
        if (i >= steps.length) finish();
        else show();
      });
      row.append(skip, next);
      pop.append(dots, row);
      // popover below the hole when there's room, above otherwise
      const holeBottom = tr.bottom - dr.top;
      const below = holeBottom + 170 < dr.height;
      pop.style.top = below ? holeBottom + pad + 10 + "px" : "";
      pop.style.bottom = below ? "" : dr.height - (tr.top - dr.top) + pad + 10 + "px";
      pop.style.left = Math.min(Math.max(tr.left - dr.left, 16), dr.width - 296) + "px";
    };

    drawerEl.append(overlay);
    show();
  }

  async function refreshAll() {
    const [h, c] = await Promise.all([
      send({ type: "history", productId: product.productId }),
      send({ type: "comments:list", productId: product.productId }),
    ]);
    history = h && !h.error ? h.result : null;
    comments = c && !c.error && Array.isArray(c.result) ? c.result : [];
    historyLoaded = true;
    updateTabSparkline();
    if (drawerEl && drawerEl.classList.contains("jd-open")) renderActive();
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

  // A stylized jackdaw in flight, facing its direction of travel:
  // black body, grey nape, pale eye, two independently flapping wings.
  const BIRD_SVG =
    `<svg class="jd-flight-bird" viewBox="0 0 64 44" fill="none" aria-hidden="true"><g class="jd-bob">` +
    `<path class="jd-w2" d="M26 20 Q31 4 46 2 Q37 12 32 20 Z" fill="#0d1626" opacity=".85"/>` +
    `<path d="M2 20 L15 16 L15 25 L2 27 Z" fill="#1a1d23"/>` + // tail fan
    `<path d="M12 22 Q26 13 42 15 Q52 16 57 21 Q52 27 40 28 Q24 30 12 26 Z" fill="#1a1d23"/>` + // body+head
    `<path d="M55 19.5 L63 22.5 L55 24.5 Z" fill="#3d434c"/>` + // beak
    `<path d="M40 14.5 Q47 12.5 53 16 Q47 15.5 41 16.5 Z" fill="#8b95a3"/>` + // grey nape
    `<circle cx="53.5" cy="19.5" r="1.4" fill="#e8edf4"/>` + // pale eye
    `<path class="jd-w1" d="M24 21 Q32 2 54 1 Q41 13 33 21 Z" fill="#16233a"/>` +
    `</g></svg>`;

  // The jackdaw flies in and becomes the banner. Full flight on the very
  // first visit; a quick swoop afterwards. Skipped under reduced motion.
  function flightEntrance(full) {
    return new Promise((resolve) => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return resolve();
      const r = tabEl.getBoundingClientRect();
      const wrap = el("div", "jd-flight " + (full ? "jd-flight-full" : "jd-flight-mini"));
      wrap.style.left = r.left + r.width / 2 + window.scrollX + "px";
      wrap.style.top = r.top + r.height / 2 + window.scrollY + "px";
      wrap.innerHTML = BIRD_SVG;
      uiRoot.append(wrap);
      const bird = wrap.querySelector(".jd-flight-bird");
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        wrap.classList.add("jd-land");
        setTimeout(() => {
          // banner growth and bird absorption start on the same frame
          resolve();
          requestAnimationFrame(() => wrap.classList.add("jd-bird-out"));
          setTimeout(() => wrap.remove(), 320);
        }, 150);
      };
      bird.addEventListener("animationend", (e) => {
        if (e.animationName === "jd-fly") finish();
      });
      setTimeout(finish, full ? 1600 : 900); // safety net
    });
  }

  function buildTab() {
    tabEl = document.createElement("button");
    tabEl.id = "jackdaw-tab";
    tabEl.classList.add("jd-preflight"); // hidden until the bird lands
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
      uiRoot.appendChild(tabEl);
      const place = () => {
        const r = host.getBoundingClientRect();
        tabEl.style.left = r.left + window.scrollX + "px";
        tabEl.style.top = r.top + window.scrollY + r.height / 2 + "px";
      };
      place();
      window.addEventListener("resize", place);
      setTimeout(place, 800);
      setTimeout(place, 2500);
    } else {
      tabEl.classList.add("jd-tab-fixed");
      uiRoot.appendChild(tabEl);
    }
  }

  // ---------- Bottom drawer ----------

  const ICONS = {
    share: `<svg viewBox="0 0 16 16" fill="none"><path d="M8 10V2.5M8 2.5 5.2 5.3M8 2.5l2.8 2.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 8.5v4a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
    check: `<svg viewBox="0 0 16 16" fill="none"><path d="M3 8.5 6.5 12 13 4.5" stroke="#16a34a" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    sun: `<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3.2" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
    moon: `<svg viewBox="0 0 16 16" fill="none"><path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
    minimize: `<svg viewBox="0 0 16 16" fill="none"><path d="M3.5 9.5 8 13l4.5-3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 4.5 8 8l4.5-3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" opacity=".45"/></svg>`,
    expand: `<svg viewBox="0 0 16 16" fill="none"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    shrink: `<svg viewBox="0 0 16 16" fill="none"><path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5 14 2M6.5 9.5 2 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    bell: `<svg viewBox="0 0 16 16" fill="none"><path d="M8 2a4 4 0 0 0-4 4v2.4L2.8 11h10.4L12 8.4V6a4 4 0 0 0-4-4Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M6.5 13a1.6 1.6 0 0 0 3 0" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  };

  function iconBtn(svg, title) {
    const b = el("button", "jd-icon-btn");
    b.innerHTML = svg;
    b.title = title;
    b.setAttribute("aria-label", title);
    return b;
  }

  function buildDrawer() {
    drawerEl = document.createElement("div");
    drawerEl.id = "jackdaw-drawer";
    drawerEl.classList.toggle("jd-dark", theme === "dark");

    const header = el("div", "jd-header");
    const brand = el("div", "jd-brand");
    brand.innerHTML =
      `<span class="jd-live" title="Live community data"></span>` +
      `<span class="jd-wordmark">Jackdaw</span>`;
    const prodName = el("div", "jd-product-name", product.name);

    const controls = el("div", "jd-header-controls");
    controls.classList.add("jd-idle-icons");
    const expandBtn = iconBtn(ICONS.expand, "Expand");
    expandBtn.classList.add("jd-ib-expand");
    expandBtn.addEventListener("click", () => {
      const max = drawerEl.classList.toggle("jd-max");
      expandBtn.innerHTML = max ? ICONS.shrink : ICONS.expand;
      expandBtn.title = max ? "Shrink" : "Expand";
      renderLeft(); // chart re-measures to the new width
    });
    const shareBtn = iconBtn(ICONS.share, "Copy chart as image");
    shareBtn.classList.add("jd-ib-share");
    shareBtn.addEventListener("click", () => shareChart(shareBtn));
    const themeBtn = iconBtn(theme === "dark" ? ICONS.sun : ICONS.moon, theme === "dark" ? "Light mode" : "Dark mode");
    themeBtn.classList.add("jd-ib-theme");
    themeBtn.addEventListener("click", () => {
      theme = theme === "dark" ? "light" : "dark";
      chrome.storage.local.set({ jdTheme: theme });
      drawerEl.classList.toggle("jd-dark", theme === "dark");
      themeBtn.innerHTML = theme === "dark" ? ICONS.sun : ICONS.moon;
      themeBtn.title = theme === "dark" ? "Light mode" : "Dark mode";
      renderLeft(); // chart canvas re-renders with the new palette; comments stay put
    });
    watchBtn = el("button", "jd-watch");
    watchBtn.innerHTML = `${ICONS.bell}<span>Set alert</span>`;
    watchBtn.title = "Pick a price — get notified when the flock sees it";
    watchBtn.addEventListener("click", () => switchTab("alerts"));
    const minBtn = iconBtn(ICONS.minimize, "Minimize");
    minBtn.classList.add("jd-ib-min");
    minBtn.addEventListener("click", closeDrawer);
    controls.append(expandBtn, shareBtn, themeBtn, watchBtn, minBtn);
    header.append(brand, prodName, controls);

    // Tab bar with a sliding indicator (transform-only motion)
    const tabbar = el("div", "jd-tabbar");
    tabButtons = new Map();
    const tabDefs = [
      ["chart", "Price history"],
      ["discussion", "Aisle intel"],
      ["alerts", "Alerts"],
    ];
    for (const [key, label] of tabDefs) {
      const b = el("button", "jd-tab-btn");
      b.dataset.tab = key;
      b.append(el("span", "jd-tab-label", label), el("span", "jd-tab-count"));
      b.addEventListener("click", () => switchTab(key));
      tabButtons.set(key, b);
      tabbar.append(b);
    }
    tabIndicator = el("span", "jd-tab-ind");
    tabbar.append(tabIndicator);

    const body = el("div", "jd-drawer-body");
    paneEl = el("div", "jd-pane");
    body.append(paneEl);
    drawerEl.append(header, tabbar, body);
    uiRoot.appendChild(drawerEl);
    window.addEventListener("resize", () => positionIndicator(false));

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && drawerEl.classList.contains("jd-open")) closeDrawer();
    });

    send({ type: "watch:status", productId: product.productId }).then((res) => {
      if (!res.error) setWatching(res.result.watching, res.result.target);
    });
  }

  function setWatching(v, target) {
    watchTarget = v ? target : null;
    watchBtn.classList.toggle("jd-watching", v);
    watchBtn.querySelector("span").textContent = v && target != null ? `Alert at ${fmtPrice(target)}` : "Set alert";
    if (tabButtons) updateTabChrome(); // async status arrives after first paint
  }

  // ---------- Tabs ----------

  function switchTab(key) {
    if (!drawerEl.classList.contains("jd-open")) openDrawer();
    if (activeTab === key) return;
    activeTab = key;
    positionIndicator(true);
    paneEl.classList.remove("jd-pane-enter");
    void paneEl.offsetWidth;
    paneEl.classList.add("jd-pane-enter");
    renderActive();
  }

  function positionIndicator(animate) {
    const btn = tabButtons && tabButtons.get(activeTab);
    if (!btn || !tabIndicator) return;
    if (!animate) tabIndicator.style.transition = "none";
    tabIndicator.style.transform = `translateX(${btn.offsetLeft}px)`;
    tabIndicator.style.width = btn.offsetWidth + "px";
    if (!animate) requestAnimationFrame(() => { tabIndicator.style.transition = ""; });
  }

  function updateTabChrome() {
    for (const [k, b] of tabButtons) {
      b.classList.toggle("jd-tab-active", k === activeTab);
      const count = b.querySelector(".jd-tab-count");
      if (k === "discussion") count.textContent = comments.length ? String(comments.length) : "";
      else if (k === "alerts") count.textContent = watchTarget != null ? "●" : "";
      else count.textContent = "";
    }
    positionIndicator(true);
  }

  function renderActive() {
    updateTabChrome();
    renderLeft();
    renderRight();
    renderAlerts();
  }

  // ---------- Alerts pane ----------

  function renderAlerts() {
    if (activeTab !== "alerts" || !paneEl) return;
    paneEl.textContent = "";
    const card = el("div", "jd-alert-card");
    card.append(el("div", "jd-popover-label", watchTarget != null ? "Alert armed" : "Notify me at or below"));

    const inputRow = el("div", "jd-popover-input");
    const dollar = el("span", "jd-popover-dollar", "$");
    const input = el("input", "mk-input jd-price-input");
    input.type = "number";
    input.min = "0.01";
    input.step = "0.01";
    input.value = (watchTarget != null ? watchTarget : Math.max(product.price - 0.01, 0.01)).toFixed(2);
    inputRow.append(dollar, input);
    card.append(inputRow);

    // Distance meter: where today's price sits relative to your target.
    if (history && history.points.length) {
      const stats = computeStats(history.points);
      card.append(el("div", "jd-popover-hint",
        `Current ${fmtPrice(product.price)} · typical ${fmtPrice(window.__jackdawChart.typicalPrice(history.points))} · all-time low ${fmtPrice(stats.lowest)}`));
      if (watchTarget != null) {
        const meter = el("div", "jd-meter");
        const span = Math.max(stats.highest - watchTarget, 0.01);
        const pos = Math.min(Math.max((product.price - watchTarget) / span, 0), 1);
        const fill = el("div", "jd-meter-fill");
        fill.style.width = ((1 - pos) * 100).toFixed(1) + "%";
        meter.append(fill);
        const gap = product.price - watchTarget;
        card.append(meter, el("div", "jd-meter-label",
          gap <= 0 ? "Target met — alert will fire on the next hourly check" : `${fmtPrice(gap)} above your target`));
      }
    }

    const row = el("div", "mk-form-row");
    if (watchTarget != null) {
      const remove = el("button", "mk-cancel", "Remove alert");
      remove.addEventListener("click", async () => {
        const res = await send({ type: "watch:toggle", productId: product.productId });
        if (res.error) toast("Couldn't remove the alert — try again");
        else {
          setWatching(false, null);
          toast("Alert removed");
          renderAlerts();
        }
      });
      row.append(remove);
    }
    const save = el("button", "mk-post", watchTarget != null ? "Update alert" : "Set alert");
    save.addEventListener("click", async () => {
      const v = parseFloat(input.value);
      if (!isFinite(v) || v <= 0) {
        input.classList.add("mk-input-nudge");
        setTimeout(() => input.classList.remove("mk-input-nudge"), 400);
        return;
      }
      save.disabled = true;
      const res = await send({ type: "watch:setTarget", productId: product.productId, targetPrice: Math.round(v * 100) / 100 });
      save.disabled = false;
      if (res.error) toast("Couldn't set the alert — try again");
      else {
        setWatching(true, res.result.target);
        toast(res.result.target >= product.price
          ? `Today's price already qualifies — you'll be pinged within the hour`
          : `Alert set — we'll ping you at ${fmtPrice(res.result.target)} or less`);
        renderAlerts();
      }
    });
    row.append(save);
    card.append(row);
    paneEl.append(card);

    paneEl.append(el("div", "mk-note",
      "One alert per product. The flock checks hourly; when any member sees the price at or below your target, you get a Chrome notification. Alerts fire once, then disarm — re-arm any time."));
  }

  function openDrawer() {
    if (!drawerEl) buildDrawer();
    const firstOpen = !everOpened;
    pendingReveal = firstOpen;
    everOpened = true;
    renderActive();
    tabEl.classList.add("jd-hidden");
    requestAnimationFrame(() => positionIndicator(false));
    if (firstOpen) setTimeout(maybeTour, 700); // after the drawer settles
    requestAnimationFrame(() => requestAnimationFrame(() => drawerEl.classList.add("jd-open")));
  }

  function closeDrawer() {
    drawerEl.classList.remove("jd-open");
    tabEl.classList.remove("jd-hidden");
  }

  function toast(msg) {
    const t = el("div", "jd-toast", msg);
    drawerEl.append(t);
    requestAnimationFrame(() => t.classList.add("jd-toast-in"));
    setTimeout(() => {
      t.classList.remove("jd-toast-in");
      setTimeout(() => t.remove(), 300);
    }, 2400);
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

  function fmtRel(ms) {
    const d = Date.now() - ms;
    if (d < 90_000) return "just now";
    if (d < 3_600_000) return Math.round(d / 60_000) + "m ago";
    if (d < 86_400_000) return Math.round(d / 3_600_000) + "h ago";
    if (d < 7 * 86_400_000) return Math.round(d / 86_400_000) + "d ago";
    return fmtDate(ms);
  }

  function renderLeft() {
    if (activeTab !== "chart" || !paneEl) return;
    const leftCol = paneEl;
    leftCol.textContent = "";
    leftCol.className = "jd-pane" + (pendingReveal ? " mk-stagger" : "");

    if (!historyLoaded) {
      // skeleton while the flock reports in
      const sk = el("div", "jd-skeleton");
      sk.append(el("div", "jd-sk-row"), el("div", "jd-sk-chip"), el("div", "jd-sk-chart"));
      leftCol.append(sk);
      return;
    }

    if (history && history.points.length) {
      const stats = computeStats(history.points);
      const atLow = product.price <= stats.lowest;
      const sightings = history.points.reduce((n, p) => n + (p.reportCount || 1), 0);

      const s = el("div", "mk-stats");
      const animateNums = pendingReveal;
      const current = stat("Current", product.price, product.inStock ? "in stock" : "out of stock", animateNums);
      if (atLow) current.classList.add("jd-at-low");
      s.append(
        current,
        stat("Lowest seen", stats.lowest, fmtDate(stats.lowestAt), animateNums),
        stat("Highest seen", stats.highest, fmtDate(stats.highestAt), animateNums),
      );
      leftCol.append(s);

      // Verdict chip: the one-line answer a shopper actually wants,
      // judged against the duration-weighted typical price.
      const typical = window.__jackdawChart.typicalPrice(history.points);
      const chips = el("div", "jd-chips");
      const chip = el("span", "jd-chip");
      if (atLow) {
        chip.classList.add("jd-chip-low");
        chip.textContent = "All-time low — as good as the flock has ever seen it";
        // Rare-moment spell: a one-time sparkle burst on first reveal only.
        if (pendingReveal && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          setTimeout(() => {
            for (let i = 0; i < 7; i++) {
              const p = el("span", "jd-spark-particle");
              p.style.setProperty("--dx", (Math.cos((i / 7) * Math.PI * 2) * (26 + Math.random() * 14)).toFixed(0) + "px");
              p.style.setProperty("--dy", (Math.sin((i / 7) * Math.PI * 2) * (18 + Math.random() * 10)).toFixed(0) + "px");
              p.style.animationDelay = (Math.random() * 90) + "ms";
              chip.appendChild(p);
              setTimeout(() => p.remove(), 900);
            }
          }, 350);
        }
      } else if (product.price <= typical * 0.97) {
        chip.classList.add("jd-chip-low");
        chip.textContent = `Good price — ${fmtPrice(typical - product.price)} below typical`;
      } else if (product.price < typical * 1.03) {
        chip.textContent = `Fair price — right around the typical ${fmtPrice(typical)}`;
      } else {
        chip.classList.add("jd-chip-high");
        chip.textContent = `${fmtPrice(product.price - typical)} above typical — patience may pay`;
      }
      chips.append(chip);

      if (sightings < 5) {
        chips.append(el("span", "jd-chip jd-chip-early", `Early data — ${sightings} sighting${sightings === 1 ? "" : "s"} so far`));
      }
      const obPoints = history.points.filter((p) => p.openBoxPrice != null);
      if (obPoints.length) {
        const cheapest = obPoints.reduce((a, b) => (a.openBoxPrice <= b.openBoxPrice ? a : b));
        chips.append(el("span", "jd-chip jd-chip-ob", `Open-box seen from ${fmtPrice(cheapest.openBoxPrice)} (${fmtDate(cheapest.lastSeenAt)})`));
      }
      leftCol.append(chips);

      leftCol.append(
        window.__jackdawChart.build(history.points, {
          reveal: pendingReveal,
          theme,
          height: chartHeight,
          onHeightChange: (h) => {
            chartHeight = h;
            chrome.storage.local.set({ jdChartH: h });
          },
        }),
      );

      const note = el("div", "mk-note");
      const first = history.points.reduce((m, p) => Math.min(m, p.firstSeenAt), Infinity);
      note.textContent = `Community-tracked since ${fmtDate(first)} · ${sightings} sighting${sightings === 1 ? "" : "s"} · store #${product.storeNum}`;
      leftCol.append(note);
    } else {
      const empty = el("div", "mk-empty");
      empty.append(
        el("div", "mk-empty-title", "No sightings yet"),
        el("div", null, "Your visit just logged today's price — the first in the flock's memory. The chart begins here."),
      );
      leftCol.append(empty);
    }
    pendingReveal = false;
  }

  function renderRight() {
    if (activeTab !== "discussion" || !paneEl) return;
    paneEl.textContent = "";
    paneEl.className = "jd-pane";
    paneEl.append(renderComments());
    updateTabChrome();
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

  // Compose chart + verdict into a PNG; copy to clipboard, download as fallback.
  async function shareChart(btn) {
    try {
      await shareChartInner(btn);
    } catch (e) {
      toast("Share failed — " + String(e && e.message ? e.message : e).slice(0, 60));
    }
  }

  async function shareChartInner(btn) {
    if (activeTab !== "chart") switchTab("chart");
    const src = paneEl && paneEl.querySelector(".jd-chart canvas");
    if (!src || !history) {
      toast("Nothing to share yet");
      return;
    }
    const dark = theme === "dark";
    const dpr = 2;
    const srcCssW = src.width / (window.devicePixelRatio || 1);
    const srcCssH = src.height / (window.devicePixelRatio || 1);
    const W = 760, H = 96 + srcCssH + 40;
    const out = document.createElement("canvas");
    out.width = W * dpr;
    out.height = H * dpr;
    const ctx = out.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.fillStyle = dark ? "#0f1726" : "#fcfbf9";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = dark ? "#e6eaf2" : "#16233a";
    ctx.font = "600 15px system-ui, sans-serif";
    ctx.fillText(product.name.slice(0, 70), 24, 34);
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillStyle = dark ? "#8b94a8" : "#6b7280";
    const typical = window.__jackdawChart.typicalPrice(history.points);
    ctx.fillText(`Current ${fmtPrice(product.price)} · typical ${fmtPrice(typical)} · Micro Center store #${product.storeNum}`, 24, 56);
    const scale = Math.min((W - 48) / srcCssW, 1);
    ctx.drawImage(src, 24, 76, srcCssW * scale, srcCssH * scale);
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = dark ? "#5b667a" : "#9aa1ab";
    ctx.fillText("Jackdaw · community price history · data from shoppers like you", 24, H - 16);

    const blob = await new Promise((r) => out.toBlob(r, "image/png"));
    let copied = false;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      copied = true;
    } catch {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `jackdaw-${product.productId}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    const old = btn.innerHTML;
    btn.innerHTML = ICONS.check;
    toast(copied ? "Chart copied to clipboard" : "Chart downloaded");
    setTimeout(() => { btn.innerHTML = old; }, 1600);
  }

  // ---------- Discussion (threaded) ----------

  function commentTree() {
    const byId = new Map(comments.map((c) => [c._id, { ...c, children: [] }]));
    const roots = [];
    for (const c of byId.values()) {
      if (c.parentId && byId.has(c.parentId)) byId.get(c.parentId).children.push(c);
      else roots.push(c);
    }
    return roots;
  }

  function countReplies(c) {
    return c.children.reduce((n, ch) => n + 1 + countReplies(ch), 0);
  }

  function renderComments() {
    const sec = el("div", "mk-comments");
    const titleRow = el("div", "mk-section-head");
    titleRow.append(el("div", "mk-section-title", comments.length ? `Aisle intel (${comments.length})` : "Aisle intel"));
    if (comments.length > 1) {
      const sortWrap = el("div", "jd-sort");
      for (const s of ["top", "new"]) {
        const b = el("button", "jd-sort-btn" + (commentSort === s ? " jd-sort-active" : ""), s === "top" ? "Top" : "New");
        b.addEventListener("click", () => {
          commentSort = s;
          renderRight();
        });
        sortWrap.append(b);
      }
      titleRow.append(sortWrap);
    }
    sec.append(titleRow);

    const list = el("div", "mk-comment-list");
    const roots = commentTree();
    roots.sort(commentSort === "top" ? (a, b) => b.score - a.score : (a, b) => b._creationTime - a._creationTime);
    if (!roots.length) {
      list.append(el("div", "mk-note", "Quiet aisle. Spotted an open-box deal, a price match, or empty shelves? Leave a note for the flock."));
    }
    for (const c of roots) list.append(renderComment(c, 0));
    sec.append(list);
    sec.append(composeForm(null, "What did you see in store?", "Post"));
    return sec;
  }

  function renderComment(c, depth) {
    const wrap = el("div", "mk-thread" + (depth ? " mk-thread-nested" : ""));

    // Reddit-style collapse: clicking a collapsed row (or the thread rail)
    // toggles this comment and everything beneath it.
    if (collapsedThreads.has(c._id)) {
      const replies = countReplies(c);
      const row = el("button", "mk-comment mk-collapsed-row");
      row.innerHTML = `<span class="mk-expander">+</span><span class="mk-author">${escapeHtml(c.displayName)}</span><span class="mk-collapsed-snippet"> · ${escapeHtml(c.body.slice(0, 64))}${c.body.length > 64 ? "…" : ""}</span>${replies ? `<span class="mk-collapsed-count">${replies} repl${replies === 1 ? "y" : "ies"}</span>` : ""}`;
      row.addEventListener("click", () => {
        collapsedThreads.delete(c._id);
        renderRight();
      });
      wrap.append(row);
      return wrap;
    }

    // Hidden by community reports: placeholder keeps thread structure intact.
    if (c.hidden) {
      const ph = el("div", "mk-comment mk-hidden-row", "Hidden by the community");
      wrap.append(ph);
      const kidsH = c.children.slice().sort((a, b) => a._creationTime - b._creationTime);
      for (const child of kidsH) wrap.append(renderComment(child, depth + 1));
      return wrap;
    }

    const row = el("div", "mk-comment");
    // The whole row collapses the thread — except interactive elements and
    // real text selections (so copying a comment never collapses it).
    row.addEventListener("click", (e) => {
      if (e.target.closest("button, textarea, input, a")) return;
      if (String(window.getSelection() || "").length) return;
      collapsedThreads.add(c._id);
      renderRight();
    });
    row.classList.add("mk-collapsible");
    const rail = el("button", "mk-rail");
    rail.title = "Collapse thread";
    rail.setAttribute("aria-label", "Collapse thread");
    rail.addEventListener("click", () => {
      collapsedThreads.add(c._id);
      renderRight();
    });

    const voteBox = el("div", "mk-votes");
    const up = el("button", "mk-vote-btn" + (c.myVote === 1 ? " mk-active-up" : ""), "▲");
    up.setAttribute("aria-label", "Upvote");
    const score = el("div", "mk-score", String(c.score));
    const down = el("button", "mk-vote-btn" + (c.myVote === -1 ? " mk-active-down" : ""), "▼");
    down.setAttribute("aria-label", "Downvote");
    // Votes patch the row in place — the chart never re-renders for a vote.
    const applyVote = async (value) => {
      const res = await send({ type: "comments:vote", commentId: c._id, value });
      if (res.error) {
        toast("Vote didn't stick — try again");
        return;
      }
      c.score = res.result.score;
      c.myVote = value;
      score.textContent = String(c.score);
      up.classList.toggle("mk-active-up", value === 1);
      down.classList.toggle("mk-active-down", value === -1);
      score.classList.remove("mk-pop");
      void score.offsetWidth; // restart the pop
      score.classList.add("mk-pop");
    };
    up.addEventListener("click", () => applyVote(c.myVote === 1 ? 0 : 1));
    down.addEventListener("click", () => applyVote(c.myVote === -1 ? 0 : -1));
    voteBox.append(up, score, down);

    const main = el("div", "mk-comment-main");
    const meta = el("div", "mk-comment-meta");
    const authorEl = el("span", "mk-author", c.displayName);
    authorEl.title = "Collapse thread";
    authorEl.addEventListener("click", () => {
      collapsedThreads.add(c._id);
      renderRight();
    });
    meta.append(authorEl, el("span", null, " · " + fmtRel(c._creationTime)));
    const body = el("div", "mk-comment-body", c.body);
    const actions = el("div", "mk-comment-actions");
    if (depth < 3) {
      const replyBtn = el("button", "mk-reply-btn", "Reply");
      replyBtn.addEventListener("click", () => {
        replyTo = replyTo === c._id ? null : c._id;
        renderRight();
      });
      actions.append(replyBtn);
    }
    const reportBtn = el("button", "mk-reply-btn mk-report-btn", "Report");
    reportBtn.addEventListener("click", async () => {
      const res = await send({ type: "comments:report", commentId: c._id });
      if (res.error) toast(friendlyError(res, "Couldn't report — try again"));
      else toast(res.result.alreadyReported ? "You already reported this" : "Reported — thanks for keeping the aisle clean");
    });
    actions.append(reportBtn);
    main.append(meta, body, actions);
    row.append(rail, voteBox, main);
    wrap.append(row);

    if (replyTo === c._id) {
      const form = composeForm(c._id, `Reply to ${c.displayName}…`, "Reply");
      form.classList.add("mk-reply-form");
      wrap.append(form);
    }
    const kids = c.children.slice().sort((a, b) => a._creationTime - b._creationTime);
    for (const child of kids) wrap.append(renderComment(child, depth + 1));
    return wrap;
  }

  function friendlyError(res, fallback) {
    switch (res.code) {
      case "RATE_LIMITED": return "Easy there — you're going too fast. Try again in a bit.";
      case "LINKS_NOT_ALLOWED": return "Links aren't allowed in comments";
      case "CONTACT_INFO_NOT_ALLOWED": return "Please don't post contact info";
      case "CONTENT_REJECTED": return "Keep it civil — comment rejected";
      default: return fallback;
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function composeForm(parentId, placeholder, cta) {
    const form = el("div", "mk-form");
    const nameInput = el("input", "mk-input");
    nameInput.placeholder = "Display name";
    nameInput.maxLength = 40;
    chrome.storage.local.get("displayName").then((v) => { if (v.displayName) nameInput.value = v.displayName; });
    const bodyInput = el("textarea", "mk-input mk-textarea");
    bodyInput.placeholder = placeholder;
    bodyInput.maxLength = 2000;
    const rowEl = el("div", "mk-form-row");
    const btn = el("button", "mk-post", cta);
    btn.addEventListener("click", async () => {
      const displayName = nameInput.value.trim();
      const body = bodyInput.value.trim();
      if (!displayName) { nameInput.focus(); nameInput.classList.add("mk-input-nudge"); setTimeout(() => nameInput.classList.remove("mk-input-nudge"), 400); return; }
      if (!body) { bodyInput.focus(); return; }
      btn.disabled = true;
      await chrome.storage.local.set({ displayName });
      const args = { type: "comments:add", productId: product.productId, displayName, body };
      if (parentId) args.parentId = parentId;
      const res = await send(args);
      btn.disabled = false;
      if (res.error) {
        toast(friendlyError(res, "Couldn't post — try again"));
        return;
      }
      replyTo = null;
      const c = await send({ type: "comments:list", productId: product.productId });
      comments = c && !c.error ? c.result : comments;
      renderRight();
    });
    if (parentId) {
      const cancel = el("button", "mk-cancel", "Cancel");
      cancel.addEventListener("click", () => { replyTo = null; renderRight(); });
      rowEl.append(cancel);
    }
    rowEl.append(btn);
    form.append(nameInput, bodyInput, rowEl);
    return form;
  }
})();
