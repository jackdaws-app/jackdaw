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

// ---------- Optional accounts ----------
// Anonymous stays complete: nothing here is required by any feature. An
// account exists so alerts survive clearing browser data, and signing in
// adopts the watches this device already has rather than starting over.
//
// The session token is a bearer credential — whoever holds it is the account —
// so it lives only in the service worker's storage and is NEVER returned to a
// caller. Content scripts run inside a page Micro Center controls; they get to
// know *whether* someone is signed in, and their address, and nothing else.

const SESSION_KEY = "jdSession";

async function getSession() {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  const session = stored[SESSION_KEY];
  return session && session.token ? session : null;
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
    if (me.email !== session.email) {
      await chrome.storage.local.set({ [SESSION_KEY]: { ...session, email: me.email } });
    }
    return { signedIn: true, email: me.email };
  } catch {
    return { signedIn: true, email: session.email, stale: true };
  }
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
        return convexMutation("observations:report", { deviceId, ...msg.data });
      case "history":
        return convexQuery("products:history", { productId: msg.productId });
      case "comments:list":
        return convexQuery("comments:list", { productId: msg.productId, deviceId });
      case "comments:add":
        return convexMutation("comments:add", {
          productId: msg.productId,
          deviceId,
          displayName: msg.displayName,
          body: msg.body,
        });
      case "comments:vote":
        return convexMutation("comments:vote", { commentId: msg.commentId, deviceId, value: msg.value });
      case "comments:report":
        return convexMutation("comments:report", { commentId: msg.commentId, deviceId });
      case "watch:toggle":
        return convexMutation("watches:toggle", { deviceId, productId: msg.productId });
      case "watch:setTarget":
        return convexMutation("watches:setTarget", { deviceId, productId: msg.productId, targetPrice: msg.targetPrice });
      case "watch:dashboard":
        return convexQuery("watches:dashboard", { deviceId });
      case "watch:status":
        return convexQuery("watches:status", { deviceId, productId: msg.productId });
      default:
        throw new Error("Unknown message type: " + msg.type);
    }
  })()
    .then((result) => sendResponse({ result }))
    .catch((e) => {
      // a failed data call is exactly what telemetry exists to surface
      const map = { report: "report_failed", history: "history_failed", "comments:list": "comments_failed" };
      if (map[msg.type]) recordEvent(map[msg.type]);
      sendResponse({ error: String(e && e.message ? e.message : e), code: e && e.code });
    });
  return true; // async response
});

// ---------- Price-drop alerts ----------

const ALARM = "jackdaw-watch-check";

function ensureAlarm() {
  chrome.alarms.get(ALARM, (a) => {
    if (!a) chrome.alarms.create(ALARM, { delayInMinutes: 2, periodInMinutes: 60 });
  });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  await flushEvents(); // hourly, and only when something is buffered
  try {
    const deviceId = await getDeviceId();
    const drops = await convexQuery("watches:check", { deviceId });
    for (const d of drops) {
      chrome.notifications.create(d.urlPath, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: `Price drop: $${d.currentPrice.toFixed(2)}`,
        message: `${d.name}\nYour target: $${d.priceAtWatch.toFixed(2)} · store #${d.storeNum}`,
        priority: 1,
      });
      await convexMutation("watches:ack", { deviceId, productId: d.productId, newPrice: d.currentPrice });
    }
  } catch {
    // network hiccups are fine; next hourly tick retries
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith("/")) return;
  chrome.tabs.create({ url: "https://www.microcenter.com" + notificationId });
  chrome.notifications.clear(notificationId);
  // A click is the one moment we can honestly say Jackdaw sent someone to a
  // store's product page. Counted in aggregate only (no device, no product).
  convexMutation("metrics:alertClicked", {}).catch(() => {});
});
