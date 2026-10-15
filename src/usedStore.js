// 🔒 قفل التكرار العالمي: أي سؤال انرسل ما يتكرر بأي مسابقة وبأي قروب —
// حتى لو انتهت المسابقة وبدأت غيرها — إلا لما تخلص كل أسئلة الفقرة. وقتها
// يتصفّر عدّاد هذي الفقرة بس، وتبدأ دورة جديدة عشوائية.
//
// كل فقرة لها مجموعة مفاتيح (Set) "مستخدمة". حجمها محدود بعدد أسئلة الفقرة
// (أقصاه بنك الكلمات ~430 مفتاح نص قصير)، وتنمسح كاملة عند الدورة الجديدة،
// فما تتراكم بالذاكرة. وتتخزن بقاعدة البيانات عشان تبقى بعد إعادة التشغيل
// (مستند صغير لكل فقرة، حفظ مؤجل ومجمّع).

const { getDb } = require("./db");

const COLLECTION = "used_keys";
const PERSIST_DEBOUNCE_MS = 3000;

const sets = new Map(); // lockPool -> Set(keys)
const timers = new Map(); // lockPool -> timeout (حفظ مؤجل)
const running = new Map(); // lockPool -> { again } أثناء كتابة جارية

function setOf(pool) {
  let s = sets.get(pool);
  if (!s) {
    s = new Set();
    sets.set(pool, s);
  }
  return s;
}

// يسحب عنصر عشوائي من (items) ما سبق استخدامه، ويقفله فوراً (حجز).
// exclude = مفاتيح مستبعدة إضافياً (مثلاً كلمات انسحبت بنفس الجولة).
// لو كل العناصر انستخدمت: يصفّر عدّاد الفقرة ويبدأ دورة جديدة.
function pick(pool, items, keyFn, exclude) {
  if (!items || items.length === 0) return null;
  const used = setOf(pool);
  const allowed = (it) => {
    const k = keyFn(it);
    return !used.has(k) && !(exclude && exclude.has(k));
  };
  let cands = items.filter(allowed);
  if (cands.length === 0) {
    if (used.size > 0) {
      used.clear();
      console.log(`🔄 انتهت كل أسئلة فقرة (${pool}) — بدأنا دورة جديدة عشوائية.`);
      persistSoon(pool);
    }
    cands = exclude ? items.filter((it) => !exclude.has(keyFn(it))) : items;
    if (cands.length === 0) return null;
  }
  const item = cands[Math.floor(Math.random() * cands.length)];
  used.add(keyFn(item));
  persistSoon(pool);
  return item;
}

// يفك قفل مفتاح (لو سؤال انحجز ولا انرسل فعلاً)
function release(pool, key) {
  const used = sets.get(pool);
  if (used && used.delete(key)) persistSoon(pool);
}

function size(pool) {
  const s = sets.get(pool);
  return s ? s.size : 0;
}

// ---------- التخزين بقاعدة البيانات ----------
async function writePool(pool) {
  const db = getDb();
  if (!db) return;
  await db.collection(COLLECTION).updateOne({ _id: pool }, { $set: { keys: [...setOf(pool)] } }, { upsert: true });
}

async function runPersist(pool) {
  const r = running.get(pool);
  if (r) {
    r.again = true; // تتعاد بعد الجارية بآخر بيانات
    return r.promise;
  }
  const state = { again: false, promise: null };
  state.promise = (async () => {
    try {
      do {
        state.again = false;
        try {
          await writePool(pool);
        } catch (e) {
          console.error("خطأ حفظ قفل التكرار:", e.message);
        }
      } while (state.again);
    } finally {
      running.delete(pool);
    }
  })();
  running.set(pool, state);
  return state.promise;
}

function persistSoon(pool) {
  if (!getDb() || timers.has(pool)) return;
  const t = setTimeout(() => {
    timers.delete(pool);
    runPersist(pool);
  }, PERSIST_DEBOUNCE_MS);
  timers.set(pool, t);
}

async function loadFromDb() {
  const db = getDb();
  if (!db) return;
  try {
    const docs = await db.collection(COLLECTION).find({}).toArray();
    let n = 0;
    for (const d of docs) {
      if (!d || !Array.isArray(d.keys)) continue;
      const s = setOf(d._id);
      for (const k of d.keys) {
        s.add(k);
        n++;
      }
    }
    console.log(`📥 تحميل قفل التكرار: ${n} سؤال مستخدم بـ${docs.length} فقرة.`);
  } catch (e) {
    console.error("خطأ تحميل قفل التكرار:", e.message);
  }
}

async function flushPending() {
  const pools = [...timers.keys()];
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  await Promise.all(pools.map((p) => runPersist(p)));
  await Promise.all([...running.values()].map((r) => r.promise));
}

module.exports = { pick, release, size, loadFromDb, flushPending };
