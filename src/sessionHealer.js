// 🩹 علاج تلقائي لجلسات التشفير التالفة. لما رسالة ما تنفك (Bad MAC / Over
// 2000 / لا توجد جلسة مطابقة)، بيليز يرسلها لنا كرسالة "فاضية" (stub) —
// نحذف مفاتيح هذا الشخص بس، فتتجدد جلسته من أول رسالة بعدها (واتساب
// يعيد إرسالها تلقائياً). بدون هذا، الجلسة التالفة تفضل تستهلك معالجاً
// كبيراً مع كل محاولة، وعلى سيرفر ضعيف (Render المجاني 0.1 معالج) تجمّد
// البوت وتفصله.

const FAIL_RE = /Bad MAC|Over 2000 messages|No matching sessions|No session record|Invalid PreKey|No session found/i;
const CIPHERTEXT_STUB = 2; // proto.WebMessageInfo.StubType.CIPHERTEXT
const COOLDOWN_MS = 60 * 1000;

function userOf(jid) {
  if (!jid || typeof jid !== "string") return null;
  const u = jid.split("@")[0].split(":")[0].split("_")[0].replace(/\D/g, "");
  return u || null;
}

// مصدر الرسالة الفاشلة — عشان نعرف من اللوق بالضبط من وين جاي الحمل
// (ستوري؟ قروبات؟ خاص؟) بدل التخمين، ونقرر هل نفعّل IGNORE_STATUS
function sourceOf(msg) {
  const j = (msg && msg.key && msg.key.remoteJid) || "";
  if (j === "status@broadcast") return "ستوري";
  if (j.endsWith("@g.us")) return "قروب";
  if (j.endsWith("@newsletter")) return "قناة";
  if (j.endsWith("@broadcast")) return "بث";
  return "خاص";
}

function createHealer({ purge, log = console.log, now = () => Date.now(), reportEveryMs = 60 * 1000 }) {
  const lastHealed = new Map(); // user -> ts
  // إحصاء الدقيقة الأخيرة (يتصفّر مع كل تقرير، فما يتراكم شي)
  let stats = { total: 0, bySource: new Map(), users: new Set(), healed: 0 };

  function report() {
    if (stats.total === 0) return;
    const parts = [...stats.bySource].map(([k, n]) => `${k}=${n}`).join(" | ");
    log(
      `🩹 فشل فك تشفير آخر دقيقة: ${stats.total} (${parts}) | أشخاص مختلفين=${stats.users.size} | جلسات انعالجت=${stats.healed}`
    );
    stats = { total: 0, bySource: new Map(), users: new Set(), healed: 0 };
  }
  if (reportEveryMs > 0) setInterval(report, reportEveryMs).unref();

  function usersFor(msg) {
    const key = msg.key || {};
    const out = new Set();
    for (const j of [key.participant, key.participantAlt, key.remoteJid, key.remoteJidAlt]) {
      // remoteJid لقروب ما يهمنا (المرسل الفعلي هو participant)
      if (typeof j === "string" && j.endsWith("@g.us")) continue;
      const u = userOf(j);
      if (u) out.add(u);
    }
    return [...out];
  }

  async function maybeHeal(msg) {
    try {
      if (!msg || msg.messageStubType !== CIPHERTEXT_STUB || (msg.key && msg.key.fromMe)) return false;
      stats.total++;
      const src = sourceOf(msg);
      stats.bySource.set(src, (stats.bySource.get(src) || 0) + 1);
      for (const u of usersFor(msg)) stats.users.add(u);
      const params = (msg.messageStubParameters || []).join(" ");
      if (!FAIL_RE.test(params)) return false;
      const t = now();
      let healed = 0;
      for (const u of usersFor(msg)) {
        const last = lastHealed.get(u);
        if (last !== undefined && t - last < COOLDOWN_MS) continue;
        lastHealed.set(u, t);
        const n = await purge(u);
        healed++;
        stats.healed++;
        log(`🩹 جلسة تشفير تالفة لـ${u} — حذفنا ${n} مفتاح، تتجدد تلقائياً مع أول رسالة.`);
      }
      // تنظيف دوري للـMap عشان ما يكبر
      if (lastHealed.size > 500) for (const [u, ts] of lastHealed) if (t - ts > 10 * 60 * 1000) lastHealed.delete(u);
      return healed > 0;
    } catch (e) {
      log("⚠️ فشل علاج الجلسة التالفة:", e.message);
      return false;
    }
  }

  return { maybeHeal, report };
}

module.exports = { createHealer, userOf, FAIL_RE, sourceOf };
