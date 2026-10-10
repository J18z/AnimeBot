// لوحة صدارة: أسرع الأوقات لكل فقرة. تبقى بالذاكرة للسرعة، وتنحفظ
// بالخلفية بقاعدة البيانات (لو متوفرة)

const { getDb } = require("./db");

// ✅ "writing1".."writing5" بنوك إضافية منفصلة تماماً عن "writing" الأصلية
// (اللي ما اتغيرت ولا اتلمست) — تتبع أفضل وقت لكل عدد كلمات بالضبط (1
// إلى 5)، لأمر .توب كت <رقم> الجديد. تُملأ تلقائياً بنفس آلية .record
// العادية (راجع game.js) — ما تحتاج أي تعامل خاص هنا غير التسجيل بقائمة
// الأنواع عشان تنحفظ/تتصفر/تنمسح مع بقية الفقرات تلقائياً
const WRITING_BY_COUNT = ["writing1", "writing2", "writing3", "writing4", "writing5"];
const POOL_TYPES = ["writing", "images", "questions", "counts", "dismantle", "reverse", "scramble", "repeat", ...WRITING_BY_COUNT];
// نخزن أكثر من 5 داخلياً (30) عشان لما نفلتر لجوالات بس، يبقى فيه عمق
// كافي نطلع منه أفضل 5 جوالات حتى لو ما كانوا بأعلى 5 عام
const STORE_CAP = 30;
const DISPLAY_CAP = 5;

const board = {};
for (const t of POOL_TYPES) board[t] = [];

// ✅ إصلاح مهم: الحفظ القديم كان deleteMany ثم insertMany كخطوتين، وكل
// تسجيل نتيجة يطلقه فورًا بدون انتظار السابق. لو جا تسجيلان متقاربان،
// خطواتهم تتداخل (حذف، حذف، إدخال، إدخال) فتنكتب كل السجلات مرتين
// بقاعدة البيانات — وعند كل تشغيل جديد كانت تنقرأ مكررة (تراكم بيانات
// بلا فايدة + قوائم توب فيها نفس الشخص أكثر من مرة). الحين:
//  1) الحفظ مؤجل ومجمّع (ثانية ونص) — عدة تحديثات متتالية = كتابة وحدة
//  2) حذف + إدخال بعملية bulkWrite وحدة (رحلة شبكة واحدة)
//  3) ما نبدأ كتابة جديدة لنفس الفقرة قبل ما تخلص السابقة
const PERSIST_DEBOUNCE_MS = 1500;
const persistTimers = new Map(); // poolType -> timeout
const persistRunning = new Map(); // poolType -> Promise جاري
const persistAgain = new Set(); // فقرات تغيّرت أثناء كتابة جارية

async function writePool(poolType) {
  const db = getDb();
  if (!db) return;
  const ops = [{ deleteMany: { filter: { poolType } } }];
  for (const e of board[poolType]) ops.push({ insertOne: { document: { ...e, poolType } } });
  await db.collection("leaderboard").bulkWrite(ops, { ordered: true });
}

async function runPersist(poolType) {
  if (persistRunning.has(poolType)) {
    persistAgain.add(poolType); // نعيدها بعد ما تخلص الجارية، بآخر بيانات
    return persistRunning.get(poolType);
  }
  const p = (async () => {
    try {
      do {
        persistAgain.delete(poolType);
        try {
          await writePool(poolType);
        } catch (err) {
          console.error("خطأ حفظ لوحة الصدارة:", err.message);
        }
      } while (persistAgain.has(poolType));
    } finally {
      persistRunning.delete(poolType);
    }
  })();
  persistRunning.set(poolType, p);
  return p;
}

function persistPool(poolType) {
  if (!getDb()) return;
  if (persistTimers.has(poolType)) return; // فيه كتابة مجدولة، بتاخذ آخر بيانات
  const t = setTimeout(() => {
    persistTimers.delete(poolType);
    runPersist(poolType);
  }, PERSIST_DEBOUNCE_MS);
  persistTimers.set(poolType, t);
}

// يفرّغ كل الكتابات المؤجلة فورًا (وقت إغلاق البرنامج)
async function flushPending() {
  const pools = [...persistTimers.keys()];
  for (const t of persistTimers.values()) clearTimeout(t);
  persistTimers.clear();
  await Promise.all(pools.map((p) => runPersist(p)));
  await Promise.all([...persistRunning.values()]);
}

// يسجل نتيجة جديدة — كل شخص له سجل واحد بس بكل فقرة (أفضل وقت له).
// لو عنده سجل سابق ووقته الجديد أفضل (أقل)، يحدّثه. لو أسوأ، يتجاهله.
// هذا يمنع شخص واحد قوي يحتل كل المراكز الخمسة لحاله بنفس الفقرة
function record(poolType, entry) {
  if (!board[poolType]) return;
  const existingIdx = board[poolType].findIndex((e) => e.userId === entry.userId);
  if (existingIdx !== -1) {
    if (entry.elapsed >= board[poolType][existingIdx].elapsed) return; // مو أفضل من سجله السابق
    board[poolType][existingIdx] = entry;
  } else {
    board[poolType].push(entry);
  }
  board[poolType].sort((a, b) => a.elapsed - b.elapsed);
  if (board[poolType].length > STORE_CAP) {
    board[poolType].length = STORE_CAP;
  }
  persistPool(poolType); // بدون انتظار
}

function getTop(poolType, n = DISPLAY_CAP) {
  return (board[poolType] || []).slice(0, n);
}

function getTopFiltered(poolType, n, predicate) {
  return (board[poolType] || []).filter(predicate).slice(0, n);
}

function getAllTypes() {
  return POOL_TYPES;
}

function reset(poolType) {
  if (poolType) {
    if (board[poolType]) board[poolType] = [];
    persistPool(poolType);
  } else {
    for (const t of POOL_TYPES) {
      board[t] = [];
      persistPool(t);
    }
  }
}

function removeUserFromPool(poolType, userId) {
  if (!board[poolType]) return false;
  const before = board[poolType].length;
  board[poolType] = board[poolType].filter((e) => e.userId !== userId);
  const changed = board[poolType].length !== before;
  if (changed) persistPool(poolType);
  return changed;
}

function removeUser(userId) {
  for (const t of POOL_TYPES) {
    const before = board[t].length;
    board[t] = board[t].filter((e) => e.userId !== userId);
    if (board[t].length !== before) persistPool(t);
  }
}

async function loadFromDb() {
  const db = getDb();
  if (!db) return;
  try {
    const docs = await db.collection("leaderboard").find({}).toArray();
    let count = 0;
    const dirtyPools = new Set();
    for (const doc of docs) {
      if (!board[doc.poolType]) continue;
      const entry = {
        userId: doc.userId,
        displayName: doc.displayName,
        elapsed: doc.elapsed,
        answer: doc.answer,
        ts: doc.ts,
      };
      // تنظيف تكرارات قديمة: شخص واحد = سجل واحد بالفقرة (الأفضل وقتاً)
      const idx = board[doc.poolType].findIndex((e) => e.userId === entry.userId);
      if (idx !== -1) {
        dirtyPools.add(doc.poolType);
        if (entry.elapsed < board[doc.poolType][idx].elapsed) board[doc.poolType][idx] = entry;
        continue;
      }
      board[doc.poolType].push(entry);
      count++;
    }
    for (const t of POOL_TYPES) board[t].sort((a, b) => a.elapsed - b.elapsed);
    console.log(`📥 تحميل ${count} سجل لوحة صدارة من قاعدة البيانات.`);
    if (dirtyPools.size) {
      console.log(`🧹 نظّفنا سجلات مكررة قديمة بلوحة الصدارة (${[...dirtyPools].join("، ")}).`);
      for (const t of dirtyPools) persistPool(t);
    }
  } catch (err) {
    console.error("خطأ تحميل لوحة الصدارة:", err.message);
  }
}

module.exports = { record, getTop, getTopFiltered, getAllTypes, reset, removeUser, removeUserFromPool, loadFromDb, flushPending };
