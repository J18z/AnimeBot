// نص تقرير الذاكرة للأمر .ذاكرة (دالة نقية، سهلة الاختبار)
const MB = 1024 * 1024;
const mb = (n) => Math.round(n / MB);

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}س ${m}د` : `${m}د`;
}

function buildMemoryReport({ mem, stats, info, activeContests, uptimeSec, now = Date.now() }) {
  const lines = ["📊 حالة الذاكرة"];
  const pct = Math.round((mem.rss / MB / info.LIMIT_MB) * 100);
  lines.push(`• الكلية (RSS): ${mb(mem.rss)}MB من ${info.LIMIT_MB}MB (${pct}%)`);
  lines.push(`• ذاكرة الكود (Heap): ${mb(mem.heapUsed)}MB / ${mb(mem.heapTotal)}MB`);
  lines.push(`• خارجية: ${mb(mem.external)}MB | بافرات: ${mb(mem.arrayBuffers)}MB`);
  const other = mb(mem.rss - mem.heapTotal - mem.external);
  lines.push(`• باقي (مكتبات/نظام): ~${Math.max(other, 0)}MB`);
  if (stats) {
    lines.push(`• مفاتيح التشفير: محادثات ${stats.chatKeys} (السقف ${stats.maxChat}) | أخرى ${stats.otherKeys}`);
  } else {
    lines.push("• مفاتيح التشفير: غير متاحة");
  }
  lines.push(`• مسابقات نشطة: ${activeContests} | مدة التشغيل: ${fmtDuration(uptimeSec)}`);
  const last = info.lastReconnectAt ? `قبل ${fmtDuration(Math.round((now - info.lastReconnectAt) / 1000))}` : "ما صار";
  lines.push(
    `• الصيانة: تنظيف عند ${info.SOFT_MB}MB، دورية كل ${info.PERIODIC_HOURS > 0 ? info.PERIODIC_HOURS + "س" : "— (معطّلة)"} | آخر إعادة اتصال خفيفة: ${last}`
  );
  return lines.join("\n");
}

module.exports = { buildMemoryReport };
