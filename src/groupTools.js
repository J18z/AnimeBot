// أدوات قروبات واتساب: مطابقة أعضاء القروب، فحص إشراف البوت، وتجهيز رسائل منشن للجميع.
// منفصلة عن index.js عشان تنختبر بدون واتساب

function digits(jid) {
  return String(jid || "").split("@")[0].split(":")[0];
}

// عضو القروب (participant) يطابق هذا الآيدي؟ يفحص id و lid و phoneNumber (واتساب الجديد يخلط بينهم)
function participantMatches(p, jidLike) {
  const want = digits(jidLike);
  if (!want) return false;
  return [p.id, p.lid, p.phoneNumber].filter(Boolean).some((x) => digits(x) === want);
}

function findParticipant(meta, jidLike) {
  return (meta.participants || []).find((p) => participantMatches(p, jidLike)) || null;
}

function isAdminParticipant(p) {
  return !!p && (p.admin === "admin" || p.admin === "superadmin");
}

// عضو القروب اللي هو البوت نفسه (sock.user: { id, lid })
function botParticipant(meta, user) {
  const ids = [user && user.id, user && user.lid].filter(Boolean);
  return (meta.participants || []).find((p) => ids.some((i) => participantMatches(p, i))) || null;
}

// يجهّز رسائل منشن للجميع: كل رسالة فيها حد أقصى perMessage شخص (القروبات الكبيرة تتقسم لعدة رسائل)
function mentionBlocks(participants, { exclude = [], note = "", perMessage = 200 } = {}) {
  const skip = new Set(exclude.map(digits));
  const list = (participants || []).filter((p) => !skip.has(digits(p.id)));
  const blocks = [];
  for (let i = 0; i < list.length; i += perMessage) {
    const chunk = list.slice(i, i + perMessage);
    let text = i === 0 ? `📢 *منشن للجميع*${note ? `\n${note}` : ""}\n` : "";
    text += "\n" + chunk.map((p) => "@" + digits(p.id)).join(" ");
    blocks.push({ text, mentions: chunk.map((p) => p.id) });
  }
  return blocks;
}

module.exports = { digits, participantMatches, findParticipant, isAdminParticipant, botParticipant, mentionBlocks };
