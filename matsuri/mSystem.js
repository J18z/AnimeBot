// ═══════════════════════════════════════════════════════════════════
// نظام ماتسوري الإضافي 🧧 — موجّه الأوامر (مستقل عن بقية البوت)
//   • سجل الألقاب:  .لقب  .ازالة لقب  .عدل لقب  .المسجلين  .منشن_المسجلين
//   • صلاحيات ماتسوري (منفصلة عن .حزمة): .منح  .الغ  .صلاحيات
//   • أدوات قروب: .قفل قروب  .فتح قروب  .منشن  .رفع/.ترقية  .تنزيل  .حذف
//   • المسابقة المجدولة: .بدء مسابقة  .انهاء المسابقة
// يُستدعى مبكراً من index.js (قبل بوابات القفل والخاص) عشان:
//   - أوامر ماتسوري ما تتأثر بـ.قفل اوامر ولا يطلع تنبيه "مقفولة" هناك
//   - .لقب يشتغل بالخاص لأعضاء ماتسوري
// handle() يرجع true لو عالج الرسالة، false لو ما تخصه (تكمل لبقية البوت).
// ═══════════════════════════════════════════════════════════════════

const store = require("../src/dataStore");
const S = require("./mStore");
const C = require("./mContest");
const DATA = require("./matsuriData");

const FLOW_TTL_MS = 10 * 60 * 1000;
const FLOW_MAX = 300;
const MIN_TOTAL = 10;
const MAX_TOTAL = 500;
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

let ctx = { getSock: () => null, getGroupMeta: async () => null, activeContests: new Map() };
let scheduler = null;
const flows = new Map(); // `${chatId}|${senderId}` -> { type, step, at, ... }

// الأوامر القابلة للإضافة لحزمة ماتسوري (key → اسم العرض). الباقي (.منح .الغ .ضف امر .الغ امر .صلاحيات) للمالك والقائد دائماً
const DELEGABLE = {
  "قفل قروب": ".قفل قروب",
  "فتح قروب": ".فتح قروب",
  "منشن": ".منشن",
  "رفع": ".رفع / .ترقية",
  "تنزيل": ".تنزيل",
  "حذف": ".حذف",
  "المسجلين": ".المسجلين",
  "بدء مسابقة": ".بدء مسابقة",
  "انهاء المسابقة": ".انهاء المسابقة",
  "ازالة لقب": ".ازالة لقب",
  "عدل لقب": ".عدل لقب",
  "منشن_المسجلين": ".منشن_المسجلين",
  "اعلان": ".اعلان",
};
const OWNER_ONLY_CMDS = [".رابط_ماتسوري", ".منح", ".الغ", ".ضف امر", ".الغ امر", ".صلاحيات"];

// ── إعدادات ───────────────────────────────────────────────────────
function list(v) {
  return String(v || "").split(/[,،\s]+/).filter(Boolean);
}
function cfg() {
  return store.getConfig();
}
function contestChatIds() {
  return list(cfg().matsuriContestChatId);
}
function matsuriGroupIds() {
  const c = cfg();
  return new Set([...list(c.matsuriChatId), ...contestChatIds(), ...list(c.rouletteChatId), ...list(c.rasadChatId)]);
}
function isGroup(chatId) {
  return String(chatId || "").endsWith("@g.us");
}
function isMatsuriGroup(chatId) {
  return isGroup(chatId) && matsuriGroupIds().has(chatId);
}
function isContestChat(chatId) {
  return isGroup(chatId) && contestChatIds().includes(chatId);
}

function init(opts) {
  ctx = { ...ctx, ...opts };
}
function loadFromDb() {
  return S.loadFromDb();
}
function start() {
  if (!scheduler) scheduler = C.createScheduler({ getSock: () => ctx.getSock(), getGroupMeta: (j) => ctx.getGroupMeta(j), activeContests: ctx.activeContests });
  scheduler.start();
}
function getScheduler() {
  if (!scheduler) scheduler = C.createScheduler({ getSock: () => ctx.getSock(), getGroupMeta: (j) => ctx.getGroupMeta(j), activeContests: ctx.activeContests });
  return scheduler;
}

// ── هوية الأشخاص ──────────────────────────────────────────────────
function sameId(a, b) {
  const x = S.digits(a);
  const y = S.digits(b);
  return !!x && !!y && x === y;
}
function participantIds(p) {
  return [p && p.id, p && p.lid, p && p.phoneNumber].filter(Boolean);
}
function findParticipant(meta, idLike) {
  if (!meta || !Array.isArray(meta.participants)) return null;
  const ds = idLike instanceof Set ? idLike : new Set([S.digits(idLike)]);
  return meta.participants.find((p) => participantIds(p).some((v) => ds.has(S.digits(v)))) || null;
}
async function metaOf(chatId) {
  if (!isGroup(chatId)) return null;
  try {
    return (await ctx.getGroupMeta(chatId)) || null;
  } catch (e) {
    return null;
  }
}
// كل الأرقام اللي تعرّف المرسل (آيدي + lid + رقم الجوال لو معروف)
function aliasDigits(msg, senderId, meta) {
  const ds = new Set([senderId, msg && msg.key && msg.key.participantAlt, msg && msg.key && msg.key.remoteJidAlt, msg && msg.key && msg.key.senderPn].filter(Boolean).map(S.digits));
  const p = findParticipant(meta, ds);
  if (p) participantIds(p).forEach((v) => ds.add(S.digits(v)));
  return ds;
}
function isTopDigits(ds) {
  const c = cfg();
  return [...list(c.ownerId), ...list(c.matsuriOwnerId)].some((id) => ds.has(S.digits(id)));
}
function hasPackageDigits(ds) {
  return S.listGranted().some((id) => ds.has(S.digits(id)));
}
// يرجع { top, pkg, canon, ds }
async function who(chatId, msg, senderId) {
  const meta = await metaOf(chatId);
  const ds = aliasDigits(msg, senderId, meta);
  const p = findParticipant(meta, ds);
  return { meta, ds, top: isTopDigits(ds), pkg: hasPackageDigits(ds), canon: p ? p.id : senderId };
}

// الهدف: منشن أو ريبلاي (المنشن أولاً)
function getTarget(msg) {
  const m = (msg && msg.message) || {};
  const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m;
  const c = inner.extendedTextMessage?.contextInfo || inner.imageMessage?.contextInfo || inner.videoMessage?.contextInfo || null;
  if (!c) return null;
  if (c.mentionedJid && c.mentionedJid[0]) return c.mentionedJid[0];
  if (c.quotedMessage && c.participant) return c.participant;
  return null;
}
function canonTarget(meta, jid) {
  const p = findParticipant(meta, jid);
  return p ? p.id : jid;
}
function stripMentions(args) {
  return String(args || "").replace(/@\d{5,}/g, " ").replace(/\s+/g, " ").trim();
}

// ── إرسال ─────────────────────────────────────────────────────────
async function reply(sock, chatId, msg, text, mentions) {
  const content = mentions && mentions.length ? { text, mentions } : { text };
  return sock.sendMessage(chatId, content, msg ? { quoted: msg } : undefined);
}

// ── نصوص ثابتة ────────────────────────────────────────────────────
function guildListText() {
  return `> نـقـابـات هـيـكـاري\n${S.GUILDS.map((g) => `${g.n}. ${g.title}${g.emoji}`).join("\n")}`;
}
const YES = /^(نعم|ايوه|ايوا|ايو|اي|ايه|اجل|اكيد|تمام|متاكد|yes|y|اه|ok|اوكي)$/;
const NO = /^(لا|كلا|لاء|no|n|غلط)$/;
function yn(text) {
  const t = S.norm(S.toAscii(text)).replace(/[.!؟?]+$/g, "");
  if (YES.test(t)) return "yes";
  if (NO.test(t)) return "no";
  return null;
}

// ── flows ─────────────────────────────────────────────────────────
function flowKey(chatId, senderId) {
  return `${chatId}|${senderId}`;
}
// كل سطر بخط غليظ (واتساب ما يدعم الغليظ عبر أسطر): نتجاهل قوائم النقابات وأسطر الاقتباس
function bold(text) {
  return String(text)
    .split("\n")
    .map((l) => (!l.trim() || /^>/.test(l) || /^\d+\. /.test(l) ? l : `*${l.trim()}*`))
    .join("\n");
}
const rb = (sock, chatId, msg, text, mentions) => reply(sock, chatId, msg, bold(text), mentions);

const NICK_IDLE_MS = 60 * 1000; // دقيقة بدون رد = إلغاء طلب .لقب

function clearFlowTimer(f) {
  if (f && f.timer) {
    clearTimeout(f.timer);
    f.timer = null;
  }
}
function setFlow(chatId, senderId, f) {
  const k = flowKey(chatId, senderId);
  clearFlowTimer(flows.get(k));
  clearFlowTimer(f);
  const nf = { ...f, at: Date.now(), timer: null };
  flows.delete(k);
  flows.set(k, nf);
  while (flows.size > FLOW_MAX) {
    const oldest = flows.keys().next().value;
    clearFlowTimer(flows.get(oldest));
    flows.delete(oldest);
  }
  if (nf.type === "nick") {
    nf.timer = setTimeout(() => {
      if (flows.get(k) !== nf) return;
      flows.delete(k);
      nf.timer = null;
      const sock = ctx.getSock();
      if (!sock) return;
      const tag = isGroup(chatId) ? `@${S.digits(senderId)} ` : "";
      const text = `${tag ? `*${tag.trim()}*\n` : ""}*⏱️ انلغى الطلب لأنك ما كتبت خلال دقيقة.*\n*لازم تكتب الأمر .لقب مرة ثانية.*`;
      sock.sendMessage(chatId, isGroup(chatId) ? { text, mentions: [senderId] } : { text }).catch(() => {});
    }, NICK_IDLE_MS);
    if (nf.timer.unref) nf.timer.unref();
  }
}
function getFlow(chatId, senderId) {
  const k = flowKey(chatId, senderId);
  const f = flows.get(k);
  if (!f) return null;
  if (Date.now() - f.at > FLOW_TTL_MS) {
    flows.delete(k);
    return null;
  }
  return f;
}
function dropFlow(chatId, senderId) {
  const k = flowKey(chatId, senderId);
  clearFlowTimer(flows.get(k));
  flows.delete(k);
}

// ── التسجيل (.لقب) ────────────────────────────────────────────────
function whoText(f) {
  return f.other ? { your: "لقبه", you: "نقابته" } : { your: "لقبك", you: "نقابتك" };
}
const ASK_NICK = (f) => `الرجاء ادخال ${whoText(f).your} ونقابت${f.other ? "ه" : "ك"} في الرسالة القادمة.`;
const ASK_CONFIRM = (f) => {
  const g = f.guild ? S.GUILDS.find((x) => x.n === f.guild) : null;
  return f.other ? `هل انت متأكد ان ${f.nick}${g ? g.emoji : ""} هو لقبه؟ (نعم/لا)` : `هل ${g ? "انت " : ""}متأكد ان ${f.nick}${g ? g.emoji : ""} هو لقبك؟ (نعم/لا)`;
};

// يفصل لقب مكتوب بنقابة غلط ("سيزار تسكي") ويرجع نص اللقب بدون آخر كلمة
function badGuildText() {
  return `${guildListText()}\n\nالنقابة غير صحيحة، اكتب النقابة باسمها أو شعارها أو رقمها، وارجع ادخل اللقب والنقابة من جديد.`;
}

function duplicateNick(nick, guild, exceptUserId) {
  const n = S.norm(nick);
  for (const e of S._entries.values()) {
    if (e.userId !== exceptUserId && S.norm(e.nick) === n && (!guild || e.guild === guild)) return e;
  }
  return null;
}

async function finalizeNick(sock, chatId, msg, senderId, f) {
  const dup = duplicateNick(f.nick, f.guild, f.userId);
  if (dup && dup.guild === f.guild) {
    f.step = "nick";
    f.nick = null;
    f.guild = null;
    setFlow(chatId, senderId, f);
    await rb(sock, chatId, msg, `⚠️ اللقب ${S.display(dup)} مسجل مسبقاً بنفس النقابة.\n${ASK_NICK(f)}`);
    return;
  }
  const e = S.setEntry(f.userId, f.nick, f.guild);
  dropFlow(chatId, senderId);
  await rb(sock, chatId, msg, f.other ? `✅ تم تسجيل ${S.display(e)}` : `✅ تم تسجيل لقبك: ${S.display(e)}`);
}

async function processNickText(sock, chatId, msg, senderId, f, text) {
  const p = S.parseNickGuild(text);
  if (p.ok && /\p{Extended_Pictographic}/u.test(p.nick)) {
    // شعار غير شعارات النقابات الأربع
    p.ok = false;
    p.reason = "bad_guild";
  }
  if (!p.ok) {
    if (p.reason === "bad_guild") {
      await rb(sock, chatId, msg, badGuildText());
    } else if (p.reason === "too_long") {
      await rb(sock, chatId, msg, `⚠️ اللقب طويل (الحد ${S.MAX_NICK_LEN} حرف).\n${ASK_NICK(f)}`);
    } else {
      await rb(sock, chatId, msg, ASK_NICK(f));
    }
    return;
  }
  f.nick = p.nick;
  f.guild = p.guild ? p.guild.n : null;
  f.step = "confirm";
  setFlow(chatId, senderId, f);
  await rb(sock, chatId, msg, ASK_CONFIRM(f));
}

async function continueNickFlow(sock, chatId, msg, senderId, f, text) {
  if (f.step === "nick") return processNickText(sock, chatId, msg, senderId, f, text);
  if (f.step === "confirm") {
    const a = yn(text);
    if (a === "yes") {
      if (f.guild) return finalizeNick(sock, chatId, msg, senderId, f);
      f.step = "guild";
      setFlow(chatId, senderId, f);
      return rb(sock, chatId, msg, `${guildListText()}\n\nحدد ${whoText(f).you} (باسمها أو شعارها أو رقمها).`);
    }
    if (a === "no") {
      f.step = "nick";
      f.nick = null;
      f.guild = null;
      setFlow(chatId, senderId, f);
      return rb(sock, chatId, msg, ASK_NICK(f));
    }
    return rb(sock, chatId, msg, ASK_CONFIRM(f));
  }
  if (f.step === "guild") {
    const g = S.guildFromToken(text.replace(/[​-‏‪-‮⁦-⁩﻿]/g, "").trim());
    if (!g) return rb(sock, chatId, msg, `${guildListText()}\n\nما عرفت النقابة، اكتب اسمها أو شعارها أو رقمها.`);
    f.guild = g.n;
    return finalizeNick(sock, chatId, msg, senderId, f);
  }
}

// يعرف هوية الشخص بالخاص: مسجل أصلاً، أو بقائمة المنتظرين، أو عضو بقروب من قروبات ماتسوري
async function resolveDmUser(msg, senderId) {
  const aliases = [senderId, msg.key && msg.key.remoteJidAlt, msg.key && msg.key.participantAlt, msg.key && msg.key.senderPn].filter(Boolean);
  const ds = new Set(aliases.map(S.digits));
  for (const e of S._entries.values()) if (ds.has(S.digits(e.userId))) return e.userId;
  for (const a of aliases) {
    const k = S.isPending(a);
    if (k) return k;
  }
  for (const gid of matsuriGroupIds()) {
    if (!isGroup(gid)) continue;
    const p = findParticipant(await metaOf(gid), ds);
    if (p) return p.id;
  }
  return null;
}

async function cmdNick(sock, chatId, msg, senderId, args, w) {
  const groupChat = isGroup(chatId);
  let userId;
  let other = false;
  const target = groupChat ? getTarget(msg) : null;
  if (target && w.top) {
    userId = canonTarget(w.meta, target);
    other = !sameId(userId, w.canon);
  } else if (groupChat) {
    userId = w.canon;
  } else {
    userId = await resolveDmUser(msg, senderId);
    if (!userId) return false; // مو من أعضاء ماتسوري: نتجاهل بصمت (بوابة الخاص بالبوت تتولى)
  }
  const rest = stripMentions(args);
  const existing = S.lookup(userId);
  if (existing) {
    const where = S.position(existing.userId);
    const lines = other
      ? `لقبه: ${S.display(existing)}\nعدد مشاركاته في مسابقات البوت: ${existing.contests}`
      : `لقبك: ${S.display(existing)}\nعدد مشاركاتك في مسابقات البوت: ${existing.contests}`;
    await rb(sock, chatId, msg, lines);
    return true;
  }
  const f = { type: "nick", step: "nick", userId, other };
  setFlow(chatId, senderId, f);
  if (rest) await processNickText(sock, chatId, msg, senderId, f, rest);
  else await rb(sock, chatId, msg, ASK_NICK(f));
  return true;
}

// ── .ازالة لقب / .عدل لقب ─────────────────────────────────────────
async function findRegistered(sock, chatId, msg, args, w) {
  const target = getTarget(msg);
  if (target) {
    const e = S.lookup(canonTarget(w.meta, target));
    if (!e) {
      await reply(sock, chatId, msg, "⚠️ هذا الشخص غير مسجل.");
      return null;
    }
    return e;
  }
  const q = stripMentions(args);
  if (!q) {
    await reply(sock, chatId, msg, "حدد الشخص بمنشن أو ريبلاي، أو برقمه ونقابته (مثل 1🔆 أو 1 تسوكي)، أو بلقبه (مثل بلاك🔆).");
    return null;
  }
  const r = S.resolveQuery(q);
  if (r.entry) return r.entry;
  if (r.error === "ambiguous") {
    const names = r.matches.map((e) => {
      const pos = S.position(e.userId);
      return `- ${pos.num}${S.GUILDS[e.guild - 1].emoji} ${S.display(e)}`;
    });
    await reply(sock, chatId, msg, `⚠️ فيه أكثر من مسجل بهذا اللقب، حدده برقمه ونقابته:\n${names.join("\n")}`);
    return null;
  }
  await reply(sock, chatId, msg, "⚠️ ما لقيت مسجل بهذا الوصف.");
  return null;
}

async function cmdRemove(sock, chatId, msg, args, w) {
  const e = await findRegistered(sock, chatId, msg, args, w);
  if (!e) return;
  const label = S.display(e);
  S.removeEntry(e.userId);
  await reply(sock, chatId, msg, `✅ تم إزالة لقب ${label}`);
}

async function cmdEdit(sock, chatId, msg, senderId, args, w) {
  const e = await findRegistered(sock, chatId, msg, args, w);
  if (!e) return;
  setFlow(chatId, senderId, { type: "edit", userId: e.userId });
  await reply(sock, chatId, msg, `ادخل اللقب الجديد لـ ${S.display(e)} في الرسالة القادمة (تقدر تضيف النقابة معه لو تبي تغيّرها).`);
}

async function continueEditFlow(sock, chatId, msg, senderId, f, text) {
  const e = S.get(f.userId);
  if (!e) {
    dropFlow(chatId, senderId);
    return reply(sock, chatId, msg, "⚠️ هذا الشخص ما عاد مسجل.");
  }
  const p = S.parseNickGuild(text);
  if (p.ok && /\p{Extended_Pictographic}/u.test(p.nick)) {
    p.ok = false;
    p.reason = "bad_guild";
  }
  if (!p.ok) {
    if (p.reason === "bad_guild") return reply(sock, chatId, msg, badGuildText());
    if (p.reason === "too_long") return reply(sock, chatId, msg, `⚠️ اللقب طويل (الحد ${S.MAX_NICK_LEN} حرف)، ادخل لقب أقصر.`);
    return reply(sock, chatId, msg, "ادخل اللقب الجديد.");
  }
  const guild = p.guild ? p.guild.n : e.guild;
  const dup = duplicateNick(p.nick, guild, e.userId);
  if (dup && dup.guild === guild) return reply(sock, chatId, msg, `⚠️ اللقب ${S.display(dup)} مسجل مسبقاً بنفس النقابة، ادخل لقب ثاني.`);
  const before = S.display(e);
  const ne = S.setEntry(e.userId, p.nick, guild);
  dropFlow(chatId, senderId);
  await reply(sock, chatId, msg, `✅ تم تعديل لقب ${before} إلى ${S.display(ne)}`);
}

// ── .المسجلين / .منشن_المسجلين ───────────────────────────────────
const LIST_HEADER = "˼\u200F⬩بــوت ريــم • レム┊🤖˹\n❆ـ⋅ ┈── ─━ •⊰✣⊱ • ━─ ──┈ ⋅ـ❆\n◞الـمـسـجـلـيـن╎˼\u200F✒️˹⤹◜\nـ»» ┉ ٠ ┈─ • ⊰ 倖 ⊱ • ─┈ ٠ ┉ ««ـ";
const LIST_FOOTER = "ـ»»——⍟——««ـ\n✪ مـرحـبـاً، مـعـكـم بـوت ريـم للاسـتـمـارات الـخـاصـة بــ وزارة ماتسوري🧧\n❆ـ⋅ ┈── ─━ •⊰✣⊱ • ━─ ──┈ ⋅ـ❆\n~✷┇تــ✍︎ــوقــيــ؏↯:~\n◜Hikari✨Matsuri •🧧◝";
const LIST_LIMIT = 3500;

function buildRegisteredMessages(withMentions) {
  const lists = S.byGuild();
  const sections = S.GUILDS.map((g, i) => {
    const mentions = [];
    const rows = lists[i].map((e, k) => {
      let line = `${k + 1}. ${S.display(e)}`;
      if (withMentions) {
        line += ` @${S.digits(e.userId)}`;
        mentions.push(e.userId);
      }
      return line;
    });
    return { text: `> *✠ ${g.title} • ${g.emoji}◜*\n${rows.length ? rows.join("\n") : "- ما فيه مسجلين"}`, mentions };
  });
  // نقسم على رسائل لو طالت (مثلاً مع المنشن)
  const chunks = [];
  let cur = { text: "", mentions: [] };
  for (const sec of sections) {
    const parts = [];
    // قسم ضخم لحاله: نقسمه بالأسطر
    if (sec.text.length > LIST_LIMIT) {
      const lines = sec.text.split("\n");
      let buf = "";
      let bufM = [];
      for (const ln of lines) {
        if ((buf + "\n" + ln).length > LIST_LIMIT && buf) {
          parts.push({ text: buf, mentions: bufM });
          buf = "";
          bufM = [];
        }
        buf = buf ? buf + "\n" + ln : ln;
        const m = ln.match(/@(\d+)/);
        if (m) {
          const e = sec.mentions.find((id) => S.digits(id) === m[1]);
          if (e) bufM.push(e);
        }
      }
      if (buf) parts.push({ text: buf, mentions: bufM });
    } else parts.push(sec);
    for (const part of parts) {
      if (cur.text && (cur.text + "\n\n" + part.text).length > LIST_LIMIT) {
        chunks.push(cur);
        cur = { text: "", mentions: [] };
      }
      cur.text = cur.text ? cur.text + "\n\n" + part.text : part.text;
      cur.mentions.push(...part.mentions);
    }
  }
  if (cur.text) chunks.push(cur);
  return chunks.map((c, i) => ({
    text: `${i === 0 ? LIST_HEADER + "\n" : ""}${c.text}\n${i === chunks.length - 1 ? LIST_FOOTER : "..."}`,
    mentions: c.mentions,
  }));
}

async function cmdRegistered(sock, chatId, msg, withMentions) {
  const msgs = buildRegisteredMessages(withMentions);
  for (let i = 0; i < msgs.length; i++) {
    await reply(sock, chatId, i === 0 ? msg : null, msgs[i].text, msgs[i].mentions);
  }
}

// ── الصلاحيات ─────────────────────────────────────────────────────
async function cmdPermsList(sock, chatId, msg) {
  const granted = S.listGranted();
  const inPkg = S.listPkgCmds();
  const li = (a) => (a.length ? a.map((x) => `- ${x}`).join("\n") : "- ما فيه");
  const pkgNames = Object.keys(DELEGABLE).filter((k) => inPkg.includes(k)).map((k) => DELEGABLE[k]);
  const lockedNames = [...Object.keys(DELEGABLE).filter((k) => !inPkg.includes(k)).map((k) => DELEGABLE[k]), ...OWNER_ONLY_CMDS];
  const text =
    `> 📦 حـزمـة ماتـسـوري:\n${li(pkgNames)}\n\n` +
    `> 🔒 لـلـمـالـك والـقـائـد فـقـط:\n${li(lockedNames)}\n\n` +
    `> 🔖 الـمـمـنـوح لـهـم:\n${li(granted.map((id) => `${(S.lookup(id) && S.display(S.lookup(id))) || "بدون لقب"} ~ @${S.digits(id)}`))}`;
  await reply(sock, chatId, msg, text, granted);
}

// أسماء يكتبها المستخدم → مفتاح الأمر
const CMD_ALIASES = { "ترقية": "رفع", "انهاء مسابقة": "انهاء المسابقة", "المسجلين_منشن": "منشن_المسجلين" };
function resolveCmdKey(typed) {
  const n = S.norm(typed).replace(/^\./, "").trim();
  const al = Object.keys(CMD_ALIASES).find((k) => S.norm(k) === n);
  if (al) return CMD_ALIASES[al];
  return Object.keys(DELEGABLE).find((k) => S.norm(k) === n) || null;
}

// .ضف امر <الأمر> / .الغ امر <الأمر>: يعدّل حزمة ماتسوري (اللي يستخدمها الممنوحون بـ.منح)
async function cmdPkgCmd(sock, chatId, msg, args, revoke) {
  const typed = String(args || "").replace(/^\s*امر\s*/, "").trim();
  const list = Object.keys(DELEGABLE).map((k) => DELEGABLE[k]).join("، ");
  if (!typed) {
    await reply(sock, chatId, msg, `${revoke ? ".الغ امر" : ".ضف امر"} <الأمر>\nالأوامر المتاحة: ${list}`);
    return;
  }
  const key = resolveCmdKey(typed);
  if (!key) {
    await reply(sock, chatId, msg, `⚠️ ما عرفت الأمر "${typed}".\nالأوامر المتاحة: ${list}`);
    return;
  }
  const ok = revoke ? S.removePkgCmd(key) : S.addPkgCmd(key);
  const name = DELEGABLE[key];
  await reply(sock, chatId, msg, revoke ? (ok ? `✅ تم إزالة ${name} من حزمة ماتسوري.` : `${name} مو بالحزمة أصلاً.`) : ok ? `✅ تم إضافة ${name} لحزمة ماتسوري.` : `${name} موجود بالحزمة أصلاً.`);
}

async function cmdGrant(sock, chatId, msg, w, revoke) {
  const t = getTarget(msg);
  if (!t) {
    await reply(sock, chatId, msg, `حدد الشخص بمنشن أو ريبلاي: ${revoke ? ".الغ" : ".منح"} @منشن`);
    return false;
  }
  const id = canonTarget(w.meta, t);
  const ok = revoke ? S.revoke(id) : S.grant(id);
  const mention = `@${S.digits(id)}`;
  let text;
  if (revoke) text = ok ? `✅ تم سحب صلاحيات ماتسوري من ${mention}` : `${mention} ما عنده صلاحيات أصلاً.`;
  else text = ok ? `✅ تم منح ${mention} حزمة ماتسوري (شوف .صلاحيات)` : `${mention} عنده الحزمة أصلاً.`;
  await reply(sock, chatId, msg, text, [id]);
  return true;
}

// ── أدوات القروب ──────────────────────────────────────────────────
async function adminAction(sock, chatId, msg, fn, okText) {
  try {
    await fn();
    if (okText) await reply(sock, chatId, msg, okText);
  } catch (e) {
    console.error("⚠️ ماتسوري/إجراء قروب:", e && e.message);
    await reply(sock, chatId, msg, "⚠️ ما قدرت أنفذ الأمر. تأكد إن البوت مشرف بالقروب.");
  }
}

async function cmdMentionAll(sock, chatId, msg, args, meta) {
  const head = args || "📢";
  const blocks = C.mentionAllBlocks(meta ? meta.participants : [], head);
  for (let i = 0; i < blocks.length; i++) {
    await sock.sendMessage(chatId, { text: blocks[i].text, mentions: blocks[i].mentions }, i === 0 ? { quoted: msg } : undefined);
  }
}

async function cmdDelete(sock, chatId, msg) {
  const m = msg.message || {};
  const c = (m.extendedTextMessage && m.extendedTextMessage.contextInfo) || null;
  if (!c || !c.stanzaId) return false;
  const bot = sock.user || {};
  const participant = c.participant;
  const fromMe = !!participant && (sameId(participant, bot.id) || sameId(participant, bot.lid));
  try {
    await sock.sendMessage(chatId, { delete: { remoteJid: chatId, fromMe, id: c.stanzaId, participant } });
    await sock.sendMessage(chatId, { delete: msg.key });
  } catch (e) {
    console.error("⚠️ ماتسوري/حذف:", e && e.message);
    await reply(sock, chatId, msg, "⚠️ ما قدرت أحذف الرسالة. تأكد إن البوت مشرف بالقروب.");
  }
  return true;
}

// ── المسابقة المجدولة ─────────────────────────────────────────────
function fmtSaudiDate(t) {
  const d = new Date(t + RIYADH_OFFSET_MS);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${C.fmtTime(d.getUTCHours(), d.getUTCMinutes())}`;
}

async function cmdStartContest(sock, chatId, msg, senderId, args) {
  if (!contestChatIds().length) {
    await reply(sock, chatId, msg, "⚠️ ما تم تحديد قروب المسابقات (متغير MATSURI_CONTEST_CHAT_ID).");
    return;
  }
  if (!isContestChat(chatId)) {
    await reply(sock, chatId, msg, "⚠️ هذا الأمر يشتغل بقروب المسابقات فقط.");
    return;
  }
  const a = S.toAscii(args).trim();
  let total = 80;
  if (a) {
    if (!/^\d+$/.test(a)) {
      await reply(sock, chatId, msg, "اكتب الأمر هكذا: .بدء مسابقة 80");
      return;
    }
    total = Number(a);
  }
  if (total < MIN_TOTAL || total > MAX_TOTAL) {
    await reply(sock, chatId, msg, `⚠️ عدد الأسئلة لازم يكون بين ${MIN_TOTAL} و${MAX_TOTAL}.`);
    return;
  }
  if (getScheduler().isRunning()) {
    await reply(sock, chatId, msg, "⚠️ فيه مسابقة شغالة حالياً. أنهها بـ .انهاء المسابقة أول.");
    return;
  }
  setFlow(chatId, senderId, { type: "contest", step: "pools", total });
  await reply(sock, chatId, msg, `الفقرات المتاحة لمسابقة ${total}:\n${C.sectionList()}\n\nاكتب الفقرات بالاسم أو بالرقم (تقدر تختار أكثر من وحدة، والترتيب اللي تكتبه هو ترتيب الفقرات).`);
}

async function continueContestFlow(sock, chatId, msg, senderId, f, text) {
  if (f.step === "pools") {
    const pools = C.parseSections(text);
    if (!pools.length) {
      await reply(sock, chatId, msg, `ما فهمت الفقرات. اختر من القائمة (بالاسم أو الرقم):\n${C.sectionList()}`);
      return;
    }
    f.pools = pools;
    f.step = "hour";
    setFlow(chatId, senderId, f);
    await reply(sock, chatId, msg, "الرجاء حدد الوقت بتوقيت السعودية لبدء المسابقة");
    return;
  }
  if (f.step === "hour") {
    const t = C.parseHour(text);
    if (!t) {
      await reply(sock, chatId, msg, "ما فهمت الوقت. اكتب الساعة مثل: 9 أو 21 أو 9:30 (بتوقيت السعودية).");
      return;
    }
    dropFlow(chatId, senderId);
    const first = getScheduler().schedule(chatId, f.total, f.pools, t.hour, t.minute);
    await reply(
      sock,
      chatId,
      msg,
      `✅ تم جدولة مسابقة ${f.total} (${f.pools.join("، ")})\n🕘 كل يوم الساعة ${C.fmtTime(t.hour, t.minute)} بتوقيت السعودية\n📅 أقرب مسابقة: ${fmtSaudiDate(first)}\n📢 الإعلان قبلها بـ5 دقائق.\nلإيقافها: .انهاء المسابقة`
    );
  }
}

async function cmdEndContest(sock, chatId, msg) {
  const r = await getScheduler().cancel();
  if (!r.cancelled && !r.stopped) {
    await reply(sock, chatId, msg, "ما فيه مسابقة مجدولة ولا شغالة.");
    return;
  }
  const parts = [];
  if (r.cancelled) parts.push("تم إلغاء الجدولة اليومية");
  if (r.stopped) parts.push("وإيقاف المسابقة الجارية (القروب ما انقفل، استخدم .قفل قروب لو تبي)");
  await reply(sock, chatId, msg, `⏹️ ${parts.join(" ")}.`);
}

// ── .اعلان (ريبلاي على رسالة النتائج) ─────────────────────────────
// قروب إعلانات/أركان: البوت ما يرد فيه إلا على أوامر المالك الإدارية (القفل يطبقه index.js)
function isAnnounceChat(chatId) {
  if (!chatId || !announceChatIds().includes(chatId)) return false;
  return !isMatsuriGroup(chatId);
}
function announceChatIds() {
  return [...new Set(list(cfg().matsuriAnnounceChatIds))];
}
function quotedContent(msg) {
  const m = (msg && msg.message) || {};
  const inner = m.ephemeralMessage?.message || m;
  const c = inner.extendedTextMessage?.contextInfo;
  const q = c && c.quotedMessage;
  if (!q) return null;
  const qi = q.ephemeralMessage?.message || q;
  const text = qi.conversation || qi.extendedTextMessage?.text || qi.imageMessage?.caption || qi.videoMessage?.caption || "";
  const mentions = (qi.extendedTextMessage?.contextInfo?.mentionedJid || qi.imageMessage?.contextInfo?.mentionedJid || []).filter(Boolean);
  return text ? { text, mentions } : null;
}
async function cmdAnnounce(sock, chatId, msg) {
  const q = quotedContent(msg);
  if (!q) {
    await reply(sock, chatId, msg, "رد على الرسالة اللي تبي تعلنها بـ .اعلان");
    return;
  }
  const targets = announceChatIds();
  if (!targets.length) {
    await reply(sock, chatId, msg, "⚠️ ما تم تحديد قروبات الإعلانات (متغير MATSURI_ANNOUNCE_CHAT_IDS).");
    return;
  }
  let ok = 0;
  let fail = 0;
  for (const t of targets) {
    try {
      await sock.sendMessage(t, q.mentions.length ? { text: q.text, mentions: q.mentions } : { text: q.text });
      ok++;
    } catch (e) {
      fail++;
      console.error("⚠️ ماتسوري/اعلان:", t, e && e.message);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  await reply(sock, chatId, msg, `✅ تم الإعلان في ${ok} قروب${fail ? `\n⚠️ فشل في ${fail} (تأكد إن البوت داخلها)` : ""}`);
}

// ── قسم البوت والمساعدة (.06) ─────────────────────────────────────
const HELP06 = `˼\u200F⬩بــوت ريــم • レム┊🤖˹
❆ـ⋅ ┈── ─━ •⊰✣⊱ • ━─ ──┈ ⋅ـ❆
     ◞قـسـم الـمـسـاعـدة╎˼\u200F🎐˹⤹◜
        ◝الاوامــر⇆📍◟
ـ»» ┉ ٠ ┈─ • ⊰ 倖 ⊱ • ─┈ ٠ ┉ ««ـ

> *✠ لـلـجـمـيـع • 👥◜*
⪦ .لـقـب [اللقب والنقابة] :
> تسجيل لقبك ونقابتك (بالقروب أو بالخاص)، وإذا كنت مسجل يعرض لقبك وعدد مشاركاتك بمسابقات البوت.
⪦ .مـسـاعـدة :
> قائمة مختصرة بأوامر ماتسوري.

> *✠ لـحـامـلـي الـصـلاحـيـات • 🔖◜*
⪦ .الـمـسـجـلـيـن :
> قائمة المسجلين مرتبة بالنقابات.
⪦ .قـفـل قـروب / .فـتـح قـروب :
> قفل القروب على الأعضاء أو فتحه.
⪦ .مـنـشـن [نص] :
> منشن لجميع أعضاء القروب.
⪦ .رفـع / .تـرقـيـة @ :
> ترقية عضو إلى مشرف بالقروب.
⪦ .تـنـزيـل @ :
> تنزيل مشرف إلى عضو عادي.
⪦ .حـذف :
> بالرد على رسالة: يحذفها ويحذف أمر الحذف.

> *✠ لـلـمـالـك والـقـائـد • 👑◜*
⪦ .بـدء مـسـابـقـة [العدد] :
> جدولة مسابقة يومية بقروب المسابقات (الفقرات والوقت بتوقيت السعودية).
⪦ .انـهـاء الـمـسـابـقـة :
> إلغاء الجدولة اليومية وإيقاف المسابقة الجارية.
⪦ .ازالـة لـقـب / .عـدل لـقـب :
> بالمنشن أو الرد أو بالرقم والنقابة (1🔆) أو باللقب (بلاك🔆).
⪦ .مـنـشـن_الـمـسـجـلـيـن :
> نفس قائمة المسجلين مع منشن.
⪦ .مـنـح @ / .الـغ @ / .صـلاحـيـات :
> منح حزمة ماتسوري أو سحبها أو عرضها.
⪦ .ضـف امـر <الأمر> / .الـغ امـر <الأمر> :
> إضافة أمر لحزمة الممنوحين أو إزالته منها (مثل حذف أو بدء مسابقة).
⪦ .اعـلان :
> بالرد على رسالة (مثل النتائج): ينشرها بقروبات الإعلانات.
 ـ»»——⍟——««ـ
✪ مـرحـبـاً، مـعـكـم بـوت ريـم للاسـتـمـارات الـخـاصـة بــ وزارة ماتسوري🧧
❆ـ⋅ ┈── ─━ •⊰✣⊱ • ━─ ──┈ ⋅ـ❆
~✷┇تــ✍︎ــوقــيــ؏↯:~
◜Hikari✨Matsuri •🧧◝`;
DATA.menus["06"] = HELP06;

// ── مساعدة ────────────────────────────────────────────────────────
function helpText() {
  return (
    "> 🧧 أوامر ماتسوري\n" +
    "- .لقب : تسجيل لقبك ونقابتك (أو عرض لقبك)\n" +
    "- .المسجلين : قائمة المسجلين\n" +
    "- .صلاحيات : الحزمة (للمالك والقائد)\n\n" +
    "> للصلاحيات:\n" +
    "- .قفل قروب / .فتح قروب / .منشن [نص]\n" +
    "- .رفع / .ترقية / .تنزيل (منشن أو ريبلاي)\n" +
    "- .حذف (ريبلاي على رسالة)\n\n" +
    "> للمالك والقائد:\n" +
    "- .بدء مسابقة [العدد] / .انهاء المسابقة\n" +
    "- .ازالة لقب / .عدل لقب\n" +
    "- .منح / .الغ (منشن أو ريبلاي)\n" +
    "- .ضف امر <الأمر> / .الغ امر <الأمر> (تعديل حزمة الممنوحين)\n" +
    "- .اعلان (ريبلاي على رسالة النتائج: ينشرها بقروبات الإعلانات)\n" +
    "- .منشن_المسجلين"
  );
}

// ── الموجّه الرئيسي ───────────────────────────────────────────────
function parseCmd(text) {
  const m = String(text || "").trim().match(/^\.(\S+(?:\s+(?:لقب|(?:ال)?مسابقة|قروب))?)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { cmd: m[1].replace(/\s+/g, " "), args: (m[2] || "").trim() };
}

async function handle(sock, msg, text, chatId, senderId) {
  try {
    return await handleInner(sock, msg, text, chatId, senderId);
  } catch (e) {
    console.error("⚠️ ماتسوري: خطأ بمعالجة رسالة:", e);
    return false;
  }
}

async function handleInner(sock, msg, text, chatId, senderId) {
  const group = isGroup(chatId);
  if (group && !isMatsuriGroup(chatId)) return false;
  if (!text) return false;
  const t = S.toAscii(text).trim();

  // 1) خطوة جارية بمحادثة سابقة
  const f = getFlow(chatId, senderId);
  if (f) {
    if (t.startsWith(".")) {
      // أي أمر جديد يلغي الخطوة الجارية (.الغاء يلغيها بدون رد زائد)
      dropFlow(chatId, senderId);
      if (t === ".الغاء") {
        await reply(sock, chatId, msg, "✅ تم الإلغاء.");
        return true;
      }
    } else {
      // أثناء مسابقة شغالة بالقروب: ما نبلع رسائل اللاعبين (ممكن تكون إجابات)
      const running = ctx.activeContests.get(chatId);
      if (running && running.active && f.type !== "contest") {
        dropFlow(chatId, senderId);
        return false;
      }
      if (f.type === "nick") {
        await continueNickFlow(sock, chatId, msg, senderId, f, text);
        const nf = getFlow(chatId, senderId);
        if (nf) setFlow(chatId, senderId, nf); // نشاط جديد: نجدد مهلة الدقيقة
      }
      else if (f.type === "edit") await continueEditFlow(sock, chatId, msg, senderId, f, text);
      else if (f.type === "contest") await continueContestFlow(sock, chatId, msg, senderId, f, text);
      return true;
    }
  }

  if (!t.startsWith(".")) return false;
  const pc = parseCmd(t);
  if (!pc) return false;
  const { cmd, args } = pc;

  // الخاص: .لقب فقط (والمالك يمر لبقية البوت عشان ما نغطي أمر .لقب العام عنده)
  if (!group) {
    if (cmd !== "لقب") return false;
    const w0 = { top: false, pkg: false, canon: senderId, meta: null, ds: new Set([S.digits(senderId)]) };
    if (isTopDigits(w0.ds)) return false;
    return !!(await cmdNick(sock, chatId, msg, senderId, args, w0));
  }

  const w = await who(chatId, msg, senderId);
  // locked = للمالك والقائد فقط. غير كذا: حامل الحزمة يستخدم الأمر لو هو داخل الحزمة الحالية (key)
  const allowed = (locked, key) => w.top || (!locked && w.pkg && !!key && S.hasPkgCmd(key));

  switch (cmd) {
    case "لقب":
      await cmdNick(sock, chatId, msg, senderId, args, w);
      return true;
    case "ازالة لقب":
      if (!allowed(false, "ازالة لقب")) return false;
      await cmdRemove(sock, chatId, msg, args, w);
      return true;
    case "عدل لقب":
      if (!allowed(false, "عدل لقب")) return false;
      await cmdEdit(sock, chatId, msg, senderId, args, w);
      return true;
    case "المسجلين":
      if (!allowed(false, "المسجلين")) return false;
      await cmdRegistered(sock, chatId, msg, false);
      return true;
    case "منشن_المسجلين":
      if (!allowed(false, "منشن_المسجلين")) return false;
      await cmdRegistered(sock, chatId, msg, true);
      return true;
    case "منح":
      if (!allowed(true)) return false;
      await cmdGrant(sock, chatId, msg, w, false);
      return true;
    case "ضف":
      // .ضف امر <أمر> : يضيف الأمر لحزمة ماتسوري. أي .ضف ثاني (صور) يمر للبوت العام
      if (!/^امر(\s|$)/.test(S.norm(args)) || !allowed(true)) return false;
      await cmdPkgCmd(sock, chatId, msg, args, false);
      return true;
    case "الغ":
      // .الغ امر <أمر> : يشيل الأمر من الحزمة. .الغ بدون هدف هو أمر الفنش العام: نمرره
      if (/^امر(\s|$)/.test(S.norm(args))) {
        if (!allowed(true)) return false;
        await cmdPkgCmd(sock, chatId, msg, args, true);
        return true;
      }
      if (!allowed(true) || !getTarget(msg)) return false;
      await cmdGrant(sock, chatId, msg, w, true);
      return true;
    case "رابط_ماتسوري": {
      if (!allowed(true)) return false;
      const l = args.trim();
      if (!l) {
        const cur = S.getSetting("link");
        await reply(sock, chatId, msg, cur ? `🔗 الرابط الحالي:\n${cur}\n\nللتغيير: .رابط_ماتسوري <الرابط> (أو .رابط_ماتسوري حذف)` : "اكتب: .رابط_ماتسوري <الرابط>");
        return true;
      }
      if (/^(حذف|مسح|ازاله|ازالة)$/.test(S.norm(l))) {
        S.setSetting("link", "");
        await reply(sock, chatId, msg, "✅ تم حذف الرابط.");
        return true;
      }
      S.setSetting("link", l);
      await reply(sock, chatId, msg, "✅ تم حفظ رابط ماتسوري، يدخل تلقائياً بالاستمارات تحت (يرجى الدخول للرابط الادنى).");
      return true;
    }
    case "صلاحيات":
      if (!allowed(true)) return false;
      await cmdPermsList(sock, chatId, msg);
      return true;
    case "حذف":
      if (!allowed(false, "حذف") || args) return false;
      return !!(await cmdDelete(sock, chatId, msg));
    case "منشن":
      if (!allowed(false, "منشن")) return false;
      await cmdMentionAll(sock, chatId, msg, args, w.meta);
      return true;
    case "رفع":
    case "ترقية": {
      if (!allowed(false, "رفع")) return false;
      if (/^(ادمن|اداري|شات)/.test(S.norm(args))) return false; // أمر ترقية الادمنية العام
      const tg = getTarget(msg);
      if (!tg) {
        await reply(sock, chatId, msg, `حدد الشخص بمنشن أو ريبلاي: .${cmd} @منشن`);
        return true;
      }
      const id = canonTarget(w.meta, tg);
      await adminAction(sock, chatId, msg, () => sock.groupParticipantsUpdate(chatId, [id], "promote"), `✅ تمت ترقية @${S.digits(id)} مشرف بالقروب.`).catch(() => {});
      return true;
    }
    case "تنزيل": {
      if (!allowed(false, "تنزيل")) return false;
      const tg = getTarget(msg);
      if (!tg) {
        await reply(sock, chatId, msg, "حدد الشخص بمنشن أو ريبلاي: .تنزيل @منشن");
        return true;
      }
      const id = canonTarget(w.meta, tg);
      await adminAction(sock, chatId, msg, () => sock.groupParticipantsUpdate(chatId, [id], "demote"), `✅ تم تنزيل @${S.digits(id)} من الاشراف.`);
      return true;
    }
    case "قفل قروب":
      if (!allowed(false, "قفل قروب")) return false;
      await adminAction(sock, chatId, msg, () => sock.groupSettingUpdate(chatId, "announcement"), "🔒 تم قفل القروب.");
      return true;
    case "فتح قروب":
      if (!allowed(false, "فتح قروب")) return false;
      await adminAction(sock, chatId, msg, () => sock.groupSettingUpdate(chatId, "not_announcement"), "🔓 تم فتح القروب.");
      return true;
    case "بدء مسابقة":
      if (!allowed(false, "بدء مسابقة")) return false;
      await cmdStartContest(sock, chatId, msg, senderId, args);
      return true;
    case "انهاء المسابقة":
    case "انهاء مسابقة":
      if (!allowed(false, "انهاء المسابقة")) return false;
      await cmdEndContest(sock, chatId, msg);
      return true;
    case "اعلان":
      if (!allowed(false, "اعلان") || args) return false;
      await cmdAnnounce(sock, chatId, msg);
      return true;
    case "06":
      await reply(sock, chatId, msg, HELP06);
      return true;
    case "مساعدة":
      await reply(sock, chatId, msg, helpText());
      return true;
    default:
      return false;
  }
}

module.exports = {
  handle,
  init,
  start,
  loadFromDb,
  isMatsuriGroup,
  isAnnounceChat,
  isContestChat,
  getScheduler,
  _buildRegisteredMessages: buildRegisteredMessages,
  _flows: flows,
};
