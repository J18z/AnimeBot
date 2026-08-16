// قسم الرصد — يحسب فلوس الأعضاء داخل قروب مخصص (rasadChatId)
// الأوامر الإدارية (بدء/انهاء/رصد_الكل/تصفير) خاصة بصاحب البوت + صاحب
// وزارة ماتسوري بس (نفس صلاحية قسم الروليت). أمر .رصد متاح للجميع.
//
// طريقة العمل:
//  - أثناء الرصد الفعّال، أي رسالة توصل بقروب الرصد تتفحص فوراً (بدون أي
//    فحص دوري/polling — بس رد فعل على حدث "رسالة جديدة")
//  - كل رسالة (بغض النظر هل الرصد شغال أو لا) تُسجَّل بسجل خام مؤقت
//    بقاعدة البيانات، عشان أمر ".رصد_الكل" يقدر يعيد حساب الأسبوع كامل
//    حتى لو نسينا نبدأ الرصد أو صار انقطاع بمنتصف الأسبوع
//  - النتيجة النهائية (قائمة الجويل) تُحفظ بالخلفية بعد كل تحديث

const { getDb } = require("../src/db");
const store = require("../src/dataStore");
const RD = require("./rasadData");
const { parseMessage, resolvePartialName } = require("./rasadParser");

// حالة بالذاكرة
let totals = {}; // { key: amountK }
let active = false;
let startedAt = null;
// آخر رسالة معروفة من كل شخص بقروب الرصد (لأمر ".رصد")
// { senderId: { text, timestamp, parsed: boolean } }
let lastFromSender = {};

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

// سجل خام لكل رسالة تدخل قروب الرصد (لأجل .رصد_الكل والاسترجاع)
async function logRawMessage(senderId, text, timestamp, parsed) {
  const db = getDb();
  if (!db) return;
  try {
    await db.collection("matsuri_rasad_log").insertOne({ senderId, text, timestamp, parsed });
  } catch (err) {
    console.error("خطأ تسجيل رسالة الرصد:", err.message);
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
    lastFromSender = {};
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
    const prev = lastFromSender[senderId];
    if (!prev) {
      await reply(sock, chatId, msg, "⚠️ ما وصلتني أي رسالة منك قبل هذي — تأكد إذا كان البوت متصل وقتها.");
      return true;
    }
    if (prev.parsed) {
      await reply(sock, chatId, msg, "✅ رسالتك السابقة انرصدت مسبقاً، تمام 👍");
      return true;
    }
    // نحاول نرصدها الحين (احتياط لو صار خلل وقتها)
    const entries = parseMessage(prev.text);
    const applied = applyEntries(entries);
    if (applied) {
      prev.parsed = true;
      await persist();
      await reply(sock, chatId, msg, "✅ تم رصدها الحين (كانت فاتت متأخر).");
    } else {
      await reply(sock, chatId, msg, "⚠️ ما لقيت مبلغ واضح برسالتك السابقة، تأكد من الصيغة.");
    }
    return true;
  }

  // مو أمر معروف — نعتبرها رسالة عادية بالقروب، نسجّلها ونحاول نرصدها لو الرصد شغال
  let parsed = false;
  if (active) {
    const entries = parseMessage(t);
    parsed = applyEntries(entries);
    if (parsed) await persist();
  }
  lastFromSender[senderId] = { text: t, timestamp: now, parsed };
  await logRawMessage(senderId, t, now, parsed);

  return false; // نسمح لباقي البوت يكمل شغله على نفس الرسالة لو يحتاج
}

module.exports = { handleRasadMessage, loadFromDb, isRasadChat };