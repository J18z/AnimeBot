// 🧹 تنظيف المسجّلين الخاملين (ما عملوا أي أمر ولا شاركوا بمسابقة):
//  - بعد DORMANT_DAYS (افتراضي 7 أيام): ينشالون من .تسجيلات و.توب و.سجل (يتخفّون) مع الاحتفاظ بكل بياناتهم،
//    ويرجعون بـ.تسجيل جوال/خارجي (قائمة .نقاطي ما تنعرض لهم إلا بعد ما يسجلون من جديد)
//  - بعد PURGE_DAYS (افتراضي 15 يوم) بدون أي نشاط ولا إعادة تسجيل: تتصفّر كل سجلاته (توب، سجل، نقاطي، تسجيل)
// المدة تحسب من آخر نشاط. المالك مستثنى. للإيقاف الكامل: INACTIVE_CLEANUP=0
// قابلة للتغيير: INACTIVE_DORMANT_DAYS / INACTIVE_PURGE_DAYS

const registration = require("./registration");
const leaderboard = require("./leaderboard");
const personalHistory = require("./personalHistory");
const standings = require("./standings");

const DAY = 24 * 60 * 60 * 1000;
const DORMANT_DAYS = Number(process.env.INACTIVE_DORMANT_DAYS) || 7;
const PURGE_DAYS = Math.max(Number(process.env.INACTIVE_PURGE_DAYS) || 15, DORMANT_DAYS + 1);

let running = false;

async function runOnce(isExempt) {
  if (running) return { dormant: 0, purged: 0 };
  running = true;
  try {
    const { toDormant, toPurge } = registration.inactivityCandidates(Date.now(), DORMANT_DAYS * DAY, PURGE_DAYS * DAY, isExempt);
    for (const id of toDormant) await registration.markDormant(id);
    for (const id of toPurge) {
      await registration.hardDelete(id);
      leaderboard.removeUser(id);
      personalHistory.removeUser(id);
      standings.removeUser(id);
    }
    if (toDormant.length || toPurge.length) {
      console.log(`🧹 تنظيف الخاملين: ${toDormant.length} انشالوا من التسجيلات/التوب (خمول ${DORMANT_DAYS}+ أيام)، ${toPurge.length} اتصفّرت سجلاتهم (${PURGE_DAYS}+ يوم)`);
    }
    return { dormant: toDormant.length, purged: toPurge.length };
  } catch (e) {
    console.error("⚠️ خطأ تنظيف الخاملين:", e && e.message);
    return { dormant: 0, purged: 0 };
  } finally {
    running = false;
  }
}

function start(isExempt) {
  if (process.env.INACTIVE_CLEANUP === "0") {
    console.log("🧹 تنظيف الخاملين متوقف (INACTIVE_CLEANUP=0).");
    return;
  }
  setTimeout(() => runOnce(isExempt), 60 * 1000).unref(); // بعد دقيقة من التشغيل
  setInterval(() => runOnce(isExempt), 60 * 60 * 1000).unref(); // وكل ساعة
}

module.exports = { start, runOnce, DORMANT_DAYS, PURGE_DAYS };
