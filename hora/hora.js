// ═══════════════════════════════════════════════════════════════════
// وحدة استمارات نقابة هورا 🩸 — مجلد مستقل تماماً عن ماتسوري ومنطق المسابقات.
// تشتغل فقط داخل القروب المحدد بـ horaChatId (متغير البيئة HORA_CHAT_ID
// أو حقل horaChatId بـ data/config.json) — أي شات ثاني يتجاهلها بصمت.
//
// الأوامر (تُكتب نفس ما هي، رسالة كاملة بدون زيادة):
//   .هورا   → القائمة الرئيسية
//   ادارة   → قائمة الاستمارات الإدارية  |  فعاليات → قائمة الفعاليات
//   ثم اسم الاستمارة نفسه: شموع، ون بيس، قلوب، ترحيب، استقبال، انذار عضو ...
//
// الاستمارات نصوص عادية داخل hora/forms/**.txt — كل ملف يحوي رسالة أو أكثر
// مفصولة بسطر يحتوي  @@@@  فقط. كل جزء يُرسل برسالة مستقلة بالترتيب
// (إعلان ← حسبة ← نتائج). عدّل النص بالملف مباشرة بدون لمس هذا الكود.
//
// ➕ لإضافة استمارة جديدة: ضع ملف .txt بالمجلد المناسب، ثم أضف سطر
// واحد بجدول COMMANDS تحت (الاسم/الأسماء المقبولة + اسم الملف).
// ═══════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
const store = require("../src/dataStore");

const BASE = __dirname;
const SEPARATOR = /^[ \t]*@@@@[ \t]*$/m;

// يوحّد أشكال الألف/التاء المربوطة/الألف المقصورة ويشيل التشكيل والتطويل
// والمسافات الزايدة — عشان "أبراج" و"ابراج" و"انذار  عضو" كلها تضبط
function normalize(s) {
  return String(s || "")
    // رموز الاتجاه/العرض الصفري غير المرئية (تنضاف أحياناً من كيبورد الجوال
    // أو عند اللصق) — تخلّي "شموع" تبان نفسها بس ما تتطابق مع الأمر
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim();
}

// يقرأ ملف نصي ويرجع مصفوفة رسائل (كل جزء مفصول بـ @@@@ = رسالة)
function loadParts(relPath) {
  const raw = fs.readFileSync(path.join(BASE, relPath), "utf8").replace(/\r\n/g, "\n");
  return raw
    .split(SEPARATOR)
    .map((p) => p.replace(/^\n+|\n+$/g, ""))
    .filter((p) => p.trim().length > 0);
}

// ── جدول الأوامر ──────────────────────────────────────────────────
// names: الأسماء المقبولة (تتطبّع تلقائياً) | file: مسار الملف داخل hora/
const COMMANDS = [
  // قسم الإدارة
  { names: ["استقبال"], file: "forms/admin/reception.txt" },
  { names: ["ترحيب"], file: "forms/admin/welcome.txt" },
  { names: ["انذار عضو"], file: "forms/admin/warn-member.txt" },
  { names: ["انذار اداري"], file: "forms/admin/warn-admin.txt" },
  { names: ["ترقية"], file: "forms/admin/promotion.txt" },
  { names: ["اعفاء"], file: "forms/admin/dismissal.txt" },
  { names: ["بنك"], file: "forms/admin/bank.txt" },
  { names: ["رواتب"], file: "forms/admin/salaries.txt" },
  { names: ["متجر"], file: "forms/admin/store.txt" },
  { names: ["يومي"], file: "forms/admin/daily.txt" },
  // قسم الفعاليات
  { names: ["ابراج"], file: "forms/events/towers.txt" },
  { names: ["قلوب"], file: "forms/events/hearts.txt" },
  { names: ["مسابقة"], file: "forms/events/contest.txt" },
  { names: ["جرس"], file: "forms/events/bell.txt" },
  { names: ["دروع"], file: "forms/events/shields.txt" },
  { names: ["فنش"], file: "forms/events/finish.txt" },
  { names: ["هجوم عمالقة", "هجوم العمالقة"], file: "forms/events/giants.txt" },
  { names: ["ون بيس"], file: "forms/events/onepiece.txt" },
  { names: ["كرات"], file: "forms/events/balls.txt" },
  { names: ["عنكبوت"], file: "forms/events/spider.txt" },
  { names: ["لعنات"], file: "forms/events/curses.txt" },
  { names: ["شموع"], file: "forms/events/candles.txt" },
];

// القوائم: اسم الأمر → ملف القائمة
const MENUS = [
  { names: [".هورا"], file: "menus/main.txt" },
  { names: ["ادارة"], file: "menus/admin.txt" },
  { names: ["فعاليات"], file: "menus/events.txt" },
];

// نبني الفهرس مرة وحدة عند تحميل الملف (مو بكل رسالة) — وأي ملف ناقص
// يطلع خطأ واضح عند الإقلاع بدل ما يفشل بصمت وقت الاستخدام
const index = new Map(); // normalizedName -> parts[]
for (const entry of [...MENUS, ...COMMANDS]) {
  const parts = loadParts(entry.file);
  if (!parts.length) throw new Error(`hora: الملف فاضي: ${entry.file}`);
  for (const n of entry.names) index.set(normalize(n), parts);
}

// يوحّد صيغة الآيدي: يشيل المسافات والاقتباس (شائعة عند لصق القيمة بإعدادات
// الاستضافة)، ويكمّل "@g.us" لو انكتب الرقم بس
function cleanChatId(raw) {
  let id = String(raw || "").trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  if (id && !id.includes("@")) id += "@g.us";
  return id;
}

function configuredChatId() {
  return cleanChatId(store.getConfig().horaChatId);
}

const warnedChats = new Set();
let seenHoraChat = false;

function isHoraChat(chatId) {
  const configured = configuredChatId();
  return !!configured && cleanChatId(chatId) === configured;
}

// ينطبع مرة وحدة عند التشغيل — تشوفه بسجلات السيرفر وتتأكد المتغير وصل
console.log(
  configuredChatId()
    ? `🩸 هورا: القروب المحدد = ${configuredChatId()}`
    : "🩸 هورا: HORA_CHAT_ID غير مضبوط — وحدة هورا معطّلة"
);

// نقطة الدخول الوحيدة — تُستدعى من index.js لكل رسالة قروب.
// ترجع true لو تكفلت بالرسالة، و false لو مالها علاقة بهورا
async function handleHoraMessage(sock, msg, text, chatId, senderId) {
  const key = normalize(text);
  if (!key) return false;

  if (!isHoraChat(chatId)) {
    // أمر هورا وصل من قروب غير المحدد: نسجل آيدي هذا القروب مرة وحدة بالسجلات
    // عشان تقارنه بالمضبوط وتعرف بسهولة لو الآيدي غلط
    if ((index.has(key) || key === ".هورا") && !warnedChats.has(chatId)) {
      warnedChats.add(chatId);
      console.log(
        `🩸 هورا: وصل أمر "${key}" من قروب غير المحدد.\n   آيدي هذا القروب: ${chatId}\n   المضبوط بـHORA_CHAT_ID: ${configuredChatId() || "(فاضي)"}`
      );
    }
    // تشخيص: صاحب البوت يكتب "تشخيص هورا" بأي قروب ويعرف ليش ما اشتغل
    if (key === "تشخيص هورا" || key === ".هورا") {
      const ownerId = store.getConfig().ownerId;
      if (ownerId && senderId === ownerId) {
        const conf = configuredChatId();
        await sock.sendMessage(
          chatId,
          {
            text:
              `🩸 هذا القروب مو القروب المحدد لهورا (أو المتغير ما وصل).\n` +
              `آيدي هذا الشات: ${chatId}\n` +
              `HORA_CHAT_ID المضبوط: ${conf || "(فاضي — المتغير ما وصل للبوت)"}\n` +
              `التطابق: ${conf && cleanChatId(chatId) === conf ? "✅ نعم" : "❌ لا"}`,
          },
          { quoted: msg }
        );
        return true;
      }
    }
    return false;
  }

  // تشخيص: HORA_DEBUG=1 بمتغيرات البيئة يطبع كل رسالة توصل من قروب هورا
  // (النص كما وصل بالضبط + الرموز الخفية إن وجدت + هل هو أمر معروف). بدونه
  // يطبع سطر واحد فقط عند أول رسالة، عشان تتأكد إن قروب هورا يوصّل رسائل للبوت
  const known = index.has(key);
  if (process.env.HORA_DEBUG === "1" || !seenHoraChat) {
    seenHoraChat = true;
    const hidden = [...String(text)].filter((c) => /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/.test(c)).length;
    console.log(`🩸 هورا: وصلت رسالة من قروب هورا ← نص=${JSON.stringify(text)} | بعد التطبيع=${JSON.stringify(key)} | رموز خفية=${hidden} | أمر معروف=${known ? "نعم" : "لا"}`);
  }

  const parts = index.get(key);
  if (!parts) return false;

  // كل استمارة برسالة مستقلة، بالترتيب (await يضمن عدم اختلاط الترتيب)
  for (const part of parts) {
    await sock.sendMessage(chatId, { text: part }, { quoted: msg });
  }
  return true;
}

module.exports = { handleHoraMessage, isHoraChat };
