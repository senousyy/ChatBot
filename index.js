/**
 * Chatbot Integration - UltraMsg + Oracle ORDS
 * Author: Yousef Mahmoud
 */

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const fetch = require("node-fetch");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // ⛔️ لتخطي التحقق من SSL (للاختبار فقط)

const app = express();
const PORT = process.env.PORT || 3000;

// --- إعداد القيم --- //
const ULTRA_INSTANCE_ID = "instance142984";
const ULTRA_TOKEN = "799w3nqqj4fbwxt9";
const ULTRA_SEND_URL = `https://api.ultramsg.com/${ULTRA_INSTANCE_ID}/messages/chat`;

const SARWA_API_BASE = "https://sl-portal.sarwa.insurance/ords/sl_ws/MEMBERS";
const SARWA_LOG_API = "https://sl-portal.sarwa.insurance/ords/sl_ws/discussion/messages";
const SECRET_KEY = "your_super_secret_key_here_change_this";
// ---------------------- //

app.use(bodyParser.json());

const processedMessages = new Set();
const welcomedUsers = new Set();
const verifiedUsers = new Map();

// اختبار تشغيل السيرفر
app.get("/", (req, res) => res.send("✅ Server is running"));

// Webhook Endpoint
app.post("/ultramsgwebhook", async (req, res) => {
  try {
    console.log("📩 Incoming Webhook:", JSON.stringify(req.body).slice(0, 1000));

    const data = req.body.data || req.body;
    const from = data.from;
    const rawBody = (data.body || "").toString().trim();
    const messageHash = req.body.hash;

    const cleanFrom = from.split("@")[0];

    console.log("👤 From:", from);
    console.log("💬 Body:", rawBody);
    console.log("🔑 Hash:", messageHash);

    // تجاهل التكرار
    if (processedMessages.has(messageHash)) {
      console.log("🔁 Duplicate message ignored");
      return res.sendStatus(200);
    }
    processedMessages.add(messageHash);

    // سجل الرسالة
    await logMessage({
      member_id: null,
      message: rawBody,
      sender: "USER",
      user_number: cleanFrom,
    });

    // لو المستخدم اتحقق قبل كده
    if (verifiedUsers.has(from)) {
      const userData = verifiedUsers.get(from);
      const memberId = userData.memberId;
      let reply = "";

      if (["1", "2"].includes(rawBody)) {
        const secureToken = createSecureToken(memberId, cleanFrom);
        const uploadUrl = `https://sl-portal.sarwa.insurance/ords/r/sl_ws/slportal10511020151201212044/document?p3_token=${secureToken}`;
        reply = `برجاء رفع المستندات المطلوبة عبر الرابط التالي:\n${uploadUrl}`;
      } else if (rawBody === "3") {
        reply = "للاستفسارات برجاء الاتصال على XXXX";
      } else {
        reply = "عذراً، برجاء اختيار رقم من 1 إلى 3.";
      }

      await sendUltraReply(from, reply);
      await logMessage({ member_id: memberId, message: reply, sender: "BOT", user_number: cleanFrom });
      return res.sendStatus(200);
    }

    // لو دي أول رسالة
    if (!welcomedUsers.has(from)) {
      const reply = "مرحباً بكم في ثروة لتأمينات الحياة!\nبرجاء إدخال رقم الكارت الطبي الخاص بكم للمتابعة.";
      await sendUltraReply(from, reply);
      await logMessage({ member_id: null, message: reply, sender: "BOT", user_number: cleanFrom });
      welcomedUsers.add(from);
      return res.sendStatus(200);
    }

    // تحقق من رقم الكارت
    const memberId = rawBody.replace(/\D/g, "");
    if (!memberId || !/^\d+$/.test(rawBody)) {
      const reply = "برجاء إدخال رقم الكارت الطبي الصحيح أو التواصل على XXXX.";
      await sendUltraReply(from, reply);
      await logMessage({ member_id: null, message: reply, sender: "BOT", user_number: cleanFrom });
      return res.sendStatus(200);
    }

    // استدعاء Sarwa ORDS
    const ordsUrl = `${SARWA_API_BASE}/${encodeURIComponent(memberId)}`;
    console.log("🔍 Calling Sarwa ORDS:", ordsUrl);

    let sarwaJson;
    try {
      const r = await fetch(ordsUrl);
      sarwaJson = await r.json();
      console.log("🔎 Sarwa Response:", sarwaJson);
    } catch (err) {
      console.error("❌ Error calling Sarwa API:", err.message);
      const reply = "حدث خطأ أثناء الاتصال بالنظام، برجاء المحاولة لاحقًا.";
      await sendUltraReply(from, reply);
      await logMessage({ member_id: null, message: reply, sender: "BOT", user_number: cleanFrom });
      return res.sendStatus(200);
    }

    // الرد النهائي
    let reply = "لم يتم العثور على بيانات العضو، برجاء التأكد من الرقم.";
    let detectedMemberId = null;

    if (sarwaJson?.items?.length > 0) {
      const member = sarwaJson.items[0];
      const name = member.member_name || member.MEMBER_NAME || "العميل";
      detectedMemberId = member.member_id || member.MEMBER_ID;

      reply = `أهلاً ${name}، كيف يمكننا مساعدتك اليوم؟\n1 - لإضافة علاج شهري جديد\n2 - لتعديل علاج شهري\n3 - للاستفسارات`;

      verifiedUsers.set(from, { memberId: detectedMemberId, name, userNumber: cleanFrom });
    }

    await sendUltraReply(from, reply);
    await logMessage({ member_id: detectedMemberId, message: reply, sender: "BOT", user_number: cleanFrom });
    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook Error:", err);
    return res.sendStatus(200);
  }
});

// ====== 🧠 المساعدين ====== //

async function logMessage({ member_id, message, sender, user_number }) {
  try {
    const body = {
      member_id: member_id ? Number(member_id) : null,
      message,
      sender,
      user_number,
    };

    console.log("🟢 logMessage ->", JSON.stringify(body));

    const resp = await fetch(SARWA_LOG_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const json = await resp.json().catch(() => ({}));
    console.log("📝 ORDS Response:", resp.status, json);

    if (!resp.ok) {
      console.error("❌ ORDS returned non-OK:", resp.status);
    }

    return { status: resp.status, body: json };
  } catch (err) {
    console.error("❌ logMessage error:", err.message);
    return { error: err.message };
  }
}

async function sendUltraReply(to, text) {
  try {
    const params = new URLSearchParams();
    params.append("token", ULTRA_TOKEN);
    params.append("to", to);
    params.append("body", text);

    const resp = await fetch(ULTRA_SEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const json = await resp.json();
      console.log("📤 UltraMsg response:", json);
      return { status: resp.status, body: json };
    } else {
      const txt = await resp.text();
      console.log("📤 UltraMsg raw:", txt);
      return { status: resp.status, body: txt };
    }
  } catch (err) {
    console.error("❌ sendUltraReply error:", err.message);
    return { error: err.message };
  }
}

function createSecureToken(memberId, userNumber) {
  const cleanUserNumber = userNumber.split("@")[0];
  const timestamp = Date.now();
  const data = `${memberId}:${cleanUserNumber}:${timestamp}`;
  const hmac = crypto.createHmac("sha256", SECRET_KEY).update(data).digest("hex");
  return Buffer.from(`${data}:${hmac}`).toString("base64");
}

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
