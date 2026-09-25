const sharp = require("sharp");
const webp = require("node-webpmux");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const fs = require("fs");
const path = require("path");

ffmpeg.setFfmpegPath(ffmpegPath);

// ✅ تخفيف استهلاك الذاكرة: sharp افتراضياً يحتفظ بكاش داخلي (صور
// وعمليات معالجة سابقة) بالذاكرة، مفيد لسيرفرات تعالج نفس الصورة بشكل
// متكرر — بوتنا يعالج كل صورة مرة وحدة بس، فالكاش هذا يحجز ذاكرة بدون
// أي فايدة فعلية. نطفّيه كليًا
sharp.cache(false);

const MAX_VIDEO_DURATION = 6; // ثواني — حد واتساب للستيكر المتحرك

function cleanup(...files) {
  for (const f of files) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
  }
}

function buildExifPayload(pack, author) {
  const json = {
    "sticker-pack-id": "bot.reem.quiz",
    "sticker-pack-name": pack || "",
    "sticker-pack-publisher": author || "",
    "emojis": ["🤖"],
  };

  const exifAttr = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  const jsonBuffer = Buffer.from(JSON.stringify(json));
  const exif = Buffer.concat([exifAttr, jsonBuffer]);
  exif.writeUIntLE(jsonBuffer.length, 14, 4);
  return exif;
}

// ✅ إصلاح "نص الستيكر يتحرك ونص يتجمد": node-webpmux (يستخدمه addExif
// تحت) يفكّك كل فريمات الستيكر المتحرك ويعيد بناءها من الصفر عشان يضيف
// بيانات الباقة — وهذي بالضبط الحالة اللي فيها خطأ موثّق بمشروع libwebp
// نفسه (Google) بعلم blend/dispose بين الفريمات لما فيه قناة شفافية:
// فريم قديم يفضل عالق جزئياً بدل ما ينمسح، فيبين "نص يتحرك ونص واقف".
// اختبرنا هذا فعلياً على فيديو حقيقي سبّب المشكلة — تأكدنا إن ffmpeg
// نفسه ينتج ملف سليم 100%، والعطب يصير بالضبط بخطوة إعادة البناء هذي.
//
// الحل: نضيف بيانات الباقة مباشرة على مستوى الـbytes الخام لملف WebP
// (RIFF chunks) بدون ما نلمس أي فريم إطلاقاً — بس نضيف تشنك EXIF
// بآخر الملف ونفعّل بت العلم المناسب بترويسة VP8X. الملف الأصلي وكل
// فريماته يبقون بالضبط زي ما طلعوا من ffmpeg، فمستحيل ينكسر شي
function addExifRaw(webpBuffer, pack, author) {
  const exif = buildExifPayload(pack, author);
  const data = Buffer.from(webpBuffer); // نسخة قابلة للتعديل، ما نأثر على الأصل

  const vp8xIndex = data.indexOf("VP8X");
  if (vp8xIndex === -1) {
    // نادر جداً (ملف متحرك بدون ترويسة VP8X) — نرمي خطأ عشان المستدعي
    // يرجع لـaddExif (node-webpmux) كخطة بديلة بدل ما يفشل تماماً
    throw new Error("لا توجد ترويسة VP8X بالملف");
  }
  const flagsPos = vp8xIndex + 8;
  data[flagsPos] |= 0x08; // بت علم وجود EXIF (bit 3) بترويسة VP8X

  const needsPad = exif.length % 2 !== 0;
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write("EXIF", 0, "ascii");
  chunkHeader.writeUInt32LE(exif.length, 4);
  const pad = needsPad ? Buffer.from([0x00]) : Buffer.alloc(0);

  const result = Buffer.concat([data, chunkHeader, exif, pad]);
  result.writeUInt32LE(result.length - 8, 4); // تحديث حجم RIFF الكامل
  return result;
}

// الطريقة الأصلية عبر node-webpmux — نخليها للستيكرات الثابتة (فريم
// وحيد، ما فيه فرصة لمشكلة blend/dispose بين فريمات أصلاً) وكخطة بديلة
// لو addExifRaw فشلت لأي سبب
async function addExif(webpBuffer, pack, author) {
  const img = new webp.Image();
  await img.load(webpBuffer);
  img.exif = buildExifPayload(pack, author);
  return await img.save(null);
}

// يضيف بيانات الباقة لستيكر متحرك — يفضّل الطريقة الخام الآمنة، ولو
// فشلت لأي سبب غير متوقع يرجع لـnode-webpmux بدل ما يكسر كل شي
async function addExifAnimated(webpBuffer, pack, author) {
  try {
    return addExifRaw(webpBuffer, pack, author);
  } catch (e) {
    console.error("⚠️ فشلت إضافة EXIF بالطريقة الخام، رجعنا لـnode-webpmux:", e.message);
    return await addExif(webpBuffer, pack, author);
  }
}

async function createSticker(imageBuffer, pack, author) {
  // لو أصلاً animated webp (ستيكر متحرك) — نحافظ على الحركة
  try {
    const img = new webp.Image();
    await img.load(imageBuffer);
    if (img.frames && img.frames.length > 1) {
      return await addExifAnimated(imageBuffer, pack, author);
    }
  } catch (e) {}

  // صورة ثابتة → webp
  const MAX = 512;
  const webpBuffer = await sharp(imageBuffer)
    .resize(MAX, MAX, { fit: "inside", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 80, effort: 4, lossless: false })
    .toBuffer();

  return await addExif(webpBuffer, pack, author);
}

// فيديو → ستيكر متحرك (animated webp)
async function createAnimatedSticker(videoBuffer, pack, author) {
  const tmpDir = "/tmp";
  const id = Date.now();
  const inputPath = path.join(tmpDir, `in_${id}.mp4`);
  const outputPath = path.join(tmpDir, `out_${id}.webp`);

  fs.writeFileSync(inputPath, videoBuffer);

  try {
    // فحص مدة الفيديو
    const metadata = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, meta) => {
        if (err) reject(err);
        else resolve(meta);
      });
    });

    const duration = metadata.format.duration || 0;
    if (duration > MAX_VIDEO_DURATION) {
      throw new Error(`الفيديو طويل جداً (${duration.toFixed(1)} ثانية). الحد الأقصى المسموح: ${MAX_VIDEO_DURATION} ثواني.`);
    }

    // تحويل الفيديو لـ animated webp
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          // نقص المربع النص من الفيديو ونكبّره لـ512×512 بالضبط — واتساب
          // يشترط هذا المقاس تحديداً للستيكر المتحرك. جربنا قبل نحافظ على
          // شكل الفيديو الطولي/العرضي الأصلي بدون قص (fit-within بدون
          // مربع كامل)، وطلعت مشكلة "نص يتحرك ونص يتجمد" باستمرار حتى إن
          // الملف نفسه كان سليم 100% لما فحصناه — يعني المشكلة مو بالملف،
          // أغلب الظن إنها بطريقة عرض واتساب لستيكر أبعاده مو مربعة تمامًا.
          // القص للمربع يضمن توافق كامل مع المواصفة ويلغي هذا الاحتمال نهائياً
          '-vf', "fps=10,crop='min(iw\\,ih)':'min(iw\\,ih)',scale=512:512,setsar=1",
          '-c:v', 'libwebp',
          '-lossless', '0',
          '-q:v', '80',
          '-loop', '0',
          '-preset', 'picture',
          '-an', // بدون صوت
          '-vsync', '0'
        ])
        .toFormat('webp')
        .save(outputPath)
        .on('end', resolve)
        .on('error', reject);
    });

    const webpBuffer = fs.readFileSync(outputPath);
    return await addExifAnimated(webpBuffer, pack, author);

  } finally {
    cleanup(inputPath, outputPath);
  }
}

module.exports = { createSticker, createAnimatedSticker };