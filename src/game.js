const fs = require("fs");
const { pickRandom, shuffle, formatSeconds, findAllMatches } = require("./utils");
const store = require("./dataStore");
const leaderboard = require("./leaderboard");
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
const NETWORK_OVERHEAD_MS = 300;

// حد أدنى منطقي (فيزيائياً) لأي وقت إجابة — ولا إنسان يقرأ سؤال/صورة
// ويكتب إجابة أسرع من هذا. أي قيمة أقل من كذا (0.00، 0.05...) مؤكد خطأ
// قياس (تذبذب سيرفر/شبكة)، مو سرعة حقيقية — نحميها بحد أدنى ثابت بدل ما
// تطلع رقم مستحيل يقدر يُستغل كـ"سرعة خارقة" مزيّفة
const MIN_PLAUSIBLE_ELAPSED_MS = 200;

// أنواع الفقرات المدعومة
const POOL_TYPES = ["writing", "images", "questions", "counts"];

class Contest {
  constructor(chatId, sock, contestType, target, options = {}) {
    this.chatId = chatId;
    this.client = sock; // Baileys socket
    this.contestType = contestType; // 'general' | 'writing' | 'images' | 'questions' | 'counts'
    this.target = target; // النقاط المطلوبة للفوز (Infinity للمسابقات المستمرة)
    this.scores = new Map(); // userId -> points
    this.usedIds = { writing: new Set(), images: new Set(), questions: new Set(), counts: new Set() };
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
  }

  pickPoolType() {
    if (this.contestType === "general") {
      return pickRandom(POOL_TYPES);
    }
    return this.contestType;
  }

  // يجيب عنصر عشوائي غير مستخدم من مجموعة بيانات (صور/أسئلة/تعداد)
  pickItem(poolType) {
    let pool;
    if (poolType === "images") pool = store.getImages();
    else if (poolType === "questions") pool = store.getQuestions();
    else if (poolType === "counts") pool = store.getCounts();

    if (!pool || pool.length === 0) return null;

    const used = this.usedIds[poolType];
    let available = pool.filter((it) => !used.has(it.id));
    if (available.length === 0) {
      used.clear();
      available = pool;
    }
    const item = pickRandom(available);
    used.add(item.id);
    return item;
  }

  // فقرة الكتابة: يسحب عشوائياً 1-3 كلمات من بنك كلمات واحد (بدون تكرار
  // بنفس الجولة/الجلسة)، كل كلمة لها صيغ مقبولة (aliases)، ولازم كلها تنكتب
  // (بأي رسالة، بأي ترتيب، حتى لو وسط كلام زيادة) عشان تفوز بالجولة
  pickWritingRound(forcedCount) {
    const pool = store.getWords(); // array of { word: ["لوفي","luffy", ...] }
    if (!pool || pool.length === 0) return null;

    const used = this.usedIds.writing; // Set من فهارس الكلمات المستخدمة
    let availableIdx = pool.map((_, i) => i).filter((i) => !used.has(i));
    if (availableIdx.length === 0) {
      used.clear();
      availableIdx = pool.map((_, i) => i);
    }

    const desired = forcedCount || Math.floor(Math.random() * 3) + 1;
    const count = Math.min(desired, availableIdx.length);
    const selected = shuffle(availableIdx).slice(0, count);
    selected.forEach((i) => used.add(i));

    return selected.map((i) => pool[i].word); // مصفوفة مصفوفات (slots)
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
    let slots, required, points, questionText, label;

    if (poolType === "writing") {
      slots = this.pickWritingRound(this.fixedWordCount);
      if (!slots) {
        await this.sendChat(`⚠️ ما فيه كلمات بملف data/words.json. أضف كلمات أول.`);
        return;
      }
      required = slots.length;
      points = 1;
      label = slots.map((s) => s[0]).join("، ");
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
      startTime: Date.now(), // قيمة مؤقتة، تنستبدل تحت بتوقيت واتساب الفعلي
      finished: false,
      perUser: new Map(), // userId -> Set(فهارس) — مسار كل شخص مستقل تماماً
    };
    this.currentRound = round;

    let sentMsg = null;

    // إرسال السؤال بحسب نوع الفقرة
    if (poolType === "writing") {
      const preview = slots.map((s) => `*${s[0]}*`).join(" - ");
      sentMsg = await this.sendChat(`✍️ اكتب التالي:\n\n${preview}`);
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
            caption: `🖼️ ${questionText || "من هذه الشخصية؟"}`,
            jpegThumbnail: thumbBuffer,  // ← المعاينة الفورية
            mimetype: "image/jpeg",
          });
        } else {
          // لو sharp مو موجود
          sentMsg = await this.client.sendMessage(this.chatId, {
            image: imageBuffer,
            caption: `🖼️ ${questionText || "من هذه الشخصية؟"}`,
            mimetype: "image/jpeg",
          });
        }
      } catch (e) {
        this.currentRound = null;
        await this.sendChat(`⚠️ ما قدرت أفتح الصورة: ${this._lastItem.file}. تأكد إنها موجودة بمجلد data/images`);
        return;
      }
    } else if (poolType === "questions") {
        sentMsg = await this.sendChat(`❓ سؤال جديد\n\n${questionText}`);
    } else if (poolType === "counts") {
      sentMsg = await this.sendChat(`🔢 فقرة التعداد\n\n${questionText}`);
    }

    // وقت البداية = لحظة تأكد إرسال السؤال فعلياً (بعد ما ينتهي الـ await)،
    // مباشرة وبدون أي تخمين أو تعديل إضافي — أثبت وأدق من محاولة توقع
    // "زمن شبكة" متغيّر. نعدّل نفس كائن الجولة (مو نستبدله) عشان أي رد
    // وصل بالفترة القصيرة اللي بين التعيين والإرسال يشوف نفس المرجع
    round.startTime = Date.now();

    // مؤقت حراسة: لو ما صار أي رد (ولا حتى محاولة خطأ) خلال دقيقة ونصف،
    // على الأغلب الرسالة (سؤال/صورة) ما وصلت فعلياً لواتساب رغم إن سيرفرنا
    // ظن إنها انرسلت بنجاح — هذا وارد لو الاتصال متذبذب. بدل ما تفضل
    // المسابقة "عالقة" بصمت بدون أي تفسير، ننبّه القروب بوضوح
    this.clearRoundWatchdog();
    this.roundWatchdog = setTimeout(() => {
      if (this.currentRound === round && !round.finished && this.active) {
        this.sendChat(
          "⚠️ يبدو إن السؤال الحالي ما وصل بشكل طبيعي (تأخير غير عادي بالاتصال). جرب .سكب للانتقال للسؤال التالي، أو .انهاء لو تبي توقف المسابقة."
        ).catch((e) => console.error("فشل إرسال تنبيه انتظار السؤال:", e));
      }
    }, 10000); // 10س ثانية
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
    if (!this.active || !this.currentRound || this.currentRound.finished) return;
    if (!text) return;
    if (moderation.isBanned(senderId)) return;

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

    // كل شخص عنده مساره الخاص المستقل تماماً — إجابات شخص ثاني ما تأثر
    // على فرص هذا الشخص، وما تحجز عناصر تمنعه من إكمالها لحاله
    if (!round.perUser.has(senderId)) round.perUser.set(senderId, new Set());
    const userSet = round.perUser.get(senderId);

    // يدور داخل الرسالة عن أي عناصر صحيحة (من مساره الشخصي) لسا ما جابها،
    // حتى لو وسط كلام زيادة أو حروف ملتصقة أو أكثر من عنصر بنفس الرسالة.
    // كل الفقرات تستخدم تطبيع مرن (غ/ق/ج كحرف واحد) عدا الكتابة، اللي
    // لازم فيها تطابق حرفي كامل بدون تساهل
    const relaxed = round.poolType !== "writing";
    const newlyClaimed = findAllMatches(text, round.slots, userSet, relaxed);
    if (newlyClaimed.length === 0) return;

    for (const idx of newlyClaimed) userSet.add(idx);

    if (userSet.size >= round.required) {
      await this.completeRound(msg, senderId);
    }
  }

  addPoints(userId, points) {
    const current = this.scores.get(userId) || 0;
    this.scores.set(userId, current + points);
    return this.scores.get(userId);
  }

  async completeRound(msg, senderId) {
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
    // رسالة السؤال، بدون أي تخمين متغيّر يقدر يشوّه الرقم
    let elapsed = Math.max(0, rawElapsed - NETWORK_OVERHEAD_MS);
    // حماية إضافية: لو طلعت القيمة أقل من الحد الفيزيائي الممكن (يعني
    // خطأ قياس مؤكد، مو سرعة حقيقية)، نثبتها على الحد الأدنى بدل ما
    // تطلع رقم مستحيل (0.00 أو أقل من العادة بشكل مريب)
    if (elapsed < MIN_PLAUSIBLE_ELAPSED_MS) {
      if (elapsed < 50) {
        // فرق واضح ومريب (مو مجرد اقتراب من الحد) — نسجله للمراجعة
        console.warn(
          `⚠️ وقت غير منطقي بجولة ${round.poolType} (elapsed=${elapsed}ms قبل التثبيت) — ثبّتناه على ${MIN_PLAUSIBLE_ELAPSED_MS}ms.`
        );
      }
      elapsed = MIN_PLAUSIBLE_ELAPSED_MS;
    }
    const total = this.addPoints(senderId, round.points);

    // نسجل هذي النتيجة بلوحة الصدارة (أفضل الأوقات) — إلا لو تقديم بسيط
    // (تجربة/معاينة)، ما نحسبها بالمنافسة الرسمية. محاطة بحماية عشان لو
    // فشل التسجيل لأي سبب (مشكلة قاعدة بيانات لحظية)، ما توقف تقدم الجولة
    if (!this.practiceMode) {
      try {
        leaderboard.record(round.poolType, {
          userId: senderId,
          displayName: this.displayNameFor(senderId),
          elapsed,
          answer: round.label,
          ts: Date.now(),
        });
      } catch (e) {
        console.error("⚠️ خطأ تسجيل النتيجة بلوحة الصدارة (تجاهلناه، الجولة تكمل عادي):", e);
      }
    }

    const resultLabel = round.required > 1 ? `جمعت ${round.required} إجابات` : "إجابة صحيحة";

    // التقديم البسيط تجربة/معاينة كلاسيكية بدون وقت ولا نقاط حقيقية —
    // الوقت والنقاط تخص المسابقات الفعلية بس
    if (this.practiceMode) {
      await this.replyTo(msg, `🎉 ${resultLabel}!`);
    } else {
      await this.replyTo(
        msg,
        `🎉 ${resultLabel}!\n\n⏱️ الوقت: ${formatSeconds(elapsed)} ثانية\n\n⭐ +${round.points} نقطة\n(المجموع: ${total})`
      );
    }

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
    await this.replyTo(msg, `⏭️ تم سكب السؤال.\n📝 الإجابة كانت: ${round.label}`);

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
