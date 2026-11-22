// ═══════════════════════════════════════════════════════════════════
// نظام البكجات (.105 / .بكج / .ضف_بكج / .حذف_بكج) — شات ماتسوري فقط
// القوائم (العادية/الخاصة) محفوظة بقاعدة البيانات وقابلة للتعديل
// ═══════════════════════════════════════════════════════════════════
const store = require("../src/dataStore");
const S = require("./mStore");

const DEFAULT_SPECIAL = [
  "زيادة 100k جويل",
  "نسخ 2 بكج",
  "تغير لقبك يومين",
  "تغير لقب عضو يوم ×2",
  "زيارة نقابة يومين",
  "سرقة 100k",
];
const DEFAULT_NORMAL = [
  "طرد عضو ساعه (3س)",
  "زيادة 500 رسالة",
  "تغيير العرض 12س",
  "خطف عضو 3 - 6س (12س - يوم)",
  "زيادة 20ك - 30ك (40ك - 80ك)",
  "ناقص 20ك - 50ك",
  "إعطاء انذار - انذارين",
  "تسكيت نص ساعه",
  "اسم جانب النقابة 6س",
  "(نسخ بكج)",
  "(سرقة بكج)",
  "تغير لقبك 12س (تغيير لقبك يوم)",
  "تغيير لقب عضو 3س - 6س (7س - يوم)",
  "سرقة 50ك",
  "زيارة نقابه 3س - 6س (12س - يوم)",
];

function pools() {
  const p = S.getSetting("pkgPools");
  return {
    normal: p && Array.isArray(p.normal) ? p.normal : DEFAULT_NORMAL,
    special: p && Array.isArray(p.special) ? p.special : DEFAULT_SPECIAL,
  };
}
function savePools(p) {
  S.setSetting("pkgPools", { normal: [...p.normal], special: [...p.special] });
}

// ── تفكيك صيغة الأمر لخيارات: "خطف عضو 3 - 6س (12س - يوم)" → 4 خيارات ──
const isValueOnly = (s) => s.split(/\s+-\s+/).every((x) => x.trim() && !/\s/.test(x.trim()));
function splitRange(str) {
  // "3 - 6س" / "انذار - انذارين" → { prefix, vals }
  const m = str.match(/^(.*?)\s*(\S+)\s+-\s+(\S+)$/);
  if (!m) return null;
  let [, prefix, a, b] = m;
  const bu = b.match(/^[\d٠-٩]+(\D+)$/);
  if (bu && /^[\d٠-٩]+$/.test(a)) a += bu[1];
  return { prefix: prefix.trim(), vals: [a, b] };
}
function expand(display) {
  const d = String(display).trim();
  const full = d.match(/^\(([^()]+)\)$/);
  if (full) return [full[1].trim()];
  let main = d;
  let paren = null;
  const pm = d.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (pm) {
    main = pm[1].trim();
    paren = pm[2].trim();
  }
  if (paren && !isValueOnly(paren)) return [main, paren]; // بديل كامل
  let prefix;
  let vals;
  const r = splitRange(main);
  if (r) {
    prefix = r.prefix;
    vals = r.vals;
  } else if (paren) {
    const toks = main.split(/\s+/);
    vals = [toks.pop()];
    prefix = toks.join(" ");
  } else return [main];
  if (paren) vals = vals.concat(paren.split(/\s+-\s+/).map((x) => x.trim()));
  return vals.map((v) => `${prefix} ${v}`.trim());
}
// عرض البند بالقائمة: الأقواس الكاملة "(نسخ بكج)" تنعرض كما هي
function pick(display) {
  const o = expand(display);
  return o[Math.floor(Math.random() * o.length)];
}

// ── قراءة قائمة البكجات المرسلة ──
function parseList(text) {
  const out = new Map();
  for (const raw of String(text || "").split("\n")) {
    const m = S.toAscii(raw).trim().match(/^(\d{1,2})\s*[-.)]*\s*(.+)$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n < 1 || n > 20) continue;
    const name = m[2].replace(/^[-.)\s]+/, "").replace(/\s*┇.*$/, "").replace(/\*/g, "").trim();
    if (name && /[\p{L}]/u.test(name) && !out.has(n)) out.set(n, name);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([n, name]) => ({ n, name }));
}

function shuffle(a) {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}
// يسحب n بند بدون تكرار (لو ما يكفي نعيد التدوير)
function draw(list, n) {
  const res = [];
  while (res.length < n && list.length) res.push(...shuffle(list).slice(0, n - res.length));
  return res;
}
const pad2 = (n) => String(n).padStart(2, "0");

function buildForm(entries) {
  const P = pools();
  const normal = entries.filter((e) => e.n <= 15);
  const special = entries.filter((e) => e.n >= 16);
  const nCmds = draw(P.normal, normal.length).map(pick);
  const sCmds = draw(P.special, special.length).map(pick);
  const lines = [];
  normal.forEach((e, i) => lines.push(`${pad2(e.n)} - ${e.name} ┇ ${nCmds[i]}`));
  const sMap = new Map(special.map((e, i) => [e.n, `${e.n} - ${e.name} ┇ ${sCmds[i]}`]));
  const sLines = [16, 17, 18, 19, 20].map((n) => sMap.get(n) || `${n} 🏷️`);
  return (
    "༺ الـبـكـجـات ༻\n⪦══━┉━≻📮≺━┉━══⪧\n" +
    "◝طريقة المشاركة سيتم فتح القروب حتى اكتمال العدد ويختار الأعضاء أحد الأرقام التالية وعلى حسب حظك يطلعلك البكجات ◟\n\n" +
    "عدد البكجات 15 - 20 :-\n\n" +
    lines.join("\n") +
    `\n\n- البكجات الخاصة: *${special.length ? "يوجد" : "لا يوجد"}*\n\n` +
    sLines.join("\n") +
    "\n\n⎆ للمشاركة يرجى الدخول الى الرابط الأدنى \n\n⪦══━┉━≻📮≺━┉━══⪧\n✪ تفعيل الأوامر عند مسؤول نقابتك\n⋞Hikari✨Matsuri🧧⋟"
  );
}

function menuText() {
  const P = pools();
  const li = (a) => a.map((x) => `- ${x}`).join("\n");
  return (
    "˼‏⬩بــوت ريــم • レム┊🤖˹\n❆ـ⋅ ┈── ─━ •⊰✣⊱ • ━─ ──┈ ⋅ـ❆\n◞قـائـمـة الاوامــر╎˼‏🧾˹⤹◜\n◝بـكـجـات⇆🎁◟\nـ»» ┉ ٠ ┈─ • ⊰ 倖 ⊱ • ─┈ ٠ ┉ ««ـ\n" +
    `> *✠ الاوامـر الـخـاصـة • 🌟◜*\n${li(P.special)}\n\n> *✠ الاوامـر الـعـاديـة • 🍂◜*\n${li(P.normal)}\n` +
    "ـ»»——⍟——««ـ\n✪ مـرحـبـاً، مـعـكـم بـوت ريـم للاسـتـمـارات الـخـاصـة بــ وزارة ماتسوري🧧\n❆ـ⋅ ┈── ─━ •⊰✣⊱ • ━─ ──┈ ⋅ـ❆\n~✷┇تــ✍︎ــوقــيــ؏↯:~\n◜Hikari✨Matsuri •🧧◝"
  );
}

function quotedText(msg) {
  const m = (msg && msg.message) || {};
  const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m;
  const q = inner.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!q) return "";
  return q.conversation || q.extendedTextMessage?.text || q.imageMessage?.caption || "";
}

const waiting = new Map(); // chatId|sender -> until
const WAIT_MS = 5 * 60 * 1000;

function isAdmin(senderId) {
  const cfg = store.getConfig();
  const raw = String(senderId || "").split("@")[0];
  return !!raw && [cfg.ownerId, cfg.matsuriOwnerId].some((x) => x && String(x).split("@")[0] === raw);
}

async function reply(sock, chatId, msg, text) {
  await sock.sendMessage(chatId, { text }, { quoted: msg });
}

async function makeAndSend(sock, chatId, msg, listText) {
  const entries = parseList(listText);
  if (!entries.filter((e) => e.n <= 15).length) {
    await reply(sock, chatId, msg, "⚠️ ما لقيت قائمة بكجات (رقم + اسم، مثل: 1 اكاني 🎴).");
    return;
  }
  await sock.sendMessage(chatId, { text: S.applyLink(buildForm(entries)) }, { quoted: msg });
}

// يرجع true لو تكفل بالرسالة
async function handlePackages(sock, msg, t, chatId, senderId) {
  const pk = `${chatId}|${senderId}`;
  const w = waiting.get(pk);
  if (w && Date.now() > w) waiting.delete(pk);
  else if (w && !t.startsWith(".") && parseList(t).length) {
    waiting.delete(pk);
    await makeAndSend(sock, chatId, msg, t);
    return true;
  }

  if (t === ".105") {
    await reply(sock, chatId, msg, menuText());
    return true;
  }

  const bm = t.match(/^\.بكج(?:\s+([\s\S]*))?$/);
  if (bm) {
    const inline = (bm[1] || "").trim();
    const src = quotedText(msg) || inline;
    if (src && parseList(src).length) {
      waiting.delete(pk);
      await makeAndSend(sock, chatId, msg, src);
    } else {
      waiting.set(pk, Date.now() + WAIT_MS);
      await reply(sock, chatId, msg, "📦 ارسل البكجات المختارة (رقم + اسم، كل واحد بسطر)، مثل:\n1 اكاني 🎴\n2 باتريك 🎴\n...\n15 هوتارو ⛰️\n\n(أو ارسلها ورد عليها بـ .بكج)");
    }
    return true;
  }

  const am = t.match(/^\.ضف_بكج(\s+خاص)?(?:\s+([\s\S]+))?$/);
  if (am) {
    if (!isAdmin(senderId)) return false;
    const text = (am[2] || "").trim();
    if (!text) {
      await reply(sock, chatId, msg, "اكتب الأمر بعد الأمر، مثل:\n.ضف_بكج زيارة نقابه 3س - 6س (12س - يوم)\n.ضف_بكج خاص سرقة 100k");
      return true;
    }
    const P = pools();
    const key = am[1] ? "special" : "normal";
    P[key] = [...P[key], text];
    savePools(P);
    await reply(sock, chatId, msg, `✅ انضاف للبكجات ${am[1] ? "الخاصة" : "العادية"}: ${text}\n(الخيارات: ${expand(text).join(" / ")})`);
    return true;
  }

  const dm = t.match(/^\.حذف_بكج(\s+خاص)?\s+(\d+)$/);
  if (dm) {
    if (!isAdmin(senderId)) return false;
    const P = pools();
    const key = dm[1] ? "special" : "normal";
    const i = parseInt(dm[2], 10) - 1;
    if (i < 0 || i >= P[key].length) {
      await reply(sock, chatId, msg, `⚠️ رقم غير صحيح (1 - ${P[key].length}).`);
      return true;
    }
    const [gone] = P[key].splice(i, 1);
    savePools(P);
    await reply(sock, chatId, msg, `🗑️ انحذف: ${gone}`);
    return true;
  }
  return false;
}

module.exports = { handlePackages, expand, parseList, buildForm, menuText, pools };
