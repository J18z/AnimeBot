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

function createHealer({ purge, log = console.log, now = () => Date.now() }) {
  const lastHealed = new Map(); // user -> ts
  // عدّاد فشل لكل مستخدم (لملخص دوري بدل سطر مع كل رسالة). محدود بـ300 مستخدم
  const failCounts = new Map();
  let failTotal = 0;

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
      const params = (msg.messageStubParameters || []).join(" ");
      if (!FAIL_RE.test(params)) return false;
      const t = now();
      let healed = 0;
      failTotal++;
      for (const u of usersFor(msg)) {
        if (failCounts.has(u) || failCounts.size < 300) failCounts.set(u, (failCounts.get(u) || 0) + 1);
        const last = lastHealed.get(u);
        if (last !== undefined && t - last < COOLDOWN_MS) continue;
        lastHealed.set(u, t);
        const n = await purge(u);
        if (n > 0) {
          healed++;
          log(`🩹 جلسة تشفير تالفة لـ${u} — حذفنا ${n} مفتاح، تتجدد تلقائياً مع أول رسالة.`);
        } else {
          // ما عندنا أي مفتاح لهذا الشخص = العطل مو بمفاتيحنا (غالباً جلسته هو
          // على جواله مو متزامنة مع جهازنا). ما فيه شي نحذفه ولا نطبع له سطر،
          // ونمدّد التهدئة له 10 دقايق (يظهر بالملخص الدوري)
          lastHealed.set(u, t + 9 * 60 * 1000);
        }
      }
      // تنظيف دوري للـMap عشان ما يكبر
      if (lastHealed.size > 500) for (const [u, ts] of lastHealed) if (t - ts > 10 * 60 * 1000) lastHealed.delete(u);
      return healed > 0;
    } catch (e) {
      log("⚠️ فشل علاج الجلسة التالفة:", e.message);
      return false;
    }
  }

  // ملخص دوري (يُستدعى كل 10 دقايق): كم رسالة فشلت ومن أكثر الأشخاص. يرجع
  // null لو ما فيه شي، ويصفّر العدّادات
  function takeSummary() {
    if (failTotal === 0) return null;
    const top = [...failCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([u, c]) => `${u} (${c})`)
      .join("، ");
    const text = `🔐 رسائل ما انفك تشفيرها آخر 10 دقايق: ${failTotal} من ${failCounts.size} مستخدم — الأكثر: ${top}`;
    failCounts.clear();
    failTotal = 0;
    return text;
  }

  return { maybeHeal, takeSummary };
}

module.exports = { createHealer, userOf, FAIL_RE };
