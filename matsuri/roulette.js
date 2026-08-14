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

// حالة بالذاكرة: purchases: [{label, money, stars}], counts: {senderId: totalRolls}
let state = { purchases: [], counts: {} };

async function loadFromDb() {
  const db = getDb();
  if (!db) return; // بدون قاعدة بيانات، يشتغل بالذاكرة بس (يُفقد عند إعادة التشغيل)
  try {
    const doc = await db.collection("matsuri_roulette").findOne({ _id: "state" });
    if (doc) state = { purchases: doc.purchases || [], counts: doc.counts || {} };
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
      .updateOne({ _id: "state" }, { $set: { purchases: state.purchases, counts: state.counts } }, { upsert: true });
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

// يبني رسالة الشراء ويحسب التكلفة ويسحب الأوامر عشوائياً
function buildPurchase(parts, label) {
  const usedGold = new Set();
  const usedNormal = new Set();
  const lines = [];
  let totalMoney = 0;
  let totalStars = 0;

  for (const p of parts) {
    const list = p.tier === "ذهبي" ? RD.goldCommands : RD.normalCommands;
    const usedSet = p.tier === "ذهبي" ? usedGold : usedNormal;
    for (let i = 0; i < p.count; i++) {
      const cmd = pickRandom(list, usedSet);
      lines.push(p.tier === "ذهبي" ? `*⬩⧼⬦ ${cmd} ⧽⬩*` : `*⛋ ${cmd}*`);
    }
    const unitPrice = RD.PRICES[p.tier][p.currency];
    const cost = unitPrice * p.count;
    if (p.currency === "نجوم") totalStars += cost;
    else totalMoney += cost;
  }

  const text = RD.purchaseTemplate
    .replace("{label}", label)
    .replace("{lines}", lines.join("\n"));

  return { text, totalMoney, totalStars };
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

function renderPurchasesList(state) {
  if (!state.purchases.length) {
    return RD.purchasesListTemplate.replace("{entries}", "⪦ لا يوجد مشتريات حالياً");
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
  return RD.purchasesListTemplate.replace("{entries}", entries);
}

function totalRolls(parts) {
  return parts.reduce((sum, p) => sum + p.count, 0);
}

async function reply(sock, chatId, msg, text) {
  await sock.sendMessage(chatId, { text }, { quoted: msg });
}

// نقطة الدخول — ترجع true لو تكفلت بالرسالة
async function handleRouletteMessage(sock, msg, text, chatId, senderId) {
  const t = text.trim();
  const isRouletteCmd =
    t === ".000" ||
    t === ".روليت_اوامر" ||
    t === ".المشتريات" ||
    t === ".تصفير_المشتريات" ||
    /^\.شراء(\+|_مميز)?\s+روليت(\s|$)/.test(t);

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

  if (t === ".المشتريات") {
    await reply(sock, chatId, msg, renderPurchasesList(state));
    return true;
  }

  if (t === ".تصفير_المشتريات") {
    state = { purchases: [], counts: {} };
    await persist();
    await reply(sock, chatId, msg, "✅ تم تصفير قائمة المشتريات، تقدرون تبدأون من جديد.");
    return true;
  }

  // .شراء+ روليت <عادي|ذهبي>(_نجوم)? اللقب  → لفة وحدة فوق الحد الطبيعي
  const plusMatch = t.match(/^\.شراء\+\s+روليت\s+(عادي|ذهبي)(_نجوم)?\s+(.+)$/);
  if (plusMatch) {
    const parts = [{ count: RD.LIMITS.plusExtra, tier: plusMatch[1], currency: plusMatch[2] ? "نجوم" : "فلوس" }];
    const label = plusMatch[3].trim();
    const { text: purchaseText, totalMoney, totalStars } = buildPurchase(parts, label);
    addPurchaseRecord(state, label, totalMoney, totalStars);
    await persist();
    await reply(sock, chatId, msg, purchaseText);
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

    const already = state.counts[senderId] || 0;
    const requested = totalRolls(parts);

    if (already + requested > limit) {
      const remaining = Math.max(limit - already, 0);
      await reply(
        sock,
        chatId,
        msg,
        `🚫 وصلت الحد الأقصى (${limit} لفات).\nمتبقي لك: ${remaining} فقط.`
      );
      return true;
    }

    const { text: purchaseText, totalMoney, totalStars } = buildPurchase(parts, label);
    addPurchaseRecord(state, label, totalMoney, totalStars);
    state.counts[senderId] = already + requested;
    await persist();
    await reply(sock, chatId, msg, purchaseText);
    return true;
  }

  await reply(sock, chatId, msg, RD.menuText);
  return true;
}

module.exports = { handleRouletteMessage, loadFromDb };
