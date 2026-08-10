const sharp = require("sharp");

function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateCopyrightSvg(text, canvasWidth) {
  const fontSize = Math.min(40, Math.max(14, Math.floor(canvasWidth / (text.length * 0.55))));
  const height = fontSize + 24;

  return `
    <svg width="${canvasWidth}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="2" dy="2" stdDeviation="3" flood-color="black" flood-opacity="0.85"/>
        </filter>
      </defs>
      <text x="50%" y="55%" text-anchor="middle" dominant-baseline="middle"
        font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold"
        fill="white" filter="url(#shadow)">${escapeXml(text)}</text>
    </svg>
  `;
}

async function createSticker(imageBuffer, copyright) {
  const MAX = 512;

  const resized = sharp(imageBuffer).resize(MAX, MAX, {
    fit: "inside",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });

  const svg = generateCopyrightSvg(copyright, MAX);

  const stickerBuffer = await resized
    .composite([
      {
        input: Buffer.from(svg),
        gravity: "south",
        blend: "over",
      },
    ])
    .webp({
      quality: 80,
      effort: 4,
      lossless: false,
    })
    .toBuffer();

  return stickerBuffer;
}

module.exports = { createSticker };