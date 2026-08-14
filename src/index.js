const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const P = require("pino");
const fs = require("fs");
const qrcode = require("qrcode-terminal");
const store = require("./dataStore");
const { Contest } = require("./game");
const leaderboard = require("./leaderboard");
const standings = require("./standings");
const registration = require("./registration");
const moderation = require("./moderation");
const templates = require("./templates");
const db = require("./db");
const { useMongoAuthState } = require("./mongoAuthState");
const { startHealthServer, setQr, clearQr } = require("./healthServer");
const { createSticker, createAnimatedSticker } = require("./stickerMaker");
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const CONFIG = store.getConfig(); // ✅ نقرأ config مرة وحدة عند التشغيل
const { handleMatsuriMessage } = require("../matsuri/matsuri");

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

// كل محادثة (قروب أو خاص) عندها مسابقة مستقلة
const activeContests = new Map(); // chatId -> Contest

// طلبات تغيير نوع التسجيل المعلّقة، بانتظار موافقة صاحب البوت
// userId -> "mobile" | "external"
const pendingChangeRequests = new Map();

function isChatAllowed(chatId) {
  const cfg = store.getConfig();
  if (!cfg.allowedChats || cfg.allowedChats.length === 0) return true;
  return cfg.allowedChats.includes(chatId);
}

// يتحقق إن الشخص هو صاحب البوت (المحدد بـ ownerId بملف config.json)
// لو ownerId فاضي (ما تحدد بعد)، نرفض الأمر بدل ما نسمح لأي أحد افتراضياً
function isOwner(senderId) {
  return !!CONFIG.ownerId && senderId === CONFIG.ownerId;
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

const endlessTypeLabels = { images: "صور", writing: "كتابة", counts: "تعداد", questions: "أسئلة" };

// يبدأ مسابقة مستمرة (ما تتوقف تلقائياً، بس بأمر إيقاف مخصص)
async function startEndless(chatId, sock, msg, poolType, extraOpts = {}) {
  if (activeContests.has(chatId) && activeContests.get(chatId).active) {
    await sock.sendMessage(chatId, { text: "⚠️ فيه مسابقة شغالة بالفعل بهذي المحادثة." }, { quoted: msg });
    return;
  }
  const contest = new Contest(chatId, sock, poolType, Infinity, { endless: true, ...extraOpts });
  activeContests.set(chatId, contest);
  await sock.sendMessage(chatId, {
    text: `🎬 بدأت مسابقة *${endlessTypeLabels[poolType]}* مستمرة! ما تتوقف إلا بأمر الإيقاف المخصص لها.`,
  });
  await safeStartFirstRound(chatId, sock, contest);
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
function parseStartCommand(text) {
  const t = text.trim().replace(/\s+/g, " ");
  const typeMap = {
    فنش: "general",
    فص: "images",
    فكت: "writing",
    فتع: "counts",
    فسس: "questions",
  };

  const match = t.match(/^\.(فنش|فص|فكت|فتع|فسس)(?:\s+(ج))?\s*(\d+)$/);
  if (!match) return null;

  const cmdWord = match[1];
  const mobileOnly = match[2] === "ج";
  const target = parseInt(match[3], 10);
  const contestType = typeMap[cmdWord];

  return { contestType, target, mobileOnly };
}

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
const poolLabels = { writing: "كتابة", images: "صور", questions: "أسئلة", counts: "تعداد" };
const topTypeMap = { ص: "images", كت: "writing", تع: "counts", سس: "questions" };

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

async function connectSocket() {
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

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
  });

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
        console.log("⚠️ انقطع الاتصال. إعادة محاولة...");
        connectSocket();
      } else {
        console.log("⚠️ تم تسجيل الخروج من واتساب. نمسح الجلسة القديمة ونطلب QR جديد...");
        await clearAuthSession();
        connectSocket();
      }
    } else if (connection === "open") {
      console.log("✅ البوت جاهز ومتصل بواتساب!");
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
          await handleIncoming(sock, msg);
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
  if (!isChatAllowed(chatId)) return;

  const text = extractText(msg);
  // بالقروبات: participant هو آيدي الشخص الفعلي. بالخاص: remoteJid هو نفسه
  const senderId = msg.key.participant || msg.key.remoteJid;

  if (await handleMatsuriMessage(sock, msg, text, chatId, senderId)) return;

  // أمر مساعدة: يعطيك آيدي المحادثة عشان تحطه بـ config.json لو تبي تحصر البوت بقروب معين
  if (text === "شات الايدي" || text === "chat id") {
    await sock.sendMessage(chatId, { text: `آيدي هذي المحادثة:\n${chatId}` }, { quoted: msg });
    return;
  }

  // أمر .ريم اوامر: قائمة كل الأوامر مصنفة
  if (text === ".ريم اوامر") {
    const helpText = `˼‏⬩بــوت ريــم • レム┊🤖˹
❆ ⋅ ┈── ─━ •⊰✣⊱ • ━─ ──┈ ⋅ ❆
◞الـقـائـمـة الأسـاسـيـة╎˼‏📋˹⤹◜
     ◝الاوامــر⇆🕹️◟
      ❊ ┉ ٠ ┈─ • ⊰ 倖 ⊱ • ─┈ ٠ ┉ ❊
> *✠ الـمـسـابـقـات • 🎮◜*
 *◈ عـــام • 🔰◜*

◞◈ .مسابقة <رقم> •— مسابقة عامه◜
◞◈ .فنش <رقم> •— فنش عام◜
◞◈ .فص <رقم> •— فنش صور◜
◞◈ .فكت <رقم> •— فنش كت◜ 
◞◈ .فتع <رقم> •— فنش تعداد◜ 
◞◈ .فسس <رقم> •— فنش سس◜ 
◞◈ .انهاء •— ايقاف المسابقة◜ 
◞◈ .سكب •— لتخطي اي سؤال◜
◞◈ النقاط •— عرض النقاط اثناء المسابقة◜ 
*˼‏مثال: .فنش 15⋄◟*

 *◈ لـلـجـوالات • 📱◜*

◞◈ كل الاوامر السابقة بإضافة ج •— .فكت ج◜ 
◞◈ .مسابقة ج <رقم> •— مسابقة جوالات◜
◞◈ .فنش ج <رقم> •— فنش جوالات◜
*˼‏مثال: .فنش ج 15⋄◟*


*◈ الـمـسـابـقـات الـمـسـتـمـرة• ♾️◜*
◞◈ .مسص •— إيقاف: .سص◜
◞◈ .مسكت •— إيقاف: .سكت◜ 
◞◈ .مستع •— إيقاف: .ستع◜ 
◞◈ .مسس •— إيقاف: .سس◜ 

*◈ فـقـرات عـاديـة• 🎗️◜*
◞◈ .ص •— صور◜
◞◈ .كت •— كتابة◜ 
◞◈ .تع •— تعداد◜ 
◞◈ .س •— اسئلة◜
      ❊ ┉ ٠ ┈─ • ⊰ 倖 ⊱ • ─┈ ٠ ┉ ❊
> *✠ الـتـسـجـيـل • 📍◜*

◞◈ .تسجيل جوال •— لاعب جوال◜
◞◈ .تسجيل خارجي •— لاعب كيبورد/لاب/بي سي◜
◞◈ .تغيير تسجيل جوال/خارجي •— طلب تغيير النوع◜ 
◞◈ .الغاء التسجيل •— يمسح تسجيلك مع سجلاتك◜ 
◞◈ .تسجيلات •— يعرض المسجلين جوال/خارجي◜
◞◈ .قائمة_تع •— كل عناصر التعداد مع إجاباتها◜
◞◈ .قائمة_سس •— كل الأسئلة مع إجاباتها◜
*˼‏مهم جدا: سجل بأمانة او يتم حظرك⋄◟*
      ❊ ┉ ٠ ┈─ • ⊰ 倖 ⊱ • ─┈ ٠ ┉ ❊
> *✠ الـتـرتـيـب والصدارة • 🏆◜*
*◈ عـــام • 🔰◜*

◞◈ .توب •— توب 3 لكل الفقرات◜
◞◈ .توب ص • كت • س • تع •— لكل فقرة◜ 
◞◈ .سجل •— ترتيب عام للفنش والنقاط◜ 

*◈ لـلـجـوالات • 📱◜*

◞◈ .توب جوالات •— توب 3 لكل الفقرات◜
◞◈ .توب ص • كت • س • تع • جوال ◜ 
◞◈ .سجل •— ترتيب جوالات للفنش والنقاط◜ 
*˼‏مثال: .توب ص جوال⋄◟*
❊ ┉ ٠ ┈─ • ⊰ 倖 ⊱ • ─┈ ٠ ┉ ❊
> *✠ اوامـر الـ Owner • 👑◜*

◞◈ .ايقاف @ •— استبعاد من قوائم الجوالات◜ 
◞◈ .حظر @ •— حظر من اللعب◜
◞◈ .الغاء ايقاف/حظر @ •— الغاء الامرين◜ 
◞◈ .ازالة @ •— تزيل اللاعب من التسجيلات◜ 
◞◈ .ازالة تصفير @ •— ازالة اللاعب مع حذف السجلات◜
◞◈ .قبول/.رفض تغيير @ •— الرد على طلب تغيير تسجيل◜
◞◈ .ريسيت توب/سجل @ •— تصفير لشخص معين◜
◞◈ .ريسيت تسجيلات •— تصفير كل التسجيلات (الكل يسجل من جديد)◜
❆ ⋅ ┈── ─━ •⊰✣⊱ • ━─ ──┈ ⋅ ❆`;
    await sock.sendMessage(chatId, { text: helpText }, { quoted: msg });
    return;
  }

  // أمر تشخيصي: يعطيك آيديك الشخصي عشان نتأكد المنشن يشتغل صح
  // (لو واتساب يستخدم نظام الخصوصية الجديد LID بهذا القروب، الآيدي بيكون
  // شكله @lid بدل رقم جوالك، وهذا سبب معروف لمشاكل المنشن مو خطأ بالبوت)
  if (text === "ايديي" || text === "my id") {
    await sock.sendMessage(chatId, { text: `آيديك بهذي المحادثة:\n${senderId}`, mentions: [senderId] }, { quoted: msg });
    return;
  }

// ═══ أمر .ستيكر — ميزة خاصة (ما موجودة بقائمة الأوامر) ═══
  const stickerMatch = text.match(/^\.ستيكر\s+(.+)$/);
  if (stickerMatch) {
    const raw = stickerMatch[1].trim();
    if (!raw) {
      await sock.sendMessage(
        chatId,
        { text: "⚠️ اكتب الحقوق بعد الأمر، مثال:\n.ستيكر J18\n.ستيكر J18/فداك الستيكر" },
        { quoted: msg }
      );
      return;
    }

    // تفكيك: pack/author
    // النص الأبيض (pack) = قبل /
    // النص الرمادي (author) = بعد /
    let pack, author;
    if (raw.includes("/")) {
      const parts = raw.split("/");
      pack = parts[0].trim();
      author = parts.slice(1).join("/").trim();
    } else {
      pack = raw;
      author = "";
    }

    const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
    const quoted = contextInfo?.quotedMessage;

    if (!quoted) {
      await sock.sendMessage(
        chatId,
        { text: "⚠️ رد على *صورة* أو *ستيكر* أولاً، ثم اكتب الأمر." },
        { quoted: msg }
      );
      return;
    }

    try {
      let buffer = null;
      let isVideo = false;

      if (quoted.imageMessage) {
        const stream = await downloadContentFromMessage(quoted.imageMessage, "image");
        buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
      } else if (quoted.stickerMessage) {
        const stream = await downloadContentFromMessage(quoted.stickerMessage, "image");
        buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
      } else if (quoted.videoMessage) {
        const stream = await downloadContentFromMessage(quoted.videoMessage, "video");
        buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        isVideo = true;
      }

      if (!buffer || buffer.length === 0) {
        await sock.sendMessage(
          chatId,
          { text: "⚠️ ما قدرت أحمل الملف. جرب صورة/فيديو/ستيكر ثاني." },
          { quoted: msg }
        );
        return;
      }

      const stickerBuffer = isVideo
        ? await createAnimatedSticker(buffer, pack, author)
        : await createSticker(buffer, pack, author);

     await sock.sendMessage(
        chatId,
        {
          sticker: stickerBuffer,
          pack: pack,
          author: author,
        },
        { quoted: msg }
      );
    } catch (err) {
      console.error("⚠️ خطأ بإنشاء الستيكر:", err.message);
      await sock.sendMessage(
        chatId,
        { text: `⚠️ صار خطأ: ${err.message}` },
        { quoted: msg }
      );
    }
    return;
  }
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
if (/^\.قبول تغيير(\s|$)/.test(text)) {
  if (!isOwner(senderId)) {
    await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
    return;
  }
  const target = getMentionedJid(msg);
  if (!target) {
    await sock.sendMessage(chatId, { text: "استخدم الأمر مع منشن للشخص: .قبول تغيير @الشخص" }, { quoted: msg });
    return;
  }
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
  return;
}

if (/^\.رفض تغيير(\s|$)/.test(text)) {
  if (!isOwner(senderId)) {
    await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
    return;
  }
  const target = getMentionedJid(msg);
  if (!target) {
    await sock.sendMessage(chatId, { text: "استخدم الأمر مع منشن للشخص: .رفض تغيير @الشخص" }, { quoted: msg });
    return;
  }
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
  return;
}

  // أمر .الغاء تسجيل (أو إلغاء): يمسح تسجيلك وكل سجلاتك (توب وسجل) بالكامل
  if (text === ".الغاء تسجيل" || text === ".إلغاء تسجيل") {
    await registration.unregister(senderId);
    leaderboard.removeUser(senderId);
    standings.removeUser(senderId);
    await sock.sendMessage(chatId, { text: "🗑️ تم إلغاء تسجيلك، وحذف كل سجلاتك من .توب و.سجل." }, { quoted: msg });
    return;
  }

  // أوامر إشراف (.ايقاف / .الغاء ايقاف / .حظر / .الغاء حظر) — لصاحب البوت بس
  if (/^\.الغاء ايقاف(\s|$)/.test(text) || /^\.إلغاء إيقاف(\s|$)/.test(text)) {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    const target = getMentionedJid(msg);
    if (!target) {
      await sock.sendMessage(chatId, { text: "استخدم الأمر مع منشن للشخص: .الغاء ايقاف @الشخص" }, { quoted: msg });
      return;
    }
    moderation.unsuspend(target);
    await sock.sendMessage(chatId, { text: "✅ تم رفع الإيقاف عنه، رجع مؤهل لقوائم الجوالات.", mentions: [target] }, { quoted: msg });
    return;
  }

  if (/^\.ايقاف(\s|$)/.test(text)) {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    const target = getMentionedJid(msg);
    if (!target) {
      await sock.sendMessage(chatId, { text: "استخدم الأمر مع منشن للشخص: .ايقاف @الشخص" }, { quoted: msg });
      return;
    }
    moderation.suspend(target);
    await sock.sendMessage(
      chatId,
      { text: "⏸️ تم إيقافه من قوائم الجوالات (يلعب عادي، نقاطه العامة تُحسب، بس مستبعد من .توب/.سجل جوالات).", mentions: [target] },
      { quoted: msg }
    );
    return;
  }

  if (/^\.الغاء حظر(\s|$)/.test(text) || /^\.إلغاء حظر(\s|$)/.test(text)) {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    const target = getMentionedJid(msg);
    if (!target) {
      await sock.sendMessage(chatId, { text: "استخدم الأمر مع منشن للشخص: .الغاء حظر @الشخص" }, { quoted: msg });
      return;
    }
    moderation.unban(target);
    await sock.sendMessage(chatId, { text: "✅ تم فك الحظر عنه، يقدر يلعب من جديد.", mentions: [target] }, { quoted: msg });
    return;
  }

  if (/^\.حظر(\s|$)/.test(text)) {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    const target = getMentionedJid(msg);
    if (!target) {
      await sock.sendMessage(chatId, { text: "استخدم الأمر مع منشن للشخص: .حظر @الشخص" }, { quoted: msg });
      return;
    }
    moderation.ban(target);
    await sock.sendMessage(
      chatId,
      { text: "🚫 تم حظره، رسائله بالمسابقات تُتجاهل تماماً (ما يحصل نقاط ولا يفوز بأي جولة).", mentions: [target] },
      { quoted: msg }
    );
    return;
  }

  // أمر .توب أو .توب <نوع>: يعرض أفضل الأوقات (3 لكل الفقرات، أو 5 لفقرة محددة)
  const topMatch = text.match(/^\.توب(?:\s+(ص|كت|تع|سس))?$/);
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
  const topMobileMatch = text.match(/^\.توب (ص|كت|تع|سس) جوال$/);
  if (topMobileMatch) {
    const poolType = topTypeMap[topMobileMatch[1]];
    const entries = leaderboard.getTopFiltered(poolType, 5, (e) => isMobileEligible(e.userId));
    const out = templates.formatTopSection(poolType, entries, templates.TOP_SUBTITLE_MOBILE);
    const mentions = entries.map((e) => e.userId);
    await sock.sendMessage(chatId, { text: out, mentions }, { quoted: msg });
    return;
  }

  // أمر .ريسيت توب أو .ريسيت توب <نوع> [@شخص]: يصفّر لوحة الصدارة (كلها،
  // أو فقرة وحدة، أو سجل شخص معين بس لو فيه منشن) — مخصص لصاحب البوت بس
  const resetTopMatch = text.match(/^\.ريسيت توب(?:\s+(ص|كت|تع|سس))?(?:\s|$)/);
  if (resetTopMatch) {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    const shortType = resetTopMatch[1];
    const poolType = shortType ? topTypeMap[shortType] : null;
    const target = getMentionedJid(msg);

    if (target) {
      if (poolType) {
        leaderboard.removeUserFromPool(poolType, target);
        await sock.sendMessage(
          chatId,
          { text: `🗑️ تم حذف سجل @${target.split("@")[0]} من توب فقرة ${poolLabels[poolType]}.`, mentions: [target] },
          { quoted: msg }
        );
      } else {
        leaderboard.removeUser(target);
        await sock.sendMessage(
          chatId,
          { text: `🗑️ تم حذف كل سجلات @${target.split("@")[0]} من التوب (كل الفقرات).`, mentions: [target] },
          { quoted: msg }
        );
      }
      return;
    }

    if (poolType) {
      leaderboard.reset(poolType);
      await sock.sendMessage(
        chatId,
        { text: `🗑️ تم تصفير لوحة صدارة فقرة ${poolLabels[poolType]}.` },
        { quoted: msg }
      );
    } else {
      leaderboard.reset();
      await sock.sendMessage(chatId, { text: "🗑️ تم تصفير لوحة الصدارة بالكامل." }, { quoted: msg });
    }
    return;
  }

  // أمر .سجل: يعرض السجل التراكمي (مجموع نقاط كل شخص عبر كل المسابقات
  // اللي شارك فيها 3 أشخاص فأكثر)
  if (text === ".سجل") {
    const list = standings.getStandings();
    await sendStandingsList(sock, chatId, msg, list, templates.TOP_SUBTITLE_ALL);
    return;
  }

  // أمر .سجل جوالات: زي .سجل بس بس الأشخاص المسجلين كجوال
  if (text === ".سجل جوالات") {
    const list = standings.getStandingsFiltered((userId) => isMobileEligible(userId));
    await sendStandingsList(sock, chatId, msg, list, templates.TOP_SUBTITLE_MOBILE);
    return;
  }

  // أمر .تسجيلات: يعرض كل الأعضاء المسجلين (خارجي وجوال) مع منشنهم
  // (اسمها القديم كان .قائمة)
  if (text === ".تسجيلات") {
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

  // أمر .ريسيت سجل [@شخص]: يصفّر السجل التراكمي كامل، أو سجل شخص معين بس
  // لو فيه منشن — مخصص لصاحب البوت بس
  if (/^\.ريسيت سجل(\s|$)/.test(text)) {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    const target = getMentionedJid(msg);
    if (target) {
      standings.removeUser(target);
      await sock.sendMessage(
        chatId,
        { text: `🗑️ تم حذف سجل @${target.split("@")[0]} من السجل التراكمي.`, mentions: [target] },
        { quoted: msg }
      );
      return;
    }
    standings.reset();
    await sock.sendMessage(chatId, { text: "🗑️ تم تصفير السجل العام بالكامل." }, { quoted: msg });
    return;
  }

  // أمر بدء مسابقة
  const startCmd = parseStartCommand(text);
  if (startCmd) {
    if (activeContests.has(chatId) && activeContests.get(chatId).active) {
      await sock.sendMessage(
        chatId,
        { text: "⚠️ فيه مسابقة شغالة بالفعل بهذي المحادثة. اكتب: .انهاء عشان تنهيها." },
        { quoted: msg }
      );
      return;
    }
    const contest = new Contest(chatId, sock, startCmd.contestType, startCmd.target, {
      mobileOnly: startCmd.mobileOnly,
    });
    activeContests.set(chatId, contest);

    const typeLabels = {
      general: "عامة (كل الفقرات)",
      images: "صور",
      counts: "تعداد",
      writing: "كتابة",
      questions: "أسئلة",
    };
    const mobileNote = startCmd.mobileOnly ? " 📱 (جوالات بس)" : "";
    // ✅ محمية بـ try/catch: لو فشلت رسالة "بدأت مسابقة" (انقطاع لحظي
    // بالاتصال)، لازم نكمل ونبدأ السؤال الأول برضو — قبل كذا، فشل هذي
    // الرسالة وحدها كان يوقف كل شي (ما يوصل السؤال الأول أبدًا) بصمت
    try {
      await sock.sendMessage(chatId, {
        text: `🎬 بدأت مسابقة *${typeLabels[startCmd.contestType]}*${mobileNote}!\nالنقاط المطلوبة للفوز: ${startCmd.target}\nبالتوفيق للجميع 🍀`,
      });
    } catch (e) {
      console.error("⚠️ فشل إرسال رسالة بدء المسابقة (تجاهلناه، نكمل لبدء السؤال الأول):", e);
    }
    await safeStartFirstRound(chatId, sock, contest);
    return;
  }

  // أمر .مسابقة <رقم> أو .مسابقة ج <رقم>: فقرات منوعة (زي .فنش) بس تنتهي
  // لما مجموع عدد الأسئلة الكلي (بغض النظر مين جاوب) يوصل الرقم — مو
  // أول شخص يوصل هدف
  const mixedMatch = text.match(/^\.مسابقة(?:\s+(ج))?\s+(\d+)$/);
  if (mixedMatch) {
    if (activeContests.has(chatId) && activeContests.get(chatId).active) {
      await sock.sendMessage(
        chatId,
        { text: "⚠️ فيه مسابقة شغالة بالفعل بهذي المحادثة. اكتب: .انهاء عشان تنهيها." },
        { quoted: msg }
      );
      return;
    }
    const mobileOnly = mixedMatch[1] === "ج";
    const roundsTarget = parseInt(mixedMatch[2], 10);
    const contest = new Contest(chatId, sock, "general", Infinity, { roundsTarget, mobileOnly });
    activeContests.set(chatId, contest);
    const mobileNote = mobileOnly ? " 📱 (جوالات بس)" : "";
    // ✅ نفس الحماية: فشل رسالة البدء ما لازم يمنع بدء السؤال الأول
    try {
      await sock.sendMessage(chatId, {
        text: `🎬 بدأت مسابقة *منوعة*${mobileNote} (فقرات مختلفة)!\nعدد الأسئلة الكلي: ${roundsTarget}\nبالتوفيق للجميع 🍀`,
      });
    } catch (e) {
      console.error("⚠️ فشل إرسال رسالة بدء المسابقة المنوعة (تجاهلناه، نكمل لبدء السؤال الأول):", e);
    }
    await safeStartFirstRound(chatId, sock, contest);
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

  if (text === ".مسص") {
    await startEndless(chatId, sock, msg, "images");
    return;
  }
  if (text === ".مسس") {
    await startEndless(chatId, sock, msg, "questions");
    return;
  }
  if (text === ".مستع") {
    await startEndless(chatId, sock, msg, "counts");
    return;
  }
  const msKtMatch = text.match(/^\.مسكت\s+(\d+)$/);
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
    await startEndless(chatId, sock, msg, "writing", { fixedWordCount: n });
    return;
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

  // ═══ أوامر إدارة التسجيل من المالك ═══

  if (/^\.ازالة تصفير(\s|$)/.test(text)) {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    const target = getMentionedJid(msg);
    if (!target) {
      await sock.sendMessage(chatId, { text: "استخدم الأمر مع منشن للشخص: .ازالة تصفير @الشخص" }, { quoted: msg });
      return;
    }
    await registration.hardDelete(target);
    leaderboard.removeUser(target);
    standings.removeUser(target);
    await sock.sendMessage(
      chatId,
      { text: "🗑️ تم إزالة تسجيله وتصفير كل سجلاته من .توب و.سجل.", mentions: [target] },
      { quoted: msg }
    );
    return;
  }

  if (/^\.ازالة(\s|$)/.test(text)) {
    if (!isOwner(senderId)) {
      await sock.sendMessage(chatId, { text: "⛔ هذا الأمر مخصص لصاحب البوت بس." }, { quoted: msg });
      return;
    }
    const target = getMentionedJid(msg);
    if (!target) {
      await sock.sendMessage(chatId, { text: "استخدم الأمر مع منشن للشخص: .ازالة @الشخص" }, { quoted: msg });
      return;
    }
    await registration.hardDelete(target);
    await sock.sendMessage(
      chatId,
      { text: "✅ تم إزالة تسجيله (بدون تصفير سجلاته من .توب/.سجل).", mentions: [target] },
      { quoted: msg }
    );
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
      const stopCmdFor = { writing: ".سكت", images: ".سص", questions: ".سس", counts: ".ستع" };
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
    standings.loadFromDb(),
    registration.loadFromDb(),
    moderation.loadFromDb(),
    roulette.loadFromDb(),
  ]);
  await connectSocket();
}

main();
