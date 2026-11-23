// 💾 نسخ احتياطي لصور Cloudinary كملفات tar (بدون أي مكتبة) واسترجاعها لحساب جديد.
// كل جزء = مانيفست (manifest.json: بيانات الصور) + ملفات الصور. الأجزاء مستقلة: تسترجع أي جزء لوحده.
const cloud = require("./cloudImages");

const PART_BYTES = 15 * 1024 * 1024; // حجم الجزء التقريبي: صغير عشان ذاكرة الاستضافة المجانية (الذروة ≈ 3-4 أضعافه وقت الإرسال)

function tarHeader(name, size) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136);
  h.write("        ", 148); // checksum placeholder
  h.write("0", 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}
function tarPack(files) {
  const out = [];
  for (const f of files) {
    out.push(tarHeader(f.name, f.data.length), f.data);
    const pad = (512 - (f.data.length % 512)) % 512;
    if (pad) out.push(Buffer.alloc(pad));
  }
  out.push(Buffer.alloc(1024));
  return Buffer.concat(out);
}
function tarUnpack(buf) {
  const files = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.toString("utf8", 0, 100).replace(/\0.*$/s, "");
    const size = parseInt(h.toString("ascii", 124, 135).replace(/\0.*$/s, "").trim() || "0", 8);
    off += 512;
    if (!Number.isFinite(size) || off + size > buf.length) throw new Error("ملف tar تالف أو ناقص");
    files.push({ name, data: Buffer.from(buf.subarray(off, off + size)) });
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

// يبني الأجزاء ويسلّمها واحد واحد لـ onPart(buffer, fileName, i, total). يرجع { total, ok, missing:[publicId] }
async function backupAll(onPart, onProgress) {
  const docs = cloud.getDocs();
  if (!docs.length) return { total: 0, ok: 0, missing: [] };
  const missing = [];
  let ok = 0;
  let part = [];
  let partDocs = [];
  let bytes = 0;
  // نجمع كل جزء ونرسله فوراً (ما نبقي كل الأجزاء بالذاكرة)
  const sendPart = async (files, pdocs, idx) => {
    const manifest = Buffer.from(JSON.stringify({ version: 1, createdAt: Date.now(), docs: pdocs, files: files.map((f) => ({ name: f.name, publicId: f.publicId })) }, null, 1));
    const tar = tarPack([{ name: "manifest.json", data: manifest }, ...files.map((f) => ({ name: f.name, data: f.data }))]);
    await onPart(tar, `quiz-images-part${String(idx).padStart(2, "0")}.tar`, idx);
  };
  let idx = 0;
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    try {
      const data = await cloud.fetchOriginal(d.publicId);
      part.push({ name: `img${String(i + 1).padStart(5, "0")}.bin`, publicId: d.publicId, data });
      partDocs.push(d);
      bytes += data.length;
      ok++;
    } catch (e) {
      missing.push(d.publicId);
      partDocs.push(d); // البيانات نحفظها حتى لو الصورة ضاعت
    }
    if (onProgress && (i + 1) % 25 === 0) onProgress(i + 1, docs.length);
    if (bytes >= PART_BYTES) {
      await sendPart(part, partDocs, ++idx);
      part = [];
      partDocs = [];
      bytes = 0;
    }
  }
  if (part.length || partDocs.length) await sendPart(part, partDocs, ++idx);
  return { total: docs.length, ok, missing, parts: idx };
}

// يسترجع جزء: يرفع الصور لحساب Cloudinary الحالي (متغيرات البيئة) بنفس الـpublic_id ويرجّع الوثائق
async function restorePart(tarBuf, onProgress) {
  const files = tarUnpack(tarBuf);
  const mf = files.find((f) => f.name === "manifest.json");
  if (!mf) throw new Error("ما لقيت manifest.json — هذا مو ملف نسخة احتياطية من البوت");
  const manifest = JSON.parse(mf.data.toString("utf8"));
  const byName = new Map(files.map((f) => [f.name, f.data]));
  let uploaded = 0;
  const failed = [];
  const imgs = manifest.files || [];
  for (let i = 0; i < imgs.length; i++) {
    const f = imgs[i];
    const data = byName.get(f.name);
    if (!data) {
      failed.push(f.publicId);
      continue;
    }
    try {
      await cloud.uploadBuffer(data, f.publicId);
      uploaded++;
    } catch (e) {
      failed.push(f.publicId);
    }
    if (onProgress && (i + 1) % 20 === 0) onProgress(i + 1, imgs.length);
  }
  const ok = new Set(imgs.map((f) => f.publicId).filter((p) => !failed.includes(p)));
  // نرجّع الوثائق بس لصور انرفعت فعلاً (ونضيف اللي ما كانت بالنسخة لكنها موجودة بالقاعدة ما نلمسها)
  const docs = (manifest.docs || []).filter((d) => ok.has(d.publicId));
  await cloud.upsertDocs(docs);
  return { uploaded, failed, docs: docs.length };
}

module.exports = { backupAll, restorePart, tarPack, tarUnpack };
