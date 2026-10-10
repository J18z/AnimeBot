// تحميل وسائط واتساب لبافر مع سقف حجم. القديم كان يسوي
// Buffer.concat([buffer, chunk]) مع كل جزء (نسخ كامل للبيانات كل مرة =
// استهلاك ذاكرة ومعالج تربيعي على الفيديوهات الكبيرة)، وبدون أي حد أقصى —
// فيديو ضخم يقدر يستهلك ذاكرة السيرفر كلها

const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // 25MB

async function streamToBuffer(stream, maxBytes = MAX_MEDIA_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`الملف كبير جداً (الحد الأقصى ${Math.round(maxBytes / 1024 / 1024)}MB).`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

module.exports = { streamToBuffer, MAX_MEDIA_BYTES };
