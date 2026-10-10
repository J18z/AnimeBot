const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");

// ✅ كاش بالذاكرة: قبل كذا كل استدعاء (وكان يصير عدة مرات مع كل رسالة
// توصل من أي قروب) يسوي readFileSync + JSON.parse على القرص — عمل متزامن
// يوقف المعالج. الحين نقرأ الملف مرة وحدة، ونفحص تعديله (mtime) بحد أقصى
// مرة كل 3 ثواني، فتعديلاتك على الملفات تنعكس بدون إعادة تشغيل (نفس
// السلوك القديم) لكن بدون تكلفة بكل رسالة
const CHECK_EVERY_MS = 3000;
const jsonCache = new Map(); // fileName -> { data, mtimeMs, checkedAt }

function readJson(fileName) {
  const now = Date.now();
  const hit = jsonCache.get(fileName);
  if (hit && now - hit.checkedAt < CHECK_EVERY_MS) return hit.data;

  const filePath = path.join(DATA_DIR, fileName);
  if (hit) {
    try {
      const mtimeMs = fs.statSync(filePath).mtimeMs;
      if (mtimeMs === hit.mtimeMs) {
        hit.checkedAt = now;
        return hit.data;
      }
    } catch (e) {
      hit.checkedAt = now;
      return hit.data; // الملف مؤقتاً غير متاح، نكمل بآخر نسخة سليمة
    }
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw); // لو الملف تالف يرمي خطأ (والكاش القديم يبقى سليم)
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch (e) {}
  jsonCache.set(fileName, { data, mtimeMs, checkedAt: now });
  return data;
}

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

let configCache = { source: null, merged: null };
function getConfig() {
  const fileConfig = readJson("config.json");
  if (configCache.source === fileConfig) return configCache.merged;
  // متغيرات البيئة (تُضبط من إعدادات الاستضافة، Render مثلاً) لها أولوية
  // على الملف — عشان ما نحط أسرار زي رابط قاعدة البيانات بالكود مباشرة
  const merged = {
    ...fileConfig,
    mongoUri: process.env.MONGO_URI || fileConfig.mongoUri,
    ownerId: process.env.OWNER_ID || fileConfig.ownerId,
    matsuriChatId: process.env.MATSURI_CHAT_ID || fileConfig.matsuriChatId,
    matsuriOwnerId: process.env.MATSURI_OWNER_ID || fileConfig.matsuriOwnerId,
    rouletteChatId: process.env.ROULETTE_CHAT_ID || fileConfig.rouletteChatId,
    rasadChatId: process.env.RASAD_CHAT_ID || fileConfig.rasadChatId,
    horaChatId: process.env.HORA_CHAT_ID || fileConfig.horaChatId,
  };
  configCache = { source: fileConfig, merged };
  return merged;
}

function getImagePath(fileName) {
  return path.join(DATA_DIR, "images", fileName);
}

// يلقى الصورة حتى لو اختلفت حالة الأحرف (Musashi.JPG vs musashi.jpg) أو
// فيه مسافة زايدة بالاسم — لينكس حساس لحالة الأحرف وويندوز لا، فصورة تشتغل
// عندك محلياً ممكن تفشل بالسيرفر. يرجع null لو الملف فعلاً غير موجود
// فهرس أسماء ملفات الصور (بحروف صغيرة) — نبنيه مرة، ونعيد بناءه بس لو
// ما لقينا ملف (وبحد أدنى 10 ثواني بين كل إعادة بناء) بدل existsSync +
// readdirSync مع كل صورة
let imageIndex = null;
let imageIndexBuiltAt = 0;
function buildImageIndex() {
  const dir = path.join(DATA_DIR, "images");
  const idx = new Map();
  try {
    for (const f of fs.readdirSync(dir)) idx.set(f.toLowerCase(), path.join(dir, f));
  } catch (e) {
    /* المجلد غير موجود */
  }
  imageIndex = idx;
  imageIndexBuiltAt = Date.now();
}

// يلقى الصورة حتى لو اختلفت حالة الأحرف (Musashi.JPG vs musashi.jpg) أو
// فيه مسافة زايدة بالاسم — لينكس حساس لحالة الأحرف وويندوز لا. يرجع null
// لو الملف فعلاً غير موجود
function resolveImagePath(fileName) {
  const clean = String(fileName || "").trim();
  if (!clean) return null;
  const lower = clean.toLowerCase();
  if (!imageIndex) buildImageIndex();
  let found = imageIndex.get(lower);
  if (!found && Date.now() - imageIndexBuiltAt > 10000) {
    buildImageIndex(); // ممكن أضفت صورة جديدة
    found = imageIndex.get(lower);
  }
  return found || null;
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