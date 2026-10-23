// 🩹 إصلاح تلقائي لحالة "ولا صورة تنرسل" بعد ساعات من التشغيل.
//
// الأعراض: النصوص تنرسل عادي لكن كل الصور تفشل ("تعذّر إرسال الصورة") لين تعيد تشغيل
// البوت. السبب المرجّح: رفع الميديا بمكتبة الواتساب يعتمد على اتصال مخزّن بالسوكت،
// ولو فشل مرة وحدة (تعثر شبكة لحظي) ممكن يبقى مخزّن كفشل ويرفض كل الصور بعده على
// نفس السوكت — وإعادة تشغيل السوكت وحدها تصلحه. فبدل ما ننتظر أحد يلاحظ، لو فشلت
// محاولتين لرفع صورة، نعيد الاتصال تلقائياً (نفس الجلسة، بدون QR) ونحاول مرة أخيرة.
//
// حماية من الحلقات: حد أقصى 3 إعادات اتصال بكل 10 دقايق، وفاصل 30 ثانية بينها.

const WINDOW_MS = 10 * 60 * 1000;
const MAX_IN_WINDOW = 3;
const COOLDOWN_MS = 30 * 1000;
const WAIT_OPEN_MS = 25 * 1000;

let reconnectFn = null;
let openCount = 0;
let waiters = [];
const requests = []; // أوقات طلبات إعادة الاتصال اللي تنفذت
let inFlight = null;
let lastResult = false;

function setReconnect(fn) {
  reconnectFn = fn;
}

// يُنادى كل ما يفتح اتصال واتساب
function notifyOpen() {
  openCount++;
  const w = waiters;
  waiters = [];
  for (const done of w) done(true);
}

function waitForOpen(fromCount) {
  if (openCount !== fromCount) return Promise.resolve(true); // انفتح فعلاً أثناء الانتظار
  return new Promise((resolve) => {
    const done = (v) => {
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== done);
      resolve(false);
    }, WAIT_OPEN_MS);
    waiters.push(done);
  });
}

// يرجع true لو صار اتصال جديد مفتوح (يستاهل نعيد المحاولة)، false لو ما صار
function requestRecovery(reason) {
  if (!reconnectFn) return Promise.resolve(false);
  if (inFlight) return inFlight; // فيه إعادة اتصال جارية، ننتظر نتيجتها
  const now = Date.now();
  while (requests.length && now - requests[0] > WINDOW_MS) requests.shift();
  const last = requests[requests.length - 1];
  if (last && now - last < COOLDOWN_MS) return Promise.resolve(lastResult); // لسه معيدينه قبل شوي
  if (requests.length >= MAX_IN_WINDOW) {
    console.warn("⚠️ فشل رفع الصور تكرر وإعادات الاتصال وصلت الحد (3 كل 10 دقايق) — ما نعيد مرة ثانية الحين.");
    return Promise.resolve(false);
  }
  requests.push(now);
  const from = openCount;
  inFlight = (async () => {
    try {
      console.warn(`♻️ إعادة اتصال لإصلاح رفع الصور (${reason})`);
      await reconnectFn();
      lastResult = await waitForOpen(from);
    } catch (e) {
      console.error("⚠️ فشلت إعادة الاتصال التلقائية:", e && e.message);
      lastResult = false;
    } finally {
      inFlight = null;
    }
    return lastResult;
  })();
  return inFlight;
}

module.exports = { setReconnect, notifyOpen, requestRecovery };
