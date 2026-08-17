// قسم الرصد — يحسب فلوس الأعضاء داخل قروب مخصص (rasadChatId)
// الأوامر الإدارية (بدء/انهاء/رصد_الكل/تصفير) خاصة بصاحب البوت + صاحب
// وزارة ماتسوري بس (نفس صلاحية قسم الروليت). أمر .رصد متاح للجميع.
//
// طريقة العمل:
//  - أثناء الرصد الفعّال، أي رسالة توصل بقروب الرصد تتفحص فوراً (بدون أي
//    فحص دوري/polling — بس رد فعل على حدث "رسالة جديدة")، وترد فوراً
//    إما "✅ تم الرصد" أو "❌ حدثت مشكلة أثناء الرصد"
//  - كل رسالة (بغض النظر هل الرصد شغال أو لا) تُسجَّل بسجل خام مؤقت
//    بقاعدة البيانات (مع آيدي الرسالة نفسها)، عشان أمر ".رصد_الكل" يقدر
//    يعيد حساب الأسبوع كامل، وعشان أمر ".رصد" يقدر يتأكد من رسالة معينة
//  - أمر ".رصد" لازم يُرسل كـ"رد" (reply) على الرسالة المطلوب التأكد منها
//  - النتيجة النهائية (قائمة الجويل) تُحفظ بالخلفية بعد كل تحديث

const { getDb } = require("../src/db");
const store = require("../src/dataStore");
const RD = require("./rasadData");
const { parseMessage, resolvePartialName } = require("./rasadParser");

// حالة بالذاكرة
let totals = {}; // { key: amountK }
let active = false;
let startedAt = null;

async function loadFromDb() {
  const db = getDb();
  if (!db) return;
  try {
    const doc = await db.collection("matsuri_rasad").findOne({ _id: "state" });
    if (doc) {
      totals = doc.totals || {};
      active = !!doc.active;
      startedAt = doc.startedAt || null;
    }
  } catch (err) {
    console.error("خطأ تحميل بيانات الرصد:", err.message);
  }
}

async function persist() {
  const db = getDb();
  if (!db) return;
  try {
    await db
      .collection("matsuri_rasad")
      .updateOne({ _id: "state" }, { $set: { totals, active, startedAt } }, { upsert: true });
  } catch (err) {
    console.error("خطأ حفظ بيانات الرصد:", err.message);
  }
}

// سجل خام لكل رسالة تدخل قروب الرصد (لأجل .رصد_الكل و.رصد)
async function logRawMessage(msgId, senderId, text, timestamp, parsed) {
  const db = getDb();
  if (!db) return;
  try {
    await db.collection("matsuri_rasad_log").insertOne({ msgId, senderId, text, timestamp, parsed });
  } catch (err) {
    console.error("خطأ تسجيل رسالة الرصد:", err.message);
  }
}

async function markLogParsed(msgId) {
  const db = getDb();
  if (!db || !msgId) return;
  try {
    await db.collection("matsuri_rasad_log").updateOne({ msgId }, { $set: { parsed: true } });
  } catch (err) {
    console.error("خطأ تحديث سجل الرصد:", err.message);
  }
}

async function findLogByMsgId(msgId) {
  const db = getDb();
  if (!db || !msgId) return null;
  try {
    return await db.collection("matsuri_rasad_log").findOne({ msgId });
  } catch (err) {
    console.error("خطأ بحث سجل الرصد:", err.message);
    return null;
  }
}

async function clearRawLog() {
  const db = getDb();
  if (!db) return;
  try {
    await db.collection("matsuri_rasad_log").deleteMany({});
  } catch (err) {
    console.error("خطأ تصفير سجل الرصد:", err.message);
  }
}

function isRasadAdmin(senderId) {
  const cfg = store.getConfig();
  const rawId = String(senderId || "").split("@")[0];
  const owner = String(cfg.ownerId || "").split("@")[0];
  const matsuriOwner = String(cfg.matsuriOwnerId || "").split("@")[0];
  if (!rawId) return false;
  return (owner && rawId === owner) || (matsuriOwner && rawId === matsuriOwner);
}

function isRasadChat(chatId) {
  const cfg = store.getConfig();
  return !!cfg.rasadChatId && chatId === cfg.rasadChatId;
}

// يطبّق قائمة أزواج (key/namePartial, amount) على الإجمالي، ويرجع true
// لو قدر يطبّق شي فعلاً (عشان نعرف نعتبر الرسالة "منرصدة" أو لا)
function applyEntries(entries) {
  let appliedAny = false;
  for (const e of entries) {
    let key = e.key;
    if (!key && e.namePartial) {
      key = resolvePartialName(e.namePartial, Object.keys(totals));
    }
    if (!key) continue; // ما قدرنا نحدد مين بالضبط (اسم جديد بلا شعار، أو لبس)
    totals[key] = (totals[key] || 0) + e.amount;
    appliedAny = true;
  }
  return appliedAny;
}

function formatAmount(n) {
  const sign = n < 0 ? "-" : "";
  return `${sign}${Math.abs(n)}k`;
}

function renderList() {
  const keys = Object.keys(totals);
  if (!keys.length) {
    return RD.listTemplate.replace("{entries}", "⪦ لا يوجد بيانات حالياً");
  }
  const entries = keys.map((k) => `⪦ ${k} ${formatAmount(totals[k])}`).join("\n");
  return RD.listTemplate.replace("{entries}", entries);
}

async function reply(sock, chatId, msg, text) {
  await sock.sendMessage(chatId, { text }, { quoted: msg });
}

// يستخرج نص وآيدي الرسالة المقتبسة (المردود عليها) — يرجع null لو
// الرسالة الحالية مو رد على شي
function extractQuoted(msg) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (!ctx || !ctx.quotedMessage) return null;
  const qm = ctx.quotedMessage;
  const text = (
    qm.conversation ||
    qm.extendedTextMessage?.text ||
    qm.imageMessage?.caption ||
    qm.videoMessage?.caption ||
    ""
  ).trim();
  return { text, msgId: ctx.stanzaId || null };
}

// يعيد حساب الإجمالي من الصفر بالاعتماد على السجل الخام، من بداية يوم
// الجمعة (12:00 صباحاً) إلى الآن — تُستخدم بأمر .رصد_الكل الاحتياطي
async function recomputeFromLog() {
  const db = getDb();
  if (!db) return null;

  const now = new Date();
  const fridayStart = new Date(now);
  // getDay(): الجمعة = 5
  const diffDays = (fridayStart.getDay() - 5 + 7) % 7;
  fridayStart.setDate(fridayStart.getDate() - diffDays);
  fridayStart.setHours(0, 0, 0, 0);

  const docs = await db
    .collection("matsuri_rasad_log")
    .find({ timestamp: { $gte: fridayStart.getTime() } })
    .sort({ timestamp: 1 })
    .toArray();

  const recomputed = {};
  for (const d of docs) {
    const entries = parseMessage(d.text);
    for (const e of entries) {
      let key = e.key;
      if (!key && e.namePartial) {
        key = resolvePartialName(e.namePartial, Object.keys(recomputed));
      }
      if (!key) continue;
      recomputed[key] = (recomputed[key] || 0) + e.amount;
    }
  }
  return recomputed;
}

// نقطة الدخول — ترجع true لو تكفلت بالرسالة
async function handleRasadMessage(sock, msg, text, chatId, senderId) {
  if (!isRasadChat(chatId)) return false;

  const t = text.trim();
  const now = Date.now();

  // الأوامر الإدارية أولاً
  const adminCommands = [".الرصد", ".بدء_الرصد", ".انهاء_الرصد", ".رصد_الكل", ".صحة_الرصد", ".الجويل", ".تصفير_الرصد"];
  if (adminCommands.includes(t) && !isRasadAdmin(senderId)) {
    await reply(sock, chatId, msg, "🚫 هذا الأمر خاص، ما عندك صلاحية استخدامه.");
    return true;
  }

  if (t === ".الرصد") {
    await reply(sock, chatId, msg, RD.mainMenuText);
    return true;
  }

  if (t === ".بدء_الرصد") {
    active = true;
    startedAt = now;
    await persist();
    await reply(sock, chatId, msg, "✅ بدأ الرصد. كل رسالة بالقروب من الحين تُحسب.");
    return true;
  }

  if (t === ".انهاء_الرصد") {
    active = false;
    await persist();
    await reply(sock, chatId, msg, "🛑 انتهى الرصد.");
    await reply(sock, chatId, msg, renderList());
    return true;
  }

  if (t === ".رصد_الكل") {
    const recomputed = await recomputeFromLog();
    if (recomputed === null) {
      await reply(sock, chatId, msg, "⚠️ ما فيه اتصال بقاعدة البيانات، ما قدرت أرجع للسجل.");
      return true;
    }
    totals = recomputed;
    await persist();
    await reply(sock, chatId, msg, "🔄 تم إعادة حساب الأسبوع كامل من بداية الجمعة.");
    await reply(sock, chatId, msg, renderList());
    return true;
  }

  if (t === ".تصفير_الرصد") {
    totals = {};
    active = false;
    startedAt = null;
    await persist();
    await clearRawLog();
    await reply(sock, chatId, msg, "✅ تم تصفير الرصد بالكامل. جاهزين لأسبوع جديد.");
    return true;
  }

  if (t === ".صحة_الرصد") {
    const status = active ? "🟢 شغال" : "🔴 متوقف";
    await reply(
      sock,
      chatId,
      msg,
      `${status}\nعدد الأسماء المسجّلة: ${Object.keys(totals).length}`
    );
    return true;
  }

  if (t === ".الجويل") {
    await reply(sock, chatId, msg, renderList());
    return true;
  }

  if (t === ".رصد") {
    const quoted = extractQuoted(msg);
    if (!quoted || !quoted.text) {
      await reply(sock, chatId, msg, "⚠️ لازم ترسل الأمر كـ«رد» (reply) على الرسالة اللي تبي تتأكد منها.");
      return true;
    }

    // نشوف هل هذي الرسالة مسجلة عندنا مسبقاً بالسجل
    const logEntry = quoted.msgId ? await findLogByMsgId(quoted.msgId) : null;

    if (logEntry && logEntry.parsed) {
      await reply(sock, chatId, msg, "✅ تم رصدها سابقاً.");
      return true;
    }

    // إما ما لها سجل (البوت فاته وقتها)، أو موجودة بس فشلت وقتها — نحاول الآن
    const entries = parseMessage(quoted.text);
    const applied = applyEntries(entries);

    if (applied) {
      await persist();
      if (logEntry) {
        await markLogParsed(quoted.msgId);
      } else {
        await logRawMessage(quoted.msgId, senderId, quoted.text, now, true);
      }
      await reply(sock, chatId, msg, "✅ تم الرصد.");
    } else {
      await reply(sock, chatId, msg, "⚠️ ما لقيت مبلغ واضح بهذي الرسالة.");
    }
    return true;
  }

  // مو أمر معروف — رسالة عادية بالقروب
  const msgId = msg.key?.id || null;
  let parsed = false;
  let replied = false;

  if (active) {
    const entries = parseMessage(t);
    parsed = applyEntries(entries);
    if (parsed) {
      await persist();
      await reply(sock, chatId, msg, "✅ تم الرصد.");
    } else {
      await reply(sock, chatId, msg, "❌ حدثت مشكلة أثناء الرصد.");
    }
    replied = true;
  }

  await logRawMessage(msgId, senderId, t, now, parsed);

  return replied; // لو رددنا (الرصد شغال)، نوقف هنا. غير كذا نسمح لباقي البوت يكمل
}

module.exports = { handleRasadMessage, loadFromDb, isRasadChat };