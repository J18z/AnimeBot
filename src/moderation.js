// أوامر إشراف لصاحب البوت:
// - إيقاف: يلعب عادي وتُحسب نقاطه بالعام، بس يُستبعد من قوائم الجوالات
// - حظر: يُمنع كلياً، البوت يتجاهل رسائله بالمسابقات تماماً
// تبقى بالذاكرة للسرعة، وتنحفظ بالخلفية بقاعدة البيانات (لو متوفرة)

const { getDb } = require("./db");

const suspended = new Set(); // مستبعدين من قوائم الجوالات بس
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

function suspend(userId) {
  suspended.add(userId);
  persistSet("suspended", userId, true);
}

function unsuspend(userId) {
  suspended.delete(userId);
  persistSet("suspended", userId, false);
}

function isSuspended(userId) {
  return suspended.has(userId);
}

function ban(userId) {
  banned.add(userId);
  persistSet("banned", userId, true);
}

function unban(userId) {
  banned.delete(userId);
  persistSet("banned", userId, false);
}

function isBanned(userId) {
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
    console.log(`📥 تحميل ${suspendedDocs.length} موقوف و${bannedDocs.length} محظور من قاعدة البيانات.`);
  } catch (err) {
    console.error("خطأ تحميل بيانات الإشراف:", err.message);
  }
}

module.exports = { suspend, unsuspend, isSuspended, ban, unban, isBanned, loadFromDb };
