// قفل أوامر التوب (.قفل توب / .فتح توب — للمالك بس). الحالة بالذاكرة وتنحفظ
// بقاعدة البيانات (لو متوفرة) عشان تبقى بعد إعادة التشغيل
const { getDb } = require("./db");

let locked = false;

function isLocked() {
  return locked;
}

async function setLocked(value) {
  locked = !!value;
  const db = getDb();
  if (!db) return;
  try {
    await db.collection("settings").updateOne({ _id: "topLock" }, { $set: { locked } }, { upsert: true });
  } catch (err) {
    console.error("خطأ حفظ حالة قفل التوب:", err.message);
  }
}

async function loadFromDb() {
  const db = getDb();
  if (!db) return;
  try {
    const doc = await db.collection("settings").findOne({ _id: "topLock" });
    if (doc) locked = !!doc.locked;
    if (locked) console.log("🔒 أوامر التوب مقفولة (للمالك بس).");
  } catch (err) {
    console.error("خطأ تحميل حالة قفل التوب:", err.message);
  }
}

module.exports = { isLocked, setLocked, loadFromDb };
