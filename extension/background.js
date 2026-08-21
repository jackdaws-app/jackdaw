// Service worker: owns the anonymous device id, all Convex HTTP calls, and
// the price-drop alert loop (hourly check of watched products).
import { CONVEX_URL } from "./config.js";

async function getDeviceId() {
  const { deviceId } = await chrome.storage.local.get("deviceId");
  if (deviceId) return deviceId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId: id });
  return id;
}

const REQUEST_TIMEOUT_MS = 12_000;

async function convexCall(kind, path, args, opts = {}) {
  const { retry = true, attempt = 0 } = opts;
  let res;
  try {
    res = await fetch(`${CONVEX_URL}/api/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
      // without this a hung connection never settles and the caller waits forever
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    // one retry with backoff for transport failures (offline, timeout, DNS)
    if (retry && attempt === 0) {
      await new Promise((r) => setTimeout(r, 900));
      return convexCall(kind, path, args, { retry, attempt: 1 });
    }
    const err = new Error("network");
    err.code = "NETWORK";
    throw err;
  }
  if (res.status >= 500 && retry && attempt === 0) {
    await new Promise((r) => setTimeout(r, 900));
    return convexCall(kind, path, args, { retry, attempt: 1 });
  }
  let json;
  try {
    json = await res.json();
  } catch {
    const err = new Error("bad response");
    err.code = "NETWORK";
    throw err;
  }
  if (json.status === "success") return json.value;
  const err = new Error(json.errorMessage || "Convex call failed");
  if (json.errorData && json.errorData.code) err.code = json.errorData.code;
  throw err;
}

const convexQuery = (path, args) => convexCall("query", path, args);
const convexMutation = (path, args) => convexCall("mutation", path, args);
// Actions are NOT retried. auth:verifyCode spends a single-use code, so if its
// response is lost in transit a replay would answer BAD_CODE for a code that
// actually worked — telling someone their correct code is wrong. One attempt,
// and a lost response means "request another code", which is at least true.
const convexAction = (path, args) => convexCall("action", path, args, { retry: false });

// ---------- Telemetry ----------
// Anonymous counters only: an event name from a fixed list, nothing else.
// Buffered in local storage so failures that happen while offline (the ones
// most worth knowing about) still get reported once connectivity returns.
const EVENT_NAMES = new Set([
  "panel_ok",
  "no_datalayer",
  "report_failed",
  "history_failed",
  "comments_failed",
  "panel_error",
]);

async function recordEvent(name) {
  if (!EVENT_NAMES.has(name)) return;
  const { jdEvents = {} } = await chrome.storage.local.get("jdEvents");
  jdEvents[name] = Math.min((jdEvents[name] || 0) + 1, 500);
  await chrome.storage.local.set({ jdEvents });
}

async function flushEvents() {
  const { jdEvents = {} } = await chrome.storage.local.get("jdEvents");
  const events = Object.entries(jdEvents)
    .filter(([name, count]) => EVENT_NAMES.has(name) && count > 0)
    .slice(0, 12)
    .map(([name, count]) => ({ name, count }));
  if (!events.length) return;
  // clear first: a failed flush loses a few counts, a failed clear double-counts
  await chrome.storage.local.set({ jdEvents: {} });
  try {
    await convexMutation("metrics:events", { events });
  } catch {
    // put them back for the next attempt, merging anything recorded meanwhile
    const { jdEvents: since = {} } = await chrome.storage.local.get("jdEvents");
    for (const { name, count } of events) {
      since[name] = Math.min((since[name] || 0) + count, 500);
    }
    await chrome.storage.local.set({ jdEvents: since });
  }
}

// ---------- Store names ----------
// A number → name map for notification copy, learned from Micro Center's own
// store picker. Capped so a malformed page can't grow it without bound; names
// are truncated for the same reason. Nothing here is ever sent anywhere.

const STORE_NAMES_KEY = "jdStoreNames";
const MAX_STORE_NAMES = 60;

async function learnStoreNames(names) {
  if (!names || typeof names !== "object") return { ok: false };
  const { [STORE_NAMES_KEY]: known = {} } = await chrome.storage.local.get(STORE_NAMES_KEY);
  let changed = false;
  for (const [num, name] of Object.entries(names)) {
    if (!/^\d{1,10}$/.test(num) || typeof name !== "string") continue;
    const clean = name.trim().slice(0, 40);
    if (!clean || known[num] === clean) continue;
    if (!(num in known) && Object.keys(known).length >= MAX_STORE_NAMES) continue;
    known[num] = clean;
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ [STORE_NAMES_KEY]: known });
  return { ok: true, known: Object.keys(known).length };
}

// 029 "Shippable Items" and 000 (page-world's unknown fallback) name no
// shelf, so they can never be where something was seen. content.js keeps its
// own copy — a service worker and a content script share no module.
const NON_PHYSICAL_STORES = new Set(["029", "000"]);

/** "Westmont" if we've seen it, else "store #045" — never a bare number. */
async function storeLabel(storeNum) {
  const { [STORE_NAMES_KEY]: known = {} } = await chrome.storage.local.get(STORE_NAMES_KEY);
  return known[storeNum] || `store #${storeNum}`;
}

/** "20h ago" / "3 days ago" — how old the sighting behind an alert is. */
function ageLabel(observedAt) {
  const mins = Math.max(0, Math.round((Date.now() - observedAt) / 60000));
  if (mins < 90) return `${Math.max(1, mins)} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

// ---------- Optional accounts ----------
// Anonymous stays complete: nothing here is required by any feature. An
// account exists so alerts survive clearing browser data, and signing in
// adopts the watches this device already has rather than starting over.
//
// The session token is a bearer credential — whoever holds it is the account —
// and it is NEVER returned to a caller. Content scripts run inside a page Micro
// Center controls; they get to know *whether* someone is signed in, and their
// address, and nothing else.
//
// What that does NOT mean, and what this comment claimed until it was measured:
// the token is in chrome.storage.local, which the whole extension can read,
// content scripts included. The page itself cannot — an isolated world is a
// real boundary — so what stands is that no page script and no message reply
// ever sees it. Anything running with extension privileges already could.
//
// Neither obvious hardening is free, which is why this is written down rather
// than silently "fixed": storage.session is cleared when the browser closes and
// would end the 90-day sign-in the account exists to provide, and restricting
// storage.local's access level is not scoped to one key — it would cut off
// content.js's own theme and consent reads, which are the reason it has storage
// access at all. A dedicated trusted-context store for this one key is the
// shape worth having; see the open item in the handbook.

const SESSION_KEY = "jdSession";

async function getSession() {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  const session = stored[SESSION_KEY];
  return session && session.token ? session : null;
}

/**
 * The scope argument every participation call carries — watches AND
 * comments:add/vote/report, plus comments:list for vote-marking:
 * `{sessionToken}` when signed in, `{}` when not. Spread into the args rather
 * than passed as null, because the backend's validator is
 * `v.optional(v.string())` and an absent token gets the backend's own answer —
 * SIGN_IN_REQUIRED from the mutations, the signed-out shape from the queries —
 * rather than an ArgumentValidationError.
 *
 * A stale or revoked token needs no special handling here: the backend
 * resolves it to null and answers exactly as it would with no token at all.
 * Participation requires sign-in as of 2026-08-20; reading history, reading
 * threads, and reporting observations stay anonymous.
 */
async function scopeArg() {
  const session = await getSession();
  return session === null ? {} : { sessionToken: session.token };
}

/**
 * Who's signed in, verified against the backend rather than trusted from
 * storage — a session can be revoked, expire, or belong to a deleted account,
 * and a popup that shows a stale address is worse than one that shows none.
 *
 * A network failure returns the cached address instead of signing the user
 * out: being offline is not a credential problem, and dropping someone's
 * account state every time their wifi drops would be its own bug.
 */
async function authState() {
  const session = await getSession();
  if (session === null) return { signedIn: false };
  try {
    const me = await convexQuery("auth:me", { sessionToken: session.token });
    if (me === null) {
      await chrome.storage.local.remove(SESSION_KEY);
      return { signedIn: false };
    }
    // Sliding expiry lives in a mutation because queries can't write. Cheap:
    // the backend only writes once a day per session.
    convexMutation("auth:touch", { sessionToken: session.token }).catch(() => {});
    // Mirror the backend's answer into storage so the offline branch below has
    // something true to say. The handle is cached for the same reason the
    // address is: a compose form that forgets who you are the moment the
    // network blips would send you back to a claim step you already completed.
    const handle = me.handle ?? null;
    if (me.email !== session.email || handle !== (session.handle ?? null)) {
      await chrome.storage.local.set({
        [SESSION_KEY]: { ...session, email: me.email, handle },
      });
    }
    return { signedIn: true, email: me.email, handle, emailAlerts: me.emailAlerts === true };
  } catch {
    // Offline: the cached address and handle are the last true things we know.
    // emailAlerts is deliberately NOT cached and reports false here — a switch
    // drawn from a stale cache could show "on" for an account that turned it
    // off on another browser, and of the two ways to be wrong about consent,
    // showing it off is the one that cannot mislead anybody into thinking they
    // are unsubscribed when they are not. The popup marks this state stale and
    // the switch reads from the backend the moment the network returns.
    return { signedIn: true, email: session.email, handle: session.handle ?? null, emailAlerts: false, stale: true };
  }
}

// The contribution switch, read at the one place every observation has to pass
// through. The popup's label says "Share what I browse", so it has to govern
// BOTH sighting paths — gating only the catalog collector would leave product
// pages reporting under a switch that reads as off. Only an explicit true —
// written when the person answers the popup's consent card or turns the
// switch on — contributes. Absent means the question hasn't been answered
// yet, and an unanswered question sends nothing: consent has to come before
// collection, not after it.
async function contributing() {
  const { jdCatalog } = await chrome.storage.local.get("jdCatalog");
  return jdCatalog === true;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    // client-side signal, no backend round trip of its own
    if (msg.type === "event") {
      await recordEvent(msg.name);
      return { ok: true };
    }
    const deviceId = await getDeviceId();
    switch (msg.type) {
      case "auth:state":
        return authState();
      // The panel's sign-in card asks for the popup, where the sign-in sheet
      // lives — a content script cannot open it itself. chrome.action.openPopup
      // exists from Chrome 127 and can still refuse (no focused window, or the
      // gesture didn't survive the message hop); either failure reaches the
      // card as a message-layer error, and its toast says where the popup is.
      case "auth:openPopup": {
        if (!chrome.action || !chrome.action.openPopup) throw new Error("unsupported");
        await chrome.action.openPopup();
        return { ok: true };
      }
      case "auth:request":
        // Always answers ok, for any syntactically valid address — the backend
        // deliberately can't tell you whether an account exists.
        return convexMutation("auth:requestCode", { email: msg.email });
      case "auth:verify": {
        const res = await convexAction("auth:verifyCode", {
          email: msg.email,
          code: msg.code,
          deviceId,
        });
        await chrome.storage.local.set({
          [SESSION_KEY]: { token: res.sessionToken, email: res.email },
        });
        // The token stays here. The caller learns what it needs to say.
        return { email: res.email, adoptedWatches: res.adoptedWatches };
      }
      // The one consent surface for the address's second use. Token stays in
      // the service worker, like every other account call.
      case "auth:emailAlerts": {
        const session = await getSession();
        if (session === null) return { ok: false, error: "SIGNED_OUT" };
        return convexMutation("auth:setEmailAlerts", {
          sessionToken: session.token,
          on: msg.on === true,
        });
      }
      case "auth:signOut": {
        const session = await getSession();
        // Local state clears either way: a caller that asked to sign out is
        // signed out, even if the backend never heard about it.
        await chrome.storage.local.remove(SESSION_KEY);
        if (session) {
          await convexMutation("auth:signOut", { sessionToken: session.token }).catch(() => {});
        }
        return { ok: true };
      }
      case "auth:claimHandle": {
        const session = await getSession();
        // Answered in the same shape the backend uses, so the caller has one
        // set of reasons to handle rather than two.
        if (!session) return { ok: false, reason: "NO_SESSION" };
        const res = await convexMutation("auth:claimHandle", {
          sessionToken: session.token,
          deviceId,
          handle: msg.handle,
        });
        // Cache it the moment it lands. The compose form re-reads auth:state
        // right after posting, and a round trip that answered "no handle" to
        // someone who just claimed one would send them back to the claim step.
        if (res.ok) {
          await chrome.storage.local.set({
            [SESSION_KEY]: { ...session, handle: res.handle },
          });
        }
        return res;
      }
      case "auth:delete": {
        const session = await getSession();
        if (!session) return { ok: true };
        // Not swallowed, unlike sign-out: a client that believes it deleted an
        // account that still exists is worse off than one told it failed.
        await convexMutation("auth:deleteAccount", { sessionToken: session.token });
        await chrome.storage.local.remove(SESSION_KEY);
        return { ok: true };
      }
      case "report":
        if (!(await contributing())) return { ok: false, reason: "CONTRIBUTION_OFF" };
        return convexMutation("observations:report", { deviceId, ...msg.data });
      // One grid page the shopper was already looking at. Nothing was fetched
      // to produce it — see the header of catalog.js. Refused in band by the
      // backend, and the caller discards the result either way.
      case "catalog:batch":
        if (!(await contributing())) return { ok: false, reason: "CONTRIBUTION_OFF" };
        return convexMutation("observations:reportBatch", {
          deviceId,
          storeNum: msg.storeNum,
          items: msg.items,
          // Behind `contributing()` with everything else, and that is not an
          // accident of placement: a selector tally is data leaving this
          // browser, so "Share what I browse" being off must mean the
          // telemetry stops too, not just the sightings.
          selectors: msg.selectors,
        });
      // The read half of the catalog surface: what have shoppers seen these
      // products cost? Deliberately NOT behind `contributing()` — that switch
      // governs what leaves this browser as an OBSERVATION, and withholding
      // price history from somebody who opted out of contributing would make it
      // a toll rather than a privacy control. Badges have their own switch.
      //
      // It carries product ids and nothing else. Not the URL, not the search
      // terms, not the filters — the same rule the batch write follows, for the
      // same reason (PRIVACY.md §3).
      case "catalog:summaries":
        return convexQuery("products:summaries", { productIds: msg.productIds });
      case "history":
        return convexQuery("products:history", {
          productId: msg.productId,
          // Prices are national; shelves are not. The chart keeps every
          // store's points, and only the shelf snapshot is scoped to wherever
          // the shopper is browsing.
          ...(msg.shelfStore ? { shelfStore: msg.shelfStore } : {}),
          // The store-scoped fields (shelf snapshot, per-store open-box price)
          // come back only with a session. The price series does not depend on
          // it. The token stays in the service worker, as everywhere else.
          ...(await scopeArg()),
        });
      // Cross-store open-box snapshot. Account-gated on the backend: signed
      // out it answers the empty shape, and the panel invites sign-in instead
      // of surfacing an error. Store numbers only — names live client-side.
      case "openbox:across":
        return convexQuery("products:openBoxAcross", {
          productId: msg.productId,
          ...(await scopeArg()),
        });
      // Reading stays anonymous; the token, when there is one, only marks the
      // caller's own votes in the answer.
      case "comments:list":
        return convexQuery("comments:list", {
          productId: msg.productId,
          ...(await scopeArg()),
        });
      // The session decides the author: the backend signs the comment with the
      // account's claimed handle, and there is no displayName argument any
      // more — participation requires sign-in, and a caller who could pick the
      // name on a ticked comment could wear anyone's. A signed-out call gets
      // the backend's SIGN_IN_REQUIRED refusal, which the panel surfaces while
      // keeping the typed body.
      case "comments:add":
        return convexMutation("comments:add", {
          productId: msg.productId,
          deviceId,
          body: msg.body,
          // Forwarding this is what makes a reply a reply. It was dropped here
          // while the renderer read it, so replies typed in the panel landed at
          // the top of the thread — invisible in the seeded data, which writes
          // parentId straight to the database.
          ...(msg.parentId ? { parentId: msg.parentId } : {}),
          ...(await scopeArg()),
        });
      case "comments:vote":
        return convexMutation("comments:vote", {
          commentId: msg.commentId,
          value: msg.value,
          ...(await scopeArg()),
        });
      case "comments:report":
        return convexMutation("comments:report", {
          commentId: msg.commentId,
          ...(await scopeArg()),
        });
      // Watches are account-scoped, full stop: signed in, the scope is the
      // person's whole watchlist on every browser; signed out, the mutations
      // refuse SIGN_IN_REQUIRED and the queries answer the signed-out shape.
      // deviceId still rides on toggle/setTarget only — it names this
      // browser's pre-sign-in row so the backend can adopt it into the account
      // at the moment of the write.
      case "watch:toggle":
        return convexMutation("watches:toggle", {
          deviceId,
          productId: msg.productId,
          ...(await scopeArg()),
        });
      case "watch:setTarget":
        return convexMutation("watches:setTarget", {
          deviceId,
          productId: msg.productId,
          targetPrice: msg.targetPrice,
          ...(await scopeArg()),
        });
      case "watch:setTriggers":
        return convexMutation("watches:setTriggers", {
          productId: msg.productId,
          storeNum: msg.storeNum,
          price: msg.price,
          openBox: msg.openBox,
          restock: msg.restock,
          ...(await scopeArg()),
        });
      // Store numbers are all the backend knows; the names live on Micro
      // Center's own page. content.js reads the picker whenever somebody
      // loads a product page and parks the map here, so a notification fired
      // hours later from a service worker with no tab open can still say
      // "Westmont" instead of "store #045". Display only — nothing is sent.
      case "stores:learn":
        return learnStoreNames(msg.names);
      case "watch:dashboard":
        return convexQuery("watches:dashboard", { ...(await scopeArg()) });
      case "watch:status":
        return convexQuery("watches:status", {
          productId: msg.productId,
          ...(await scopeArg()),
        });
      default:
        throw new Error("Unknown message type: " + msg.type);
    }
  })()
    .then((result) => sendResponse({ result }))
    .catch((e) => {
      // a failed data call is exactly what telemetry exists to surface
      const map = {
        report: "report_failed",
        // Same counter as the single report: both are "a sighting didn't land",
        // and splitting them would add a name to the fixed telemetry list for a
        // distinction nothing acts on.
        "catalog:batch": "report_failed",
        history: "history_failed",
        // Same counter as the product-page lookup: both are "we couldn't tell
        // the shopper what this has cost", which is the one thing the name
        // means. A separate name would add an entry to the fixed telemetry list
        // for a distinction nothing acts on.
        "catalog:summaries": "history_failed",
        "comments:list": "comments_failed",
      };
      if (map[msg.type]) recordEvent(map[msg.type]);
      sendResponse({ error: String(e && e.message ? e.message : e), code: e && e.code });
    });
  return true; // async response
});

// ---------- Alerts ----------

// Micro Center prints "$15,299.99"; every price string in Jackdaw matches it.
const money = (p) =>
  "$" + p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * What a firing watch says, per reason.
 *
 * Every one of these describes SOMETHING A SHOPPER SAW, at a time, and says so.
 * That is not hedging for its own sake — an open-box unit is a single physical
 * item and nothing can tell us it sold except another person walking past it,
 * so a notification that reads like a live inventory feed is a promise the data
 * cannot keep and a wasted trip for whoever believes it. The age is in every
 * message for the same reason.
 *
 * Two phrases are deliberate and should not be softened away: "may already be
 * gone" on open box, and "stock isn't held" on restock. Micro Center sells
 * reservations as their own feature ("Reserve Now"); an alert of ours that
 * reads like one is simply untrue.
 */
async function notificationFor(d) {
  const where = await storeLabel(d.storeNum);
  const seen = ageLabel(d.observedAt);
  const price = money(d.currentPrice);

  if (d.reason === "openBox" && d.openBoxPrice !== undefined) {
    return {
      title: `Open box at ${where}: ${money(d.openBoxPrice)}`,
      message: `${d.name}\nNew ${price} · one unit seen ${seen} — it may already be gone`,
    };
  }
  if (d.reason === "restock") {
    return {
      title: `Back in stock at ${where}`,
      message: `${d.name}\n${price} · seen ${seen} — stock isn't held`,
    };
  }
  // The price trigger is store-blind by design (watches.ts takes the newest row
  // from ANY store), so `d.storeNum` can be a pseudo-store — and "seen at
  // store #029" names a place with no shelves. Drop the place, keep the age.
  const placed = !NON_PHYSICAL_STORES.has(d.storeNum);
  return {
    title: `Price drop: ${price}`,
    message:
      `${d.name}\nYour target ${money(d.priceAtWatch)}` +
      (placed ? ` · seen at ${where} ${seen}` : ` · seen ${seen}`),
  };
}

const ALARM = "jackdaw-watch-check";

function ensureAlarm() {
  chrome.alarms.get(ALARM, (a) => {
    if (!a) chrome.alarms.create(ALARM, { delayInMinutes: 2, periodInMinutes: 60 });
  });
}
// A toolbar dot while the contribution question is still open — jdCatalog
// absent means unanswered, and unanswered sends nothing, so the dot marks
// "there is a question waiting", not "something is wrong". Cleared the moment
// either answer lands, from any surface. setBadgeTextColor is Chrome 110+;
// optional-chaining keeps older Chromiums from throwing over a cosmetic call.
async function refreshConsentBadge() {
  try {
    const { jdCatalog } = await chrome.storage.local.get("jdCatalog");
    if (jdCatalog === undefined) {
      chrome.action.setBadgeText({ text: "•" });
      chrome.action.setBadgeBackgroundColor({ color: "#0e7a37" });
      chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  } catch {
    // cosmetic; never let the badge break the worker
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  ensureAlarm();
  refreshConsentBadge();
  // The welcome page opens once, on a fresh install only — never on an
  // update or a browser restart. It is where the contribution question is
  // first asked, before any collection could happen.
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  }
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  refreshConsentBadge();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.jdCatalog) refreshConsentBadge();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  await flushEvents(); // hourly, and only when something is buffered
  try {
    // Alerts are account-scoped now: signed out, there is nothing to check —
    // skip cleanly rather than ask the server a question whose answer is [].
    // Read the token once and reuse it for the acks: a sign-out landing
    // mid-loop would otherwise ack some drops and refuse the rest, from one
    // pass over one list.
    const scope = await scopeArg();
    if (!scope.sessionToken) return;
    const drops = await convexQuery("watches:check", { ...scope });
    for (const d of drops) {
      const { title, message } = await notificationFor(d);
      chrome.notifications.create(d.urlPath, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title,
        message,
        priority: 1,
      });
      await convexMutation("watches:ack", {
        productId: d.productId,
        newPrice: d.currentPrice,
        ...scope,
      });
    }
  } catch {
    // network hiccups are fine; next hourly tick retries
  }
});

// Micro Center's own slugs can carry an undecoded HTML numeric character
// reference: product 684336's path ends `...with-900&#181;m-fiber-holder`, the
// micro sign arriving from `dataLayer.pageUrl` as those seven literal characters
// because a script body is not HTML and nothing ever decodes it. The stored path
// is right and stays that way — `normalizeUrlPath` in convex/lib.ts deliberately
// does not cut there — but concatenated onto the origin that `#` is a fragment
// delimiter, so the browser navigates to `.../with-900&` and 404s. `encodeURI`
// does NOT help; it leaves `#` and `&` alone as reserved characters. Escape the
// one character whose meaning changes on the way into a URL.
//
// Duplicated in popup.js: a popup script and a service worker share no module
// here, and the alternative is a file that exists only to hold one expression.
const productUrl = (urlPath) =>
  "https://www.microcenter.com" + String(urlPath).replace(/#/g, "%23");

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith("/")) return;
  chrome.tabs.create({ url: productUrl(notificationId) });
  chrome.notifications.clear(notificationId);
  // A click is the one moment we can honestly say Jackdaw sent someone to a
  // store's product page. Counted in aggregate only (no device, no product).
  convexMutation("metrics:alertClicked", {}).catch(() => {});
});
