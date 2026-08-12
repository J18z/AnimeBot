// دوال مساعدة عامة

/**
 * تطبيع النص العربي/الإنجليزي عشان المقارنة تكون دقيقة
 * (إزالة التشكيل، توحيد الألف والهمزات، إزالة المسافات الزايدة، تصغير الأحرف الإنجليزية)
 */
function normalizeText(text) {
  if (!text) return "";
  let t = String(text).trim();

  // إزالة التشكيل العربي (الحركات)
  t = t.replace(/[\u064B-\u065F\u0670]/g, "");

  // توحيد أشكال الألف والهمزة
  t = t.replace(/[إأآا]/g, "ا");
  t = t.replace(/ى/g, "ي");
  t = t.replace(/ة/g, "ه");
  t = t.replace(/ؤ/g, "و");
  t = t.replace(/ئ/g, "ي");

  // إزالة علامات الترقيم الشائعة (وفواصل زي ~ و |)
  t = t.replace(/[.,!?؟،؛:"'`\-_/\\()\[\]{}~|]/g, " ");

  // تصغير الأحرف الإنجليزية
  t = t.toLowerCase();

  // توحيد المسافات
  t = t.replace(/\s+/g, " ").trim();

  return t;
}

/**
 * يتحقق هل النص المدخل يطابق أي إجابة من قائمة الإجابات المقبولة
 */
function matchesAnswer(input, acceptedAnswers) {
  const normInput = normalizeText(input);
  if (!normInput) return false;
  return acceptedAnswers.some((ans) => normalizeText(ans) === normInput);
}

/**
 * تطبيع "مرن" إضافي: يوحّد الأحرف المتشابهة نطقاً (غ/ق/ج) لحرف واحد
 * (مثلاً "ناجي" و"ناقي" و"ناغي" تُحسب نفس الشي). يُستخدم بكل الفقرات
 * عدا الكتابة، اللي لازم فيها تطابق حرفي كامل بدون أي تساهل.
 */
function relaxLetters(text) {
  return text.replace(/[غقج]/g, "ق");
}

/**
 * يقصّ أي تكرار متتالي لنفس الحرف لحرف واحد بس — مثلاً "نااغي"،
 * "نااااغي"، و"ناغي" كلهم يصيرون "ناقي" (بعد التطبيع المرن). يعالج
 * حالات كتابة زيادة بالحماس (كاااكاشي، ككاكاشي، كييسكي...). يُستخدم مع
 * نفس فقرات relaxLetters بالضبط (كل شي عدا الكتابة).
 */
function collapseRepeats(text) {
  return text.replace(/(.)\1+/g, "$1");
}

function normalizeRelaxed(text) {
  return collapseRepeats(relaxLetters(normalizeText(text)));
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function formatSeconds(ms) {
  return (ms / 1000).toFixed(2);
}

/**
 * يدور داخل نص رسالة (ممكن تحتوي أكثر من إجابة، مفصولة بأي شي: مسافات،
 * فواصل، ~، أو حتى كلام زيادة مالوش علاقة) عن كل الإجابات الصحيحة الغير
 * مستخدمة بعد من قائمة slots، ويرجع فهارس العناصر اللي طابقها بهذي الرسالة.
 *
 * slots: مصفوفة مصفوفات (كل عنصر = الصيغ المقبولة لعنصر/كلمة وحدة)
 * claimedSet: Set فيها فهارس العناصر المستخدمة مسبقاً (ما نعيد مطابقتها)
 * relaxed: لو true، يستخدم التطبيع المرن (غ/ق/ج كحرف واحد) — لكل الفقرات
 * عدا الكتابة، اللي لازم فيها تطابق حرفي كامل
 */
function findAllMatches(message, slots, claimedSet, relaxed = false) {
  const normalize = relaxed ? normalizeRelaxed : normalizeText;
  let text = " " + normalize(message) + " ";

  // نجمع كل الاحتمالات (فهرس + صيغة) ونرتبها بحيث الصيغ الأطول (بعدد كلمات
  // أكثر) تتفحص أول، عشان "مونكي دي لوفي" ما تتأكل بمطابقة جزئية أقصر
  const candidates = [];
  slots.forEach((aliases, idx) => {
    if (claimedSet.has(idx)) return;
    aliases.forEach((alias) => {
      const norm = normalize(alias);
      if (norm) candidates.push({ idx, norm, wordCount: norm.split(" ").length });
    });
  });
  candidates.sort((a, b) => b.wordCount - a.wordCount);

  const claimedNow = [];
  const usedIdx = new Set();

  for (const c of candidates) {
    if (usedIdx.has(c.idx)) continue;
    const pattern = " " + c.norm + " ";
    const pos = text.indexOf(pattern);
    if (pos !== -1) {
      claimedNow.push(c.idx);
      usedIdx.add(c.idx);
      // نشيل النص المطابق عشان ما ينحسب مرتين لعنصرين مختلفين
      text = text.slice(0, pos + 1) + text.slice(pos + pattern.length - 1);
    }
  }

  return claimedNow;
}

module.exports = {
  normalizeText,
  normalizeRelaxed,
  matchesAnswer,
  pickRandom,
  shuffle,
  formatSeconds,
  findAllMatches,
};
