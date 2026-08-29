// دوال مساعدة عامة

/**
 * تطبيع النص العربي/الإنجليزي عشان المقارنة تكون دقيقة
 * (إزالة التشكيل، توحيد الألف والهمزات، إزالة المسافات الزايدة، تصغير الأحرف الإنجليزية)
 */
/**
 * تحذف كل همزة (ء) "ملتصقة" بحرف غير همزة الغرض منها تمويه الكلمة عن
 * اقتراحات لوحة المفاتيح (مثلاً "ءايزن جين توسينء" تصير "ايزن جين توسين")
 * — تُحذف بغض النظر عن مكانها بالنص (بداية/وسط/نهاية). الاستثناء الوحيد:
 * لو آخر همزة بالنص منفصلة عن الكلمة قبلها بمسافة فعلية (مو نقطة أو علامة
 * ترقيم تحولت لمسافة)، نسيبها زي ما هي بدون حذف — عشان تفشل المطابقة
 * عمداً (تمنع تمويه زايد على الآخر). أي همزة ثانية غير الأخيرة تُحذف دايمًا
 * حتى لو انفصلت بمسافة (بسبب نقطة مثلاً)
 */
function stripDisguiseHamza(text) {
  const lastIdx = text.lastIndexOf("ء");
  if (lastIdx === -1) return text;
  const precededBySpace = lastIdx > 0 && text[lastIdx - 1] === " ";
  if (precededBySpace) {
    return text.slice(0, lastIdx).replace(/ء/g, "") + text.slice(lastIdx);
  }
  return text.replace(/ء/g, "");
}

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

  // همزات التمويه الملتصقة (شرحها فوق الدالة)
  t = stripDisguiseHamza(t);

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

/**
 * نفس تطبيع الكتابة العادي (تطابق حرفي دقيق، بدون غ/ق/ج) لكن مع قص تكرار
 * الأحرف المتتالي — مثلاً "روجرر" أو "نااغي روجرر" (لو الاسم أصلاً فيه غ)
 * تُحسب صحيحة، بدون ما نلغي دقة التمييز بين غ/ق/ج نفسها بفقرة الكتابة
 */
function normalizeWritingRelaxed(text) {
  return collapseRepeats(normalizeText(text));
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
 * relaxed: لو true، يستخدم التطبيع المرن الكامل (غ/ق/ج + تكرار الأحرف) —
 * لكل الفقرات عدا الكتابة. الكتابة نفسها لسا تقص تكرار الأحرف (روجرر →
 * روجر) بس بدون توحيد غ/ق/ج، عشان يبقى التمييز الحرفي الدقيق بينهم
 */
function findAllMatches(message, slots, claimedSet, relaxed = false) {
  const normalize = relaxed ? normalizeRelaxed : normalizeWritingRelaxed;
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

/**
 * يحلل رسالة تحديد نمط الهمزات (مثلاً "تءءت" أو "جججءءججج") لمسابقة
 * وضع الهمزات الإلزامي — يرجع { prefix, suffix } (كل شي قبل أول همزة،
 * وكل شي بعد آخر همزة)، أو null لو ما فيه همزتين مختلفتين بالنص
 */
function parseHamzaPattern(text) {
  const t = String(text || "").trim();
  const first = t.indexOf("ء");
  const last = t.lastIndexOf("ء");
  if (first === -1 || last === -1 || first === last) return null;
  return { prefix: t.slice(0, first), suffix: t.slice(last + 1) };
}

/**
 * يفك تغليف الهمزات لرسالة إجابة حسب نمط محدد (من parseHamzaPattern) —
 * لازم النص يبدأ بـprefix وينتهي بـsuffix بالضبط، وبينهم همزة فأول
 * المحتوى وهمزة آخره. يرجع المحتوى الفعلي (بين الهمزتين) لو طابق، أو
 * null لو ما طابق الإطار إطلاقاً
 */
function unwrapHamza(text, pattern) {
  if (!pattern) return null;
  const { prefix, suffix } = pattern;
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) return null;
  const middleEnd = text.length - suffix.length;
  if (middleEnd < prefix.length) return null;
  const middle = text.slice(prefix.length, middleEnd);
  if (middle.length < 2 || !middle.startsWith("ء") || !middle.endsWith("ء")) return null;
  return middle.slice(1, -1);
}

module.exports = {
  normalizeText,
  normalizeRelaxed,
  normalizeWritingRelaxed,
  matchesAnswer,
  pickRandom,
  shuffle,
  formatSeconds,
  findAllMatches,
  parseHamzaPattern,
  unwrapHamza,
};
