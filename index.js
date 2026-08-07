// Gamepay Cafe - WhatsApp Cloud API Webhook Server
// Handles: (1) Meta's webhook verification, (2) incoming messages, (3) AI reply via Claude

const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const {
  VERIFY_TOKEN,        // any string you choose, must match what you put in Meta dashboard
  WHATSAPP_TOKEN,       // permanent access token from Meta (System User)
  PHONE_NUMBER_ID,      // from WhatsApp > API Setup in Meta dashboard
  ANTHROPIC_API_KEY,    // Claude API key
  PORT = 3000,
} = process.env;

// ---------- Cafe info the AI will use to answer FAQs ----------
const CAFE_CONTEXT = `
You are the WhatsApp assistant for Gamepay Cafe, a gaming cafe.
Answer customer questions about hours, pricing, and games briefly and in a friendly tone.
If the customer wants to book a slot, ask which date, time, and how many hours/players,
then say a booking confirmation and payment link will follow shortly.
Keep replies short (2-4 sentences), suitable for WhatsApp.

--- Cafe details (edit this with your real info) ---
Hours: 11 AM - 11 PM, all days
Games available: PS5, PS3, Tekken Tag, GTA, Mustaffa, God Of War, Tekken 8, Spider Man
Pricing: PS5 - Rs 150/hour, Tekken Tag - Rs 10 - 4 Coin, PS3 - 100/hour
Address: [📍 Gamepay Cafe
SHop No-5, CS1, Block C, Near SBI BANK & BANDHAN BANK, Nandgram, Ghaziabad, Uttar Pradesh]
`;

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

    const reply = await getAIReply(text);
    await sendWhatsAppMessage(from, reply);
  } catch (err) {
    console.error("Error handling incoming message:", err.message);
  }
});

// ============================================================
// Call Claude to generate a reply
// ============================================================
async function getAIReply(userMessage) {
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: CAFE_CONTEXT,
      messages: [{ role: "user", content: userMessage }],
    },
    {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    }
  );

  return response.data.content[0].text;
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
