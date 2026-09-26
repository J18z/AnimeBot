// نسخة من useMultiFileAuthState الأصلية بمكتبة Baileys، بس بدل ما تحفظ
// كل شي بملفات محلية (اللي تنمسح على أغلب السيرفرات المجانية عند إعادة
// التشغيل)، تحفظ كل شي بـ MongoDB — عشان الجلسة تفضل موجودة مهما صار
// للسيرفر (نوم، إعادة تشغيل، انتقال لسيرفر ثاني تماماً)

const { proto, initAuthCreds, BufferJSON } = require("@whiskeysockets/baileys");
const { getDb } = require("./db");
const instanceLock = require("./instanceLock");

// ✅ إصلاح تسرب ذاكرة تراكمي: معالج الإغلاق (SIGTERM/SIGINT) لازم يتسجل
// مرة وحدة بس على مستوى الملف — مو جوا useMongoAuthState() — لأن هذي
// الدالة تتنفذ من جديد كل إعادة اتصال، ولو سجّلنا process.on() جواها كل
// مرة، كل إعادة اتصال تضيف مستمع جديد يفضل للأبد (process كائن واحد ثابت،
// وNode ما يشيل المستمعين القدامى تلقائيًا)، وكل مستمع يحتفظ بنسخة كاملة
// من كاش الجلسة القديمة بالذاكرة بلا داعي. بعد كذا إعادة اتصال (شي وارد
// جدًا على سيرفر مجاني بينقطع كثير)، تتراكم عدة نسخ كاملة من بيانات
// الجلسة بالذاكرة وتخلي البوت يبطّئ تدريجيًا. هذا المتغير يشاور دايمًا
// على آخر flushNow نشط، ونحدّثه بس كل ما صار اتصال جديد بدل ما نسجل
// مستمع جديد من الصفر
let currentFlushNow = null;
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 استلمنا ${signal} — نحفظ جلسة واتساب المعلّقة قبل الإغلاق...`);
  try {
    if (currentFlushNow) await currentFlushNow();
    await instanceLock.release();
    console.log("✅ تم حفظ جلسة واتساب وتحرير القفل، جاهزين للإغلاق.");
  } catch (e) {
    console.error("⚠️ خطأ أثناء حفظ الجلسة وقت الإغلاق:", e.message);
  }
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

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

  // ✅ إصلاح تسرب ذاكرة تراكمي ثاني: قبل هذا التعديل، الكاش كان يحتفظ
  // بكل مفتاح للأبد بدون أي سقف — كل شخص/عضو قروب جديد يتفاعل مع البوت
  // يضيف مفاتيح جديدة، وبعد أسابيع تشغيل متواصل يتراكم الكاش لمئات
  // الميجا (شُوهد فعلياً 350+MB)، وهذا يفسر بالضبط: "الجلسة الجديدة
  // خفيفة وسريعة، وبعدها بفترة يرجع بطيء" — لأن مسح الجلسة يصفّر الكاش
  // من جديد (useMongoAuthState تتنفذ من الصفر)، والتراكم يبدأ يزيد تاني
  // تدريجياً مع الوقت
  //
  // الحل: سقف أقصى لعدد المفاتيح بالذاكرة (LRU — نحتفظ بالأحدث استخداماً
  // بس). لو مفتاح قديم غير نشط اتطرد واحتجناه بعدين، نرجعه من قاعدة
  // البيانات (رحلة شبكة، بس نادرة جداً — بس للمفاتيح الخاملة فعلاً، مو
  // للمحادثات النشطة اللي تفضل بالكاش طول الوقت)
  const MAX_CACHE_SIZE = 8000;

  // ينقل مفتاح لآخر ترتيب الـMap (يعني "استُخدم للتو") — الأقدم استخداماً
  // يفضل بأول الـMap دايمًا، وهو اللي نطرده أول لو الكاش امتلأ
  function touch(id, value) {
    cache.delete(id);
    cache.set(id, value !== undefined ? value : cache.get(id));
  }

  async function evictIfNeeded() {
    // ✅ إصلاح: لو "creds" صادف كانت أقدم مفتاح، الكود القديم كان يوقف
    // كل عملية الطرد نهائياً (break) بدل ما يكمل فحص بقية المفاتيح —
    // يعني لو creds قديمة نسبياً، الكاش يقدر يتجاوز السقف بمئات
    // المفاتيح بصمت والتسريب يرجع يصير زي قبل الإصلاح. الحل: نستثني
    // creds من الطرد بس نكمل نفحص بقية المفاتيح، مع عدّاد أمان يمنع
    // لوب لانهائي لو كل المفاتيح المتبقية كانت creds بس (عملياً مستحيل)
    let guard = cache.size;
    while (cache.size > MAX_CACHE_SIZE && guard-- > 0) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === "creds") {
        // بيانات الاعتماد الأساسية — ما نطردها أبداً، ننقلها لآخر الترتيب
        // ونكمل الفحص من غيرها
        touch("creds");
        continue;
      }
      if (dirty.has(oldestKey)) {
        // فيه تغيير معلّق ما انكتب لقاعدة البيانات بعد — نضمن نحفظه أول
        // قبل ما نطرده من الذاكرة، عشان ما نفقد أي بيانات
        try {
          const value = JSON.stringify(cache.get(oldestKey), BufferJSON.replacer);
          await col.updateOne({ _id: oldestKey }, { $set: { value } }, { upsert: true });
          dirty.delete(oldestKey);
        } catch (e) {
          console.error(`⚠️ خطأ حفظ مفتاح قبل طرده من الكاش (${oldestKey}):`, e.message);
          break; // ما نطرده لو فشل الحفظ — أحسن نحتفظ فيه بالذاكرة مؤقتاً
        }
      }
      cache.delete(oldestKey);
    }
  }

  function scheduleFlush() {
    if (flushTimer) return; // فيه فلاش مجدول أصلاً، ما نكرر المؤقت
    flushTimer = setTimeout(flushNow, 800);
  }

  // يحفظ كل المفاتيح المعلّقة فورًا (بدون انتظار الـ800ms) — نستخدمها
  // وقت إغلاق البرنامج (SIGTERM/SIGINT) عشان نضمن ما نفقد أي مفتاح جلسة
  // معلّق بالذاكرة لو صار إعادة تشغيل مفاجئة للسيرفر بنفس لحظة تحديث
  // مفتاح (هذا بالضبط كان يسبب انفكاك الجلسة المفاجئ بدون سبب واضح)
  async function flushNow() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
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
          console.error(`⚠️ خطأ حفظ مفتاح جلسة واتساب (${id}):`, e.message);
        }
      })
    );
  }

  async function readData(id) {
    if (cache.has(id)) {
      touch(id);
      return cache.get(id);
    }
    // مو موجود بالكاش (اتطرد قبل كذا لقلة استخدامه، أو أصلاً ما تحمّل) —
    // رحلة شبكة نادرة بس لهالحالة تحديداً، ترجعه من قاعدة البيانات
    try {
      const doc = await col.findOne({ _id: id });
      if (!doc || doc.value === undefined) return null;
      const value = JSON.parse(doc.value, BufferJSON.reviver);
      cache.set(id, value);
      await evictIfNeeded();
      return value;
    } catch (e) {
      return null;
    }
  }

  async function writeData(id, data) {
    touch(id, data);
    dirty.add(id);
    scheduleFlush();
    await evictIfNeeded();
  }

  function removeData(id) {
    cache.delete(id);
    dirty.add(id);
    scheduleFlush();
  }

  const allDocs = await col.find({}).toArray();
  let totalBytes = 0;
  for (const doc of allDocs) {
    if (doc.value === undefined) continue;
    totalBytes += doc.value.length;
    try {
      cache.set(doc._id, JSON.parse(doc.value, BufferJSON.reviver));
    } catch (e) {
      // مفتاح تالف بقاعدة البيانات — نتجاهله بدل ما يوقف تحميل الجلسة كلها
    }
  }
  // 🔍 تشخيص: نطبع حجم كاش الجلسة الفعلي عشان نعرف هل هو السبب الرئيسي
  // باستهلاك الذاكرة (350+MB) ولا في مكان ثاني يستحق نركز عليه
  console.log(
    `📦 كاش جلسة واتساب: ${allDocs.length} مفتاح بقاعدة البيانات، ${(totalBytes / 1024 / 1024).toFixed(2)}MB (كنص JSON مضغوط، الحجم الفعلي بالذاكرة بعد التحليل أكبر عادة).`
  );
  // ✅ نطبّق سقف الذاكرة فوراً من بداية التشغيل (مو بس على التراكم
  // المستقبلي) — لو كان محمّل أكثر من السقف، نطرد الفائض دفعة وحدة الآن
  await evictIfNeeded();
  if (allDocs.length > MAX_CACHE_SIZE) {
    console.log(`✂️ طردنا ${allDocs.length - MAX_CACHE_SIZE} مفتاح من الذاكرة فوراً (سقف الكاش ${MAX_CACHE_SIZE}) — باقين بقاعدة البيانات، يرجعوا للكاش لو احتجناهم.`);
  }

  const creds = (await readData("creds")) || initAuthCreds();
  if (!cache.has("creds")) touch("creds", creds);

  // ✅ نحدّث المرجع المشترك بس (مو نسجل مستمع process جديد) — المعالج
  // المسجل مرة وحدة فوق يستخدم هذا المرجع، فدايمًا يحفظ آخر جلسة نشطة
  // فعلاً وقت الإغلاق، بدون ما نراكم مستمعين مع كل إعادة اتصال
  currentFlushNow = flushNow;

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = await readData(`${type}-${id}`);
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
              if (value) await writeData(key, value);
              else removeData(key);
            }
          }
        },
      },
    },
    saveCreds: () => writeData("creds", creds),
  };
}

// ✅ يحفظ فورًا أي تحديث جلسة معلّق بالذاكرة (بدل انتظار مؤقت الـ800ms
// المجدول). نستخدمها قبل أي إعادة اتصال فورية (مثلاً عند 515) عشان نضمن
// إن قاعدة البيانات محدّثة فعلاً قبل ما نبني جلسة جديدة تقرأ منها — وإلا
// نلقى بيانات قديمة غير مسجّلة (creds.registered=false) رغم نجاح المسح
// فعليًا، ونضطر نطلب QR من جديد بدون داعي. لو ما فيه جلسة نشطة أصلاً
// (currentFlushNow لسا null)، ما تسوي شي — آمنة تنادى في أي وقت
async function flushPendingAuth() {
  if (currentFlushNow) await currentFlushNow();
}

module.exports = { useMongoAuthState, flushPendingAuth };
