// Isolated-world content script: receives product data from page-world.js,
// reports the observation, anchors a "Price history" tab to the product image,
// and opens a bottom drawer with the interactive chart + community discussion.
(() => {
  let product = null;
  let history = null;
  let comments = [];
  let historyLoaded = false;
  let historyFailed = false;
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
  // {signedIn:false} | {signedIn:true, email, handle} — never the session token,
  // which stays in the service worker. This script runs inside a page Micro
  // Center controls; it gets to know who you are, not how to prove it.
  let account = { signedIn: false };
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
  // Which triggers the armed watch fires on. `price` is the target above;
  // `openBox`/`restock` are scoped to `store`, which is the store the alert was
  // armed against and needn't be the one being browsed right now.
  let triggers = { price: true, openBox: false, restock: false, store: null };
  let commentSort = "top"; // "top" | "new"
  const collapsedThreads = new Set(); // comment _ids collapsed reddit-style

  // A content script outlives the extension that injected it. Reloading Jackdaw
  // at chrome://extensions — or Chrome auto-updating it under a shopper with
  // this tab already open — orphans this instance: the DOM stays, the closures
  // keep running, and every `chrome.*` call from that moment throws
  // "Extension context invalidated". The panel is drawn from data already in
  // memory, so it goes on LOOKING alive while nothing it does can reach the
  // service worker. `send` was already guarded; storage was not, which is how a
  // click on the comment box threw an uncaught error into Micro Center's own
  // console. Guard the whole boundary, and say so once, honestly.
  let contextLost = false;
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  function orphaned() {
    contextLost = true;
    showOrphanNotice();
  }
  // Never throws and never rejects: a dead context yields {} / a no-op, so every
  // caller reads it as "nothing stored" and carries on with its defaults.
  const store = {
    async get(keys) {
      if (!alive()) return orphaned(), {};
      try {
        return await chrome.storage.local.get(keys);
      } catch {
        return orphaned(), {};
      }
    },
    async set(obj) {
      if (!alive()) return orphaned();
      try {
        await chrome.storage.local.set(obj);
      } catch {
        orphaned();
      }
    },
  };

  const send = (msg) =>
    new Promise((resolve) => {
      if (!alive()) {
        orphaned();
        resolve({ error: "Extension context invalidated.", code: "ORPHANED" });
        return;
      }
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            const m = chrome.runtime.lastError.message || "";
            // Only the explicit wording means orphaned. "Receiving end does not
            // exist" is an asleep service worker, which the next call wakes.
            if (/context invalidated/i.test(m)) orphaned();
            resolve(contextLost ? { error: m, code: "ORPHANED" } : { error: m });
          } else resolve(res || { error: "no response" });
        });
      } catch (e) {
        orphaned();
        resolve({ error: String(e), code: "ORPHANED" });
      }
    });

  // page-world gave up finding a ProductPage dataLayer entry. On a real
  // product URL that means their markup changed — worth knowing about.
  window.addEventListener("jackdaw:nodata", () => {
    if (tabEl) return;
    if (/\/product\/\d+/.test(location.pathname)) {
      send({ type: "event", name: "no_datalayer" });
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
    try {
      await ensureRoot();
      await store.get(["jdTheme", "jdChartH"]).then((v) => {
        if (v.jdTheme === "dark") theme = "dark";
        if (v.jdChartH) chartHeight = v.jdChartH;
      });
      buildTab();
      // The bird flies in, becomes the banner, and only then does the
      // coach mark speak — one thing at a time.
      store.get("jdFlightDone").then(async ({ jdFlightDone }) => {
        try {
          await flightEntrance(!jdFlightDone);
          if (!jdFlightDone) store.set({ jdFlightDone: true });
          tabEl.classList.remove("jd-preflight");
          tabEl.classList.add("jd-tab-reveal");
          maybeCoachMark();
        } catch {
          // never let the arrival choreography strand the tab invisible
          if (tabEl) {
            tabEl.classList.remove("jd-preflight");
            tabEl.classList.add("jd-tab-reveal");
          }
          send({ type: "event", name: "panel_error" });
        }
      });
      // Report what this browser already sees, then load community data.
      send({ type: "report", data: product });
      learnStoreNames();
      await refreshAll();
      send({ type: "event", name: "panel_ok" });
    } catch (e) {
      send({ type: "event", name: "panel_error" });
    }
  });

  // ---------- Onboarding ----------

  // First contact: a small coach mark pointing at the tab.
  async function maybeCoachMark() {
    const { jdCoachDone } = await store.get("jdCoachDone");
    if (jdCoachDone || !tabEl) return;
    const mark = el("div", "jd-coach");
    mark.append(
      el("div", "jd-coach-title", "Price history lives here"),
      el("div", "jd-coach-body", "Prices seen by real shoppers. Open the tab for this product's history."),
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
      store.set({ jdCoachDone: true });
    };
    ok.addEventListener("click", dismiss);
    tabEl.addEventListener("click", dismiss, { once: true });
  }

  // First open: a three-step spotlight tour, built in our own shadow world.
  async function maybeTour() {
    const { jdTourDone } = await store.get("jdTourDone");
    if (jdTourDone) return;
    const steps = [
      {
        target: () => paneEl.querySelector(".jd-chart") || paneEl,
        title: "Price history",
        body: "Each point is a real shopper's visit. Hover for dates, drag the handle to resize. Amber marks open-box prices.",
      },
      {
        target: () => tabButtons.get("discussion"),
        title: "Aisle intel",
        body: "Open-box finds, price matches, stock reports — notes from shoppers, for shoppers.",
      },
      {
        target: () => watchBtn,
        title: "Price alerts",
        body: "Set a price. You'll get a notification when a shopper sees it lower.",
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
      store.set({ jdTourDone: true });
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
    const [h, c, a] = await Promise.all([
      // shelfStore scopes only the shelf snapshot, never the price series:
      // prices are national, the shelf is the one thing that isn't.
      send({ type: "history", productId: product.productId, shelfStore: product.storeNum }),
      send({ type: "comments:list", productId: product.productId }),
      send({ type: "auth:state" }),
    ]);
    // A failed auth check falls back to the anonymous compose form — the
    // normal state of this product, not a degraded one. The backend stays the
    // authority on who signed a comment either way.
    account = a && !a.error && a.result ? a.result : { signedIn: false };
    // A failed request and a product with no history are different things and
    // must not look the same: one offers a retry, the other invites a first visit.
    historyFailed = !!(h && h.error);
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
    if (!path || path.getAttribute("d") === d) return;
    path.setAttribute("d", d);
    // If the bird hasn't landed yet, stop here: the reveal choreography
    // will draw the (now data-true) shape itself. Restarting the draw
    // while hidden would burn the animation invisibly and leave a static
    // line at reveal time.
    if (!tabEl.classList.contains("jd-tab-reveal")) return;
    // Tab already visible: draw the new shape on in place.
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      path.style.animation = "none";
      void path.getBoundingClientRect();
      path.style.animation = "jd-spark-reveal 1.1s cubic-bezier(0.23, 1, 0.32, 1)";
      // hand control back to the stylesheet (hover redraw) afterwards
      setTimeout(() => { path.style.animation = ""; }, 1300);
    }
  }

  // ---------- Tab on the product image (left edge) ----------

  const SPARK_PATH = "M1 15 L6 15 L6 9 L11 9 L11 12 L16 12 L16 4 L21 4";

  // A stylized jackdaw in flight, facing its direction of travel:
  // black body, grey nape, pale eye, two independently flapping wings.
  // v6: pure overhead silhouette (the user's chosen reference style) —
  // bird seen from above, broad fingered wings beating with foreshortening,
  // notched fan tail, slim body with pointed head. One ink, zero fuss.
  const BIRD_SVG =
    `<svg class="jd-flight-bird" viewBox="8 2 76 96" fill="none" aria-hidden="true">` +
    `<path class="jd-w1" d="M55 46.2 Q51 38 47.5 30.5 Q44.5 23.5 40.5 15.5 L38.6 21.5 L35.2 17.5 L34.6 24 L31.6 21.5 L32 28 L29.5 26.5 Q32.5 34 36 40.5 Q38.5 44.6 40 47.8 Z" fill="#16233a"/>` +
    `<path class="jd-w2" d="M55 53.8 Q51 62 47.5 69.5 Q44.5 76.5 40.5 84.5 L38.6 78.5 L35.2 82.5 L34.6 76 L31.6 78.5 L32 72 L29.5 73.5 Q32.5 66 36 59.5 Q38.5 55.4 40 52.2 Z" fill="#16233a"/>` +
    `<path d="M31.5 47.6 L20 42.5 L21.8 45.8 L17.5 44.8 L19.6 48 L16.8 50 L19.6 52 L17.5 55.2 L21.8 54.2 L20 57.5 L31.5 52.4 Q30.6 50 31.5 47.6 Z" fill="#16233a"/>` +
    `<path d="M31 49.9 Q34 47.6 41 46.6 Q50 45.4 57 46.6 Q62.5 47.4 66.5 48.7 L74 49.9 L66.5 51.2 Q62.5 52.6 57 53.4 Q50 54.6 41 53.4 Q34 52.4 31 50.1 Z" fill="#16233a"/>` +
    `</svg>`;

  // Perched pose for the landing beat: side view, folded wing, tail flick.
  const PERCH_SVG =
    `<svg class="jd-perch" viewBox="0 0 42 50" fill="none" aria-hidden="true">` +
    `<g class="jd-perch-tail"><path d="M13.5 30.5 L4 41 L6.5 41 L4.5 44.5 L7.5 44 L6.5 47 L15.5 36.5 Q14 33.5 13.5 30.5 Z" fill="#16233a"/></g>` +
    `<path d="M21.5 4.5 Q27 2.2 30.8 5.8 Q33.6 8.6 32.4 12.4 Q31.4 15.4 28.4 17 Q30 21.5 29.4 26.5 Q28.6 32.5 25 36.8 Q22 40.2 17.8 41.2 Q14.6 41.8 12.4 40.4 Q15.2 37.2 16 32.4 Q16.8 27.6 16.2 22 Q15.6 15.8 17.8 10.8 Q19.3 7.2 21.5 4.5 Z" fill="#16233a"/>` +
    `<path d="M31.8 8 L38.5 9.8 L31.4 11.8 Q32 9.9 31.8 8 Z" fill="#16233a"/>` +
    `<path d="M17.5 41 L16.8 45.5 L18.4 45.5 L18.8 41.4 Z" fill="#16233a"/>` +
    `<path d="M21.5 41 L21.4 45.7 L23 45.6 L22.9 41.2 Z" fill="#16233a"/>` +
    `<path d="M19.5 17 Q22.5 15.5 25.5 16.5 Q27.5 22 26.8 27.5 Q26.2 32.5 23.5 36 Q21.5 33 20.5 28 Q19.5 22.5 19.5 17 Z" fill="#0d1424"/>` +
    `</svg>`;

  // A twig grows out from the image edge during the swoop — the bird
  // needs somewhere to land. Drawn-on stroke, silhouette ink.
  const BRANCH_SVG =
    `<svg class="jd-branch" viewBox="0 0 64 20" fill="none" aria-hidden="true">` +
    `<path d="M62 3.5 Q48 4.5 36 6.5 Q20 9.2 3 9.5" stroke="#16233a" stroke-width="2.6" stroke-linecap="round" pathLength="100"/>` +
    `<path d="M40 6 Q35 3.5 32 0.5" stroke="#16233a" stroke-width="1.6" stroke-linecap="round" pathLength="100"/>` +
    `<path d="M20 8.6 Q17 11.5 16 14.5" stroke="#16233a" stroke-width="1.4" stroke-linecap="round" pathLength="100"/>` +
    `</svg>`;

  // The jackdaw flies in and becomes the banner. Full flight on the very
  // first visit; a quick swoop afterwards. Skipped under reduced motion.
  function flightEntrance(full) {
    return new Promise((resolve) => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return resolve();
      const r = tabEl.getBoundingClientRect();
      const wrap = el("div", "jd-flight " + (full ? "jd-flight-full" : "jd-flight-mini"));
      wrap.style.left = r.left + r.width / 2 + window.scrollX + "px";
      wrap.style.top = r.top + r.height / 2 + window.scrollY + "px";
      wrap.innerHTML = BIRD_SVG + PERCH_SVG;
      // The shared intermediate: bird collapses into this dot, and the
      // banner grows out of it. Sibling of the wrap so the bird's exit
      // transform doesn't drag it along.
      const dot = el("span", "jd-dot");
      dot.style.left = wrap.style.left;
      dot.style.top = wrap.style.top;
      const branch = el("div", "jd-branch-wrap");
      branch.style.left = wrap.style.left;
      branch.style.top = wrap.style.top;
      branch.innerHTML = BRANCH_SVG;
      uiRoot.append(branch, wrap, dot);
      requestAnimationFrame(() => branch.classList.add("jd-branch-in"));
      const bird = wrap.querySelector(".jd-flight-bird");
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        wrap.classList.add("jd-land");
        setTimeout(() => {
          // touchdown: the flying pose swaps to a perched bird that
          // settles, flicks its tail, then collapses into the dot
          wrap.classList.add("jd-perched");
          setTimeout(() => {
            // bird and branch leave together: bird collapses into the dot
            // while the twig dissolves beneath it
            wrap.classList.add("jd-bird-out");
            branch.classList.add("jd-branch-out");
            setTimeout(() => dot.classList.add("jd-dot-in"), 60);
            setTimeout(() => {
              resolve(); // banner grows out of the dot
              requestAnimationFrame(() => {
                dot.classList.remove("jd-dot-in");
                dot.classList.add("jd-dot-out");
              });
              setTimeout(() => { wrap.remove(); dot.remove(); branch.remove(); }, 500);
            }, 430);
          }, 750);
        }, 280);
      };
      bird.addEventListener("animationend", (e) => {
        if (e.animationName === "jd-fly") finish();
      });
      setTimeout(finish, full ? 3200 : 1800); // safety net
    });
  }

  function buildTab() {
    tabEl = document.createElement("button");
    tabEl.id = "jackdaw-tab";
    tabEl.classList.add("jd-preflight"); // hidden until the bird lands
    tabEl.setAttribute("aria-label", "Price history");
    // Layered for the arrival choreography: the pill surface, the glyph,
    // and each letter are separate objects with their own entrances.
    const letters = "Price history"
      .split("")
      .map((ch, i) => `<i class="jd-l" style="--i:${i}">${ch === " " ? "&nbsp;" : ch}</i>`)
      .join("");
    tabEl.innerHTML =
      `<span class="jd-tab-bg" aria-hidden="true"></span>` +
      `<svg class="jd-spark" viewBox="0 0 22 18" fill="none" aria-hidden="true">` +
      `<path d="${SPARK_PATH}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" pathLength="100"/></svg>` +
      `<span class="jd-tab-text">${letters}</span>`;
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
    // An opened carton — flaps folded back, which is the whole point.
    openbox: `<svg viewBox="0 0 16 16" fill="none"><path d="M2.6 6.4v6.1a.9.9 0 0 0 .9.9h9a.9.9 0 0 0 .9-.9V6.4" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M2.6 6.4 4.8 4.3M13.4 6.4 11.2 4.3M6.4 6.4h3.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.8 4.3 6.6 2.6M11.2 4.3 9.4 2.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
    // A shelf refilling: an arrow returning onto a line.
    restock: `<svg viewBox="0 0 16 16" fill="none"><path d="M2.8 13.2h10.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M8 10.4V3.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M5.3 5.9 8 3.2l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    price: `<svg viewBox="0 0 16 16" fill="none"><path d="M8 2.4v11.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M10.6 5.2a2.4 2.4 0 0 0-2.4-1.3H7.4a1.9 1.9 0 0 0 0 3.8h1.2a1.9 1.9 0 0 1 0 3.8H7.6a2.4 2.4 0 0 1-2.4-1.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
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
      `<svg class="jd-flit" viewBox="8 2 76 96" fill="currentColor" aria-hidden="true">` +
      `<g class="jd-flit-wings">` +
      `<path d="M55 46.2 Q51 38 47.5 30.5 Q44.5 23.5 40.5 15.5 L38.6 21.5 L35.2 17.5 L34.6 24 L31.6 21.5 L32 28 L29.5 26.5 Q32.5 34 36 40.5 Q38.5 44.6 40 47.8 Z"/>` +
      `<path d="M55 53.8 Q51 62 47.5 69.5 Q44.5 76.5 40.5 84.5 L38.6 78.5 L35.2 82.5 L34.6 76 L31.6 78.5 L32 72 L29.5 73.5 Q32.5 66 36 59.5 Q38.5 55.4 40 52.2 Z"/>` +
      `</g>` +
      `<path d="M31.5 47.6 L20 42.5 L21.8 45.8 L17.5 44.8 L19.6 48 L16.8 50 L19.6 52 L17.5 55.2 L21.8 54.2 L20 57.5 L31.5 52.4 Q30.6 50 31.5 47.6 Z"/>` +
      `<path d="M31 49.9 Q34 47.6 41 46.6 Q50 45.4 57 46.6 Q62.5 47.4 66.5 48.7 L74 49.9 L66.5 51.2 Q62.5 52.6 57 53.4 Q50 54.6 41 53.4 Q34 52.4 31 50.1 Z"/>` +
      `</svg>` +
      `<span class="jd-wordmark">` +
      "Jackdaw".split("").map((ch, i) => `<i style="--i:${i}">${ch}</i>`).join("") +
      `</span>`;
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
      store.set({ jdTheme: theme });
      drawerEl.classList.toggle("jd-dark", theme === "dark");
      themeBtn.innerHTML = theme === "dark" ? ICONS.sun : ICONS.moon;
      themeBtn.title = theme === "dark" ? "Light mode" : "Dark mode";
      renderLeft(); // chart canvas re-renders with the new palette; comments stay put
    });
    watchBtn = el("button", "jd-watch");
    watchBtn.innerHTML = `${ICONS.bell}<span>Set alert</span>`;
    watchBtn.title = "Get notified at your price";
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
      if (!res.error) setWatching(res.result.watching, res.result.target, res.result);
    });
  }

  function setWatching(v, target, state) {
    watchTarget = v ? target : null;
    triggers = v
      ? {
          price: state ? state.alertPrice !== false : true,
          openBox: !!(state && state.alertOpenBox),
          restock: !!(state && state.alertRestock),
          // Default the store to the one being browsed, so a watch armed
          // before this feature existed offers today's store rather than none.
          store: (state && state.storeNum) || physicalStore(),
        }
      : { price: true, openBox: false, restock: false, store: physicalStore() };
    watchBtn.classList.toggle("jd-watching", v);
    watchBtn.querySelector("span").textContent =
      v && target != null && triggers.price ? `Alert at ${fmtPrice(target)}` : v ? "Alert set" : "Set alert";
    // The status round-trip can land after the alerts pane has already been
    // painted — open the drawer straight onto Alerts and every control there
    // (the target, the meter, the switches) would describe a watch that isn't
    // the one on the server. renderAlerts returns immediately off that tab.
    if (tabButtons) updateTabChrome();
    if (paneEl) renderAlerts();
  }

  // ---------- The store ----------
  //
  // Store selection is a full page navigation on Micro Center (the picker is a
  // plain ?storeID=NNN link), so the dataLayer — and therefore product.storeNum
  // — is always correct for the store on screen. Nothing needs to watch for a
  // change; the page reloads and this script runs again.

  // Numbers that name no shelf: "029" is Micro Center's "Shippable Items"
  // pseudo-store and the default for anyone who has never picked a location,
  // "000" is page-world.js's fallback for "the dataLayer didn't say".
  const NON_PHYSICAL_STORES = new Set(["029", "000"]);
  const physicalStore = () =>
    product && !NON_PHYSICAL_STORES.has(product.storeNum) ? product.storeNum : null;

  /** The current store's display name, read live from the page's own picker. */
  function currentStoreName() {
    const n = document.querySelector("#My-Store .storeName");
    const name = n && n.textContent.trim();
    return name ? name.slice(0, 40) : null;
  }

  /**
   * Every store the page's own picker names, as number → name. The picker is
   * the whole chain, not just the selected store, which is what lets an alert
   * armed at one location be named while browsing another.
   */
  let storeNames = null;
  function harvestStoreNames() {
    if (storeNames) return storeNames;
    const names = {};
    for (const node of document.querySelectorAll(".storeName")) {
      const row = node.closest("a[href*='storeid' i]") ||
        node.closest("li, div, tr")?.querySelector("a[href*='storeid' i]");
      const m = row && /[?&]storeid=(\d{1,10})/i.exec(row.getAttribute("href") || "");
      if (m) names[m[1]] = node.textContent.trim();
    }
    const here = currentStoreName();
    if (here && product) names[product.storeNum] = here;
    storeNames = names;
    return names;
  }

  /** A store's name if this page knows it, else null — never a guess. */
  const storeNameFor = (num) => harvestStoreNames()[num] || null;

  /**
   * Hand the service worker the same map, so an alert firing hours later with
   * no tab open can name the store instead of printing a number. Display only,
   * and it never leaves the browser.
   */
  function learnStoreNames() {
    const names = harvestStoreNames();
    if (Object.keys(names).length) send({ type: "stores:learn", names });
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
    card.append(el("div", "jd-popover-label",
      watchTarget == null ? "Notify me at or below"
      : triggers.price ? "Alert armed"
      : "Price target (off)"));

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
      // The meter measures a distance that only matters while the price
      // trigger is live. With it switched off the target is a saved number,
      // not a countdown — drawing the bar anyway would promise a price alert
      // that cannot fire.
      if (watchTarget != null && triggers.price) {
        const meter = el("div", "jd-meter");
        const span = Math.max(stats.highest - watchTarget, 0.01);
        const pos = Math.min(Math.max((product.price - watchTarget) / span, 0), 1);
        const fill = el("div", "jd-meter-fill");
        fill.style.width = ((1 - pos) * 100).toFixed(1) + "%";
        meter.append(fill);
        const gap = product.price - watchTarget;
        card.append(meter, el("div", "jd-meter-label",
          gap <= 0 ? "Target met — alert fires on the next check" : `${fmtPrice(gap)} above your target`));
      } else if (watchTarget != null) {
        card.append(el("div", "jd-meter-label",
          "Target saved, but the price trigger is off — switch it on below."));
      }
    }

    const row = el("div", "mk-form-row");
    if (watchTarget != null) {
      const remove = el("button", "mk-cancel", "Remove alert");
      remove.addEventListener("click", async () => {
        const res = await send({ type: "watch:toggle", productId: product.productId });
        if (res.error) toast("Couldn't remove the alert — try again");
        else {
          setWatching(false, null); // re-renders this pane
          toast("Alert removed");
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
        // Typing a target turns the price trigger back on (armOne does the same
        // server-side); any store triggers already set are left alone.
        setWatching(true, res.result.target, {
          alertPrice: true,
          alertOpenBox: triggers.openBox,
          alertRestock: triggers.restock,
          storeNum: triggers.store,
        });
        toast(res.result.target >= product.price
          ? `Current price already qualifies — you'll be notified within the hour`
          : `Alert set for ${fmtPrice(res.result.target)} or less`);
      }
    });
    row.append(save);
    card.append(row);
    paneEl.append(card);

    renderStoreTriggers();

    paneEl.append(el("div", "mk-note",
      "One alert per product, checked hourly against what other shoppers have seen. Alerts fire once — re-arm any time."));
  }

  // ---------- Store triggers ----------
  //
  // Everything below reports SIGHTINGS, not inventory. Jackdaw learns a store's
  // stock only when somebody with the extension loads that store's page, so the
  // copy here never says "available" — it says what was seen and when, and the
  // notification repeats the age. An open-box unit is one physical item; the
  // difference between "there is one" and "somebody saw one" is a wasted drive.

  /** A labelled switch row. Returns the row; `input` is the checkbox inside. */
  function switchRow(icon, label, hint, checked, disabled, onChange) {
    const rowEl = el("label", "jd-switch-row" + (disabled ? " jd-switch-off" : ""));
    const ic = el("span", "jd-switch-icon");
    ic.innerHTML = icon;
    const text = el("span", "jd-switch-text");
    text.append(el("span", "jd-switch-label", label), el("span", "jd-switch-hint", hint));
    const input = el("input", "jd-switch-input");
    input.type = "checkbox";
    input.checked = checked;
    input.disabled = disabled;
    const track = el("span", "jd-switch-track");
    track.append(el("span", "jd-switch-thumb"));
    input.addEventListener("change", () => onChange(input.checked, input));
    rowEl.append(ic, text, input, track);
    return rowEl;
  }

  function renderStoreTriggers() {
    const card = el("div", "jd-alert-card jd-store-card");
    const storeName = currentStoreName();
    const here = physicalStore();
    // The alert's store, which may not be the one being browsed — someone can
    // arm at Westmont and later open the same product while set to Shippable.
    const armedAt = triggers.store;
    const targetStore = armedAt || here;

    card.append(el("div", "jd-popover-label",
      targetStore && targetStore !== here && storeName
        ? "At your alert's store"
        : "At this store"));

    // No physical store to scope to. Micro Center defaults everyone to
    // "Shippable Items" (029), which has no shelves — so there is nothing
    // truthful to offer until a location is picked, and saying why beats
    // showing two switches that could never fire.
    if (!targetStore) {
      card.append(el("div", "jd-store-empty",
        `You're browsing ${storeName || "Shippable Items"}, which has no shelves. ` +
        "Pick a Micro Center location with the store selector at the top of this page, " +
        "then come back — open-box and back-in-stock alerts are per store."));
      paneEl.append(card);
      return;
    }

    // The picker on this page names every store, so an alert armed elsewhere
    // still reads as a place. The number is the fallback, never the guess.
    const label =
      (targetStore === here ? storeName : null) ||
      storeNameFor(targetStore) ||
      `store #${targetStore}`;
    card.append(el("div", "jd-store-name", label));

    const armed = watchTarget != null;
    const disabled = !armed;

    const commit = async (next, input) => {
      const res = await send({
        type: "watch:setTriggers",
        productId: product.productId,
        storeNum: targetStore,
        price: next.price,
        openBox: next.openBox,
        restock: next.restock,
      });
      if (res.error || !res.result.ok) {
        // Put the switch back where the person left it: a control that stays
        // flipped after a failed save is a lie about the alert's state.
        if (input) input.checked = !input.checked;
        const reason = res.result && res.result.reason;
        toast(
          reason === "NOT_WATCHING" ? "Set an alert first, then choose what it watches for"
          : reason === "NOT_A_STORE" ? "That store has no shelves — pick a Micro Center location"
          : reason === "NO_TRIGGERS" ? "An alert needs at least one thing to watch for"
          : "Couldn't save that — try again",
        );
        return false;
      }
      triggers = { ...triggers, ...next, store: targetStore };
      renderAlerts();
      return true;
    };

    card.append(
      switchRow(ICONS.openbox, "Open box appears",
        "One unit, one store. We'll tell you what was seen and when — it may already be gone.",
        triggers.openBox, disabled,
        (on, input) => commit({ ...triggers, openBox: on }, input)),
      switchRow(ICONS.restock, "Back in stock",
        "Fires on the change from out-of-stock to in-stock. Stock isn't held for you.",
        triggers.restock, disabled,
        (on, input) => commit({ ...triggers, restock: on }, input)),
      switchRow(ICONS.price, "Price target",
        armed && watchTarget != null
          ? `Any store, at or below ${fmtPrice(watchTarget)}.`
          : "Any store, at or below your target.",
        triggers.price, disabled,
        (on, input) => commit({ ...triggers, price: on }, input)),
    );

    if (disabled) {
      card.append(el("div", "jd-store-empty", "Set an alert above to choose what it watches for."));
    }
    paneEl.append(card);
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
    showOrphanNotice(); // no-op unless the context died before this drawer existed
  }

  function closeDrawer() {
    drawerEl.classList.remove("jd-open");
    // The bird brings the banner back: hold the tab hidden while the
    // drawer descends, then replay the mini swoop + construction.
    tabEl.classList.remove("jd-hidden");
    tabEl.classList.remove("jd-tab-reveal");
    tabEl.classList.add("jd-preflight");
    setTimeout(() => {
      flightEntrance(false).then(() => {
        tabEl.classList.remove("jd-preflight");
        void tabEl.offsetWidth; // retrigger the reveal choreography
        tabEl.classList.add("jd-tab-reveal");
      });
    }, 300);
  }

  // The orphan notice is not a toast. A toast times out, and this condition
  // never does — it lasts until the page is refreshed. It is also deliberately
  // idempotent and re-checked on every drawer open, because the context can die
  // before the drawer exists: firing once into a null drawer and setting the
  // flag would consume the only warning the shopper was going to get.
  function showOrphanNotice() {
    if (!contextLost || !drawerEl) return;
    if (drawerEl.querySelector(".jd-toast-orphan")) return;
    const t = el("div", "jd-toast jd-toast-orphan", "Jackdaw updated — refresh the page to reconnect");
    drawerEl.append(t);
    requestAnimationFrame(() => t.classList.add("jd-toast-in"));
  }

  function toast(msg) {
    // Once the context is gone the notice above is on screen and every other
    // message is advice that cannot work — "try again" can only ever fail.
    if (!drawerEl || contextLost) return;
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

  // Micro Center prints "$15,299.99"; every price string in Jackdaw matches it.
  // Note this is display only — the target input at the top of the panel keeps
  // toFixed, because a comma in a `type=number` field is not a valid value.
  function fmtPrice(p) {
    return "$" + p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
      // skeleton while data loads
      const sk = el("div", "jd-skeleton");
      sk.append(el("div", "jd-sk-row"), el("div", "jd-sk-chip"), el("div", "jd-sk-chart"));
      leftCol.append(sk);
      return;
    }

    if (history && history.points.length) {
      const stats = computeStats(history.points);
      // The sparkle and the "all-time low" chip are the product's loudest
      // claim, so they wait for corroboration. A provisional low still shows
      // as a number — it just doesn't get celebrated.
      const atLow = product.price <= stats.lowest && !stats.provisional;
      const sightings = history.points.reduce((n, p) => n + (p.reportCount || 1), 0);

      const s = el("div", "mk-stats");
      const animateNums = pendingReveal;
      const current = stat("Current", product.price, product.inStock ? "in stock" : "out of stock", animateNums);
      if (atLow) current.classList.add("jd-at-low");
      s.append(
        current,
        // "seen once" rather than a date, when that is the whole of the
        // evidence — the date would read as a record established on that day.
        stat("Lowest seen", stats.lowest,
          stats.provisional ? "seen once" : fmtDate(stats.lowestAt), animateNums),
        stat("Highest seen", stats.highest,
          stats.provisional ? "seen once" : fmtDate(stats.highestAt), animateNums),
      );
      leftCol.append(s);

      // Verdict chip: the one-line answer a shopper actually wants,
      // judged against the duration-weighted typical price.
      const typical = window.__jackdawChart.typicalPrice(history.points);
      const chips = el("div", "jd-chips");
      // Condition leads, because it changes what every number after it means: a
      // used unit's history is not comparable to a new one's, and a verdict read
      // before that qualifier has already been read wrong. It costs nothing in
      // the common case — almost no product carries it.
      if (history.product && history.product.condition === "refurbished") {
        chips.append(el("span", "jd-chip", "Refurbished"));
      }
      const chip = el("span", "jd-chip");
      if (atLow) {
        chip.classList.add("jd-chip-low");
        chip.textContent = "All-time low";
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
        chip.textContent = `Fair price — near the typical ${fmtPrice(typical)}`;
      } else {
        chip.classList.add("jd-chip-high");
        chip.textContent = `${fmtPrice(product.price - typical)} above typical`;
      }
      chips.append(chip);

      if (sightings < 5) {
        chips.append(el("span", "jd-chip jd-chip-early", `Early data — ${sightings} sighting${sightings === 1 ? "" : "s"}`));
      }
      // The retailer's own "Original price", relayed as theirs. "Advertised" is
      // load-bearing: we never observed a shelf price of $799.99, we saw a
      // struck-out figure beside a discount, and a chip reading "Was $799.99"
      // would claim a measurement we do not hold.
      //
      // Live only — read off the NEWEST point rather than the cheapest or the
      // most common, because a promotion that ended is not a fact about the
      // price today, and the chart is where an ended one belongs. The
      // carry-forward on both write paths is what makes the newest point a fair
      // test: a product-page visit cannot blank the field, so an absent
      // listPrice here means a grid card actually saw no discount.
      const newest = history.points.reduce((a, b) => (a.lastSeenAt >= b.lastSeenAt ? a : b));
      if (newest.listPrice != null) {
        // How long this same figure has been standing, and the single most
        // useful thing Jackdaw can say about a discount: a "sale" price that
        // has not moved in two months is not a sale, it is the price. Nothing
        // else in the product can make that claim — it needs the retailer's own
        // advertised figure timestamped across visits, which is exactly what
        // `listPrice` on the price series is.
        //
        // Walk back from the newest point while the advertised figure is the
        // same, and remember WHY the walk ended, because that decides whether
        // the number is exact or a floor:
        //
        //   a different figure    the promotion demonstrably started after that
        //                         point. The run is exact.
        //   a null figure         either a card that saw no discount, or a row
        //                         written before this field existed — and from
        //                         here those are indistinguishable. Floor.
        //   ran out of points     the run reaches the oldest reading we hold and
        //                         may well predate it. Floor.
        //
        // A floor is marked "63+ days", the same idiom the shelf uses for "25+".
        // Without it a product first seen last Tuesday would read "unchanged 6
        // days" and quietly imply we looked on the seventh.
        const desc = history.points.slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt);
        let since = newest.firstSeenAt;
        let atLeast = true;
        for (const p of desc) {
          if (p.listPrice != null && Math.abs(p.listPrice - newest.listPrice) > 0.01) {
            atLeast = false;
            break;
          }
          if (p.listPrice == null) break;
          since = Math.min(since, p.firstSeenAt);
        }
        const days = Math.floor((newest.lastSeenAt - since) / 86_400_000);
        // Under a day there is nothing to report: every reading is from today,
        // and "unchanged 0 days" is noise dressed as information.
        const run =
          days >= 1
            ? ` · unchanged ${days}${atLeast ? "+" : ""} ${days === 1 && !atLeast ? "day" : "days"}`
            : "";
        chips.append(
          el("span", "jd-chip", `Advertised list: ${fmtPrice(newest.listPrice)}${run}`),
        );
      }
      // This store's open-box reading, resolved BEFORE the historical chip
      // below so that chip can stand down when it would only repeat the number.
      // The count comes off a grid card and the price off the same card in the
      // same write, so the store's newest open-box point is the price that
      // count was standing beside. Taken by max lastSeenAt rather than by
      // position, because `points` is not ordered by contract.
      let shelfOb = null;
      if (history.shelf && history.shelf.openBoxUnits != null) {
        const here = history.points.filter(
          (p) => p.storeNum === history.shelf.storeNum && p.openBoxPrice != null,
        );
        if (here.length) shelfOb = here.reduce((a, b) => (a.lastSeenAt >= b.lastSeenAt ? a : b));
      }

      const obPoints = history.points.filter((p) => p.openBoxPrice != null);
      if (obPoints.length) {
        const cheapest = obPoints.reduce((a, b) => (a.openBoxPrice <= b.openBoxPrice ? a : b));
        // Two amber chips carrying the same figure is noise, and on sparse data
        // it is the DEFAULT rather than an edge case: the first open-box price a
        // product ever gets is simultaneously the cheapest ever seen and the one
        // sitting on the shelf right now. Where they agree the store chip
        // strictly dominates — same price, plus where, how many, and how fresh —
        // so the historical one stands down and speaks only when it has a
        // genuinely different number. It can only ever be the LOWER of the two
        // (`cheapest` is a minimum over every point including this store's own),
        // so what survives the test always reads as "it has been cheaper".
        if (!shelfOb || Math.abs(shelfOb.openBoxPrice - cheapest.openBoxPrice) > 0.01) {
          chips.append(el("span", "jd-chip jd-chip-ob", `Open-box seen from ${fmtPrice(cheapest.openBoxPrice)} (${fmtDate(cheapest.lastSeenAt)})`));
        }
      }
      // What was on the shelf at this store the last time anyone's screen
      // showed it — the count comes off a catalog card, so it is a sighting
      // with an age, never a live inventory read. "Last seen" is the whole
      // wording: Micro Center's own page is the authority on what is there
      // now, and this says what somebody saw and when, which is a different
      // and honestly answerable question. "25+" stays a floor, not a count.
      if (history.shelf && history.shelf.inStock && history.shelf.units != null) {
        const where = storeNameFor(history.shelf.storeNum) || `store #${history.shelf.storeNum}`;
        const n = history.shelf.units + (history.shelf.atLeast ? "+" : "");
        chips.append(
          el("span", "jd-chip", `Last seen: ${n} at ${where} · ${fmtRel(history.shelf.observedAt)}`),
        );
      }
      // How many used units one store had and what the cheapest of them cost —
      // the actionable open-box fact, where the chip above is a historical one.
      // It carries its own age because a shelf reading is a sighting, not a
      // live count, exactly like the "Last seen" chip beside it.
      if (shelfOb) {
        const where = storeNameFor(history.shelf.storeNum) || `store #${history.shelf.storeNum}`;
        chips.append(
          el(
            "span",
            "jd-chip jd-chip-ob",
            `Open box at ${where}: ${history.shelf.openBoxUnits} from ${fmtPrice(shelfOb.openBoxPrice)} · ${fmtRel(history.shelf.observedAt)}`,
          ),
        );
      }
      leftCol.append(chips);

      leftCol.append(
        window.__jackdawChart.build(history.points, {
          reveal: pendingReveal,
          theme,
          height: chartHeight,
          onHeightChange: (h) => {
            chartHeight = h;
            store.set({ jdChartH: h });
          },
        }),
      );

      const note = el("div", "mk-note");
      const first = history.points.reduce((m, p) => Math.min(m, p.firstSeenAt), Infinity);
      note.textContent = `Community-tracked since ${fmtDate(first)} · ${sightings} sighting${sightings === 1 ? "" : "s"} · store #${product.storeNum}`;
      leftCol.append(note);
    } else if (historyFailed) {
      const failed = el("div", "mk-empty mk-failed");
      failed.append(
        el("div", "mk-empty-title", "Couldn't load price history"),
        el("div", null, "The connection didn't go through. Your visit was still recorded."),
      );
      const retry = el("button", "mk-post mk-retry", "Try again");
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        retry.textContent = "Loading…";
        await refreshAll();
        renderActive();
      });
      failed.append(retry);
      leftCol.append(failed);
    } else {
      const empty = el("div", "mk-empty");
      empty.append(
        el("div", "mk-empty-title", "No sightings yet"),
        el("div", null, "Your visit logged today's price — the first on record."),
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

  // Mirrors the corroboration rule in convex/products.ts. It has to live here
  // too because this panel computes its own stats from `points` rather than
  // reading the ones the query returns — and this is the copy that decides
  // whether the all-time-low sparkle fires, which is the loudest claim the
  // product makes about a number.
  //
  // A price seen once, on one grid card, is the thinnest evidence we hold: the
  // card also shows a member price, a bundle total and a $x/mo financing
  // figure, and the write-path clamp admits anything down to 0.2x. So it never
  // NAMES the record — it still plots, it just waits to be confirmed by a
  // second sighting (reportCount > 1) or a product-page reading. When there is
  // nothing corroborated at all, its own evidence stands and `provisional`
  // marks it, because reporting no low for a product we have genuinely seen
  // would be its own kind of wrong.
  function computeStats(points) {
    let lowest = Infinity, highest = -Infinity, lowestAt = 0, highestAt = 0;
    let anyLowest = Infinity, anyHighest = -Infinity, anyLowestAt = 0, anyHighestAt = 0;
    for (const p of points) {
      if (p.price < anyLowest) { anyLowest = p.price; anyLowestAt = p.firstSeenAt; }
      if (p.price > anyHighest) { anyHighest = p.price; anyHighestAt = p.firstSeenAt; }
      // `source` is absent on responses from a backend older than the
      // corroboration change; treating absent as "not catalog" keeps those
      // deployments behaving exactly as they did instead of silently
      // discarding every point.
      if (p.reportCount > 1 || p.source !== "catalog") {
        if (p.price < lowest) { lowest = p.price; lowestAt = p.firstSeenAt; }
        if (p.price > highest) { highest = p.price; highestAt = p.firstSeenAt; }
      }
    }
    const provisional = lowest === Infinity && anyLowest !== Infinity;
    if (provisional) {
      return {
        lowest: anyLowest, highest: anyHighest,
        lowestAt: anyLowestAt, highestAt: anyHighestAt, provisional: true,
      };
    }
    return { lowest, highest, lowestAt, highestAt, provisional: false };
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
    ctx.fillText("Jackdaw · community price history", 24, H - 16);

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
      list.append(el("div", "mk-note", "No notes yet. Seen an open-box deal, price match, or empty shelf? Post it."));
    }
    for (const c of roots) list.append(renderComment(c, 0));
    sec.append(list);
    sec.append(composeForm(null, "What did you see in store?", "Post"));
    return sec;
  }

  // The verified mark. A bare check, not a filled badge: at 11px a badge reads
  // as a notification dot, and this has to sit inside a line of meta text
  // without shouting. Only a claimed handle earns it — a tick beside a name
  // anyone can type would be worse than no tick at all.
  const VERIFIED_MARK =
    '<svg class="mk-verified" viewBox="0 0 12 12" role="img">' +
    "<title>Verified — a claimed handle</title>" +
    '<path d="M2.4 6.3 4.8 8.6 9.6 3.5" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const HANDLE_REASONS = {
    TAKEN: "That handle is taken.",
    RESERVED: "That handle is reserved.",
    // INVALID covers two refusals the backend deliberately doesn't separate:
    // the wrong shape, and a word the content filter won't allow. So this
    // leads with the refusal — true either way — and gives the shape after,
    // rather than reciting character rules at someone whose handle was the
    // right shape all along.
    INVALID:
      "That handle can't be used. Handles are 3–20 characters — letters, numbers, - and _ — starting and ending with a letter or number.",
    NO_SESSION: "Open the Jackdaw toolbar icon to sign in first.",
  };

  // Refusals that are about the typed name and nothing else. They go inline on
  // the name field rather than into a toast: the fix is to change that one
  // input, and a toast floating over the panel points at nothing.
  const NAME_REFUSALS = {
    NAME_CLAIMED: "Someone has claimed that name. Pick another, or sign in to claim your own.",
    NAME_RESERVED: "That name is reserved. Pick another.",
  };

  function renderComment(c, depth) {
    const wrap = el("div", "mk-thread" + (depth ? " mk-thread-nested" : ""));

    // Reddit-style collapse: clicking a collapsed row (or the thread rail)
    // toggles this comment and everything beneath it.
    if (collapsedThreads.has(c._id)) {
      const replies = countReplies(c);
      const row = el("button", "mk-comment mk-collapsed-row");
      row.innerHTML = `<span class="mk-expander">+</span><span class="mk-author">${escapeHtml(c.displayName)}</span>${c.verified ? VERIFIED_MARK : ""}<span class="mk-collapsed-snippet"> · ${escapeHtml(c.body.slice(0, 64))}${c.body.length > 64 ? "…" : ""}</span>${replies ? `<span class="mk-collapsed-count">${replies} repl${replies === 1 ? "y" : "ies"}</span>` : ""}`;
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
        toast("Vote failed — try again");
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
    meta.append(authorEl);
    if (c.verified) meta.insertAdjacentHTML("beforeend", VERIFIED_MARK);
    meta.append(el("span", null, " · " + fmtRel(c._creationTime)));
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
      else toast(res.result.alreadyReported ? "You already reported this" : "Reported");
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
      case "RATE_LIMITED": return "Too many requests — try again shortly.";
      case "LINKS_NOT_ALLOWED": return "Links aren't allowed in comments";
      case "CONTACT_INFO_NOT_ALLOWED": return "Contact info isn't allowed";
      case "CONTENT_REJECTED": return "Keep it civil — comment rejected";
      case "NAME_CLAIMED": return "Someone has claimed that name — pick another";
      case "NAME_RESERVED": return "That name is reserved — pick another";
      case "NEED_HANDLE": return "Pick a handle first";
      case "ORPHANED": return "Jackdaw updated — refresh the page to reconnect";
      default: return fallback;
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function composeForm(parentId, placeholder, cta) {
    const form = el("div", "mk-form");
    const signedIn = !!account.signedIn;

    // Who this comment gets signed as, settled before a word is typed. Three
    // states, and only one of them is an editable name: an account with a
    // handle posts as that handle, an account without one claims it here on
    // the way to its first comment, and everyone else keeps the free-text name
    // this product has always had.
    let nameInput = null; // anonymous — the display name
    let handleInput = null; // signed in, unclaimed — the handle being claimed
    const errEl = el("div", "mk-form-error");
    errEl.hidden = true;

    if (signedIn && account.handle) {
      const who = el("div", "mk-as");
      who.append(el("span", "mk-as-label", "Posting as"), el("span", "mk-as-handle", account.handle));
      who.insertAdjacentHTML("beforeend", VERIFIED_MARK);
      form.append(who);
    } else if (signedIn) {
      form.append(
        el("div", "mk-as-hint", "Pick a handle — it's permanent, it's yours alone, and your comments carry a verified mark."),
      );
      handleInput = el("input", "mk-input");
      handleInput.placeholder = "handle";
      handleInput.maxLength = 20;
      handleInput.autocapitalize = "off";
      handleInput.spellcheck = false;
      form.append(handleInput, errEl);
    } else {
      nameInput = el("input", "mk-input");
      nameInput.placeholder = "Display name";
      nameInput.maxLength = 40;
      store.get("displayName").then((v) => { if (v.displayName) nameInput.value = v.displayName; });
      form.append(nameInput, errEl);
    }

    const bodyInput = el("textarea", "mk-input mk-textarea");
    bodyInput.placeholder = placeholder;
    bodyInput.maxLength = 2000;
    const rowEl = el("div", "mk-form-row");
    const btn = el("button", "mk-post", cta);

    const nudge = (input) => {
      input.focus();
      input.classList.add("mk-input-nudge");
      setTimeout(() => input.classList.remove("mk-input-nudge"), 400);
    };
    const fail = (input, message) => {
      errEl.textContent = message;
      errEl.hidden = false;
      nudge(input);
    };

    btn.addEventListener("click", async () => {
      errEl.hidden = true;
      const body = bodyInput.value.trim();
      if (handleInput && !handleInput.value.trim()) return nudge(handleInput);
      if (nameInput && !nameInput.value.trim()) return nudge(nameInput);
      if (!body) { bodyInput.focus(); return; }

      btn.disabled = true;
      try {
        // The claim runs first and separately, so a refused handle costs
        // nothing but the handle: the typed comment stays on screen.
        if (handleInput) {
          const claim = await send({ type: "auth:claimHandle", handle: handleInput.value.trim() });
          if (claim.error) return fail(handleInput, friendlyError(claim, "Couldn't set that handle — try again"));
          if (!claim.result.ok) {
            // LOCKED means this form was drawn against stale state — the
            // account already has a handle. Re-read rather than explain.
            if (claim.result.reason === "LOCKED") {
              const a = await send({ type: "auth:state" });
              if (a && !a.error && a.result) account = a.result;
              renderRight();
              return;
            }
            return fail(handleInput, HANDLE_REASONS[claim.result.reason] || "That handle can't be used.");
          }
          account = { ...account, handle: claim.result.handle };
        }

        const displayName = nameInput ? nameInput.value.trim() : account.handle;
        if (nameInput) await store.set({ displayName });
        const args = { type: "comments:add", productId: product.productId, displayName, body };
        if (parentId) args.parentId = parentId;
        const res = await send(args);
        if (res.error) {
          if (res.code === "NEED_HANDLE") {
            account = { ...account, handle: null };
            toast("Pick a handle first");
            renderRight();
            return;
          }
          if (nameInput && NAME_REFUSALS[res.code]) {
            return fail(nameInput, NAME_REFUSALS[res.code]);
          }
          toast(friendlyError(res, "Couldn't post — try again"));
          return;
        }
        replyTo = null;
        const c = await send({ type: "comments:list", productId: product.productId });
        comments = c && !c.error ? c.result : comments;
        renderRight();
      } finally {
        btn.disabled = false;
      }
    });

    if (parentId) {
      const cancel = el("button", "mk-cancel", "Cancel");
      cancel.addEventListener("click", () => { replyTo = null; renderRight(); });
      rowEl.append(cancel);
    }
    rowEl.append(btn);
    form.append(bodyInput, rowEl);
    return form;
  }
})();
