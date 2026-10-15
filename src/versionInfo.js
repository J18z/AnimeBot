// يطبع نسخ المكتبات المثبّتة فعلياً على السيرفر. السبب: ما فيه ملف قفل
// (package-lock.json) بالمشروع، فكل نشر جديد على Render يثبّت "أحدث نسخة
// مسموحة" من Baileys و libsignal — يعني الكود ممكن يكون نفسه لكن المكتبة
// تحت تغيّرت بين نشر ونشر. بهالسطر نقدر نقارن بين النشرات بدل التخمين.
const fs = require("fs");
const path = require("path");

function pkgVersion(name) {
  try {
    let dir = path.dirname(require.resolve(name));
    for (let i = 0; i < 6; i++) {
      const f = path.join(dir, "package.json");
      if (fs.existsSync(f)) {
        const j = JSON.parse(fs.readFileSync(f, "utf8"));
        if (j.name === name) return j.version;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch (e) {
    /* ننتقل للمحاولة الثانية */
  }
  try {
    // مكتبات ESM فقط (Baileys 7) ما ينفع معها require.resolve — نقرأ ملفها مباشرة
    const f = path.join(process.cwd(), "node_modules", name, "package.json");
    return JSON.parse(fs.readFileSync(f, "utf8")).version || "؟";
  } catch (e) {
    /* تجاهل */
  }
  return "؟";
}

function logVersions() {
  console.log(
    `📦 النسخ: Node ${process.version} | Baileys ${pkgVersion("@whiskeysockets/baileys")} | libsignal ${pkgVersion("libsignal")}`
  );
}

module.exports = { logVersions, pkgVersion };
