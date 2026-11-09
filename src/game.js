const fs = require("fs");
const usedStore = require("./usedStore");
const { imageKeyFn } = require("./answerGroups");
const cloudImages = require("./cloudImages");
const { randomHamzaPattern, pickRandom, shuffle, formatSeconds, prepareSlots, findAllMatchesPrepared, prepareWordAliases, findWordProgress, parseHamzaPattern, unwrapHamza, isCloseToSingleName } = require("./utils");
const store = require("./dataStore");
const leaderboard = require("./leaderboard");
const personalHistory = require("./personalHistory");
const standings = require("./standings");
const moderation = require("./moderation");
const registration = require("./registration");
const templates = require("./templates");
const topLock = require("./topLock");
const loopGuard = require("./loopGuard");
const mediaHealth = require("./mediaHealth");
let sharp;
try {
  sharp = require("sharp");
  // ✅ كل صورة تُعالج مرة وحدة بس، فكاش sharp الداخلي ما يفيد ويحجز ذاكرة.
  // وخيط واحد لـlibvips: بسيرفر صغير (Render) os.cpus() يعرض أنوية
  // الجهاز المضيف كلها فيفتح خيوط كثيرة تتزاحم على معالج ضئيل
  sharp.cache(false);
  sharp.concurrency(1);
} catch (e) { sharp = null; }
// هامش زمني ثابت وصغير (مو متغيّر أو متوقّع) نطرحه من وقت أي إجابة، تعويض
// تقريبي بسيط لزمن وصول رسالة السؤال قبل ما يبدأ المتسابق يقرأها. متعمد
// إنه رقم ثابت صغير (مو تخمين ديناميكي) عشان يبقى الوقت المعروض ثابت
// ويعتمد على، بدل ما يتقلب حسب سرعة السيرفر اللحظية (خصوصاً بسيرفرات
// مجانية زي Render ممكن تتأخر لحظياً وتشوّه أي تخمين ديناميكي)
const NETWORK_OVERHEAD_MS = 500;

// ⏳ أقصى انتظار لرسالة تأكيد الإجابة قبل ما نكمل للسؤال التالي. السؤال التالي
// كان ينتظر وصول رسالة التأكيد (وممكن تعلق لين 40 ثانية لو شبكة واتساب تدهورت)،
// فكل المسابقة تتجمد. بالوضع الطبيعي الرسالة توصل بأقل من ثانية والسلوك ما يتغيّر
const CONFIRM_WAIT_MS = 4000;
// أقل وقت (الظاهر للاعب، بعد الخصم) نعتبره واقعي لإنسان — أقل منه ما يتسجل بالتوب. يختلف حسب الفقرة
const MIN_PLAUSIBLE_ELAPSED_MS = {
  writing: 500, // الكتابة
  images: 600, // الصور
  questions: 600, // الأسئلة
  counts: 1000, // التعداد
  dismantle: 700, // التفكيك
  // بقية الفقرات (عكس، ترتيب، تكرار)
  default: 600,
};

// ⏹️ إنهاء تلقائي: لو السؤال الحالي مرّ عليه دقيقتين بدون أي إجابة صحيحة (ولا جزء منها)
// تنتهي المسابقة وتنعرض النتيجة — عشان ما تبقى مسابقة منسية شغالة. تنطبق على كل
// الأنواع (فنش/مستمرة/عدد أسئلة...) ما عدا التقديم البسيط. قابل للتغيير بمتغير IDLE_END_MS
const IDLE_END_MS = Number(process.env.IDLE_END_MS) > 0 ? Number(process.env.IDLE_END_MS) : 2 * 60 * 1000;
function waitAtMost(promise, ms) {
  let timer;
  let timedOut = false;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, ms);
  });
  // لو فشل الإرسال بعد انتهاء المهلة، نسجله بس (ما يصير unhandledRejection)
  promise.catch((e) => {
    if (timedOut) console.error("⚠️ فشل إرسال متأخر (بعد انتهاء مهلة الانتظار):", e && e.message);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 🏁 وضع .بدء_فنش: فقرات الدورة (كتابة، صور، سستع = أسئلة+تعداد بالتناوب)
const FINISH_SECTIONS = ["writing", "images", "mix"];
const FINISH_SECTION_LABELS = { writing: "كتابة", images: "صور", mix: "سستع" };

// يوزّع الهدف على الفقرات: كل فقرة round(الهدف/عدد الفقرات) والأخيرة تاخذ الباقي
// (مثال 20 على 3 = 7,7,6) ثم يخلطها عشوائياً على الفقرات
function splitFinishShares(target, sections) {
  const base = Math.max(1, Math.round(target / sections));
  const shares = Array(sections - 1).fill(base);
  shares.push(Math.max(1, target - base * (sections - 1)));
  return shuffle(shares);
}

// ⏱️ توقيتات وضع .بدء_فنش
// انتظار بعد اسم الفقرة / بعد قائمة النتائج / بعد السكب قبل الرسالة اللي بعدها:
// 3.5 ثانية لو الفنش همزات (اللاعبين يحتاجون وقت يقرأون النمط)، و2.5 ثانية للفنش العادي
const FINISH_STEP_DELAY_HAMZA_MS = 3000;
const FINISH_IMAGE_DELAY_HAMZA_MS = 1800;
const FINISH_IMAGE_DELAY_NORMAL_MS = 1500;
const FINISH_STEP_DELAY_NORMAL_MS = 2700;
const FINISH_SECTION_CHANGE_DELAY_MS = 1000; // بعد القائمة لما الفقرة تتغير: ثانية وحدة قبل اسم الفقرة الجديدة
const HAMZA_SWITCH_CONTINUE_DELAY_MS = 1000; // بعد رسالة تغيير النمط (الهمزات/الإلغاء): ثانية وحدة قبل *نكمل*
const HAMZA_SWITCH_AFTER_CONTINUE_MS = 3000; // بعد *نكمل*: 3 ثواني قبل السؤال (أو ثانية لو الفقرة بتتغير)
const FINISH_SKIP_MS = 7 * 1000; // بدون أي إجابة: سكب تلقائي
const FINISH_END_MS = 2 * 60 * 1000; // دقيقتين بدون أي إجابة: إنهاء تلقائي
const EXTEND_WINDOW_MS = 15 * 60 * 1000; // بعد نهاية الفنش: 15 دقيقة يبقى مستعد لأمر .تمديد، بعدها يتحرر من الذاكرة
const FINISH_LATER_CYCLES_FACTOR = 0.7; // من الدورة الثانية: حدود تغيير الفقرة 70% من الأصلية (ثابتة لبقية الدورات)
const FINISH_SECTION_CAP_BONUS = 2; // زيادة ثابتة على حد نقاط الفقرة (نقاط الشخص ما تتأثر)
const PAUSE_MAX_MS = 2 * 60 * 60 * 1000; // مسابقة موقوفة (.وقف) ولا أحد كمّل بعد ساعتين: تنتهي تلقائياً (ما تبقى معلّقة بالذاكرة)
const FINISH_MAX_SKIPS = 3; // 3 سكبات ورا بعض (بدون أي إجابة بينها): إنهاء تلقائي

// أنواع الفقرات المدعومة
const POOL_TYPES = ["writing", "images", "questions", "counts"];

// ➕ فنش منتهي ينتظر .تمديد: chatId -> { contest, timer }. واحد لكل قروب بالأكثر، يتحرر بعد 15 دقيقة،
// أو أول ما يبدأ أي تقديم/فنش جديد بنفس القروب (constructor الـContest)، أو لما ينفّذ التمديد
const extendable = new Map();
function dropExtendable(chatId) {
  const e = extendable.get(chatId);
  if (!e) return;
  clearTimeout(e.timer);
  extendable.delete(chatId);
}
function rememberExtendable(contest) {
  dropExtendable(contest.chatId);
  const timer = setTimeout(() => {
    const cur = extendable.get(contest.chatId);
    if (cur && cur.contest === contest) extendable.delete(contest.chatId);
  }, EXTEND_WINDOW_MS);
  if (timer.unref) timer.unref();
  extendable.set(contest.chatId, { contest, timer });
}
// يسحب الفنش المنتهي القابل للتمديد (ويشيله من السجل). null لو ما فيه
function takeExtendable(chatId) {
  const e = extendable.get(chatId);
  if (!e) return null;
  dropExtendable(chatId);
  return e.contest;
}

class Contest {
  constructor(chatId, sock, contestType, target, options = {}) {
    dropExtendable(chatId); // بدء أي تقديم/فنش جديد بالقروب = ينتهي استعداد الفنش السابق للتمديد
    this.chatId = chatId;
    this.client = sock; // Baileys socket
    this.contestType = contestType; // 'general' | 'writing' | 'images' | 'questions' | 'counts'
    this.target = target; // النقاط المطلوبة للفوز (Infinity للمسابقات المستمرة)
    this.scores = new Map(); // userId -> points
    this.active = true;
    this.currentRound = null;
    this.nameCache = new Map(); // userId -> اسم للعرض (pushName)
    this.remindedUsers = new Set(); // شخوص ذكّرناهم بالتسجيل (مرة وحدة بس)
    this.remindedMobileOnly = new Set(); // شخوص حذّرناهم إنها مسابقة جوالات بس (مرة وحدة بس)
    // خيارات خاصة:
    this.finishMode = !!options.finishMode; // 🏁 .بدء_فنش: بدون وقت ولا تسجيل، قائمة نقاط بعد كل سؤال، فقرات تتبدل تلقائياً
    this.practiceMode = !!options.practiceMode; // تقديم بسيط، جولة وحدة، بدون تسجيل بـ.توب/.سجل
    this.endless = !!options.endless; // مسابقة مستمرة، ما تتوقف تلقائياً عند الهدف
    this.mobileOnly = !!options.mobileOnly; // بس المسجلين كجوال يقدرون يشاركون
    this.fixedWordCount = options.fixedWordCount || null; // عدد كلمات ثابت لفقرة الكتابة
    this.roundsTarget = options.roundsTarget || null; // عدد أسئلة إجمالي تنتهي عنده المسابقة (بغض النظر مين جاوب)
    this.roundsCompleted = 0; // عدّاد الأسئلة اللي خلصت (إجابة صحيحة أو سكب)
    this.nextRoundTimer = null; // ✅ حفظ رقم Timer عشان نلغيه لاحقاً
    this.idleTimer = null; // مؤقت الإنهاء التلقائي لو ما أحد جاوب
    this.roundWatchdog = null; // مؤقت حراسة: ينبّه لو سؤال "علق" بدون أي رد لفترة طويلة
    // 🔤 وضع الهمزات الإلزامي (.فنش 20 همزات وأمثالها): أول محاولة إجابة
    // من كل شخص بكل جولة لازم تكون بإطار همزات محدد (يحدده اللي بدأ
    // المسابقة بعد ما نطلبه). تصحيح برسالة ثانية يشتغل عادي بدون همزات
    this.hamzaMode = !!options.hamzaMode;
    this.hamzaPattern = null; // { prefix, suffix } بعد ما يتحدد
    this.awaitingHamzaFrom = null; // senderId اللي المفروض يحدد النمط
    this.pendingStart = null; // دالة نناديها فور ما يتحدد النمط (تبدأ أول سؤال فعليًا)
    // ✅ لمسابقة "عامة" بفقرات مختارة يدويًا (مو بالضرورة الأربعة
    // التقليدية) — لو موجودة، pickPoolType يختار عشوائي من هذي القائمة
    // بس بدل POOL_TYPES الافتراضية
    this.allowedPoolTypes = options.allowedPoolTypes || null;
    if (this.finishMode) this._finishStartCycle(true);
  }

  pickPoolType() {
    if (this.finishMode) return this._finishPoolType();
    if (this.contestType === "general") {
      return pickRandom(this.allowedPoolTypes || POOL_TYPES);
    }
    return this.contestType;
  }

  // يجيب عنصر من مجموعة بيانات (صور/أسئلة/تعداد) بقفل تكرار لكل قروب على حدى
  // (usedStore): أي سؤال انرسل بهذا القروب ما يتكرر فيه إلا لما تخلص كل
  // أسئلة الفقرة، وقتها تبدأ له دورة جديدة عشوائية (القروبات الثانية ما تتأثر). الصور مقفولة "حسب الإجابة"
  // (صور مختلفة بنفس الإجابة = سؤال واحد، شوف answerGroups.js)
  // 🔒🔒 قفل داخل قفل: بعد ما يتحدد "سؤال" الصورة (مجموعة الإجابة)، نختار منه صورة ما انعرضت قبل بهذا القروب
  _pickImageVariant(pool, keyFn, item) {
    if (!item) return item;
    const k = keyFn(item);
    const group = pool.filter((it) => keyFn(it) === k);
    return usedStore.pickWithin("images_var", group, this.chatId) || item;
  }

  pickItem(poolType) {
    let pool;
    if (poolType === "images") pool = store.getImages();
    else if (poolType === "questions") pool = store.getQuestions();
    else if (poolType === "counts") pool = store.getCounts();

    if (!pool || pool.length === 0) return null;
    const keyFn = poolType === "images" ? imageKeyFn(pool) : (it) => it.id;
    if (this.finishMode) {
      // 🏁 بالفنش: صورة/سؤال/تعداد ما يتكرر أبداً داخل نفس الفنش بنفس القروب. القفل العادي لحاله ما يضمن هذا:
      // لو خلص البنك بنص الفنش ينصفّر القفل ويقدر يرجع شي انعرض قبل. فنتذكر اللي طلع بهذا الفنش ونستبعده
      const seenAll = this._finishSeen || (this._finishSeen = {});
      const seen = seenAll[poolType] || (seenAll[poolType] = new Set());
      let item = usedStore.pick(poolType, pool, keyFn, seen, this.chatId);
      if (!item) {
        // البنك كله طلع بهذا الفنش (البنك أصغر من طول الفنش) — ما فيه حل غير نبدأ دورة جديدة
        console.log(`🔁 فنش: انعرض كل بنك (${poolType}) بالقروب ${this.chatId} — دورة جديدة للضرورة.`);
        seen.clear();
        item = usedStore.pick(poolType, pool, keyFn, undefined, this.chatId);
      }
      if (item) seen.add(keyFn(item));
      return poolType === "images" ? this._pickImageVariant(pool, keyFn, item) : item;
    }
    const picked = usedStore.pick(poolType, pool, keyFn, undefined, this.chatId); // قفل لهذا القروب بس
    return poolType === "images" ? this._pickImageVariant(pool, keyFn, picked) : picked;
  }

  // فقرة الكتابة: يسحب 1-3 كلمات من بنك كلمات واحد بنفس نظام الوزن
  // المتناقص العالمي (chosenKeys يمنع بس تكرار نفس الكلمة داخل هذي
  // الجولة الواحدة، مالها علاقة بتتبع الاستخدام عبر الزمن). كل كلمة لها
  // صيغ مقبولة (aliases)، ولازم كلها تنكتب (بأي رسالة، بأي ترتيب، حتى لو
  // وسط كلام زيادة) عشان تفوز بالجولة
  //
  // ✅ استبعاد صارم إضافي: بس لجولات "كلمة وحدة" (مو 2-3 كلمات مع بعض —
  // هذي احتمال تكرارها بنفس المسابقة شبه معدوم أصلاً فما تحتاج استبعاد
  // صارم)، نفس الكلمة ما تتكرر إطلاقاً طول عمر هذي المسابقة
  // سحب بقفل القروب، وبالفنش نضيف استبعاد صارم لكل ما طلع داخل نفس الفنش (حتى لو بدأت دورة جديدة بنص الفنش)
  _strictPick(name, pool, keyFn, exclude) {
    if (!this.finishMode) return usedStore.pick(name, pool, keyFn, exclude, this.chatId);
    const seenAll = this._finishSeen || (this._finishSeen = {});
    const seen = seenAll[name] || (seenAll[name] = new Set());
    const combined = new Set(seen);
    if (exclude) for (const k of exclude) combined.add(k);
    let item = usedStore.pick(name, pool, keyFn, combined, this.chatId);
    if (!item) {
      seen.clear(); // البنك كله طلع بهذا الفنش، دورة جديدة للضرورة
      item = usedStore.pick(name, pool, keyFn, exclude, this.chatId);
    }
    if (item) seen.add(keyFn(item));
    return item;
  }

  pickWritingRound(forcedCount) {
    const pool = store.getWords(); // array of { word: ["لوفي","luffy", ...] }
    if (!pool || pool.length === 0) return null;

    // مفتاح ثابت لكل كلمة: أول صيغة (aliases[0])
    const keyFn = (it) => it.word[0];

    const desired = forcedCount || Math.floor(Math.random() * 3) + 1;
    const count = Math.min(desired, pool.length);

    // كل كلمة تنسحب تنقفل عالمياً (فقرة "writing")، وchosen يمنع تكرارها
    // داخل نفس الجولة حتى لو بدأت دورة جديدة بنصف الجولة
    const chosen = new Set();
    const result = [];
    for (let i = 0; i < count; i++) {
      const item = this._strictPick("writing", pool, keyFn, chosen);
      if (!item) break;
      chosen.add(keyFn(item));
      result.push(item.word);
    }
    return result.length > 0 ? result : null; // مصفوفة مصفوفات (slots)
  }

  // فقرة التكرار: تسحب كلمتين لأربع كلمات (أو عدد ثابت لو محدد عبر
  // .مستك <رقم>) من نفس بنك كلمات فقرة الكتابة (data/words.json)، وتعطي
  // كل كلمة عدد تكرار عشوائي مستقل بين 2 و5. الفايز لازم يكتب كل كلمة
  // العدد المطلوب بالضبط (زيادة أو نقصان = غلط)، بمسافات بينها، كلهم
  // برسالة وحدة (مو متراكمة عبر أكثر من رسالة زي فقرة الكتابة العادية)
  pickRepeatRound(forcedCount) {
    const pool = store.getWordsRepeat();
    if (!pool || pool.length === 0) return null;

    const keyFn = (it) => it.word[0];
    const desired = forcedCount || Math.floor(Math.random() * 3) + 2; // 2..4
    const count = Math.min(desired, pool.length);

    const chosenKeys = new Set();
    const result = [];
    for (let i = 0; i < count; i++) {
      const item = this._strictPick("repeat", pool, keyFn, chosenKeys);
      if (!item) break;
      chosenKeys.add(keyFn(item));
      const repeatCount = Math.floor(Math.random() * 3) + 2; // 2..4
      result.push({ word: item.word, repeatCount });
    }

    return result.length > 0 ? result : null;
  }

  // يرسل نص عادي، ويرجع كائن الرسالة المُرسلة (نحتاج توقيتها لحساب الوقت بدقة)
  async sendChat(text) {
    return this.client.sendMessage(this.chatId, { text });
  }

  // يرد كـ Reply/Quote فعلي على رسالة معينة (عشان نعرف مع مين، حتى لو فيه
  // أكثر من شخص يجاوب بنفس الوقت)
  async replyTo(msg, text) {
    return this.client.sendMessage(this.chatId, { text }, { quoted: msg });
  }

  // تفاعل ✅ على رسالة معينة (لتأكيد فوري بدون تزحيم الشات)
  async reactCheck(msg) {
    try {
      await this.client.sendMessage(this.chatId, { react: { text: "✅", key: msg.key } });
    } catch (e) {
      /* تجاهل لو فشل التفاعل */
    }
  }

  // يجهّز محتوى الصورة (قراءة ← تصغير). مفصولة عن الإرسال عشان نقدر
  // نجهّز صورة السؤال القادم بالخلفية أثناء ما المتسابقين يجاوبون على
  // السؤال الحالي، فتطلع الصورة فور بدء الجولة بدل ما ننتظر المعالجة
  async _prepareImage(file) {
    const tag = (stage, err) => Object.assign(new Error(`${stage}: ${err.message}`), { stage, cause: err });

    let imageBuffer;
    try {
      if (typeof file === "string" && file.startsWith("cloud:")) {
        imageBuffer = await cloudImages.fetchImage(file.slice(6)); // ☁️ صورة من Cloudinary
      } else {
        const imagePath = store.resolveImagePath(file);
        if (!imagePath) throw new Error(`الملف غير موجود: ${file}`);
        imageBuffer = await fs.promises.readFile(imagePath); // غير متزامن: ما يوقف باقي الرسائل
      }
      if (!imageBuffer.length) throw new Error("الملف فاضي (0 بايت)");
    } catch (err) {
      throw tag("read", err);
    }

    let content = { image: imageBuffer, mimetype: "image/jpeg" };
    if (sharp) {
      try {
        // نصغّر الصورة شوي عشان تتحمل بسرعة. بدون progressive (أبطأ
        // بالترميز وما يفيد، واتساب يعيد ضغط الصورة أصلاً)
        const resized = await sharp(imageBuffer, { sequentialRead: true })
          .rotate()
          .resize(1000, 1000, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
        // thumbnail يدوي — يظهر فوراً بدون "تالف"
        const thumb = await sharp(resized).resize(120, 120, { fit: "cover" }).jpeg({ quality: 60 }).toBuffer();
        content = { image: resized, jpegThumbnail: thumb, mimetype: "image/jpeg" };
      } catch (err) {
        console.error(`⚠️ sharp فشل مع ${file} — نرسل الصورة الأصلية بدون تصغير:`, err.message);
      }
    }
    return content;
  }

  // يرسل صورة السؤال (المحتوى جاهز مسبقاً لو الجلب المسبق نجح). الإرسال
  // نعيده حتى مرتين لو كان العطل مؤقت بالاتصال
  async _sendImageQuestion(file) {
    const tag = (stage, err) => Object.assign(new Error(`${stage}: ${err.message}`), { stage, cause: err });

    let content;
    const pre = this._prefetched;
    this._prefetched = null; // نفرّغ المرجع دايماً — ما نحتفظ بالصورة بالذاكرة بعد استخدامها
    if (pre && pre.file === file) {
      content = await pre.promise; // لو فشل التجهيز المسبق يرمي نفس خطأ المرحلة الأصلية
    } else {
      content = await this._prepareImage(file);
    }

    let lastErr;
    const trySend = async (attempt) => {
      try {
        return { ok: true, res: await this.client.sendMessage(this.chatId, content) };
      } catch (err) {
        lastErr = err;
        // نطبع تفاصيل السبب الحقيقي (كان يطبع الرسالة بس) عشان نعرف وش اللي يفشل بالضبط
        const extra = [
          err && err.code ? `code=${err.code}` : "",
          err && err.output && err.output.statusCode ? `status=${err.output.statusCode}` : "",
          err && err.cause && err.cause.message ? `cause=${err.cause.message}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        console.error(`⚠️ إرسال ${file} فشل (محاولة ${attempt}/3):`, err && err.message, extra);
        return { ok: false };
      }
    };

    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await trySend(attempt);
      if (r.ok) return r.res;
      if (attempt < 2) await new Promise((res) => setTimeout(res, 1500));
    }
    // محاولتين فشلوا: غالباً رفع الميديا عالق بالسوكت (النصوص تمشي والصور لا) — نعيد الاتصال
    // تلقائياً (نفس الجلسة) ونحاول مرة أخيرة بالسوكت الجديد. شوف mediaHealth.js
    const recovered = await mediaHealth.requestRecovery(file).catch(() => false);
    if (recovered && this.active) {
      const r = await trySend(3);
      if (r.ok) return r.res;
    }
    throw tag("send", lastErr);
  }

  // 🚀 جلب مسبق: نقرر نوع الجولة القادمة من الحين، ولو صور نجهّز صورتها
  // بالخلفية. نحتفظ بصورة وحدة بس كحد أقصى، وتنمسح فور استخدامها أو
  // عند انتهاء المسابقة (ما يتراكم شي)
  _planNextRound() {
    if (this.practiceMode || this.finishMode || !this.active) return;
    try {
      const nextType = this.pickPoolType();
      this._plannedPoolType = nextType;
      if (nextType !== "images") return;
      const item = this.pickItem("images");
      if (!item) return;
      this._plannedImageItem = item;
      const promise = this._prepareImage(item.file);
      promise.catch(() => {}); // الخطأ يُعالج وقت الاستخدام الفعلي
      this._prefetched = { file: item.file, promise };
    } catch (e) {
      this._plannedPoolType = null;
      this._plannedImageItem = null;
      this._prefetched = null;
    }
  }

  _clearPlanned() {
    // صورة انحجزت للجولة القادمة ولا انرسلت (انتهت/انلغت المسابقة): نفك قفلها
    // عشان ما تنحسب مستخدمة وهي ما ظهرت لأحد
    if (this._plannedImageItem) {
      const imgs = store.getImages();
      if (imgs && imgs.length) {
        usedStore.release("images", imageKeyFn(imgs)(this._plannedImageItem), this.chatId);
        usedStore.release("images_var", this._plannedImageItem.id, this.chatId);
      }
    }
    this._plannedPoolType = null;
    this._plannedImageItem = null;
    this._prefetched = null;
  }

  // يبدأ جولة جديدة
  async nextRound() {
    if (!this.active) return;
    if (this.paused) return; // موقوفة (.وقف): .كمل هو اللي يجدول السؤال الجاي

    // 🔀 تحويل الفنش بين عادي/همزات (.همزات / .الغ) — يتطبق بين سؤالين، بدون ما يمس الحسبة أو الفقرات
    if (this.finishMode && this.fm && this.fm.pendingHamza !== undefined) {
      await this._applyFinishHamzaSwitch();
      if (!this.active || this.paused) return; // لو انوقفت (.وقف) أثناء التحويل: .كمل يجدول السؤال
    }

    // 🏁 إعلان اسم الفقرة (*كتابة* / *صور* / *سستع*) قبل أول سؤال منها
    if (this.finishMode && this.fm.announce) {
      this.fm.announce = false;
      try {
        await this.sendChat(`*${FINISH_SECTION_LABELS[this.fm.order[this.fm.idx]]}*`);
      } catch (e) {
        console.error("⚠️ فشل إرسال اسم الفقرة (نكمل):", e && e.message);
      }
      // انتظار بين اسم الفقرة والسؤال (3.5 ثانية همزات / 2.5 عادي) — عشان يلاحظه اللاعبون قبل ما ينزل السؤال
      await new Promise((r) => setTimeout(r, this._finishStepDelay()));
      if (!this.active) return;
    }

    const poolType = this._plannedPoolType || this.pickPoolType();
    this._plannedPoolType = null;
    let slots, required, points, questionText, label, repeatCounts, altAnswers;

    if (poolType === "repeat") {
      const picks = this.pickRepeatRound(this.fixedWordCount);
      if (!picks) {
        await this.sendChat(`⚠️ ما فيه كلمات بملف data/words.json. أضف كلمات أول.`);
        return;
      }
      slots = picks.map((p) => p.word);
      repeatCounts = picks.map((p) => p.repeatCount);
      required = slots.length;
      points = 1;
      label = picks.map((p) => `${p.word[0]}(${p.repeatCount})`).join(" ");
    } else if (poolType === "writing") {
      slots = this.pickWritingRound(this.fixedWordCount);
      if (!slots) {
        await this.sendChat(`⚠️ ما فيه كلمات بملف data/words.json. أضف كلمات أول.`);
        return;
      }
      required = slots.length;
      points = 1;
      label = slots.map((s) => s[0]).join("، ");
    } else if (poolType === "dismantle" || poolType === "reverse" || poolType === "scramble") {
      // ✅ ثلاث فقرات مبنية على نفس بنك كلمات فقرة الكتابة (data/words.json)
      // — تفكيك (اكتب الحروف مفصولة)، عكس (اعكس الكلمة)، ترتيب (رتّب حروف
      // مبعثرة). كل جولة تسحب كلمة بنظام الوزن المتناقص العالمي، + استبعاد
      // صارم على مستوى هذي المسابقة بالذات (نفس أسلوب pickItem بالضبط)
      const wordPool = store.getWords();
      if (!wordPool || wordPool.length === 0) {
        await this.sendChat(`⚠️ ما فيه كلمات بملف data/words.json. أضف كلمات أول.`);
        return;
      }
      // قفل تكرار لكل قروب على حدى لكل فقرة من الثلاث (شوف usedStore.js)
      const wordItem = this._strictPick(poolType, wordPool, (it) => it.word[0], undefined);
      const rawWord = wordItem.word[0].replace(/\s+/g, ""); // نشيل المسافات (لو الاسم أكثر من كلمة) عشان الفقرات الثلاث تشتغل على كلمة مصمتة
      points = 1;
      required = 1;
      if (poolType === "dismantle") {
        questionText = rawWord;
        label = rawWord.split("").join(" "); // "س ا س ك ي"
      } else if (poolType === "reverse") {
        questionText = rawWord;
        label = [...rawWord].reverse().join("");
      } else {
        // ترتيب: نبعثر الحروف بترتيب عشوائي مختلف عن الأصل (لو أمكن)،
        // ونعرضها مفصولة بمسافات (زي "ا ج ن") — الإجابة تبقى الكلمة
        // متلاصقة عادي ("جان")
        let scrambled = rawWord;
        if (rawWord.length > 1) {
          let attempts = 0;
          do {
            scrambled = shuffle(rawWord.split("")).join("");
            attempts++;
          } while (scrambled === rawWord && attempts < 10);
        }
        questionText = scrambled.split("").join(" ");
        label = rawWord;
      }
      slots = [[label]];
    } else {
      let item;
      if (poolType === "images" && this._plannedImageItem) {
        item = this._plannedImageItem;
        this._plannedImageItem = null;
      } else {
        item = this.pickItem(poolType);
      }
      if (!item) {
        await this.sendChat(`⚠️ ما فيه أسئلة متوفرة لفقرة "${poolType}". أضف بيانات بملف data/${poolType}.json`);
        return;
      }
      points = item.points || 1;
      questionText = item.question;

      // صورة بإجابتين أو أكثر (type: "count" أو answers مصفوفة مصفوفات): تنعامل مثل سؤال التعداد
      const multiImage = poolType === "images" && (item.type === "count" || Array.isArray(item.answers[0]));
      if ((poolType === "questions" && item.type === "count") || multiImage) {
        slots = item.answers;
        required = item.required;
        altAnswers = multiImage && Array.isArray(item.alt) ? item.alt : null;
        label = item.answers.map((a) => a[0]).join("، ");
      } else if (poolType === "counts") {
        slots = item.answers;
        required = item.required;
        questionText = item.topic;
        label = item.answers.map((a) => a[0]).join("، ");
      } else {
        // صور أو سؤال عادي: إجابة وحدة، لكن نقبلها بأي مكان بالرسالة
        slots = [item.answers];
        required = 1;
        label = item.answers[0];
      }

      this._lastItem = item; // نحتاجه لإرسال الصورة
    }

    // نجهز الجولة ونعيّنها فوراً — قبل حتى ما نبدأ نرسل السؤال. هذا مهم
    // جداً: لو عيّنّاها بعد الإرسال، فيه احتمال (نادر بس حقيقي) إن رد
    // سريع جداً يوصل ويتعالج قبل ما تتعيّن الجولة، فتنرفض غلط. تعيينها
    // أول شي يضمن إنها جاهزة قبل ما يصل أي رد بالمرة
    const round = {
      poolType,
      slots,
      required,
      points,
      label, // "الإجابة" اللي تُعرض بلوحة الصدارة
      altAnswers,
      repeatCounts, // بس لفقرة "تكرار": عدد التكرار المطلوب بالظبط لكل عنصر بـslots
      startTime: Date.now(), // قيمة مؤقتة، تنستبدل تحت بتوقيت واتساب الفعلي
      finished: false,
      perUser: new Map(), // userId -> Set(فهارس) — مسار كل شخص مستقل تماماً
      perUserWords: new Map(), // تعداد فقط: userId -> Map(إجابة مركبة -> كلمات انكتبت منها) (يتصفّر مع الجولة)
    };
    this.currentRound = round;

    let sentMsg = null;

    // إرسال السؤال بحسب نوع الفقرة — سادة بدون أي نص زائد، بادئة "س/"
    // للأسئلة و"تع/" للتعداد بس (الكتابة والصور بدون بادئة إطلاقاً)
    if (poolType === "repeat") {
      const preview = slots.map((s, i) => `*${s[0]}(${repeatCounts[i]})*`).join(" ");
      sentMsg = await this.sendChat(preview);
    } else if (poolType === "writing") {
      // الكلمات بين نجمتين مع بعض بدون شرطات (*مايكي رايلي ساسكي*) — بكل المسابقات
      const preview = `*${slots.map((s) => s[0]).join(" ")}*`;
      sentMsg = await this.sendChat(preview);
    } else if (poolType === "images") {
      try {
        sentMsg = await this._sendImageQuestion(this._lastItem.file);
        this._imgFailStreak = 0;
      } catch (e) {
        this.currentRound = null;
        // نسجل السبب الحقيقي بالسجلات (مرحلة الفشل + رسالة الخطأ) بدل ما
        // نخفيه — الرسالة القديمة كانت تقول "ما قدرت أفتح الصورة" حتى لو
        // السبب انقطاع شبكة لحظي بالإرسال، والصورة نفسها سليمة
        console.error(`⚠️ فشل إرسال صورة ${this._lastItem.file} [مرحلة: ${e.stage || "غير معروفة"}]:`, e.cause || e);
        this._imgFailStreak = (this._imgFailStreak || 0) + 1;
        // بدل ما تتوقف المسابقة: نجرب صورة ثانية تلقائياً (حد أقصى 3 فشلات متتالية)
        if (this._imgFailStreak < 3 && this.active) {
          return this.nextRound();
        }
        this._imgFailStreak = 0;
        const why =
          e.stage === "read" ? "الملف غير موجود أو ما ينقرأ (تأكد من الاسم ومجلد data/images)"
          : e.stage === "send" ? "فشل الإرسال لواتساب (مشكلة اتصال مؤقتة غالباً)"
          : "مشكلة بمعالجة الصورة";
        await this.sendChat(`⚠️ تعذّر إرسال الصورة: ${this._lastItem.file}\nالسبب: ${why}`);
        return;
      }
    } else if (poolType === "questions") {
      sentMsg = await this.sendChat(`*س/ ${questionText}*`);
    } else if (poolType === "counts") {
      sentMsg = await this.sendChat(`*تع/ ${questionText}*`);
    } else if (poolType === "dismantle") {
      // اسم الفقرة يظهر بس لو المسابقة فيها أكثر من فقرة ممكنة (يعني
      // ممكن يجي بدلها فقرة ثانية)، عشان نفرّق بينها وبين بقية الفقرات.
      // لو حددت الفقرة لحالها (مباشرة أو باختيار وحيد من القائمة)، ما
      // فيه لبس أصلاً فترسل بدون اسم
      const showLabel = this.contestType === "general" && this.allowedPoolTypes && this.allowedPoolTypes.length > 1;
      sentMsg = await this.sendChat(showLabel ? `تفكيك\n\n*${questionText}*` : `*${questionText}*`);
    } else if (poolType === "reverse") {
      const showLabel = this.contestType === "general" && this.allowedPoolTypes && this.allowedPoolTypes.length > 1;
      sentMsg = await this.sendChat(showLabel ? `عكس\n\n*${questionText}*` : `*${questionText}*`);
    } else if (poolType === "scramble") {
      sentMsg = await this.sendChat(`*${questionText}*`);
    }

    // وقت البداية = لحظة تأكد إرسال السؤال فعلياً (بعد ما ينتهي الـ await)،
    // مباشرة وبدون أي تخمين أو تعديل إضافي — أثبت وأدق من محاولة توقع
    // "زمن شبكة" متغيّر. نعدّل نفس كائن الجولة (مو نستبدله) عشان أي رد
    // وصل بالفترة القصيرة اللي بين التعيين والإرسال يشوف نفس المرجع
    round.startTime = Date.now();
    round.startStall = loopGuard.stallEndingAt(round.startTime); // لو البوت تجمّد قبل هذا الختم مباشرة

    // مؤقت حراسة: لو ما صار أي رد (ولا حتى محاولة خطأ) خلال 20 ثانية،
    // على الأغلب الرسالة (سؤال/صورة) ما وصلت فعلياً لواتساب رغم إن سيرفرنا
    // ظن إنها انرسلت بنجاح — هذا وارد لو الاتصال متذبذب. بدل ما تفضل
    // المسابقة "عالقة" بصمت بدون أي تفسير، ننبّه القروب بوضوح. التقديم
    // البسيط مستثنى: مهمته يرسل الفقرة بس، بدون أي رسائل إضافية إطلاقاً
    this.clearRoundWatchdog();
    if (!this.practiceMode) {
      // بوضع الفنش ما فيه رسالة تحذير (السكب والإنهاء تلقائيين)
      if (!this.finishMode && !this.paused) this.roundWatchdog = setTimeout(() => {
        if (this.currentRound === round && !round.finished && this.active) {
          this.sendChat(
            "⚠️ يبدو إن السؤال الحالي ما وصل بشكل طبيعي (تأخير غير عادي بالاتصال). جرب .سكب للانتقال للسؤال التالي، أو .انهاء لو تبي توقف المسابقة."
          ).catch((e) => console.error("فشل إرسال تنبيه انتظار السؤال:", e));
        }
      }, 20000); // 20 ثانية
      this._planNextRound();
      if (this.finishMode) this._finishRoundStarted();
      else this._armIdleTimer();
    }
  }

  // (يعيد) تشغيل مؤقت الإنهاء التلقائي — يُنادى لما يبدأ سؤال، ولما أحد يحقق تقدم بالإجابة
  // ⏳ انتظار تحديد نمط الهمزات: لو محد حدده خلال IDLE_END_MS تنتهي المسابقة (كل الأنواع)
  _armHamzaWaitTimer() {
    if (this.paused) return;
    if (this.hamzaWaitTimer) clearTimeout(this.hamzaWaitTimer);
    this.hamzaWaitTimer = setTimeout(() => {
      this.hamzaWaitTimer = null;
      this._hamzaWaitExpired().catch((e) => console.error("⚠️ خطأ بإنهاء انتظار الهمزات:", e));
    }, IDLE_END_MS);
    if (this.hamzaWaitTimer.unref) this.hamzaWaitTimer.unref();
  }

  async _hamzaWaitExpired() {
    if (!this.active || !this.awaitingHamzaFrom) return;
    this.awaitingHamzaFrom = null;
    this.pendingStart = null;
    try {
      await this.sendChat("⏹️ تم إنهاء المسابقة تلقائياً لأنه ما أحد حدد نمط الهمزات لمدة دقيقتين.");
    } catch (e) {
      console.error("فشل إرسال رسالة إنهاء انتظار الهمزات:", e && e.message);
    }
    await this.endContest();
  }

  _armIdleTimer() {
    if (this.paused) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this._autoEndIdle().catch((e) => console.error("⚠️ خطأ بالإنهاء التلقائي:", e));
    }, IDLE_END_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  async _autoEndIdle() {
    const round = this.currentRound;
    if (!this.active || !round || round.finished) return;
    round.finished = true; // يمنع أي إجابة متأخرة تتداخل مع الإنهاء
    console.log(`⏹️ إنهاء تلقائي للمسابقة بالقروب ${this.chatId} (بدون إجابات)`);
    try {
      await this.sendChat("⏹️ تم إنهاء المسابقة تلقائياً لأنه ما أحد جاوب لمدة دقيقتين.");
    } catch (e) {
      console.error("فشل إرسال رسالة الإنهاء التلقائي:", e && e.message);
    }
    await this.endContest();
  }

  // يلغي مؤقت الحراسة الحالي (لو موجود) — يُستدعى كل ما جولة تخلص/تُسكب/تنتهي المسابقة
  clearRoundWatchdog() {
    if (this.hamzaWaitTimer) {
      clearTimeout(this.hamzaWaitTimer);
      this.hamzaWaitTimer = null;
    }
    if (this.finishMode && this.fm && this.fm.skipTimer) {
      clearTimeout(this.fm.skipTimer);
      this.fm.skipTimer = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.roundWatchdog) {
      clearTimeout(this.roundWatchdog);
      this.roundWatchdog = null;
    }
  }

  // يعالج رسالة واردة أثناء وجود جولة نشطة
  // msg: كائن رسالة Baileys الأصلي (نحتاجه للرد/الـ react)
  // text: النص المستخرج من الرسالة
  // senderId: آيدي الشخص المرسل (jid)
  async handleMessage(msg, text, senderId) {
    if (this.paused) return; // موقوفة (.وقف): ما نستقبل إجابات
    registration.touch(senderId); // مشاركة بمسابقة = نشاط (للتنظيف التلقائي للخاملين)
    // 🔤 لسا ننتظر اللي بدأ المسابقة يحدد نمط الهمزات — أي رسالة من شخص
    // ثاني نتجاهلها كليًا لين يوصلنا رد من نفس الشخص اللي بدأ
    if (this.awaitingHamzaFrom) {
      if (senderId !== this.awaitingHamzaFrom) return;
      const parsed = parseHamzaPattern(text);
      if (!parsed) {
        await this.replyTo(msg, "⚠️ لازم يكون فيه همزتين (ء) مختلفتين بالنص عشان أحدد الإطار. مثال: تءءت");
        return;
      }
      this.hamzaPattern = parsed;
      this.awaitingHamzaFrom = null;
      if (this.hamzaWaitTimer) { clearTimeout(this.hamzaWaitTimer); this.hamzaWaitTimer = null; }
      const starter = this.pendingStart;
      this.pendingStart = null;
      await this.sendChat(
        "✅ تم تحديد نمط الهمزات. أول محاولة إجابة من كل شخص بكل سؤال لازم تكون بنفس هذا الإطار — تصحيح برسالة ثانية يشتغل عادي بدون همزات."
      );
      if (starter) await starter();
      return;
    }

    if (!this.active || !this.currentRound || this.currentRound.finished) return;
    if (!text) return;
    if (moderation.isBanned(senderId, this.chatId)) return;

    // ✅ تجاهل رسائل السبام المكوّنة من حرف واحد بس (زي "ا" مكررة عدة
    // رسائل ورا بعض) — ما تقدر أصلاً تكون إجابة صحيحة لأي فقرة (المطابقة
    // بحدود الكلمة الكاملة، فحرف وحيد ما يطابق إجابة أطول أبدًا)، فتجاهلها
    // بدري يقلل الإزعاج والمعالجة الزايدة بدون فايدة. استثناء: نسمح بالأرقام
    // المفردة (زي "5")، لأن فيه سؤال إجابته رقم واحد بالضبط بالبنك الحالي
    const trimmedText = text.trim();
    if (trimmedText.length === 1 && !/[0-9٠-٩]/.test(trimmedText)) return;

    // ملاحظة: الحماية من تكرار معالجة نفس الرسالة (بيليز يعيد الحدث أحياناً)
    // انتقلت لملف index.js (alreadyProcessed) وصارت محدودة الحجم بشكل صحيح
    // هناك (آخر 500 رسالة). أزلنا النسخة القديمة من هنا لأنها كانت Set بدون
    // حد أقصى — تكبر للأبد طول عمر الكونتست وتسبب تسريب ذاكرة تدريجي بعد
    // أيام من التشغيل المستمر (بطء عام متزايد بمرور الوقت)

    // ✅ حماية دقة التوقيت: نتجاهل أي رسالة يكون توقيتها الحقيقي بواتساب
    // (messageTimestamp، بالثواني من سيرفر واتساب نفسه) قبل بداية الجولة
    // الحالية. هذا يحمينا من حالة نادرة بس حقيقية: بيليز أحياناً "يعيد
    // تشغيل" رسائل قديمة (مزامنة بعد انقطاع اتصال لحظي بالسيرفر)، فلو
    // صدف إن رسالة قديمة (قبل ما نرسل السؤال أصلاً) تطابق الإجابة بالغلط،
    // كانت تنحسب كـ"إجابة خارقة السرعة" (قريبة من 0 أو حتى قبل السؤال).
    // نسمح بهامش تسامح بسيط (2 ثانية) لفروقات الساعة الطبيعية بين
    // سيرفرنا وسيرفر واتساب، بدون ما نرفض ردود شرعية جاية بسرعة حقيقية
    const msgTsMs = Number(msg.messageTimestamp || 0) * 1000;
    if (msgTsMs && this.currentRound && msgTsMs < this.currentRound.startTime - 2000) {
      return;
    }

    // التقديم البسيط (معاينة/تجربة): مجاني للجميع بدون تسجيل ولا تحذير
    if (!this.practiceMode) {
      if (this.mobileOnly) {
        if (!registration.isMobile(senderId)) {
          if (!this.remindedMobileOnly.has(senderId)) {
            this.remindedMobileOnly.add(senderId);
            await this.replyTo(
              msg,
              "🚫 هذي مسابقة *جوالات بس*، ما تُحسب لك مشاركتك. اكتب .تسجيل جوال عشان تقدر تشارك وتنحسب لك النقاط."
            );
          }
          return;
        }
      } else {
        if (!registration.getType(senderId)) {
          if (!this.remindedUsers.has(senderId)) {
            this.remindedUsers.add(senderId);
            await this.replyTo(
              msg,
              "الرجاء قم بالتسجيل في البوت بـ .تسجيل جوال او .تسجيل خارجي"
            );
          }
          return;
        }
      }
    }

    // نخزن اسم العرض أول ما توصلنا رسالة منه (يفيدنا بالنتيجة النهائية)
    if (msg.pushName) this.nameCache.set(senderId, msg.pushName);

    const round = this.currentRound;

    // ✅ فقرة "تكرار" لها نظام تحقق مختلف تماماً عن باقي الفقرات: مو
    // تراكم عناصر عبر أكثر من رسالة (زي الكتابة)، كل رسالة لازم تكون
    // محاولة كاملة لحالها — تحتوي كل الكلمات المطلوبة، كل وحدة مكررة
    // العدد المطلوب بالضبط (زيادة أو نقصان = محاولة غلط بالكامل). لو
    // غلطت، الشخص يقدر يرسل رسالة جديدة كاملة ويحاول من جديد (نفس فكرة
    // "تصحيح برسالة ثانية" بباقي الفقرات، بس هنا المحاولة كلها من الصفر
    // مو تكملة الجزء الناقص بس)
    if (round.poolType === "repeat") {
      const tokens = text.trim().split(/\s+/).filter(Boolean);
      // ✅ تحقق صارم: عدد الكلمات بالرسالة لازم يطابق المجموع المطلوب
      // بالضبط (مجموع كل التكرارات). أي كلمة أو حرف زيادة (حتى لو كل
      // الكلمات المطلوبة موجودة وبالعدد الصحيح) يرفض المحاولة بالكامل —
      // قبل هذا الشرط، كان ممكن تمرر رسالة فيها كلام إضافي زيادة على
      // المطلوب وتُحسب صح غلط
      const totalNeeded = round.repeatCounts.reduce((a, b) => a + b, 0);
      let allMatch = tokens.length === totalNeeded;
      if (allMatch) {
        for (let i = 0; i < round.slots.length; i++) {
          const aliases = round.slots[i];
          const need = round.repeatCounts[i];
          let found = 0;
          for (const tok of tokens) {
            if (aliases.includes(tok)) found++;
          }
          if (found !== need) {
            allMatch = false;
            break;
          }
        }
      }
      if (allMatch) {
        await this.completeRound(msg, senderId, text);
      }
      return;
    }

    // كل شخص عنده مساره الخاص المستقل تماماً — إجابات شخص ثاني ما تأثر
    // على فرص هذا الشخص، وما تحجز عناصر تمنعه من إكمالها لحاله
    if (!round.perUser.has(senderId)) round.perUser.set(senderId, new Set());
    const userSet = round.perUser.get(senderId);

    // يدور داخل الرسالة عن أي عناصر صحيحة (من مساره الشخصي) لسا ما جابها،
    // حتى لو وسط كلام زيادة أو حروف ملتصقة أو أكثر من عنصر بنفس الرسالة.
    // كل الفقرات تستخدم تطبيع مرن (غ/ق/ج كحرف واحد) عدا الكتابة، اللي
    // لازم فيها تطابق حرفي كامل بدون تساهل
    // ✅ الكتابة و"عكس"/"ترتيب" تحتاج تطابق حرفي دقيق (بدون توحيد غ/ق/ج) —
    // عكس وترتيب نتائج محسوبة بالضبط (مو بنك إجابات متنوعة)، فلازم الدقة.
    // باقي الفقرات (صور/أسئلة/تعداد/تفكيك) تستخدم التطبيع المرن العادي
    const relaxed = !["writing", "reverse", "scramble"].includes(round.poolType);
    // 🔤 وضع الهمزات: أول محاولة (userSet فاضي) لهذا الشخص بهذي الجولة
    // لازم تكون بإطار الهمزات المحدد — لو ما طابقت الإطار، نتجاهل الرسالة
    // كليًا (كأنها ما كانت إجابة أصلاً). أي محاولة بعدها (تصحيح) تفحص عادي
    // ➕ جولة إجابتها اسم واحد (صورة/سؤال): لو أول محاولة مغلّفة غلط بس قريبة (30%+ من حروف الاسم)،
    // نفتح للشخص التصحيح بدون همزات (round.hamzaUnlocked) — الكتابة/التعداد ما تحتاجها (أول كلمة صح تفتح الباقي)
    let searchText = text;
    let framedAttempt = false;
    if (this.hamzaMode && this.hamzaPattern) {
      const unlocked = !!(round.hamzaUnlocked && round.hamzaUnlocked.has(senderId));
      if (userSet.size === 0 && !unlocked) {
        const unwrapped = unwrapHamza(text, this.hamzaPattern);
        if (unwrapped === null) return;
        searchText = unwrapped;
        framedAttempt = true;
      } else if (unlocked) {
        const unwrapped = unwrapHamza(text, this.hamzaPattern); // لو رجع يغلّف، نفك الإطار عادي
        if (unwrapped !== null) searchText = unwrapped;
      }
    }
    // تطبيع الإجابات المقبولة مرة وحدة لكل جولة (مو مع كل رسالة)
    if (!round.prepared) round.prepared = prepareSlots(round.slots, relaxed);
    if (round.altAnswers) {
      if (!round.altPrepared) round.altPrepared = prepareSlots([round.altAnswers], relaxed);
      if (findAllMatchesPrepared(searchText, round.altPrepared, new Set()).length > 0) {
        for (let i = 0; i < round.slots.length; i++) userSet.add(i);
        if (this.finishMode) this._finishProgress();
         await this.completeRound(msg, senderId, text);
         return;
      }
    }
    
    const newlyClaimed = findAllMatchesPrepared(searchText, round.prepared, userSet);
    // 🧩 تعداد: الإجابة المركبة (أكثر من كلمة) تكتمل بكلماتها المتفرقة (برسالة أو رسائل، بأي ترتيب) وتنحسب إجابة وحدة
    let wordProgress = false;
    if (round.poolType === "counts") {
      if (!round.wordPrepared) round.wordPrepared = prepareWordAliases(round.slots, relaxed);
      if (round.wordPrepared.list.length > 0) {
        let seenMap = round.perUserWords.get(senderId);
        if (!seenMap) round.perUserWords.set(senderId, (seenMap = new Map()));
        const already = new Set([...userSet, ...newlyClaimed]);
        const wp = findWordProgress(searchText, round.wordPrepared, already, seenMap);
        for (const idx of wp.claimed) newlyClaimed.push(idx);
        wordProgress = wp.progressed;
      }
    }
    if (newlyClaimed.length === 0 && wordProgress) {
      // كلمة صح من إجابة مركبة بدون ما تكتمل: تقدّم (يعيد عدّ مؤقتات الخمول/السكب)
      if (this.finishMode) this._finishProgress();
      else if (!this.practiceMode) this._armIdleTimer();
      return;
    }
    if (newlyClaimed.length === 0) {
      if (
        framedAttempt &&
        round.slots.length === 1 &&
        round.required === 1 &&
        !["writing", "counts", "repeat"].includes(round.poolType) &&
        isCloseToSingleName(searchText, round.prepared)
      ) {
        (round.hamzaUnlocked || (round.hamzaUnlocked = new Set())).add(senderId); // بدون أي رد (ما نعطي تلميح)
      }
      return;
    }

    for (const idx of newlyClaimed) userSet.add(idx);
    if (this.finishMode && newlyClaimed.length > 0) this._finishProgress(); // فيه تقدم: يصفّر عدّاد السكبات ويعيد المؤقتات
    if (!this.practiceMode && !this.finishMode && userSet.size < round.required) this._armIdleTimer(); // فيه تقدم: نعيد العدّ

    if (userSet.size >= round.required) {
      await this.completeRound(msg, senderId, text);
    }
  }

  addPoints(userId, points) {
    const current = this.scores.get(userId) || 0;
    this.scores.set(userId, current + points);
    return this.scores.get(userId);
  }

  async completeRound(msg, senderId, winningText) {
    const round = this.currentRound;
    round.finished = true;
    this.roundsCompleted += 1;
    this.clearRoundWatchdog();

    // حماية التايمر: نفس المعادلة بالضبط بدون أي تغيير، بس بحماية إضافية
    // ضد أي قيمة غير طبيعية (NaN/undefined/سالب) لو صار خلل غير متوقع —
    // بدل ما يطلع وقت "مقلتش" غريب للمستخدم، نرجع لقيمة آمنة (0) ونسجل
    // تحذير بالـ Logs عشان نلاحظه ونحقق فيه، بدون ما نغيّر شكل الحساب
    const arrivedAt = (msg && msg._recvAt) || Date.now();
    let rawElapsed = arrivedAt - round.startTime;
    if (!Number.isFinite(rawElapsed)) {
      console.warn(
        `⚠️ قيمة وقت غير طبيعية بجولة ${round.poolType} (startTime=${round.startTime}) — استخدمنا 0 كقيمة آمنة.`
      );
      rawElapsed = 0;
    }
    // 🛡️ تصحيح التجمّد: لو البوت تجمّد (GC/ضغط معالج) حول ختم البداية أو ختم وصول الرد،
    // الاثنين ينهارون على بعض ويطلع وقت وهمي (0.00). نصحّحه بتقدير ونعلّمها "مشكوك فيها"
    let stallMs = 0;
    try {
      const adj = loopGuard.adjustedElapsed(round.startTime, round.startStall, arrivedAt, msg && msg._recvStall);
      if (adj.stallMs > 0 && Number.isFinite(adj.raw)) {
        rawElapsed = adj.raw;
        stallMs = adj.stallMs;
      }
    } catch (e) {
      /* لو صار أي خلل نرجع للحساب القديم */
    }
    const arrivedBeforeStart = rawElapsed < 0; // الرد وصل قبل ختم البداية: مستحيل بدون تجمّد/تأخر ختم
    rawElapsed = Math.max(0, rawElapsed);
    // ننزل هامش ثابت وصغير بس (300 ملي ثانية) — تعويض بسيط لزمن وصول
    // رسالة السؤال، بدون أي تخمين متغيّر يقدر يشوّه الرقم. ما فيه حد
    // أدنى إضافي بعد كذا — لو طلعت 0.00 أو قريبة منها فهذا وقت حقيقي
    // (شخص جاوب بسرعة كبيرة فعلاً)، نعرضه زي ما هو بدون تثبيت
    const elapsed = Math.max(0, rawElapsed - NETWORK_OVERHEAD_MS);
    // ⚠️ نتيجة غير موثوقة للتسجيل بالتوب: متأثرة بتجمّد، أو وصلت قبل بداية السؤال، أو أسرع من
    // أي إنسان (أقل من الحد الأدنى لهذي الفقرة). تنحسب النقطة وتظهر للاعب عادي، بس ما تدخل لوحة
    // الصدارة ولا .نقاطي عشان ما يتلوث التوب بوقت وهمي
    const unreliable = stallMs > 0 || arrivedBeforeStart || elapsed < (MIN_PLAUSIBLE_ELAPSED_MS[round.poolType] ?? MIN_PLAUSIBLE_ELAPSED_MS.default);
    if (unreliable) {
      console.warn(
        `⚠️ نتيجة وقت غير موثوقة (جولة ${round.poolType}): ${formatSeconds(elapsed)}ث | تجمّد=${Math.round(stallMs)}ms | وصل قبل البداية=${arrivedBeforeStart} — انحسبت النقطة بدون تسجيل بالتوب.`
      );
    }
    if (process.env.TIMING_LOG === "1") {
      const lag = msg && msg.messageTimestamp ? Date.now() - Number(msg.messageTimestamp) * 1000 : null;
      console.log(
        `⏱️ جولة ${round.poolType}: خام=${rawElapsed}ms | داخل البوت=${Date.now() - arrivedAt}ms | عمر الرسالة بواتساب≈${lag === null ? "؟" : Math.round(lag / 1000) + "ث"}`
      );
    }

    const total = this.addPoints(senderId, round.points);

    // نسجل هذي النتيجة بلوحة الصدارة (أفضل الأوقات) — إلا لو تقديم بسيط
    // (تجربة/معاينة)، ما نحسبها بالمنافسة الرسمية. محاطة بحماية عشان لو
    // فشل التسجيل لأي سبب (مشكلة قاعدة بيانات لحظية)، ما توقف تقدم الجولة
    // 🔒 لو التوب مقفول (.قفل توب)، ما نسجل النتيجة بـ.توب ولا .نقاطي لين يتفتح
    if (!this.practiceMode && !this.finishMode && !topLock.isLocked() && !unreliable) {
      try {
        // ✅ للتعداد بس: بدل ما نعرض بلوحة الصدارة كل الإجابات المقبولة
        // مجمّعة (ممكن توصل 9+ عنصر وتشوّه شكل الرسالة)، نعرض نص رسالة
        // الفائز الفعلية اللي جاوب فيها — أوضح وأقصر، وهو اللي فعلاً جاوبه
        const displayAnswer = round.poolType === "counts" && winningText ? winningText.trim() : round.label;
        const entry = {
          userId: senderId,
          displayName: this.displayNameFor(senderId),
          elapsed,
          answer: displayAnswer,
          ts: Date.now(),
        };
        // عدد كلمات الجولة (للكتابة بس): يخلّي أمر الحذف الإداري يعرف يرجّع
        // أفضل نتيجة تالية للبنك الصحيح (.توب كت 1..5) بعد حذف نتيجة خاطئة
        if (round.poolType === "writing" && round.required >= 1 && round.required <= 5) entry.wc = round.required;
        leaderboard.record(round.poolType, entry);
        personalHistory.record(round.poolType, entry);
        // ✅ إضافي: لفقرة الكتابة بس، نسجل نفس النتيجة كمان ببنك منفصل
        // حسب عدد الكلمات بالضبط (round.required = عدد الكلمات بهذي
        // الجولة) — لأمر .توب كت <رقم> الجديد. ما يأثر على تسجيل
        // "writing" العادي فوق (أمر .توب كت الأصلي) إطلاقاً، هذا بنك ثاني
        // تماماً بس يشارك نفس بيانات هذي الجولة
        if (round.poolType === "writing" && round.required >= 1 && round.required <= 5) {
          leaderboard.record(`writing${round.required}`, entry);
        }
      } catch (e) {
        console.error("⚠️ خطأ تسجيل النتيجة بلوحة الصدارة (تجاهلناه، الجولة تكمل عادي):", e);
      }
    }

    const resultLabel = round.required > 1 ? `جمعت ${round.required} إجابات` : "إجابة صحيحة";

    // ✅ إصلاح مهم: نلف الإرسال بـ try/catch. قبل كذا، لو فشل إرسال رسالة
    // "إجابة صحيحة" لأي سبب (انقطاع لحظي بالاتصال)، الكود كان يتوقف هنا
    // تمامًا — يعني afterRoundWin() ما ينفّذ أبدًا، والسؤال التالي ما
    // ينجدول، وتفضل المسابقة "معلّقة" بصمت بدون أي تنبيه (لأن round.finished
    // صارت true من البداية، فمؤقت الحراسة ما يشتغل). النقطة كانت تنحسب
    // برضو (لأن addPoints فوق) بس بدون أي رسالة ولا استمرار — بالضبط
    // المشكلة اللي وصفتها. الحين: نحاول نرسل، ولو فشلت نسجلها بالـ logs
    // ونكمل عادي، عشان تقدم المسابقة ما يعتمد على نجاح رسالة تأكيد واحدة
    try {
      // التقديم البسيط: مهمته يرسل الفقرة بس، بدون أي رد أو رسالة تأكيد
      // إجابة إطلاقاً (لا وقت ولا نقاط ولا حتى "إجابة صحيحة")
      if (!this.practiceMode) {
        await waitAtMost(this.replyTo(msg, this.finishMode ? this._finishBoardText(senderId, total >= this.target) : `🎉 ${resultLabel}!\n\n⏱️ الوقت: ${formatSeconds(elapsed)} ثانية\n\n⭐ +${round.points} نقطة\n(المجموع: ${total})`), CONFIRM_WAIT_MS);
      }
    } catch (e) {
      console.error("⚠️ فشل إرسال رسالة الإجابة الصحيحة (تجاهلناه، الجولة تكمل عادي):", e);
    }

    // خارج الـ try عمدًا: لازم تشتغل دايمًا بغض النظر عن نجاح رسالة التأكيد
    await this.afterRoundWin(senderId, total);
  }

  // يجدول الجولة القادمة بعد تأخير، مع محاولة ثانية تلقائية لو فشلت
  // الأولى (عطل مؤقت بالشبكة مثلاً)، وتنبيه واضح للقروب لو فشلت الاثنتين
  // — بدل ما تفضل المسابقة "معلّقة" بصمت بدون أي توضيح لأي أحد
  scheduleNextRound(delayMs, context = "الجولة القادمة") {
    if (this.paused) return; // موقوفة (.وقف): .كمل يجدول بدالها
    this.nextRoundTimer = setTimeout(async () => {
      try {
        await this.nextRound();
      } catch (e1) {
        console.error(`⚠️ خطأ بـ${context} (محاولة أولى):`, e1);
        if (!this.active) return;
        this.nextRoundTimer = setTimeout(async () => {
          try {
            await this.nextRound();
          } catch (e2) {
            console.error(`⚠️ خطأ بـ${context} (محاولة ثانية، توقفنا):`, e2);
            try {
              await this.sendChat(
                "⚠️ صار خطأ متكرر أثناء تجهيز السؤال التالي، والمسابقة توقفت. جرب .انهاء وابدأها من جديد."
              );
            } catch (notifyErr) {
              console.error("فشل حتى إرسال رسالة تنبيه الخطأ:", notifyErr);
            }
          }
        }, 2000);
      }
    }, delayMs);
  }

  // أمر .سكب: يسكب (يتخطى) السؤال الحالي بدون ما يحسب نقاط لحد، يرسل
  // الإجابة الصحيحة، وينتقل للسؤال اللي بعده. يرجع true لو فيه سؤال
  // فعلاً انسكب، أو false لو ما فيه سؤال شغال أصلاً
  async skipRound(msg) {
    if (!this.active || !this.currentRound || this.currentRound.finished) return false;
    const round = this.currentRound;
    round.finished = true;
    this.roundsCompleted += 1;
    this.clearRoundWatchdog();
    // ✅ نفس إصلاح completeRound: فشل رسالة "تم سكب السؤال" ما لازم يوقف
    // انتقال المسابقة للسؤال التالي
    try {
      await waitAtMost(this.replyTo(msg, `⏭️ تم سكب السؤال.\n📝 الإجابة كانت: ${round.label}`), CONFIRM_WAIT_MS);
    } catch (e) {
      console.error("⚠️ فشل إرسال رسالة السكب (تجاهلناه، ننتقل للسؤال التالي عادي):", e);
    }

    if (this.practiceMode) {
      this.active = false;
      return true;
    }

    // مسابقة بعدد أسئلة إجمالي: السؤال المسكوب يُحسب من العدد برضو
    if (this.roundsTarget && this.roundsCompleted >= this.roundsTarget) {
      await this.endContest();
      return true;
    }

    const cfg = store.getConfig();
    this.scheduleNextRound(cfg.nextQuestionDelayMs || 1000, "الجولة القادمة بعد السكب");
    return true;
  }

  async afterRoundWin(senderId, total) {
    // تقديم بسيط: جولة وحدة بس، تنتهي بهدوء بدون رسالة "انتهت المسابقة"
    if (this.practiceMode) {
      this.active = false;
      return;
    }
    // مسابقة بعدد أسئلة إجمالي (.مسابقة <رقم>): تنتهي لما مجموع الأسئلة
    // اللي خلصت (بغض النظر مين جاوب) يوصل الرقم المطلوب
    if (this.roundsTarget && this.roundsCompleted >= this.roundsTarget) {
      await this.endContest();
      return;
    }
    // مسابقة مستمرة: ما تتوقف تلقائياً عند أي هدف، تستمر لحد أمر الإيقاف اليدوي
    if (!this.endless && total >= this.target) {
      if (this.finishMode) this._finishWinPending = true; // آخر فوز ما اتحسب بحدود الفقرة: يتحسب لو تمدد الفنش
      await this.endContest();
      return;
    }
    if (this.finishMode) this._finishAfterWin();
    const cfg = store.getConfig();
    this.scheduleNextRound(this.finishMode ? this._finishNextRoundDelay() : cfg.nextQuestionDelayMs || 1000, "الجولة القادمة");
  }

  // يعرض اسم العرض المخزن (لو موجود) وإلا رقم الشخص فقط
  // ═══ 🏁 وضع .بدء_فنش ═══
  // دورة = كل الفقرات بالترتيب: كتابة ← صور ← سستع، كل وحدة مرة. الانتقال لفقرة ثانية
  // يصير لما: (1) أحد المشاركين نقاطه (من بداية الدورة) توصل الحد التراكمي للفقرة (7 ثم 14 ثم 20
  // مثلاً لفنش 20)، أو (2) مجموع النقاط الموزعة بهذي الفقرة يوصل حد الفقرة (فنش 20 = 12).
  // بعد آخر فقرة والفنش ما انتهى: دورة جديدة بنفس الترتيب والحدود 70% من الأصلية (تقريب لأقرب رقم)، والـ70% تبقى لكل الدورات بعدها (حد نقاط الفقرة = نصف الهدف + 2 + 2 زيادة، ثم ×0.7 من الدورة الثانية)
  _finishStartCycle(first = false) {
    if (first) {
      this.fm = { cycle: 1, order: [], idx: 0, shares: [], cum: [], cap: 0, baseline: new Map(), sectionPoints: 0, announce: true, lastSection: null, mixNext: Math.random() < 0.5 ? "questions" : "counts", consecSkips: 0, skipTimer: null, endTimer: null };
    } else {
      this.fm.cycle += 1;
    }
    const fm = this.fm;
    // ترتيب ثابت بكل دورة: كتابة ← صور ← سستع
    fm.order = [...FINISH_SECTIONS];
    fm.idx = 0;
    const scale = fm.cycle >= 2 ? FINISH_LATER_CYCLES_FACTOR : 1; // من الدورة الثانية 70% ثابتة لبقية الدورات (ما تنقص مرة ثانية)
    fm.shares = splitFinishShares(this.target, fm.order.length).map((s) => Math.max(1, Math.round(s * scale)));
    fm.cum = [];
    let run = 0;
    for (const s of fm.shares) fm.cum.push((run += s));
    fm.cap = Math.max(1, Math.round((Math.round(this.target / 2 + 2) + FINISH_SECTION_CAP_BONUS) * scale)); // حد نقاط الفقرة (+2 فوق الأصلي)
    fm.baseline = new Map(this.scores); // لقطة نقاط الكل بداية الدورة
    fm.sectionPoints = 0;
    fm.announce = true;
  }

  _finishPoolType() {
    const sec = this.fm.order[this.fm.idx];
    if (sec === "writing") return "writing";
    if (sec === "images") return "images";
    const t = this.fm.mixNext; // سستع: مرة سؤال ومرة تعداد
    this.fm.mixNext = t === "questions" ? "counts" : "questions";
    return t;
  }

  _finishAfterWin() {
    this._finishWinPending = false;
    const fm = this.fm;
    const round = this.currentRound;
    fm.sectionPoints += (round && round.points) || 0;
    const i = fm.idx;
    let reason = null;
    if (fm.sectionPoints >= fm.cap) {
      reason = `حد الفقرة (${fm.sectionPoints}/${fm.cap})`;
    } else {
      for (const [uid, pts] of this.scores) {
        if (pts - (fm.baseline.get(uid) || 0) >= fm.cum[i]) {
          reason = `وصل مشارك لحد النقاط (${fm.cum[i]})`;
          break;
        }
      }
    }
    if (!reason) return;
    console.log(`🏁 فنش ${this.chatId}: انتقال من فقرة ${FINISH_SECTION_LABELS[fm.order[i]]} — ${reason}`);
    fm.lastSection = fm.order[i];
    fm.idx += 1;
    fm.sectionPoints = 0;
    if (fm.idx >= fm.order.length) this._finishStartCycle(false);
    else fm.announce = true;
  }

  // ⏱️ سكب/إنهاء تلقائي بوضع الفنش
  _finishRoundStarted() {
    this._finishArmSkip();
    if (!this.fm.endTimer) this._finishArmEnd();
  }

  _finishArmSkip() {
    if (this.paused) return;
    if (this.fm.skipTimer) clearTimeout(this.fm.skipTimer);
    this.fm.skipTimer = setTimeout(() => {
      this.fm.skipTimer = null;
      this._finishAutoSkip().catch((e) => console.error("⚠️ خطأ بالسكب التلقائي:", e));
    }, FINISH_SKIP_MS);
    if (this.fm.skipTimer.unref) this.fm.skipTimer.unref();
  }

  _finishArmEnd() {
    if (this.paused) return;
    if (this.fm.endTimer) clearTimeout(this.fm.endTimer);
    this.fm.endTimer = setTimeout(() => {
      this.fm.endTimer = null;
      this._finishAutoEnd("ما أحد جاوب لمدة دقيقتين").catch((e) => console.error("⚠️ خطأ بالإنهاء التلقائي:", e));
    }, FINISH_END_MS);
    if (this.fm.endTimer.unref) this.fm.endTimer.unref();
  }

  // أي تقدم بالإجابة (حتى جزء منها): يصفّر عدّاد السكبات المتتالية ويعيد مؤقتي السكب والإنهاء
  _finishProgress() {
    this.fm.consecSkips = 0;
    this._finishArmSkip();
    this._finishArmEnd();
  }

  _finishClearTimers() {
    if (!this.fm) return;
    if (this.fm.skipTimer) clearTimeout(this.fm.skipTimer);
    if (this.fm.endTimer) clearTimeout(this.fm.endTimer);
    this.fm.skipTimer = null;
    this.fm.endTimer = null;
  }

  // مدة الانتظار قبل نزول السؤال بوضع الفنش: 3 ثواني للهمزات، 2.5 للعادي؛ وفقرة الصور 2.5 للهمزات و2.2 للعادي
  _finishStepDelay() {
    const images = !!(this.fm && this.fm.order && this.fm.order[this.fm.idx] === "images");
    if (images) return this.hamzaMode ? FINISH_IMAGE_DELAY_HAMZA_MS : FINISH_IMAGE_DELAY_NORMAL_MS;
    return this.hamzaMode ? FINISH_STEP_DELAY_HAMZA_MS : FINISH_STEP_DELAY_NORMAL_MS;
  }

  // 🔀 طلب تحويل الفنش لهمزات (on=true) أو لعادي (on=false) — يرجع حالة الطلب:
  // none (ما فيه فنش) | already_on | already_off | cancelled (لغى طلب معلّق) | ok (يتطبق قبل السؤال الجاي) | queued (فيه سؤال شغال، يتطبق بعده)
  requestFinishHamza(on) {
    if (!this.active || !this.finishMode || !this.fm) return "none";
    const target = !!on;
    if (target === this.hamzaMode) {
      if (this.fm.pendingHamza !== undefined) {
        this.fm.pendingHamza = undefined;
        return "cancelled";
      }
      return target ? "already_on" : "already_off";
    }
    if (this.fm.pendingHamza === target) return target ? "already_on" : "already_off";
    this.fm.pendingHamza = target;
    return this.currentRound && !this.currentRound.finished ? "queued" : "ok";
  }

  async _applyFinishHamzaSwitch() {
    const on = this.fm.pendingHamza;
    this.fm.pendingHamza = undefined;
    if (on === undefined || on === this.hamzaMode) return;
    this.hamzaMode = on;
    try {
      if (on) {
        const p = randomHamzaPattern();
        this.hamzaPattern = { prefix: p.prefix, suffix: p.suffix };
        await this.sendChat(`*${p.text}*`);
      } else {
        this.hamzaPattern = null;
        await this.sendChat("✅ تم إلغاء الهمزات، الفنش رجع عادي.");
      }
      await new Promise((r) => setTimeout(r, HAMZA_SWITCH_CONTINUE_DELAY_MS)); // ثانية بعد تغيير المود
      if (!this.active) return;
      await this.sendChat("*نكمل*");
    } catch (e) {
      console.error("⚠️ فشل إرسال رسائل تحويل الهمزات (نكمل):", e && e.message);
    }
    // بعد *نكمل*: لو الفقرة بتتغير ثانية وحدة، وإلا 3 ثواني قبل السؤال
    await new Promise((r) => setTimeout(r, this.fm.announce ? FINISH_SECTION_CHANGE_DELAY_MS : HAMZA_SWITCH_AFTER_CONTINUE_MS));
  }

  // الانتظار بعد قائمة النتائج/السكب قبل الرسالة اللي بعدها: لو الفقرة بتتغير (بينزل اسم الفقرة الجديدة)
  // ثانية وحدة بس. لو نفس الفقرة (بينزل السؤال مباشرة) نفس الانتظار المعتاد
  _finishNextRoundDelay() {
    return this.fm && this.fm.announce ? FINISH_SECTION_CHANGE_DELAY_MS : this._finishStepDelay();
  }

  // سكب يدوي من الادمنية (.سكب): نفس السكب التلقائي بس ما يُحسب ضمن "3 سكبات
  // ورا بعض" اللي توقف الفنش تلقائياً. يرجع false لو ما فيه سؤال حالياً
  async finishManualSkip() {
    const round = this.currentRound;
    if (!this.finishMode || !this.active || !round || round.finished) return false;
    await this._finishAutoSkip(true);
    return true;
  }

  // إنهاء يدوي من الادمنية (.انهاء): يعرض آخر قائمة نقاط ثم "انتهى الفنش"
  async finishManualEnd() {
    if (!this.finishMode || !this.active) return false;
    if (this.currentRound) this.currentRound.finished = true; // يمنع أي إجابة متأخرة تتداخل مع الإنهاء
    await this.endContest();
    return true;
  }

  async _finishAutoSkip(manual = false) {
    const round = this.currentRound;
    if (!this.active || !round || round.finished) return;
    round.finished = true;
    this.roundsCompleted += 1;
    this.clearRoundWatchdog();
    if (!manual) this.fm.consecSkips += 1;
    try {
      await waitAtMost(this.sendChat(`*سكب*\nالإجابة: ${round.label}`), CONFIRM_WAIT_MS);
    } catch (e) {
      console.error("⚠️ فشل إرسال رسالة السكب التلقائي (نكمل):", e && e.message);
    }
    if (!this.active) return;
    if (this.fm.consecSkips >= FINISH_MAX_SKIPS) {
      await this._finishAutoEnd(`ما أحد جاوب ${FINISH_MAX_SKIPS} أسئلة ورا بعض`);
      return;
    }
    this.scheduleNextRound(this._finishNextRoundDelay(), "الجولة القادمة بعد السكب");
  }

  async _finishAutoEnd(reason) {
    if (!this.active) return;
    if (this.currentRound) this.currentRound.finished = true; // يمنع أي إجابة متأخرة تتداخل مع الإنهاء
    try {
      await this.sendChat(`⏹️ تم إنهاء الفنش تلقائياً لأنه ${reason}.`);
    } catch (e) {
      console.error("⚠️ فشل إرسال رسالة الإنهاء التلقائي:", e && e.message);
    }
    await this.endContest();
  }

  _finishBoardText(winnerId, reached) {
    const entries = [...this.scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([userId, points]) => ({ userId, displayName: registration.getTitle(userId) || this.displayNameFor(userId), points }));
    const hamzaText = this.hamzaMode && this.hamzaPattern ? `${this.hamzaPattern.prefix}ءء${this.hamzaPattern.suffix}` : null;
    return templates.formatFinishBoard({ target: this.target, mobileOnly: this.mobileOnly, entries, winnerId: reached ? winnerId : null, hamzaText });
  }

  displayNameFor(userId) {
    return this.nameCache.get(userId) || userId.split("@")[0];
  }

  async sendScoreboard() {
    const ranking = [...this.scores.entries()].sort((a, b) => b[1] - a[1]);
    if (ranking.length === 0) {
      await this.sendChat("ما فيه نقاط لأحد لحد الآن.");
      return;
    }
    let text = "📊 النقاط الحالية:\n\n";
    const mentions = [];
    for (const [userId, points] of ranking) {
      const title = registration.getTitle(userId);
      text += `${title || this.displayNameFor(userId)} (@${userId.split("@")[0]}) — ${points}\n`;
      mentions.push(userId);
    }
    await this.client.sendMessage(this.chatId, { text, mentions });
  }

  async endContest() {
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    if (this.nextRoundTimer) {
      clearTimeout(this.nextRoundTimer);
      this.nextRoundTimer = null;
    }
    this.clearRoundWatchdog();
    if (this.finishMode) this._finishClearTimers();
    this._clearPlanned();
    this.active = false;
    if (this.finishMode) rememberExtendable(this); // يبقى مستعد لـ.تمديد 15 دقيقة
    const ranking = [...this.scores.entries()].sort((a, b) => b[1] - a[1]);

    // نضيف نتيجة هذي المسابقة للسجل التراكمي (بس لو فيه مشاركين كافيين)
    // countWin: فوز "فنش" يُحسب بس بالمسابقات اللي مو مستمرة (فنش رسمي أو
    // مسابقة بعدد أسئلة محدد) — المستمرة (.مسص/.مسس/.متع/.مسكت) ما تُحسب
    // 🏁 .بدء_فنش يدخل السجل التراكمي (.سجل/.لقبي: نقاط + مشاركات) أيضاً — بس هنا عند نهاية الفنش مرة وحدة،
    // مو أثناءه (ما نسجّل ولا نحسب شي وقت اللعب عشان ما يصير بطء)، فالنقاط ما تظهر إلا بعد انتهاء الفنش
    // لو الفنش تمدد (.تمديد) وانتهى مرة ثانية: نسجّل الفرق بس (ما ينحسب الفوز/المشاركة مرتين)
    this._standingsRec = this._standingsRec
      ? standings.addContestExtension(this._standingsRec, this.scores, this.nameCache)
      : standings.addContestResult(this.scores, this.nameCache, { countWin: !this.endless });

    if (ranking.length === 0) {
      await this.sendChat("انتهت المسابقة بدون فائزين 😅");
      return;
    }

    if (this.finishMode) {
      // لو أحد وصل الهدف، آخر قائمة (اللي جنب اسمه فـنـش) هي النتيجة النهائية.
      // لو انتهت يدوياً (.انهاء) أو لخمول، نرسل القائمة الحالية كنتيجة
      if (!ranking.some(([, p]) => p >= this.target)) {
        await this.sendChat(this._finishBoardText(null, false));
      }
      // 🏁 بعد القائمة النهائية مباشرة (كل طرق الانتهاء: وصل الهدف / .انهاء / إنهاء تلقائي)
      try {
        await this.sendChat("*انـتـهـى الـفـنـش*");
      } catch (e) {
        console.error("⚠️ فشل إرسال رسالة انتهاء الفنش:", e && e.message);
      }
      return;
    }

    const rankingObjs = ranking.map(([userId, points]) => ({
      userId,
      displayName: this.displayNameFor(userId),
      points,
    }));
    const text = templates.formatContestEnd(rankingObjs);
    const mentions = registration.mentionable(rankingObjs.map((e) => e.userId));

    await this.client.sendMessage(this.chatId, { text, mentions });
  }

  // ⏸️ .وقف: يوقف التقديم مؤقتاً (كل المؤقتات تتجمد) مع الاحتفاظ بكل الحالة (النقاط، الفقرة/الدورة بالفنش، الهدف...)
  pause() {
    if (!this.active || this.paused) return false;
    this.paused = true;
    if (this.nextRoundTimer) {
      clearTimeout(this.nextRoundTimer);
      this.nextRoundTimer = null;
    }
    this.clearRoundWatchdog();
    if (this.finishMode) this._finishClearTimers();
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      if (!this.paused || !this.active) return;
      this.sendChat("⏹️ تم إنهاء المسابقة تلقائياً لأنها كانت موقوفة أكثر من ساعتين.")
        .catch(() => {})
        .then(() => this.endContest())
        .catch((e) => console.error("⚠️ خطأ بإنهاء المسابقة الموقوفة:", e));
    }, PAUSE_MAX_MS);
    if (this.pauseTimer.unref) this.pauseTimer.unref();
    return true;
  }

  // ▶️ .كمل: يكمل من نفس النقطة. السؤال اللي كان شغال لحظة الوقف (ما انجاب) يُلغى بدون حساب، ويجي سؤال جديد بنفس الفقرة/الدورة
  resume() {
    if (!this.active || !this.paused) return false;
    this.paused = false;
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    if (this.awaitingHamzaFrom) {
      this._armHamzaWaitTimer(); // لسا ينتظر نمط الهمزات
      return true;
    }
    const round = this.currentRound;
    if (round && !round.finished) round.finished = true; // السؤال المعلّق ينلغي بصمت
    if (this.nextRoundTimer) clearTimeout(this.nextRoundTimer);
    const delay = this.finishMode ? this._finishNextRoundDelay() : store.getConfig().nextQuestionDelayMs || 1000;
    this.scheduleNextRound(delay, "الجولة القادمة بعد الاستئناف");
    return true;
  }

  // ➕ .تمديد <رقم>: يزيد هدف فنش منتهي ويكمله من حيث وقف (نفس النقاط/الفقرة/الدورة/الهمزات/الشخوص)
  extend(n) {
    if (!this.finishMode || this.active || !this.fm || !(n > 0)) return false;
    this.target += n;
    this.active = true;
    this.paused = false;
    if (this._finishWinPending) this._finishAfterWin(); // آخر فوز كان أنهى الفنش قبل حساب حدود الفقرة
    this.fm.announce = true; // يرسل اسم الفقرة (*كتابة* مثلاً) قبل أول سؤال
    this.fm.consecSkips = 0;
    this._finishClearTimers();
    this.scheduleNextRound(this._finishNextRoundDelay(), "الجولة القادمة بعد التمديد");
    return true;
  }

  stop() {
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    if (this.nextRoundTimer) {
      clearTimeout(this.nextRoundTimer);
      this.nextRoundTimer = null;
    }
    this.clearRoundWatchdog();
    if (this.finishMode) this._finishClearTimers();
    this._clearPlanned();
    this.active = false;
    this.currentRound = null;
  }
}

module.exports = { Contest, takeExtendable };
