// نسخة من useMultiFileAuthState الأصلية بمكتبة Baileys، بس بدل ما تحفظ
// كل شي بملفات محلية (اللي تنمسح على أغلب السيرفرات المجانية عند إعادة
// التشغيل)، تحفظ كل شي بـ MongoDB — عشان الجلسة تفضل موجودة مهما صار
// للسيرفر (نوم، إعادة تشغيل، انتقال لسيرفر ثاني تماماً)

const { proto, initAuthCreds, BufferJSON } = require("@whiskeysockets/baileys");
const { getDb } = require("./db");

async function useMongoAuthState() {
  const db = getDb();
  if (!db) {
    throw new Error("ما فيه اتصال بقاعدة بيانات، ما نقدر نحفظ جلسة واتساب فيها.");
  }
  const col = db.collection("baileys_auth");

  async function readData(id) {
    try {
      const doc = await col.findOne({ _id: id });
      if (!doc || doc.value === undefined) return null;
      return JSON.parse(doc.value, BufferJSON.reviver);
    } catch (e) {
      return null;
    }
  }

  async function writeData(id, data) {
    const value = JSON.stringify(data, BufferJSON.replacer);
    await col.updateOne({ _id: id }, { $set: { value } }, { upsert: true });
  }

  async function removeData(id) {
    await col.deleteOne({ _id: id });
  }

  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData("creds", creds),
  };
}

module.exports = { useMongoAuthState };
