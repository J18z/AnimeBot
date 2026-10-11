// حذف نقاط شخص إدارياً (للمالك) — منطق مشترك بين .ريسيت توب <نوع> و.ريسيت نقاط.
// "نقاط" هنا = نتائجه بـ.نقاطي (التاريخ الشخصي) + سجلاته بلوحة التوب.

const WRITING_BOARDS = ["writing1", "writing2", "writing3", "writing4", "writing5"];

// لوحات التوب المرتبطة بفقرة: الكتابة لها بنوك إضافية حسب عدد الكلمات
function boardsFor(poolType) {
  return poolType === "writing" ? ["writing", ...WRITING_BOARDS] : [poolType];
}

// يحذف أفضل (أسرع) نتيجة لشخص بفقرة — من .نقاطي ومن لوحة التوب العامة لهذي
// الفقرة بس، وتصعد نتيجته التالية تلقائياً للتوب (بنفس شروط أي نتيجة
// عادية). ما يلمس بنوك الكتابة حسب عدد الكلمات (writing1..5) إطلاقاً —
// هذي لها أمرها المستقل (removeTopBoardPoint)
function removeTopPoint({ leaderboard, personalHistory, poolType, userId }) {
  const { removed, remaining } = personalHistory.popTopEntry(poolType, userId);
  leaderboard.removeUserFromPool(poolType, userId);
  const next = remaining[0] || null;
  if (next) leaderboard.record(poolType, next);
  return { removed, next };
}

// يحذف أقوى نقطة لشخص من بنك كتابة بعدد كلمات محدد (writing1..writing5) —
// من هذا البنك بس (ما يلمس .نقاطي ولا توب الكتابة العام). تصعد له تلقائياً
// أفضل نتيجة تالية بنفس عدد الكلمات، بشرط تكون أبطأ من المحذوفة (عشان ما
// ترجع نتيجة سبق حذفها أسرع منها). ترجع { removed: null } لو ما عنده سجل بالبنك
function removeTopBoardPoint({ leaderboard, personalHistory, board, userId }) {
  const current = leaderboard.getTop(board, 1000).find((e) => e.userId === userId);
  if (!current) return { removed: null, next: null };
  leaderboard.removeUserFromPool(board, userId);
  const n = Number(board.slice(-1));
  const next =
    personalHistory
      .getTop(userId, "writing", 10)
      .find((e) => e.wc === n && e.elapsed > current.elapsed) || null;
  if (next) leaderboard.record(board, next);
  return { removed: current, next };
}

// يحذف نتائج محددة (قائمة entries) لشخص بفقرة — من .نقاطي ومن لوحة التوب
// (بما فيها بنوك الكتابة 1..5). لو الشخص فقد سجله بلوحة بسبب الحذف، تصعد
// أفضل نتيجة متبقية له تلقائياً (بنفس شروط أي نتيجة عادية)
function deletePoints({ leaderboard, personalHistory, poolType, userId, entries }) {
  const removed = [];
  const emptied = new Set();
  for (const e of entries) {
    if (!personalHistory.removeEntryMatching(userId, poolType, e)) continue;
    removed.push(e);
    for (const b of boardsFor(poolType)) if (leaderboard.removeEntryMatching(b, userId, e)) emptied.add(b);
  }
  const remaining = personalHistory.getTop(userId, poolType, 10);
  for (const b of emptied) {
    if (b === poolType) {
      if (remaining[0]) leaderboard.record(b, remaining[0]);
    } else {
      const n = Number(b.slice(-1));
      const best = remaining.find((e) => e.wc === n);
      if (best) leaderboard.record(b, best);
    }
  }
  return { removed, remaining };
}

module.exports = { removeTopPoint, removeTopBoardPoint, deletePoints, boardsFor };
