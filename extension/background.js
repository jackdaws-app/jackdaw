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

async function convexCall(kind, path, args, attempt = 0) {
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
    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, 900));
      return convexCall(kind, path, args, 1);
    }
    const err = new Error("network");
    err.code = "NETWORK";
    throw err;
  }
  if (res.status >= 500 && attempt === 0) {
    await new Promise((r) => setTimeout(r, 900));
    return convexCall(kind, path, args, 1);
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    // client-side signal, no backend round trip of its own
    if (msg.type === "event") {
      await recordEvent(msg.name);
      return { ok: true };
    }
    const deviceId = await getDeviceId();
    switch (msg.type) {
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
