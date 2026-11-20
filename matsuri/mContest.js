// ═══════════════════════════════════════════════════════════════════
// مسابقة ماتسوري المجدولة 🧧
//   • MatsuriContest: مسابقة بعدد أسئلة ثابت (80 افتراضياً) فقراتها تتبدل كل 10% من العدد
//     بالترتيب اللي اختاره المالك، بتوقيتات ثابتة (شوف الأرقام تحت)، وسكب تلقائي بعد 6 ثواني.
//     تعيد استخدام محرك Contest نفسه (نفس مطابقة الإجابات وإرسال الصور وقفل التكرار)،
//     بس بدون تسجيل البوت العام ولا لوحة .توب/.سجل (وضع matsuriMode).
//   • المجدول اليومي: قبل الموعد بـ5 دقائق يعلن الاستمارة ويمنشن الكل، وبالموعد يفتح القروب
//     ويمنشن الكل مع *بنبدأ*، ثم يقدّم، وبنهايتها يقفل القروب ويعلن الحسبة.
// ═══════════════════════════════════════════════════════════════════

const { Contest } = require("../src/game");
const DATA = require("./matsuriData");
const S = require("./mStore");

// ⏱️ التوقيتات (بالملي ثانية)
const SECTION_TO_QUESTION_MS = 2000; // بين اسم الفقرة والسؤال
const AFTER_POINT_TEXT_MS = 3000; // بعد النقطة → السؤال الجاي (فقرات كتابية)
const AFTER_POINT_IMAGE_MS = 1500; // بعد النقطة → السؤال الجاي (صور)
const AUTO_SKIP_MS = 6000; // ما أحد عرف السؤال: سكب تلقائي
const MAX_CONSEC_SKIPS = 10; // حماية: 10 أسئلة ورا بعض بدون أي إجابة = إنهاء (ما نكمل 80 سؤال لقروب فاضي)
const ANNOUNCE_BEFORE_MS = 5 * 60 * 1000; // الإعلان قبل الموعد بخمس دقائق
const START_DELAY_MS = 3000; // بعد "بنبدأ" وقبل أول فقرة
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000; // توقيت السعودية UTC+3 (بدون توقيت صيفي)
const MENTION_CHUNK = 200;

// أسماء الفقرات المتاحة (بالترتيب المعروض) → نوع الفقرة داخل المحرك
const SECTIONS = [
  { n: 1, name: "كتابة", pool: "writing", aliases: ["كتابة", "كتابه"] },
  { n: 2, name: "صور", pool: "images", aliases: ["صور", "صوره", "صورة"] },
  { n: 3, name: "تفكيك", pool: "dismantle", aliases: ["تفكيك"] },
  { n: 4, name: "ترتيب", pool: "scramble", aliases: ["ترتيب"] },
  { n: 5, name: "عكس", pool: "reverse", aliases: ["عكس"] },
  { n: 6, name: "تعداد", pool: "counts", aliases: ["تعداد"] },
  { n: 7, name: "اسئلة", pool: "questions", aliases: ["اسئلة", "اسئله", "أسئلة", "سؤال", "اسئلة"] },
];

function sectionList() {
  return SECTIONS.map((s) => `${s.n}. ${s.name}`).join("\n");
}

// يفهم اختيار الفقرات: أرقام أو أسماء (مفصولة بمسافة/فاصلة). يرجع أسماء مرتبة بترتيب الكتابة، بدون تكرار
function parseSections(text) {
  const toks = S.toAscii(String(text || ""))
    .split(/[\s,،+\-/و]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const out = [];
  for (const t of toks) {
    const nt = S.norm(t);
    const hit = SECTIONS.find((s) => String(s.n) === nt || s.aliases.some((a) => S.norm(a) === nt));
    if (hit && !out.includes(hit.name)) out.push(hit.name);
  }
  return out;
}

// ══════════════ المسابقة ══════════════
class MatsuriContest extends Contest {
  // opts: { total, pools: [اسم فقرة...], onFinish(contest, reason) }
  constructor(chatId, sock, opts) {
    super(chatId, sock, "general", Infinity, { matsuriMode: true, roundsTarget: opts.total });
    this.total = opts.total;
    this.poolNames = opts.pools.length ? opts.pools : SECTIONS.map((s) => s.name);
    this.sliceSize = Math.max(1, Math.round(this.total * 0.1)); // كل 10% من العدد = فقرة
    this.onFinish = opts.onFinish || (async () => {});
    this._lastLabel = null;
    this._consecSkips = 0;
    this._skipTimer = null;
    this._ended = false;
  }

  // الفقرة اللي يقع فيها السؤال رقم idx (يبدأ من 0)
  sectionAt(idx) {
    const slice = Math.floor(idx / this.sliceSize);
    const name = this.poolNames[slice % this.poolNames.length];
    const sec = SECTIONS.find((s) => s.name === name) || SECTIONS[0];
    // الكتابة: اسم واحد، وبنص المسابقة تتحول لـ"كتابة اسمين"
    const two = sec.pool === "writing" && idx >= Math.floor(this.total / 2);
    return { pool: sec.pool, label: two ? "كتابة اسمين" : sec.name, words: sec.pool === "writing" ? (two ? 2 : 1) : null };
  }

  // 🚀 جلب مسبق لصورة السؤال القادم (نفس فكرة المحرك الأصلي، بس بترتيب الشرائح)
  _planNextRound() {
    if (!this.active) return;
    try {
      const idx = this.roundsCompleted + 1;
      if (idx >= this.total) return;
      const nextType = this.sectionAt(idx).pool;
      this._plannedPoolType = nextType;
      if (nextType !== "images") return;
      const item = this.pickItem("images");
      if (!item) return;
      this._plannedImageItem = item;
      const promise = this._prepareImage(item.file);
      promise.catch(() => {});
      this._prefetched = { file: item.file, promise };
    } catch (e) {
      this._plannedPoolType = null;
      this._plannedImageItem = null;
      this._prefetched = null;
    }
  }

  async nextRound() {
    if (!this.active || this.paused) return;
    const idx = this.roundsCompleted;
    if (idx >= this.total) {
      await this.endContest("done");
      return;
    }
    const sec = this.sectionAt(idx);
    this.fixedWordCount = sec.words; // الكتابة: 1 أو 2 (غيرها يتجاهلها)
    if (sec.label !== this._lastLabel) {
      this._lastLabel = sec.label;
      // الصور المجهّزة مسبقاً للفقرة القديمة ما تنفع لو تغيّرت الفقرة (نفك قفلها ونختار من جديد)
      if (this._plannedPoolType && this._plannedPoolType !== sec.pool) this._clearPlanned();
      try {
        await this.sendChat(`*${sec.label}*`);
      } catch (e) {
        console.error("⚠️ ماتسوري: فشل إرسال اسم الفقرة (نكمل):", e && e.message);
      }
      await new Promise((r) => setTimeout(r, SECTION_TO_QUESTION_MS));
      if (!this.active || this.paused) return;
    }
    this._plannedPoolType = sec.pool;
    await super.nextRound();
    if (this.currentRound && !this.currentRound.finished) this.currentRound.points = 1; // نقطة وحدة لكل سؤال مهما كانت نقاطه بالبنك
  }

  // بعد إجابة صحيحة (النقطة انرسلت بـcompleteRound): نجدول السؤال الجاي
  async afterRoundWin() {
    this._consecSkips = 0;
    if (this.roundsCompleted >= this.total) {
      await this.endContest("done");
      return;
    }
    this._scheduleAfter();
  }

  _scheduleAfter(context = "الجولة القادمة") {
    const next = this.sectionAt(this.roundsCompleted);
    this.scheduleNextRound(next.pool === "images" ? AFTER_POINT_IMAGE_MS : AFTER_POINT_TEXT_MS, context);
  }

  // النقطة دايماً 1 (مهما كانت نقاط السؤال بالبنك)
  addPoints(userId) {
    return super.addPoints(userId, 1);
  }

  // مؤقت السكب التلقائي: يبدأ مع كل سؤال، ويتجدد مع أي تقدم جزئي (التعداد مثلاً)
  _armIdleTimer() {
    if (this.paused || !this.active) return;
    if (this._skipTimer) clearTimeout(this._skipTimer);
    this._skipTimer = setTimeout(() => {
      this._skipTimer = null;
      this._autoSkip().catch((e) => console.error("⚠️ ماتسوري: خطأ بالسكب التلقائي:", e));
    }, AUTO_SKIP_MS);
    if (this._skipTimer.unref) this._skipTimer.unref();
  }

  clearRoundWatchdog() {
    super.clearRoundWatchdog();
    if (this._skipTimer) {
      clearTimeout(this._skipTimer);
      this._skipTimer = null;
    }
  }

  async _autoSkip() {
    const round = this.currentRound;
    if (!this.active || !round || round.finished) return;
    round.finished = true;
    this.roundsCompleted += 1;
    this.clearRoundWatchdog();
    this._consecSkips += 1;
    try {
      await this.sendChat(`*سكب*\nالإجابة: ${round.label}`);
    } catch (e) {
      console.error("⚠️ ماتسوري: فشل إرسال رسالة السكب (نكمل):", e && e.message);
    }
    if (!this.active) return;
    if (this.roundsCompleted >= this.total) {
      await this.endContest("done");
      return;
    }
    if (this._consecSkips >= MAX_CONSEC_SKIPS) {
      await this.endContest("idle");
      return;
    }
    this._scheduleAfter("الجولة القادمة بعد السكب");
  }

  // .سكب اليدوي (لو أحد المخولين استخدمه): يكمل بنفس توقيتات ماتسوري
  async skipRound(msg) {
    if (!this.active || !this.currentRound || this.currentRound.finished) return false;
    await this._autoSkip();
    return true;
  }

  // نهاية المسابقة: نوقف كل المؤقتات ثم نسلّم للمجدول (يقفل القروب ويعلن الحسبة)
  async endContest(reason = "done") {
    if (this._ended) return;
    this._ended = true;
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    if (this.nextRoundTimer) {
      clearTimeout(this.nextRoundTimer);
      this.nextRoundTimer = null;
    }
    this.clearRoundWatchdog();
    this._clearPlanned();
    if (this.currentRound) this.currentRound.finished = true; // أي إجابة متأخرة تنتجاهل
    this.active = false;
    try {
      await this.onFinish(this, reason);
    } catch (e) {
      console.error("⚠️ ماتسوري: خطأ عند إنهاء المسابقة:", e);
    }
  }
}

// ══════════════ إعلان النتائج ══════════════
const ORDINALS = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس"];

// يبني نص النتائج من قالب الاستمارة (singleResult). المراكز: نفس النقاط = نفس المركز (أسماء مفصولة بـ-)،
// والمركز التالي يكمل بعده. المقدم والمنظم فاضيين. null لو ما فيه قالب لهذا العدد
function buildResultsText(total, ranking, lookup) {
  const entry = DATA.contests[String(total)];
  if (!entry || !entry.singleResult) return null;
  const groups = [];
  for (const [userId, pts] of ranking) {
    let g = groups[groups.length - 1];
    if (!g || g.pts !== pts) groups.push((g = { pts, ids: [] }));
    g.ids.push(userId);
  }
  const mentions = [];
  const nameOf = (id) => {
    const e = lookup(id);
    if (e) return S.display(e);
    mentions.push(id);
    return "@" + S.digits(id);
  };
  const lines = entry.singleResult.split("\n").map((line) => {
    const t = line.trim();
    if (/^(الـمـقـدم|المُـنظـم)/.test(t)) return line.replace(/❲\s*❳/, "❲ - ❳");
    for (let i = 0; i < ORDINALS.length; i++) {
      if (t.startsWith("المركز " + ORDINALS[i])) {
        const g = groups[i];
        return g ? line.replace(/❲\s*❳/, `❲${g.ids.map(nameOf).join("-")}❳`) : line;
      }
    }
    return line;
  });
  return { text: lines.join("\n"), mentions };
}

function cfgList(v) {
  return String(v || "").split(/[,،\s]+/).filter(Boolean);
}

// ══════════════ المجدول اليومي ══════════════
// أدوات وقت (توقيت السعودية ثابت UTC+3)
function nextOccurrence(hour, minute, from = Date.now()) {
  const riyadh = new Date(from + RIYADH_OFFSET_MS);
  let t = Date.UTC(riyadh.getUTCFullYear(), riyadh.getUTCMonth(), riyadh.getUTCDate(), hour, minute, 0, 0) - RIYADH_OFFSET_MS;
  if (t <= from) t += 24 * 60 * 60 * 1000;
  return t;
}

function fmtTime(hour, minute) {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${minute ? ":" + String(minute).padStart(2, "0") : ""} ${hour < 12 ? "صباحاً" : "مساءً"}`;
}

// يفهم الساعة: 9 | 21 | 9:30 | 9م | 9 مساء | 9 ص | 9 صباحا (بدون أي علامة = نظام 24 ساعة)
function parseHour(text) {
  const t = S.toAscii(String(text || "")).trim().replace(/[:٫.]/g, ":");
  const m = t.match(/^(\d{1,2})(?::(\d{1,2}))?\s*(ص|صباحا|صباحاً|ظهرا|ظهراً|م|مساء|مساءً|مساءا|ليلا|ليلاً)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const suffix = m[3] || "";
  if (min > 59) return null;
  if (/^(م|مساء|مساءً|مساءا|ليلا|ليلاً)$/.test(suffix)) {
    if (h < 1 || h > 12) return null;
    if (h < 12) h += 12;
  } else if (/^(ص|صباحا|صباحاً)$/.test(suffix)) {
    if (h < 1 || h > 12) return null;
    if (h === 12) h = 0;
  } else if (/^(ظهرا|ظهراً)$/.test(suffix)) {
    if (h < 1 || h > 12) return null;
    if (h < 11) h += 12;
  } else if (h > 23) return null;
  return { hour: h, minute: min };
}

function mentionAllBlocks(participants, headText) {
  const list = (participants || []).filter((p) => p && p.id);
  const blocks = [];
  for (let i = 0; i < list.length; i += MENTION_CHUNK) {
    const chunk = list.slice(i, i + MENTION_CHUNK);
    const text = (i === 0 ? headText + "\n\n" : "") + chunk.map((p) => "@" + S.digits(p.id)).join(" ");
    blocks.push({ text, mentions: chunk.map((p) => p.id) });
  }
  if (!blocks.length) blocks.push({ text: headText, mentions: [] });
  return blocks;
}

// ctx: { getSock(), getGroupMeta(jid), activeContests, isGroupAdminBot? }
function createScheduler(ctx) {
  let announceTimer = null;
  let startTimer = null;
  let running = null; // المسابقة الجارية الحالية

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function sendMentionAll(sock, chatId, headText) {
    const meta = await ctx.getGroupMeta(chatId);
    const blocks = mentionAllBlocks(meta ? meta.participants : [], headText);
    for (const b of blocks) {
      await sock.sendMessage(chatId, { text: b.text, mentions: b.mentions });
    }
  }

  async function setGroupOpen(sock, chatId, open) {
    try {
      await sock.groupSettingUpdate(chatId, open ? "not_announcement" : "announcement");
      return true;
    } catch (e) {
      console.error(`⚠️ ماتسوري: فشل ${open ? "فتح" : "قفل"} القروب:`, e && e.message);
      try {
        await sock.sendMessage(chatId, { text: `⚠️ ما قدرت ${open ? "أفتح" : "أقفل"} القروب. تأكد إن البوت مشرف بالقروب.` });
      } catch (_) {
        /* تجاهل */
      }
      return false;
    }
  }

  function clearTimers() {
    if (announceTimer) clearTimeout(announceTimer);
    if (startTimer) clearTimeout(startTimer);
    announceTimer = startTimer = null;
  }

  // يجدول التشغيل القادم (يومياً)
  function arm() {
    clearTimers();
    const sch = S.getSchedule();
    if (!sch) return;
    const startAt = nextOccurrence(sch.hour, sch.minute || 0);
    const announceAt = startAt - ANNOUNCE_BEFORE_MS;
    const now = Date.now();
    // لو إعلان هذا الموعد انرسل قبل (إعادة تشغيل بنص الفترة) ما نعيده
    const needAnnounce = sch.lastAnnouncedStart !== startAt;
    if (needAnnounce) {
      announceTimer = setTimeout(() => announce(startAt).catch((e) => console.error("⚠️ ماتسوري/إعلان:", e)), Math.max(0, announceAt - now));
      if (announceTimer.unref) announceTimer.unref();
    }
    startTimer = setTimeout(() => begin(startAt).catch((e) => console.error("⚠️ ماتسوري/بدء:", e)), Math.max(0, startAt - now));
    if (startTimer.unref) startTimer.unref();
  }

  async function announce(startAt) {
    const sch = S.getSchedule();
    const sock = ctx.getSock();
    if (!sch || !sock) return;
    S.setSchedule({ ...sch, lastAnnouncedStart: startAt });
    const entry = DATA.contests[String(sch.total)];
    const form = entry && entry.form ? entry.form : `📮 إعـلان مُـسـابـقـة 📮\nعدد الفقرات: ${sch.total}\nالمقدم: -- `;
    await sock.sendMessage(sch.chatId, { text: form });
    await sendMentionAll(sock, sch.chatId, "📢 *تذكير*\nالمسابقة بعد 5 دقائق");
  }

  async function begin(startAt) {
    const sch = S.getSchedule();
    const sock = ctx.getSock();
    if (!sch || !sock) {
      arm();
      return;
    }
    const existing = ctx.activeContests.get(sch.chatId);
    if (existing && existing.active) {
      console.log("ℹ️ ماتسوري: فيه مسابقة شغالة بالقروب، تخطّينا مسابقة اليوم.");
      arm();
      return;
    }
    await setGroupOpen(sock, sch.chatId, true);
    await sendMentionAll(sock, sch.chatId, "*بنبدأ*");
    await sleep(START_DELAY_MS);
    const cur = S.getSchedule();
    if (!cur) return; // انلغت (.انهاء المسابقة) أثناء الانتظار
    startContest(cur.chatId, cur.total, cur.pools);
    // موعد باجر
    arm();
  }

  function startContest(chatId, total, pools) {
    const sock = ctx.getSock();
    const c = new MatsuriContest(chatId, sock, { total, pools, onFinish: finish });
    running = c;
    ctx.activeContests.set(chatId, c);
    c.nextRound().catch((e) => console.error("⚠️ ماتسوري: خطأ ببدء المسابقة:", e));
    return c;
  }

  // يستدعيها endContest: يقفل القروب ثم يعلن الحسبة
  async function finish(contest, reason) {
    const sock = ctx.getSock();
    const chatId = contest.chatId;
    if (running === contest) running = null;
    if (ctx.activeContests.get(chatId) === contest) ctx.activeContests.delete(chatId);
    if (!sock) return;
    if (reason === "cancel") return; // إيقاف يدوي (.انهاء المسابقة): بدون قفل ولا حسبة، الأمر نفسه يرد

    if (reason === "idle") {
      try {
        await sock.sendMessage(chatId, { text: "⏹️ انتهت المسابقة لأنه ما أحد جاوب على آخر 10 أسئلة." });
      } catch (_) {
        /* تجاهل */
      }
    }
    await setGroupOpen(sock, chatId, false);
    await sleep(1000);

    const ranking = [...contest.scores.entries()].sort((a, b) => b[1] - a[1]);
    if (ranking.length === 0) {
      await sock.sendMessage(chatId, { text: "> حـسـبـة الـمـسـابـقـة\nانتهت المسابقة بدون نقاط 😅" });
      return;
    }
    const lines = [];
    const mentions = [];
    const unregistered = [];
    for (const [userId, points] of ranking) {
      const e = S.lookup(userId);
      if (e) lines.push(`- ${S.display(e)} ${points}`);
      else {
        lines.push(`- @${S.digits(userId)} ${points}`);
        mentions.push(userId);
        unregistered.push(userId);
      }
    }
    await sock.sendMessage(chatId, { text: `> حـسـبـة الـمـسـابـقـة\n${lines.join("\n")}`, mentions });

    // مشاركات المسجلين +1، وغير المسجلين يقدرون يسجلون بالخاص حتى لو طلعوا من القروب
    S.addContests(ranking.map(([id]) => (S.lookup(id) || {}).userId).filter(Boolean));
    if (unregistered.length) {
      let meta = null;
      try {
        meta = await ctx.getGroupMeta(chatId);
      } catch (_) {
        /* تجاهل */
      }
      const parts = (meta && meta.participants) || [];
      S.addPending(
        unregistered.map((userId) => {
          const p = parts.find((x) => [x.id, x.lid, x.phoneNumber].some((v) => v && S.digits(v) === S.digits(userId)));
          return { userId, aliases: p ? [p.id, p.lid, p.phoneNumber] : [] };
        })
      );
      await sleep(1000);
      await sock.sendMessage(chatId, {
        text: `${unregistered.map((u) => "@" + S.digits(u)).join(" ")}\n\nالرجاء تسجيل لقبك ونقابتك في خاص البوت بالأمر .لقب`,
        mentions: unregistered,
      });
    }

    // 🏆 إعلان النتائج: قروب المسابقة ← قروب الرصد (ويرصد تلقائياً) ← قروب ماتسوري شات
    try {
      const res = buildResultsText(contest.total, ranking, S.lookup);
      if (res) {
        await sleep(1500);
        const cfg = require("../src/dataStore").getConfig();
        // فيه منشن = شخص ما سجل لقبه: الرصد ما يقدر يرصده، فما نرسل لقروب الرصد ونبلّغ ماتسوري شات
        const skipRasad = res.mentions.length > 0;
        const targets = [...new Set([chatId, ...(skipRasad ? [] : cfgList(cfg.rasadChatId)), ...cfgList(cfg.matsuriChatId)])];
        const rasadIds = new Set(skipRasad ? [] : cfgList(cfg.rasadChatId));
        for (const target of targets) {
          try {
            const sent = await sock.sendMessage(target, res.mentions.length ? { text: res.text, mentions: res.mentions } : { text: res.text });
            if (rasadIds.has(target)) await require("./rasad").recordText(res.text, sent && sent.key && sent.key.id);
          } catch (e) {
            console.error("⚠️ ماتسوري: فشل إرسال النتائج إلى", target, e && e.message);
          }
          await sleep(800);
        }
        if (skipRasad && cfgList(cfg.rasadChatId).length) {
          const warn = `⚠️ ما قدرت أرسل النتائج لقروب الرصد لأن فيه شخص ما سجّل لقبه: ${res.mentions.map((u) => "@" + S.digits(u)).join(" ")}\nيسجل لقبه بـ .لقب ثم تنرصد النتائج يدوياً.`;
          for (const target of cfgList(cfg.matsuriChatId)) {
            try {
              await sock.sendMessage(target, { text: warn, mentions: res.mentions });
            } catch (e) {
              console.error("⚠️ ماتسوري: فشل إرسال تنبيه الرصد:", e && e.message);
            }
          }
        }
      }
    } catch (e) {
      console.error("⚠️ ماتسوري: خطأ بإعلان النتائج:", e);
    }
  }

  // ── واجهة للأوامر ──
  return {
    start() {
      arm();
    },
    schedule(chatId, total, pools, hour, minute) {
      S.setSchedule({ chatId, total, pools, hour, minute, lastAnnouncedStart: 0 });
      arm();
      return nextOccurrence(hour, minute);
    },
    // يلغي الجدولة ويوقف الجارية. يرجع { cancelled, stopped }
    async cancel() {
      const had = !!S.getSchedule();
      S.setSchedule(null);
      clearTimers();
      const c = running;
      let stopped = false;
      if (c && c.active) {
        stopped = true;
        await c.endContest("cancel");
      }
      return { cancelled: had, stopped };
    },
    isRunning() {
      return !!(running && running.active);
    },
    getRunning() {
      return running;
    },
    startContestNow: startContest, // للاختبارات
    _sectionsInfo: { SECTIONS },
  };
}

module.exports = {
  MatsuriContest,
  createScheduler,
  SECTIONS,
  sectionList,
  parseSections,
  parseHour,
  nextOccurrence,
  fmtTime,
  mentionAllBlocks,
  buildResultsText,
  AUTO_SKIP_MS,
};
