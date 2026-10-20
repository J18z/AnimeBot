// 🧹 صيانة تلقائية خفيفة للبوت — تعالج 3 أشياء بدون تدخلك وبدون QR:
//  1) امتلاء الذاكرة (RAM): تنظيف الذاكرة عند الحاجة، وإعادة اتصال "خفيفة"
//     (بنفس الجلسة الموجودة بالذاكرة) تفرّغ كل ما تراكم داخل مكتبة واتساب
//  2) تجمّد التشفير: لو كل الرسائل الواردة صارت تفشل بفك التشفير لدقيقتين
//     وما وصلت ولا رسالة سليمة (حالة "وقف البوت ساعات")، نصفّر تشفير
//     المحادثات ونعيد الاتصال تلقائياً
//  3) تعفّن مع الوقت: إعادة اتصال خفيفة دورية (كل 6 ساعات، وبوقت ما فيه
//     مسابقة شغالة)، وإعادة اتصال لو سكتت الرسائل كلياً أثناء مسابقة نشطة
//
// ما نطبع شي باللوق إلا لما نسوي إجراء فعلي (سطر واحد).

const v8 = require("v8");
const vm = require("vm");

const TICK_MS = 30 * 1000;
const MB = 1024 * 1024;

function getGc() {
  if (typeof global.gc === "function") return global.gc;
  try {
    // تفعيل gc() بدون ما تحتاج تضيف أي خيار تشغيل
    v8.setFlagsFromString("--expose-gc");
    return vm.runInNewContext("gc");
  } catch (e) {
    return null;
  }
}

function createMaintenance({
  reconnect, // async (reason) => void — إعادة اتصال خفيفة
  healEncryption, // async () => void — تصفير تشفير المحادثات
  hasActiveContest = () => false,
  log = console.log,
  now = Date.now,
  memory = () => process.memoryUsage(),
  gc = getGc,
  env = process.env,
}) {
  const LIMIT_MB = Number(env.RAM_LIMIT_MB) || 512;
  const SOFT_MB = Number(env.RAM_SOFT_MB) || Math.floor(LIMIT_MB * 0.75);
  const PERIODIC_HOURS = env.SOFT_RECONNECT_HOURS !== undefined ? Number(env.SOFT_RECONNECT_HOURS) : 6;

  let open = false;
  let lastConnectAt = now();
  let lastInboundAt = now(); // آخر رسالة واردة فعلية (ما يتأثر بإعادة الاتصال)
  let lastSilenceFixAt = 0;
  let lastReconnectAt = 0;
  let lastHealAt = 0;
  let lastGcAt = 0;
  let tickNo = 0;
  let busy = false;
  let cur = { ok: 0, fail: 0 };
  const buckets = []; // آخر 4 فترات (دقيقتين)

  function noteConnected() {
    open = true;
    lastConnectAt = now();
  }
  function noteDisconnected() {
    open = false;
  }
  function noteInbound(msg) {
    lastInboundAt = now();
    if (msg.messageStubType === 2) cur.fail++;
    else if (msg.message && !(msg.key && msg.key.fromMe)) cur.ok++;
  }

  async function doReconnect(reason, cooldownMs) {
    const t = now();
    if (t - lastReconnectAt < cooldownMs) return false;
    lastReconnectAt = t;
    log(`♻️ إعادة اتصال خفيفة (${reason}) — بنفس الجلسة، بدون QR.`);
    await reconnect(reason);
    return true;
  }

  async function step() {
    tickNo++;
    const t = now();
    buckets.push(cur);
    if (buckets.length > 4) buckets.shift();
    cur = { ok: 0, fail: 0 };
    if (!open) return;

    // 2) فشل تشفير شامل: ≥30 فشل ولا رسالة سليمة خلال دقيقتين
    const ok = buckets.reduce((a, b) => a + b.ok, 0);
    const fail = buckets.reduce((a, b) => a + b.fail, 0);
    if (fail >= 30 && ok === 0 && t - lastHealAt > 30 * 60 * 1000) {
      lastHealAt = t;
      log(`🩹 كل الرسائل الواردة تفشل بفك التشفير (${fail} فشل، 0 سليمة) — نصفّر تشفير المحادثات ونعيد الاتصال.`);
      try {
        await healEncryption();
      } catch (e) {
        log("⚠️ تعذّر تصفير التشفير:", e.message);
      }
      await doReconnect("فشل تشفير شامل", 0);
      buckets.length = 0;
      return;
    }

    // 1) الذاكرة — كل دقيقتين
    if (tickNo % 4 === 0) {
      let m = memory();
      const rssMb = m.rss / MB;
      const extMb = (m.external + m.arrayBuffers) / MB;
      const g = gc();
      // ✅ التنظيف القسري (gc) يوقف المعالج لحظات (جزء من الثانية) — أثناء مسابقة نشطة
      // هذا يظهر كتذبذب بالتوقيت. نأجّله لين تخلص المسابقة، إلا لو الذاكرة تعدّت الحد
      if (g && (rssMb > SOFT_MB * 0.7 || extMb > 60) && t - lastGcAt > 60 * 1000 && (!hasActiveContest() || rssMb > SOFT_MB)) {
        g();
        lastGcAt = t;
        m = memory();
      }
      // ✅ أثناء مسابقة نشطة ما نقطع الاتصال لمجرد تعدّي الحد "الناعم" — إعادة الاتصال
      // تضيّع رسائل لثواني، ولو الذاكرة ثابتة فوق الحد ما تنزّلها أصلاً. نأجّلها
      // لين تخلص المسابقة، إلا لو الذاكرة صارت قريبة جداً من حد السيرفر (90%)
      if (m.rss / MB > SOFT_MB && (!hasActiveContest() || m.rss / MB > LIMIT_MB * 0.9)) {
        const done = await doReconnect(`الذاكرة عالية RSS=${Math.round(m.rss / MB)}MB > ${SOFT_MB}MB`, 20 * 60 * 1000);
        if (done) return;
      }
    }

    // 3) دوري: كل N ساعات، بوقت ما فيه مسابقة (أو بعد ساعة تأخير لو المسابقات ما وقفت)
    if (PERIODIC_HOURS > 0) {
      const age = t - lastConnectAt;
      const due = PERIODIC_HOURS * 3600 * 1000;
      if (age > due && (!hasActiveContest() || age > due + 3600 * 1000)) {
        const done = await doReconnect(`صيانة دورية كل ${PERIODIC_HOURS} ساعات`, 15 * 60 * 1000);
        if (done) return;
      }
    }

    // سكوت تام 10 دقايق أثناء مسابقة نشطة = اتصال معلّق غالباً. مرة وحدة
    // بس لكل فترة سكوت (لازم توصل رسالة حقيقية بعد الإصلاح عشان تتكرر) —
    // عشان مسابقة مفتوحة بدون لاعبين طول الليل ما تسبب إعادة اتصال كل شوي
    if (hasActiveContest() && t - lastInboundAt > 10 * 60 * 1000 && lastInboundAt > lastSilenceFixAt) {
      const done = await doReconnect("لا رسائل واردة 10 دقايق أثناء مسابقة نشطة", 15 * 60 * 1000);
      if (done) lastSilenceFixAt = t;
    }
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      await step();
    } catch (e) {
      log("⚠️ خطأ بالصيانة التلقائية:", e.message);
    } finally {
      busy = false;
    }
  }

  function start() {
    setInterval(tick, TICK_MS).unref();
  }

  // للأمر .ذاكرة
  function info() {
    return { LIMIT_MB, SOFT_MB, PERIODIC_HOURS, lastReconnectAt, lastConnectAt, open };
  }
  function forceGc() {
    const g = gc();
    if (!g) return false;
    g();
    return true;
  }

  return { start, tick, noteConnected, noteDisconnected, noteInbound, info, forceGc, _state: () => ({ open, SOFT_MB }) };
}

module.exports = { createMaintenance };
