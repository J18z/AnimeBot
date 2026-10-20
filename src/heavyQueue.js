// طابور مهام ثقيلة (ستيكر: ffmpeg/sharp) — مهمة وحدة بنفس الوقت.
// السبب: سيرفر Render صغير (معالج ضئيل)، وعدة أوامر ستيكر بنفس اللحظة تزاحم
// المعالج وتجمّد معالجة رسائل المسابقة لثواني. الباقي ينتظر دوره (حد أقصى 3
// بالانتظار)، وأي طلب زايد يرفضه البوت برسالة واضحة بدل ما يتكدس بالذاكرة.

const MAX_WAITING = 3;
let tail = Promise.resolve();
let pending = 0; // اللي يشتغل + اللي ينتظر

function runHeavy(fn) {
  if (pending >= MAX_WAITING) {
    return Promise.reject(new Error("البوت مشغول بطلبات ستيكر ثانية، جرب بعد شوي."));
  }
  pending++;
  const run = tail.then(() => fn()).finally(() => {
    pending--;
  });
  tail = run.catch(() => {}); // فشل مهمة ما يوقف اللي بعدها
  return run;
}

module.exports = { runHeavy };
