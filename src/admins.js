// ⚙️ الادمنية: أشخاص يرقّيهم صاحب البوت (.ترقية اداريه @شخص) يقدرون يستخدمون "حزمة أوامر" محددة بس.
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
  "قفل الاوامر",
  "فتح الاوامر",
  "منشن",
  "طرد",
  "قفل قروب",
  "فتح قروب",
  "همزات",
  "الغ",
  "ترقية",
  "خفض",
];
const DEFAULT_PACKAGE = ["ايقاف", "الغاء ايقاف", "حظر", "الغاء حظر", "ازالة", "قفل الاوامر", "فتح الاوامر", "منشن", "طرد", "قفل قروب", "فتح قروب", "همزات", "الغ", "ترقية", "خفض"];
// الأوامر اللي أثرها ينحصر بقروب واحد — ادمن الشات يستخدم منها بس (مهما انضاف للحزمة).
// الباقي (ازالة، ريسيت...) يمس بيانات عامة لكل القروبات فهو للادمن العام وصاحب البوت بس
const CHAT_SCOPED = ["ايقاف", "الغاء ايقاف", "حظر", "الغاء حظر", "قفل الاوامر", "فتح الاوامر", "منشن", "طرد", "قفل قروب", "فتح قروب", "همزات", "الغ", "ترقية", "خفض"];
// الأوامر اللي كانت موجودة قبل إضافة قفل/فتح الشات — نستخدمها بالتحميل عشان نعرف أي أوامر "جديدة" لازم تنضاف للحزمة
// المحفوظة تلقائياً (حزمة محفوظة قديمة ما فيها الأمرين، ولو ما أضفناها ما يشتغلون للادمنية)
const LEGACY_KEYS = [
  "ايقاف", "الغاء ايقاف", "حظر", "الغاء حظر", "ازالة", "ازالة تصفير", "سماح", "الغاء سماح",
  "ريسيت توب", "ريسيت نقاط", "ريسيت تسجيلات", "حذف سجل", "سجل", "سجل جوالات", "تسجيلات", "قفل توب", "فتح توب",
];

const admins = new Set();
const immune = new Set();
// 👮 ادمنية شات: أدمن بقروب واحد بس (.ترقية ادمن @)، يستخدم أوامر الحزمة داخل هذا القروب فقط
const chatAdmins = new Map(); // chatId -> Set(userId)
// 🔒 شاتات مقفولة (.قفل الاوامر): أوامر البوت فيها للمالك والادمنية بس
const lockedChats = new Set();
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

// ─── ادمن الشات ───
function isChatAdmin(userId, chatId) {
  const set = chatAdmins.get(chatId);
  return !!set && set.has(userId);
}
// أدمن الشات يقدر يشغّل أمر الحزمة بس داخل شاته
function canUseInChat(userId, chatId, text) {
  if (!isChatAdmin(userId, chatId)) return false;
  const k = commandKeyOf(text);
  return !!k && pkg.has(k) && CHAT_SCOPED.includes(k);
}
// أوامر ادمن الشات الحالية (الحزمة ∩ المحصورة بالقروب)
function chatPkgList() {
  return DELEGABLE.filter((k) => pkg.has(k) && CHAT_SCOPED.includes(k));
}
// ادمن عام أو ادمن هذا الشات (بدون المالك — المالك يتفحص خارجياً)
function isStaff(userId, chatId) {
  return admins.has(userId) || isChatAdmin(userId, chatId);
}
async function persistChatAdmins(chatId) {
  const db = getDb();
  if (!db) return;
  try {
    const set = chatAdmins.get(chatId);
    const col = db.collection("chatAdmins");
    if (set && set.size > 0) await col.updateOne({ _id: chatId }, { $set: { users: [...set] } }, { upsert: true });
    else await col.deleteOne({ _id: chatId });
  } catch (err) {
    console.error("خطأ حفظ ادمنية الشات:", err.message);
  }
}
function addChatAdmin(chatId, userId) {
  if (!chatAdmins.has(chatId)) chatAdmins.set(chatId, new Set());
  chatAdmins.get(chatId).add(userId);
  persistChatAdmins(chatId);
}
function removeChatAdmin(chatId, userId) {
  const set = chatAdmins.get(chatId);
  if (!set) return;
  set.delete(userId);
  if (set.size === 0) chatAdmins.delete(chatId);
  persistChatAdmins(chatId);
}
function listChatAdmins(chatId) {
  return [...(chatAdmins.get(chatId) || [])];
}

// ─── قفل الشات ───
function isChatLocked(chatId) {
  return lockedChats.has(chatId);
}
async function persistLock(chatId, exists) {
  const db = getDb();
  if (!db) return;
  try {
    const col = db.collection("lockedChats");
    if (exists) await col.updateOne({ _id: chatId }, { $set: { chatId } }, { upsert: true });
    else await col.deleteOne({ _id: chatId });
  } catch (err) {
    console.error("خطأ حفظ قفل الشات:", err.message);
  }
}
function lockChat(chatId) {
  lockedChats.add(chatId);
  persistLock(chatId, true);
}
function unlockChat(chatId) {
  lockedChats.delete(chatId);
  persistLock(chatId, false);
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
    await db
      .collection("adminPackage")
      .updateOne({ _id: "commands" }, { $set: { list: [...pkg], known: [...DELEGABLE] } }, { upsert: true });
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
      // أوامر جديدة (ما كانت معروفة وقت آخر حفظ) وهي ضمن الافتراضي: تنضاف للحزمة المحفوظة مرة وحدة
      const known = new Set(Array.isArray(doc.known) ? doc.known : LEGACY_KEYS);
      let added = false;
      for (const k of DEFAULT_PACKAGE) {
        if (!known.has(k) && !pkg.has(k)) {
          pkg.add(k);
          added = true;
        }
      }
      if (added || !Array.isArray(doc.known)) await persistPackage();
    }
    (await db.collection("lockedChats").find({}).toArray()).forEach((d) => lockedChats.add(d._id));
    (await db.collection("chatAdmins").find({}).toArray()).forEach((d) => {
      if (Array.isArray(d.users) && d.users.length) chatAdmins.set(d._id, new Set(d.users));
    });
    console.log(
      `📥 تحميل ${admins.size} ادمن و${immune.size} بحصانة، وحزمة ادمن فيها ${pkg.size} أمر، و${lockedChats.size} شات مقفول، و${chatAdmins.size} شات فيه ادمنية.`
    );
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
  isChatAdmin,
  canUseInChat,
  chatPkgList,
  isStaff,
  addChatAdmin,
  removeChatAdmin,
  listChatAdmins,
  isChatLocked,
  lockChat,
  unlockChat,
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
