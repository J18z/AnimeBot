// Render (وبعض الاستضافات المجانية) يحتاج التطبيق يستمع على منفذ HTTP
// عشان يعتبره "خدمة شغالة" — هذا سيرفر بسيط جداً مالوش علاقة بمنطق
// البوت، وظيفته بس يرد "تمام" لأي زيارة (ويصلح كمان كنقطة تنبيه لخدمات
// زي UptimeRobot لتقليل نوبات النوم)

const http = require("http");

function startHealthServer() {
  const port = process.env.PORT || 3000;
  http
    .createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("بوت مسابقات الأنمي شغال ✅");
    })
    .listen(port, () => {
      console.log(`🌐 سيرفر الفحص الصحي شغال على المنفذ ${port}`);
    });
}

module.exports = { startHealthServer };
