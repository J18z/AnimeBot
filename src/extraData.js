// ➕ بيانات إضافية تنضاف من واتساب (.ضف كت / .ضف تع / .ضف س) وتنحفظ بقاعدة MongoDB (collection: extraData)
// وتندمج مع ملفات data/words.json و counts.json و questions.json بدون ما تلمس الملفات.
// كل عنصر بنفس شكل عناصر الملف الأصلي، فباقي البوت يشتغل عليها مثل غيرها.

const { getDb } = require("./db");
const { normalizeWritingRelaxed } = require("./utils");

const COLLECTION = "extraData";
const KINDS = ["words", "counts", "questions"];

let docs = []; // الوثائق الخام
let lists = { words: [], counts: [], questions: [] }; // نبدّل المصفوفة كاملة عند أي تغيير (دمج dataStore يعتمد على مرجعها)
let hiddenSets = { words: new Set(), counts: new Set(), questions: new Set() }; // عناصر الملفات الأصلية اللي انحذفت (تنخفي بدون لمس الملف)

function rebuild() {
  const next = { words: [], counts: [], questions: [] };
  const hid = { words: new Set(), counts: new Set(), questions: new Set() };
  for (const d of docs) {
    if (d.kind === "hide") {
      if (hid[d.target]) hid[d.target].add(d.key);
    } else if (next[d.kind]) next[d.kind].push(d.item);
  }
  lists = next;
  hiddenSets = hid;
}

function get(kind) {
  return lists[kind] || [];
}
function hidden(kind) {
  return hiddenSets[kind];
}

async function loadFromDb() {
  const db = getDb();
  if (!db) return;
  try {
    docs = (await db.collection(COLLECTION).find({}).toArray()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    rebuild();
    console.log(`➕ تحميل ${docs.length} عنصر إضافي (كتابة/تعداد/أسئلة) من القاعدة.`);
  } catch (e) {
    console.error("خطأ تحميل البيانات الإضافية:", e.message);
  }
}

function startAutoReload(everyMs = 5 * 60 * 1000) {
  const t = setInterval(() => loadFromDb().catch(() => {}), everyMs);
  if (t.unref) t.unref();
}

// ───────── تحليل الأوامر (دوال نقية) ─────────
// "+" بين كلمات = اسم مركب (يتخزن بمسافة: "اول+مايت" → "اول مايت")
// بدائل نفس الإجابة بـ"|" أو "/"  (مثال: ناروتو|نارتو)
function aliasesOf(token) {
  return token
    .split(/[|/]/)
    .map((a) => a.replace(/\+/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function tokens(s) {
  return String(s || "").split(/\s+/).filter(Boolean);
}

function parseWords(rest) {
  const out = tokens(rest).map(aliasesOf).filter((a) => a.length);
  return out.map((aliases) => ({ word: aliases }));
}

// "3 ملوك شياطين|انوس موزان ريمورو"  → required=3، topic="3 ملوك شياطين ؟"، answers=[[انوس],[موزان],[ريمورو]]
function parseCount(rest) {
  const s = String(rest || "");
  const i = s.indexOf("|");
  if (i === -1) return { error: "لازم تفصل بين السؤال والإجابات بـ|" };
  const left = s.slice(0, i).trim();
  const right = s.slice(i + 1);
  const m = left.match(/^(\d+)\s+(.+)$/);
  if (!m) return { error: "ابدأ السؤال برقم المطلوب، مثال: 3 ملوك شياطين" };
  const required = parseInt(m[1], 10);
  const answers = tokens(right).map(aliasesOf).filter((a) => a.length);
  if (!answers.length) return { error: "ما لقيت إجابات بعد |" };
  if (required < 1 || required > answers.length) return { error: `المطلوب (${required}) أكثر من عدد الإجابات (${answers.length})` };
  return { topic: `${left.replace(/\s*[؟?]\s*$/, "")} ؟`, required, answers };
}

// "البطل رقم واحد| اول+مايت اولمايت توشينوري"  → أي إجابة منها صحيحة؛ "+" = كلمتين مع بعض كإجابة وحدة
function parseQuestion(rest) {
  const s = String(rest || "");
  const i = s.indexOf("|");
  if (i === -1) return { error: "لازم تفصل بين السؤال والإجابات بـ|" };
  const q = s.slice(0, i).trim().replace(/\s*[؟?]\s*$/, "");
  const answers = [];
  for (const t of tokens(s.slice(i + 1))) for (const a of aliasesOf(t)) answers.push(a);
  if (!q) return { error: "السؤال فاضي" };
  if (!answers.length) return { error: "ما لقيت إجابات بعد |" };
  return { question: `${q} ؟`, answers };
}

const nk = (s) => normalizeWritingRelaxed(String(s || "").replace(/[؟?]/g, " "));

// مفتاح هوية العنصر: الكلمة = أول صيغة، التعداد/السؤال = النص بدون رقم المطلوب بالبداية (عشان تعديل العدد يلقى نفس السؤال)
function itemKey(kind, it) {
  if (kind === "words") return nk(it.word[0]);
  const t = kind === "counts" ? it.topic : it.question;
  return nk(String(t || "").replace(/^\s*\d+\s+/, ""));
}

// عناصر الملف الأصلي بدون المحذوفة
function visibleBase(kind, base) {
  const h = hiddenSets[kind];
  if (!h.size) return base;
  return base.filter((it) => !h.has(itemKey(kind, it)));
}

// يدور على عنصر موجود (ملف أصلي + إضافات). words: أي صيغة. غيرها: النص (بدون رقم المطلوب/علامة ؟)
function find(kind, base, input) {
  const all = [...visibleBase(kind, base).map((it) => ({ it, extra: false })), ...get(kind).map((it) => ({ it, extra: true }))];
  if (kind === "words") {
    const k = nk(aliasesOf(String(input).trim())[0] || "");
    if (!k) return null;
    return all.find((x) => x.it.word.some((a) => nk(a) === k)) || null;
  }
  const k = nk(String(input || "").replace(/^\s*\d+\s+/, ""));
  if (!k) return null;
  return all.find((x) => itemKey(kind, x.it) === k) || null;
}

// يحذف عنصر: من الإضافات نحذف وثيقته، ومن الملف الأصلي نخفيه (وثيقة hide). يرجع العنصر المحذوف أو null
async function removeItem(kind, base, input) {
  const db = getDb();
  if (!db) throw new Error("ما فيه اتصال بقاعدة البيانات (MongoDB)");
  const hit = find(kind, base, input);
  if (!hit) return null;
  if (hit.extra) {
    const d = docs.find((x) => x.kind === kind && x.item === hit.it);
    if (d) {
      await db.collection(COLLECTION).deleteOne({ _id: d._id });
      docs = docs.filter((x) => x !== d);
    }
  } else {
    const key = itemKey(kind, hit.it);
    const d = { _id: `hide:${kind}:${key}`, kind: "hide", target: kind, key, createdAt: Date.now() };
    await db.collection(COLLECTION).updateOne({ _id: d._id }, { $set: d }, { upsert: true });
    docs = [...docs.filter((x) => x._id !== d._id), d];
  }
  rebuild();
  return hit.it;
}

// يضيف عناصر لنوع (words/counts/questions). base = عناصر الملف الأصلي. يرجع { added: [...], skipped: [...] }
async function addItems(kind, base, candidates) {
  const db = getDb();
  if (!db) throw new Error("ما فيه اتصال بقاعدة البيانات (MongoDB)");
  const existing = [...visibleBase(kind, base), ...get(kind)];
  const seen = new Set();
  const addSeen = (it) => {
    if (kind === "words") for (const a of it.word) seen.add(nk(a));
    else seen.add(nk(kind === "counts" ? it.topic : it.question));
  };
  existing.forEach(addSeen);
  const added = [];
  const skipped = [];
  const toInsert = [];
  const stamp = Date.now();
  candidates.forEach((c, idx) => {
    const keys = kind === "words" ? c.word.map(nk) : [nk(kind === "counts" ? c.topic : c.question)];
    const label = kind === "words" ? c.word[0] : kind === "counts" ? c.topic : c.question;
    if (keys.some((k) => seen.has(k))) {
      skipped.push(label);
      return;
    }
    keys.forEach((k) => seen.add(k));
    const item = { ...c };
    if (kind === "counts") {
      item.id = `cx_${stamp}_${idx}`;
      item.points = 1;
    } else if (kind === "questions") {
      item.id = `qx_${stamp}_${idx}`;
      item.type = "normal";
      item.points = 1;
    }
    toInsert.push({ _id: `${kind}:${stamp}_${idx}`, kind, item, createdAt: stamp + idx });
    added.push(label);
  });
  if (toInsert.length) {
    await db.collection(COLLECTION).insertMany(toInsert);
    docs = [...docs, ...toInsert];
    rebuild();
  }
  return { added, skipped };
}

module.exports = { KINDS, get, hidden, visibleBase, find, removeItem, itemKey, nk, loadFromDb, startAutoReload, parseWords, parseCount, parseQuestion, addItems };
