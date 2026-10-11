// 🔍 قياس تأخر المعالج (event loop) بدقة 200ms — للتشخيص فقط، ما يغيّر أي حساب.
// الفكرة: وقت الإجابة يُحسب بساعة البوت (وقت معالجة رسالة اللاعب − وقت
// تأكيد إرسال السؤال). لو المعالج اختنق (Render المجاني 0.1 معالج) تتأخر
// معالجة تأكيد الإرسال ومعالجة الإجابات وتنعالج مع بعض بنفس اللحظة تقريباً،
// فيطلع وقت أقل بكثير من الحقيقي (مثل 0.40 لاسم طويل). هذا الملف يسجّل أي
// تأخر ≥150ms عشان سطر ⏱️ [توقيت] يوضّح هل الرقم الغريب سببه تأخر المعالج.
const INTERVAL_MS = 200;
const MIN_LAG_MS = 150;
const events = []; // { at, lag } — آخر 100 حدث بس (ما يتراكم شي)
let timer = null;

function start() {
  if (timer) return;
  let last = Date.now();
  timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - INTERVAL_MS;
    last = now;
    if (lag >= MIN_LAG_MS) {
      events.push({ at: now, lag });
      if (events.length > 100) events.shift();
    }
  }, INTERVAL_MS);
  timer.unref();
}

// أكبر تأخر للمعالج حصل منذ وقت معيّن (مثلاً منذ بداية الجولة)
function maxLagSince(ts) {
  let m = 0;
  for (const e of events) if (e.at >= ts && e.lag > m) m = e.lag;
  return m;
}

module.exports = { start, maxLagSince };
