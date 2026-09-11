// Gamepay Cafe - WhatsApp Cloud API Webhook Server
// Handles: (1) Meta's webhook verification, (2) incoming messages,
// (3) AI reply via Gemini for FAQs, (4) a step-by-step booking flow

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const admin = require("firebase-admin");
require("dotenv").config();

// ---------- Firestore (same Firebase project as the website: "gamepay-cafe") ----------
// FIREBASE_SERVICE_ACCOUNT_KEY = the whole service account JSON, as one string,
// pasted into a Render/hosting environment variable. Get it from:
// Firebase Console -> Project Settings -> Service Accounts -> Generate new private key
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)),
});
const db = admin.firestore();
const bookingsCollection = db.collection("bookings");

const app = express();

// Allow the website (gamepaycafe.online) to call this server's /api/* routes.
// If you later host the site on the exact same domain as this server, you
// can remove this - but for now the site and this backend are separate.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Capture the raw request body too - Razorpay webhook signature verification
// needs the exact raw bytes, not the parsed JSON object.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

const {
  VERIFY_TOKEN,          // any string you choose, must match what you put in Meta dashboard
  WHATSAPP_TOKEN,         // permanent access token from Meta (System User)
  PHONE_NUMBER_ID,        // from WhatsApp > API Setup in Meta dashboard
  GEMINI_API_KEY,         // Google Gemini API key (free tier)
  RAZORPAY_KEY_ID,        // from Razorpay Dashboard > Settings > API Keys
  RAZORPAY_KEY_SECRET,    // from Razorpay Dashboard > Settings > API Keys
  RAZORPAY_WEBHOOK_SECRET,// a secret string YOU choose, set the same in Razorpay webhook settings
  ADVANCE_AMOUNT_RUPEES = "100", // booking advance amount collected via link
  OWNER_NUMBER,           // your own WhatsApp number (with country code, no +), e.g. 919876543210 - for admin commands
  PORT = 3000,
} = process.env;

// ---------- Cafe info the AI will use to answer FAQs ----------
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

// ---------- The exact 4 ice breaker texts set up in Meta dashboard ----------
const ICE_BREAKERS = {
  RATES: "aaj ke gaming rates kya hai?",
  GAMES: "kaunse games available hai?",
  LOCATION_TIMING: "cafe ka location & timing kya hai?",
  BOOK: "ek gaming slot book karna hai",
};

// Also trigger booking flow if the customer just types something booking-related
const BOOKING_KEYWORDS = ["book", "booking", "slot"];

// Keywords that should get a fixed reply instead of going to the AI
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

// Body text shown above the buttons, and the rows themselves, for the
// interactive "quick menu" sent when a customer says hi/menu/help.
// Row "id" values are what come back in the webhook when a customer taps one -
// they are matched in routeMessage() below.
const QUICK_MENU_BODY = "Gamepay Cafe mein aapka swagat hai! 🎮\nNeeche se ek option chuno:";
const QUICK_MENU_BUTTON_LABEL = "Menu dekho";
const QUICK_MENU_ROWS = [
  { id: "menu_book", title: "Book Slot", description: "Gaming slot book karo" },
  { id: "menu_pricing", title: "Pricing", description: "Rates jaano" },
  { id: "menu_timings", title: "Timings", description: "Cafe kab khula hai" },
  { id: "menu_tournaments", title: "Tournaments", description: "Upcoming tournaments" },
  { id: "menu_location", title: "Location", description: "Cafe ka address" },
];

// Edit this whenever you have a running offer/combo deal
const OFFERS_TEXT =
  `Abhi koi special offer nahi chal raha. Rates jaanne ke liye "rates" type karo!`;

const TOURNAMENTS_KEYWORDS = ["tournament", "tournaments"];

// Edit this whenever you have a tournament scheduled
const TOURNAMENTS_TEXT =
  `Abhi koi tournament schedule nahi hai. Jaise hi announce hoga, yahin update kar denge!`;

// ---------- In-memory session store for the booking flow ----------
// NOTE: this resets whenever the server restarts (e.g. Render free tier sleep/wake).
// Fine for a low-traffic cafe bot; move to a database/Sheet later if needed.
const sessions = new Map(); // phone number -> { step, data }

// Tracks pending bookings so we know which customer to message when
// Razorpay tells us a payment link was paid. Keyed by Razorpay payment_link id.
const pendingBookings = new Map(); // payment_link_id -> { phone, dateTime, gamePlayers }

// ---------- Website booking system ----------
// Station prices - MUST match what's shown on the website. Edit here if you
// change prices on the site, this is the source of truth for what gets charged.
const STATION_PRICES = {
  "PC Gaming Bay": 90,
  "Console Zone": 80,
  "VR Arena": 150,
  "Squad Room": 350,
};

// Real, verified bookings made through the website (paid + signature-checked)
// now live in Firestore (see bookingsCollection above), so they survive
// server restarts. Doc ID = `${date}|${time}|${stationType}` to block
// double-booking of the exact same slot.
// Orders created but not yet paid - so verify-payment can look up what was booked.
const pendingWebOrders = new Map(); // razorpay_order_id -> booking details

// ============================================================
// STEP 1: Webhook verification (Meta calls this once when you
// set up the webhook URL in the dashboard)
// ============================================================
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

// ============================================================
// STEP 1.5: Website Booking & Payment API
// These are the endpoints the website's booking form calls.
// Flow: create-order (get a Razorpay order) -> customer pays in the
// Razorpay popup -> verify-payment (we confirm it's real) -> booking saved.
// ============================================================

// GET /api/booked-slots?date=2026-09-15
// Website calls this to grey out time slots that are already taken.
app.get("/api/booked-slots", async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date is required" });

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

// POST /api/create-order
// Body: { stationType, duration, date, time, name, phone }
// Creates a real Razorpay order for the exact amount (calculated server-side,
// never trust a price sent from the browser) and returns what Checkout.js needs.
app.post("/api/create-order", async (req, res) => {
  try {
    const { stationType, duration, date, time, name, phone } = req.body;

    const hourlyRate = STATION_PRICES[stationType];
    if (!hourlyRate) {
      return res.status(400).json({ error: "Invalid station type" });
    }
    const hours = parseInt(duration, 10);
    if (!hours || hours < 1 || hours > 12) {
      return res.status(400).json({ error: "Invalid duration" });
    }
    if (!date || !time || !name || !phone) {
      return res.status(400).json({ error: "Missing booking details" });
    }

    // Block double-booking the same station + slot
    const slotKey = `${date}|${time}|${stationType}`;
    const existingDoc = await bookingsCollection.doc(slotKey).get();
    if (existingDoc.exists) {
      return res.status(409).json({ error: "This slot is already booked. Please pick another." });
    }

    const amountRupees = hourlyRate * hours;

    const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
    const orderResponse = await axios.post(
      "https://api.razorpay.com/v1/orders",
      {
        amount: Math.round(amountRupees * 100), // paise
        currency: "INR",
        receipt: `booking_${Date.now()}`,
        notes: { stationType, duration: hours, date, time, name, phone },
      },
      { headers: { Authorization: `Basic ${auth}`, "content-type": "application/json" } }
    );

    const order = orderResponse.data;

    // Remember what this order was for, so verify-payment can save it once paid
    pendingWebOrders.set(order.id, { stationType, duration: hours, date, time, name, phone, amountRupees });

    res.json({
      orderId: order.id,
      amount: order.amount, // in paise, Checkout.js needs this exact value
      currency: order.currency,
      key: RAZORPAY_KEY_ID, // public key id - safe to expose to the browser
    });
  } catch (err) {
    console.error("create-order error:", err.response?.data || err.message);
    res.status(500).json({ error: "Could not create order. Please try again." });
  }
});

// POST /api/verify-payment
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
// Called by the website right after Razorpay Checkout succeeds. We verify the
// signature ourselves - this is the step that makes the payment "real"
// instead of trusting whatever the browser tells us.
app.post("/api/verify-payment", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment details" });
    }

    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      console.warn("Payment signature mismatch - possible tampering attempt");
      return res.status(400).json({ error: "Payment verification failed" });
    }

    const booking = pendingWebOrders.get(razorpay_order_id);
    if (!booking) {
      return res.status(404).json({ error: "Order not found" });
    }
    pendingWebOrders.delete(razorpay_order_id);

    const slotKey = `${booking.date}|${booking.time}|${booking.stationType}`;
    const bookingRecord = { ...booking, paymentId: razorpay_payment_id, bookedAt: new Date().toISOString() };

    // Transaction = if two people somehow pay for the same slot at almost the
    // same moment, only the first write wins - the second is safely rejected
    // here instead of silently overwriting the first booking.
    try {
      await db.runTransaction(async (t) => {
        const docRef = bookingsCollection.doc(slotKey);
        const doc = await t.get(docRef);
        if (doc.exists) {
          throw new Error("SLOT_TAKEN");
        }
        t.set(docRef, bookingRecord);
      });
    } catch (err) {
      if (err.message === "SLOT_TAKEN") {
        // Refunding is a manual step in Razorpay dashboard for now - flagged here
        console.error(`DOUBLE BOOKING PAID for ${slotKey} - refund payment ${razorpay_payment_id} manually`);
        return res.status(409).json({ error: "Slot was just taken. Contact us for a refund - we'll sort it out." });
      }
      throw err;
    }

    const confirmationText =
      `Booking confirmed! ✅\n\n` +
      `${booking.stationType} - ${booking.duration}hr\n` +
      `${booking.date}, ${booking.time}\n` +
      `Amount paid: ₹${booking.amountRupees}\n\n` +
      `See you at GamePay Cafe! 🎮`;

    // Notify the customer on WhatsApp (only if they gave a valid WhatsApp number)
    if (booking.phone) {
      sendWhatsAppMessage(booking.phone, confirmationText).catch((e) =>
        console.error("Failed to send customer confirmation:", e.message)
      );
    }
    // Notify you (the owner) so staff know to expect them
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


// ============================================================
// STEP 2: Receiving incoming WhatsApp messages
// ============================================================
app.post("/webhook", async (req, res) => {
  // Always respond 200 quickly so Meta doesn't retry/timeout
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (!message) return; // could be a status update (delivered/read), ignore

    const from = message.from; // customer's WhatsApp number

    // Plain text message, OR a tap on a list/button reply we sent earlier -
    // both get turned into a "text" string that routeMessage() understands.
    let text = message.text?.body;
    if (!text && message.interactive) {
      text =
        message.interactive.list_reply?.id ||
        message.interactive.button_reply?.id;
    }

    if (!text) return; // ignoring other message types (images, audio, etc.)

    console.log(`Message from ${from}: ${text}`);

    const reply = await routeMessage(from, text);
    // routeMessage() sends the interactive list itself (see QUICK_MENU) and
    // returns null in that case - nothing more to send here.
    if (reply) await sendWhatsAppMessage(from, reply);
  } catch (err) {
    console.error("Error handling incoming message:", err.message);
  }
});

// ============================================================
// Owner-only commands - typed from OWNER_NUMBER only
// ============================================================
function handleOwnerCommand(lowerText) {
  if (lowerText === "/pending") {
    if (pendingBookings.size === 0) {
      return "Koi pending (unpaid) booking nahi hai abhi.";
    }
    const lines = [...pendingBookings.values()].map(
      (b, i) => `${i + 1}. ${b.phone} - ${b.dateTime} - ${b.gamePlayers}`
    );
    return `Pending bookings (${pendingBookings.size}):\n\n${lines.join("\n")}`;
  }

  // NOTE: "/today" and "/broadcast" aren't included yet because confirmed
  // (paid) bookings and the customer list aren't saved anywhere in this
  // code - only unpaid pendingBookings are tracked, and that's in-memory
  // only (resets on server restart). Add a database/Sheet first, then
  // these become possible.

  return null; // not a recognized owner command
}

// ============================================================
// Decide how to respond: continue a booking flow, start one,
// or just answer as a normal FAQ via AI
// ============================================================
async function routeMessage(from, rawText) {
  const text = rawText.trim();
  const lower = text.toLowerCase();

  // Owner-only commands - only work if the message comes from YOUR own
  // WhatsApp number (set OWNER_NUMBER in Render env vars)
  if (OWNER_NUMBER && from === OWNER_NUMBER) {
    const ownerReply = handleOwnerCommand(lower);
    if (ownerReply) return ownerReply;
    // if it's not a recognized owner command, fall through to normal flow
    // so you can also test the bot as a regular customer from your own number
  }

  // Let the customer cancel a booking in progress anytime
  if (sessions.has(from) && ["cancel", "cancel karo", "band karo"].includes(lower)) {
    sessions.delete(from);
    return "Theek hai, booking cancel kar di. Kuch aur poochna ho to batao!";
  }

  // If a booking flow is already in progress for this customer, continue it
  if (sessions.has(from)) {
    return continueBooking(from, text);
  }

  // "menu" / "help" / "hi" - send the interactive quick-menu (buttons/list)
  if (MENU_KEYWORDS.some((k) => lower === k || lower.includes(k))) {
    await sendWhatsAppList(
      from,
      QUICK_MENU_BODY,
      QUICK_MENU_BUTTON_LABEL,
      QUICK_MENU_ROWS
    );
    return null; // already sent above, nothing more to send
  }

  // Taps on the quick-menu rows (ids set in QUICK_MENU_ROWS above)
  if (lower === "menu_book") {
    sessions.set(from, { step: "ask_date_time", data: {} });
    return "Great! Booking ke liye bas 2 cheezein bata do:\n\nKaunsi date aur time chahiye? (jaise: 9 Aug, 6 PM)";
  }
  if (lower === "menu_pricing") return getAIReply(ICE_BREAKERS.RATES);
  if (lower === "menu_timings" || lower === "menu_location")
    return getAIReply(ICE_BREAKERS.LOCATION_TIMING);
  if (lower === "menu_tournaments") return TOURNAMENTS_TEXT;

  // "tournaments" typed as plain text
  if (TOURNAMENTS_KEYWORDS.some((k) => lower.includes(k))) {
    return TOURNAMENTS_TEXT;
  }

  // "status" / "mera booking" - check if they have an unpaid pending booking
  if (STATUS_KEYWORDS.some((k) => lower.includes(k))) {
    const pending = [...pendingBookings.values()].find((b) => b.phone === from);
    if (pending) {
      return (
        `Aapki booking payment ka wait kar rahi hai:\n` +
        `Date/Time: ${pending.dateTime}\n` +
        `Game/Players: ${pending.gamePlayers}\n\n` +
        `Payment link expire ho gaya ho to "book" type karke dobara try karo.`
      );
    }
    return `Koi active/pending booking nahi mili aapke number pe. Naya booking karne ke liye "book" type karo!`;
  }

  // "cancel booking" - note: this can only cancel an UNPAID pending booking,
  // since confirmed (paid) bookings aren't saved anywhere yet in this code
  if (CANCEL_BOOKING_KEYWORDS.some((k) => lower.includes(k))) {
    const entry = [...pendingBookings.entries()].find(([, b]) => b.phone === from);
    if (entry) {
      pendingBookings.delete(entry[0]);
      return `Aapki pending booking cancel kar di gayi hai.`;
    }
    return (
      `Aapke number pe koi pending (unpaid) booking nahi mili. ` +
      `Agar aapne already payment kar diya hai, cafe pe call karke cancel karwa lein.`
    );
  }

  // "offers" - fixed text, edit OFFERS_TEXT above whenever you run a deal
  if (OFFERS_KEYWORDS.some((k) => lower.includes(k))) {
    return OFFERS_TEXT;
  }

  // Ice breaker: "Ek gaming slot book karna hai" (or any booking-ish message)
  if (
    lower === ICE_BREAKERS.BOOK ||
    BOOKING_KEYWORDS.some((k) => lower.includes(k))
  ) {
    sessions.set(from, { step: "ask_date_time", data: {} });
    return "Great! Booking ke liye bas 2 cheezein bata do:\n\nKaunsi date aur time chahiye? (jaise: 9 Aug, 6 PM)";
  }

  // Other 3 ice breakers (rates, games, location & timing) + any other FAQ
  // just go straight to the AI, which already has all the cafe details.
  return getAIReply(text);
}

// ============================================================
// Step-by-step booking conversation
// ============================================================
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
    sessions.delete(from); // booking flow complete

    try {
      const { shortUrl, paymentLinkId } = await createPaymentLink(
        from,
        session.data.dateTime,
        session.data.gamePlayers
      );

      // Remember this booking so we can confirm it once payment comes in
      pendingBookings.set(paymentLinkId, {
        phone: from,
        dateTime: session.data.dateTime,
        gamePlayers: session.data.gamePlayers,
      });

      return (
        `Booking summary:\n` +
        `Date/Time: ${session.data.dateTime}\n` +
        `Game/Players: ${session.data.gamePlayers}\n\n` +
        `Slot lock karne ke liye Rs ${ADVANCE_AMOUNT_RUPEES} advance pay kar do (baaki cafe pe pay kar dena):\n${shortUrl}\n\n` +
        `Payment hote hi confirmation aa jayega.`
      );
    } catch (err) {
      console.error("Razorpay error:", err.response?.data || err.message);
      return (
        `Booking note kar li hai (${session.data.dateTime}, ${session.data.gamePlayers}), ` +
        `lekin payment link banane mein dikkat aa gayi. Cafe pe call karke confirm kar lena.`
      );
    }
  }

  // Fallback safety net - shouldn't normally reach here
  sessions.delete(from);
  return "Kuch gadbad ho gayi, dobara try karo - 'Ek gaming slot book karna hai' likho.";
}

// ============================================================
// Call Gemini to generate a reply for FAQs
// ============================================================
async function getAIReply(userMessage) {
  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      system_instruction: {
        parts: [{ text: CAFE_CONTEXT }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userMessage }],
        },
      ],
      generationConfig: {
        maxOutputTokens: 300,
      },
    },
    {
      headers: {
        "content-type": "application/json",
      },
    }
  );

  return response.data.candidates[0].content.parts[0].text;
}

// ============================================================
// Create a Razorpay Payment Link for the booking advance
// ============================================================
async function createPaymentLink(customerPhone, dateTime, gamePlayers) {
  const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString(
    "base64"
  );

  const response = await axios.post(
    "https://api.razorpay.com/v1/payment_links",
    {
      amount: Math.round(parseFloat(ADVANCE_AMOUNT_RUPEES) * 100), // paise
      currency: "INR",
      accept_partial: false,
      description: `Gamepay Cafe booking - ${dateTime} - ${gamePlayers}`,
      customer: {
        contact: `+${customerPhone}`,
      },
      notify: {
        sms: false,
        email: false,
        // We send the link ourselves via WhatsApp, so Razorpay's own
        // notify channels are turned off to avoid duplicate messages.
      },
      reminder_enable: true,
      notes: {
        whatsapp_number: customerPhone,
        date_time: dateTime,
        game_players: gamePlayers,
      },
    },
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "content-type": "application/json",
      },
    }
  );

  return { shortUrl: response.data.short_url, paymentLinkId: response.data.id };
}

// ============================================================
// Razorpay Webhook - fires when a payment link gets paid
// Set this URL in Razorpay Dashboard > Settings > Webhooks:
//   https://your-app.onrender.com/razorpay-webhook
// Event to subscribe to: payment_link.paid
// ============================================================
app.post("/razorpay-webhook", async (req, res) => {
  res.sendStatus(200); // acknowledge quickly

  try {
    const signature = req.headers["x-razorpay-signature"];
    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)
      .update(req.rawBody)
      .digest("hex");

    if (signature !== expectedSignature) {
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
      `Payment received! Aapki booking confirm ho gayi hai:\n` +
        `Date/Time: ${booking.dateTime}\n` +
        `Game/Players: ${booking.gamePlayers}\n\n` +
        `Milte hai Gamepay Cafe mein!`
    );
  } catch (err) {
    console.error("Error handling Razorpay webhook:", err.message);
  }
});


// ============================================================
// Send an interactive "list" message (WhatsApp's version of a
// menu with more than 3 buttons - up to 10 rows in one section).
// This is what shows up when a customer taps the "hi"/menu command.
// ============================================================
async function sendWhatsAppList(to, bodyText, buttonLabel, rows) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: bodyText },
        action: {
          button: buttonLabel, // max 20 chars
          sections: [
            {
              title: "Quick Menu",
              rows, // each row: { id, title, description }
            },
          ],
        },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "content-type": "application/json",
      },
    }
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
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "content-type": "application/json",
      },
    }
  );
}

app.get("/", (req, res) => res.send("Gamepay Cafe webhook is running"));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
