// Toolbar popup: the watchlist at a glance — every product you're tracking,
// where its price sits against your target, and its trend.
(() => {
  const bodyEl = document.getElementById("body");
  const countEl = document.getElementById("count");
  const themeBtn = document.getElementById("theme");

  const ICONS = {
    sun: `<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3.2" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
    moon: `<svg viewBox="0 0 16 16" fill="none"><path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
  };

  // The overhead silhouette, reused from the arrival — one bird, one brand.
  const BIRD =
    `<svg class="pop-empty-bird" viewBox="8 2 76 96" fill="none" aria-hidden="true">` +
    `<path d="M55 46.2 Q51 38 47.5 30.5 Q44.5 23.5 40.5 15.5 L38.6 21.5 L35.2 17.5 L34.6 24 L31.6 21.5 L32 28 L29.5 26.5 Q32.5 34 36 40.5 Q38.5 44.6 40 47.8 Z"/>` +
    `<path d="M55 53.8 Q51 62 47.5 69.5 Q44.5 76.5 40.5 84.5 L38.6 78.5 L35.2 82.5 L34.6 76 L31.6 78.5 L32 72 L29.5 73.5 Q32.5 66 36 59.5 Q38.5 55.4 40 52.2 Z"/>` +
    `<path d="M31.5 47.6 L20 42.5 L21.8 45.8 L17.5 44.8 L19.6 48 L16.8 50 L19.6 52 L17.5 55.2 L21.8 54.2 L20 57.5 L31.5 52.4 Q30.6 50 31.5 47.6 Z"/>` +
    `<path d="M31 49.9 Q34 47.6 41 46.6 Q50 45.4 57 46.6 Q62.5 47.4 66.5 48.7 L74 49.9 L66.5 51.2 Q62.5 52.6 57 53.4 Q50 54.6 41 53.4 Q34 52.4 31 50.1 Z"/>` +
    `</svg>`;

  const fmt = (p) => "$" + p.toFixed(2);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const send = (msg) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
        else resolve(res || { error: "no response" });
      });
    });

  // ---------- Theme ----------

  chrome.storage.local.get("jdTheme").then(({ jdTheme }) => setTheme(jdTheme === "dark"));
  function setTheme(dark) {
    document.body.classList.toggle("dark", dark);
    themeBtn.innerHTML = dark ? ICONS.sun : ICONS.moon;
    themeBtn.title = dark ? "Light mode" : "Dark mode";
  }
  themeBtn.addEventListener("click", () => {
    const dark = !document.body.classList.contains("dark");
    setTheme(dark);
    chrome.storage.local.set({ jdTheme: dark ? "dark" : "light" });
  });

  // ---------- Sparkline ----------

  function sparkline(trend) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "pop-spark");
    svg.setAttribute("viewBox", "0 0 74 24");
    if (!trend || trend.length < 2) return svg;
    let lo = Infinity, hi = -Infinity;
    for (const v of trend) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const span = Math.max(hi - lo, 0.01);
    const x = (i) => 2 + (i / (trend.length - 1)) * 70;
    const y = (v) => 21 - ((v - lo) / span) * 18;
    let d = `M${x(0).toFixed(1)} ${y(trend[0]).toFixed(1)}`;
    for (let i = 1; i < trend.length; i++) {
      d += ` L${x(i).toFixed(1)} ${y(trend[i]).toFixed(1)}`;
    }
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("class", "spark-draw");
    path.setAttribute("pathLength", "100");
    svg.append(path);
    return svg;
  }

  // ---------- Render ----------

  function renderEmpty() {
    bodyEl.textContent = "";
    const wrap = el("div", "pop-empty");
    wrap.innerHTML = BIRD;
    wrap.append(
      el("div", "pop-empty-title", "No alerts yet"),
      el("div", "pop-empty-body", "Open a Micro Center product page and set a price. Watched products land here."),
    );
    bodyEl.append(wrap);
    countEl.textContent = "";
  }

  function renderList(rows) {
    bodyEl.textContent = "";
    for (const r of rows) {
      const card = el("button", "pop-card" + (r.met ? " met" : ""));
      card.append(el("div", "pop-name", r.name));

      const row = el("div", "pop-row");
      const left = el("div");
      left.append(el("div", "pop-price", r.currentPrice > 0 ? fmt(r.currentPrice) : "—"));
      const sub = r.met
        ? `Target ${fmt(r.target)} · ${r.inStock ? "in stock" : "out of stock"}`
        : `${fmt(Math.max(r.currentPrice - r.target, 0))} above your ${fmt(r.target)} target`;
      left.append(el("div", "pop-sub", sub));
      row.append(left, sparkline(r.trend));
      card.append(row);

      if (r.met) {
        card.append(el("span", "pop-badge", "Target met"));
      } else if (r.currentPrice > 0) {
        const meter = el("div", "pop-meter");
        const fill = el("div", "pop-meter-fill");
        meter.append(fill);
        card.append(meter);
        // fill animates from 0 on the next frame
        const span = Math.max(r.currentPrice - r.lowest, 0.01);
        const progress = Math.min(Math.max(1 - (r.currentPrice - r.target) / span, 0), 1);
        requestAnimationFrame(() => { fill.style.width = (progress * 100).toFixed(1) + "%"; });
      }

      card.addEventListener("click", () => {
        chrome.tabs.create({ url: "https://www.microcenter.com" + r.urlPath });
        window.close();
      });
      bodyEl.append(card);
    }
    const met = rows.filter((r) => r.met).length;
    countEl.textContent = met
      ? `${met} of ${rows.length} at target`
      : `${rows.length} watched`;
    // the live dot quickens when a target is met
    document.querySelector(".pop-live").classList.toggle("alive", met > 0);
  }

  function renderError() {
    bodyEl.textContent = "";
    const wrap = el("div", "pop-empty");
    wrap.append(
      el("div", "pop-empty-title", "Couldn't load your watchlist"),
      el("div", "pop-empty-body", "Check your connection and reopen."),
    );
    bodyEl.append(wrap);
  }

  send({ type: "watch:dashboard" }).then((res) => {
    if (res.error) return renderError();
    const rows = Array.isArray(res.result) ? res.result : [];
    if (!rows.length) return renderEmpty();
    renderList(rows);
  });
})();
