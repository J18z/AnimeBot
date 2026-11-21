// قسم الروليت — أوامر خاصة بصاحب البوت + صاحب وزارة ماتسوري بس
// (داخل نفس شات ماتسوري المحدد أصلاً بـ matsuriChatId)
//
// ➕ للتعديل: أسعار/حدود/قوائم الأوامر كلها بملف rouletteData.js
// هذا الملف فيه المنطق فقط (الشراء، الحساب، تخزين قائمة المشتريات)
//
// التخزين: نفس نمط leaderboard.js بالضبط — حالة بالذاكرة للسرعة،
// وتُحفظ بالخلفية بقاعدة بيانات MongoDB (نفس اتصال البوت الأصلي،
// بمجموعة (collection) منفصلة اسمها "matsuri_roulette")

const { getDb } = require("../src/db");
const store = require("../src/dataStore");
const RD = require("./rouletteData");
const { extractEmoji } = require("./rasadParser");
const { GUILDS } = require("./mStore");

// حالة بالذاكرة: purchases: [{label, money, stars}], counts: {senderId: totalRolls}
// items: [{label, cmds:[...]}] = الأوامر اللي جت كل شخص (قائمة .المشتريات)
let state = { purchases: [], counts: {}, items: [] };
// انتظار اختيار رقم لـ"نسخ الروليت عادي": `${chatId}|${senderId}` → حالة
const pendingCopies = new Map();
const PENDING_TTL_MS = 60 * 60 * 1000;

async function loadFromDb() {
  const db = getDb();
  if (!db) return; // بدون قاعدة بيانات، يشتغل بالذاكرة بس (يُفقد عند إعادة التشغيل)
  try {
    const doc = await db.collection("matsuri_roulette").findOne({ _id: "state" });
    if (doc) state = { purchases: doc.purchases || [], counts: doc.counts || {}, items: doc.items || [] };
  } catch (err) {
    console.error("خطأ تحميل بيانات الروليت:", err.message);
  }
}

async function persist() {
  const db = getDb();
  if (!db) return;
  try {
    await db
      .collection("matsuri_roulette")
      .updateOne({ _id: "state" }, { $set: { purchases: state.purchases, counts: state.counts, items: state.items } }, { upsert: true });
  } catch (err) {
    console.error("خطأ حفظ بيانات الروليت:", err.message);
  }
}

function isRouletteAdmin(senderId) {
  const cfg = store.getConfig();
  const rawId = String(senderId || "").split("@")[0];
  const owner = String(cfg.ownerId || "").split("@")[0];
  const matsuriOwner = String(cfg.matsuriOwnerId || "").split("@")[0];
  if (!rawId) return false;
  return (owner && rawId === owner) || (matsuriOwner && rawId === matsuriOwner);
}

function formatMoney(n) {
  if (n <= 0) return null;
  return n % 1000 === 0 ? `${n / 1000}k` : `${n}`;
}

function pickRandom(list, excludeSet) {
  const pool = list.filter((c) => !excludeSet.has(c));
  const source = pool.length ? pool : list; // لو خلصت الخيارات نسمح بالتكرار
  const chosen = source[Math.floor(Math.random() * source.length)];
  excludeSet.add(chosen);
  return chosen;
}

// يحلل "<رقم> <عادي|ذهبي>(_نجوم)?" بشكل متكرر من بداية النص
function parseParts(text) {
  let rest = text.trim();
  const tokenRe = /^(\d+)\s+(عادي|ذهبي)(_نجوم)?\s*/;
  const parts = [];
  while (true) {
    const m = rest.match(tokenRe);
    if (!m) break;
    parts.push({
      count: parseInt(m[1], 10),
      tier: m[2],
      currency: m[3] ? "نجوم" : "فلوس",
    });
    rest = rest.slice(m[0].length);
  }
  return { parts, label: rest.trim() };
}

const COPY_CMD = "نسخ الروليت عادي";
const FREE_TWO_CMD = "لفتين عادية مجانا";
const goldLine = (cmd) => `*⬩⧼⬦ ${cmd} ⧽⬩*`;
const goldStruck = (cmd) => `~*⬩⧼⬦ ${cmd} ⧽⬩*~`;
const normalLine = (cmd) => `*⛋ ${cmd}*`;

// يبني أسطر الاستمارة: كل عنصر {kind:"line"|"copy", text}. أوامر "لفتين مجانا" تتحول لأمرين عاديين عشوائيين
// (السطر الأصلي ينشطب)، و"نسخ الروليت عادي" ينتظر رقم الأمر من الأدمن. recorded = الأوامر الفعلية للمشتريات
function buildLines(parts) {
  const usedGold = new Set();
  const usedNormal = new Set();
  const lines = [];
  const recorded = [];
  let totalMoney = 0;
  let totalStars = 0;
  for (const p of parts) {
    const list = p.tier === "ذهبي" ? RD.goldCommands : RD.normalCommands;
    const usedSet = p.tier === "ذهبي" ? usedGold : usedNormal;
    for (let i = 0; i < p.count; i++) {
      const cmd = pickRandom(list, usedSet);
      if (p.tier !== "ذهبي") {
        lines.push({ kind: "line", text: normalLine(cmd) });
        recorded.push(cmd);
      } else if (cmd === FREE_TWO_CMD) {
        lines.push({ kind: "line", text: goldStruck(cmd) });
        for (let k = 0; k < 2; k++) {
          const c2 = pickRandom(RD.normalCommands, usedNormal);
          lines.push({ kind: "line", text: normalLine(c2) });
          recorded.push(c2);
        }
      } else if (cmd === COPY_CMD) {
        lines.push({ kind: "copy", cmd });
      } else {
        lines.push({ kind: "line", text: goldLine(cmd) });
        recorded.push(cmd);
      }
    }
    const unitPrice = RD.PRICES[p.tier][p.currency];
    if (p.currency === "نجوم") totalStars += unitPrice * p.count;
    else totalMoney += unitPrice * p.count;
  }
  return { lines, recorded, totalMoney, totalStars };
}

// copyChoices: أوامر مختارة لكل "نسخ" بالترتيب (اللي ما انختار بعد يطلع بدون شطب)
function renderForm(label, lines, copyChoices) {
  let ci = 0;
  const out = [];
  for (const l of lines) {
    if (l.kind === "copy") {
      const chosen = copyChoices[ci++];
      if (chosen) {
        out.push(goldStruck(l.cmd));
        out.push(normalLine(chosen));
      } else out.push(goldLine(l.cmd));
    } else out.push(l.text);
  }
  return RD.purchaseTemplate.replace("{label}", label).replace("{lines}", out.join("\n"));
}

function numberedNormalList() {
  return RD.normalCommands.map((c, i) => `${i + 1}. ${c}`).join("\n");
}

function addItems(label, cmds) {
  if (!cmds.length) return;
  let it = state.items.find((x) => x.label === label);
  if (!it) {
    it = { label, cmds: [] };
    state.items.push(it);
  }
  it.cmds.push(...cmds);
}

// يبني رسالة الشراء ويحسب التكلفة ويسحب الأوامر عشوائياً. يرجع أيضاً بيانات النسخ المعلّق
function buildPurchase(parts, label) {
  const { lines, recorded, totalMoney, totalStars } = buildLines(parts);
  const copies = lines.filter((l) => l.kind === "copy").length;
  return { text: renderForm(label, lines, []), totalMoney, totalStars, lines, recorded, copies };
}

// يسحب أوامر عشوائية بس (بدون حساب تكلفة ولا قالب) — يُستخدم بأمر
// ".روليت" لتغيير/إضافة لفة يدوياً بدون ما يتحسب شراء أو يأثر بالحدود
function drawOnly(parts) {
  const usedGold = new Set();
  const usedNormal = new Set();
  const lines = [];
  for (const p of parts) {
    const list = p.tier === "ذهبي" ? RD.goldCommands : RD.normalCommands;
    const usedSet = p.tier === "ذهبي" ? usedGold : usedNormal;
    for (let i = 0; i < p.count; i++) {
      const cmd = pickRandom(list, usedSet);
      lines.push(p.tier === "ذهبي" ? `*⬩⧼⬦ ${cmd} ⧽⬩*` : `*⛋ ${cmd}*`);
    }
  }
  return lines.join("\n");
}

function addPurchaseRecord(state, label, money, stars) {
  let entry = state.purchases.find((p) => p.label === label);
  if (!entry) {
    entry = { label, money: 0, stars: 0 };
    state.purchases.push(entry);
  }
  entry.money += money;
  entry.stars += stars;
}

// المصروفات: الفلوس/النجوم المصروفة (القائمة القديمة للمشتريات)
function renderExpensesList(state) {
  if (!state.purchases.length) {
    return RD.expensesListTemplate.replace("{entries}", "⪦ لا يوجد مصروفات حالياً");
  }
  const entries = state.purchases
    .map((p) => {
      const bits = [];
      const starsTxt = formatMoney(p.stars);
      const moneyTxt = formatMoney(p.money);
      if (starsTxt) bits.push(`⭐${starsTxt}-`);
      if (moneyTxt) bits.push(`💰${moneyTxt}-`);
      return `⪦ ${p.label} ${bits.join(" | ")}`;
    })
    .join("\n");
  return RD.expensesListTemplate.replace("{entries}", entries);
}

const stripVs = (x) => String(x || "").replace(/\uFE0F/g, "");

// المشتريات: الأوامر اللي جت كل شخص مرتبين بالنقابات
function renderPurchasesList(state) {
  const items = (state.items || []).filter((x) => x.cmds && x.cmds.length);
  if (!items.length) return RD.purchasesListTemplate.replace("{entries}", "⪦ لا يوجد مشتريات حالياً");
  const blocks = [];
  const used = new Set();
  const block = (title, list) => {
    if (!list.length) return;
    blocks.push(`${title}\n${list.map((it) => `⪦ ${it.label}\n${it.cmds.join("\n")}`).join("\n\n")}`);
  };
  for (const g of GUILDS) {
    const list = items.filter((it) => stripVs(extractEmoji(it.label)) === stripVs(g.emoji));
    list.forEach((it) => used.add(it));
    block(`> *✠ ${g.title} • ${g.emoji}◜*`, list);
  }
  block("> *✠ غير مصنّف◜*", items.filter((it) => !used.has(it)));
  return RD.purchasesListTemplate.replace("{entries}", blocks.join("\n\n"));
}

function totalRolls(parts) {
  return parts.reduce((sum, p) => sum + p.count, 0);
}

async function reply(sock, chatId, msg, text) {
  await sock.sendMessage(chatId, { text }, { quoted: msg });
}

// يرسل استمارة الشراء، ولو فيها "نسخ الروليت عادي" يرسل قائمة الأوامر العادية مرقمة وينتظر رقم الأدمن
async function sendPurchase(sock, chatId, msg, pk, label, built) {
  pendingCopies.delete(pk);
  await reply(sock, chatId, msg, built.text);
  if (built.copies > 0) {
    pendingCopies.set(pk, { label, lines: built.lines, copies: built.copies, chosen: [], at: Date.now() });
    await reply(sock, chatId, msg, `${numberedNormalList()}\n\n*اكتب رقم الأمر اللي اختاره${built.copies > 1 ? ` (${built.copies} اختيارات، واحد واحد)` : ""}*`);
  }
}

// نقطة الدخول — ترجع true لو تكفلت بالرسالة
async function handleRouletteMessage(sock, msg, text, chatId, senderId) {
  const t = text.trim();

  // 🔢 اختيار رقم لـ"نسخ الروليت عادي" (الأدمن يكتب رقم الأمر)
  const pk = `${chatId}|${senderId}`;
  const pend = pendingCopies.get(pk);
  if (pend && Date.now() - pend.at > PENDING_TTL_MS) pendingCopies.delete(pk);
  else if (pend && /^[0-9٠-٩]{1,3}$/.test(t)) {
    const n = Number(t.replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)));
    if (n < 1 || n > RD.normalCommands.length) {
      await reply(sock, chatId, msg, `⚠️ اكتب رقم من 1 إلى ${RD.normalCommands.length}.`);
      return true;
    }
    pend.chosen.push(RD.normalCommands[n - 1]);
    const left = pend.copies - pend.chosen.length;
    if (left > 0) {
      await reply(sock, chatId, msg, `✅ تم. باقي ${left} اختيار، اكتب رقم الأمر التالي.`);
      return true;
    }
    pendingCopies.delete(pk);
    addItems(pend.label, pend.chosen);
    await persist();
    await reply(sock, chatId, msg, renderForm(pend.label, pend.lines, pend.chosen));
    return true;
  }
  const isRouletteCmd =
    t === ".000" ||
    t === ".روليت_اوامر" ||
    t === ".المشتريات" ||
    t === ".تصفير_المشتريات" ||
    t === ".المصروفات" ||
    t === ".تصفير_المصروفات" ||
    /^\.شراء(\+|_مميز)?\s+روليت(\s|$)/.test(t) ||
    /^\.روليت\s+\d/.test(t);

  if (!isRouletteCmd) return false;

  if (!isRouletteAdmin(senderId)) {
    await reply(sock, chatId, msg, "🚫 هذا القسم خاص، ما عندك صلاحية استخدامه.");
    return true;
  }

  if (t === ".000") {
    await reply(sock, chatId, msg, RD.menuText);
    return true;
  }

  if (t === ".روليت_اوامر") {
    await reply(sock, chatId, msg, RD.commandsListText);
    return true;
  }

  if (t === ".المصروفات") {
    await reply(sock, chatId, msg, renderExpensesList(state));
    return true;
  }

  if (t === ".تصفير_المصروفات") {
    // يصفّر المصروفات وحدود اللفات (نفس سلوك الأمر القديم)، وما يمس قائمة المشتريات (الأوامر)
    state.purchases = [];
    state.counts = {};
    await persist();
    await reply(sock, chatId, msg, "✅ تم تصفير قائمة المصروفات، تقدرون تبدأون من جديد.");
    return true;
  }

  if (t === ".المشتريات") {
    await reply(sock, chatId, msg, renderPurchasesList(state));
    return true;
  }

  if (t === ".تصفير_المشتريات") {
    state.items = [];
    pendingCopies.clear();
    await persist();
    await reply(sock, chatId, msg, "✅ تم تصفير قائمة المشتريات، تقدرون تبدأون من جديد.");
    return true;
  }

  // .روليت <عدد> <عادي|ذهبي> ... — سحب عشوائي بس، بدون لقب ولا حساب
  // فلوس ولا تسجيل بالمشتريات ولا تأثير على حدود الشراء. لتغيير/زيادة
  // لفة يدوياً (مثلاً لو طلع أمر ممنوع على المشرفين)
  const rouletteOnlyMatch = t.match(/^\.روليت\s+(.+)$/);
  if (rouletteOnlyMatch) {
    const { parts } = parseParts(rouletteOnlyMatch[1]);
    if (!parts.length) {
      await reply(
        sock,
        chatId,
        msg,
        "⚠️ صيغة الأمر غلط. مثال:\n.روليت 1 ذهبي 1 عادي"
      );
      return true;
    }
    await reply(sock, chatId, msg, drawOnly(parts));
    return true;
  }

  // .شراء+ روليت <عادي|ذهبي>(_نجوم)? اللقب  → لفة وحدة فوق الحد الطبيعي
  const plusMatch = t.match(/^\.شراء\+\s+روليت\s+(عادي|ذهبي)(_نجوم)?\s+(.+)$/);
  if (plusMatch) {
    const parts = [{ count: RD.LIMITS.plusExtra, tier: plusMatch[1], currency: plusMatch[2] ? "نجوم" : "فلوس" }];
    const label = plusMatch[3].trim();
    const built = buildPurchase(parts, label);
    addPurchaseRecord(state, label, built.totalMoney, built.totalStars);
    state.counts[label] = (state.counts[label] || 0) + RD.LIMITS.plusExtra;
    addItems(label, built.recorded);
    await persist();
    await sendPurchase(sock, chatId, msg, pk, label, built);
    return true;
  }

  // .شراء روليت ...  أو  .شراء_مميز روليت ...
  const buyMatch = t.match(/^\.شراء(_مميز)?\s+روليت\s+(.+)$/);
  if (buyMatch) {
    const isPremium = !!buyMatch[1];
    const limit = isPremium ? RD.LIMITS.premium : RD.LIMITS.normal;
    const { parts, label } = parseParts(buyMatch[2]);

    if (!parts.length || !label) {
      await reply(
        sock,
        chatId,
        msg,
        "⚠️ صيغة الأمر غلط. مثال:\n.شراء روليت 2 عادي 1 ذهبي اللقب🧧"
      );
      return true;
    }

    const key = label; // الحد يُحسب على الشخص المستلم (اللقب)، مو على الأدمن المشتري
    const already = state.counts[key] || 0;
    const requested = totalRolls(parts);

    if (already + requested > limit) {
      const remaining = Math.max(limit - already, 0);
      await reply(
        sock,
        chatId,
        msg,
        `🚫 "${label}" وصل الحد الأقصى (${limit} لفات).\nمتبقي له: ${remaining} فقط.`
      );
      return true;
    }

    const built = buildPurchase(parts, label);
    addPurchaseRecord(state, label, built.totalMoney, built.totalStars);
    state.counts[key] = already + requested;
    addItems(label, built.recorded);
    await persist();
    await sendPurchase(sock, chatId, msg, pk, label, built);
    return true;
  }

  await reply(sock, chatId, msg, RD.menuText);
  return true;
}

module.exports = { handleRouletteMessage, loadFromDb };