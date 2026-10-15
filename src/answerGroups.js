// مفتاح "الإجابة" لكل صورة: صور مختلفة بنفس الإجابة (أو إجابات تشترك بصيغة،
// مثل "كيد" و"كايتو") تنحسب سؤال واحد بقفل التكرار. نجمع الصور اللي
// تشترك بأي صيغة إجابة بمجموعة وحدة (Union-Find) ونعطيها مفتاح ثابت.
// النتيجة تتخزن مرتبطة بمصفوفة الصور نفسها (WeakMap)، فتنحسب مرة وحدة وتنمسح
// تلقائياً مع المصفوفة القديمة لو انعدّل ملف الصور.

const { normalizeWritingRelaxed } = require("./utils");

const cache = new WeakMap(); // images array -> Map(id -> groupKey)

function build(images) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // نخلي الجذر دايماً الأصغر ترتيباً — مفتاح ثابت مهما اختلف ترتيب الصور
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  const norms = images.map((it) => (it.answers || []).map((a) => normalizeWritingRelaxed(a)).filter(Boolean));
  for (const list of norms) for (const k of list) if (!parent.has(k)) parent.set(k, k);
  for (const list of norms) for (let i = 1; i < list.length; i++) union(list[0], list[i]);
  const map = new Map();
  images.forEach((it, i) => {
    map.set(it.id, norms[i].length ? find(norms[i][0]) : `id:${it.id}`);
  });
  return map;
}

function imageKeyFn(images) {
  let map = cache.get(images);
  if (!map) {
    map = build(images);
    cache.set(images, map);
  }
  return (it) => map.get(it.id) ?? `id:${it.id}`;
}

module.exports = { imageKeyFn };
