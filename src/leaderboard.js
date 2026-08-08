// لوحة صدارة: أسرع الأوقات لكل فقرة. تبقى بالذاكرة للسرعة، وتنحفظ
// بالخلفية بقاعدة البيانات (لو متوفرة)

const { getDb } = require("./db");

const POOL_TYPES = ["writing", "images", "questions", "counts"];
// نخزن أكثر من 5 داخلياً (30) عشان لما نفلتر لجوالات بس، يبقى فيه عمق
// كافي نطلع منه أفضل 5 جوالات حتى لو ما كانوا بأعلى 5 عام
const STORE_CAP = 30;
const DISPLAY_CAP = 5;

const board = { writing: [], images: [], questions: [], counts: [] };

// يحفظ كامل قائمة فقرة معينة بقاعدة البيانات (استبدال كامل، القائمة صغيرة أصلاً)
async function persistPool(poolType) {
  const db = getDb();
  if (!db) return;
  try {
    const col = db.collection("leaderboard");
    await col.deleteMany({ poolType });
    if (board[poolType].length > 0) {
      await col.insertMany(board[poolType].map((e) => ({ ...e, poolType })));
    }
  } catch (err) {
    console.error("خطأ حفظ لوحة الصدارة:", err.message);
  }
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
    for (const doc of docs) {
      if (board[doc.poolType]) {
        board[doc.poolType].push({
          userId: doc.userId,
          displayName: doc.displayName,
          elapsed: doc.elapsed,
          answer: doc.answer,
          ts: doc.ts,
        });
        count++;
      }
    }
    for (const t of POOL_TYPES) board[t].sort((a, b) => a.elapsed - b.elapsed);
    console.log(`📥 تحميل ${count} سجل لوحة صدارة من قاعدة البيانات.`);
  } catch (err) {
    console.error("خطأ تحميل لوحة الصدارة:", err.message);
  }
}

module.exports = { record, getTop, getTopFiltered, getAllTypes, reset, removeUser, removeUserFromPool, loadFromDb };
