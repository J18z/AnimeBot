// ═══════════════════════════════════════════════════════════════════
// وحدة استمارات ماتسوري — ملف مستقل تماماً عن منطق مسابقات البوت
// كل الأوامر هنا تبدأ بـ "." وتشتغل بس داخل الشات المحدد بـ matsuriChatId
// بملف data/config.json. البيانات (نصوص الاستمارات) موجودة بملف
// matsuriData.js المنفصل — هذا الملف فقط "المنطق" (الراوتر).
//
// ➕ للإضافة مستقبلاً: افتح matsuriData.js وأضف مفتاح جديد بـ forms أو
// contests. ما تحتاج تلمس هذا الملف إلا لو تبي تضيف "نوع أمر" جديد كلياً
// (مو مجرد استمارة جديدة على نفس النمط الموجود).
// ═══════════════════════════════════════════════════════════════════

const store = require("../src/dataStore");
const DATA = require("./matsuriData");
const { handleRouletteMessage } = require("./roulette");

// يطبع الألف بكل أشكالها (أ إ آ) لألف عادية، وكذا التاء المربوطة/الألف
// المقصورة — عشان لو المستخدم غلط بكتابة الهمزة يضبط معه الأمر برضو
function normalize(s) {
  return String(s || "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim();
}

const NOT_ADDED = "⚠️ هذي الاستمارة لسا ما تمت إضافتها.";

// يبني فهرس أسماء الأحداث (فردي + فرق) للبحث السريع بأمر .نتائج_
// نبنيه مرة وحدة عند تحميل الملف (مو بكل رسالة) للأداء
const nameIndex = new Map(); // normalizedName -> cmd
for (const [cmd, entry] of Object.entries(DATA.forms)) {
  if (entry.results || entry.singleResult) {
    nameIndex.set(normalize(entry.name), cmd);
  }
}

function isMatsuriChat(chatId) {
  const cfg = store.getConfig();
  return !!cfg.matsuriChatId && chatId === cfg.matsuriChatId;
}

// يرسل استمارة عادية (نص واحد)، أو عدة رسائل بالترتيب لو الأمر عنده "parts"
async function sendForm(sock, chatId, msg, entry) {
  if (entry && Array.isArray(entry.parts) && entry.parts.length) {
    for (const part of entry.parts) {
      await sock.sendMessage(chatId, { text: part }, { quoted: msg });
    }
    return;
  }
  if (!entry || !entry.form) {
    await sock.sendMessage(chatId, { text: NOT_ADDED }, { quoted: msg });
    return;
  }
  await sock.sendMessage(chatId, { text: entry.form }, { quoted: msg });
}

// معالجة أمر ".نتائج_<اسم> <رقم اختياري>"
async function handleResults(sock, chatId, msg, rawName, tierRaw) {
  const name = normalize(rawName);

  // حالة خاصة: نتائج مسابقة (رقمية) — .نتائج_مسابقة 30 مثلاً
  if (name.startsWith(normalize("مسابقة"))) {
    const num = tierRaw || (rawName.match(/(\d+)/) || [])[1];
    const c = num && DATA.contests[num];
    if (!c || !c.singleResult) {
      await sock.sendMessage(chatId, { text: NOT_ADDED }, { quoted: msg });
      return;
    }
    await sock.sendMessage(chatId, { text: c.singleResult }, { quoted: msg });
    return;
  }

  const cmd = nameIndex.get(name);
  const entry = cmd && DATA.forms[cmd];
  if (!entry) {
    await sock.sendMessage(chatId, { text: NOT_ADDED }, { quoted: msg });
    return;
  }

  // فعالية بثلاث درجات نتائج (5/10/15)
  if (entry.results) {
    const tier = (tierRaw || "").trim();
    const text = entry.results[tier];
    if (!text) {
      await sock.sendMessage(
        chatId,
        { text: "⚠️ حدد رقم النتيجة: 5 أو 10 أو 15\nمثال: .نتائج_" + entry.name + " 15" },
        { quoted: msg }
      );
      return;
    }
    await sock.sendMessage(chatId, { text }, { quoted: msg });
    return;
  }

  // فعالية بنتيجة وحدة بس (فرق غالباً)
  if (entry.singleResult) {
    await sock.sendMessage(chatId, { text: entry.singleResult }, { quoted: msg });
    return;
  }

  await sock.sendMessage(chatId, { text: NOT_ADDED }, { quoted: msg });
}

// نقطة الدخول الوحيدة لهذا الملف — تُستدعى من index.js لكل رسالة
// ترجع true لو تكفلت بالرسالة (عشان index.js يوقف ويرجع)، و false لو
// الرسالة مالها علاقة بماتسوري (يكمل index.js شغله العادي)
async function handleMatsuriMessage(sock, msg, text, chatId, senderId) {
  if (!isMatsuriChat(chatId)) return false;

  const t = text.trim();

  // قسم الروليت (.000 وكل أوامره) — خاص بصاحب البوت + صاحب وزارة ماتسوري فقط
  if (await handleRouletteMessage(sock, msg, t, chatId, senderId)) return true;

  if (t === ".ماتسوري") {
    await sock.sendMessage(chatId, { text: DATA.menus.main }, { quoted: msg });
    return true;
  }
  if (t === ".01") {
    await sock.sendMessage(chatId, { text: DATA.menus["01"] }, { quoted: msg });
    return true;
  }
  if (t === ".02") {
    await sock.sendMessage(chatId, { text: DATA.menus["02"] }, { quoted: msg });
    return true;
  }
  if (t === ".03") {
    await sock.sendMessage(chatId, { text: DATA.menus["03"] }, { quoted: msg });
    return true;
  }
  if (t === ".04") {
    await sock.sendMessage(chatId, { text: DATA.menus["04"] }, { quoted: msg });
    return true;
  }
  if (t === ".05") {
    await sock.sendMessage(chatId, { text: DATA.menus["05"] }, { quoted: msg });
    return true;
  }
  if (t === ".النتائج" || t === ".النتايج") {
    await sock.sendMessage(chatId, { text: DATA.menus.results }, { quoted: msg });
    return true;
  }

  // أوامر مسابقات .م30 .م40 ... .م300
  const mMatch = t.match(/^\.م\s*(\d+)$/);
  if (mMatch) {
    const c = DATA.contests[mMatch[1]];
    if (!c) return true; // رقم مو موجود أصلاً، نتجاهل بصمت (مو من ضمن القائمة)
    await sendForm(sock, chatId, msg, c);
    return true;
  }

  // أوامر النتائج .نتائج_الاسم رقم؟
  const resMatch = t.match(/^\.نتائج_(.+?)(?:\s+(\d+))?$/);
  if (resMatch) {
    await handleResults(sock, chatId, msg, resMatch[1], resMatch[2]);
    return true;
  }

  // أوامر الاستمارات العادية برقم (.11 .21 .71 .91 ... إلخ)
  const numMatch = t.match(/^\.(\d+)$/);
  if (numMatch && DATA.forms[numMatch[1]]) {
    await sendForm(sock, chatId, msg, DATA.forms[numMatch[1]]);
    return true;
  }

  return false; // مو أمر ماتسوري
}

module.exports = { handleMatsuriMessage, isMatsuriChat };
