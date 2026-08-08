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
  try {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db("anime_quiz_bot");
    console.log("✅ اتصل بقاعدة بيانات MongoDB بنجاح.");
    return db;
  } catch (e) {
    console.error("❌ فشل الاتصال بـ MongoDB:", e.message);
    console.log("⚠️ البوت بيكمل يشتغل بالذاكرة بس (بدون حفظ دائم) لحد ما تصلّح الاتصال.");
    db = null;
    return null;
  }
}

function getDb() {
  return db;
}

module.exports = { connect, getDb };
