const fs = require("fs");
const { pickRandom, shuffle, formatSeconds, findAllMatches, parseHamzaPattern, unwrapHamza } = require("./utils");
const store = require("./dataStore");
const leaderboard = require("./leaderboard");
const personalHistory = require("./personalHistory");
const standings = require("./standings");
const moderation = require("./moderation");
const registration = require("./registration");
const templates = require("./templates");
let sharp;
try { sharp = require("sharp"); } catch (e) { sharp = null; }
// هامش زمني ثابت وصغير (مو متغيّر أو متوقّع) نطرحه من وقت أي إجابة، تعويض
// تقريبي بسيط لزمن وصول رسالة السؤال قبل ما يبدأ المتسابق يقرأها. متعمد
// إنه رقم ثابت صغير (مو تخمين ديناميكي) عشان يبقى الوقت المعروض ثابت
// ويعتمد على، بدل ما يتقلب حسب سرعة السيرفر اللحظية (خصوصاً بسيرفرات
// مجانية زي Render ممكن تتأخر لحظياً وتشوّه أي تخمين ديناميكي)
const NETWORK_OVERHEAD_MS = 400;

// اختيار عشوائي بسيط (كل عنصر بنفس الاحتمالية بالضبط) من بين عناصر مو
// مستبعدة. نستخدمها بدل نظام الوزن المتناقص القديم (اتشال بناءً على طلب
// صريح) — الاستبعاد الصارم لكل مسابقة (usedIds/usedSingleWords بكل
// Contest) هو الميكانيزم الوحيد المتبقي لمنع التكرار
function pickRandomExcluding(pool, keyFn, excludeSet) {
  const candidates = excludeSet ? pool.filter((it) => !excludeSet.has(keyFn(it))) : pool;
  if (candidates.length === 0) return null;
  return pickRandom(candidates);
}

// أنواع الفقرات المدعومة
const POOL_TYPES = ["writing", "images", "questions", "counts"];

class Contest {
  constructor(chatId, sock, contestType, target, options = {}) {
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
    this.practiceMode = !!options.practiceMode; // تقديم بسيط، جولة وحدة، بدون تسجيل بـ.توب/.سجل
    this.endless = !!options.endless; // مسابقة مستمرة، ما تتوقف تلقائياً عند الهدف
    this.mobileOnly = !!options.mobileOnly; // بس المسجلين كجوال يقدرون يشاركون
    this.fixedWordCount = options.fixedWordCount || null; // عدد كلمات ثابت لفقرة الكتابة
    this.roundsTarget = options.roundsTarget || null; // عدد أسئلة إجمالي تنتهي عنده المسابقة (بغض النظر مين جاوب)
    this.roundsCompleted = 0; // عدّاد الأسئلة اللي خلصت (إجابة صحيحة أو سكب)
    this.nextRoundTimer = null; // ✅ حفظ رقم Timer عشان نلغيه لاحقاً
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
  }

  pickPoolType() {
    if (this.contestType === "general") {
      return pickRandom(this.allowedPoolTypes || POOL_TYPES);
    }
    return this.contestType;
  }

  // يجيب عنصر من مجموعة بيانات (صور/أسئلة/تعداد). فيه طبقتين:
  // 1) استبعاد صارم على مستوى هذي المسابقة بالذات (usedIds) — نفس العنصر
  //    ما يتكرر إطلاقاً طول عمر هذي المسابقة، وينتهي تلقائياً مع نهايتها
  //    (كائن Contest جديد = usedIds فاضية من جديد)
  // 2) بين المرشحين المتبقين بعد الاستبعاد، اختيار عشوائي بسيط (كل عنصر
  //    بنفس الاحتمالية بالضبط — بدون أي نظام وزن أو تناقص احتمالية)
  pickItem(poolType) {
    let pool;
    if (poolType === "images") pool = store.getImages();
    else if (poolType === "questions") pool = store.getQuestions();
    else if (poolType === "counts") pool = store.getCounts();

    if (!pool || pool.length === 0) return null;

    if (!this.usedIds) this.usedIds = {};
    if (!this.usedIds[poolType]) this.usedIds[poolType] = new Set();
    const usedSet = this.usedIds[poolType];

    let item = pickRandomExcluding(pool, (it) => it.id, usedSet);
    if (!item && usedSet.size > 0) {
      // خلص البنك كامل بهذي المسابقة بالذات (بنك صغير قياساً لطول
      // المسابقة، أو مسابقة مستمرة طالت) — دورة جديدة لهذي المسابقة بس،
      // بدل ما تعلق المسابقة بدون أسئلة
      usedSet.clear();
      item = pickRandomExcluding(pool, (it) => it.id, usedSet);
    }
    if (item) usedSet.add(item.id);
    return item;
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
  pickWritingRound(forcedCount) {
    const pool = store.getWords(); // array of { word: ["لوفي","luffy", ...] }
    if (!pool || pool.length === 0) return null;

    // مفتاح ثابت لكل كلمة: أول صيغة (aliases[0])، وهي عمليًا فريدة عبر
    // بنك الكلمات (اسم الشخصية الأساسي بالعربي)
    const keyFn = (it) => it.word[0];

    const desired = forcedCount || Math.floor(Math.random() * 3) + 1;
    const count = Math.min(desired, pool.length);
    const isSingleWordRound = count === 1;

    if (isSingleWordRound && !this.usedSingleWords) this.usedSingleWords = new Set();
    const chosenKeys = isSingleWordRound ? new Set(this.usedSingleWords) : new Set();

    const result = [];
    for (let i = 0; i < count; i++) {
      let item = pickRandomExcluding(pool, keyFn, chosenKeys);
      if (!item && isSingleWordRound && this.usedSingleWords.size > 0) {
        // خلصت كل كلمات البنك (كواحدة مفردة) بهذي المسابقة — دورة جديدة
        this.usedSingleWords.clear();
        chosenKeys.clear();
        item = pickRandomExcluding(pool, keyFn, chosenKeys);
      }
      if (!item) break;
      chosenKeys.add(keyFn(item));
      result.push(item.word);
    }

    if (isSingleWordRound && result.length > 0) {
      this.usedSingleWords.add(keyFn({ word: result[0] }));
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
      const item = pickRandomExcluding(pool, keyFn, chosenKeys);
      if (!item) break;
      chosenKeys.add(keyFn(item));
      const repeatCount = Math.floor(Math.random() * 4) + 2; // 2..5
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

  // يبدأ جولة جديدة
  async nextRound() {
    if (!this.active) return;

    const poolType = this.pickPoolType();
    let slots, required, points, questionText, label, repeatCounts;

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
      if (!this.usedIds) this.usedIds = {};
      if (!this.usedIds[poolType]) this.usedIds[poolType] = new Set();
      const usedSet = this.usedIds[poolType];
      let wordItem = pickRandomExcluding(wordPool, (it) => it.word[0], usedSet);
      if (!wordItem && usedSet.size > 0) {
        usedSet.clear();
        wordItem = pickRandomExcluding(wordPool, (it) => it.word[0], usedSet);
      }
      usedSet.add(wordItem.word[0]);
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
      const item = this.pickItem(poolType);
      if (!item) {
        await this.sendChat(`⚠️ ما فيه أسئلة متوفرة لفقرة "${poolType}". أضف بيانات بملف data/${poolType}.json`);
        return;
      }
      points = item.points || 1;
      questionText = item.question;

      if (poolType === "questions" && item.type === "count") {
        slots = item.answers;
        required = item.required;
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
      repeatCounts, // بس لفقرة "تكرار": عدد التكرار المطلوب بالظبط لكل عنصر بـslots
      startTime: Date.now(), // قيمة مؤقتة، تنستبدل تحت بتوقيت واتساب الفعلي
      finished: false,
      perUser: new Map(), // userId -> Set(فهارس) — مسار كل شخص مستقل تماماً
    };
    this.currentRound = round;

    let sentMsg = null;

    // إرسال السؤال بحسب نوع الفقرة — سادة بدون أي نص زائد، بادئة "س/"
    // للأسئلة و"تع/" للتعداد بس (الكتابة والصور بدون بادئة إطلاقاً)
    if (poolType === "repeat") {
      const preview = slots.map((s, i) => `*${s[0]}(${repeatCounts[i]})*`).join(" ");
      sentMsg = await this.sendChat(preview);
    } else if (poolType === "writing") {
      const preview = slots.map((s) => `*${s[0]}*`).join(" - ");
      sentMsg = await this.sendChat(preview);
    } else if (poolType === "images") {
      try {
        const imagePath = store.getImagePath(this._lastItem.file);
        let imageBuffer = fs.readFileSync(imagePath);

        if (sharp) {
          // نصغّر الصورة شوي عشان تتحمل بسرعة (WhatsApp يحب الصور الخفيفة)
          imageBuffer = await sharp(imageBuffer)
            .resize(1000, 1000, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 85, progressive: true })
            .toBuffer();

          // ✅ نولّد thumbnail يدوياً — هذا اللي يظهر فوراً بدون "تالف"
          const thumbBuffer = await sharp(imageBuffer)
            .resize(120, 120, { fit: "cover" })
            .jpeg({ quality: 60 })
            .toBuffer();

          sentMsg = await this.client.sendMessage(this.chatId, {
            image: imageBuffer,
            jpegThumbnail: thumbBuffer, // ← المعاينة الفورية
            mimetype: "image/jpeg",
          });
        } else {
          // لو sharp مو موجود
          sentMsg = await this.client.sendMessage(this.chatId, {
            image: imageBuffer,
            mimetype: "image/jpeg",
          });
        }
      } catch (e) {
        this.currentRound = null;
        await this.sendChat(`⚠️ ما قدرت أفتح الصورة: ${this._lastItem.file}. تأكد إنها موجودة بمجلد data/images`);
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

    // مؤقت حراسة: لو ما صار أي رد (ولا حتى محاولة خطأ) خلال 20 ثانية،
    // على الأغلب الرسالة (سؤال/صورة) ما وصلت فعلياً لواتساب رغم إن سيرفرنا
    // ظن إنها انرسلت بنجاح — هذا وارد لو الاتصال متذبذب. بدل ما تفضل
    // المسابقة "عالقة" بصمت بدون أي تفسير، ننبّه القروب بوضوح. التقديم
    // البسيط مستثنى: مهمته يرسل الفقرة بس، بدون أي رسائل إضافية إطلاقاً
    this.clearRoundWatchdog();
    if (!this.practiceMode) {
      this.roundWatchdog = setTimeout(() => {
        if (this.currentRound === round && !round.finished && this.active) {
          this.sendChat(
            "⚠️ يبدو إن السؤال الحالي ما وصل بشكل طبيعي (تأخير غير عادي بالاتصال). جرب .سكب للانتقال للسؤال التالي، أو .انهاء لو تبي توقف المسابقة."
          ).catch((e) => console.error("فشل إرسال تنبيه انتظار السؤال:", e));
        }
      }, 20000); // 20 ثانية
    }
  }

  // يلغي مؤقت الحراسة الحالي (لو موجود) — يُستدعى كل ما جولة تخلص/تُسكب/تنتهي المسابقة
  clearRoundWatchdog() {
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
    if (moderation.isBanned(senderId)) return;

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
              "💡 لازم تسجل نوع جهازك أول عشان تُحسب لك النقاط. اكتب .تسجيل جوال أو .تسجيل خارجي."
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
      let allMatch = tokens.length > 0;
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
    let searchText = text;
    if (this.hamzaMode && this.hamzaPattern && userSet.size === 0) {
      const unwrapped = unwrapHamza(text, this.hamzaPattern);
      if (unwrapped === null) return;
      searchText = unwrapped;
    }
    const newlyClaimed = findAllMatches(searchText, round.slots, userSet, relaxed);
    if (newlyClaimed.length === 0) return;

    for (const idx of newlyClaimed) userSet.add(idx);

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
    let rawElapsed = Date.now() - round.startTime;
    if (!Number.isFinite(rawElapsed)) {
      console.warn(
        `⚠️ قيمة وقت غير طبيعية بجولة ${round.poolType} (startTime=${round.startTime}) — استخدمنا 0 كقيمة آمنة.`
      );
      rawElapsed = 0;
    }
    rawElapsed = Math.max(0, rawElapsed);
    // ننزل هامش ثابت وصغير بس (300 ملي ثانية) — تعويض بسيط لزمن وصول
    // رسالة السؤال، بدون أي تخمين متغيّر يقدر يشوّه الرقم. ما فيه حد
    // أدنى إضافي بعد كذا — لو طلعت 0.00 أو قريبة منها فهذا وقت حقيقي
    // (شخص جاوب بسرعة كبيرة فعلاً)، نعرضه زي ما هو بدون تثبيت
    const elapsed = Math.max(0, rawElapsed - NETWORK_OVERHEAD_MS);
    const total = this.addPoints(senderId, round.points);

    // نسجل هذي النتيجة بلوحة الصدارة (أفضل الأوقات) — إلا لو تقديم بسيط
    // (تجربة/معاينة)، ما نحسبها بالمنافسة الرسمية. محاطة بحماية عشان لو
    // فشل التسجيل لأي سبب (مشكلة قاعدة بيانات لحظية)، ما توقف تقدم الجولة
    if (!this.practiceMode) {
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
        await this.replyTo(
          msg,
          `🎉 ${resultLabel}!\n\n⏱️ الوقت: ${formatSeconds(elapsed)} ثانية\n\n⭐ +${round.points} نقطة\n(المجموع: ${total})`
        );
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
    this.nextRoundTimer = setTimeout(async () => {
      try {
        await this.nextRound();
      } catch (e1) {
        console.error(`⚠️ خطأ بـ${context} (محاولة أولى):`, e1);
        setTimeout(async () => {
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
      await this.replyTo(msg, `⏭️ تم سكب السؤال.\n📝 الإجابة كانت: ${round.label}`);
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
      await this.endContest();
      return;
    }
    const cfg = store.getConfig();
    this.scheduleNextRound(cfg.nextQuestionDelayMs || 1000, "الجولة القادمة");
  }

  // يعرض اسم العرض المخزن (لو موجود) وإلا رقم الشخص فقط
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
      text += `${this.displayNameFor(userId)} (@${userId.split("@")[0]}) — ${points}\n`;
      mentions.push(userId);
    }
    await this.client.sendMessage(this.chatId, { text, mentions });
  }

  async endContest() {
    if (this.nextRoundTimer) {
      clearTimeout(this.nextRoundTimer);
      this.nextRoundTimer = null;
    }
    this.clearRoundWatchdog();
    this.active = false;
    const ranking = [...this.scores.entries()].sort((a, b) => b[1] - a[1]);

    // نضيف نتيجة هذي المسابقة للسجل التراكمي (بس لو فيه مشاركين كافيين)
    // countWin: فوز "فنش" يُحسب بس بالمسابقات اللي مو مستمرة (فنش رسمي أو
    // مسابقة بعدد أسئلة محدد) — المستمرة (.مسص/.مسس/.متع/.مسكت) ما تُحسب
    standings.addContestResult(this.scores, this.nameCache, { countWin: !this.endless });

    if (ranking.length === 0) {
      await this.sendChat("انتهت المسابقة بدون فائزين 😅");
      return;
    }

    const rankingObjs = ranking.map(([userId, points]) => ({
      userId,
      displayName: this.displayNameFor(userId),
      points,
    }));
    const text = templates.formatContestEnd(rankingObjs);
    const mentions = rankingObjs.map((e) => e.userId);

    await this.client.sendMessage(this.chatId, { text, mentions });
  }

  stop() {
    if (this.nextRoundTimer) {
      clearTimeout(this.nextRoundTimer);
      this.nextRoundTimer = null;
    }
    this.clearRoundWatchdog();
    this.active = false;
    this.currentRound = null;
  }
}

module.exports = { Contest };
