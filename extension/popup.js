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
  // inventing a distance from a target that isn't live.
  function subFor(r) {
    if (!r.alertPrice) return "Price alert off";
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
      left.append(el("div", "pop-price", r.currentPrice > 0 ? fmt(r.currentPrice) : "—"));
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
        chrome.tabs.create({ url: "https://www.microcenter.com" + r.urlPath });
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

  function loadList() {
    // Names resolve before the first paint, not after it — a row that renders
    // "store #045" and then swaps to "Westmont" is a visible correction.
    return Promise.all([
      send({ type: "watch:dashboard" }),
      chrome.storage.local.get(STORE_NAMES_KEY),
    ]).then(([res, stored]) => {
      storeNames = stored[STORE_NAMES_KEY] || {};
      if (res.error) return renderError();
      const rows = Array.isArray(res.result) ? res.result : [];
      if (!rows.length) return renderEmpty();
      renderList(rows);
    });
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

  function openSheet(render) {
    sheetEl.hidden = false;
    sheetEl.classList.remove("closing");
    render();
  }

  function closeSheet() {
    sheetEl.classList.add("closing");
    const done = () => {
      sheetEl.hidden = true;
      sheetBody.textContent = "";
      acctBtn.focus();
    };
    // The class drives an exit animation; under reduced motion there isn't
    // one to wait for, so don't hang on an animationend that never fires.
    const card = sheetEl.querySelector(".pop-sheet-card");
    const anim = getComputedStyle(card).animationName;
    if (anim === "none") done();
    else card.addEventListener("animationend", done, { once: true });
  }

  scrimEl.addEventListener("click", closeSheet);
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
    openSheet(auth.signedIn ? renderAccount : renderSignIn);
  });

  loadList();
  refreshAuth();
})();
