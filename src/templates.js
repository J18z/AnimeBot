// قوالب زخرفة "بوت ريم" المشتركة — تُستخدم من index.js و game.js

// علامات عزل اتجاه يونيكود: تمنع كسر شكل الزخرفة العربية لما يجي اسم
// إنجليزي وسطها (FSI = يكتشف الاتجاه تلقائياً، PDI = ينهي العزل)
const ISOLATE_START = "\u2068";
const ISOLATE_END = "\u2069";
function isolate(name) {
  return `${ISOLATE_START}${name}${ISOLATE_END}`;
}

const TOP_HEADER = "˼‏⬩بــوت ريــم • レム┊🤖˹";
const TOP_DIVIDER = "❆ ⋅ ┈── ─━ •⊰✣⊱ • ━─ ──┈ ⋅ ❆";
const TOP_SUBTITLE_ALL = "     ◝لـلـكـل⇆🔰◟";
const TOP_SUBTITLE_MOBILE = "     ◝جـوالات⇆📱◟";
const TOP_DIVIDER2 = "      ❊ ┉ ٠ ┈─ • ⊰ 倖 ⊱ • ─┈ ٠ ┉ ❊";
const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
const MEDALS = ["🥇", "🥈", "🥉"];

const topTitles = {
  images: { title: "تــوب الـصـور", icon: "🖼️", compact: "صـور" },
  counts: { title: "تــوب الـتـعـداد", icon: "🔢", compact: "تـعـداد" },
  writing: { title: "تـوب الـكـتـابـة", icon: "✒️", compact: "كـتـابـة" },
  questions: { title: "تــوب الأسـئـلـة", icon: "❓", compact: "اسـئـلـة" },
};
const TOP_ORDER = ["writing", "images", "questions", "counts"];

// سطرين لعنصر ترتيب وحد بلوحة صدارة الأوقات (اسم+منشن ثم إجابة+وقت)
function formatEntryLines(numOrMedal, e) {
  let out = `˼‏${numOrMedal}╎${isolate(e.displayName)} + @${e.userId.split("@")[0]} ⤹\n`;
  out += `˼‏${e.answer}˹﹝${(e.elapsed / 1000).toFixed(2)} ثانية﹞⋄◟\n\n`;
  return out;
}

// قسم نصي كامل مزخرف لأفضل نتائج فقرة معينة (لأوامر .توب <نوع>)
function formatTopSection(poolType, entries, subtitle = TOP_SUBTITLE_ALL) {
  const { title, icon } = topTitles[poolType];
  let out = `${TOP_HEADER}\n${TOP_DIVIDER}\n◞${title}╎˼‏${icon}˹⤹◜\n${subtitle}\n${TOP_DIVIDER2}\n`;
  if (entries.length === 0) {
    out += "ما فيه نتائج مسجلة بعد.\n";
  } else {
    entries.forEach((e, i) => {
      out += formatEntryLines(CIRCLED[i] || `${i + 1}.`, e);
    });
  }
  out += TOP_DIVIDER;
  return out;
}

// رسالة .توب العام (كل الفقرات مع بعض)، أو نسختها لـ .توب جوالات
function formatCombinedTop(entriesByType, subtitle = TOP_SUBTITLE_ALL) {
  let out = `${TOP_HEADER}\n${TOP_DIVIDER}\n◞تــوب الـفـقـرات╎˼‏🔝˹⤹◜\n${subtitle}\n`;
  TOP_ORDER.forEach((poolType) => {
    const { compact, icon } = topTitles[poolType];
    out += `${TOP_DIVIDER2}\n*✠ تــوب 3 ${compact} • ${icon}◜*\n\n`;
    const entries = entriesByType[poolType] || [];
    if (entries.length === 0) {
      out += "ما فيه نتائج مسجلة بعد.\n\n";
    } else {
      entries.forEach((e, i) => {
        out += formatEntryLines(MEDALS[i] || `${i + 1}.`, e);
      });
    }
  });
  out += TOP_DIVIDER;
  return out;
}

// رسالة .سجل / .سجل جوالات — أفضل 6، كل عنصر: اسم+منشن، عدد الفنشات
// المكسوبة (wins)، ومجموع النقاط
function formatStandingsList(list, subtitle = TOP_SUBTITLE_ALL) {
  let out = `${TOP_HEADER}\n${TOP_DIVIDER}\n◞سـجـل الـنـقـاط╎˼‏📑˹⤹◜\n${subtitle}\n${TOP_DIVIDER2}\n`;
  const shown = list.slice(0, 6);
  if (shown.length === 0) {
    out += "ما فيه سجل بعد.\n";
  } else {
    shown.forEach((e, i) => {
      out += `˼‏${CIRCLED[i]}╎${isolate(e.displayName)} ⇆ @${e.userId.split("@")[0]} ⤹\n`;
      out += `˼‏الـفـنـش˹ ﹝${e.wins || 0}﹞⋄🏅◟\n`;
      out += `˼‏الـنـقـاط˹﹝${e.points}﹞⋄🔢◟\n\n`;
    });
  }
  out += TOP_DIVIDER;
  return out;
}

// رسالة نهاية مسابقة (الترتيب النهائي)، أفضل 6
function formatContestEnd(ranking) {
  let out = `${TOP_HEADER}\n${TOP_DIVIDER}\n◞نـهـايـة الـمـسـابـقـة╎˼‏🏆˹⤹◜\n ◝الـتـرتـيـب الـنـهـائي⇆🎖️◟\n${TOP_DIVIDER2}\n`;
  const shown = ranking.slice(0, 6);
  if (shown.length === 0) {
    out += "انتهت المسابقة بدون فائزين.\n";
  } else {
    shown.forEach((e, i) => {
      out += `˼‏${CIRCLED[i]}╎${isolate(e.displayName)} ⇆ @${e.userId.split("@")[0]} ⤹\n`;
      out += `˼‏الـنـقـاط˹﹝${e.points}﹞⋄◟\n\n`;
    });
  }
  out += TOP_DIVIDER;
  return out;
}

// رسالة .قائمة — الأعضاء المسجلين (خارجي وجوال)، أفضل 6 لكل قسم
function formatMemberList(externals, mobiles) {
  let out = `${TOP_HEADER}\n${TOP_DIVIDER}\n◞قـائـمـة الـتـسـجـيـلات╎˼‏📜˹⤹◜\n     ◝الـاعــضــاء⇆👥◟\n${TOP_DIVIDER2}\n`;
  out += `*✠ الـخـارجـي • 💻◜*\n\n`;
  const shownExt = externals.slice(0, 6);
  if (shownExt.length === 0) {
    out += "ما فيه أعضاء مسجلين.\n\n";
  } else {
    shownExt.forEach((e, i) => {
      out += `˼‏${CIRCLED[i]}╎${isolate(e.displayName)} ⇆ @${e.userId.split("@")[0]} ⋄◟\n`;
    });
    out += "\n";
  }
  out += `${TOP_DIVIDER2}\n*✠ الـجـوالات • 📱◜*\n\n`;
  const shownMob = mobiles.slice(0, 6);
  if (shownMob.length === 0) {
    out += "ما فيه أعضاء مسجلين.\n\n";
  } else {
    shownMob.forEach((e, i) => {
      out += `˼‏${CIRCLED[i]}╎${isolate(e.displayName)} ⇆ @${e.userId.split("@")[0]} ⋄◟\n`;
    });
  }
  out += TOP_DIVIDER;
  return out;
}

module.exports = {
  isolate,
  TOP_HEADER,
  TOP_DIVIDER,
  TOP_SUBTITLE_ALL,
  TOP_SUBTITLE_MOBILE,
  TOP_DIVIDER2,
  CIRCLED,
  MEDALS,
  topTitles,
  TOP_ORDER,
  formatEntryLines,
  formatTopSection,
  formatCombinedTop,
  formatStandingsList,
  formatContestEnd,
  formatMemberList,
};
