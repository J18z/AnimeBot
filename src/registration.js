// تسجيل نوع جهاز كل شخص (جوال / خارجي) + اسمه — بالثقة، البوت ما يتحقق تقنياً
// يبقى بالذاكرة للسرعة، وينحفظ فوراً بقاعدة البيانات (لو متوفرة)

const { getDb } = require("./db");

const registry = new Map(); // userId -> { type: "mobile"|"external", displayName, active, title, lastActiveAt }
const titleIndex = new Map(); // لقب مطبّع -> userId (اللقب مميز لشخص واحد)
const lastActivePersist = new Map(); // userId -> آخر مرة حفظنا فيها وقت النشاط (نخفف الكتابة بقاعدة البيانات)
const ACTIVITY_PERSIST_EVERY_MS = 30 * 60 * 1000;

// ---------- الألقاب ----------
const BIDI_RE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

// يطبّع اللقب للمقارنة بس (التشكيل/التطويل/اختلاف الهمزات/المسافات/الحروف الكبيرة) —
// عشان ما أحد يسجل لقب شبيه جداً للقب شخص ثاني
function normalizeTitle(t) {
  return String(t || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(BIDI_RE, "")
    .replace(/\s+/g, "");
}

function validateTitle(raw) {
  const title = String(raw || "").replace(BIDI_RE, "").replace(/\s+/g, " ").trim();
  if (title.length < 2) return { ok: false, reason: "اللقب قصير، حرفين على الأقل." };
  if (title.length > 20) return { ok: false, reason: "اللقب طويل، 20 حرف كحد أقصى." };
  if (/^[.@]/.test(title) || /[@*_~`]/.test(title)) {
    return { ok: false, reason: "اللقب ما يقبل الرموز @ * _ ~ ` ولا يبدأ بنقطة." };
  }
  if (/^\d+$/.test(title)) return { ok: false, reason: "اللقب ما يكون أرقام بس." };
  return { ok: true, title };
}

function titleOwner(title) {
  return titleIndex.get(normalizeTitle(title)) || null;
}

function isTitleAvailable(title, userId) {
  const owner = titleOwner(title);
  return !owner || owner === userId;
}

function getTitle(userId) {
  const e = registry.get(userId);
  return e && e.title ? e.title : null;
}

// من القائمة نشيل أصحاب الألقاب — اللقب يطلع بالنص مكان المنشن، فما نحتاج ننشنهم
function mentionable(ids) {
  return ids.filter((id) => !getTitle(id));
}

function rebuildTitleIndex() {
  titleIndex.clear();
  for (const [userId, e] of registry) if (e.title) titleIndex.set(normalizeTitle(e.title), userId);
}

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
      { $set: { type: e.type, displayName: e.displayName, active: e.active, title: e.title || null, lastActiveAt: e.lastActiveAt || Date.now() } },
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

// title (اختياري، لازم يكون تحقق منه validateTitle/isTitleAvailable قبل): يتسجل بس لو الشخص
// ما عنده لقب أصلاً — تغيير اللقب له مسار ثاني (.تغيير لقب بموافقة صاحب البوت)
async function register(userId, type, displayName, title) {
  const existing = registry.get(userId) || {};
  const entry = {
    type,
    displayName: displayName || existing.displayName || userId.split("@")[0],
    active: true,
    title: existing.title || null,
    lastActiveAt: Date.now(),
  };
  if (!entry.title && title) {
    entry.title = title;
    titleIndex.set(normalizeTitle(title), userId);
  }
  registry.set(userId, entry);
  await persistOne(userId); // ننتظرها هنا عمداً — عملية نادرة، والصحة أهم من السرعة
}

// يضبط (أو يبدّل) لقب شخص مسجّل. المنطق "مين يقدر يبدّل" بالأوامر، مو هنا
async function setTitle(userId, rawTitle) {
  const e = registry.get(userId);
  if (!e) return { ok: false, reason: "الشخص غير مسجّل." };
  const v = validateTitle(rawTitle);
  if (!v.ok) return v;
  if (!isTitleAvailable(v.title, userId)) return { ok: false, reason: "اللقب محجوز لشخص ثاني." };
  if (e.title) titleIndex.delete(normalizeTitle(e.title));
  e.title = v.title;
  titleIndex.set(normalizeTitle(v.title), userId);
  await persistOne(userId);
  return { ok: true, title: v.title };
}

// تسجيل نشاط (أمر أو مشاركة بمسابقة) — يحدّث وقت آخر نشاط، ويحفظه بالقاعدة بحد أقصى مرة كل نص ساعة
function touch(userId) {
  const e = registry.get(userId);
  if (!e || !e.active) return;
  const now = Date.now();
  e.lastActiveAt = now;
  const last = lastActivePersist.get(userId) || 0;
  if (now - last < ACTIVITY_PERSIST_EVERY_MS) return;
  lastActivePersist.set(userId, now);
  const db = getDb();
  if (!db) return;
  db.collection("registrations")
    .updateOne({ _id: userId }, { $set: { lastActiveAt: now } })
    .catch((err) => console.error("خطأ حفظ وقت النشاط:", err.message));
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
  rebuildTitleIndex();
  await persistDelete(userId);
}

// يمسح كل التسجيلات كاملة (بالذاكرة وبقاعدة البيانات) — يستخدمها صاحب
// البوت بأمر .ريسيت تسجيلات لما يبي الجميع يسجلوا نوع جهازهم من جديد
async function resetAll() {
  const allIds = [...registry.keys()];
  registry.clear();
  titleIndex.clear();
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
        title: doc.title || null,
        lastActiveAt: doc.lastActiveAt || Date.now(), // سجلات قديمة: نبدأ العدّ من وقت أول تشغيل بهذي النسخة
      });
    }
    rebuildTitleIndex();
    console.log(`📥 تحميل ${docs.length} تسجيل من قاعدة البيانات.`);
  } catch (err) {
    console.error("خطأ تحميل التسجيلات:", err.message);
  }
}

module.exports = {
  register,
  setTitle,
  getTitle,
  validateTitle,
  isTitleAvailable,
  titleOwner,
  mentionable,
  touch,
  getType,
  getLastType,
  isMobile,
  unregister,
  hardDelete,
  resetAll,
  getAllByType,
  loadFromDb,
};
