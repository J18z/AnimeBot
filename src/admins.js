// ⚙️ الادمنية: أشخاص يرقّيهم صاحب البوت (.ترقية ادمن @شخص) يقدرون يستخدمون "حزمة أوامر" محددة بس.
// - الحزمة قابلة للتعديل: .اضافة امر <اسم الأمر> / .حذف امر <اسم الأمر> (أمثلة: ريسيت توب، ايقاف)
// - الادمن ما يقدر يستخدم أوامر الحزمة ضد صاحب البوت، ولا ضد شخص عليه حصانة (.حصانة @شخص)
// - صاحب البوت يستخدم أي أمر ضد أي شخص (حتى اللي عليه حصانة)
// نفس أسلوب moderation.js: بالذاكرة للسرعة، وينحفظ بالخلفية بقاعدة البيانات (لو متوفرة)

const { getDb } = require("./db");

// الأوامر اللي يصير تضيفها للحزمة (الباقي — زي قبول/رفض، الترقية، الحصانة، الحزمة نفسها — لصاحب البوت بس دايماً)
const DELEGABLE = [
  "ايقاف",
  "الغاء ايقاف",
  "حظر",
  "الغاء حظر",
  "ازالة",
  "ازالة تصفير",
  "سماح",
  "الغاء سماح",
  "ريسيت توب",
  "ريسيت نقاط",
  "ريسيت تسجيلات",
  "حذف سجل",
  "سجل",
  "سجل جوالات",
  "تسجيلات",
  "قفل توب",
  "فتح توب",
];
const DEFAULT_PACKAGE = ["ايقاف", "الغاء ايقاف", "حظر", "الغاء حظر", "ازالة"];

const admins = new Set();
const immune = new Set();
const pkg = new Set(DEFAULT_PACKAGE);

// تطبيع للمقارنة بس (التشكيل، اختلاف الهمزات/الألف، المسافات المكررة) — عشان "إيقاف" = "ايقاف"
function norm(s) {
  return String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}

const SORTED_KEYS = [...DELEGABLE].sort((a, b) => b.length - a.length); // الأطول أول: "ازالة تصفير" قبل "ازالة"

// يحوّل نص مكتوب (من .اضافة امر ...) لاسم أمر معروف، أو null
function resolveKey(typed) {
  const n = norm(typed).replace(/^\./, "");
  return DELEGABLE.find((k) => norm(k) === n) || null;
}

// أي أمر معروف هذا النص؟ (يطابق بأطول اسم أمر يبدأ فيه النص)
function commandKeyOf(text) {
  if (!text || text[0] !== ".") return null;
  const n = norm(text).replace(/^\./, "");
  for (const k of SORTED_KEYS) {
    const nk = norm(k);
    if (n === nk || n.startsWith(nk + " ")) return k;
  }
  return null;
}

function isAdmin(userId) {
  return admins.has(userId);
}
function isImmune(userId) {
  return immune.has(userId);
}
// الادمن يقدر يشغّل هذا النص؟ (ادمن + الأمر داخل الحزمة)
function canUse(userId, text) {
  if (!admins.has(userId)) return false;
  const k = commandKeyOf(text);
  return !!k && pkg.has(k);
}

async function persistSet(collectionName, userId, exists) {
  const db = getDb();
  if (!db) return;
  try {
    const col = db.collection(collectionName);
    if (exists) await col.updateOne({ _id: userId }, { $set: { userId } }, { upsert: true });
    else await col.deleteOne({ _id: userId });
  } catch (err) {
    console.error(`خطأ حفظ ${collectionName}:`, err.message);
  }
}

async function persistPackage() {
  const db = getDb();
  if (!db) return;
  try {
    await db.collection("adminPackage").updateOne({ _id: "commands" }, { $set: { list: [...pkg] } }, { upsert: true });
  } catch (err) {
    console.error("خطأ حفظ حزمة الادمن:", err.message);
  }
}

function addAdmin(userId) {
  admins.add(userId);
  persistSet("admins", userId, true);
}
function removeAdmin(userId) {
  admins.delete(userId);
  persistSet("admins", userId, false);
}
function addImmune(userId) {
  immune.add(userId);
  persistSet("immune", userId, true);
}
function removeImmune(userId) {
  immune.delete(userId);
  persistSet("immune", userId, false);
}
function pkgAdd(key) {
  if (pkg.has(key)) return false;
  pkg.add(key);
  persistPackage();
  return true;
}
function pkgRemove(key) {
  if (!pkg.has(key)) return false;
  pkg.delete(key);
  persistPackage();
  return true;
}
function pkgList() {
  return DELEGABLE.filter((k) => pkg.has(k));
}
function listAdmins() {
  return [...admins];
}
function listImmune() {
  return [...immune];
}

async function loadFromDb() {
  const db = getDb();
  if (!db) return;
  try {
    (await db.collection("admins").find({}).toArray()).forEach((d) => admins.add(d._id));
    (await db.collection("immune").find({}).toArray()).forEach((d) => immune.add(d._id));
    const doc = await db.collection("adminPackage").findOne({ _id: "commands" });
    if (doc && Array.isArray(doc.list)) {
      pkg.clear();
      doc.list.filter((k) => DELEGABLE.includes(k)).forEach((k) => pkg.add(k));
    }
    console.log(`📥 تحميل ${admins.size} ادمن و${immune.size} بحصانة، وحزمة ادمن فيها ${pkg.size} أمر.`);
  } catch (err) {
    console.error("خطأ تحميل بيانات الادمنية:", err.message);
  }
}

module.exports = {
  DELEGABLE,
  resolveKey,
  commandKeyOf,
  isAdmin,
  isImmune,
  canUse,
  addAdmin,
  removeAdmin,
  addImmune,
  removeImmune,
  pkgAdd,
  pkgRemove,
  pkgList,
  listAdmins,
  listImmune,
  loadFromDb,
};
