// اتصال بقاعدة بيانات MongoDB Atlas — لو ما فيه رابط أو فشل الاتصال،
// البوت يستمر يشتغل بالذاكرة بس (بدون حفظ دائم) بدل ما يتوقف بالكامل

const { MongoClient } = require("mongodb");

let db = null;
let client = null;

async function connect(uri) {
  if (!uri) {
    console.log(
      "⚠️ ما فيه رابط MongoDB بملف data/config.json (mongoUri). البوت بيشتغل بالذاكرة بس، والبيانات بتنمسح لو انطفى."
    );
    return null;
  }
  // ✅ 3 محاولات: قبل كذا لو فشلت أول محاولة (تعثر شبكة لحظي وقت الإقلاع) يشتغل
  // البوت بالذاكرة بس طول عمره لين تعيد التشغيل، وتضيع كل النقاط عند أي إعادة تشغيل
  const ATTEMPTS = 3;
  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      client = new MongoClient(uri);
      await client.connect();
      db = client.db("anime_quiz_bot");
      console.log("✅ اتصل بقاعدة بيانات MongoDB بنجاح.");
      return db;
    } catch (e) {
      console.error(`❌ فشل الاتصال بـ MongoDB (محاولة ${i}/${ATTEMPTS}):`, e.message);
      try {
        await client.close();
      } catch (_) {
        /* تجاهل */
      }
      if (i < ATTEMPTS) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  console.log("⚠️ البوت بيكمل يشتغل بالذاكرة بس (بدون حفظ دائم) لحد ما تصلّح الاتصال وتعيد التشغيل.");
  db = null;
  return null;
}

function getDb() {
  return db;
}

module.exports = { connect, getDb };
