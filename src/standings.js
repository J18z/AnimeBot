// سجل تراكمي: مجموع نقاط كل شخص، وعدد مرات فوزه بالمركز الأول (الفنش)
// عبر كل المسابقات اللي انتهت. يبقى بالذاكرة للسرعة، وينحفظ بالخلفية
// بقاعدة البيانات (لو متوفرة)

const { getDb } = require("./db");

const totals = new Map(); // userId -> { displayName, points, wins }

// شرط: لازم 3 مشاركين على الأقل بالمسابقة عشان تُحتسب بالسجل — عشان ما
// حد يلعب لحاله ويكدس نقاط بدون منافسة حقيقية
const MIN_PLAYERS = 3;

async function persistOne(userId) {
  const db = getDb();
  if (!db) return;
  try {
    const e = totals.get(userId);
    if (!e) return;
    await db
      .collection("standings")
      .updateOne({ _id: userId }, { $set: { displayName: e.displayName, points: e.points, wins: e.wins } }, { upsert: true });
  } catch (err) {
    console.error("خطأ حفظ السجل:", err.message);
  }
}

function addContestResult(scoresMap, nameCache) {
  if (!scoresMap || scoresMap.size < MIN_PLAYERS) return;

  // نحدد الفائز بالمركز الأول بهذي المسابقة (أعلى نقاط)
  let winnerId = null;
  let winnerPoints = -1;
  for (const [userId, points] of scoresMap.entries()) {
    if (points > winnerPoints) {
      winnerPoints = points;
      winnerId = userId;
    }
  }

  for (const [userId, points] of scoresMap.entries()) {
    const displayName = (nameCache && nameCache.get(userId)) || userId.split("@")[0];
    const current = totals.get(userId) || { displayName, points: 0, wins: 0 };
    current.points += points;
    current.displayName = displayName;
    if (userId === winnerId) current.wins += 1;
    totals.set(userId, current);
    persistOne(userId); // بدون انتظار
  }
}

function getStandings() {
  return [...totals.entries()]
    .map(([userId, v]) => ({ userId, displayName: v.displayName, points: v.points, wins: v.wins }))
    .sort((a, b) => b.points - a.points);
}

function getStandingsFiltered(predicate) {
  return getStandings().filter((e) => predicate(e.userId));
}

async function reset() {
  totals.clear();
  const db = getDb();
  if (!db) return;
  try {
    await db.collection("standings").deleteMany({});
  } catch (err) {
    console.error("خطأ تصفير السجل بقاعدة البيانات:", err.message);
  }
}

function removeUser(userId) {
  totals.delete(userId);
  const db = getDb();
  if (!db) return;
  db.collection("standings")
    .deleteOne({ _id: userId })
    .catch((err) => console.error("خطأ حذف شخص من السجل:", err.message));
}

async function loadFromDb() {
  const db = getDb();
  if (!db) return;
  try {
    const docs = await db.collection("standings").find({}).toArray();
    for (const doc of docs) {
      totals.set(doc._id, { displayName: doc.displayName, points: doc.points, wins: doc.wins || 0 });
    }
    console.log(`📥 تحميل ${docs.length} سجل نقاط من قاعدة البيانات.`);
  } catch (err) {
    console.error("خطأ تحميل السجل:", err.message);
  }
}

module.exports = {
  addContestResult,
  getStandings,
  getStandingsFiltered,
  reset,
  removeUser,
  loadFromDb,
  MIN_PLAYERS,
};
