// مخزن جلسة واتساب بالذاكرة فقط (بدون أي حفظ): لا قراءة ولا كتابة لقاعدة
// البيانات أو الملفات إطلاقاً — أخف وأسرع شكل ممكن. الثمن: الجلسة تنمسح مع
// أي إعادة تشغيل للبرنامج، ولازم تمسح QR من جديد (صفحة /qr).

const { baileys } = require("./baileysLoader");
const { setAuthHooks } = require("./mongoAuthState");

// ⚠️ سبب حلقة الباركود اللي كانت تصير: هذي الدالة تُستدعى مع كل إعادة اتصال
// (connectSocket)، وكانت تنشئ جلسة فاضية جديدة كل مرة. بعد ما تمسح الباركود
// واتساب يقفل الاتصال عمداً ويطلب إعادة تشغيل الاتصال (حالة عادية بالربط) —
// فنرجع نتصل بجلسة فاضية جديدة ← باركود جديد ← وهكذا للأبد. الحل: الجلسة
// تنخزن بمتغير واحد على مستوى الملف وتنرجّع نفسها لكل اتصال داخل نفس التشغيل
// (لسا "بالذاكرة فقط": تنمسح مع إعادة تشغيل البرنامج، مو بين الاتصالات)
let cached = null;

// يمسح الجلسة من الذاكرة (عند تسجيل الخروج) عشان الاتصال القادم يطلب باركود جديد
function resetMemoryAuthState() {
  cached = null;
}

// سقف عدد مفاتيح المحادثات (جلسات + مفاتيح قروبات) بالذاكرة: لو تعدّى، نشيل
// الأقدم استخدامًا (LRU). بدون هذا السقف كل شخص/جهاز يتعامل معه البوت
// يبقى مفتاحه بالذاكرة للأبد وتكبر الذاكرة مع الأيام. المحذوف غالباً أجهزة
// ما كلمت البوت من فترة طويلة، وإن رجعت تبني جلسة جديدة تلقائياً
const MAX_CHAT_KEYS = Number(process.env.MAX_CHAT_KEYS) || 5000;
const isChatType = (type) => type === "session" || type === "sender-key";

async function useMemoryAuthState() {
  if (cached) return cached;
  const { proto, initAuthCreds } = baileys(); // تُحمَّل بأول main (شوف baileysLoader)
  const creds = initAuthCreds();
  const chat = new Map(); // "session-…" / "sender-key-…" — مرتّبة بآخر استخدام (LRU)
  const other = new Map(); // pre-key, app-state…, sender-key-memory… (ما تنطرد)

  const keys = {
    get: async (type, ids) => {
      const data = {};
      const isChat = isChatType(type);
      for (const id of ids) {
        const k = `${type}-${id}`;
        let value;
        if (isChat) {
          value = chat.get(k);
          if (value !== undefined) {
            chat.delete(k); // نحرّكه لآخر القائمة = "استُخدم الحين"
            chat.set(k, value);
          }
        } else {
          value = other.get(k);
        }
        value = value ?? null;
        if (type === "app-state-sync-key" && value) {
          // v7: create بدل fromObject
          value = typeof proto.Message.AppStateSyncKeyData.create === "function" ? proto.Message.AppStateSyncKeyData.create(value) : proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        data[id] = value;
      }
      return data;
    },
    set: async (data) => {
      for (const type in data) {
        const isChat = isChatType(type);
        const target = isChat ? chat : other;
        for (const id in data[type]) {
          const value = data[type][id];
          const k = `${type}-${id}`;
          if (value) {
            if (isChat) target.delete(k);
            target.set(k, value);
          } else {
            target.delete(k);
          }
        }
      }
      while (chat.size > MAX_CHAT_KEYS) chat.delete(chat.keys().next().value);
    },
  };

  // نفس أدوات الصيانة اللي للمخزن الآخر: .تصفير_التشفير والعلاج التلقائي
  setAuthHooks({
    flush: null,
    stats: () => ({ chatKeys: chat.size, otherKeys: other.size, maxChat: MAX_CHAT_KEYS }),
    reset: async () => {
      let n = chat.size;
      chat.clear();
      for (const k of [...other.keys()]) {
        if (k.startsWith("sender-key-memory-")) {
          other.delete(k);
          n++;
        }
      }
      return { inMemory: n, inDb: 0 };
    },
    purge: async (userDigits) => {
      const u = String(userDigits).replace(/\D/g, "");
      if (!u) return 0;
      const reSession = new RegExp(`^session-${u}(_\\d+)?\\.\\d+$`);
      const reSender = new RegExp(`^sender-key-.*::${u}(_\\d+)?::\\d+$`);
      let n = 0;
      for (const k of [...chat.keys()]) {
        if (reSession.test(k) || reSender.test(k)) {
          chat.delete(k);
          n++;
        }
      }
      return n;
    },
  });

  cached = { state: { creds, keys }, saveCreds: async () => {} };
  return cached;
}

module.exports = { useMemoryAuthState, resetMemoryAuthState };
