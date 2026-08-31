// أمر .ستيكر — يحوّل صورة/فيديو/ستيكر مردود عليه لستيكر واتساب بحقوق
// (pack/author) مخصصة. ميزة مستقلة تمامًا عن منطق المسابقات، فُصلت هنا
// عشان index.js يفضل مركّز على التوزيع بس، مو تفاصيل تنفيذ كل أمر.
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const { createSticker, createAnimatedSticker } = require("../stickerMaker");

// يرجع true لو تكفل بالرسالة (أمر ستيكر فعلاً)، و false لو مالها علاقة —
// نفس نمط handleMatsuriMessage عشان index.js يقدر يستدعيه بنفس الطريقة
async function handleStickerCommand(sock, msg, text, chatId) {
  const stickerMatch = text.match(/^\.ستيكر\s+(.+)$/);
  if (!stickerMatch) return false;

  const raw = stickerMatch[1].trim();
  if (!raw) {
    await sock.sendMessage(
      chatId,
      { text: "⚠️ اكتب الحقوق بعد الأمر، مثال:\n.ستيكر J18\n.ستيكر J18/فداك الستيكر" },
      { quoted: msg }
    );
    return true;
  }

  // تفكيك: pack/author
  // النص الأبيض (pack) = قبل /
  // النص الرمادي (author) = بعد /
  let pack, author;
  if (raw.includes("/")) {
    const parts = raw.split("/");
    pack = parts[0].trim();
    author = parts.slice(1).join("/").trim();
  } else {
    pack = raw;
    author = "";
  }

  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = contextInfo?.quotedMessage;

  if (!quoted) {
    await sock.sendMessage(
      chatId,
      { text: "⚠️ رد على *صورة* أو *ستيكر* أولاً، ثم اكتب الأمر." },
      { quoted: msg }
    );
    return true;
  }

  try {
    let buffer = null;
    let isVideo = false;

    if (quoted.imageMessage) {
      const stream = await downloadContentFromMessage(quoted.imageMessage, "image");
      buffer = Buffer.from([]);
      for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    } else if (quoted.stickerMessage) {
      const stream = await downloadContentFromMessage(quoted.stickerMessage, "image");
      buffer = Buffer.from([]);
      for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    } else if (quoted.videoMessage) {
      const stream = await downloadContentFromMessage(quoted.videoMessage, "video");
      buffer = Buffer.from([]);
      for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
      isVideo = true;
    }

    if (!buffer || buffer.length === 0) {
      await sock.sendMessage(
        chatId,
        { text: "⚠️ ما قدرت أحمل الملف. جرب صورة/فيديو/ستيكر ثاني." },
        { quoted: msg }
      );
      return true;
    }

    const stickerBuffer = isVideo
      ? await createAnimatedSticker(buffer, pack, author)
      : await createSticker(buffer, pack, author);

    await sock.sendMessage(
      chatId,
      {
        sticker: stickerBuffer,
        pack: pack,
        author: author,
      },
      { quoted: msg }
    );
  } catch (err) {
    console.error("⚠️ خطأ بإنشاء الستيكر:", err.message);
    await sock.sendMessage(
      chatId,
      { text: `⚠️ صار خطأ: ${err.message}` },
      { quoted: msg }
    );
  }
  return true;
}

module.exports = { handleStickerCommand };
