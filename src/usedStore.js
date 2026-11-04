// 🔒 قفل التكرار لكل قروب على حدى: أي سؤال انرسل بقروب ما يتكرر بنفس القروب
// — حتى لو انتهت المسابقة وبدأت غيرها — إلا لما تخلص كل أسئلة الفقرة. وقتها
// يتصفّر عدّاد هذي الفقرة لهذا القروب بس، وتبدأ له دورة جديدة عشوائية.
//
// كل (فقرة + قروب) لها مجموعة مفاتيح (Set) "مستخدمة" خاصة فيها، فمسابقات
// القروبات اللي تشتغل بنفس الوقت ما تتعارض ولا تستهلك بعض ولا تصفّر بعض.
// حجم كل مجموعة محدود بعدد أسئلة الفقرة (أقصاه بنك الكلمات ~430 مفتاح نص قصير)،
// وتتخزن بقاعدة البيانات عشان تبقى بعد إعادة التشغيل (مستند صغير لكل فقرة+قروب،
// حفظ مؤجل ومجمّع).
//
// 🔁 انتقال من القفل العالمي القديم: أول مرة قروب يسحب من فقرة، نبدأ مجموعته
// بنسخة من المجموعة العالمية القديمة (لو موجودة) — عشان ما يرجع يشوف أسئلة
// شافها قبل شوي. بعدها كل قروب يمشي لحاله، والمجموعة القديمة ما تتغير.

const { getDb } = require("./db");

const COLLECTION = "used_keys";
const PERSIST_DEBOUNCE_MS = 3000;
const SEP = "::";

const sets = new Map(); // lockKey -> Set(keys)   (lockKey = "فقرة::قروب" أو "فقرة" للقديم)
const meta = new Map(); // lockKey -> { pool, scope }
const timers = new Map(); // lockKey -> timeout (حفظ مؤجل)
const running = new Map(); // lockKey -> { again } أثناء كتابة جارية
const legacy = new Map(); // pool -> Set(keys) المجموعة العالمية القديمة (للقراءة فقط)

function lockKeyOf(pool, scope) {
  return scope ? `${pool}${SEP}${scope}` : pool;
}

function setOf(pool, scope) {
  const lk = lockKeyOf(pool, scope);
  let s = sets.get(lk);
  if (!s) {
    s = scope && legacy.has(pool) ? new Set(legacy.get(pool)) : new Set();
    sets.set(lk, s);
    meta.set(lk, { pool, scope: scope || null });
    if (scope && s.size > 0) persistSoon(lk);
  }
  return s;
}

// يسحب عنصر عشوائي من (items) ما سبق استخدامه بهذا القروب (scope)، ويقفله فوراً (حجز).
// exclude = مفاتيح مستبعدة إضافياً (مثلاً كلمات انسحبت بنفس الجولة).
// لو كل العناصر انستخدمت: يصفّر عدّاد الفقرة لهذا القروب بس ويبدأ دورة جديدة.
function pick(pool, items, keyFn, exclude, scope) {
  if (!items || items.length === 0) return null;
  const used = setOf(pool, scope);
  const lk = lockKeyOf(pool, scope);
  const allowed = (it) => {
    const k = keyFn(it);
    return !used.has(k) && !(exclude && exclude.has(k));
  };
  let cands = items.filter(allowed);
  if (cands.length === 0) {
    if (used.size > 0) {
      used.clear();
      console.log(`🔄 انتهت كل أسئلة فقرة (${pool}) بالقروب ${scope || "(عام)"} — بدأنا دورة جديدة عشوائية.`);
      persistSoon(lk);
    }
    cands = exclude ? items.filter((it) => !exclude.has(keyFn(it))) : items;
    if (cands.length === 0) return null;
  }
  const item = cands[Math.floor(Math.random() * cands.length)];
  used.add(keyFn(item));
  persistSoon(lk);
  return item;
}

// يفك قفل مفتاح (لو سؤال انحجز ولا انرسل فعلاً)
function release(pool, key, scope) {
  const lk = lockKeyOf(pool, scope);
  const used = sets.get(lk);
  if (used && used.delete(key)) persistSoon(lk);
}

function size(pool, scope) {
  const s = sets.get(lockKeyOf(pool, scope));
  return s ? s.size : 0;
}

// ---------- التخزين بقاعدة البيانات ----------
async function writePool(lk) {
  const db = getDb();
  if (!db) return;
  const m = meta.get(lk) || { pool: lk, scope: null };
  await db
    .collection(COLLECTION)
    .updateOne({ _id: lk }, { $set: { keys: [...(sets.get(lk) || [])], pool: m.pool, scope: m.scope } }, { upsert: true });
}

async function runPersist(lk) {
  const r = running.get(lk);
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
          await writePool(lk);
        } catch (e) {
          console.error("خطأ حفظ قفل التكرار:", e.message);
        }
      } while (state.again);
    } finally {
      running.delete(lk);
    }
  })();
  running.set(lk, state);
  return state.promise;
}

function persistSoon(lk) {
  if (!getDb() || timers.has(lk)) return;
  const t = setTimeout(() => {
    timers.delete(lk);
    runPersist(lk);
  }, PERSIST_DEBOUNCE_MS);
  timers.set(lk, t);
}

async function loadFromDb() {
  const db = getDb();
  if (!db) return;
  try {
    const docs = await db.collection(COLLECTION).find({}).toArray();
    let n = 0;
    let scoped = 0;
    for (const d of docs) {
      if (!d || !Array.isArray(d.keys) || typeof d._id !== "string") continue;
      const isScoped = d._id.includes(SEP);
      const s = new Set(d.keys);
      n += s.size;
      if (isScoped) {
        const i = d._id.indexOf(SEP);
        sets.set(d._id, s);
        meta.set(d._id, { pool: d._id.slice(0, i), scope: d._id.slice(i + SEP.length) });
        scoped++;
      } else {
        legacy.set(d._id, s); // المجموعة العالمية القديمة: مصدر تهيئة للقروبات الجديدة بس
      }
    }
    console.log(`📥 تحميل قفل التكرار: ${n} سؤال مستخدم (${scoped} مجموعة قروب + ${legacy.size} قديمة).`);
  } catch (e) {
    console.error("خطأ تحميل قفل التكرار:", e.message);
  }
}

async function flushPending() {
  const keys = [...timers.keys()];
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  await Promise.all(keys.map((k) => runPersist(k)));
  await Promise.all([...running.values()].map((r) => r.promise));
}

module.exports = { pick, release, size, loadFromDb, flushPending };
