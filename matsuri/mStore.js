// ═══════════════════════════════════════════════════════════════════
// تخزين نظام ماتسوري: سجل الألقاب + صلاحيات ماتسوري + جدولة المسابقة اليومية
// + قائمة "غير المسجلين اللي شاركوا" (يقدرون يسجلون بالخاص حتى لو طلعوا من القروب).
// منفصل تماماً عن تسجيل البوت العام (registration.js) — جداول MongoDB خاصة:
//   matsuri_registry / matsuri_perms / matsuri_schedule / matsuri_pending
// لو ما فيه MongoDB يشتغل بالذاكرة (ويضيع عند إعادة التشغيل مثل باقي البوت).
// كل شي هنا محدود الحجم (عدد المسجلين فعلياً، والـpending ينظّف نفسه بعد 7 أيام).
// ═══════════════════════════════════════════════════════════════════

const { getDb } = require("../src/db");

const GUILDS = [
  { n: 1, name: "تسوكي", emoji: "🔆", title: "تـسـوكـي" },
  { n: 2, name: "تايو", emoji: "🎴", title: "تـايـو" },
  { n: 3, name: "ياما", emoji: "⛰️", title: "يـامـا" },
  { n: 4, name: "ناكاما", emoji: "⚡", title: "نـاكـامـا" },
];

const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_NICK_LEN = 24;

const entries = new Map(); // userId -> { userId, nick, guild, contests, createdAt }
const perms = new Set(); // أشخاص معطيهم .منح (الحزمة)
// أوامر حزمة ماتسوري (اللي يستخدمها الممنوحون). تتعدل بـ.ضف امر / .الغ امر
const DEFAULT_PKG = ["قفل قروب", "فتح قروب", "منشن", "رفع", "تنزيل", "حذف", "المسجلين"];
const pkgCmds = new Set(DEFAULT_PKG);
const pending = new Map(); // userId -> { ids: [digits...], until }
let schedule = null; // { chatId, total, pools: [اسم الفقرة...], hour }

// ── أدوات نص ──────────────────────────────────────────────────────
function digits(jid) {
  return String(jid || "").split("@")[0].split(":")[0];
}

// يشيل التشكيل/التطويل/رمز الاختيار الإيموجي (FE0F) ويوحّد الألف/التاء/الياء
function norm(s) {
  return String(s || "")
    .replace(/[​-‏‪-‮⁦-⁩﻿️]/g, "")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toAscii(s) {
  return String(s || "").replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}

function lev(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[m][n];
}

// نقابة من نص: رقم (1-4) أو اسم أو شعار. null لو مو نقابة
function guildFromToken(tok) {
  const t = norm(toAscii(tok));
  if (!t) return null;
  for (const g of GUILDS) {
    if (t === String(g.n) || t === norm(g.name) || t === norm(g.emoji)) return g;
  }
  return null;
}

// كلمة تشبه اسم نقابة بس مكتوبة غلط (تسكي بدل تسوكي): تنفعنا نفرّق بين "لقب من كلمتين" و"خطأ بالنقابة"
function looksLikeGuildTypo(tok) {
  const t = norm(tok);
  if (t.length < 3) return false;
  return GUILDS.some((g) => lev(t, norm(g.name)) <= (norm(g.name).length >= 5 ? 2 : 1));
}

// يفصل نص التسجيل إلى لقب + نقابة. ok=false مع reason عند الخطأ
// أمثلة: "سيزار" → لقب بدون نقابة | "سيزار تايو" / "سيزار🎴" / "سيزار 2" → لقب + نقابة | "سيزار تسكي" → خطأ نقابة
function parseNickGuild(text) {
  let t = String(text || "").replace(/[​-‏‪-‮⁦-⁩﻿]/g, "").trim();
  if (!t) return { ok: false, reason: "empty" };
  // شعار ملصوق بآخر اللقب (سيزار🎴) أو بأوله: نفصله
  let guild = null;
  for (const g of GUILDS) {
    const e = g.emoji.replace(/️/g, "");
    const stripped = t.replace(/️/g, "");
    if (stripped.includes(e)) {
      guild = g;
      t = stripped.split(e).join(" ").replace(/\s+/g, " ").trim();
      break;
    }
  }
  let tokens = t.split(/\s+/).filter(Boolean);
  if (!guild && tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    const g = guildFromToken(last);
    if (g) {
      guild = g;
      tokens = tokens.slice(0, -1);
    } else if (looksLikeGuildTypo(last)) {
      return { ok: false, reason: "bad_guild" };
    }
  }
  const nick = tokens.join(" ").trim();
  if (!nick) return { ok: false, reason: "empty" };
  if (nick.length > MAX_NICK_LEN) return { ok: false, reason: "too_long" };
  if (/[@\n]/.test(nick)) return { ok: false, reason: "bad_chars" };
  return { ok: true, nick, guild };
}

// ── التخزين ───────────────────────────────────────────────────────
function col(name) {
  const db = getDb();
  return db ? db.collection(name) : null;
}
function fire(p) {
  if (p && p.catch) p.catch((e) => console.error("⚠️ ماتسوري/حفظ:", e && e.message));
}

// إعدادات عامة (رابط التسجيل، قوائم البكجات...) — وثيقة وحدة
let settings = {};
function getSetting(k) {
  return settings[k];
}
function setSetting(k, v) {
  settings[k] = v;
  const c = col("matsuri_settings");
  if (c) fire(c.updateOne({ _id: "main" }, { $set: { [k]: v } }, { upsert: true }));
}
// يدخل رابط ماتسوري بالسطر اللي بعد جملة "يرجى الدخول للرابط الادنى/الأدنى"
function applyLink(text) {
  const link = settings.link;
  if (!link || typeof text !== "string") return text;
  return text.replace(/^([^\n]*(?:يرجى\s+)?الدخول\s+(?:للرابط|(?:الى|إلى)\s+الرابط)\s+(?:الادنى|الأدنى)[^\n]*)(\n[ \t]*)?/gm, (m, line) => `${line}\n${link}\n`);
}

async function loadFromDb() {
  try {
    const reg = col("matsuri_registry");
    if (!reg) return;
    const st = await col("matsuri_settings").findOne({ _id: "main" });
    if (st) {
      settings = { ...st };
      delete settings._id;
    }
    for (const d of await reg.find({}).toArray()) {
      entries.set(d._id, { userId: d._id, nick: d.nick, guild: d.guild, contests: d.contests || 0, createdAt: d.createdAt || 0 });
    }
    for (const d of await col("matsuri_perms").find({}).toArray()) perms.add(d._id);
    const pk = await col("matsuri_cmdperms").findOne({ _id: "pkg" });
    if (pk && Array.isArray(pk.cmds)) {
      pkgCmds.clear();
      pk.cmds.forEach((k) => pkgCmds.add(k));
    }
    const sch = await col("matsuri_schedule").findOne({ _id: "main" });
    if (sch && sch.chatId) schedule = { chatId: sch.chatId, total: sch.total, pools: sch.pools, hour: sch.hour, minute: sch.minute || 0, lastAnnouncedStart: sch.lastAnnouncedStart || 0 };
    const now = Date.now();
    for (const d of await col("matsuri_pending").find({}).toArray()) {
      if (d.until > now) pending.set(d._id, { ids: d.ids || [], until: d.until });
      else fire(col("matsuri_pending").deleteOne({ _id: d._id }));
    }
    console.log(`✅ ماتسوري: ${entries.size} مسجل، ${perms.size} بصلاحيات${schedule ? "، مسابقة مجدولة" : ""}.`);
  } catch (e) {
    console.error("⚠️ ماتسوري: فشل تحميل البيانات (نكمل بالذاكرة):", e && e.message);
  }
}

// ── السجل ─────────────────────────────────────────────────────────
function get(userId) {
  return entries.get(userId) || null;
}
// بحث بالآيدي مع تجاهل اختلاف الصيغة (lid/رقم): مطابقة تامة أولاً ثم بالأرقام
function lookup(...ids) {
  const list = ids.flat().filter(Boolean);
  for (const id of list) if (entries.has(id)) return entries.get(id);
  const ds = new Set(list.map(digits));
  for (const e of entries.values()) if (ds.has(digits(e.userId))) return e;
  return null;
}
function display(e) {
  const g = GUILDS.find((x) => x.n === e.guild);
  return `${e.nick}${g ? g.emoji : ""}`;
}
function setEntry(userId, nick, guild) {
  const old = entries.get(userId);
  const e = { userId, nick, guild, contests: old ? old.contests : 0, createdAt: old ? old.createdAt : Date.now() };
  entries.set(userId, e);
  const c = col("matsuri_registry");
  if (c) fire(c.updateOne({ _id: userId }, { $set: { nick, guild, contests: e.contests, createdAt: e.createdAt } }, { upsert: true }));
  removePending(userId);
  return e;
}
function removeEntry(userId) {
  if (!entries.delete(userId)) return false;
  const c = col("matsuri_registry");
  if (c) fire(c.deleteOne({ _id: userId }));
  return true;
}
// قوائم النقابات (مرتبة بوقت التسجيل) → [[entries] × 4]
function byGuild() {
  const lists = GUILDS.map(() => []);
  for (const e of entries.values()) if (lists[e.guild - 1]) lists[e.guild - 1].push(e);
  for (const l of lists) l.sort((a, b) => a.createdAt - b.createdAt || (a.userId < b.userId ? -1 : 1));
  return lists;
}
function position(userId) {
  const e = entries.get(userId);
  if (!e) return null;
  return { guild: e.guild, num: byGuild()[e.guild - 1].findIndex((x) => x.userId === userId) + 1 };
}
// يلقى مسجل من نص: "بلاك🔆" | "1🔆" | "1 تسوكي" | "تسوكي 1" | "بلاك". يرجع { entry } أو { error: "none"|"ambiguous", matches }
function resolveQuery(query) {
  const raw = String(query || "").trim();
  if (!raw) return { error: "none" };
  const parsed = raw.replace(/️/g, "");
  let guild = null;
  let rest = parsed;
  for (const g of GUILDS) {
    const e = g.emoji.replace(/️/g, "");
    if (rest.includes(e)) {
      guild = g;
      rest = rest.split(e).join(" ");
      break;
    }
  }
  let tokens = rest.split(/\s+/).filter(Boolean);
  if (!guild) {
    for (let i = 0; i < tokens.length; i++) {
      const g = guildFromToken(tokens[i]);
      if (g && !/^\d+$/.test(toAscii(tokens[i]))) {
        guild = g;
        tokens.splice(i, 1);
        break;
      }
    }
  }
  const numTok = tokens.length === 1 ? toAscii(tokens[0]).match(/^\d+$/) : null;
  const lists = byGuild();
  if (numTok && guild) {
    const entry = lists[guild.n - 1][Number(numTok[0]) - 1];
    return entry ? { entry } : { error: "none" };
  }
  const nick = norm(tokens.join(" "));
  if (!nick) return { error: "none" };
  const matches = [...entries.values()].filter((e) => norm(e.nick) === nick && (!guild || e.guild === guild.n));
  if (matches.length === 1) return { entry: matches[0] };
  return { error: matches.length ? "ambiguous" : "none", matches };
}
function addContests(userIds) {
  const c = col("matsuri_registry");
  for (const id of userIds) {
    const e = entries.get(id);
    if (!e) continue;
    e.contests += 1;
    if (c) fire(c.updateOne({ _id: id }, { $set: { contests: e.contests } }));
  }
}

// ── غير المسجلين اللي شاركوا ─────────────────────────────────────
// participants: [{ userId, aliases: [أي آيدي/رقم للشخص] }]
function addPending(list) {
  const until = Date.now() + PENDING_TTL_MS;
  const c = col("matsuri_pending");
  for (const p of list) {
    const ids = [...new Set([p.userId, ...(p.aliases || [])].filter(Boolean).map(digits))];
    pending.set(p.userId, { ids, until });
    if (c) fire(c.updateOne({ _id: p.userId }, { $set: { ids, until } }, { upsert: true }));
  }
}
function removePending(userId) {
  if (!pending.delete(userId)) return;
  const c = col("matsuri_pending");
  if (c) fire(c.deleteOne({ _id: userId }));
}
function isPending(idLike) {
  const d = digits(idLike);
  const now = Date.now();
  for (const [k, v] of pending) {
    if (v.until <= now) {
      pending.delete(k);
      continue;
    }
    if (digits(k) === d || v.ids.includes(d)) return k;
  }
  return null;
}

// ── الصلاحيات ─────────────────────────────────────────────────────
function hasPackage(userId) {
  return perms.has(userId);
}
function grant(userId) {
  if (perms.has(userId)) return false;
  perms.add(userId);
  const c = col("matsuri_perms");
  if (c) fire(c.updateOne({ _id: userId }, { $set: { at: Date.now() } }, { upsert: true }));
  return true;
}
function revoke(userId) {
  if (!perms.delete(userId)) return false;
  const c = col("matsuri_perms");
  if (c) fire(c.deleteOne({ _id: userId }));
  return true;
}
// أوامر الحزمة
function hasPkgCmd(key) {
  return pkgCmds.has(key);
}
function listPkgCmds() {
  return [...pkgCmds];
}
function savePkg() {
  const c = col("matsuri_cmdperms");
  if (c) fire(c.updateOne({ _id: "pkg" }, { $set: { cmds: [...pkgCmds], at: Date.now() } }, { upsert: true }));
}
function addPkgCmd(key) {
  if (pkgCmds.has(key)) return false;
  pkgCmds.add(key);
  savePkg();
  return true;
}
function removePkgCmd(key) {
  if (!pkgCmds.delete(key)) return false;
  savePkg();
  return true;
}
function listGranted() {
  return [...perms];
}

// ── الجدولة ───────────────────────────────────────────────────────
function getSchedule() {
  return schedule;
}
function setSchedule(s) {
  schedule = s;
  const c = col("matsuri_schedule");
  if (c) fire(s ? c.updateOne({ _id: "main" }, { $set: s }, { upsert: true }) : c.deleteOne({ _id: "main" }));
}

module.exports = {
  GUILDS,
  MAX_NICK_LEN,
  digits,
  norm,
  toAscii,
  parseNickGuild,
  guildFromToken,
  loadFromDb,
  get,
  lookup,
  display,
  setEntry,
  removeEntry,
  byGuild,
  position,
  resolveQuery,
  addContests,
  addPending,
  removePending,
  isPending,
  hasPackage,
  grant,
  revoke,
  hasPkgCmd,
  listPkgCmds,
  addPkgCmd,
  removePkgCmd,
  DEFAULT_PKG,
  listGranted,
  getSchedule,
  getSetting,
  setSetting,
  applyLink,
  setSchedule,
  _entries: entries,
};
