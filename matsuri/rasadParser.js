// محلّل النصوص — يستخرج أزواج (اسم+شعار ، مبلغ) من أي شكل رسالة
// من الأشكال المتوقعة (زي ما وضّحتوا بالطلب):
//  1) مباشر:  سيزار🎴 20   /  سيزار -7   /  سيزار🎴 7k-
//  2) نتائج بأرقام مرفوعة (superscript):  الـمُـقــدِّم¹⁷ 🕴️: توكيتو ⛰️
//  3) قوائم جوائز:  { سيزار🎴 } 🥇30K💎
//  4) مبلغ مشترك لعدة أسماء مفصولة بشرطة:  بقية المشاركين🎖️5k💎 : ميكا⛰️-كيني⚡-كيلوا⚡
//
// ⚠️ ملاحظة مهمة: كل رقم "عادي" (بدون أصفار كبيرة واضحة) يُفهم أنه بالآلاف
// (يعني رقم 20 = 20k = 20000)، لأن هذا هو المتعارف عليه بأمثلتكم (77k
// ينقص منها 7 فتصير 70k). لو تبون تغيير هذا الافتراض قولولي.

// خريطة الأرقام المرفوعة (superscript) للأرقام العادية
const SUPERSCRIPT_MAP = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
  "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
};
const SUPERSCRIPT_RE = /[⁰¹²³⁴⁵⁶⁷⁸⁹]+/;

function superscriptToNumber(s) {
  return parseInt(
    s.split("").map((c) => SUPERSCRIPT_MAP[c] || "").join(""),
    10
  );
}

// نطاقات اليونيكود العامة للإيموجي (تقريبية بس تغطي أغلب الرموز المستخدمة)
const EMOJI_CLUSTER = "(?:[\\u{1F300}-\\u{1FAFF}\\u{2190}-\\u{21FF}\\u{2300}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE0F}]+)";
const NAME_CHARS = "[\\u0600-\\u06FFA-Za-z0-9ـ]+"; // حروف عربية/إنجليزية/أرقام (بدون مسافات)

// يلصق الاسم بشعاره (يشيل أي مسافة بينهم) — عشان "سيزار🎴" و"سيزار 🎴" يصيرون نفس المفتاح
function makeKey(name, emoji) {
  return `${name.trim()}${emoji.trim()}`;
}

function parseAmountToken(numStr, sign1, sign2) {
  let n = parseInt(numStr, 10);
  if (Number.isNaN(n)) return null;
  if (sign1 === "-" || sign2 === "-") n = -n;
  return n; // بالآلاف (k) دايماً
}

// الشكل 1: مباشر — اسم+شعار [مسافة] [إشارة سالب] رقم [k] [إشارة سالب] [شعار اختياري]
// الشعار هنا اختياري (لو الاسم متسجل مسبقاً بالقائمة، ما يحتاج المرسل
// يكرر الشعار كل مرة عند التعديل بالسالب/الموجب — نحلّه لاحقاً بـ rasad.js
// بمطابقته مع الأسماء المعروفة أصلاً)
// (فيه إيموجي ملاصق = مؤكد محاولة رصد حقيقية، فنسمح بأي كلام زيادة
// بعد المبلغ زي "| ن3" أو تفاصيل ثانية بنفس السطر)
// يسمح بأي رمز/نقطة قائمة زخرفية بأول السطر (⪦ - ∙ • ⁃ ⋅ إلخ) قبل
// الاسم — مو جزء من الاسم، بس علامة تنسيق يتجاهلها
const LEADING_BULLET = "[^\\p{L}\\p{N}]{0,4}\\s*";

// (فيه إيموجي ملاصق = مؤكد محاولة رصد حقيقية، فنسمح بأي كلام زيادة
// بعد المبلغ زي "| ن3" أو تفاصيل ثانية بنفس السطر. وبنسمح كمان بإيموجي
// عملة اختياري (💰/⭐...) بين الاسم والرقم، سواء قبل الرقم أو بعده)
function matchDirectWithEmoji(line) {
  const re = new RegExp(
    `^${LEADING_BULLET}(${NAME_CHARS})\\s*(${EMOJI_CLUSTER})\\s*(?:${EMOJI_CLUSTER}\\s*)?([+-]?)\\s*(\\d+)\\s*[kKكـ]?\\s*([+-]?)`,
    "u"
  );
  const m = line.match(re);
  if (!m) return null;
  const [, name, emoji, sign1, numStr, sign2] = m;
  const amount = parseAmountToken(numStr, sign1, sign2);
  if (amount === null) return null;
  return [{ key: makeKey(name, emoji), amount }];
}

// (بدون إيموجي — تعديل بالسالب/الموجب لاسم متسجل مسبقاً. بما إنه ما فيه
// إيموجي يميزه عن جملة عادية، لازم السطر كامل يكون بس "اسم + مبلغ" وخلاص)
function matchDirectBare(line) {
  const re = new RegExp(
    `^${LEADING_BULLET}(${NAME_CHARS})\\s*([+-]?)\\s*(\\d+)\\s*[kKكـ]?\\s*([+-]?)\\s*$`,
    "u"
  );
  const m = line.match(re);
  if (!m) return null;
  const [, name, sign1, numStr, sign2] = m;
  const amount = parseAmountToken(numStr, sign1, sign2);
  if (amount === null) return null;
  return [{ namePartial: name.trim(), amount }]; // يحتاج مطابقة لاحقة مع اسم معروف
}

function matchDirect(line) {
  return matchDirectWithEmoji(line) || matchDirectBare(line);
}

// الشكل 2: تسمية + رقم مرفوع + (: أو مسافة) + اسم + شعار
// مثال: "الـمُـقــدِّم¹⁷ 🕴️: توكيتو ⛰️"
function matchSuperscriptLabeled(line) {
  const re = new RegExp(
    `(${SUPERSCRIPT_RE.source})[^:]*:\\s*(${NAME_CHARS})\\s*(${EMOJI_CLUSTER})`,
    "u"
  );
  const m = line.match(re);
  if (!m) return null;
  const [, supNum, name, emoji] = m;
  const amount = superscriptToNumber(supNum);
  if (Number.isNaN(amount)) return null;
  return [{ key: makeKey(name, emoji), amount }];
}

// الشكل 3: قوسين (معقوفين { } أو ❲❳) فيهم اسم واحد أو أكثر (مفصولين
// بشرطة لو أكثر من اسم يشتركون بنفس المبلغ)، وبعدهم المبلغ بأي شكل:
// "{ سيزار🎴 } 🥇30K💎"  أو  "❲ اوبيتو ⚡❳🥇 : *65k* 💎"  أو
// "❲ داريل 🔆 - تيريون ⚡❳🥈 : *63k* 💎" (اسمين بنفس القوس)
function matchBraced(line) {
  const re = new RegExp(`[{❲]\\s*(.+?)\\s*[}❳][^\\d*]*\\*?\\s*(\\d+)\\s*[kK]?\\s*\\*?`, "u");
  const m = line.match(re);
  if (!m) return null;
  const [, namesBlob, numStr] = m;
  const amount = parseInt(numStr, 10);
  if (Number.isNaN(amount)) return null;

  const singleRe = new RegExp(`(${NAME_CHARS})\\s*(${EMOJI_CLUSTER})`, "gu");
  const results = [];
  let sm;
  while ((sm = singleRe.exec(namesBlob))) {
    results.push({ key: makeKey(sm[1], sm[2]), amount });
  }
  return results.length ? results : null;
}

// الشكل 4: رقم مشترك + : + أسماء مفصولة بشرطة (كل واحد ياخذ نفس المبلغ كامل)
// مثال: "بقية المشاركين🎖️5k💎 : ميكا⛰️-كيني⚡-كيلوا⚡-كونان🎴"
function matchSharedDashList(line) {
  const re = new RegExp(
    `(\\d+)\\s*[kK][^:]*:\\s*((?:${NAME_CHARS}\\s*${EMOJI_CLUSTER}\\s*-\\s*)+${NAME_CHARS}\\s*${EMOJI_CLUSTER})`,
    "u"
  );
  const m = line.match(re);
  if (!m) return null;
  const [, numStr, namesBlob] = m;
  const amount = parseInt(numStr, 10);
  if (Number.isNaN(amount)) return null;

  const singleRe = new RegExp(`(${NAME_CHARS})\\s*(${EMOJI_CLUSTER})`, "gu");
  const results = [];
  let sm;
  while ((sm = singleRe.exec(namesBlob))) {
    results.push({ key: makeKey(sm[1], sm[2]), amount });
  }
  return results.length ? results : null;
}

// يجرب كل الأشكال على سطر وحد، بالأولوية: قوائم مشتركة، قوسين، مرفوع، مباشر
function parseLine(line) {
  return (
    matchSharedDashList(line) ||
    matchBraced(line) ||
    matchSuperscriptLabeled(line) ||
    matchDirect(line)
  );
}

// نقطة الدخول — تاخذ نص رسالة كامل (ممكن عدة أسطر) وترجع مصفوفة
// [{key, amount}, ...] لكل الأزواج اللي لقتها
function parseMessage(text) {
  const lines = String(text || "").split("\n");
  const results = [];
  for (const line of lines) {
    const found = parseLine(line);
    if (found) results.push(...found);
  }
  return results;
}

// يحل "اسم بدون شعار" بمطابقته مع مفاتيح معروفة مسبقاً بالقائمة (اسم+شعار)
// يرجع المفتاح الكامل لو لقى تطابق وحيد بدون لبس، وإلا يرجع null
function resolvePartialName(namePartial, knownKeys) {
  const matches = knownKeys.filter((k) => k.startsWith(namePartial));
  return matches.length === 1 ? matches[0] : null;
}

// يفحص هل الرسالة فيها أي رقم إطلاقاً (عادي أو مرفوع) — غير مستخدمة
// حالياً بـ rasad.js (استُبدلت بفحص أدق)، بس نتركها متاحة لو احتجناها
const HAS_DIGIT_RE = new RegExp(`[0-9${Object.keys(SUPERSCRIPT_MAP).join("")}]`);
function looksLikeAmount(text) {
  return HAS_DIGIT_RE.test(String(text || ""));
}

// يستخرج الشعار (الإيموجي) من مفتاح "اسم+شعار" — يرجع "" لو ما لقى شي
function extractEmoji(key) {
  const re = new RegExp(`${EMOJI_CLUSTER}+$`, "u");
  const m = String(key || "").match(re);
  return m ? m[0] : "";
}

module.exports = { parseMessage, makeKey, resolvePartialName, looksLikeAmount, extractEmoji }; 