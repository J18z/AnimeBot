// مخزن جلسة واتساب بالذاكرة فقط (بدون أي حفظ): لا قراءة ولا كتابة لقاعدة
// البيانات أو الملفات إطلاقاً — أخف وأسرع شكل ممكن. الثمن: الجلسة تنمسح مع
// أي إعادة تشغيل للبرنامج، ولازم تمسح QR من جديد (صفحة /qr).

const { proto, initAuthCreds } = require("@whiskeysockets/baileys");
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

async function useMemoryAuthState() {
  if (cached) return cached;
  const creds = initAuthCreds();
  const store = new Map(); // "type-id" -> value

  const keys = {
    get: async (type, ids) => {
      const data = {};
      for (const id of ids) {
        let value = store.get(`${type}-${id}`) ?? null;
        if (type === "app-state-sync-key" && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        data[id] = value;
      }
      return data;
    },
    set: async (data) => {
      for (const type in data) {
        for (const id in data[type]) {
          const value = data[type][id];
          const k = `${type}-${id}`;
          if (value) store.set(k, value);
          else store.delete(k);
        }
      }
    },
  };

  // نفس أدوات الصيانة اللي للمخزن الآخر: .تصفير_التشفير والعلاج التلقائي
  const isChatKey = (id) => id.startsWith("session-") || id.startsWith("sender-key-");
  setAuthHooks({
    flush: null,
    reset: async () => {
      let n = 0;
      for (const k of [...store.keys()]) {
        if (isChatKey(k)) {
          store.delete(k);
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
      for (const k of [...store.keys()]) {
        if (reSession.test(k) || reSender.test(k)) {
          store.delete(k);
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
