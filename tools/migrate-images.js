// ☁️ نقل صور data/images إلى Cloudinary (مرة وحدة، على جهازك أو أي مكان فيه مجلد الصور).
//
// التشغيل (من مجلد المشروع):
//   CLOUDINARY_CLOUD_NAME=xxx CLOUDINARY_API_KEY=xxx CLOUDINARY_API_SECRET=xxx MONGO_URI="mongodb+srv://..." node tools/migrate-images.js
//   (ويندوز PowerShell:  $env:CLOUDINARY_CLOUD_NAME="xxx"; ... ; node tools/migrate-images.js)
//   MONGO_URI اختياري لو mongoUri موجود بـdata/config.json
//
// خيارات:
//   --dry     تجربة بدون رفع ولا حفظ (تعرض وش بيصير)
//   --prune   بعد النجاح يحذف الصور المنقولة من data/images.json (ينسخ نسخة احتياطية images.json.bak أول)
//             وما يحذف ملفات الصور نفسها من المجلد
//
// آمن للتكرار: الصورة اللي انتقلت قبل (حسب id الأصلي) تنتخطى.

const fs = require("fs");
const path = require("path");
const db = require("../src/db");
const cloud = require("../src/cloudImages");

const DRY = process.argv.includes("--dry");
const PRUNE = process.argv.includes("--prune");
const DATA = path.join(__dirname, "..", "data");

const slug = cloud.slug;

async function main() {
  if (!cloud.enabled()) throw new Error("ناقصة متغيرات CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET");
  const cfgFile = JSON.parse(fs.readFileSync(path.join(DATA, "config.json"), "utf8"));
  const uri = process.env.MONGO_URI || cfgFile.mongoUri;
  const dbh = DRY ? null : await db.connect(uri);
  if (!DRY && !dbh) throw new Error("ما قدرت أتصل بـMongoDB — تأكد من MONGO_URI");

  const imagesPath = path.join(DATA, "images.json");
  const items = JSON.parse(fs.readFileSync(imagesPath, "utf8"));
  const col = dbh ? dbh.collection("cloudImages") : null;
  const done = new Set(col ? (await col.find({ source: { $exists: true } }).toArray()).map((d) => d.source) : []);
  const taken = new Set(col ? (await col.find({}).project({ _id: 1 }).toArray()).map((d) => d._id) : []);

  let ok = 0, skipped = 0, missing = 0, failed = 0;
  const migratedIds = new Set();
  let sharp = null;
  try { sharp = require("sharp"); } catch (e) { /* اختياري */ }

  for (const it of items) {
    if (done.has(it.id)) { skipped++; migratedIds.add(it.id); continue; }
    const filePath = path.join(DATA, "images", it.file || "");
    if (!it.file || !fs.existsSync(filePath)) { console.log(`⚠️ ملف مفقود: ${it.file} (${it.id})`); missing++; continue; }
    let base = slug(it.file) || slug(it.id) || "img";
    let n = 1;
    while (taken.has(`cl:${base}_${n}`)) n++;
    const id = `cl:${base}_${n}`;
    const publicId = `quiz/${base}_${n}`;
    if (DRY) { console.log(`(تجربة) ${it.file} → ${publicId} | ${JSON.stringify(it.answers)}`); taken.add(id); ok++; continue; }
    try {
      let buf = fs.readFileSync(filePath);
      if (sharp) {
        try { buf = await sharp(buf).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer(); } catch (e) { /* نرفع الأصلية */ }
      }
      await cloud.uploadBuffer(buf, publicId);
      const doc = { _id: id, charKey: base, publicId, source: it.id, question: it.question || "من هذه الشخصية؟", answers: it.answers, points: it.points || 1, createdAt: Date.now() };
      if (it.type) doc.type = it.type;
      if (it.required) doc.required = it.required;
      if (it.alt || it.alts) doc.alt = it.alt || it.alts;
      await col.insertOne(doc);
      taken.add(id);
      migratedIds.add(it.id);
      ok++;
      console.log(`✅ ${it.file} → ${publicId}`);
    } catch (e) {
      failed++;
      console.error(`❌ ${it.file}: ${e.message}`);
    }
  }
  console.log(`\nانتهى: ${ok} انرفعت، ${skipped} منتقلة من قبل، ${missing} ملفها مفقود، ${failed} فشلت.`);
  if (PRUNE && !DRY && migratedIds.size) {
    fs.copyFileSync(imagesPath, imagesPath + ".bak");
    const rest = items.filter((it) => !migratedIds.has(it.id));
    fs.writeFileSync(imagesPath, JSON.stringify(rest, null, 2) + "\n");
    console.log(`🧹 انحذف ${items.length - rest.length} عنصر من images.json (النسخة الاحتياطية: images.json.bak).`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
