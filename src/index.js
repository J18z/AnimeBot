const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const P = require("pino");
const fs = require("fs");
const qrcode = require("qrcode-terminal");
const store = require("./dataStore");
const { Contest } = require("./game");
const leaderboard = require("./leaderboard");
const personalHistory = require("./personalHistory");
const standings = require("./standings");
const registration = require("./registration");
const moderation = require("./moderation");
const templates = require("./templates");
const db = require("./db");
const { useMongoAuthState } = require("./mongoAuthState");
const { startHealthServer, setQr, clearQr } = require("./healthServer");
const dmPermissions = require("./dmPermissions");
const instanceLock = require("./instanceLock");
const CONFIG = store.getConfig(); // ✅ نقرأ config مرة وحدة عند التشغيل
const { handleMatsuriMessage } = require("../matsuri/matsuri");
const roulette = require("../matsuri/roulette");
const rasad = require("../matsuri/rasad");
const helpText = require("./helpText");
const { handleStickerCommand } = require("./commands/sticker");

// حماية كاملة من انهيار البرنامج: Baileys أحياناً يرمي أخطاء غير متوقعة
// من داخل عمليات خلفية (مثلاً محاولة إعادة إرسال رسالة بعد ما ينقطع
// الاتصال فجأة) — بدون هذا المعالج، أي خطأ غير مُمسوك يقفل Node.js
// بالكامل ويوقف البوت كلياً، ويحتاج Restart يدوي كل مرة. الحين بدل ما
// يطيح البرنامج، نسجل الخطأ بس ونكمل شغل عادي (الاتصال يتعافى من نفسه
// عن طريق منطق إعادة المحاولة الموجود أصلاً بـconnection.update)
process.on("uncaughtException", (err) => {
  console.error("⚠️ خطأ غير متوقع (تم تجاهله عشان البوت يفضل شغال):", err);
});
process.on("unhandledRejection", (err) => {
  console.error("⚠️ خطأ Promise غير معالج (تم تجاهله عشان البوت يفضل شغال):", err);
});

// ✅ إصلاح تسرّب السوكتات: نحتفظ بمرجع للسوكت الحالي + قفل يمنع أكثر من
// محاولة اتصال بنفس الوقت. بدون هذا، كل انقطاع كان يبني سوكت جديد بدون
// ما يقفل القديم (اللي يفضل شغال بالخلفية ويعالج نفس الرسائل مرتين)
let currentSock = null;
let connecting = false;

// ✅ حماية إضافية (خط دفاع ثاني): نتجاهل أي رسالة سبق نعالجها فعلاً حسب
// آيدي الرسالة (msg.key.id)، حتى لو وصلت من أكثر من سوكت أو تكررت لأي
// سبب ثاني. نحتفظ بآخر 500 آيدي بس (كافي لأي تكرار خلال دقيقة) عشان
// ما تكبر الذاكرة بلا داعي
const recentlyProcessedIds = new Set();
const recentlyProcessedOrder = [];
function alreadyProcessed(id) {
  if (!id) return false;
  if (recentlyProcessedIds.has(id)) return true;
  recentlyProcessedIds.add(id);
  recentlyProcessedOrder.push(id);
  if (recentlyProcessedOrder.length > 500) {
    const oldest = recentlyProcessedOrder.shift();
    recentlyProcessedIds.delete(oldest);
  }
  return false;
}

// كل محادثة (قروب أو خاص) عندها مسابقة مستقلة
const activeContests = new Map(); // chatId -> Contest

// طلبات تغيير نوع التسجيل المعلّقة، بانتظار موافقة صاحب البوت
// userId -> "mobile" | "external"
const pendingChangeRequests = new Map();

// ✅ صاحب البوت مسموح له بأي محادثة دايمًا، حتى لو ما كانت ضمن
// allowedChats — عشان ما ينحظر عن بوته بالغلط لو نسى يضيف آيدي محادثة
// معينة (زي الخاص تبعه). كمان نطبع بالـ logs لو رسالة انرفضت بسبب هذا
// القيد، عشان لو صار تجاهل غريب لمحادثة معينة يكون سببه واضح فورًا
// بالسجلات بدل ما يفضل لغز صامت
function isChatAllowed(chatId, senderId) {
  if (isOwner(senderId)) return true;
  // ✅ نستخدم CONFIG المحمّل مرة وحدة بالبداية بدل ما نعيد قراءة الملف
  // من القرص (fs.readFileSync) مع كل رسالة توصل — قراءة قرص لكل رسالة
  // بدون داعي، والقيمة أصلاً ما تتغير أثناء التشغيل عادة
  if (!CONFIG.allowedChats || CONFIG.allowedChats.length === 0) return true;
  const allowed = CONFIG.allowedChats.includes(chatId);
  if (!allowed) {
    console.log(
      `🚪 رسالة من محادثة غير مدرجة بـallowedChats (${chatId}) — تجاهلناها. لو هذا خطأ، أضف آيديها بconfig.json.`
    );
  }
  return allowed;
}

// يتحقق إن الشخص هو صاحب البوت (المحدد بـ ownerId بملف config.json أو
// متغير البيئة OWNER_ID). لو ownerId فاضي (ما تحدد بعد)، نرفض الأمر
// بدل ما نسمح لأي أحد افتراضياً
function isOwner(senderId) {
  return !!CONFIG.ownerId && senderId === CONFIG.ownerId;
}

// محادثة قروب أم خاص؟ (بواتساب: آيدي القروبات دايمًا تنتهي بـ @g.us)
function isGroupChat(chatId) {
  return chatId.endsWith("@g.us");
}

// يدور عن شخص بالاسم المسجل (نفس الاسم اللي يظهر جنب المنشن بـ.تسجيلات/
// .سجل) — مطابقة كاملة غير حساسة لحالة الأحرف. يرجع كل التطابقات (ممكن
// أكثر من شخص عندهم بالضبط نفس الاسم المسجل)
function findByName(name) {
  const lower = name.trim().toLowerCase();
  if (!lower) return [];
  const map = new Map();
  for (const type of ["mobile", "external"]) {
    registration.getAllByType(type).forEach((e) => {
      if (e.displayName && e.displayName.trim().toLowerCase() === lower) map.set(e.userId, e.displayName);
    });
  }
  standings.getStandings().forEach((e) => {
    if (e.displayName && e.displayName.trim().toLowerCase() === lower) map.set(e.userId, e.displayName);
  });
  return [...map.entries()].map(([userId, displayName]) => ({ userId, displayName }));
}

// يحدد هدف أمر إداري: أولوية للمنشن الفعلي (يشتغل حتى لو الشخص مو
// موجود بالقروب حالياً)، وإلا يدور بالاسم المكتوب بعد الأمر. يرجع
// { userId } لو لقى واحد بالضبط، أو { error: "none" } لو ما لقى شي، أو
// { error: "ambiguous", matches } لو فيه أكثر من شخص بنفس الاسم بالضبط
function resolveTarget(msg, trailingText) {
  const mentioned = getMentionedJid(msg);
  if (mentioned) return { userId: mentioned };
  const name = (trailingText || "").trim();
  if (!name) return { error: "none" };
  const matches = findByName(name);
  if (matches.length === 1) return { userId: matches[0].userId };
  if (matches.length === 0) return { error: "none" };
  return { error: "ambiguous", matches };
}

// أوامر إدارية معلّقة بانتظار رد برقم (لما فيه تشابه أسماء ولا فيه منشن
// متاح) — key = senderId (المالك دايمًا هو المستخدم لهذي الأوامر)
const pendingDisambiguation = new Map(); // senderId -> { matches, onResolved, expiresAt }
const DISAMBIGUATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 دقايق

// نسخة أشمل من resolveTarget: لو تحدد الهدف فورًا (منشن أو اسم فريد)،
// ينفّذ onResolved(userId) على طول. لو فيه تشابه أسماء، يعرض قائمة مرقّمة
// ويخزّن الحالة عشان لو المالك رد برقم بس (1، 2...) خلال 5 دقايق، ننفّذ
// نفس الأمر تلقائيًا بدون ما يحتاج يعيد كتابة الأمر بمنشن
async function resolveTargetOrAsk(sock, chatId, msg, senderId, trailingText, usageHint, onResolved) {
  const resolved = resolveTarget(msg, trailingText);
  if (resolved.userId) {
    await onResolved(resolved.userId);
    return;
  }
  if (resolved.error === "ambiguous") {
    pendingDisambiguation.set(senderId, {
      matches: resolved.matches,
      onResolved,
      expiresAt: Date.now() + DISAMBIGUATION_TIMEOUT_MS,
    });
    const lines = resolved.matches.map((m, i) => `${i + 1}. @${m.userId.split("@")[0]} (${m.displayName})`).join("\n");
    await sock.sendMessage(
      chatId,
      {
        text: `⚠️ فيه أكثر من شخص مسجل بنفس الاسم:\n${lines}\n\nرد بالرقم بس (مثلاً 1) خلال 5 دقايق وأكمل الأمر تلقائيًا — أو استخدم منشن بدل الاسم.`,
        mentions: resolved.matches.map((m) => m.userId),
      },
      { quoted: msg }
    );
    return;
  }
  await sock.sendMessage(chatId, { text: usageHint }, { quoted: msg });
}

// عدد الكلمات الافتراضي لأمر ".كت" التقديمي (لكل محادثة)
const practiceWordCount = new Map(); // chatId -> عدد (1-5)
const wordCountLabels = { كلمة: 1, كلمتين: 2, "ثلاث كلمات": 3, "اربع كلمات": 4, "خمس كلمات": 5 };

// يبدأ جولة تقديم بسيطة (معاينة/تجربة، بدون تسجيل بـ.توب أو .سجل)
// يبدأ أول جولة لمسابقة جديدة بأمان — لو صار خطأ (ملف تالف، مشكلة شبكة
// لحظية...)، ننظف حالة المسابقة (عشان ما تفضل "عالقة" بالمنتصف) ونخبر
// القروب بوضوح بدل ما يفضل ساكت بدون أي تفسير
async function safeStartFirstRound(chatId, sock, contest) {
  try {
    await contest.nextRound();
  } catch (e) {
    console.error("⚠️ خطأ أثناء بدء أول سؤال بالمسابقة:", e);
    contest.active = false;
    activeContests.delete(chatId);
    try {
      await sock.sendMessage(chatId, { text: "⚠️ صار خطأ أثناء بدء المسابقة. جرب تبدأها من جديد." });
    } catch (notifyErr) {
      console.error("فشل حتى إرسال رسالة خطأ بدء المسابقة:", notifyErr);
    }
  }
}

// يزيل لاحقة " همزات" من نهاية أمر بدء مسابقة (لو موجودة) — يرجع النص
// بدونها + علامة إذا كان وضع الهمزات الإلزامي مطلوب. مثال: ".فنش 20 همزات"
function stripHamzaSuffix(text) {
  const m = text.match(/^(.*?)\s+همزات$/);
  if (m) return { text: m[1], hamzaMode: true };
  return { text, hamzaMode: false };
}

// يبدأ المسابقة فعليًا — لو وضع الهمزات مفعّل، يطلب أول من اللي بدأ
// المسابقة يحدد نمط الهمزات قبل ما يرسل أول سؤال
async function beginContest(chatId, sock, contest, senderId) {
  if (contest.hamzaMode) {
    contest.awaitingHamzaFrom = senderId;
    contest.pendingStart = () => safeStartFirstRound(chatId, sock, contest);
    await sock.sendMessage(chatId, {
      text:
        "🔤 حدد نمط الهمزات الإلزامي (رد بنص فيه همزتين ء — أي إطار تحبه، مثال: تءءت أو جججءءججج).\n" +
        "كل شخص أول محاولة إجابة له بكل سؤال لازم تكون بنفس هذا الإطار (تصحيح برسالة ثانية يشتغل عادي بدون همزات).",
    });
    return;
  }
  await safeStartFirstRound(chatId, sock, contest);
}

// ✅ "التقديم البسيط" (أمر .كت وأمثاله) تجربة خفيفة بس، ما لازم تقفل
// ولا تأثر على أي مسابقة حقيقية بعدها — بس كانت تحسب "مسابقة شغالة"
// بنفس معاملة المسابقة الحقيقية، فتقفل أوامر البدء الحقيقية غلط. هذي
// الدالة تتحقق فيه مسابقة "حقيقية" فعلاً (مو مجرد تقديم بسيط متروك)
function hasBlockingContest(chatId) {
  const c = activeContests.get(chatId);
  return !!(c && c.active && !c.practiceMode);
}

// لو الموجود تقديم بسيط بس (مو مسابقة حقيقية)، ننظفه بصمت قبل ما نبدأ
// مسابقة حقيقية جديدة — نفس أسلوب startPractice بالضبط، عشان ما يفضل
// عالق بالخلفية بدون داعي
function clearStalePracticeContest(chatId) {
  const existing = activeContests.get(chatId);
  if (existing && existing.practiceMode) {
    existing.active = false;
  }
}

async function startPractice(chatId, sock, msg, poolType, extraOpts = {}) {
  const existing = activeContests.get(chatId);
  // نقفل بس لو فيه مسابقة حقيقية شغالة (فنش أو مستمرة) — التقديم البسيط
  // مالها علاقة بالمسابقات أصلاً، فما نقفلها على بعض. لو فيه تقديم بسيط
  // سابق ما انجاوب، نلغيه بصمت ونبدأ الجديد بدل ما نرفض
  if (existing && existing.active && !existing.practiceMode) {
    await sock.sendMessage(chatId, { text: "⚠️ فيه مسابقة شغالة حالياً، خلها تخلص أول." }, { quoted: msg });
    return;
  }
  if (existing && existing.practiceMode) {
    existing.active = false;
  }
  const contest = new Contest(chatId, sock, poolType, 1, { practiceMode: true, ...extraOpts });
  activeContests.set(chatId, contest);
  await safeStartFirstRound(chatId, sock, contest);
}

const endlessTypeLabels = { images: "صور", writing: "كتابة", counts: "تعداد", questions: "أسئلة", dismantle: "تفكيك", reverse: "عكس", scramble: "ترتيب" };

// يبدأ مسابقة مستمرة (ما تتوقف تلقائياً، بس بأمر إيقاف مخصص)
async function startEndless(chatId, sock, msg, senderId, poolType, extraOpts = {}) {
  if (hasBlockingContest(chatId)) {
    await sock.sendMessage(chatId, { text: "⚠️ فيه مسابقة شغالة بالفعل بهذي المحادثة." }, { quoted: msg });
    return;
  }
  clearStalePracticeContest(chatId);
  const contest = new Contest(chatId, sock, poolType, Infinity, { endless: true, ...extraOpts });
  activeContests.set(chatId, contest);
  await sock.sendMessage(chatId, {
    text: `🎬 بدأت مسابقة *${endlessTypeLabels[poolType]}* مستمرة! ما تتوقف إلا بأمر الإيقاف المخصص لها.`,
  });
  await beginContest(chatId, sock, contest, senderId);
}

// يوقف مسابقة مستمرة ويعرض النتيجة النهائية
async function stopEndless(chatId, sock, msg, poolType) {
  const contest = activeContests.get(chatId);
  if (!contest || !contest.active || !contest.endless) {
    await sock.sendMessage(chatId, { text: "ما فيه مسابقة مستمرة شغالة حالياً." }, { quoted: msg });
    return;
  }
  if (contest.contestType !== poolType) {
    await sock.sendMessage(
      chatId,
      { text: `المسابقة الشغالة حالياً مو من نوع ${endlessTypeLabels[poolType]}.` },
      { quoted: msg }
    );
    return;
  }
  await contest.endContest();
  activeContests.delete(chatId); // ✅ نظف من الذاكرة
}

// يحلل أوامر بدء المسابقة من نص الرسالة
// أمثلة: ".فنش 50" | ".فص 15" | ".فتع 20" | ".فسس 10" | ".فكت 15"
// أو نسخة الجوالات بس: ".فنش ج 50" | ".فص ج 15" ...
// ✅ صار .فنش (وحده) هو أمر البدء — يفتح قائمة اختيار الفقرات التفاعلية
// بدل ما يكون لكل فقرة أمر منفصل (.فص/.فكت/.فتع/.فسس/.فتف/.فعك/.فتر)
function parseStartCommand(text) {
  const t = text.trim().replace(/\s+/g, " ");
  const match = t.match(/^\.فنش(?:\s+(ج))?\s*(\d+)$/);
  if (!match) return null;
  return { mobileOnly: match[1] === "ج", target: parseInt(match[2], 10) };
}

// خريطة قائمة اختيار الفقرات التفاعلية (لـ.فنش و.مسابقة)
const POOL_MENU_LABELS = {
  1: "كتابة",
  2: "صور",
  3: "أسئلة",
  4: "تعداد",
  5: "تفكيك",
  6: "ترتيب",
  7: "عكس",
};
const POOL_MENU_TYPES = { 1: "writing", 2: "images", 3: "questions", 4: "counts", 5: "dismantle", 6: "scramble", 7: "reverse" };
const CLASSIC_FOUR = ["writing", "images", "questions", "counts"];
const ALL_SEVEN = ["writing", "images", "questions", "counts", "dismantle", "scramble", "reverse"];

function poolSelectionMenuText() {
  let out = "🎯 اختر الفقرات (رد برقم أو أكثر مفصولين بمسافة، أو اكتب \"الكل\"):\n\n";
  out += "0. فنش عادي (كتابة، صور، أسئلة، تعداد)\n";
  for (const n of [1, 2, 3, 4, 5, 6, 7]) out += `${n}. ${POOL_MENU_LABELS[n]}\n`;
  out += `\n*˼‏مثال: 1 2 3 (كتابة+صور+أسئلة) — أو اكتب "الكل" لكل الفقرات السبعة⋄◟*`;
  return out;
}

// يحلل رد المستخدم على قائمة اختيار الفقرات. يرجع مصفوفة أنواع فقرات، أو
// null لو الرد مو صالح (رقم غير موجود بالقائمة، أو نص فاضي)
function parsePoolSelection(text) {
  const t = text.trim();
  if (t === "الكل") return [...ALL_SEVEN];
  const parts = t.split(/\s+/);
  if (parts.length === 0) return null;
  const chosen = new Set();
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (!Number.isInteger(n) || String(n) !== p) return null;
    if (n === 0) {
      CLASSIC_FOUR.forEach((t) => chosen.add(t));
    } else if (POOL_MENU_TYPES[n]) {
      chosen.add(POOL_MENU_TYPES[n]);
    } else {
      return null; // رقم غير موجود بالقائمة
    }
  }
  return chosen.size > 0 ? [...chosen] : null;
}

// حالات معلّقة بانتظار اختيار فقرات (بعد .فنش أو .مسابقة) — key = chatId
const pendingPoolSelection = new Map(); // chatId -> { starterId, mode, target/roundsTarget, mobileOnly, hamzaMode, expiresAt }
const POOL_SELECTION_TIMEOUT_MS = 3 * 60 * 1000; // 3 دقايق

// يستخرج النص من رسالة Baileys بمختلف أنواعها (نص عادي، رد، كابشن صورة...)
function extractText(msg) {
  const m = msg.message;
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ""
  ).trim();
}

// يستخرج آيدي أول شخص تم عمل منشن له برسالة (يستخدمها .ايقاف/.حظر وأشباهها)
function getMentionedJid(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || null;
}

// مؤهل لقوائم الجوالات: مسجل كجوال وغير موقوف من صاحب البوت
function isMobileEligible(userId) {
  return registration.isMobile(userId) && !moderation.isSuspended(userId);
}

// أسماء عرض الفقرات + اختصاراتها (نفس اختصارات أوامر البدء بدون نقطة/ف)
const poolLabels = { writing: "كتابة", images: "صور", questions: "أسئلة", counts: "تعداد", dismantle: "تفكيك", reverse: "عكس", scramble: "ترتيب" };
const topTypeMap = { ص: "images", كت: "writing", تع: "counts", سس: "questions", فك: "dismantle", عك: "reverse", تر: "scramble" };

// يرسل قائمة سجل تراكمي مزخرفة (يستخدمها .سجل و.سجل جوالات)
async function sendStandingsList(sock, chatId, msg, list, subtitle) {
  if (list.length === 0) {
    await sock.sendMessage(
      chatId,
      { text: `ما فيه سجل بعد (لازم مسابقة كاملة بـ ${standings.MIN_PLAYERS} مشاركين فأكثر عشان تُحتسب).` },
      { quoted: msg }
    );
    return;
  }
  const out = templates.formatStandingsList(list, subtitle);
  const mentions = list.map((e) => e.userId);
  await sock.sendMessage(chatId, { text: out, mentions }, { quoted: msg });
}

// ✅ حماية من "عاصفة" إعادة اتصال سريعة: لو واتساب رفض الجلسة (تسجيل خروج)
// عدة مرات متتالية بفترة قصيرة، نوقف المحاولات التلقائية تمامًا بدل ما
// نستمر نطلب QR جديد فورًا كل مرة — لأن هذا التكرار السريع هو بالضبط
// اللي يخلي واتساب يحط قيد مؤقت على الرقم (نفس مشكلة "Couldn't link
// device: Try again later")
let consecutiveLogouts = 0;
let lastLogoutTime = 0;
const MAX_CONSECUTIVE_LOGOUTS = 3;
const LOGOUT_WINDOW_MS = 5 * 60 * 1000; // 5 دقائق

// ✅ نفس فكرة حماية "تسجيل الخروج" بس لأي نوع انقطاع عام (مو بس logout
// رسمي) — لو صار انقطاع متكرر بكثرة بفترة قصيرة (القيد اللي يحطه واتساب
// أحياناً يسبب انقطاعات متكررة مو logout صريح)، نبطّئ ونطوّل المهلة بدل
// ما نستمر نحاول كل 5 ثواني بلا توقف طول فترة القيد كاملة
let consecutiveCloses = 0;
let lastCloseTime = 0;
const CLOSE_WINDOW_MS = 2 * 60 * 1000; // دقيقتين
const MAX_FAST_RETRIES = 5; // بعدها نبطّئ الوتيرة بشكل كبير
const SLOW_RETRY_MS = 10 * 60 * 1000; // 10 دقايق بين كل محاولة بعد كذا

// يمسح جلسة واتساب المخزنة (سواء بقاعدة البيانات أو ملف محلي) — يُستخدم
// لما تصير الجلسة غير صالحة (تسجيل خروج) عشان نطلب QR جديد بدل ما نعلق
async function clearAuthSession() {
  if (db.getDb()) {
    try {
      await db.getDb().collection("baileys_auth").deleteMany({});
      console.log("🗑️ مسحنا جلسة واتساب القديمة من قاعدة البيانات.");
    } catch (e) {
      console.error("خطأ مسح الجلسة من قاعدة البيانات:", e.message);
    }
  } else {
    try {
      fs.rmSync("auth_info_baileys", { recursive: true, force: true });
      console.log("🗑️ مسحنا مجلد جلسة واتساب المحلي.");
    } catch (e) {
      console.error("خطأ مسح مجلد الجلسة:", e.message);
    }
  }
}

// يقفل ويفصل سوكت قديم تماماً (يشيل كل المستمعين + يقفل الاتصال الفعلي)
// قبل ما ننشئ سوكت جديد، عشان ما يفضل شغال بالخلفية "شبح" يعالج رسائل
function cleanupSocket(sock) {
  if (!sock) return;
  try {
    sock.ev.removeAllListeners();
  } catch (e) {
    /* تجاهل — السوكت ممكن يكون مقفول أصلاً */
  }
  try {
    sock.end(new Error("إعادة اتصال: تنظيف السوكت القديم"));
  } catch (e) {
    /* تجاهل — السوكت ممكن يكون مقفول أصلاً */
  }
}

async function connectSocket() {
  // ✅ قفل: لو فيه محاولة اتصال شغالة أصلاً، ما ننشئ وحدة ثانية بالتوازي
  // (يحصل لو Baileys بعث أكثر من حدث "close" بلحظات متقاربة)
  if (connecting) {
    console.log("⏳ فيه محاولة اتصال شغالة أصلاً، تجاهلنا هذي المحاولة المكررة.");
    return;
  }
  connecting = true;

  // ✅ ننظف السوكت القديم (لو موجود) قبل ما ننشئ سوكت جديد بالكامل
  cleanupSocket(currentSock);
  currentSock = null;

  // لو متصلين بقاعدة بيانات، نحفظ جلسة واتساب فيها (تفضل موجودة حتى لو
  // السيرفر أعاد التشغيل أو تغيّر). لو ما فيه اتصال، نستخدم ملفات محلية
  // كخطة احتياطية (يشتغل تمام للتشغيل من جهازك مباشرة)
  let authState;
  if (db.getDb()) {
    console.log("💾 جلسة واتساب: MongoDB");
    authState = await useMongoAuthState();
  } else {
    console.log("💾 جلسة واتساب: ملفات محلية (auth_info_baileys)");
    authState = await useMultiFileAuthState("auth_info_baileys");
  }
  const { state, saveCreds } = authState;
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
     version,
    logger: P({ level: "silent" }),
  });

  // ✅ هذا الآن هو السوكت "الرسمي" الوحيد — أي سوكت سابق انقفل فعلياً فوق
  currentSock = sock;
  connecting = false;

  // 🔍 تشخيص دقيق: نلف sock.sendMessage عشان نقيس وقت الإرسال الفعلي
  // (الشبكة/واتساب) لوحده، منفصل عن وقت تجهيز الرد بكودنا — هذا يفرق
  // بالضبط بين "كودنا بطيء" و"الإرسال الفعلي بطيء" بدل ما نخمّن
  const rawSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    const t0 = Date.now();
    try {
      return await rawSendMessage(...args);
    } finally {
      const dt = Date.now() - t0;
      if (dt > 500) {
        console.log(`🔍 [بطء إرسال شبكة] sendMessage استغرق ${dt}ms فعليًا (منفصل عن تجهيز الرد).`);
      }
    }
  };

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("امسح كود QR هذا من واتساب > الأجهزة المرتبطة:");
      qrcode.generate(qr, { small: true });
      setQr(qr); // نحدّث صفحة /qr كمان بآخر كود
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        const now = Date.now();
        if (now - lastCloseTime > CLOSE_WINDOW_MS) consecutiveCloses = 0;
        consecutiveCloses += 1;
        lastCloseTime = now;

        if (consecutiveCloses > MAX_FAST_RETRIES) {
          console.error(
            `🛑 انقطاعات متكررة (${consecutiveCloses} مرة خلال دقايق) — على الأغلب قيد مؤقت من واتساب. ` +
              `نبطّئ لمحاولة كل ${SLOW_RETRY_MS / 60000} دقايق بدل ما نستمر نقصف بسرعة.`
          );
          setTimeout(connectSocket, SLOW_RETRY_MS);
        } else {
          console.log("⚠️ انقطع الاتصال. إعادة محاولة خلال 5 ثواني...");
          setTimeout(connectSocket, 5000);
        }
      } else {
        // ✅ عداد "تسجيل خروج متتالي": لو صار 3 مرات خلال 5 دقائق، نوقف
        // المحاولات التلقائية كليًا — الاستمرار بطلب QR فورًا كل مرة هو
        // اللي يخلي واتساب يحط قيد مؤقت على الرقم (يمنعه يربط أي جهاز
        // إطلاقًا لفترة). أفضل نتوقف ونطلب تدخل يدوي بدل ما نزيد الطين بلة
        const now = Date.now();
        if (now - lastLogoutTime > LOGOUT_WINDOW_MS) consecutiveLogouts = 0;
        consecutiveLogouts += 1;
        lastLogoutTime = now;

        if (consecutiveLogouts >= MAX_CONSECUTIVE_LOGOUTS) {
          console.error(
            `🛑 تسجيل خروج متكرر (${consecutiveLogouts} مرات خلال دقايق قليلة) — أوقفنا إعادة المحاولة التلقائية ` +
              `عشان ما نتسبب بقيد إضافي من واتساب على الرقم. انتظر شوي (ساعات على الأقل) وبعدين أعد تشغيل ` +
              `السيرفر يدويًا لما يصير جاهز تربط من جديد.`
          );
          return; // ما نعيد الاتصال ولا نمسح الجلسة — نوقف كليًا هنا
        }

        console.log("⚠️ تم تسجيل الخروج من واتساب. نمسح الجلسة القديمة ونطلب QR جديد خلال 8 ثواني...");
        await clearAuthSession();
        setTimeout(connectSocket, 8000);
      }
    } else if (connection === "open") {
      console.log("✅ البوت جاهز ومتصل بواتساب!");
      consecutiveLogouts = 0; // اتصال ناجح = نصفّر العدادات
      consecutiveCloses = 0;
      clearQr();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    // ملاحظة مهمة: ما نرفض حسب "نوع الدفعة" (type !== "notify") — واتساب
    // أحياناً يرسل أول رسالة حقيقية بعد أي انقطاع بسيط بالاتصال (شي وارد
    // بسيرفر سحابي) كجزء من دفعة "مزامنة" (type غير notify)، فلو رفضنا
    // الدفعة كاملة تنضاع أول رسالة حقيقية وتحتاج ترسل مرتين. بدل كذا،
    // نفحص عمر كل رسالة لحالها ونتجاهل بس اللي قديمة فعلاً (مزامنة تاريخ
    // حقيقية بعد أول اتصال، مو رسالة حالية توصل بلحظة إعادة اتصال)
    // ✅ إصلاح مهم لدقة التوقيت: نعالج كل رسائل الدفعة بالتوازي (Promise.all)
    // مو بالتسلسل (for + await واحدة وحدة). قبل هذا التعديل، لو شخصين
    // جاوبوا بنفس اللحظة تقريبًا، الشخص الثاني كان ينتظر لين يخلص البوت
    // كامل معالجة رد الشخص الأول (اللي فيها إرسال فعلي لواتساب — طلب
    // شبكة ياخذ وقت حقيقي) قبل حتى ما يبدأ يعالج رسالته هو. وقت الانتظار
    // هذا كان ينحسب غلط كجزء من "سرعة" الشخص الثاني، فيطلع له وقت متضخم
    // رغم إنه جاوب بسرعة فعلية. المعالجة المتوازية تخلي كل رسالة تُعالَج
    // بأسرع وقت ممكن بشكل مستقل، فالتوقيت المحسوب يعكس السرعة الحقيقية.
    //
    // ملاحظة: هذا آمن تمامًا ولا يسبب تعارض/سباق — أول رسالة توصل لجملة
    // "round.finished = true" بالكود (بشكل متزامن، قبل أي await داخلي)
    // هي اللي تفوز بالجولة دايمًا، بغض النظر عن ترتيب اكتمال المعالجة.
    const now = Date.now();
    await Promise.all(
      messages.map(async (msg) => {
        try {
          const tsMs = Number(msg.messageTimestamp || 0) * 1000;
          if (tsMs && now - tsMs > 60000) return; // أقدم من دقيقة: تجاهلها
          // ✅ خط دفاع ثاني: لو نفس الرسالة (بنفس آيدي واتساب) سبق
          // اتعالجت (من هذا السوكت أو سوكت ثاني)، نتجاهلها هنا نهائياً
          if (alreadyProcessed(msg.key?.id)) return;
          // 🔍 تشخيص بطء: نقيس كم استغرقت معالجتنا الداخلية كاملة (من
          // استلام الرسالة لين آخر سطر بـhandleIncoming، شامل أي إرسال
          // رد فعلي جواها). لو الرقم صغير باستمرار رغم إحساسك بتأخير
          // فعلي، معناها التأخير مو من كودنا — من واتساب نفسه أو من
          // ضغط/خنق المعالج بالسيرفر
          const t0 = Date.now();
          await handleIncoming(sock, msg);
          const elapsed = Date.now() - t0;
          // ✅ نتجاهل حساب "تأخير الوصول" لرسائل البوت نفسه (fromMe) —
          // هذي مجرد "صدى" لرسائل أرسلها البوت، وحساب تأخير عليها رقم
          // مضلل (مو تأخير وصول حقيقي من مستخدم)، كان يسبب ضوضاء بالسجل
          const deliveryLag = tsMs && !msg.key?.fromMe ? now - tsMs : null; // فرق بين وقت إرسال الرسالة (حسب واتساب) ووصولها لنا
          if (elapsed > 500 || (deliveryLag !== null && deliveryLag > 1000)) {
            console.log(
              `🔍 [بطء] معالجتنا=${elapsed}ms، تأخير وصول الرسالة لنا=${deliveryLag}ms ` +
                `(نص: "${(msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").slice(0, 30)}")`
            );
          }
        } catch (err) {
          console.error("خطأ بمعالجة الرسالة:", err);
        }
      })
    );
  });

  return sock;
}

async function handleIncoming(sock, msg) {
  if (!msg.message) return; // رسائل بدون محتوى (حذف، إلخ)
  if (msg.key.fromMe) return; // نتجاهل رسائل البوت نفسه

  const chatId = msg.key.remoteJid;
  if (!chatId || chatId === "status@broadcast") return;
  // بالقروبات: participant هو آيدي الشخص الفعلي. بالخاص: remoteJid هو نفسه
  const senderId = msg.key.participant || msg.key.remoteJid;
  if (!isChatAllowed(chatId, senderId)) return;

  const text = extractText(msg);

  // 🚪 قفل شامل للخاص: أي حد غير صاحب البوت (وغير المسموح له صراحة بأمر
  // .سماح المخفي) يرسل بالخاص، نتجاهله كليًا بصمت — ولا حتى رد واحد، ولا
  // .ريم اوامر ولا أي أمر تشخيصي. كأن الرسالة ما وصلت أصلاً. هذي البوابة
  // أول شي بالدالة عمداً عشان ولا سطر ثاني يتنفذ لغير صاحب البوت بالخاص
  if (!isGroupChat(chatId) && !isOwner(senderId) && !dmPermissions.isAllowed(senderId)) {
    return;
  }

  // 🎯 رد على قائمة اختيار الفقرات المعلّقة (بعد .فنش أو .مسابقة) — لازم
  // يكون نفس الشخص اللي كتب أمر البدء. لو رد بشي مو رقم صالح، نتجاهله
  // بصمت تام (بدون رسالة تنبيه) وننتظر رد صحيح. أي حد (مو بس اللي بدأ)
  // يقدر يلغي الطلب المعلّق بـ.الغاء لو صاحبه اختفى
  if (pendingPoolSelection.has(chatId)) {
    const pending = pendingPoolSelection.get(chatId);
    if (Date.now() > pending.expiresAt) {
      pendingPoolSelection.delete(chatId);
    } else if (text === ".الغاء") {
      pendingPoolSelection.delete(chatId);
      await sock.sendMessage(chatId, { text: "✅ تم إلغاء طلب اختيار الفقرات المعلّق." }, { quoted: msg });
      return;
    } else if (senderId === pending.starterId) {
      const selected = parsePoolSelection(text);
      if (!selected) {
        return; // رد مو صالح — نتجاهله بصمت، ننتظر رد صحيح بدون ما نرسل تنبيهات متكررة
      }
      pendingPoolSelection.delete(chatId);

      const isClassicFour = selected.length === 4 && CLASSIC_FOUR.every((t) => selected.includes(t));
      const isAllSeven = selected.length === 7;
      const selectionLabel = isAllSeven
        ? "كل الفقرات"
        : isClassicFour
        ? "عامة (كل الفقرات التقليدية)"
        : selected.map((t) => poolLabels[t]).join("، ");

      if (pending.mode === "fnish") {
        const contest = new Contest(chatId, sock, "general", pending.target, {
          mobileOnly: pending.mobileOnly,
          hamzaMode: pending.hamzaMode,
          allowedPoolTypes: selected,
        });
        activeContests.set(chatId, contest);
        const mobileNote = pending.mobileOnly ? " 📱 (جوالات بس)" : "";
        try {
          await sock.sendMessage(chatId, {
            text: `🎬 بدأت مسابقة *${selectionLabel}*${mobileNote}!\nالنقاط المطلوبة للفوز: ${pending.target}\nبالتوفيق للجميع 🍀`,
          });
        } catch (e) {
          console.error("⚠️ فشل إرسال رسالة بدء المسابقة (تجاهلناه، نكمل لبدء السؤال الأول):", e);
        }
        await beginContest(chatId, sock, contest, senderId);
      } else {
        const contest = new Contest(chatId, sock, "general", Infinity, {
          roundsTarget: pending.roundsTarget,
          mobileOnly: pending.mobileOnly,
          hamzaMode: pending.hamzaMode,
          allowedPoolTypes: selected,
        });
        activeContests.set(chatId, contest);
        const mobileNote = pending.mobileOnly ? " 📱 (جوالات بس)" : "";
        try {
          await sock.sendMessage(chatId, {
            text: `🎬 بدأت مسابقة *${selectionLabel}*${mobileNote} (منوعة)!\nعدد الأسئلة الكلي: ${pending.roundsTarget}\nبالتوفيق للجميع 🍀`,
          });
        } catch (e) {
          console.error("⚠️ فشل إرسال رسالة بدء المسابقة المنوعة (تجاهلناه، نكمل لبدء السؤال الأول):", e);
        }
        await beginContest(chatId, sock, contest, senderId);
      }
      return;
    }
    // شخص ثاني غير اللي بدأ الأمر — نتجاهل رده بصمت (نسيبه يكمل مساره
    // الطبيعي لو صادف كان شي ثاني، القائمة تفضل معلّقة لصاحبها الأصلي)
  }

  // 🔢 رد برقم بس لحل تشابه أسماء بأمر إداري معلّق (زي .ريسيت توب J18
  // لما فيه أكثر من J18 مسجلين) — لازم يكون صاحب البوت، وفيه أمر معلّق
  // له، والرسالة رقم صريح بس (عشان ما نتعارض مع إجابة عادية بمسابقة)
  if (isOwner(senderId) && pendingDisambiguation.has(senderId) && /^\d+$/.test(text)) {
    const pending = pendingDisambiguation.get(senderId);
    if (Date.now() > pending.expiresAt) {
      pendingDisambiguation.delete(senderId);
    } else {
      const idx = parseInt(text, 10) - 1;
      const match = pending.matches[idx];
      if (match) {
        pendingDisambiguation.delete(senderId);
        await pending.onResolved(match.userId);
        return;
      }
      // رقم برا النطاق — نسيبه يكمل مساره الطبيعي (ممكن يكون إجابة لعبة)
    }
  }

  if (await handleMatsuriMessage(sock, msg, text, chatId, senderId)) return;

  // أمر مساعدة: يعطيك آيدي المحادثة عشان تحطه بـ config.json لو تبي تحصر البوت بقروب معين
  if (text === "شات الايدي" || text === "chat id") {
    await sock.sendMessage(chatId, { text: `آيدي هذي المحادثة:\n${chatId}` }, { quoted: msg });
    return;
  }

  // أمر تشخيصي: يعطيك آيديك الشخصي عشان نتأكد المنشن يشتغل صح
  if (text === "ايديي" || text === "my id") {
    await sock.sendMessage(chatId, { text: `آيديك بهذي المحادثة:\n${senderId}`, mentions: [senderId] }, { quoted: msg });
    return;
  }

  // أمر .ريم اوامر: قائمة كل الأوامر مصنفة
  // أمر .ريم اوامر: قائمة كل الأوامر مصنفة (النص نفسه بملف مستقل: helpText.js)
  if (text === ".ريم اوامر") {
    await sock.sendMessage(chatId, { text: helpText }, { quoted: msg });
    return;
  }

  // أمر .ستيكر — منطقه الكامل بملف مستقل: commands/sticker.js
  if (await handleStickerCommand(sock, msg, text, chatId)) return;

// أمر .تسجيل جوال / .تسجيل خارجي: يحدد نوع جهاز الشخص (بالثقة، بدون تحقق تقني)
// — مقفول بمجرد ما يسجل الشخص أول مرة، ما يقدر يغيّر نوعه مباشرة بعدها
// (حتى لو ألغى تسجيله)، لازم يمر بأمر .تغيير تسجيل (يحتاج موافقة المالك)
if (text === ".تسجيل جوال" || text === ".تسجيل خارجي") {
  const type = text === ".تسجيل جوال" ? "mobile" : "external";
  const typeLabel = type === "mobile" ? "جوال 📱" : "خارجي (كيبورد/لابتوب) 💻";
  const currentType = registration.getType(senderId);
  const lastType = registration.getLastType(senderId);

  if (currentType) {
    if (currentType === type) {
      await sock.sendMessage(chatId, { text: `أنت مسجل بالفعل كـ${typeLabel}.` }, { quoted: msg });
    } else {
      const otherLabel = type === "mobile" ? "جوال" : "خارجي";
      await sock.sendMessage(
        chatId,
        {
          text: `🚫 ما تقدر تغيّر نوع تسجيلك مباشرة. استخدم: .تغيير تسجيل ${otherLabel} (يحتاج موافقة صاحب البوت).`,
        },
        { quoted: msg }
      );
    }
    return;
  }

  if (lastType && lastType !== type) {
    const lastLabel = lastType === "mobile" ? "جوال" : "خارجي";
    const otherLabel = type === "mobile" ? "جوال" : "خارجي";
    await sock.sendMessage(
      chatId,
      {
        text: `🚫 كنت مسجل سابقاً كـ${lastLabel}. ما تقدر تسجل بنوع مختلف مباشرة. استخدم: .تغيير تسجيل ${otherLabel} (يحتاج موافقة صاحب البوت)، أو سجّل بنفس نوعك القديم (${lastLabel}).`,
      },
      { quoted: msg }
    );
    return;
  }

  await registration.register(senderId, type, msg.pushName);
  await sock.sendMessage(chatId, { text: `✅ تم تسجيلك كـ: ${typeLabel}` }, { quoted: msg });
  return;
}

// أمر .تغيير تسجيل جوال/خارجي: يرسل طلب تغيير لصاحب البوت (يحتاج موافقته)
const changeMatch = text.match(/^\.تغيير تسجيل (جوال|خارجي)$/);
if (changeMatch) {
  const requestedType = changeMatch[1] === "جوال" ? "mobile" : "external";
  const requestedLabel = requestedType === "mobile" ? "جوال 📱" : "خارجي 💻";
  const currentType = registration.getLastType(senderId);

  if (currentType === requestedType) {
    await sock.sendMessage(chatId, { text: `أنت مسجل بالفعل كـ${requestedLabel}.` }, { quoted: msg });
    return;
  }

  const cfg = store.getConfig();
  if (!cfg.ownerId) {
    await sock.sendMessage(
      chatId,
      { text: "⚠️ ما فيه صاحب بوت محدد حالياً بالإعدادات، تواصل مع المسؤول يدوياً." },
      { quoted: msg }
    );
    return;
  }

  pendingChangeRequests.set(senderId, requestedType);
  // حذف تلقائي بعد 24 ساعة لو ما تم الرد
setTimeout(() => {
  if (pendingChangeRequests.has(senderId)) {
    pendingChangeRequests.delete(senderId);
  }
}, 24 * 60 * 60 * 1000);
  await sock.sendMessage(
    chatId,
    {
      text: `📋 طلب تغيير تسجيل\n@${senderId.split("@")[0]} يبي يغيّر تسجيله إلى: ${requestedLabel}\n\n@${cfg.ownerId.split("@")[0]} وافق بـ:\n.قبول تغيير @${senderId.split("@")[0]}\nأو ارفض بـ:\n.رفض تغيير @${senderId.split("@")[0]}`,
      mentions: [senderId, cfg.ownerId],
    },
    { quoted: msg }
  );
  return;
}

// أوامر .قبول تغيير @شخص / .رفض تغيير @شخص — لصاحب البوت بس
const acceptChangeMatch = text.match(/^\.قبول تغيير(?:\s+(.+))?$/);
if (acceptChangeMatch) {
  if (!isOwner(senderId)) {
    await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
    return;
  }
  await resolveTargetOrAsk(sock, chatId, msg, senderId, acceptChangeMatch[1], "استخدم الأمر مع منشن أو اسم للشخص: .قبول تغيير @الشخص", async (target) => {
    const requestedType = pendingChangeRequests.get(target);
    if (!requestedType) {
      await sock.sendMessage(chatId, { text: "ما فيه طلب تغيير معلّق لهذا الشخص." }, { quoted: msg });
      return;
    }
    await registration.register(target, requestedType);
    pendingChangeRequests.delete(target);
    const label = requestedType === "mobile" ? "جوال 📱" : "خارجي 💻";
    await sock.sendMessage(
      chatId,
      { text: `✅ تم قبول الطلب، تسجيل @${target.split("@")[0]} صار: ${label}`, mentions: [target] },
      { quoted: msg }
    );
  });
  return;
}

const rejectChangeMatch = text.match(/^\.رفض تغيير(?:\s+(.+))?$/);
if (rejectChangeMatch) {
  if (!isOwner(senderId)) {
    await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
    return;
  }
  await resolveTargetOrAsk(sock, chatId, msg, senderId, rejectChangeMatch[1], "استخدم الأمر مع منشن أو اسم للشخص: .رفض تغيير @الشخص", async (target) => {
    if (!pendingChangeRequests.has(target)) {
      await sock.sendMessage(chatId, { text: "ما فيه طلب تغيير معلّق لهذا الشخص." }, { quoted: msg });
      return;
    }
    pendingChangeRequests.delete(target);
    await sock.sendMessage(
      chatId,
      { text: `🚫 تم رفض طلب تغيير تسجيل @${target.split("@")[0]}.`, mentions: [target] },
      { quoted: msg }
    );
  });
  return;
}

  // أمر .الغاء تسجيل (أو إلغاء): يمسح تسجيلك وكل سجلاتك (توب وسجل) بالكامل
  if (text === ".الغاء تسجيل" || text === ".إلغاء تسجيل") {
    await registration.unregister(senderId);
    leaderboard.removeUser(senderId);
    personalHistory.removeUser(senderId);
    standings.removeUser(senderId);
    await sock.sendMessage(chatId, { text: "🗑️ تم إلغاء تسجيلك، وحذف كل سجلاتك من .توب و.سجل." }, { quoted: msg });
    return;
  }

  // أوامر إشراف (.ايقاف / .الغاء ايقاف / .حظر / .الغاء حظر) — لصاحب البوت بس
  const unsuspendMatch = text.match(/^(?:\.الغاء ايقاف|\.إلغاء إيقاف)(?:\s+(.+))?$/);
  if (unsuspendMatch) {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    await resolveTargetOrAsk(sock, chatId, msg, senderId, unsuspendMatch[1], "استخدم الأمر مع منشن أو اسم للشخص: .الغاء ايقاف @الشخص", async (target) => {
      moderation.unsuspend(target);
      await sock.sendMessage(
        chatId,
        { text: "✅ تم رفع الإيقاف عنه، رجع مؤهل لقوائم الجوالات.", mentions: [target] },
        { quoted: msg }
      );
    });
    return;
  }

  const suspendMatch = text.match(/^\.ايقاف(?:\s+(.+))?$/);
  if (suspendMatch) {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    await resolveTargetOrAsk(sock, chatId, msg, senderId, suspendMatch[1], "استخدم الأمر مع منشن أو اسم للشخص: .ايقاف @الشخص", async (target) => {
      moderation.suspend(target);
      await sock.sendMessage(
        chatId,
        { text: "⏸️ تم إيقافه من قوائم الجوالات (يلعب عادي، نقاطه العامة تُحسب، بس مستبعد من .توب/.سجل جوالات).", mentions: [target] },
        { quoted: msg }
      );
    });
    return;
  }

  const unbanMatch = text.match(/^(?:\.الغاء حظر|\.إلغاء حظر)(?:\s+(.+))?$/);
  if (unbanMatch) {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    await resolveTargetOrAsk(sock, chatId, msg, senderId, unbanMatch[1], "استخدم الأمر مع منشن أو اسم للشخص: .الغاء حظر @الشخص", async (target) => {
      moderation.unban(target);
      await sock.sendMessage(chatId, { text: "✅ تم فك الحظر عنه، يقدر يلعب من جديد.", mentions: [target] }, { quoted: msg });
    });
    return;
  }

  const banMatch = text.match(/^\.حظر(?:\s+(.+))?$/);
  if (banMatch) {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    await resolveTargetOrAsk(sock, chatId, msg, senderId, banMatch[1], "استخدم الأمر مع منشن أو اسم للشخص: .حظر @الشخص", async (target) => {
      moderation.ban(target);
      await sock.sendMessage(
        chatId,
        { text: "🚫 تم حظره، رسائله بالمسابقات تُتجاهل تماماً (ما يحصل نقاط ولا يفوز بأي جولة).", mentions: [target] },
        { quoted: msg }
      );
    });
    return;
  }

  // أوامر .سماح <منشن/اسم> و.الغاء سماح <منشن/اسم> — مخصصة لصاحب البوت
  // بس، ومخفية عمداً (ما تظهر بقائمة .ريم اوامر): تسمح لشخص معيّن يلعب
  // المسابقات بالخاص رغم إنها مقفولة افتراضياً بالخاص للجميع عدا المالك
  const samahMatch = text.match(/^\.سماح(?:\s+(.+))?$/);
  if (samahMatch) {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    await resolveTargetOrAsk(sock, chatId, msg, senderId, samahMatch[1], "استخدم الأمر مع منشن أو اسم للشخص: .سماح @الشخص", async (target) => {
      dmPermissions.allow(target);
      await sock.sendMessage(chatId, { text: "✅ تم السماح له يستخدم البوت بالخاص.", mentions: [target] }, { quoted: msg });
    });
    return;
  }

  const laSamahMatch = text.match(/^\.الغاء سماح(?:\s+(.+))?$/);
  if (laSamahMatch) {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    await resolveTargetOrAsk(sock, chatId, msg, senderId, laSamahMatch[1], "استخدم الأمر مع منشن أو اسم للشخص: .الغاء سماح @الشخص", async (target) => {
      dmPermissions.disallow(target);
      await sock.sendMessage(chatId, { text: "🚫 تم إلغاء سماحه باستخدام البوت بالخاص.", mentions: [target] }, { quoted: msg });
    });
    return;
  }

  // أمر .توب أو .توب <نوع>: يعرض أفضل الأوقات (3 لكل الفقرات، أو 5 لفقرة محددة)
  const topMatch = text.match(/^\.توب(?:\s+(ص|كت|تع|سس|فك|عك|تر))?$/);
  if (topMatch) {
    const shortType = topMatch[1];
    let out, mentions;

    if (shortType) {
      const poolType = topTypeMap[shortType];
      const entries = leaderboard.getTop(poolType, 5);
      out = templates.formatTopSection(poolType, entries);
      mentions = entries.map((e) => e.userId);
    } else {
      const entriesByType = {};
      mentions = [];
      for (const poolType of templates.TOP_ORDER) {
        const entries = leaderboard.getTop(poolType, 3);
        entriesByType[poolType] = entries;
        entries.forEach((e) => mentions.push(e.userId));
      }
      out = templates.formatCombinedTop(entriesByType);
    }

    await sock.sendMessage(chatId, { text: out, mentions }, { quoted: msg });
    return;
  }

  // أمر .نقاطي: يعرض للشخص نفسه أفضل 5 نتائج شخصية (تاريخه هو، مو
  // التنافسي العام زي .توب) بكل فقرة
  if (text === ".نقاطي") {
    const entriesByType = {};
    for (const poolType of templates.TOP_ORDER) {
      entriesByType[poolType] = personalHistory.getTop(senderId, poolType, 5);
    }
    const anyEntry = Object.values(entriesByType).flat()[0];
    const displayName = anyEntry ? anyEntry.displayName : senderId.split("@")[0];
    const out = templates.formatMyPoints(entriesByType, displayName, senderId);
    await sock.sendMessage(chatId, { text: out, mentions: [senderId] }, { quoted: msg });
    return;
  }

  // أمر .توب جوالات: زي .توب بس بس الأشخاص المسجلين كجوال
  if (text === ".توب جوالات") {
    const entriesByType = {};
    const mentions = [];
    for (const poolType of templates.TOP_ORDER) {
      const entries = leaderboard.getTopFiltered(poolType, 3, (e) => isMobileEligible(e.userId));
      entriesByType[poolType] = entries;
      entries.forEach((e) => mentions.push(e.userId));
    }
    const out = templates.formatCombinedTop(entriesByType, templates.TOP_SUBTITLE_MOBILE);
    await sock.sendMessage(chatId, { text: out, mentions }, { quoted: msg });
    return;
  }

  // أمر .توب <نوع> جوال: زي .توب <نوع> بس بس الأشخاص المسجلين كجوال
  const topMobileMatch = text.match(/^\.توب (ص|كت|تع|سس|فك|عك|تر) جوال$/);
  if (topMobileMatch) {
    const poolType = topTypeMap[topMobileMatch[1]];
    const entries = leaderboard.getTopFiltered(poolType, 5, (e) => isMobileEligible(e.userId));
    const out = templates.formatTopSection(poolType, entries, templates.TOP_SUBTITLE_MOBILE);
    const mentions = entries.map((e) => e.userId);
    await sock.sendMessage(chatId, { text: out, mentions }, { quoted: msg });
    return;
  }

  // أمر .ريسيت توب أو .ريسيت توب <نوع> [@شخص/اسم]: يصفّر لوحة الصدارة
  // (كلها، أو فقرة وحدة، أو سجل شخص معين بس لو فيه منشن/اسم) — مخصص
  // لصاحب البوت بس
  const resetTopMatch = text.match(/^\.ريسيت توب(?:\s+(ص|كت|تع|سس|فك|عك|تر))?(?:\s+(.+))?$/);
  if (resetTopMatch) {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    const shortType = resetTopMatch[1];
    const poolType = shortType ? topTypeMap[shortType] : null;
    const trailingText = resetTopMatch[2];
    const mentioned = getMentionedJid(msg);

    const resetWholePool = async () => {
      if (poolType) {
        leaderboard.reset(poolType);
        personalHistory.resetAll(poolType);
        await sock.sendMessage(
          chatId,
          { text: `🗑️ تم تصفير لوحة صدارة فقرة ${poolLabels[poolType]}.` },
          { quoted: msg }
        );
      } else {
        leaderboard.reset();
        personalHistory.resetAll();
        await sock.sendMessage(chatId, { text: "🗑️ تم تصفير لوحة الصدارة بالكامل." }, { quoted: msg });
      }
    };

    if (!mentioned && !trailingText) {
      await resetWholePool();
      return;
    }

    await resolveTargetOrAsk(sock, chatId, msg, senderId, trailingText, "⚠️ ما لقيت هذا الشخص. استخدم منشن أو اسمه المسجل بالضبط.", async (target) => {
      if (poolType) {
        leaderboard.removeUserFromPool(poolType, target);
        personalHistory.removeUserFromPool(poolType, target);
        await sock.sendMessage(
          chatId,
          { text: `🗑️ تم حذف سجل @${target.split("@")[0]} من توب فقرة ${poolLabels[poolType]}.`, mentions: [target] },
          { quoted: msg }
        );
      } else {
        leaderboard.removeUser(target);
        personalHistory.removeUser(target);
        await sock.sendMessage(
          chatId,
          { text: `🗑️ تم حذف كل سجلات @${target.split("@")[0]} من التوب (كل الفقرات).`, mentions: [target] },
          { quoted: msg }
        );
      }
    });
    return;
  }

  // أمر .سجل: يعرض السجل التراكمي (مجموع نقاط كل شخص عبر كل المسابقات
  // اللي شارك فيها 3 أشخاص فأكثر)
  if (text === ".سجل") {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    const list = standings.getStandings();
    await sendStandingsList(sock, chatId, msg, list, templates.TOP_SUBTITLE_ALL);
    return;
  }

  // أمر .سجل جوالات: زي .سجل بس بس الأشخاص المسجلين كجوال
  if (text === ".سجل جوالات") {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    const list = standings.getStandingsFiltered((userId) => isMobileEligible(userId));
    await sendStandingsList(sock, chatId, msg, list, templates.TOP_SUBTITLE_MOBILE);
    return;
  }

  // أمر .تسجيلات: يعرض كل الأعضاء المسجلين (خارجي وجوال) مع منشنهم
  // (اسمها القديم كان .قائمة) — مخصص لصاحب البوت بس
  if (text === ".تسجيلات") {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    const externals = registration.getAllByType("external");
    const mobiles = registration.getAllByType("mobile");
    const out = templates.formatMemberList(externals, mobiles);
    const mentions = [...externals, ...mobiles].map((e) => e.userId);
    await sock.sendMessage(chatId, { text: out, mentions }, { quoted: msg });
    return;
  }

  // أمر .ريسيت تسجيلات: يصفّر كل التسجيلات (جوال/خارجي) لكل الأعضاء
  // كاملة، فيرجعون يحتاجون يسجلوا نوع جهازهم من جديد — مخصص لصاحب البوت بس
  if (text === ".ريسيت تسجيلات") {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    const count = await registration.resetAll();
    await sock.sendMessage(
      chatId,
      { text: `🗑️ تم تصفير كل التسجيلات بالكامل (${count || 0} تسجيل). الكل يحتاج يسجل من جديد.` },
      { quoted: msg }
    );
    return;
  }

  // أمر .قائمة_تع: يعرض كل عناصر التعداد مع إجاباتها
  if (text === ".قائمة_تع") {
    const out = templates.formatCountsList(store.getCounts());
    await sock.sendMessage(chatId, { text: out }, { quoted: msg });
    return;
  }

  // أمر .قائمة_سس: يعرض كل الأسئلة مع إجاباتها
  if (text === ".قائمة_سس") {
    const out = templates.formatQuestionsList(store.getQuestions());
    await sock.sendMessage(chatId, { text: out }, { quoted: msg });
    return;
  }

  // أمر .ريسيت سجل [@شخص/اسم]: يصفّر السجل التراكمي كامل، أو سجل شخص
  // معين بس لو فيه منشن/اسم — مخصص لصاحب البوت بس
  const resetStandingsMatch = text.match(/^\.ريسيت سجل(?:\s+(.+))?$/);
  if (resetStandingsMatch) {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    const trailingText = resetStandingsMatch[1];
    const mentioned = getMentionedJid(msg);
    if (mentioned || trailingText) {
      await resolveTargetOrAsk(sock, chatId, msg, senderId, trailingText, "⚠️ ما لقيت هذا الشخص. استخدم منشن أو اسمه المسجل بالضبط.", async (target) => {
        standings.removeUser(target);
        await sock.sendMessage(
          chatId,
          { text: `🗑️ تم حذف سجل @${target.split("@")[0]} من السجل التراكمي.`, mentions: [target] },
          { quoted: msg }
        );
      });
      return;
    }
    standings.reset();
    await sock.sendMessage(chatId, { text: "🗑️ تم تصفير السجل العام بالكامل." }, { quoted: msg });
    return;
  }

  // أمر .حذف سجل <رقم1> <رقم2> ...: يحذف سجلات معينة من السجل التراكمي
  // حسب رقمها بقائمة .سجل (الترتيب الحالي وقت تنفيذ الأمر) — يقدر ياخذ
  // أكثر من رقم مرة وحدة. مخصص لصاحب البوت بس
  const deleteStandingsMatch = text.match(/^\.حذف سجل(?:\s+(.+))?$/);
  if (deleteStandingsMatch) {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    const argsStr = (deleteStandingsMatch[1] || "").trim();
    const nums = [...new Set(argsStr.split(/\s+/).filter(Boolean).map((n) => parseInt(n, 10)))].filter(
      (n) => Number.isInteger(n) && n >= 1
    );
    if (nums.length === 0) {
      await sock.sendMessage(chatId, { text: "استخدم الأمر مع رقم أو أكثر (نفس الترقيم بـ.سجل): .حذف سجل 17 18 23" }, { quoted: msg });
      return;
    }
    // نأخذ لقطة (snapshot) واحدة من القائمة قبل أي حذف — عشان أرقام
    // الترتيب ما تتزحزح لو حذفنا أكثر من سجل بنفس الأمر
    const list = standings.getStandings();
    const found = [];
    const notFound = [];
    for (const n of nums) {
      const entry = list[n - 1];
      if (entry) found.push(entry);
      else notFound.push(n);
    }
    found.forEach((e) => standings.removeUser(e.userId));

    let replyText = found.length
      ? `🗑️ تم حذف ${found.length} سجل من السجل التراكمي:\n${found.map((e) => `- ${e.displayName}`).join("\n")}`
      : "⚠️ ما لقيت أي رقم مطابق بالسجل الحالي.";
    if (notFound.length) replyText += `\n\n⚠️ أرقام مو موجودة: ${notFound.join(", ")}`;
    await sock.sendMessage(chatId, { text: replyText, mentions: found.map((e) => e.userId) }, { quoted: msg });
    return;
  }

  // أمر بدء مسابقة (.فنش <رقم> أو .فنش ج <رقم>) — يفتح قائمة اختيار
  // الفقرات التفاعلية بدل ما يبدأ فورًا
  const hamzaCheckMain = stripHamzaSuffix(text);
  const startCmd = parseStartCommand(hamzaCheckMain.text);
  if (startCmd) {
    if (hasBlockingContest(chatId)) {
      await sock.sendMessage(
        chatId,
        { text: "⚠️ فيه مسابقة شغالة بالفعل بهذي المحادثة. اكتب: .انهاء عشان تنهيها." },
        { quoted: msg }
      );
      return;
    }
    if (pendingPoolSelection.has(chatId)) {
      await sock.sendMessage(
        chatId,
        { text: "⚠️ فيه طلب اختيار فقرات معلّق أصلاً بهذي المحادثة. انتظر صاحبه يختار، أو اكتب .الغاء عشان تلغيه وتقدر تبدأ من جديد." },
        { quoted: msg }
      );
      return;
    }
    clearStalePracticeContest(chatId);
    pendingPoolSelection.set(chatId, {
      starterId: senderId,
      mode: "fnish",
      target: startCmd.target,
      mobileOnly: startCmd.mobileOnly,
      hamzaMode: hamzaCheckMain.hamzaMode,
      expiresAt: Date.now() + POOL_SELECTION_TIMEOUT_MS,
    });
    await sock.sendMessage(chatId, { text: poolSelectionMenuText() }, { quoted: msg });
    return;
  }

  // أمر .مسابقة <رقم> أو .مسابقة ج <رقم>: فقرات منوعة، تنتهي لما مجموع
  // عدد الأسئلة الكلي (بغض النظر مين جاوب) يوصل الرقم — مو أول شخص يوصل
  // هدف. نفس قائمة اختيار الفقرات
  const hamzaCheckMixed = stripHamzaSuffix(text);
  const mixedMatch = hamzaCheckMixed.text.match(/^\.مسابقة(?:\s+(ج))?\s+(\d+)$/);
  if (mixedMatch) {
    if (hasBlockingContest(chatId)) {
      await sock.sendMessage(
        chatId,
        { text: "⚠️ فيه مسابقة شغالة بالفعل بهذي المحادثة. اكتب: .انهاء عشان تنهيها." },
        { quoted: msg }
      );
      return;
    }
    if (pendingPoolSelection.has(chatId)) {
      await sock.sendMessage(
        chatId,
        { text: "⚠️ فيه طلب اختيار فقرات معلّق أصلاً بهذي المحادثة. انتظر صاحبه يختار، أو اكتب .الغاء عشان تلغيه وتقدر تبدأ من جديد." },
        { quoted: msg }
      );
      return;
    }
    clearStalePracticeContest(chatId);
    pendingPoolSelection.set(chatId, {
      starterId: senderId,
      mode: "mixed",
      roundsTarget: parseInt(mixedMatch[2], 10),
      mobileOnly: mixedMatch[1] === "ج",
      hamzaMode: hamzaCheckMixed.hamzaMode,
      expiresAt: Date.now() + POOL_SELECTION_TIMEOUT_MS,
    });
    await sock.sendMessage(chatId, { text: poolSelectionMenuText() }, { quoted: msg });
    return;
  }

  // ═══ أوامر التقديم البسيطة (معاينة/تجربة، بدون تسجيل بـ.توب/.سجل) ═══

  if (text === ".ص") {
    await startPractice(chatId, sock, msg, "images");
    return;
  }
  if (text === ".تع") {
    await startPractice(chatId, sock, msg, "counts");
    return;
  }
  if (text === ".س") {
    await startPractice(chatId, sock, msg, "questions");
    return;
  }
  if (text === ".تف") {
    await startPractice(chatId, sock, msg, "dismantle");
    return;
  }
  if (text === ".عك") {
    await startPractice(chatId, sock, msg, "reverse");
    return;
  }
  if (text === ".تر") {
    await startPractice(chatId, sock, msg, "scramble");
    return;
  }

  // ".كت كلمة" / "كلمتين" / ... تغيّر عدد الكلمات الافتراضي لأمر ".كت"
  const wordSetMatch = text.match(/^\.كت (كلمة|كلمتين|ثلاث كلمات|اربع كلمات|خمس كلمات)$/);
  if (wordSetMatch) {
    const count = wordCountLabels[wordSetMatch[1]];
    practiceWordCount.set(chatId, count);
    await sock.sendMessage(chatId, { text: `✅ صار أمر .كت يرسل ${wordSetMatch[1]}.` }, { quoted: msg });
    return;
  }
  if (text === ".كت") {
    const count = practiceWordCount.get(chatId) || 1;
    await startPractice(chatId, sock, msg, "writing", { fixedWordCount: count });
    return;
  }

  // ═══ مسابقات مستمرة (تفتح بأمر، تتوقف بأمر مخصص لها) ═══

  {
    const h = stripHamzaSuffix(text);
    if (h.text === ".مسص") {
      await startEndless(chatId, sock, msg, senderId, "images", { hamzaMode: h.hamzaMode });
      return;
    }
    if (h.text === ".مسس") {
      await startEndless(chatId, sock, msg, senderId, "questions", { hamzaMode: h.hamzaMode });
      return;
    }
    if (h.text === ".مستع") {
      await startEndless(chatId, sock, msg, senderId, "counts", { hamzaMode: h.hamzaMode });
      return;
    }
    const msKtMatch = h.text.match(/^\.مسكت\s+(\d+)$/);
    if (msKtMatch) {
      const n = parseInt(msKtMatch[1], 10);
      if (n < 1) {
        await sock.sendMessage(chatId, { text: "لازم رقم 1 أو أكثر." }, { quoted: msg });
        return;
      }
      if (n > 50) {
        await sock.sendMessage(chatId, { text: "🚫 وصلت للحد الأقصى (50 كلمة بالرسالة الوحدة)." }, { quoted: msg });
        return;
      }
      await startEndless(chatId, sock, msg, senderId, "writing", { fixedWordCount: n, hamzaMode: h.hamzaMode });
      return;
    }
    if (h.text === ".مستف") {
      await startEndless(chatId, sock, msg, senderId, "dismantle", { hamzaMode: h.hamzaMode });
      return;
    }
    if (h.text === ".مسعك") {
      await startEndless(chatId, sock, msg, senderId, "reverse", { hamzaMode: h.hamzaMode });
      return;
    }
    if (h.text === ".مستر") {
      await startEndless(chatId, sock, msg, senderId, "scramble", { hamzaMode: h.hamzaMode });
      return;
    }
  }

  if (text === ".سص") {
    await stopEndless(chatId, sock, msg, "images");
    return;
  }
  if (text === ".سس") {
    await stopEndless(chatId, sock, msg, "questions");
    return;
  }
  if (text === ".ستع") {
    await stopEndless(chatId, sock, msg, "counts");
    return;
  }
  if (text === ".سكت") {
    await stopEndless(chatId, sock, msg, "writing");
    return;
  }
  if (text === ".ستف") {
    await stopEndless(chatId, sock, msg, "dismantle");
    return;
  }
  if (text === ".سعك") {
    await stopEndless(chatId, sock, msg, "reverse");
    return;
  }
  if (text === ".ستر") {
    await stopEndless(chatId, sock, msg, "scramble");
    return;
  }

  // ═══ أوامر إدارة التسجيل من المالك ═══

  const removeResetMatch = text.match(/^\.ازالة تصفير(?:\s+(.+))?$/);
  if (removeResetMatch) {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    await resolveTargetOrAsk(sock, chatId, msg, senderId, removeResetMatch[1], "استخدم الأمر مع منشن أو اسم للشخص: .ازالة تصفير @الشخص", async (target) => {
      await registration.hardDelete(target);
      leaderboard.removeUser(target);
      personalHistory.removeUser(target);
      standings.removeUser(target);
      await sock.sendMessage(
        chatId,
        { text: "🗑️ تم إزالة تسجيله وتصفير كل سجلاته من .توب و.سجل.", mentions: [target] },
        { quoted: msg }
      );
    });
    return;
  }

  const removeMatch = text.match(/^\.ازالة(?:\s+(.+))?$/);
  if (removeMatch) {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    await resolveTargetOrAsk(sock, chatId, msg, senderId, removeMatch[1], "استخدم الأمر مع منشن أو اسم للشخص: .ازالة @الشخص", async (target) => {
      await registration.hardDelete(target);
      await sock.sendMessage(
        chatId,
        { text: "✅ تم إزالة تسجيله (بدون تصفير سجلاته من .توب/.سجل).", mentions: [target] },
        { quoted: msg }
      );
    });
    return;
  }

  // أمر وقف المسابقة (بس للفنشات العادية اللي لها هدف — مو المستمرة)
  if (text === ".انهاء") {
    const contest = activeContests.get(chatId);
    if (!contest || !contest.active) {
      await sock.sendMessage(chatId, { text: "ما فيه مسابقة شغالة حالياً." }, { quoted: msg });
      return;
    }
    if (contest.endless) {
      const stopCmdFor = { writing: ".سكت", images: ".سص", questions: ".سس", counts: ".ستع", dismantle: ".ستف", reverse: ".سعك", scramble: ".ستر" };
      await sock.sendMessage(
        chatId,
        { text: `⚠️ هذي مسابقة مستمرة، ما توقف بـ .انهاء. استخدم: ${stopCmdFor[contest.contestType]}` },
        { quoted: msg }
      );
      return;
    }
    await contest.endContest(); // يوقف ويعرض النتائج مباشرة
    activeContests.delete(chatId); // ✅ نظف من الذاكرة
    return;
  }

  // أمر .سكب: يتخطى السؤال/الصورة/التعداد الحالي (مهما كان نوعه)، يرسل
  // الإجابة الصحيحة، وينتقل للي بعده بدون ما يحسب نقاط لحد
  if (text === ".سكب") {
    const contest = activeContests.get(chatId);
    if (!contest || !contest.active) {
      await sock.sendMessage(chatId, { text: "ما فيه مسابقة شغالة حالياً." }, { quoted: msg });
      return;
    }
    const skipped = await contest.skipRound(msg);
    if (!skipped) {
      await sock.sendMessage(chatId, { text: "ما فيه سؤال حالياً يُسكب." }, { quoted: msg });
    }
    return;
  }

  // أمر عرض النقاط الحالية أثناء المسابقة
  if (text === "النقاط") {
    const contest = activeContests.get(chatId);
    if (!contest || !contest.active) {
      await sock.sendMessage(chatId, { text: "ما فيه مسابقة شغالة حالياً." }, { quoted: msg });
      return;
    }
    await contest.sendScoreboard();
    return;
  }

  // تمرير الرسالة لمحرك المسابقة النشطة (لفحص الإجابات)
  const contest = activeContests.get(chatId);
  if (contest && contest.active) {
    await contest.handleMessage(msg, text, senderId);
  }
}

// نقطة البداية: نتصل بقاعدة البيانات ونسحب كل البيانات المحفوظة (مرة
// وحدة بس، مو عند كل إعادة اتصال بواتساب)، وبعدها نشغّل اتصال واتساب
async function main() {
  startHealthServer(); // يفتح منفذ HTTP بسيط (يحتاجه Render وأشباهه)
  await db.connect(store.getConfig().mongoUri);
  await Promise.all([
    leaderboard.loadFromDb(),
    personalHistory.loadFromDb(),
    standings.loadFromDb(),
    registration.loadFromDb(),
    moderation.loadFromDb(),
    dmPermissions.loadFromDb(),
    roulette.loadFromDb(),
    rasad.loadFromDb(),
  ]);
  // 🌱 نبذر تاريخ .نقاطي الشخصي بأفضل نتيجة موجودة أصلاً بلوحة الصدارة
  // العامة — عشان اللي عنده نتائج من قبل إضافة هذي الميزة يشوفها فورًا
  // بدون ما يحتاج يلعب من جديد. آمنة تتكرر كل تشغيل (idempotent)
  for (const poolType of leaderboard.getAllTypes()) {
    personalHistory.seedFromLeaderboard(leaderboard.getTop(poolType, 999), poolType);
  }
  // 🔒 ننتظر لين نتأكد ما فيه نسخة ثانية من البوت شغّالة (تعارض جلسات
  // يقفل الاتصال بواتساب بخطأ device_removed) — سيرفر الـHTTP فوق شغّال
  // أصلاً فيرضي فحص Render الصحي، حتى لو انتظرنا هنا شوي
  await instanceLock.acquireWithRetry();
  await connectSocket();
}
setInterval(() => {
  const mem = process.memoryUsage();
  console.log(`📊 الذاكرة: RSS=${(mem.rss / 1024 / 1024).toFixed(1)}MB | Heap=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`);
}, 5 * 60 * 1000); // كل 5 دقايق

// ✅ نحرر قفل النسخة الوحيدة صراحة وقت إغلاق البرنامج (Render يبعث SIGTERM
// وقت أي Redeploy/Restart) — بدون هذا، القفل يفضل "محجوز" باسم نسخة ميتة
// لين تنتهي مهلة الدقيقة (STALE_AFTER_MS)، وبهالفترة ممكن يصير تداخل بين
// النسخة القديمة (تحتضر) والجديدة (تنتظر/تحاول). التحرير الصريح هنا يخلي
// النسخة الجديدة تاخذ القفل فورًا تقريبًا بدون أي انتظار
async function shutdown(signal) {
  console.log(`🛑 استلمنا ${signal} — نحرر قفل النسخة ونطفي بأمان...`);
  try {
    await personalHistory.flushPending();
  } catch (e) {
    console.error("⚠️ خطأ أثناء تفريغ السجل الشخصي المؤجل وقت الإغلاق:", e.message);
  }
  try {
    await instanceLock.release();
  } catch (e) {
    console.error("⚠️ خطأ أثناء تحرير القفل وقت الإغلاق:", e.message);
  }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main();
