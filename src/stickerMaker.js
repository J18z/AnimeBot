const sharp = require("sharp");
const webp = require("node-webpmux");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const fs = require("fs");
const path = require("path");

ffmpeg.setFfmpegPath(ffmpegPath);

const MAX_VIDEO_DURATION = 6; // ثواني — حد واتساب للستيكر المتحرك

function cleanup(...files) {
  for (const f of files) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
  }
}

async function addExif(webpBuffer, pack, author) {
  const img = new webp.Image();
  await img.load(webpBuffer);

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

  img.exif = exif;
  return await img.save(null);
}

async function createSticker(imageBuffer, pack, author) {
  // لو أصلاً animated webp (ستيكر متحرك) — نحافظ على الحركة
  try {
    const img = new webp.Image();
    await img.load(imageBuffer);
    if (img.frames && img.frames.length > 1) {
      return await addExif(imageBuffer, pack, author);
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
          '-vf', 'fps=10,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
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
    return await addExif(webpBuffer, pack, author);

  } finally {
    cleanup(inputPath, outputPath);
  }
}

module.exports = { createSticker, createAnimatedSticker };