// تسجيل نوع جهاز كل شخص (جوال / خارجي) + اسمه — بالثقة، البوت ما يتحقق تقنياً
// يبقى بالذاكرة للسرعة، وينحفظ فوراً بقاعدة البيانات (لو متوفرة)

const { getDb } = require("./db");

const registry = new Map(); // userId -> { type: "mobile"|"external", displayName, active }

// يحفظ تسجيل شخص وحد. مهم: ننتظرها (await) بعمليات التسجيل/الإلغاء —
// لأن البوت يمكن يعيد التشغيل بأي لحظة (خمول سيرفر مجاني، إعادة نشر،
// انقطاع مؤقت)، ولو الحفظ "بالخلفية بدون انتظار" ما اكتمل قبل إعادة
// التشغيل، ينضاع التسجيل بالكامل من قاعدة البيانات وكأنه ما صار
async function persistOne(userId) {
  const db = getDb();
  if (!db) return;
  try {
    const e = registry.get(userId);
    if (!e) return;
    await db.collection("registrations").updateOne(
      { _id: userId },
      { $set: { type: e.type, displayName: e.displayName, active: e.active } },
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

async function register(userId, type, displayName) {
  const existing = registry.get(userId) || {};
  registry.set(userId, {
    type,
    displayName: displayName || existing.displayName || userId.split("@")[0],
    active: true,
  });
  await persistOne(userId); // ننتظرها هنا عمداً — عملية نادرة، والصحة أهم من السرعة
}

function getType(userId) {
  const e = registry.get(userId);
  return e && e.active ? e.type : null;
}

// آخر نوع اتسجل فيه الشخص، حتى لو ألغى تسجيله بنفسه (.الغاء تسجيل) —
// نستخدمها عشان نمنعه يسجل بنوع مختلف مباشرة بدون موافقة صاحب البوت
function getLastType(userId) {
  const e = registry.get(userId);
  return e ? e.type : null;
}

function isMobile(userId) {
  return getType(userId) === "mobile";
}

// إلغاء تسجيل "ناعم" (يستخدمه الشخص لنفسه بـ.الغاء تسجيل): يوقف تسجيله
// الحالي بس يحتفظ بنوعه القديم بالذاكرة، عشان لو حاول يسجل بنوع مختلف
// بعدها مباشرة، يوقفه القفل ويوجّهه لأمر .تغيير تسجيل (يحتاج موافقة)
async function unregister(userId) {
  const existing = registry.get(userId);
  if (!existing) return;
  existing.active = false;
  await persistOne(userId);
}

// حذف كامل (يستخدمه صاحب البوت بـ.ازالة/.ازالة تصفير): يمسح كل أثر
// للشخص، بما فيها القفل، فيقدر يسجل بأي نوع يبيه من جديد بحرية
async function hardDelete(userId) {
  registry.delete(userId);
  await persistDelete(userId);
}

// يمسح كل التسجيلات كاملة (بالذاكرة وبقاعدة البيانات) — يستخدمها صاحب
// البوت بأمر .ريسيت تسجيلات لما يبي الجميع يسجلوا نوع جهازهم من جديد
async function resetAll() {
  const allIds = [...registry.keys()];
  registry.clear();
  const db = getDb();
  if (!db) return;
  try {
    await db.collection("registrations").deleteMany({});
  } catch (err) {
    console.error("خطأ تصفير كل التسجيلات:", err.message);
  }
  return allIds.length;
}

// يرجع كل المسجلين النشيطين من نوع معين، بصيغة {userId, displayName} (لأمر .تسجيلات)
function getAllByType(type) {
  return [...registry.entries()]
    .filter(([, e]) => e.active && e.type === type)
    .map(([userId, e]) => ({ userId, displayName: e.displayName }));
}

// يسحب كل التسجيلات المحفوظة من قاعدة البيانات (يُستدعى مرة وحدة عند التشغيل)
async function loadFromDb() {
  const db = getDb();
  if (!db) return;
  try {
    const docs = await db.collection("registrations").find({}).toArray();
    for (const doc of docs) {
      registry.set(doc._id, {
        type: doc.type,
        displayName: doc.displayName,
        active: doc.active !== undefined ? doc.active : true, // توافق مع سجلات قديمة ما فيها هذا الحقل
      });
    }
    console.log(`📥 تحميل ${docs.length} تسجيل من قاعدة البيانات.`);
  } catch (err) {
    console.error("خطأ تحميل التسجيلات:", err.message);
  }
}

module.exports = {
  register,
  getType,
  getLastType,
  isMobile,
  unregister,
  hardDelete,
  resetAll,
  getAllByType,
  loadFromDb,
};
