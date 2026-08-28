// تصاريح اللعب بالخاص: المسابقات مقفولة افتراضياً بالخاص للجميع عدا
// صاحب البوت (يشتغل معه بالخاص طبيعي دايمًا). هذا الملف يدير استثناءات
// يديها صاحب البوت لأشخاص معيّنين (أمر مخفي .سماح / .الغاء سماح — ما
// يظهر بقائمة .ريم اوامر). تبقى بالذاكرة للسرعة، وتنحفظ بالخلفية
// بقاعدة البيانات (لو متوفرة) — نفس أسلوب moderation.js بالضبط

const { getDb } = require("./db");

const allowed = new Set(); // userId مسموح له يلعب بالخاص

async function persist(userId, exists) {
  const db = getDb();
  if (!db) return;
  try {
    const col = db.collection("dmAllowed");
    if (exists) {
      await col.updateOne({ _id: userId }, { $set: { userId } }, { upsert: true });
    } else {
      await col.deleteOne({ _id: userId });
    }
  } catch (err) {
    console.error("خطأ حفظ تصريح اللعب بالخاص:", err.message);
  }
}

function allow(userId) {
  allowed.add(userId);
  persist(userId, true);
}

function disallow(userId) {
  allowed.delete(userId);
  persist(userId, false);
}

function isAllowed(userId) {
  return allowed.has(userId);
}

async function loadFromDb() {
  const db = getDb();
  if (!db) return;
  try {
    const docs = await db.collection("dmAllowed").find({}).toArray();
    docs.forEach((d) => allowed.add(d._id));
    console.log(`📥 تحميل ${docs.length} تصريح لعب بالخاص من قاعدة البيانات.`);
  } catch (err) {
    console.error("خطأ تحميل تصاريح اللعب بالخاص:", err.message);
  }
}

module.exports = { allow, disallow, isAllowed, loadFromDb };
