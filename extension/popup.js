// Toolbar popup: the watchlist at a glance — every product you're tracking,
// where its price sits against your target, and its trend.
(() => {
  const bodyEl = document.getElementById("body");
  const countEl = document.getElementById("count");
  const themeBtn = document.getElementById("theme");

  const ICONS = {
    sun: `<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3.2" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
    moon: `<svg viewBox="0 0 16 16" fill="none"><path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
    sliders: `<svg viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5h11M2.5 11.5h11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="6" cy="4.5" r="1.9" fill="var(--jd-header)" stroke="currentColor" stroke-width="1.3"/><circle cx="10.5" cy="11.5" r="1.9" fill="var(--jd-header)" stroke="currentColor" stroke-width="1.3"/></svg>`,
  };

  // The overhead silhouette, reused from the arrival — one bird, one brand.
  const BIRD =
    `<svg class="pop-empty-bird" viewBox="8 2 76 96" fill="none" aria-hidden="true">` +
    `<path d="M55 46.2 Q51 38 47.5 30.5 Q44.5 23.5 40.5 15.5 L38.6 21.5 L35.2 17.5 L34.6 24 L31.6 21.5 L32 28 L29.5 26.5 Q32.5 34 36 40.5 Q38.5 44.6 40 47.8 Z"/>` +
    `<path d="M55 53.8 Q51 62 47.5 69.5 Q44.5 76.5 40.5 84.5 L38.6 78.5 L35.2 82.5 L34.6 76 L31.6 78.5 L32 72 L29.5 73.5 Q32.5 66 36 59.5 Q38.5 55.4 40 52.2 Z"/>` +
    `<path d="M31.5 47.6 L20 42.5 L21.8 45.8 L17.5 44.8 L19.6 48 L16.8 50 L19.6 52 L17.5 55.2 L21.8 54.2 L20 57.5 L31.5 52.4 Q30.6 50 31.5 47.6 Z"/>` +
    `<path d="M31 49.9 Q34 47.6 41 46.6 Q50 45.4 57 46.6 Q62.5 47.4 66.5 48.7 L74 49.9 L66.5 51.2 Q62.5 52.6 57 53.4 Q50 54.6 41 53.4 Q34 52.4 31 50.1 Z"/>` +
    `</svg>`;

  // Micro Center's own slugs can carry an undecoded HTML numeric character
  // reference: product 684336's path ends `...with-900&#181;m-fiber-holder`, the
  // micro sign arriving from `dataLayer.pageUrl` as those seven literal
  // characters because a script body is not HTML and nothing ever decodes it.
  // The stored path is right and stays that way — `normalizeUrlPath` in
  // convex/lib.ts deliberately does not cut there — but concatenated onto the
  // origin that `#` is a fragment delimiter, so the browser navigates to
  // `.../with-900&` and 404s. `encodeURI` does NOT help; it leaves `#` and `&`
  // alone as reserved characters. Escape the one character whose meaning
  // changes on the way into a URL.
  const productUrl = (urlPath) =>
    "https://www.microcenter.com" + String(urlPath).replace(/#/g, "%23");

  // Micro Center prints "$15,299.99"; every price string in Jackdaw matches it.
  const fmt = (p) =>
    "$" + p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ---------- How old the number is ----------
  // Every price here came out of the database, which means it came from the
  // last time a person happened to look at that product. There is no feed. A
  // watchlist that renders a three-week-old price identically to a five-minute-
  // old one isn't neutral, it's a claim — so the age sits beside the number and
  // the wording says "seen", not "is".
  //
  // 48h is the same threshold watches.ts uses to stop treating a store signal
  // as evidence at all. One number, one meaning, on both sides.
  const STALE_MS = 48 * 3600_000;
  const ago = (ms) => {
    const d = Date.now() - ms;
    if (d < 90_000) return "just now";
    if (d < 3_600_000) return Math.round(d / 60_000) + "m ago";
    if (d < 86_400_000) return Math.round(d / 3_600_000) + "h ago";
    if (d < 7 * 86_400_000) return Math.round(d / 86_400_000) + "d ago";
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
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

  // ---------- Store names ----------
  // The same number→name map the service worker keeps for notifications,
  // harvested from Micro Center's own store picker. A watch can outlive every
  // tab that taught us the name, so an unknown number still has to read as
  // something — "store #045" is honest, just less useful.

  const STORE_NAMES_KEY = "jdStoreNames";
  let storeNames = {};
  const storeLabel = (n) => storeNames[n] || `store #${n}`;

  // ---------- Theme ----------

  chrome.storage.local.get("jdTheme").then(({ jdTheme }) => setTheme(jdTheme === "dark"));
  function setTheme(dark) {
    document.body.classList.toggle("dark", dark);
    themeBtn.innerHTML = dark ? ICONS.sun : ICONS.moon;
    themeBtn.title = dark ? "Light mode" : "Dark mode";
    // aria-label outranks title in the accessible name, so it must move with
    // it — the static HTML label read "Dark mode" forever, wrong every second
    // press for a screen reader.
    themeBtn.setAttribute("aria-label", themeBtn.title);
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

  // The price line under the number. A watch with its price trigger switched
  // off has no target to measure against, so it names the state instead of
  // inventing a distance from a target that isn't live. A watch with no
  // sighting yet is the same rule from the other side: no price to measure
  // from, and "$0.00 above your target" would read as at-target.
  function subFor(r) {
    if (!r.alertPrice) return "Price alert off";
    if (!(r.currentPrice > 0)) return `No sightings yet · target ${fmt(r.target)}`;
    if (r.met) return `Target ${fmt(r.target)} · ${r.inStock ? "in stock" : "out of stock"}`;
    return `${fmt(Math.max(r.currentPrice - r.target, 0))} above your ${fmt(r.target)} target`;
  }

  // What else the row is waiting for. Without it a store-only watch reads as
  // an alert with nothing behind it. "Also" only when a price target is live
  // — otherwise these triggers are the whole alert, not an addition to one.
  function triggerLine(r) {
    const marks = [];
    if (r.alertOpenBox) marks.push("open box");
    if (r.alertRestock) marks.push("back in stock");
    if (!marks.length) return null;
    const at = r.watchStore ? ` at ${storeLabel(r.watchStore)}` : "";
    return `${r.alertPrice ? "Also watching" : "Watching"}: ${marks.join(", ")}${at}`;
  }

  function renderList(rows) {
    bodyEl.textContent = "";
    for (const r of rows) {
      const card = el("button", "pop-card" + (r.met ? " met" : ""));
      card.append(el("div", "pop-name", r.name));

      const row = el("div", "pop-row");
      const left = el("div");
      // The price and its age are one statement, on one baseline: "$169.99,
      // seen 18m ago". Split across two lines the age reads as a footnote to
      // the price; on the same line it's part of it.
      const priceLine = el("div", "pop-priceline");
      priceLine.append(el("span", "pop-price", r.currentPrice > 0 ? fmt(r.currentPrice) : "—"));
      if (r.currentPrice > 0 && r.observedAt) {
        const stale = Date.now() - r.observedAt > STALE_MS;
        priceLine.append(
          el("span", "pop-age" + (stale ? " stale" : ""), "seen " + ago(r.observedAt)),
        );
      }
      left.append(priceLine);
      left.append(el("div", "pop-sub", subFor(r)));
      row.append(left, sparkline(r.trend));
      card.append(row);

      if (r.met) {
        card.append(el("span", "pop-badge", "Target met"));
      } else if (r.alertPrice && r.currentPrice > 0) {
        const meter = el("div", "pop-meter");
        const fill = el("div", "pop-meter-fill");
        meter.append(fill);
        card.append(meter);
        // fill animates from 0 on the next frame
        const span = Math.max(r.currentPrice - r.lowest, 0.01);
        const progress = Math.min(Math.max(1 - (r.currentPrice - r.target) / span, 0), 1);
        requestAnimationFrame(() => { fill.style.width = (progress * 100).toFixed(1) + "%"; });
      }

      // Last, under a hairline: the price copy and the bar that measures it are
      // one unit, and putting the triggers between them split the pair.
      const triggers = triggerLine(r);
      if (triggers) card.append(el("div", "pop-triggers", triggers));

      card.addEventListener("click", () => {
        chrome.tabs.create({ url: productUrl(r.urlPath) });
        window.close();
      });
      bodyEl.append(card);
    }
    const met = rows.filter((r) => r.met).length;
    // Denominator is price-armed rows only: a store-only alert can never be
    // "at target", so counting it there would make the ratio unreachable.
    const priced = rows.filter((r) => r.alertPrice).length;
    countEl.textContent = met
      ? `${met} of ${priced} at target`
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

  // Entrance choreography belongs to the popup opening, not to refreshes:
  // sign-in, sign-out and delete reload the list in place, and replaying the
  // cascade there would make a data refresh look like a restart.
  let bodySettled = false;

  function loadList() {
    // Names resolve before the first paint, not after it — a row that renders
    // "store #045" and then swaps to "Westmont" is a visible correction.
    return Promise.all([
      send({ type: "watch:dashboard" }),
      chrome.storage.local.get([STORE_NAMES_KEY, CATALOG_KEY, BADGES_KEY]),
    ]).then(([res, stored]) => {
      storeNames = stored[STORE_NAMES_KEY] || {};
      catalogOn = stored[CATALOG_KEY] === true;
      badgesOn = stored[BADGES_KEY] !== false;
      bodyEl.classList.toggle("settled", bodySettled);
      bodySettled = true;
      if (res.error) return renderError();
      const rows = Array.isArray(res.result) ? res.result : [];
      if (!rows.length) renderEmpty();
      else renderList(rows);
      if (stored[CATALOG_KEY] === undefined) bodyEl.prepend(noticeCard());
    });
  }

  // ---------- Contributing ----------
  // Jackdaw's history is other people's screens. Somebody browsing a category
  // page already has 24 current prices in front of them, and reading what is
  // there costs Micro Center nothing — no page is opened, nothing is fetched,
  // the byte count of the visit is identical either way.
  //
  // That is a good deal only if the person agreed to it first, which is why
  // the card below asks before anything is sent — on its own, not buried in a
  // settings screen — and why both answers are one click. Only an explicit
  // `true` contributes; absent means the question hasn't been answered yet,
  // and an unanswered question sends nothing.

  const CATALOG_KEY = "jdCatalog";
  let catalogOn = false;

  function setCatalog(on) {
    catalogOn = on;
    return chrome.storage.local.set({ [CATALOG_KEY]: on });
  }

  // The other half of the same surface, and a separate consent: this one
  // governs what Jackdaw DRAWS on a category page, not what it sends. They are
  // deliberately not one switch — somebody who wants the history without
  // contributing to it should get it, and somebody who is happy to contribute
  // may still want Micro Center's pages left alone. Absent means on.
  const BADGES_KEY = "jdBadges";
  let badgesOn = true;

  function setBadges(on) {
    badgesOn = on;
    return chrome.storage.local.set({ [BADGES_KEY]: on });
  }

  /** The consent card: shown until the question is answered, in the words a
   *  person would use. Both buttons write an explicit answer, so it appears
   *  exactly as long as the question is open and never nags. */
  function noticeCard() {
    // Two elements, not one: the outer is a grid that collapses its own row on
    // dismissal (so the watch list rises into the gap), the inner is the card.
    const card = el("div", "pop-notice");
    const inner = el("div", "pop-notice-inner");
    card.append(inner);
    inner.append(
      el("div", "pop-notice-title", "Help build the price history"),
      el(
        "div",
        "pop-notice-body",
        "As you browse Micro Center, Jackdaw can read the prices already on " +
          "your screen and add them to the shared history — anonymously. It " +
          "never opens pages or loads products on its own, and nothing is " +
          "shared until you say yes.",
      ),
    );
    const actions = el("div", "pop-notice-actions");
    const no = el("button", "pop-notice-btn", "No thanks");
    const yes = el("button", "pop-notice-btn primary", "Start contributing");
    const close = () => {
      card.classList.add("going");
      // The inner's own fade ends first and animationend BUBBLES — without the
      // target check it would remove the card mid-collapse.
      const done = (e) => {
        if (e && e.target !== card) return;
        card.removeEventListener("animationend", done);
        card.remove();
      };
      if (getComputedStyle(card).animationName === "none") done();
      else card.addEventListener("animationend", done);
    };
    no.addEventListener("click", () => {
      setCatalog(false);
      close();
    });
    yes.addEventListener("click", () => {
      setCatalog(true);
      close();
    });
    actions.append(no, yes);
    // Into the inner card — the outer is a one-row grid, and a second child
    // would take an implicit row that the collapse can't close.
    inner.append(actions);
    return card;
  }

  /** One switch row: label, an ⓘ note, an optional live hint, and the painted
      track over a real input. The note is the long form — collapsed until the
      ⓘ is hovered, focused, or clicked — so the sheet leads with controls
      instead of prose. A row given no `hint` shows its state through the note
      instead, which is why a toggle on such a row opens it. */
  function settingRow({ on, label, hint, note, noteId, onChange }) {
    const row = el("label", "pop-set-row");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "pop-set-input";
    input.checked = on;
    const track = el("span", "pop-set-track");
    track.append(el("span", "pop-set-thumb"));

    const text = el("div", "pop-set-text");
    const line = el("div", "pop-set-labelline");
    const info = document.createElement("button");
    info.type = "button";
    info.className = "pop-set-info";
    info.setAttribute("aria-label", "More about this setting");
    info.setAttribute("aria-expanded", "false");
    info.setAttribute("aria-controls", noteId);
    info.innerHTML =
      '<svg viewBox="0 0 12 12" aria-hidden="true">' +
      '<circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" stroke-width="1.1"/>' +
      '<circle cx="6" cy="3.5" r="0.9" fill="currentColor"/>' +
      '<rect x="5.3" y="5.3" width="1.4" height="3.5" rx="0.7" fill="currentColor"/>' +
      "</svg>";
    line.append(el("span", "pop-set-label", label), info);

    const noteEl = el("div", "pop-set-note");
    const noteInner = el("div", "pop-set-note-inner");
    const noteText = el("div", "pop-set-note-text");
    noteText.id = noteId;
    noteInner.append(noteText);
    noteEl.append(noteInner);

    const hintEl = hint ? el("div", "pop-set-hint") : null;
    const paint = () => {
      if (hintEl) hintEl.textContent = hint(input.checked);
      noteText.textContent = note(input.checked);
    };
    paint();
    text.append(line);
    if (hintEl) text.append(hintEl);
    text.append(noteEl);

    const setOpen = (open) => {
      row.classList.toggle("note-open", open);
      info.setAttribute("aria-expanded", String(open));
    };
    info.addEventListener("click", (e) => {
      // A button inside the row's <label>: the click must never double as a
      // flip of the switch the label wraps.
      e.preventDefault();
      setOpen(!row.classList.contains("note-open"));
    });

    input.addEventListener("change", async () => {
      await onChange(input.checked);
      paint();
      if (!hintEl) setOpen(true);
    });

    row.append(text, input, track);
    return row;
  }

  /** The permanent controls, behind the header's settings button. The full
      disclosures live in each row's ⓘ note; the one line that stays on the
      surface is the badge row's "sends the products on the page", because it
      is the only place the popup says the feature sends anything. */
  function renderSettings() {
    sheetBody.textContent = "";
    sheetBody.append(
      sheetHead(
        "Contributing",
        "Built from what you already have on screen — nothing is requested on your behalf.",
      ),
      settingRow({
        on: catalogOn,
        label: "Share what I browse",
        noteId: "setNoteCatalog",
        note: (on) =>
          on
            ? "Prices and stock from the Micro Center pages you visit. No account, nothing that identifies you, and no extra pages opened in the background."
            : "Jackdaw still shows you the history. You just won't be adding to it.",
        // Writing the explicit boolean is also what answers the consent card's
        // question, so it stops appearing once this switch has been touched.
        onChange: setCatalog,
      }),
    );

    // Second head, built by hand rather than through sheetHead(): that one
    // stamps the id the sheet is labelled by, and a page cannot have two.
    sheetBody.append(
      el("div", "pop-sheet-title pop-set-head", "Showing"),
      el(
        "div",
        "pop-sheet-body",
        "What Jackdaw draws on the page — reading, not contributing.",
      ),
      settingRow({
        on: badgesOn,
        label: "Price range on category pages",
        noteId: "setNoteBadges",
        hint: (on) =>
          on
            ? "Sends the products on the page — never what you searched for."
            : "Category pages stay as Micro Center draws them.",
        note: () => "A small range under each card, showing where today's price sits.",
        onChange: setBadges,
      }),
    );

    const done = el("button", "pop-btn", "Done");
    done.addEventListener("click", closeSheet);
    sheetBody.append(done);
  }

  // ---------- Account ----------
  // Optional throughout. The footer pill describes the watchlist's durability
  // rather than advertising a feature — "this browser only" is the actual
  // exposure, sitting next to the count of what it applies to.

  const acctBtn = document.getElementById("acct");
  const sheetEl = document.getElementById("sheet");
  const sheetBody = document.getElementById("sheetBody");
  const scrimEl = document.getElementById("scrim");

  const CHECK = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.4 8.5l3 3 6.2-7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  // The same mark the discussion panel puts beside a claimed handle, so the
  // two surfaces are visibly saying one thing.
  const VERIFIED_MARK =
    `<svg class="pop-verified" viewBox="0 0 12 12" role="img"><title>Verified — a claimed handle</title>` +
    `<path d="M2.4 6.3 4.8 8.6 9.6 3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  // Backend error codes are contracts; these are the sentences a person reads.
  const ERRORS = {
    INVALID_ARGUMENT: "That doesn't look like an email address.",
    BAD_CODE: "That code isn't right. Check the email, or request a new one.",
    CODE_LOCKED: "Too many wrong guesses. Request a new code.",
    RATE_LIMITED: "Too many attempts just now. Try again in a little while.",
    NETWORK: "Couldn't reach Jackdaw. Check your connection.",
  };
  const errorText = (res) =>
    ERRORS[res.code] || res.error || "Something went wrong. Try again.";

  let auth = { signedIn: false };

  function paintAcct() {
    acctBtn.hidden = false;
    acctBtn.classList.toggle("synced", auth.signedIn);
    acctBtn.textContent = auth.signedIn ? "synced" : "this browser only";
    acctBtn.title = auth.signedIn
      ? `Signed in as ${auth.email}`
      : "Your alerts live only in this browser";
  }

  function refreshAuth() {
    return send({ type: "auth:state" }).then((res) => {
      auth = res.result && !res.error ? res.result : { signedIn: false };
      paintAcct();
    });
  }

  // ---------- Sheet ----------

  // Whichever control opened the sheet gets the focus back when it closes —
  // two surfaces open this now, and returning focus to the footer pill after
  // the header button opened it loses the user's place in the tab order.
  let sheetOpener = acctBtn;

  function openSheet(render, opener) {
    sheetOpener = opener || acctBtn;
    sheetEl.hidden = false;
    sheetEl.classList.remove("closing");
    render();
  }

  function closeSheet() {
    sheetEl.classList.add("closing");
    const done = () => {
      sheetEl.hidden = true;
      sheetBody.textContent = "";
      if (sheetOpener && !sheetOpener.hidden) sheetOpener.focus();
    };
    // The class drives an exit animation; under reduced motion there isn't
    // one to wait for, so don't hang on an animationend that never fires.
    const card = sheetEl.querySelector(".pop-sheet-card");
    const anim = getComputedStyle(card).animationName;
    if (anim === "none") done();
    else card.addEventListener("animationend", done, { once: true });
  }

  scrimEl.addEventListener("click", closeSheet);
  // The grip reads as a dismiss handle, so it is one — on a sheet tall enough
  // to cap out, the strip of scrim above it is too thin to be the only way out.
  sheetEl.querySelector(".pop-sheet-grip").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !sheetEl.hidden) closeSheet();
  });

  /** Title + body copy, shared by every sheet state. */
  function sheetHead(title, body) {
    const frag = document.createDocumentFragment();
    const h = el("div", "pop-sheet-title", title);
    h.id = "sheetTitle";
    frag.append(h, el("div", "pop-sheet-body", body));
    return frag;
  }

  function showError(message) {
    const old = sheetBody.querySelector(".pop-err");
    if (old) old.remove();
    // Re-inserting is what replays the shake; patching the text of a node
    // whose animation already finished would change the words silently.
    sheetBody.append(el("div", "pop-err", message));
  }

  /** Signed out: ask for an address, then transform that step into the code step. */
  function renderSignIn() {
    sheetBody.textContent = "";
    sheetBody.append(
      sheetHead(
        "Keep your alerts",
        "Clearing your browser data takes your watchlist with it. An account keeps it, and brings it to your other browsers. No password — we email you a 6-digit code.",
      ),
    );

    const emailStep = el("div", "pop-step");
    const emailWrap = el("div");
    const emailInput = el("input", "pop-field");
    emailInput.type = "email";
    emailInput.placeholder = "you@example.com";
    emailInput.autocomplete = "email";
    emailInput.spellcheck = false;
    emailInput.setAttribute("aria-label", "Email address");
    emailWrap.append(emailInput);
    emailStep.append(emailWrap);

    const sentLine = el("div", "pop-step shut");
    const sentWrap = el("div");
    const sent = el("div", "pop-sent");
    sent.innerHTML = CHECK;
    sentWrap.append(sent);
    sentLine.append(sentWrap);

    const codeStep = el("div", "pop-step shut");
    const codeWrap = el("div");
    const codeInput = el("input", "pop-field code");
    codeInput.type = "text";
    codeInput.inputMode = "numeric";
    // Chrome offers the code straight from the mail app with this.
    codeInput.autocomplete = "one-time-code";
    codeInput.maxLength = 7;
    codeInput.placeholder = "······";
    codeInput.setAttribute("aria-label", "Six-digit code");
    codeWrap.append(codeInput);
    codeStep.append(codeWrap);

    const actions = el("div", "pop-actions");
    const primary = el("button", "pop-btn", "Send code");
    const cancel = el("button", "pop-btn ghost", "Not now");
    actions.append(primary, el("span", "pop-spacer"), cancel);

    sheetBody.append(emailStep, sentLine, codeStep, actions);
    emailInput.focus();
    cancel.addEventListener("click", closeSheet);

    let step = "email";
    let address = "";

    async function submit() {
      if (primary.disabled) return;
      const old = sheetBody.querySelector(".pop-err");
      if (old) old.remove();

      if (step === "email") {
        address = emailInput.value.trim();
        if (!address) return emailInput.focus();
        primary.disabled = true;
        primary.textContent = "Sending…";
        const res = await send({ type: "auth:request", email: address });
        primary.disabled = false;
        if (res.error) {
          primary.textContent = "Send code";
          return showError(errorText(res));
        }
        // Step one becomes step two: the address field collapses into the line
        // that names it, and the code field opens into the space it gave up.
        step = "code";
        sent.append(document.createTextNode("Code sent to "), el("b", null, address));
        emailStep.classList.add("shut");
        primary.textContent = "Sign in";
        requestAnimationFrame(() => {
          sentLine.classList.remove("shut");
          codeStep.classList.remove("shut");
          codeInput.focus();
        });
        return;
      }

      const code = codeInput.value.trim();
      if (!code) return codeInput.focus();
      primary.disabled = true;
      primary.textContent = "Checking…";
      const res = await send({ type: "auth:verify", email: address, code });
      primary.disabled = false;
      primary.textContent = "Sign in";
      if (res.error) {
        codeInput.select();
        return showError(errorText(res));
      }
      renderSignedInDone(res.result);
    }

    primary.addEventListener("click", submit);
    for (const input of [emailInput, codeInput]) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
      });
    }
  }

  /** The moment it works. States what actually moved, not "success". */
  function renderSignedInDone(result) {
    auth = { signedIn: true, email: result.email };
    paintAcct();
    // A returning account may already own a handle, which verifyCode has no
    // reason to report — pick it up so the account sheet is right next time.
    refreshAuth();
    loadList();

    sheetBody.textContent = "";
    const wrap = el("div", "pop-done");
    const mark = el("div", "pop-done-mark");
    mark.innerHTML = CHECK;
    const n = result.adoptedWatches;
    wrap.append(
      mark,
      el("div", "pop-sheet-title", "You're in"),
      el(
        "div",
        "pop-sheet-body",
        n > 0
          ? `${n} ${n === 1 ? "alert" : "alerts"} moved to ${result.email}. They'll follow you to your other browsers.`
          : `Signed in as ${result.email}. Alerts you set from now on are kept with your account.`,
      ),
    );
    sheetBody.append(wrap);
    setTimeout(() => {
      if (!sheetEl.hidden) closeSheet();
    }, 2600);
  }

  /** Signed in: who you are, and the two ways out. */
  function renderAccount() {
    sheetBody.textContent = "";
    sheetBody.append(
      sheetHead(
        "Your account",
        auth.stale
          ? "Couldn't reach Jackdaw just now, so this may be out of date."
          : "Your watchlist is kept with your account and follows you to any browser you sign in to.",
      ),
    );
    sheetBody.append(el("div", "pop-acct-email", auth.email || ""));
    // Shown, never asked for. A handle is claimed where it first matters — the
    // compose form on a product page — because an account that only tracks
    // prices never needs one, and a form here would imply otherwise.
    if (auth.handle) {
      const who = el("div", "pop-acct-handle");
      who.append(el("span", null, auth.handle));
      who.insertAdjacentHTML("beforeend", VERIFIED_MARK);
      who.append(el("span", "pop-acct-handle-note", "your name on comments"));
      sheetBody.append(who);
    }

    const actions = el("div", "pop-actions");
    const out = el("button", "pop-btn ghost", "Sign out");
    const del = el("button", "pop-btn danger", "Delete account");
    actions.append(out, el("span", "pop-spacer"), del);
    sheetBody.append(actions);

    out.addEventListener("click", async () => {
      out.disabled = true;
      await send({ type: "auth:signOut" });
      auth = { signedIn: false };
      paintAcct();
      loadList();
      closeSheet();
    });

    // Two-step in place rather than a dialog: a popup that opens a confirm()
    // can lose focus and close, taking the answer with it.
    let armed = false;
    del.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        del.textContent = "Really delete?";
        sheetBody.append(
          el(
            "div",
            "pop-sheet-body",
            "Your email address and sessions are removed. Your alerts stay on this browser, unlinked — you keep them.",
          ),
        );
        return;
      }
      del.disabled = true;
      const res = await send({ type: "auth:delete" });
      if (res.error) {
        del.disabled = false;
        return showError(errorText(res));
      }
      auth = { signedIn: false };
      paintAcct();
      loadList();
      closeSheet();
    });
  }

  acctBtn.addEventListener("click", () => {
    openSheet(auth.signedIn ? renderAccount : renderSignIn, acctBtn);
  });

  const settingsBtn = document.getElementById("settings");
  settingsBtn.innerHTML = ICONS.sliders;
  settingsBtn.addEventListener("click", () => {
    openSheet(renderSettings, settingsBtn);
  });

  loadList();
  refreshAuth();
})();

// ---------- The header lap ----------
// Every 18 seconds the live dot takes flight: it becomes the bird, flies one
// lap over the wordmark — letters ducking as it actually passes them — and
// lands back on its mark. The same engine as the welcome arrival (arc-length
// path sampling, per-frame wingbeat, heading from the path derivative),
// trimmed to one flight on a 200x60 stage over the brand. popup.css hides
// the canvas under prefers-reduced-motion; the scheduler here checks the
// same query before every lap, and tears down on a mid-session flip.
(() => {
  const sky = document.querySelector(".pop-sky");
  const live = document.querySelector(".pop-live");
  const mark = document.querySelector(".pop-wordmark");
  if (!sky || !live || !mark) return;
  const brand = sky.parentElement;
  const letters = Array.from(mark.querySelectorAll("i"));
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  // The glyph's own artwork as Path2D: head at +x, tail at -x, wings
  // +-y about the body line at y 50; registration centre (46, 50).
  const BIRD_PARTS = {
    wingUp: new Path2D("M55 46.2 Q51 38 47.5 30.5 Q44.5 23.5 40.5 15.5 L38.6 21.5 L35.2 17.5 L34.6 24 L31.6 21.5 L32 28 L29.5 26.5 Q32.5 34 36 40.5 Q38.5 44.6 40 47.8 Z"),
    wingDn: new Path2D("M55 53.8 Q51 62 47.5 69.5 Q44.5 76.5 40.5 84.5 L38.6 78.5 L35.2 82.5 L34.6 76 L31.6 78.5 L32 72 L29.5 73.5 Q32.5 66 36 59.5 Q38.5 55.4 40 52.2 Z"),
    tail: new Path2D("M31.5 47.6 L20 42.5 L21.8 45.8 L17.5 44.8 L19.6 48 L16.8 50 L19.6 52 L17.5 55.2 L21.8 54.2 L20 57.5 L31.5 52.4 Q30.6 50 31.5 47.6 Z"),
    body: new Path2D("M31 49.9 Q34 47.6 41 46.6 Q50 45.4 57 46.6 Q62.5 47.4 66.5 48.7 L74 49.9 L66.5 51.2 Q62.5 52.6 57 53.4 Q50 54.6 41 53.4 Q34 52.4 31 50.1 Z"),
  };
  // Wings first, under a vertical squash about the body line, then tail and
  // body on top. Symmetric artwork: heading is pure rotation, no mirror.
  function drawBird(g, x, y, ang, k, spread, alpha) {
    g.save();
    g.globalAlpha = alpha;
    g.translate(x, y);
    g.rotate(ang);
    g.scale(k, k);
    g.translate(-46, -50);
    g.save();
    g.translate(0, 50);
    g.scale(1, Math.max(spread, 0.05));
    g.translate(0, -50);
    g.fill(BIRD_PARTS.wingUp);
    g.fill(BIRD_PARTS.wingDn);
    g.restore();
    g.fill(BIRD_PARTS.tail);
    g.fill(BIRD_PARTS.body);
    g.restore();
  }

  // Arc-length path sampling, as in welcome.js: one cumulative table per
  // authored path, inverted per frame; heading from the derivative.
  const ARC_STEPS = 32;
  function cubicAt(s, t) {
    const u = 1 - t;
    return [
      u * u * u * s[0] + 3 * u * u * t * s[2] + 3 * u * t * t * s[4] + t * t * t * s[6],
      u * u * u * s[1] + 3 * u * u * t * s[3] + 3 * u * t * t * s[5] + t * t * t * s[7],
    ];
  }
  function cubicDeriv(s, t) {
    const u = 1 - t;
    return [
      3 * u * u * (s[2] - s[0]) + 6 * u * t * (s[4] - s[2]) + 3 * t * t * (s[6] - s[4]),
      3 * u * u * (s[3] - s[1]) + 6 * u * t * (s[5] - s[3]) + 3 * t * t * (s[7] - s[5]),
    ];
  }
  function measurePath(d) {
    const n = (d.match(/-?[\d.]+/g) || []).map(Number);
    const segs = [];
    let sx = n[0], sy = n[1];
    for (let i = 2; i + 5 < n.length; i += 6) {
      segs.push([sx, sy, n[i], n[i + 1], n[i + 2], n[i + 3], n[i + 4], n[i + 5]]);
      sx = n[i + 4];
      sy = n[i + 5];
    }
    const lens = [0];
    const samples = [];
    let total = 0;
    let px = segs[0][0], py = segs[0][1];
    for (const seg of segs) {
      for (let k = 1; k <= ARC_STEPS; k++) {
        const [x, y] = cubicAt(seg, k / ARC_STEPS);
        total += Math.hypot(x - px, y - py);
        lens.push(total);
        samples.push([seg, k / ARC_STEPS]);
        px = x;
        py = y;
      }
    }
    return { lens, samples, total };
  }
  function pathAt(path, f) {
    const target = Math.min(Math.max(f, 0), 1) * path.total;
    let lo = 0, hi = path.lens.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (path.lens[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const i = Math.max(lo, 1);
    const [seg, t1] = path.samples[i - 1];
    const span = path.lens[i] - path.lens[i - 1] || 1;
    const t = t1 - 1 / ARC_STEPS + ((target - path.lens[i - 1]) / span) * (1 / ARC_STEPS);
    const [x, y] = cubicAt(seg, t);
    const [dx, dy] = cubicDeriv(seg, t);
    return { x, y, ang: Math.atan2(dy, dx) };
  }
  function bezierEase(x1, y1, x2, y2) {
    const ax = 3 * x1 - 3 * x2 + 1, bx = 3 * x2 - 6 * x1, cx = 3 * x1;
    const ay = 3 * y1 - 3 * y2 + 1, by = 3 * y2 - 6 * y1, cy = 3 * y1;
    const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
    const sampleY = (t) => ((ay * t + by) * t + cy) * t;
    const slopeX = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return (x) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 5; i++) {
        const s = slopeX(t);
        if (Math.abs(s) < 1e-6) break;
        t -= (sampleX(t) - x) / s;
      }
      if (t < 0 || t > 1 || Math.abs(sampleX(t) - x) > 1e-4) {
        let lo = 0, hi = 1;
        t = x;
        for (let i = 0; i < 24; i++) {
          if (sampleX(t) < x) lo = t;
          else hi = t;
          t = (lo + hi) / 2;
        }
      }
      return sampleY(t);
    };
  }
  const LINEAR = (x) => x;
  const EASE_IN_OUT = bezierEase(0.42, 0, 0.58, 1);
  function profileAt(marks, p) {
    if (p <= marks[0][0]) return marks[0][1];
    const last = marks[marks.length - 1];
    if (p >= last[0]) return last[1];
    for (let i = 1; i < marks.length; i++) {
      if (p <= marks[i][0]) {
        const prev = marks[i - 1];
        const u = (p - prev[0]) / (marks[i][0] - prev[0]);
        return prev[1] + (prev[2] || LINEAR)(u) * (marks[i][1] - prev[1]);
      }
    }
    return last[1];
  }
  const smooth = (u) => {
    const c = Math.min(Math.max(u, 0), 1);
    return c * c * (3 - 2 * c);
  };

  const cbLaunch = bezierEase(0.4, 0.1, 0.7, 1);
  const cbSweep = bezierEase(0.4, 0, 0.5, 1);
  const cbSettle = bezierEase(0.2, 0.6, 0.3, 1);

  // Stage: popup.css's .pop-sky rect, in .pop-brand coordinates — change
  // both together. The dot's centre sits at (3.5, 8) at the popup's fixed
  // metrics; the lap launches there, climbs over the letters, banks past
  // the wordmark's end and swoops home below it.
  const CV = { left: -20, top: -24, w: 200, h: 60 };
  const LAP = {
    path: measurePath("M 3.5 9.4 C 24 -4 62 -8 96 -2 C 122 3 126 16 102 19 C 78 21 40 21 14 17 C 2 16 -1 12 3.5 9.4"),
    dur: 1.9, delay: 0,
    dist: [[0, 0, cbLaunch], [0.32, 0.42, EASE_IN_OUT], [0.62, 0.66, cbSweep], [0.8, 0.85, cbSettle], [1, 1]],
    alpha: [[0, 0], [0.07, 1], [0.93, 1], [1, 0]],
    size: [[0, 0.11], [0.18, 0.19], [0.3, 0.2], [0.72, 0.2], [0.88, 0.16], [1, 0.11]],
    take: 0.4, rampIn: 0.15, flare: 0.85, level: 0.9,
  };
  // Cruise flap at ~195ms a beat, a blend from the folded launch pose, and
  // a full-spread flare before the bird shrinks back into the dot.
  function spreadAt(p, ms) {
    let s = 0.3 + 0.7 * Math.abs(Math.sin(ms / 62));
    if (p < LAP.rampIn) s = LAP.take + (s - LAP.take) * smooth(p / LAP.rampIn);
    if (p > LAP.flare) s += (1 - s) * smooth((p - LAP.flare) / (1 - LAP.flare));
    return s;
  }

  const cx2d = sky.getContext("2d");
  let dpr = 0;
  let flightRaf = 0;
  let flightState = null;
  function ensureCanvas() {
    const want = Math.min(window.devicePixelRatio || 1, 2);
    if (want !== dpr) {
      dpr = want;
      sky.width = Math.round(CV.w * dpr);
      sky.height = Math.round(CV.h * dpr);
    }
  }
  function cancelFlight() {
    if (flightRaf) cancelAnimationFrame(flightRaf);
    flightRaf = 0;
    flightState = null;
    cx2d.setTransform(1, 0, 0, 1, 0, 0);
    cx2d.clearRect(0, 0, sky.width, sky.height);
  }
  function startFlight(hooks) {
    cancelFlight();
    ensureCanvas();
    flightState = { hooks: hooks || {}, t0: 0, prevX: null };
    flightRaf = requestAnimationFrame(flightFrame);
  }
  function flightFrame(ts) {
    const st = flightState;
    if (!st) return;
    if (!st.t0) st.t0 = ts;
    const p = ((ts - st.t0) / 1000 - LAP.delay) / LAP.dur;
    cx2d.setTransform(1, 0, 0, 1, 0, 0);
    cx2d.clearRect(0, 0, sky.width, sky.height);
    if (p >= 1) {
      const done = st.hooks.onDone;
      flightRaf = 0;
      flightState = null;
      if (done) done();
      return;
    }
    if (p > 0) {
      const pt = pathAt(LAP.path, profileAt(LAP.dist, p));
      let ang = pt.ang;
      if (p > LAP.level) ang *= 1 - smooth((p - LAP.level) / (1 - LAP.level));
      cx2d.setTransform(dpr, 0, 0, dpr, -CV.left * dpr, -CV.top * dpr);
      // Ink re-read per frame: the theme class lands asynchronously from
      // the storage read, and the old SVG's currentColor was live too.
      cx2d.fillStyle = getComputedStyle(sky).color;
      drawBird(cx2d, pt.x, pt.y, ang, profileAt(LAP.size, p),
               spreadAt(p, ts - st.t0), profileAt(LAP.alpha, p));
      if (st.hooks.onPos) st.hooks.onPos(pt.x, pt.y, p, st.prevX);
      st.prevX = pt.x;
    }
    flightRaf = requestAnimationFrame(flightFrame);
  }

  // Letter centres in brand space, measured per lap; a letter ducks the
  // frame the bird's x actually crosses it on the outbound (rightward,
  // overhead) leg. One-shot animation, removed on its own animationend.
  let letterXs = null;
  function measureLetters() {
    const brandLeft = brand.getBoundingClientRect().left;
    letterXs = letters.map((el) => {
      const r = el.getBoundingClientRect();
      return r.left + r.width / 2 - brandLeft;
    });
  }
  function duckUnder(x, y, p, prevX) {
    if (prevX == null || y > 4 || p > 0.55) return;
    for (let i = 0; i < letters.length; i++) {
      if (prevX < letterXs[i] && letterXs[i] <= x) letters[i].classList.add("duck");
    }
  }
  mark.addEventListener("animationend", (e) => {
    if (e.animationName === "pop-duck") e.target.classList.remove("duck");
  });

  let lapTimer = 0;
  function schedule(ms) {
    clearTimeout(lapTimer);
    lapTimer = setTimeout(lap, ms);
  }
  function lap() {
    if (reduced.matches || flightState) return;
    measureLetters();
    live.classList.add("away");
    startFlight({
      onPos: duckUnder,
      onDone: () => {
        live.classList.remove("away");
        schedule(16100); // lap 1.9s -> the old 18s cycle, kept
      },
    });
  }
  if (reduced.addEventListener) {
    reduced.addEventListener("change", () => {
      if (reduced.matches) {
        clearTimeout(lapTimer);
        lapTimer = 0;
        cancelFlight();
        live.classList.remove("away");
        letters.forEach((el) => el.classList.remove("duck"));
      } else {
        schedule(6000);
      }
    });
  }
  if (!reduced.matches) schedule(6000); // the old cycle's initial delay, kept
})();
