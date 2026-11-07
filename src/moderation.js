// أوامر إشراف لصاحب البوت:
// - إيقاف: يلعب عادي وتُحسب نقاطه بالعام، بس يُستبعد من قوائم الجوالات
// - حظر: يُمنع كلياً، البوت يتجاهل رسائله بالمسابقات تماماً
// تبقى بالذاكرة للسرعة، وتنحفظ بالخلفية بقاعدة البيانات (لو متوفرة)

const { getDb } = require("./db");

const suspended = new Set(); // مستبعدين من قوائم الجوالات بس
// 🏷️ إجراءات ادمن الشات: على مستوى قروب واحد (chatId -> Set(userId)) وتأثيرها بهذا القروب فقط
const chatSuspended = new Map();
const chatBanned = new Map();
const banned = new Set(); // محظورين كلياً

async function persistSet(collectionName, userId, exists) {
  const db = getDb();
  if (!db) return;
  try {
    const col = db.collection(collectionName);
    if (exists) {
      await col.updateOne({ _id: userId }, { $set: { userId } }, { upsert: true });
    } else {
      await col.deleteOne({ _id: userId });
    }
  } catch (err) {
    console.error(`خطأ حفظ ${collectionName}:`, err.message);
  }
}

async function persistChat(collectionName, chatId, map) {
  const db = getDb();
  if (!db) return;
  try {
    const col = db.collection(collectionName);
    const set = map.get(chatId);
    if (set && set.size > 0) await col.updateOne({ _id: chatId }, { $set: { users: [...set] } }, { upsert: true });
    else await col.deleteOne({ _id: chatId });
  } catch (err) {
    console.error(`خطأ حفظ ${collectionName}:`, err.message);
  }
}

function chatAdd(map, collectionName, chatId, userId) {
  if (!map.has(chatId)) map.set(chatId, new Set());
  map.get(chatId).add(userId);
  persistChat(collectionName, chatId, map);
}

function chatDelete(map, collectionName, chatId, userId) {
  const set = map.get(chatId);
  if (!set || !set.delete(userId)) return;
  if (set.size === 0) map.delete(chatId);
  persistChat(collectionName, chatId, map);
}

// chatId (اختياري): لو انكتب يصير الإجراء بهذا القروب فقط (ادمن الشات). بدونه = عام بكل القروبات.
// الرفع بدون chatId (المالك/الادمن العام) يشيل العام وكل القروبات
function suspend(userId, chatId) {
  if (chatId) return chatAdd(chatSuspended, "chatSuspended", chatId, userId);
  suspended.add(userId);
  persistSet("suspended", userId, true);
}

function unsuspend(userId, chatId) {
  if (chatId) return chatDelete(chatSuspended, "chatSuspended", chatId, userId);
  suspended.delete(userId);
  persistSet("suspended", userId, false);
  for (const c of [...chatSuspended.keys()]) chatDelete(chatSuspended, "chatSuspended", c, userId);
}

function isSuspended(userId, chatId) {
  if (suspended.has(userId)) return true;
  const set = chatId ? chatSuspended.get(chatId) : null;
  return !!set && set.has(userId);
}

function isSuspendedGlobal(userId) {
  return suspended.has(userId);
}

function ban(userId, chatId) {
  if (chatId) return chatAdd(chatBanned, "chatBanned", chatId, userId);
  banned.add(userId);
  persistSet("banned", userId, true);
}

function unban(userId, chatId) {
  if (chatId) return chatDelete(chatBanned, "chatBanned", chatId, userId);
  banned.delete(userId);
  persistSet("banned", userId, false);
  for (const c of [...chatBanned.keys()]) chatDelete(chatBanned, "chatBanned", c, userId);
}

function isBanned(userId, chatId) {
  if (banned.has(userId)) return true;
  const set = chatId ? chatBanned.get(chatId) : null;
  return !!set && set.has(userId);
}

function isBannedGlobal(userId) {
  return banned.has(userId);
}

async function loadFromDb() {
  const db = getDb();
  if (!db) return;
  try {
    const suspendedDocs = await db.collection("suspended").find({}).toArray();
    suspendedDocs.forEach((d) => suspended.add(d._id));
    const bannedDocs = await db.collection("banned").find({}).toArray();
    bannedDocs.forEach((d) => banned.add(d._id));
    (await db.collection("chatSuspended").find({}).toArray()).forEach((d) => {
      if (Array.isArray(d.users) && d.users.length) chatSuspended.set(d._id, new Set(d.users));
    });
    (await db.collection("chatBanned").find({}).toArray()).forEach((d) => {
      if (Array.isArray(d.users) && d.users.length) chatBanned.set(d._id, new Set(d.users));
    });
    console.log(`📥 تحميل ${suspendedDocs.length} موقوف و${bannedDocs.length} محظور من قاعدة البيانات.`);
  } catch (err) {
    console.error("خطأ تحميل بيانات الإشراف:", err.message);
  }
}

module.exports = { suspend, unsuspend, isSuspended, isSuspendedGlobal, ban, unban, isBanned, isBannedGlobal, loadFromDb };
