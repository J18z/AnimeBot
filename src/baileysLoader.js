// تحميل مكتبة Baileys بطريقة تشتغل مع النسختين:
//  • 6.x (CommonJS): تحميل عادي
//  • 7.x (ESM فقط): لازم import() ديناميكي — require العادي ما يشتغل معها
// نحمّلها مرة وحدة بأول main() ونخزّن الرموز اللي نحتاجها، وباقي الملفات
// تاخذها بـbaileys() بعد التحميل (بدل require بأول الملف).

let api = null;

async function loadBaileys() {
  if (api) return api;
  const ns = await import("@whiskeysockets/baileys");
  const d = ns.default;
  const pick = (name) => (ns[name] !== undefined ? ns[name] : d && typeof d === "object" ? d[name] : undefined);
  // ESM (v7): default = makeWASocket نفسه. CJS (v6): default = كائن فيه default
  const makeWASocket = typeof d === "function" ? d : (d && d.default) || ns.makeWASocket;
  api = {
    makeWASocket,
    useMultiFileAuthState: pick("useMultiFileAuthState"),
    DisconnectReason: pick("DisconnectReason"),
    fetchLatestBaileysVersion: pick("fetchLatestBaileysVersion"),
    proto: pick("proto"),
    initAuthCreds: pick("initAuthCreds"),
    BufferJSON: pick("BufferJSON"),
    downloadContentFromMessage: pick("downloadContentFromMessage"),
  };
  return api;
}

// وصول متزامن بعد التحميل. لو ما انحمّلت (مثلاً اختبارات)، نجرب require عادي
function baileys() {
  if (api) return api;
  const m = require("@whiskeysockets/baileys");
  return {
    makeWASocket: m.default,
    useMultiFileAuthState: m.useMultiFileAuthState,
    DisconnectReason: m.DisconnectReason,
    fetchLatestBaileysVersion: m.fetchLatestBaileysVersion,
    proto: m.proto,
    initAuthCreds: m.initAuthCreds,
    BufferJSON: m.BufferJSON,
    downloadContentFromMessage: m.downloadContentFromMessage,
  };
}

module.exports = { loadBaileys, baileys };
