const sharp = require("sharp");
const webp = require("node-webpmux");

async function createSticker(imageBuffer, pack, author) {
  const MAX = 512;

  // 1) تحويل الصورة لـ webp
  const webpBuffer = await sharp(imageBuffer)
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

  // 2) إضافة EXIF metadata (Pack + Author) داخل الـ webp نفسه
  const img = new webp.Image();
  await img.load(webpBuffer);

  const json = {
    "sticker-pack-id": "bot.reem.quiz",
    "sticker-pack-name": pack,
    "sticker-pack-publisher": author,
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

module.exports = { createSticker };