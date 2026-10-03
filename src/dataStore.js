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

// بنك كلمات مخصص لفقرة "تكرار" بس — كلمات قصيرة (2-4 أحرف) عشان ما
// تتعب لما تتكرر 2-5 مرات برسالة وحدة. مفصول عن بنك الكتابة العادي
// (اللي فيه كلمات أطول تناسب فقرة الكتابة العادية)
function getWordsRepeat() {
  return readJson("words_repeat.json");
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
    matsuriOwnerId: process.env.MATSURI_OWNER_ID || fileConfig.matsuriOwnerId,
    rouletteChatId: process.env.ROULETTE_CHAT_ID || fileConfig.rouletteChatId,
    rasadChatId: process.env.RASAD_CHAT_ID || fileConfig.rasadChatId,
    horaChatId: process.env.HORA_CHAT_ID || fileConfig.horaChatId,
  };
}

function getImagePath(fileName) {
  return path.join(DATA_DIR, "images", fileName);
}

// يلقى الصورة حتى لو اختلفت حالة الأحرف (Musashi.JPG vs musashi.jpg) أو
// فيه مسافة زايدة بالاسم — لينكس حساس لحالة الأحرف وويندوز لا، فصورة تشتغل
// عندك محلياً ممكن تفشل بالسيرفر. يرجع null لو الملف فعلاً غير موجود
function resolveImagePath(fileName) {
  const clean = String(fileName || "").trim();
  const exact = getImagePath(clean);
  if (fs.existsSync(exact)) return exact;
  try {
    const dir = path.join(DATA_DIR, "images");
    const lower = clean.toLowerCase();
    const found = fs.readdirSync(dir).find((f) => f.toLowerCase() === lower);
    return found ? path.join(dir, found) : null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  getQuestions,
  getWords,
  getWordsRepeat,
  getCounts,
  getImages,
  getConfig,
  getImagePath,
  resolveImagePath,
  DATA_DIR,
};