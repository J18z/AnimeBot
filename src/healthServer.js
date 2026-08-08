// Render (وبعض الاستضافات المجانية) يحتاج التطبيق يستمع على منفذ HTTP
// عشان يعتبره "خدمة شغالة" — هذا سيرفر بسيط جداً مالوش علاقة بمنطق
// البوت، وظيفته بس يرد "تمام" لأي زيارة (ويصلح كمان كنقطة تنبيه لخدمات
// زي UptimeRobot لتقليل نوبات النوم)
//
// كمان يعرض صفحة /qr تولّد كود QR كصورة حقيقية قابلة للمسح مباشرة من
// الجوال — أسهل بكثير من محاولة تصوير رمز ASCII من صفحة اللوق

const http = require("http");
const QRCode = require("qrcode");

let latestQr = null;

// يُستدعى من index.js كل ما يوصل كود QR جديد من واتساب
function setQr(qr) {
  latestQr = qr;
}

// يُستدعى لما ينجح الربط (عشان صفحة /qr تعرض "متصل" بدل كود قديم)
function clearQr() {
  latestQr = null;
}

function startHealthServer() {
  const port = process.env.PORT || 3000;
  http
    .createServer(async (req, res) => {
      if (req.url === "/qr") {
        if (!latestQr) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h2>ما فيه كود QR بالوقت الحالي — إما البوت متصل أصلاً، أو لسا يجهّز.</h2>");
          return;
        }
        try {
          const dataUrl = await QRCode.toDataURL(latestQr, { width: 400 });
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`
            <html dir="rtl"><body style="text-align:center;font-family:sans-serif;padding:20px">
              <h2>امسح هذا الكود من واتساب</h2>
              <p>الأجهزة المرتبطة > ربط جهاز</p>
              <img src="${dataUrl}" style="max-width:90%;border:8px solid #fff" />
              <p><small>الصفحة تحدّث تلقائياً كل 20 ثانية</small></p>
              <script>setTimeout(() => location.reload(), 20000)</script>
            </body></html>
          `);
        } catch (e) {
          res.writeHead(500);
          res.end("خطأ بتوليد الصورة: " + e.message);
        }
        return;
      }

      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("بوت مسابقات الأنمي شغال ✅");
    })
    .listen(port, () => {
      console.log(`🌐 سيرفر الفحص الصحي شغال على المنفذ ${port}`);
    });
}

module.exports = { startHealthServer, setQr, clearQr };
