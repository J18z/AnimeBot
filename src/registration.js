// تسجيل نوع جهاز كل شخص (جوال / خارجي) + اسمه — بالثقة، البوت ما يتحقق تقنياً
// يبقى بالذاكرة للسرعة، وينحفظ بالخلفية بقاعدة البيانات (لو متوفرة)

const { getDb } = require("./db");

const registry = new Map(); // userId -> { type: "mobile"|"external", displayName }

// يحفظ تسجيل شخص وحد بالخلفية (بدون ما يعطّل بقية الكود)
async function persistOne(userId) {
  const db = getDb();
  if (!db) return;
  try {
    const e = registry.get(userId);
    if (!e) return;
    await db.collection("registrations").updateOne(
      { _id: userId },
      { $set: { type: e.type, displayName: e.displayName } },
      { upsert: true }
    );
  } catch (err) {
    console.error("خطأ حفظ التسجيل:", err.message);
  }
}

async function persistDelete(userId) {
  const db = getDb();
  if (!db) return;
  try {
    await db.collection("registrations").deleteOne({ _id: userId });
  } catch (err) {
    console.error("خطأ حذف التسجيل:", err.message);
  }
}

function register(userId, type, displayName) {
  const existing = registry.get(userId) || {};
  registry.set(userId, {
    type,
    displayName: displayName || existing.displayName || userId.split("@")[0],
  });
  persistOne(userId); // بدون انتظار، يشتغل بالخلفية
}

function getType(userId) {
  const e = registry.get(userId);
  return e ? e.type : null;
}

function isMobile(userId) {
  return getType(userId) === "mobile";
}

function unregister(userId) {
  registry.delete(userId);
  persistDelete(userId);
}

// يرجع كل المسجلين من نوع معين، بصيغة {userId, displayName} (لأمر .قائمة)
function getAllByType(type) {
  return [...registry.entries()]
    .filter(([, e]) => e.type === type)
    .map(([userId, e]) => ({ userId, displayName: e.displayName }));
}

// يسحب كل التسجيلات المحفوظة من قاعدة البيانات (يُستدعى مرة وحدة عند التشغيل)
async function loadFromDb() {
  const db = getDb();
  if (!db) return;
  try {
    const docs = await db.collection("registrations").find({}).toArray();
    for (const doc of docs) {
      registry.set(doc._id, { type: doc.type, displayName: doc.displayName });
    }
    console.log(`📥 تحميل ${docs.length} تسجيل من قاعدة البيانات.`);
  } catch (err) {
    console.error("خطأ تحميل التسجيلات:", err.message);
  }
}

module.exports = { register, getType, isMobile, unregister, getAllByType, loadFromDb };
