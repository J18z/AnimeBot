// اختيار عشوائي "بوزن متناقص" (soft decay) بدل الاستبعاد الصارم الكامل:
// كل عنصر يُستخدم، احتمال رجوعه بالمرة الجاية يقل بشكل كبير (100% ← 50%
// ← 20% ← 10% ← 5%)، بدل ما يُمنع كليًا لين تنتهي الدورة. هذا يخلي فيه
// احتمال ضئيل (بس موجود) يتكرر عنصر قريب، وبنفس الوقت يضمن إن البنك
// الكبير كله (مئات الأسئلة) يتوزع ويتغطى تدريجيًا بدل ما يعلق بمجموعة
// صغيرة. لما كل عناصر البنك توصل لاستخدام مرة وحدة على الأقل، نرجّع كل
// الأوزان لـ100% من جديد (دورة جديدة تلقائيًا).
//
// التتبع هنا "عالمي" (على مستوى العملية كلها، مو لكل مسابقة/قروب لحاله)
// عمداً — عشان البنك يتوزع صح حتى لو فيه أكثر من مسابقة شغالة بنفس
// الوقت بقروبات مختلفة. يبقى بالذاكرة بس (يرجع 100% للكل لو البوت
// أعاد التشغيل)، وهذا مقصود ومقبول: ما فيه داعي نعقّد الموضوع بحفظه
// بقاعدة البيانات لمجرد تنويع الأسئلة.

const WEIGHT_BY_USES = [1, 0.5, 0.2, 0.1, 0.05];
function weightForUses(n) {
  return WEIGHT_BY_USES[Math.min(n, WEIGHT_BY_USES.length - 1)];
}

const usageMaps = {}; // poolType -> Map(key -> عدد مرات الاستخدام منذ آخر دورة)

function getUsageMap(poolType) {
  if (!usageMaps[poolType]) usageMaps[poolType] = new Map();
  return usageMaps[poolType];
}

// يختار عنصر وحد بالوزن من pool. keyFn(item) يرجع مفتاح ثابت مميز لكل
// عنصر (id غالبًا). excludeKeys اختياري: مجموعة مفاتيح نستبعدها كليًا
// من هذا الاختيار بس (نستخدمها لمنع نفس الكلمة تتكرر داخل نفس جولة
// كتابة وحدة — مالها علاقة بتتبع "الاستخدام عبر الزمن")
function pickWeighted(poolType, pool, keyFn, excludeKeys = null) {
  if (!pool || pool.length === 0) return null;
  const usage = getUsageMap(poolType);
  const candidates = excludeKeys ? pool.filter((it) => !excludeKeys.has(keyFn(it))) : pool;
  if (candidates.length === 0) return null;

  const weights = candidates.map((it) => weightForUses(usage.get(keyFn(it)) || 0));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  let chosen = candidates[candidates.length - 1]; // احتياط لو صار تقريب عائم بسيط
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      chosen = candidates[i];
      break;
    }
  }

  const key = keyFn(chosen);
  usage.set(key, (usage.get(key) || 0) + 1);

  // لو كل عناصر البنك الأصلي كامل (مو بس المرشحين المتاحين هالمرة) وصلت
  // لاستخدام مرة فأكثر، نبدأ دورة جديدة: نصفّر التتبع بالكامل لهذا النوع
  const allUsedAtLeastOnce = pool.every((it) => (usage.get(keyFn(it)) || 0) >= 1);
  if (allUsedAtLeastOnce) {
    usage.clear();
  }

  return chosen;
}

module.exports = { pickWeighted };
