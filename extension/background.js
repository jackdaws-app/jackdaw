// Service worker: owns the anonymous device id and all network calls to the
// Convex backend via its plain HTTP API (no client library needed).
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
  throw new Error(json.errorMessage || "Convex call failed");
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
      default:
        throw new Error("Unknown message type: " + msg.type);
    }
  })()
    .then((result) => sendResponse({ result }))
    .catch((e) => sendResponse({ error: String(e && e.message ? e.message : e) }));
  return true; // async response
});
