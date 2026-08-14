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

async function convexCall(kind, path, args) {
  const res = await fetch(`${CONVEX_URL}/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const json = await res.json();
  if (json.status === "success") return json.value;
  const err = new Error(json.errorMessage || "Convex call failed");
  if (json.errorData && json.errorData.code) err.code = json.errorData.code;
  throw err;
}

const convexQuery = (path, args) => convexCall("query", path, args);
const convexMutation = (path, args) => convexCall("mutation", path, args);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
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
      case "watch:status":
        return convexQuery("watches:status", { deviceId, productId: msg.productId });
      default:
        throw new Error("Unknown message type: " + msg.type);
    }
  })()
    .then((result) => sendResponse({ result }))
    .catch((e) => sendResponse({ error: String(e && e.message ? e.message : e), code: e && e.code }));
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
  if (notificationId.startsWith("/")) {
    chrome.tabs.create({ url: "https://www.microcenter.com" + notificationId });
    chrome.notifications.clear(notificationId);
  }
});
