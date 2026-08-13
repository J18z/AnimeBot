const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");

function readJson(fileName) {
  const filePath = path.join(DATA_DIR, fileName);
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

// نعيد القراءة من القرص كل مرة عشان لو عدّلت الملفات وأنت شغّال البوت
// تنعكس التعديلات فوراً بدون ما تسكّر وتشغّل البوت من جديد
function getQuestions() {
  return readJson("questions.json");
}

function getWords() {
  return readJson("words.json");
}

function getCounts() {
  return readJson("counts.json");
}

function getImages() {
  return readJson("images.json");
}

function getConfig() {
  const fileConfig = readJson("config.json");
  // متغيرات البيئة (تُضبط من إعدادات الاستضافة، Render مثلاً) لها أولوية
  // على الملف — عشان ما نحط أسرار زي رابط قاعدة البيانات بالكود مباشرة
  return {
    ...fileConfig,
    mongoUri: process.env.MONGO_URI || fileConfig.mongoUri,
    ownerId: process.env.OWNER_ID || fileConfig.ownerId,
    matsuriChatId: process.env.MATSURI_CHAT_ID || fileConfig.matsuriChatId,
  };
}

function getImagePath(fileName) {
  return path.join(DATA_DIR, "images", fileName);
}

module.exports = {
  getQuestions,
  getWords,
  getCounts,
  getImages,
  getConfig,
  getImagePath,
  DATA_DIR,
};
