// سجل شخصي: أفضل 5 نتائج (أسرع وقت) حصل عليها كل شخص بكل فقرة — بعكس
// leaderboard.js اللي يحفظ سجل واحد بس لكل شخص (أفضل نتيجة عامة تنافسية)،
// هذا يحفظ تاريخ شخصي كامل لكل نتيجة سجّلها الشخص، عشان أمر .نقاطي يقدر
// يوريه أفضل 5 نقاط جابها هو بنفسه. تبقى بالذاكرة للسرعة، وتنحفظ بالخلفية
// بقاعدة البيانات (لو متوفرة)

const { getDb } = require("./db");

const POOL_TYPES = ["writing", "images", "questions", "counts"];
const STORE_CAP = 10; // نحتفظ بأكثر من 5 داخلياً (هامش، مو ضروري فعلياً)
const DISPLAY_CAP = 5;

// userId -> { writing: [...], images: [...], questions: [...], counts: [...] }
const history = new Map();

function getUserBucket(userId) {
  if (!history.has(userId)) {
    history.set(userId, { writing: [], images: [], questions: [], counts: [] });
  }
  return history.get(userId);
}

// يحفظ سجل شخص واحد بفقرة معينة بقاعدة البيانات (استبدال كامل، القائمة صغيرة أصلاً)
async function persistUserPool(userId, poolType) {
  const db = getDb();
  if (!db) return;
  try {
    const col = db.collection("personalHistory");
    await col.deleteMany({ userId, poolType });
    const entries = getUserBucket(userId)[poolType];
    if (entries.length > 0) {
      await col.insertMany(entries.map((e) => ({ ...e, userId, poolType })));
    }
  } catch (err) {
    console.error("خطأ حفظ السجل الشخصي:", err.message);
  }
}

// يسجل نتيجة جديدة لتاريخ شخص معين — بعكس leaderboard، هنا كل نتيجة تُضاف
// (مو استبدال)، ونحتفظ بأفضل STORE_CAP نتيجة بس (الأسرع)
function record(poolType, entry) {
  if (!POOL_TYPES.includes(poolType)) return;
  const bucket = getUserBucket(entry.userId);
  bucket[poolType].push(entry);
  bucket[poolType].sort((a, b) => a.elapsed - b.elapsed);
  if (bucket[poolType].length > STORE_CAP) {
    bucket[poolType].length = STORE_CAP;
  }
  persistUserPool(entry.userId, poolType);
}

function getTop(userId, poolType, n = DISPLAY_CAP) {
  const bucket = history.get(userId);
  if (!bucket) return [];
  return (bucket[poolType] || []).slice(0, n);
}

// يمسح تاريخ شخص بفقرة معينة (يُستخدم مع .ريسيت توب <نوع> <شخص> عشان
// يبقى متزامن مع لوحة الصدارة العامة)
function removeUserFromPool(poolType, userId) {
  const bucket = history.get(userId);
  if (!bucket || !bucket[poolType] || bucket[poolType].length === 0) return;
  bucket[poolType] = [];
  persistUserPool(userId, poolType);
}

// يمسح تاريخ شخص بكل الفقرات (يُستخدم مع .ريسيت توب بدون نوع، أو
// .ازالة تصفير)
function removeUser(userId) {
  const bucket = history.get(userId);
  if (!bucket) return;
  for (const t of POOL_TYPES) {
    if (bucket[t].length > 0) {
      bucket[t] = [];
      persistUserPool(userId, t);
    }
  }
}

// يمسح تاريخ كل الأشخاص بفقرة معينة (أو كل الفقرات لو ما تحدد نوع) —
// يُستخدم مع .ريسيت توب بدون منشن/اسم (تصفير شامل)
function resetAll(poolType) {
  const db = getDb();
  for (const [userId, bucket] of history.entries()) {
    if (poolType) {
      if (bucket[poolType].length > 0) bucket[poolType] = [];
    } else {
      for (const t of POOL_TYPES) bucket[t] = [];
    }
  }
  if (!db) return;
  (async () => {
    try {
      const col = db.collection("personalHistory");
      if (poolType) await col.deleteMany({ poolType });
      else await col.deleteMany({});
    } catch (err) {
      console.error("خطأ تصفير السجل الشخصي:", err.message);
    }
  })();
}

// عند أول تشغيل بعد إضافة هذي الميزة، نبذر تاريخ كل شخص بأفضل نتيجة له
// موجودة أصلاً بلوحة الصدارة العامة (leaderboard) — عشان تظهر بـ.نقاطي
// فورًا بدون ما يحتاج يلعب من جديد. آمنة نكررها كل تشغيل (idempotent):
// لو الشخص عنده تاريخ أصلاً بهذي الفقرة، نتخطاه ولا نكرر
function seedFromLeaderboard(leaderboardEntries, poolType) {
  for (const e of leaderboardEntries) {
    const bucket = getUserBucket(e.userId);
    if (bucket[poolType].length > 0) continue; // عنده تاريخ أصلاً، تخطاه
    bucket[poolType].push({ userId: e.userId, displayName: e.displayName, elapsed: e.elapsed, answer: e.answer, ts: e.ts });
    persistUserPool(e.userId, poolType);
  }
}

async function loadFromDb() {
  const db = getDb();
  if (!db) return;
  try {
    const docs = await db.collection("personalHistory").find({}).toArray();
    let count = 0;
    for (const doc of docs) {
      const bucket = getUserBucket(doc.userId);
      if (bucket[doc.poolType]) {
        bucket[doc.poolType].push({
          userId: doc.userId,
          displayName: doc.displayName,
          elapsed: doc.elapsed,
          answer: doc.answer,
          ts: doc.ts,
        });
        count++;
      }
    }
    for (const bucket of history.values()) {
      for (const t of POOL_TYPES) bucket[t].sort((a, b) => a.elapsed - b.elapsed);
    }
    console.log(`📥 تحميل ${count} سجل تاريخ شخصي من قاعدة البيانات.`);
  } catch (err) {
    console.error("خطأ تحميل السجل الشخصي:", err.message);
  }
}

module.exports = { record, getTop, removeUser, removeUserFromPool, resetAll, seedFromLeaderboard, loadFromDb };
