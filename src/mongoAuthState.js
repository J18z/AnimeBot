// نسخة من useMultiFileAuthState الأصلية بمكتبة Baileys، بس بدل ما تحفظ
// كل شي بملفات محلية (اللي تنمسح على أغلب السيرفرات المجانية عند إعادة
// التشغيل)، تحفظ كل شي بـ MongoDB — عشان الجلسة تفضل موجودة مهما صار
// للسيرفر (نوم، إعادة تشغيل، انتقال لسيرفر ثاني تماماً)

const { proto, initAuthCreds, BufferJSON } = require("@whiskeysockets/baileys");
const { getDb } = require("./db");

async function useMongoAuthState() {
  const db = getDb();
  if (!db) {
    throw new Error("ما فيه اتصال بقاعدة بيانات، ما نقدر نحفظ جلسة واتساب فيها.");
  }
  const col = db.collection("baileys_auth");

  // ✅ إصلاح تأخير/تعليق البوت وقت اللعب الكثير: قبل هذا التعديل، كل
  // قراءة أو كتابة لمفتاح تشفير (session/sender-key — بيليز يستخدمها
  // بشكل متكرر جداً، تقريباً مع كل رسالة) كانت رحلة كاملة عبر الشبكة
  // لـMongoDB (await منفصل لكل مفتاح). وقت اللعب الكثير (رسايل متزاحمة)
  // هالرحلات تتراكم فوق بعض وتعلّق معالجة الرسائل فعلياً.
  //
  // الحل: كاش كامل بالذاكرة (نفس نمط matsuri/roulette.js و rasad.js) —
  // نحمّل كل جلسة واتساب دفعة وحدة عند البداية، وبعدها كل قراءة فورية
  // من الذاكرة (صفر انتظار شبكة)، وكل كتابة تُسجَّل بالذاكرة فوراً
  // وتُحفظ لقاعدة البيانات بالخلفية (مجمّعة كل 800ms) بدون ما توقف
  // معالجة الرسالة الحالية بانتظارها
  const cache = new Map();
  const dirty = new Set();
  let flushTimer = null;

  const allDocs = await col.find({}).toArray();
  for (const doc of allDocs) {
    if (doc.value === undefined) continue;
    try {
      cache.set(doc._id, JSON.parse(doc.value, BufferJSON.reviver));
    } catch (e) {
      // مفتاح تالف بقاعدة البيانات — نتجاهله بدل ما يوقف تحميل الجلسة كلها
    }
  }

  function scheduleFlush() {
    if (flushTimer) return; // فيه فلاش مجدول أصلاً، ما نكرر المؤقت
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      const keysToFlush = Array.from(dirty);
      dirty.clear();
      await Promise.all(
        keysToFlush.map(async (id) => {
          try {
            if (!cache.has(id)) {
              await col.deleteOne({ _id: id });
            } else {
              const value = JSON.stringify(cache.get(id), BufferJSON.replacer);
              await col.updateOne({ _id: id }, { $set: { value } }, { upsert: true });
            }
          } catch (e) {
            console.error(`⚠️ خطأ حفظ مفتاح جلسة واتساب بالخلفية (${id}):`, e.message);
          }
        })
      );
    }, 800);
  }

  function readData(id) {
    return cache.has(id) ? cache.get(id) : null;
  }

  function writeData(id, data) {
    cache.set(id, data);
    dirty.add(id);
    scheduleFlush();
  }

  function removeData(id) {
    cache.delete(id);
    dirty.add(id);
    scheduleFlush();
  }

  const creds = readData("creds") || initAuthCreds();
  if (!cache.has("creds")) cache.set("creds", creds);

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = readData(`${type}-${id}`);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) writeData(key, value);
              else removeData(key);
            }
          }
        },
      },
    },
    saveCreds: () => writeData("creds", creds),
  };
}

module.exports = { useMongoAuthState };
