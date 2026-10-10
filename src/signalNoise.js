// 🔇 تخفيف ضجيج مكتبة التشفير (libsignal): كل رسالة ما قدرت تنفك تطبع
// خطأ بـ6 أسطر (stack كامل) عبر console.error، ومع إعادة محاولات كثيرة
// يصير عندنا آلاف الأسطر — على Render الكتابة للّوق متزامنة، فالسيل هذا
// بحد ذاته يبطّئ المعالج ويغرق اللوق ويخفي الأخطاء المهمة الحقيقية.
// نكتم هذي الأسطر بالذات (ما نلمس باقي الأخطاء) ونطبع كل دقيقة سطر ملخّص
// واحد فقط بعدد كل نوع.

const counts = new Map();

const NOISY_ERROR = /^Session error:/;
// رسائل libsignal الإعلامية (كلها تطبع كائن الجلسة كامل أحياناً)
const NOISY_INFO =
  /^(Closing session|Closing open session|Closing stale open session|Opening session|Removing old closed session|Migrating session|Session already (closed|open)|Decrypted message with closed session|Failed to decrypt message with any known session)/;

function kind(first) {
  const s = String(first);
  if (s.includes("Bad MAC")) return "Bad MAC";
  if (s.includes("Over 2000 messages")) return "Over 2000 messages";
  if (s.includes("No matching sessions")) return "No matching sessions";
  return s.replace(/^Session error:/, "").slice(0, 40).trim() || "أخرى";
}

function install() {
  if (global.__signalNoiseInstalled) return;
  global.__signalNoiseInstalled = true;

  const origError = console.error.bind(console);
  const origInfo = console.info.bind(console);
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);

  console.error = (...args) => {
    if (typeof args[0] === "string" && NOISY_ERROR.test(args[0])) {
      const k = kind(args[0]);
      counts.set(k, (counts.get(k) || 0) + 1);
      return;
    }
    origError(...args);
  };
  const quiet = (orig) => (...args) => {
    if (typeof args[0] === "string" && NOISY_INFO.test(args[0])) {
      const k = "جلسات (معلومات)";
      counts.set(k, (counts.get(k) || 0) + 1);
      return;
    }
    orig(...args);
  };
  console.info = quiet(origInfo);
  console.log = quiet(origLog);
  console.warn = quiet(origWarn);

  setInterval(() => {
    if (counts.size === 0) return;
    const parts = [...counts].map(([k, n]) => `${k}: ${n}`).join(" | ");
    counts.clear();
    origError(`🔐 أخطاء تشفير مكتومة آخر دقيقة → ${parts}`);
  }, 60 * 1000).unref();
}

module.exports = { install };
