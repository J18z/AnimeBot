// 🛡️ حارس توقيت: يكشف "تجمّد" البوت (حلقة الأحداث توقفت) ويصحّح حساب وقت الإجابة.
//
// المشكلة: وقت الإجابة = (لحظة وصول الرد) − (لحظة تأكد إرسال السؤال)، والاثنين
// يتسجلون بنفس البرنامج. لو البرنامج تجمّد ثانية ونص (GC، ضغط معالج، مزامنة بعد
// ربط) مباشرة بعد إرسال السؤال، اللاعب شاف السؤال وجاوب خلال التجمّد — لكن لما
// البرنامج يصحى يسجل بداية السؤال ووصول الرد بنفس اللحظة تقريباً، فيطلع 0.00.
// السيرفر ما "أخّر"، البرنامج نفسه كان واقف فالأختام الزمنية انهارت على بعض.
//
// الحل: مؤقت خفيف (كل 20ms) يلاحظ أي فجوة كبيرة، وحساب الوقت يستخدمها.
// ما يعدّل شي إلا لو صار تجمّد فعلي (300ms أو أكثر)؛ بالوضع الطبيعي ما يتغير أي رقم.

const TICK_MS = 20;
const MIN_STALL_MS = 300;
const KEEP_MS = 60 * 1000;
const ASSOC_MS = 25; // الختم يعتبر "بعد التجمّد مباشرة" لو جاء خلال هذي المدة منه

let lastTick = 0;
let timer = null;
const stalls = []; // [{ from, to }]

function start() {
  if (timer) return;
  lastTick = Date.now();
  timer = setInterval(() => {
    const now = Date.now();
    if (now - lastTick > TICK_MS + MIN_STALL_MS) {
      stalls.push({ from: lastTick, to: now });
      const cutoff = now - KEEP_MS;
      while (stalls.length && (stalls[0].to < cutoff || stalls.length > 50)) stalls.shift();
    }
    lastTick = now;
  }, TICK_MS);
  if (timer.unref) timer.unref();
}

// التجمّد اللي انتهى عند اللحظة now (أو null لو ما صار). يشتغل حتى لو مؤقتنا
// نفسه لسه ما اشتغل بعد التجمّد (ترتيب مراحل حلقة الأحداث يخلي الختم ممكن يجي قبله)
function stallEndingAt(now) {
  if (!timer) return null;
  if (now - lastTick > TICK_MS + MIN_STALL_MS) return { from: lastTick, to: now };
  const last = stalls[stalls.length - 1];
  if (last && now >= last.to && now - last.to <= ASSOC_MS) return last;
  return null;
}

// يحسب الوقت الخام (ms) بين ختم بداية السؤال وختم وصول الرد مع تصحيح التجمّد.
// يرجع { raw, stallMs } — stallMs > 0 يعني القيمة تقديرية (غير موثوقة للتسجيل)
function adjustedElapsed(startStamp, startStall, arrStamp, arrStall) {
  let s = startStamp;
  let a = arrStamp;
  let stallMs = 0;
  if (startStall && arrStall && startStall.from === arrStall.from) {
    // نفس التجمّد غطّى الاثنين: الرد وصل خلاله، فالسؤال انكتب قبل بدايته حتماً
    s = startStall.from;
    a = (arrStall.from + arrStall.to) / 2;
    stallMs = arrStall.to - arrStall.from;
  } else {
    if (startStall) {
      s = (startStall.from + startStall.to) / 2;
      stallMs = Math.max(stallMs, startStall.to - startStall.from);
    }
    if (arrStall) {
      a = (arrStall.from + arrStall.to) / 2;
      stallMs = Math.max(stallMs, arrStall.to - arrStall.from);
    }
  }
  return { raw: a - s, stallMs };
}

module.exports = { start, stallEndingAt, adjustedElapsed, MIN_STALL_MS };
