// تسجيل نوع جهاز كل شخص (جوال / خارجي) + اسمه — بالثقة، البوت ما يتحقق تقنياً
// يبقى بالذاكرة للسرعة، وينحفظ فوراً بقاعدة البيانات (لو متوفرة)

const { getDb } = require("./db");

const registry = new Map(); // userId -> { type: "mobile"|"external", displayName, active, title, lastActiveAt, order, dormant }
let nextOrder = 1; // ترتيب التسجيل (الرقم اللي يطلع بـ.تسجيلات) — يتغير بـ.ترتيب تسجيل
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

// الاسم المسجّل (للعرض بقوائم الإدارة) — null لو ما له تسجيل
function getDisplayName(userId) {
  const e = registry.get(userId);
  return e && e.displayName ? e.displayName : null;
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

// القوائم: اللقب يطلع بخانة الاسم، والمنشن يبقى دايماً بالخانة الثانية — فنرجع الكل بدون تصفية
function mentionable(ids) {
  return ids;
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
      { $set: { type: e.type, displayName: e.displayName, active: e.active, title: e.title || null, lastActiveAt: e.lastActiveAt || Date.now(), order: e.order, dormant: !!e.dormant } },
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
    order: existing.order || nextOrder++, // الشخص الراجع (بعد خمول/إلغاء) يرجع لنفس رقمه القديم
    dormant: false, // إعادة التسجيل = يرجع نشيط
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
  // الخامل (dormant) نشاطه يحسب "دخول" ويؤخّر التصفير النهائي، بس ما يرجّعه للتسجيلات — بس .تسجيل يرجّعه
  if (!e || (!e.active && !e.dormant)) return;
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
  existing.dormant = false;
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
    .sort((a, b) => (a[1].order || 0) - (b[1].order || 0))
    .map(([userId, e]) => ({ userId, displayName: e.displayName }));
}

// ---------- الخمول (تنظيف تلقائي) ----------
// خامل (dormant): انشال من التسجيلات والتوب (يتخفّون) بس بياناته محفوظة. يرجع بـ.تسجيل
function isDormant(userId) {
  const e = registry.get(userId);
  return !!(e && e.dormant);
}

async function markDormant(userId) {
  const e = registry.get(userId);
  if (!e) return;
  e.active = false;
  e.dormant = true;
  await persistOne(userId);
}

// مين يستاهل يتحول لخامل ومين يتصفّر. المنطق (الأيام) بـinactivity.js، هنا بس الحساب
function inactivityCandidates(now, dormantMs, purgeMs, isExempt) {
  const toDormant = [];
  const toPurge = [];
  for (const [userId, e] of registry) {
    if (!e.active && !e.dormant) continue; // ألغى تسجيله بنفسه — ما عنده بيانات أصلاً
    if (isExempt && isExempt(userId)) continue;
    const idle = now - (e.lastActiveAt || now);
    if (idle >= purgeMs) toPurge.push(userId);
    else if (e.active && idle >= dormantMs) toDormant.push(userId);
  }
  return { toDormant, toPurge };
}

// ---------- ترتيب التسجيلات ----------
// ينقل شخص من رقم لرقم بقائمة نوعه (نفس ترقيم .تسجيلات). الباقي يتزحزح تلقائياً
async function moveInList(type, fromPos, toPos) {
  const items = [...registry.entries()]
    .filter(([, e]) => e.active && e.type === type)
    .sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
  const n = items.length;
  if (fromPos < 1 || fromPos > n) return { ok: false, reason: `ما فيه رقم ${fromPos} بهذي القائمة (فيها ${n}).` };
  if (toPos < 1 || toPos > n) return { ok: false, reason: `الرقم ${toPos} برا القائمة (فيها ${n}).` };
  if (fromPos === toPos) return { ok: false, reason: "الشخص أصلاً بنفس المكان." };
  const slots = items.map(([, e]) => e.order || 0); // قيم الترتيب الحالية (تصاعدي) — نعيد توزيعها فقط
  const moved = items.splice(fromPos - 1, 1)[0];
  items.splice(toPos - 1, 0, moved);
  const changed = [];
  items.forEach(([userId, e], i) => {
    if (e.order !== slots[i]) {
      e.order = slots[i];
      changed.push(userId);
    }
  });
  const db = getDb();
  if (db && changed.length) {
    try {
      await db.collection("registrations").bulkWrite(
        changed.map((userId) => ({ updateOne: { filter: { _id: userId }, update: { $set: { order: registry.get(userId).order } } } })),
        { ordered: false }
      );
    } catch (err) {
      console.error("خطأ حفظ ترتيب التسجيلات:", err.message);
    }
  }
  return { ok: true, userId: moved[0], displayName: moved[1].displayName, from: fromPos, to: toPos };
}

// يسحب كل التسجيلات المحفوظة من قاعدة البيانات (يُستدعى مرة وحدة عند التشغيل)
async function loadFromDb() {
  const db = getDb();
  if (!db) return;
  try {
    const docs = await db.collection("registrations").find({}).toArray();
    // سجلات قديمة ما عندها "order": نرقّمها بترتيب القراءة (نفس الترتيب اللي كان يطلع بـ.تسجيلات)
    const withOrder = docs.filter((d) => typeof d.order === "number");
    let maxOrder = withOrder.reduce((m, d) => Math.max(m, d.order), 0);
    const fixes = []; // سجلات ناقصها حقول — نحفظها مرة وحدة عشان ما ينعاد العدّ كل تشغيل
    for (const doc of docs) {
      const needsOrder = typeof doc.order !== "number";
      const needsActivity = !doc.lastActiveAt;
      const order = needsOrder ? ++maxOrder : doc.order;
      const lastActiveAt = doc.lastActiveAt || Date.now(); // سجلات قديمة: نبدأ العدّ من الحين (وننحفظ تحت)
      registry.set(doc._id, {
        type: doc.type,
        displayName: doc.displayName,
        active: doc.active !== undefined ? doc.active : true, // توافق مع سجلات قديمة ما فيها هذا الحقل
        title: doc.title || null,
        lastActiveAt,
        order,
        dormant: !!doc.dormant,
      });
      if (needsOrder || needsActivity) fixes.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { order, lastActiveAt } } } });
    }
    nextOrder = maxOrder + 1;
    if (fixes.length) await db.collection("registrations").bulkWrite(fixes, { ordered: false });
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
  getDisplayName,
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
  isDormant,
  markDormant,
  inactivityCandidates,
  moveInList,
  loadFromDb,
};
