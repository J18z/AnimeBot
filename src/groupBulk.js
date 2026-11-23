// ترقية/تنزيل عدة أشخاص دفعة وحدة + قائمة "لا تمنشني" (.الغ_منشن) — مشتركة بين البوت العام وماتسوري
const gt = require("./groupTools");
const S = require("../matsuri/mStore");

// كل المنشنات برسالة (أو صاحب الرسالة المردود عليها لو ما فيه منشن)
function allTargets(msg) {
  const m = (msg && msg.message) || {};
  const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m;
  const c = inner.extendedTextMessage?.contextInfo || inner.imageMessage?.contextInfo || inner.videoMessage?.contextInfo || null;
  if (!c) return [];
  if (c.mentionedJid && c.mentionedJid.length) return [...new Set(c.mentionedJid)];
  if (c.quotedMessage && c.participant) return [c.participant];
  return [];
}

const BATCH = 30;
// ينفّذ promote/demote لقائمة. blockReason(id) اختياري يرجع نص منع. يرجع { text, mentions }
async function bulkAdmin(sock, chatId, meta, ids, action, blockReason) {
  const promote = action === "promote";
  const ok = [];
  const skip = []; // [id, سبب]
  const seen = new Set();
  for (const raw of ids) {
    const p = gt.findParticipant(meta, raw);
    if (!p) {
      skip.push([raw, "مو بالقروب"]);
      continue;
    }
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const isAdm = gt.isAdminParticipant(p);
    if (promote && isAdm) skip.push([p.id, "مشرف أصلاً"]);
    else if (!promote && !isAdm) skip.push([p.id, "مو مشرف أصلاً"]);
    else if (!promote && p.admin === "superadmin") skip.push([p.id, "منشئ القروب"]);
    else {
      const b = blockReason && blockReason(p.id);
      if (b) skip.push([p.id, "محمي"]);
      else ok.push(p.id);
    }
  }
  const done = [];
  for (let i = 0; i < ok.length; i += BATCH) {
    const batch = ok.slice(i, i + BATCH);
    try {
      const res = await sock.groupParticipantsUpdate(chatId, batch, action);
      const byJid = new Map((Array.isArray(res) ? res : []).map((r) => [gt.digits(r.jid), String(r.status || "200")]));
      for (const id of batch) {
        const st = byJid.get(gt.digits(id));
        if (!st || st.startsWith("2")) done.push(id);
        else skip.push([id, `رفض واتساب (${st})`]);
      }
    } catch (e) {
      console.error("⚠️ ترقية/تنزيل جماعي:", e && e.message);
      for (const id of batch) skip.push([id, "فشل التنفيذ"]);
    }
  }
  const tag = (id) => "@" + gt.digits(id);
  const lines = [];
  if (done.length) lines.push(`${promote ? "✅ تمت ترقية" : "✅ تم تنزيل"} (${done.length}): ${done.map(tag).join(" ")}`);
  if (skip.length) lines.push(`⚠️ ما انتنفذ (${skip.length}):\n` + skip.map(([id, why]) => `- ${/^\d/.test(id) ? tag(id) : tag(id)} — ${why}`).join("\n"));
  if (!lines.length) lines.push("ما فيه أحد ينفذ عليه.");
  return { text: lines.join("\n\n"), mentions: [...done, ...skip.map((s) => s[0])] };
}

// ── من لا يبي منشن جماعي ──
// قائمتين منفصلتين: scope = "matsuri" | "general"
const optKey = (scope) => "mentionOptOut_" + (scope === "matsuri" ? "matsuri" : "general");
function optSet(scope) {
  return new Set((S.getSetting(optKey(scope)) || []).map(String));
}
function idDigits(meta, jid) {
  const p = meta ? gt.findParticipant(meta, jid) : null;
  const all = [jid, ...(p ? [p.id, p.lid, p.phoneNumber] : [])].filter(Boolean).map(gt.digits);
  return [...new Set(all)];
}
function optOut(meta, jid, scope) {
  const set = optSet(scope);
  const ds = idDigits(meta, jid);
  if (ds.every((d) => set.has(d))) return false;
  ds.forEach((d) => set.add(d));
  S.setSetting(optKey(scope), [...set]);
  return true;
}
function optIn(meta, jid, scope) {
  const set = optSet(scope);
  const ds = idDigits(meta, jid);
  if (!ds.some((d) => set.has(d))) return false;
  ds.forEach((d) => set.delete(d));
  S.setSetting(optKey(scope), [...set]);
  return true;
}
function isOptedOut(p, scope) {
  const set = optSet(scope);
  if (!set.size) return false;
  return [p.id, p.lid, p.phoneNumber].filter(Boolean).some((x) => set.has(gt.digits(x)));
}
function filterOptOut(participants, scope) {
  return (participants || []).filter((p) => !isOptedOut(p, scope));
}
// أرقام مكتوبة نصاً (@9677… أو رقم جوال طويل) داخل النص → jid
function typedNumbers(text) {
  return [...String(text || "").replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).matchAll(/@?(\d{7,15})/g)].map((m) => m[1] + "@s.whatsapp.net");
}

module.exports = { allTargets, bulkAdmin, optOut, optIn, isOptedOut, filterOptOut, typedNumbers };
