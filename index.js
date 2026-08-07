// Gamepay Cafe - WhatsApp Cloud API Webhook Server
// Handles: (1) Meta's webhook verification, (2) incoming messages,
// (3) AI reply via Gemini for FAQs, (4) a step-by-step booking flow

const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const {
  VERIFY_TOKEN,        // any string you choose, must match what you put in Meta dashboard
  WHATSAPP_TOKEN,       // permanent access token from Meta (System User)
  PHONE_NUMBER_ID,      // from WhatsApp > API Setup in Meta dashboard
  GEMINI_API_KEY,       // Google Gemini API key (free tier)
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

// ---------- In-memory session store for the booking flow ----------
// NOTE: this resets whenever the server restarts (e.g. Render free tier sleep/wake).
// Fine for a low-traffic cafe bot; move to a database/Sheet later if needed.
const sessions = new Map(); // phone number -> { step, data }

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
    const text = message.text?.body;

    if (!text) return; // ignoring non-text messages for now (images, audio, etc.)

    console.log(`Message from ${from}: ${text}`);

    const reply = await routeMessage(from, text);
    await sendWhatsAppMessage(from, reply);
  } catch (err) {
    console.error("Error handling incoming message:", err.message);
  }
});

// ============================================================
// Decide how to respond: continue a booking flow, start one,
// or just answer as a normal FAQ via AI
// ============================================================
async function routeMessage(from, rawText) {
  const text = rawText.trim();
  const lower = text.toLowerCase();

  // Let the customer cancel a booking in progress anytime
  if (sessions.has(from) && ["cancel", "cancel karo", "band karo"].includes(lower)) {
    sessions.delete(from);
    return "Theek hai, booking cancel kar di. Kuch aur poochna ho to batao!";
  }

  // If a booking flow is already in progress for this customer, continue it
  if (sessions.has(from)) {
    return continueBooking(from, text);
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

    // TODO: Once Razorpay is integrated, generate a real payment link here
    // and save this booking to a database/Google Sheet instead of just replying.
    return (
      `Booking summary:\n` +
      `Date/Time: ${session.data.dateTime}\n` +
      `Game/Players: ${session.data.gamePlayers}\n\n` +
      `Aapki booking note kar li gayi hai! Payment link jaldi bhejenge confirm karne ke liye. ` +
      `Kuch change karna ho to "cancel" likh ke dobara book kar sakte ho.`
    );
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
// Send a WhatsApp message back to the customer
// ============================================================
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
