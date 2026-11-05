// طلبات تحتاج موافقة صاحب البوت (تغيير نوع التسجيل، تغيير اللقب).
// الطلب يوصل لصاحب البوت بالخاص برقم، ويرد عليه .قبول <رقم> أو .رفض <رقم>
// (أو يرد على رسالة الطلب نفسها بـ .قبول / .رفض). تنحفظ بقاعدة البيانات عشان ما تضيع
// مع إعادة التشغيل، وتنتهي بعد 24 ساعة بدون رد.

const { getDb } = require("./db");

const TTL_MS = 24 * 60 * 60 * 1000;
const COLLECTION = "change_requests";

const reqs = new Map(); // id -> { id, kind: "type"|"title", userId, chatId, value, createdAt, ownerMsgId }
let seq = 0;

function persist(r) {
  const db = getDb();
  if (!db) return Promise.resolve();
  return db
    .collection(COLLECTION)
    .updateOne({ _id: r.id }, { $set: { kind: r.kind, userId: r.userId, chatId: r.chatId, value: r.value, createdAt: r.createdAt, ownerMsgId: r.ownerMsgId } }, { upsert: true })
    .catch((e) => console.error("خطأ حفظ طلب:", e.message));
}

function persistDelete(id) {
  const db = getDb();
  if (!db) return Promise.resolve();
  return db
    .collection(COLLECTION)
    .deleteOne({ _id: id })
    .catch((e) => console.error("خطأ حذف طلب:", e.message));
}

function prune() {
  const now = Date.now();
  for (const r of [...reqs.values()]) {
    if (now - r.createdAt > TTL_MS) {
      reqs.delete(r.id);
      persistDelete(r.id);
    }
  }
}

// طلب جديد لنفس الشخص ونفس النوع يلغي القديم
function create({ kind, userId, chatId, value }) {
  for (const r of [...reqs.values()]) {
    if (r.userId === userId && r.kind === kind) {
      reqs.delete(r.id);
      persistDelete(r.id);
    }
  }
  const r = { id: ++seq, kind, userId, chatId, value, createdAt: Date.now(), ownerMsgId: null };
  reqs.set(r.id, r);
  persist(r);
  return r;
}

function get(id) {
  prune();
  return reqs.get(id) || null;
}

function findByUser(userId, kind) {
  prune();
  return [...reqs.values()].find((r) => r.userId === userId && r.kind === kind) || null;
}

function findByOwnerMsgId(msgId) {
  if (!msgId) return null;
  prune();
  return [...reqs.values()].find((r) => r.ownerMsgId === msgId) || null;
}

function setOwnerMsgId(id, msgId) {
  const r = reqs.get(id);
  if (!r || !msgId) return;
  r.ownerMsgId = msgId;
  persist(r);
}

function list() {
  prune();
  return [...reqs.values()].sort((a, b) => a.id - b.id);
}

async function remove(id) {
  reqs.delete(id);
  await persistDelete(id);
}

async function loadFromDb() {
  const db = getDb();
  if (!db) return;
  try {
    const docs = await db.collection(COLLECTION).find({}).toArray();
    for (const d of docs) {
      if (typeof d._id !== "number") continue;
      reqs.set(d._id, { id: d._id, kind: d.kind, userId: d.userId, chatId: d.chatId, value: d.value, createdAt: d.createdAt || Date.now(), ownerMsgId: d.ownerMsgId || null });
      if (d._id > seq) seq = d._id;
    }
    prune();
    console.log(`📥 طلبات معلّقة: ${reqs.size}`);
  } catch (e) {
    console.error("خطأ تحميل الطلبات:", e.message);
  }
}

module.exports = { create, get, findByUser, findByOwnerMsgId, setOwnerMsgId, list, remove, loadFromDb };
