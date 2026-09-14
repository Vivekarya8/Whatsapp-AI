// Gamepay Cafe - WhatsApp Cloud API Webhook Server
// Hardened production version: persistent website booking orders, idempotent
// payment verification, payment/refund safety checks, restricted CORS, and health check.

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const admin = require("firebase-admin");
require("dotenv").config();

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)),
});
const db = admin.firestore();
const bookingsCollection = db.collection("bookings");
const pendingWebOrdersCollection = db.collection("pendingWebOrders");

const app = express();

const ALLOWED_ORIGINS = new Set([
  "https://gamepaycafe.online",
  "https://www.gamepaycafe.online",
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
  }
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(
  express.json({
    limit: "50kb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

const {
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  GEMINI_API_KEY,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,
  ADVANCE_AMOUNT_RUPEES = "100",
  OWNER_NUMBER,
  PORT = 3000,
} = process.env;

const CAFE_CONTEXT = `
You are the WhatsApp assistant for Gamepay Cafe, a gaming cafe.
Answer customer questions about hours, pricing, games, and location briefly and in a friendly tone.
Keep replies short (2-4 sentences), suitable for WhatsApp. Reply in the same language/style the customer used (Hindi/Hinglish/English).
Do NOT handle bookings yourself - if a customer wants to book, tell them to type "book a slot" or use the "Ek gaming slot book karna hai" option.

--- Cafe details (edit this with your real info) ---
Hours: 11 AM - 11 PM, all days
Games available: PS5, PC gaming (Valorant, FIFA, GTA V), pool table
Pricing: PS5 - Rs 150/hour, PC - Rs 100/hour, Pool - Rs 200/hour
Location: [your cafe address]
`;

const ICE_BREAKERS = {
  RATES: "aaj ke gaming rates kya hai?",
  GAMES: "kaunse games available hai?",
  LOCATION_TIMING: "cafe ka location & timing kya hai?",
  BOOK: "ek gaming slot book karna hai",
};

const BOOKING_KEYWORDS = ["book", "booking", "slot"];
const MENU_KEYWORDS = ["menu", "help", "hi", "hello", "hey"];
const STATUS_KEYWORDS = ["status", "mera booking", "my booking"];
const CANCEL_BOOKING_KEYWORDS = ["cancel booking", "booking cancel"];
const OFFERS_KEYWORDS = ["offers", "offer", "discount"];
const MENU_TEXT =
  `Gamepay Cafe mein aapka swagat hai! 🎮\n\n` +
  `Neeche se poocho:\n` +
  `- "rates" - gaming rates\n` +
  `- "games" - available games\n` +
  `- "location" - cafe address & timing\n` +
  `- "book" - slot book karo`;
const QUICK_MENU_BODY = "Gamepay Cafe mein aapka swagat hai! 🎮\nNeeche se ek option chuno:";
const QUICK_MENU_BUTTON_LABEL = "Menu dekho";
const QUICK_MENU_ROWS = [
  { id: "menu_book", title: "Book Slot", description: "Gaming slot book karo" },
  { id: "menu_pricing", title: "Pricing", description: "Rates jaano" },
  { id: "menu_timings", title: "Timings", description: "Cafe kab khula hai" },
  { id: "menu_tournaments", title: "Tournaments", description: "Upcoming tournaments" },
  { id: "menu_location", title: "Location", description: "Cafe ka address" },
];
const OFFERS_TEXT = `Abhi koi special offer nahi chal raha. Rates jaanne ke liye "rates" type karo!`;
const TOURNAMENTS_KEYWORDS = ["tournament", "tournaments"];
const TOURNAMENTS_TEXT = `Abhi koi tournament schedule nahi hai. Jaise hi announce hoga, yahin update kar denge!`;

const sessions = new Map();
const pendingBookings = new Map();

const STATION_PRICES = {
  "PC Gaming Bay": 90,
  "Console Zone": 80,
  "VR Arena": 150,
  "Squad Room": 350,
};

function safeEqualHex(a, b) {
  try {
    const aBuf = Buffer.from(a, "hex");
    const bBuf = Buffer.from(b, "hex");
    return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

function isValidDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function validateBookingInput({ stationType, duration, date, time, name, phone }) {
  const hourlyRate = STATION_PRICES[stationType];
  if (!hourlyRate) return "Invalid station type";
  const hours = Number.parseInt(duration, 10);
  if (!Number.isInteger(hours) || hours < 1 || hours > 12) return "Invalid duration";
  if (!isValidDate(date)) return "Invalid date";
  if (typeof time !== "string" || time.trim().length < 2 || time.length > 40) return "Invalid time";
  if (typeof name !== "string" || name.trim().length < 2 || name.length > 100) return "Invalid name";
  const cleanPhone = normalizePhone(phone);
  if (cleanPhone.length < 10 || cleanPhone.length > 15) return "Invalid phone number";
  return null;
}

async function razorpayRequest(method, url, data) {
  const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
  return axios({
    method,
    url,
    data,
    timeout: 10000,
    headers: {
      Authorization: `Basic ${auth}`,
      "content-type": "application/json",
    },
  });
}

async function refundPayment(paymentId, amountPaise) {
  const response = await razorpayRequest(
    "post",
    `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`,
    { amount: amountPaise }
  );
  return response.data;
}

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, service: "gamepay-cafe-backend" });
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified successfully");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.get("/api/booked-slots", async (req, res) => {
  const { date } = req.query;
  if (!isValidDate(date)) return res.status(400).json({ error: "Valid date is required" });
  try {
    const snapshot = await bookingsCollection.where("date", "==", date).get();
    const taken = snapshot.docs.map((doc) => {
      const b = doc.data();
      return { time: b.time, stationType: b.stationType };
    });
    res.json({ taken });
  } catch (err) {
    console.error("booked-slots error:", err.message);
    res.status(500).json({ error: "Could not check availability" });
  }
});

app.post("/api/create-order", async (req, res) => {
  try {
    const { stationType, duration, date, time, name, phone } = req.body || {};
    const validationError = validateBookingInput({ stationType, duration, date, time, name, phone });
    if (validationError) return res.status(400).json({ error: validationError });

    const hours = Number.parseInt(duration, 10);
    const cleanPhone = normalizePhone(phone);
    const hourlyRate = STATION_PRICES[stationType];
    const amountRupees = hourlyRate * hours;
    const slotKey = `${date}|${time}|${stationType}`;
    const existingDoc = await bookingsCollection.doc(slotKey).get();
    if (existingDoc.exists) {
      return res.status(409).json({ error: "This slot is already booked. Please pick another." });
    }

    const orderResponse = await razorpayRequest("post", "https://api.razorpay.com/v1/orders", {
      amount: Math.round(amountRupees * 100),
      currency: "INR",
      receipt: `booking_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      notes: { stationType, duration: hours, date, time, name: name.trim(), phone: cleanPhone },
    });

    const order = orderResponse.data;
    await pendingWebOrdersCollection.doc(order.id).set({
      stationType,
      duration: hours,
      date,
      time,
      name: name.trim(),
      phone: cleanPhone,
      amountRupees,
      amountPaise: order.amount,
      currency: order.currency,
      status: "created",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("create-order error:", err.response?.data || err.message);
    res.status(500).json({ error: "Could not create order. Please try again." });
  }
});

app.post("/api/verify-payment", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment details" });
    }

    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    if (!safeEqualHex(expectedSignature, razorpay_signature)) {
      console.warn("Payment signature mismatch - possible tampering attempt");
      return res.status(400).json({ error: "Payment verification failed" });
    }

    const paymentResponse = await razorpayRequest(
      "get",
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(razorpay_payment_id)}`
    );
    const payment = paymentResponse.data;
    if (
      payment.order_id !== razorpay_order_id ||
      payment.currency !== "INR" ||
      payment.status !== "captured"
    ) {
      return res.status(400).json({ error: "Payment is not valid or has not been captured" });
    }

    const pendingRef = pendingWebOrdersCollection.doc(razorpay_order_id);
    const pendingSnap = await pendingRef.get();
    if (!pendingSnap.exists) {
      const existingPayment = await bookingsCollection
        .where("paymentId", "==", razorpay_payment_id)
        .limit(1)
        .get();
      if (!existingPayment.empty) return res.json({ success: true, message: "Booking already confirmed" });
      return res.status(404).json({ error: "Order not found or already processed" });
    }

    const booking = pendingSnap.data();
    if (booking.status !== "created") {
      return res.status(409).json({ error: "Order has already been processed" });
    }
    if (payment.amount !== booking.amountPaise || payment.currency !== booking.currency) {
      return res.status(400).json({ error: "Payment amount does not match the booking" });
    }

    const slotKey = `${booking.date}|${booking.time}|${booking.stationType}`;
    const bookingRef = bookingsCollection.doc(slotKey);
    const bookingRecord = {
      stationType: booking.stationType,
      duration: booking.duration,
      date: booking.date,
      time: booking.time,
      name: booking.name,
      phone: booking.phone,
      amountRupees: booking.amountRupees,
      paymentId: razorpay_payment_id,
      razorpayOrderId: razorpay_order_id,
      bookedAt: new Date().toISOString(),
    };

    let slotTaken = false;
    let alreadyConfirmed = false;
    await db.runTransaction(async (t) => {
      const [slotSnap, pendingOrderSnap] = await Promise.all([
        t.get(bookingRef),
        t.get(pendingRef),
      ]);
      if (!pendingOrderSnap.exists) {
        alreadyConfirmed = true;
        return;
      }
      if (slotSnap.exists) {
        const existing = slotSnap.data();
        if (existing.paymentId === razorpay_payment_id) {
          alreadyConfirmed = true;
          t.delete(pendingRef);
          return;
        }
        slotTaken = true;
        t.update(pendingRef, {
          status: "refund_required",
          conflictAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return;
      }
      t.set(bookingRef, bookingRecord);
      t.delete(pendingRef);
    });

    if (alreadyConfirmed) return res.json({ success: true, message: "Booking already confirmed" });

    if (slotTaken) {
      try {
        const refund = await refundPayment(razorpay_payment_id, payment.amount);
        await pendingRef.set({
          status: "refunded",
          refundId: refund.id || null,
          refundedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        if (OWNER_NUMBER) {
          sendWhatsAppMessage(
            OWNER_NUMBER,
            `⚠️ Double-booking prevented and payment refunded automatically.\n${booking.name} - ${booking.phone}\n${booking.date}, ${booking.time}\nRefund: ${refund.id || "processed"}`
          ).catch((e) => console.error("Failed to notify owner:", e.message));
        }
        return res.status(409).json({ error: "Slot was just taken. Your payment has been refunded automatically." });
      } catch (refundErr) {
        console.error("Automatic refund failed:", refundErr.response?.data || refundErr.message);
        await pendingRef.set({
          status: "refund_required",
          refundError: refundErr.response?.data || refundErr.message,
          refundFailedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        if (OWNER_NUMBER) {
          sendWhatsAppMessage(
            OWNER_NUMBER,
            `🚨 REFUND ACTION REQUIRED\nDouble-booking: ${booking.date}, ${booking.time}, ${booking.stationType}\nCustomer: ${booking.name} - ${booking.phone}\nPayment: ${razorpay_payment_id}\nAutomatic refund failed. Refund this payment in Razorpay Dashboard.`
          ).catch((e) => console.error("Failed to notify owner:", e.message));
        }
        return res.status(409).json({ error: "Slot was just taken. Please contact Gamepay Cafe for your refund." });
      }
    }

    const confirmationText =
      `Booking confirmed! ✅\n\n` +
      `${booking.stationType} - ${booking.duration}hr\n` +
      `${booking.date}, ${booking.time}\n` +
      `Amount paid: ₹${booking.amountRupees}\n\n` +
      `See you at GamePay Cafe! 🎮`;

    if (booking.phone) {
      sendWhatsAppMessage(booking.phone, confirmationText).catch((e) =>
        console.error("Failed to send customer confirmation:", e.message)
      );
    }
    if (OWNER_NUMBER) {
      sendWhatsAppMessage(
        OWNER_NUMBER,
        `🎮 New website booking!\n${booking.name} - ${booking.phone}\n${confirmationText}`
      ).catch((e) => console.error("Failed to notify owner:", e.message));
    }

    res.json({ success: true, message: "Booking confirmed" });
  } catch (err) {
    console.error("verify-payment error:", err.response?.data || err.message);
    res.status(500).json({ error: "Something went wrong verifying payment" });
  }
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    if (!message) return;
    const from = message.from;
    let text = message.text?.body;
    if (!text && message.interactive) {
      text = message.interactive.list_reply?.id || message.interactive.button_reply?.id;
    }
    if (!text) return;
    console.log(`Message from ${from}: ${text}`);
    const reply = await routeMessage(from, text);
    if (reply) await sendWhatsAppMessage(from, reply);
  } catch (err) {
    console.error("Error handling incoming message:", err.message);
  }
});

function handleOwnerCommand(lowerText) {
  if (lowerText === "/pending") {
    if (pendingBookings.size === 0) return "Koi pending (unpaid) booking nahi hai abhi.";
    const lines = [...pendingBookings.values()].map(
      (b, i) => `${i + 1}. ${b.phone} - ${b.dateTime} - ${b.gamePlayers}`
    );
    return `Pending bookings (${pendingBookings.size}):\n\n${lines.join("\n")}`;
  }
  return null;
}

async function routeMessage(from, rawText) {
  const text = rawText.trim();
  const lower = text.toLowerCase();
  if (OWNER_NUMBER && from === OWNER_NUMBER) {
    const ownerReply = handleOwnerCommand(lower);
    if (ownerReply) return ownerReply;
  }
  if (sessions.has(from) && ["cancel", "cancel karo", "band karo"].includes(lower)) {
    sessions.delete(from);
    return "Theek hai, booking cancel kar di. Kuch aur poochna ho to batao!";
  }
  if (sessions.has(from)) return continueBooking(from, text);
  if (MENU_KEYWORDS.some((k) => lower === k || lower.includes(k))) {
    await sendWhatsAppList(from, QUICK_MENU_BODY, QUICK_MENU_BUTTON_LABEL, QUICK_MENU_ROWS);
    return null;
  }
  if (lower === "menu_book") {
    sessions.set(from, { step: "ask_date_time", data: {} });
    return "Great! Booking ke liye bas 2 cheezein bata do:\n\nKaunsi date aur time chahiye? (jaise: 9 Aug, 6 PM)";
  }
  if (lower === "menu_pricing") return getAIReply(ICE_BREAKERS.RATES);
  if (lower === "menu_timings" || lower === "menu_location") return getAIReply(ICE_BREAKERS.LOCATION_TIMING);
  if (lower === "menu_tournaments") return TOURNAMENTS_TEXT;
  if (TOURNAMENTS_KEYWORDS.some((k) => lower.includes(k))) return TOURNAMENTS_TEXT;
  if (STATUS_KEYWORDS.some((k) => lower.includes(k))) {
    const pending = [...pendingBookings.values()].find((b) => b.phone === from);
    if (pending) {
      return `Aapki booking payment ka wait kar rahi hai:\nDate/Time: ${pending.dateTime}\nGame/Players: ${pending.gamePlayers}\n\nPayment link expire ho gaya ho to "book" type karke dobara try karo.`;
    }
    return `Koi active/pending booking nahi mili aapke number pe. Naya booking karne ke liye "book" type karo!`;
  }
  if (CANCEL_BOOKING_KEYWORDS.some((k) => lower.includes(k))) {
    const entry = [...pendingBookings.entries()].find(([, b]) => b.phone === from);
    if (entry) {
      pendingBookings.delete(entry[0]);
      return `Aapki pending booking cancel kar di gayi hai.`;
    }
    return `Aapke number pe koi pending (unpaid) booking nahi mili. Agar aapne already payment kar diya hai, cafe pe call karke cancel karwa lein.`;
  }
  if (OFFERS_KEYWORDS.some((k) => lower.includes(k))) return OFFERS_TEXT;
  if (lower === ICE_BREAKERS.BOOK || BOOKING_KEYWORDS.some((k) => lower.includes(k))) {
    sessions.set(from, { step: "ask_date_time", data: {} });
    return "Great! Booking ke liye bas 2 cheezein bata do:\n\nKaunsi date aur time chahiye? (jaise: 9 Aug, 6 PM)";
  }
  return getAIReply(text);
}

async function continueBooking(from, text) {
  const session = sessions.get(from);
  if (session.step === "ask_date_time") {
    session.data.dateTime = text;
    session.step = "ask_game_players";
    sessions.set(from, session);
    return "Perfect. Ab batao:\n\nKaunsa game chahiye (PS5 / PC / Pool) aur kitne players/hours ke liye?";
  }
  if (session.step === "ask_game_players") {
    session.data.gamePlayers = text;
    sessions.delete(from);
    try {
      const { shortUrl, paymentLinkId } = await createPaymentLink(from, session.data.dateTime, session.data.gamePlayers);
      pendingBookings.set(paymentLinkId, { phone: from, dateTime: session.data.dateTime, gamePlayers: session.data.gamePlayers });
      return `Booking summary:\nDate/Time: ${session.data.dateTime}\nGame/Players: ${session.data.gamePlayers}\n\nSlot lock karne ke liye Rs ${ADVANCE_AMOUNT_RUPEES} advance pay kar do (baaki cafe pe pay kar dena):\n${shortUrl}\n\nPayment hote hi confirmation aa jayega.`;
    } catch (err) {
      console.error("Razorpay error:", err.response?.data || err.message);
      return `Booking note kar li hai (${session.data.dateTime}, ${session.data.gamePlayers}), lekin payment link banane mein dikkat aa gayi. Cafe pe call karke confirm kar lena.`;
    }
  }
  sessions.delete(from);
  return "Kuch gadbad ho gayi, dobara try karo - 'Ek gaming slot book karna hai' likho.";
}

async function getAIReply(userMessage) {
  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      system_instruction: { parts: [{ text: CAFE_CONTEXT }] },
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: 300 },
    },
    { headers: { "content-type": "application/json" }, timeout: 10000 }
  );
  return response.data.candidates[0].content.parts[0].text;
}

async function createPaymentLink(customerPhone, dateTime, gamePlayers) {
  const response = await razorpayRequest("post", "https://api.razorpay.com/v1/payment_links", {
    amount: Math.round(parseFloat(ADVANCE_AMOUNT_RUPEES) * 100),
    currency: "INR",
    accept_partial: false,
    description: `Gamepay Cafe booking - ${dateTime} - ${gamePlayers}`,
    customer: { contact: `+${customerPhone}` },
    notify: { sms: false, email: false },
    reminder_enable: true,
    notes: { whatsapp_number: customerPhone, date_time: dateTime, game_players: gamePlayers },
  });
  return { shortUrl: response.data.short_url, paymentLinkId: response.data.id };
}

app.post("/razorpay-webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const signature = req.headers["x-razorpay-signature"];
    const expectedSignature = crypto.createHmac("sha256", RAZORPAY_WEBHOOK_SECRET).update(req.rawBody).digest("hex");
    if (!safeEqualHex(expectedSignature, signature || "")) {
      console.warn("Razorpay webhook signature mismatch - ignoring event");
      return;
    }
    const event = req.body.event;
    if (event !== "payment_link.paid") return;
    const paymentLinkId = req.body.payload.payment_link.entity.id;
    const booking = pendingBookings.get(paymentLinkId);
    if (!booking) {
      console.warn(`No pending booking found for payment link ${paymentLinkId}`);
      return;
    }
    pendingBookings.delete(paymentLinkId);
    await sendWhatsAppMessage(
      booking.phone,
      `Payment received! Aapki booking confirm ho gayi hai:\nDate/Time: ${booking.dateTime}\nGame/Players: ${booking.gamePlayers}\n\nMilte hai Gamepay Cafe mein!`
    );
  } catch (err) {
    console.error("Error handling Razorpay webhook:", err.message);
  }
});

async function sendWhatsAppList(to, bodyText, buttonLabel, rows) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: { type: "list", body: { text: bodyText }, action: { button: buttonLabel, sections: [{ title: "Quick Menu", rows }] } },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "content-type": "application/json" }, timeout: 10000 }
  );
}

async function sendWhatsAppMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "content-type": "application/json" }, timeout: 10000 }
  );
}

app.get("/", (req, res) => res.send("Gamepay Cafe webhook is running"));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
