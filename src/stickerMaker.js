const sharp = require("sharp");

/**
 * يحول أي صورة/ستيكر إلى webp 512×512 (صيغة الستيكر)
 * بدون إضافة نص على الصورة نفسها
 */
async function createSticker(imageBuffer) {
  const MAX = 512;

  const stickerBuffer = await sharp(imageBuffer)
    .resize(MAX, MAX, {
      fit: "inside",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp({
      quality: 80,
      effort: 4,
      lossless: false,
    })
    .toBuffer();

  return stickerBuffer;
}

module.exports = { createSticker };