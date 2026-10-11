// 🔇 تخفيف ضجيج مكتبة التشفير (libsignal): كل رسالة ما قدرت تنفك تطبع
// خطأ بـ6 أسطر (stack كامل) عبر console.error، ومع إعادة محاولات كثيرة
// يصير عندنا آلاف الأسطر — على Render الكتابة للّوق متزامنة، فالسيل هذا
// بحد ذاته يبطّئ المعالج ويغرق اللوق ويخفي الأخطاء المهمة الحقيقية.
// نكتم هذي الأسطر بالذات (ما نلمس باقي الأخطاء) ونطبع كل دقيقة سطر ملخّص
// واحد فقط بعدد كل نوع.

const counts = new Map();

const NOISY_ERROR = /^(Session error:|Failed to decrypt message with any known session)/;
// رسائل libsignal الإعلامية (كلها تطبع كائن الجلسة كامل أحياناً)
const NOISY_INFO =
  /^(Closing session|Closing open session|Closing stale open session|Opening session|Removing old closed session|Migrating session|Session already (closed|open)|Decrypted message with closed session|Failed to decrypt message with any known session)/;

function kind(first) {
  const s = String(first);
  if (s.startsWith("Failed to decrypt")) return "فشل فك تشفير";
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

  // 🧱 طبقة ثانية على مستوى الكتابة الفعلية للـstdout/stderr: لو أي سطر
  // من أسطر libsignal وصل للّوق بطريقة تتجاوز console (مرجع محفوظ قبل
  // الاستبدال، أو مكتبة تكتب مباشرة)، نمسكه هنا. نفحص بداية الكتلة بس
  // (أسطر libsignal كلها تبدأ بنص ثابت)، وباقي لوق البوت يمر كما هو
  const STREAM_NOISE =
    /^\s*(Session error:|Failed to decrypt message with any known session|Closing session|Closing open session|Closing stale open session|Removing old closed session|Migrating session|Session already (closed|open)|Decrypted message with closed session)/;
  const wrapStream = (stream) => {
    const orig = stream.write.bind(stream);
    stream.write = (chunk, encoding, cb) => {
      let head = "";
      if (typeof chunk === "string") head = chunk.length > 200 ? chunk.slice(0, 200) : chunk;
      else if (chunk && chunk.length) head = Buffer.from(chunk.slice(0, 200)).toString("utf8");
      if (head && STREAM_NOISE.test(head)) {
        const k = kind(head.trim());
        counts.set(k, (counts.get(k) || 0) + 1);
        const done = typeof encoding === "function" ? encoding : cb;
        if (typeof done === "function") done();
        return true;
      }
      return orig(chunk, encoding, cb);
    };
  };
  wrapStream(process.stdout);
  wrapStream(process.stderr);

  setInterval(() => {
    if (counts.size === 0) return;
    const parts = [...counts].map(([k, n]) => `${k}: ${n}`).join(" | ");
    counts.clear();
    origError(`🔐 أخطاء تشفير مكتومة آخر دقيقة → ${parts}`);
  }, 60 * 1000).unref();
}

module.exports = { install };
