// قفل تزامن بسيط عبر MongoDB: يمنع أكثر من نسخة وحدة من البوت تتصل
// بواتساب بنفس الوقت بنفس الجلسة المحفوظة. لو صار تعارض (نسخة قديمة لسا
// حية أثناء إعادة نشر، أو خدمة قديمة منسية شغّالة بالخلفية)، واتساب يقفل
// الاتصال بخطأ غامض وصعب التشخيص ("device_removed" conflict). هذا القفل
// يمنع الوصول لهذي الحالة أصلاً بدل ما نكتشفها بعد ما تصير مشكلة فعلية

const { getDb } = require("./db");

const INSTANCE_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const HEARTBEAT_MS = 20 * 1000; // كل 20 ثانية نجدد القفل (نثبت إننا لسا حيين)
const STALE_AFTER_MS = 60 * 1000; // لو مر أكثر من دقيقة بدون تجديد، نعتبر صاحب القفل ميت

let heartbeatTimer = null;

// يحاول ياخذ القفل. يرجع true لو نجح (مافيه نسخة ثانية حية)، أو false لو
// فيه نسخة ثانية شغّالة فعليًا هذي اللحظة
//
// ✅ إصلاح سباق تزامن (race condition): النسخة القديمة كانت تسوي findOne
// ثم updateOne كخطوتين منفصلتين — فيه فاصل زمني بينهم (ولو أجزاء من
// الثانية). لو نسختان استدعتا tryAcquire() بنفس اللحظة تقريباً (يصير
// فعلياً وقت أي إعادة نشر على Render، أو لو اتعمل Deploy وبعدها Deploy
// ثاني قبل ما ينتهي الأول)، الاثنتين ممكن تشوفان "ما فيه قفل" وتاخذانه
// سوا، فيتصلان بواتساب بنفس الوقت بنفس الجلسة ويحصل تلف/فقد للجلسة
// بقاعدة البيانات (كل وحدة عندها كاش منفصل بالذاكرة، وأول واحدة تحفظ
// تمسح مفاتيح الثانية).
//
// الحل: عملية ذرية وحدة بس (findOneAndUpdate) بدل خطوتين. لو فيه وثيقة
// حية فعلاً بنفس اللحظة (نسخة ثانية غير ميتة)، الـ upsert يفشل بخطأ
// تكرار مفتاح (E11000) لأن MongoDB يمنع وثيقتين بنفس الـ_id — وهذا بالضبط
// اللي نستخدمه كدليل إن فيه نسخة حية، بدل الاعتماد على قراءة سابقة ممكن
// تصير قديمة (stale) لحظة التنفيذ الفعلي
async function tryAcquire() {
  const db = getDb();
  if (!db) {
    console.log("⚠️ ما فيه قاعدة بيانات متصلة — تخطينا فحص قفل النسخة الوحيدة.");
    return true;
  }
  const col = db.collection("botLock");
  const now = Date.now();
  const staleThreshold = now - STALE_AFTER_MS;

  try {
    await col.findOneAndUpdate(
      {
        _id: "singleton",
        // نسمح بالاستحواذ لو: الوثيقة مو موجودة أصلاً (upsert)، أو
        // صاحبها إحنا نفسنا (تجديد)، أو صاحبها ميت (heartbeat قديم)
        $or: [{ instanceId: INSTANCE_ID }, { heartbeatAt: { $lt: staleThreshold } }],
      },
      { $set: { instanceId: INSTANCE_ID, heartbeatAt: now } },
      { upsert: true }
    );
  } catch (e) {
    if (e.code === 11000) {
      return false; // فيه نسخة ثانية حية فعلاً ماسكة القفل هذي اللحظة
    }
    throw e;
  }

  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(async () => {
      try {
        // نجدد بس لو القفل لسا لنا (فلتر instanceId) — نتفادى نسرق أو
        // نجدد قفل نسخة ثانية بالغلط لو صار تعارض غريب
        await col.updateOne({ _id: "singleton", instanceId: INSTANCE_ID }, { $set: { heartbeatAt: Date.now() } });
      } catch (e) {
        console.error("⚠️ خطأ تجديد قفل النسخة:", e.message);
      }
    }, HEARTBEAT_MS);
  }

  return true;
}

// يحاول ياخذ القفل بشكل متكرر لين ينجح — يُستخدم عند بدء التشغيل عشان
// نضمن ما نتصل بواتساب إلا لما نتأكد ما فيه نسخة ثانية حية (لو فيه، ننتظر
// لين تنتهي — عادة تصير وقت إعادة نشر، تنتهي القديمة تلقائيًا خلال ثواني)
async function acquireWithRetry() {
  let warned = false;
  while (true) {
    const got = await tryAcquire();
    if (got) {
      console.log(`🔒 قفلنا التشغيل لهذي النسخة (instanceId=${INSTANCE_ID}).`);
      return;
    }
    if (!warned) {
      console.error(
        "🚫 نسخة ثانية من البوت شغّالة حاليًا! ننتظر لين تنتهي (كل 15 ثانية نعيد الفحص) عشان نتفادى تعارض " +
          "\"device_removed\" مع واتساب. لو هذا استمر أكثر من دقيقتين وواثق ما فيه نسخة ثانية فعلية، راجع " +
          "لوحة Render وتأكد ما فيه أكثر من خدمة (أو نسخة قديمة منسية) متصلة بنفس قاعدة البيانات."
      );
      warned = true;
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
}

// يحرر القفل — يُستدعى وقت إغلاق البرنامج (SIGTERM/SIGINT) عشان النسخة
// الجديدة (لو فيه إعادة نشر) تقدر تاخذ القفل فورًا بدون ما تنتظر الدقيقة
async function release() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  const db = getDb();
  if (!db) return;
  try {
    await db.collection("botLock").deleteOne({ _id: "singleton", instanceId: INSTANCE_ID });
  } catch (e) {
    console.error("⚠️ خطأ تحرير قفل النسخة:", e.message);
  }
}

module.exports = { acquireWithRetry, release, INSTANCE_ID };
