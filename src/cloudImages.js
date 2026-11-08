// ☁️ صور Cloudinary: صور إضافية تنرفع من واتساب (.ضف) وتنضاف لبنك الصور بدون ما تلمس ملف.
// - الصورة نفسها على Cloudinary، وبياناتها (الاسم، الإجابات، النقاط) بقاعدة MongoDB (collection: cloudImages)
// - كل صورة = عنصر بنفس شكل عناصر data/images.json، وملفها "cloud:<public_id>"
// - أكثر من صورة لنفس الشخصية = عناصر بنفس الإجابات، ونظام answerGroups يعتبرها سؤال واحد بقفل التكرار
// - المتغيرات: CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET (بدونها الميزة تتعطل بصمت)
// ما نستخدم أي مكتبة إضافية: REST مباشر (fetch + crypto) من Node 18+

const crypto = require("crypto");
const { getDb } = require("./db");

const COLLECTION = "cloudImages";
const FOLDER = "quiz";
const FETCH_TIMEOUT_MS = 20000;
const UPLOAD_TIMEOUT_MS = 60000;
const MAX_UPLOAD_BYTES = 9 * 1024 * 1024; // حد Cloudinary المجاني 10MB

let items = []; // عناصر بنك الصور (نسخة غير قابلة للتعديل: نبدّل المصفوفة كاملة عند أي تغيير)
let docs = []; // الوثائق الخام من القاعدة
let onChange = () => {};

function cfg() {
  return {
    cloud: process.env.CLOUDINARY_CLOUD_NAME,
    key: process.env.CLOUDINARY_API_KEY,
    secret: process.env.CLOUDINARY_API_SECRET,
  };
}
function enabled() {
  const c = cfg();
  return !!(c.cloud && c.key && c.secret);
}

// توقيع Cloudinary: المعاملات (بدون file/api_key/cloud_name/resource_type) مرتبة أبجدياً "k=v&k=v" + السر → SHA1
function sign(params, secret) {
  const base = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHash("sha1").update(base + secret).digest("hex");
}

async function api(path, form, timeoutMs) {
  const c = cfg();
  const res = await fetch(`https://api.cloudinary.com/v1_1/${c.cloud}/${path}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    /* رد غير JSON */
  }
  if (!res.ok) throw new Error((json && json.error && json.error.message) || `HTTP ${res.status}`);
  return json;
}

async function uploadBuffer(buffer, publicId) {
  if (!enabled()) throw new Error("Cloudinary غير مفعّل (متغيرات البيئة ناقصة)");
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error("الصورة أكبر من 9MB");
  const c = cfg();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const params = { overwrite: "true", public_id: publicId, timestamp };
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "image/jpeg" }), "image.jpg");
  form.append("api_key", c.key);
  for (const [k, v] of Object.entries(params)) form.append(k, v);
  form.append("signature", sign(params, c.secret));
  return api("image/upload", form, UPLOAD_TIMEOUT_MS);
}

async function destroy(publicId) {
  if (!enabled()) return;
  const c = cfg();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const params = { public_id: publicId, timestamp };
  const form = new FormData();
  form.append("api_key", c.key);
  for (const [k, v] of Object.entries(params)) form.append(k, v);
  form.append("signature", sign(params, c.secret));
  await api("image/destroy", form, FETCH_TIMEOUT_MS);
}

// رابط التسليم: jpg، أقصى 1000px (نفس تصغير البوت)، جودة تلقائية
function urlFor(publicId) {
  const c = cfg();
  return `https://res.cloudinary.com/${c.cloud}/image/upload/c_limit,w_1000,h_1000,q_auto:good,f_jpg/${publicId}`;
}

// يجيب الصورة كـBuffer (محاولتين). يستخدمها game._prepareImage للملفات اللي تبدأ بـ"cloud:"
async function fetchImage(publicId) {
  if (!enabled()) throw new Error("Cloudinary غير مفعّل (متغيرات البيئة ناقصة)");
  let lastErr;
  for (let i = 1; i <= 2; i++) {
    try {
      const res = await fetch(urlFor(publicId), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error("صورة فاضية");
      return buf;
    } catch (e) {
      lastErr = e;
      if (i < 2) await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr;
}

// ───────── بنك الصور (الذاكرة + القاعدة) ─────────
function toItem(d) {
  const it = {
    id: d._id,
    file: `cloud:${d.publicId}`,
    question: d.question || "من هذه الشخصية؟",
    answers: d.answers,
    points: d.points || 1,
  };
  if (d.type) it.type = d.type;
  if (d.required) it.required = d.required;
  if (d.alt) it.alt = d.alt;
  return it;
}

function rebuild() {
  items = docs.map(toItem);
  onChange(items);
}

async function loadFromDb() {
  const db = getDb();
  if (!db) return;
  try {
    docs = (await db.collection(COLLECTION).find({}).toArray()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    rebuild();
    console.log(`☁️ تحميل ${docs.length} صورة من Cloudinary (بيانات القاعدة).`);
  } catch (e) {
    console.error("خطأ تحميل صور Cloudinary:", e.message);
  }
}

// اسم رمزي من اسم ملف: حروف إنجليزية صغيرة وأرقام و - _ (بدون الامتداد)
function slug(s) {
  return String(s || "").toLowerCase().replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

// شخصية لسا بصور data/images (ما انتقلت): نلقاها باسم ملف الصورة أو id ونرجع إجاباتها
function findLegacySpec(charKey) {
  let base;
  try {
    base = require("./dataStore").getImages().filter((i) => !String(i.file || "").startsWith("cloud:"));
  } catch (e) {
    return null;
  }
  const it = base.find((i) => slug(i.file) === charKey) || base.find((i) => slug(i.id) === charKey);
  if (!it) return null;
  const spec = { answers: it.answers, points: it.points || 1 };
  if (it.type) spec.type = it.type;
  if (it.required) spec.required = it.required;
  if (it.alt || it.alts) spec.alt = it.alt || it.alts;
  return spec;
}

// نعيد قراءة الصور من القاعدة كل فترة: الصور اللي ينقلها سكربت النقل من برا تظهر بدون إعادة تشغيل
function startAutoReload(everyMs = 5 * 60 * 1000) {
  const t = setInterval(() => loadFromDb().catch(() => {}), everyMs);
  if (t.unref) t.unref();
}

function setOnChange(fn) {
  onChange = fn;
  fn(items);
}

function getItems() {
  return items;
}

// صور شخصية معيّنة (بالترتيب)
function ofChar(charKey) {
  return docs.filter((d) => d.charKey === charKey);
}

// قائمة الشخصيات: [{ charKey, count, answers }]
function listChars() {
  const m = new Map();
  for (const d of docs) {
    const e = m.get(d.charKey) || { charKey: d.charKey, count: 0, answers: d.answers };
    e.count += 1;
    m.set(d.charKey, e);
  }
  return [...m.values()];
}

// يضيف صورة. spec = { answers, type?, required?, points? } اختياري لو الشخصية موجودة (ننسخ من أول صورة لها)
// يرجع { doc, n } ورقم الصورة بالشخصية
async function addImage(charKey, buffer, spec) {
  const existing = ofChar(charKey);
  let base = spec && spec.answers ? spec : null;
  if (!base) {
    if (!existing.length) throw new Error("NEED_ANSWERS");
    const f = existing[0];
    base = { answers: f.answers, type: f.type, required: f.required, points: f.points };
  }
  // رقم فريد (ما نعيد استخدام رقم محذوف عشان ما ينكسر كاش Cloudinary)
  let n = 1;
  const used = new Set(existing.map((d) => d._id));
  while (used.has(`cl:${charKey}_${n}`)) n++;
  const id = `cl:${charKey}_${n}`;
  const publicId = `${FOLDER}/${charKey}_${n}`;
  await uploadBuffer(buffer, publicId);
  const doc = {
    _id: id,
    charKey,
    publicId,
    question: "من هذه الشخصية؟",
    answers: base.answers,
    points: base.points || 1,
    createdAt: Date.now(),
  };
  if (base.type) doc.type = base.type;
  if (base.required) doc.required = base.required;
  if (base.alt) doc.alt = base.alt;
  const db = getDb();
  if (db) await db.collection(COLLECTION).insertOne(doc);
  docs = [...docs, doc];
  rebuild();
  return { doc, n: existing.length + 1 };
}

// يحذف صورة رقم n من الشخصية (أو كلها لو n = undefined). يرجع عدد المحذوف
async function removeImages(charKey, n) {
  const list = ofChar(charKey);
  const targets = n ? list.slice(n - 1, n) : list;
  if (!targets.length) return 0;
  for (const d of targets) {
    try {
      await destroy(d.publicId);
    } catch (e) {
      console.error(`⚠️ فشل حذف ${d.publicId} من Cloudinary (نكمل حذف بياناتها):`, e.message);
    }
  }
  const db = getDb();
  if (db) await db.collection(COLLECTION).deleteMany({ _id: { $in: targets.map((d) => d._id) } });
  const gone = new Set(targets.map((d) => d._id));
  docs = docs.filter((d) => !gone.has(d._id));
  rebuild();
  return targets.length;
}

module.exports = {
  enabled,
  sign,
  urlFor,
  fetchImage,
  uploadBuffer,
  destroy,
  loadFromDb,
  startAutoReload,
  slug,
  findLegacySpec,
  setOnChange,
  getItems,
  ofChar,
  listChars,
  addImage,
  removeImages,
};
