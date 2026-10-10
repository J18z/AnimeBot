// أمر .ستكر — نفس فكرة .ستيكر بالضبط، بس يستخدم الطريقة القديمة لصنع
// الستيكر (../stickerMakerOld) بدل الجديدة. الاثنين مطلوبين مع بعض بنفس
// البوت (بطلب المستخدم)، فخليناهم بملفين منفصلين تماماً عشان أي تعديل
// على وحدة مستقبلاً ما يأثر على الثانية.
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const { streamToBuffer } = require("../mediaUtil");
const { createSticker, createAnimatedSticker } = require("../stickerMakerOld");

// يرجع true لو تكفل بالرسالة (أمر .ستكر فعلاً)، و false لو مالها علاقة
async function handleStickerOldCommand(sock, msg, text, chatId) {
  const stickerMatch = text.match(/^\.ستكر\s+(.+)$/);
  if (!stickerMatch) return false;

  const raw = stickerMatch[1].trim();
  if (!raw) {
    await sock.sendMessage(
      chatId,
      { text: "⚠️ اكتب الحقوق بعد الأمر، مثال:\n.ستكر J18\n.ستكر J18|فداك الستيكر" },
      { quoted: msg }
    );
    return true;
  }

  // تفكيك: pack|author
  // النص الأبيض (pack) = قبل |
  // النص الرمادي (author) = بعد |
  let pack, author;
  if (raw.includes("|")) {
    const parts = raw.split("|");
    pack = parts[0].trim();
    author = parts.slice(1).join("|").trim();
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
      buffer = await streamToBuffer(stream);
    } else if (quoted.stickerMessage) {
      const stream = await downloadContentFromMessage(quoted.stickerMessage, "image");
      buffer = await streamToBuffer(stream);
    } else if (quoted.videoMessage) {
      const stream = await downloadContentFromMessage(quoted.videoMessage, "video");
      buffer = await streamToBuffer(stream);
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
    console.error("⚠️ خطأ بإنشاء الستيكر (.ستكر):", err.message);
    await sock.sendMessage(
      chatId,
      { text: `⚠️ صار خطأ: ${err.message}` },
      { quoted: msg }
    );
  }
  return true;
}

module.exports = { handleStickerOldCommand };
