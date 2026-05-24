/**
 * ============================================================
 *  CHANDRA COLOR SHOPPEE - WHATSAPP BOT SERVER - META v3.0
 * ============================================================
 *  This version uses META's WhatsApp Cloud API (not Twilio).
 *
 *  REQUIRED ENVIRONMENT VARIABLES (set in Render):
 *  - ANTHROPIC_API_KEY          (your Claude API key)
 *  - WHATSAPP_TOKEN             (Meta access token)
 *  - WHATSAPP_PHONE_NUMBER_ID   (Meta phone number ID)
 *  - WHATSAPP_VERIFY_TOKEN      (a password you invent yourself)
 *
 *  OPTIONAL (for Google Sheets lead capture):
 *  - GOOGLE_SHEET_ID
 *  - GOOGLE_SHEETS_KEY
 *
 *  WEBHOOK URL (set this in Meta):
 *  - https://your-app.onrender.com/webhook
 *
 *  You do NOT normally edit this file.
 *  To add products/offers/FAQs, edit botConfig.js instead.
 * ============================================================
 */

const express = require("express");
const { SYSTEM_PROMPT } = require("./botConfig");
const { google } = require("googleapis");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---- Settings (from environment variables) ----
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const GOOGLE_SHEETS_KEY = process.env.GOOGLE_SHEETS_KEY;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const PORT = process.env.PORT || 3000;
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 600;
const HISTORY_LIMIT = 15;

if (!ANTHROPIC_API_KEY) console.error("ERROR: ANTHROPIC_API_KEY not set.");
if (!WHATSAPP_TOKEN) console.error("ERROR: WHATSAPP_TOKEN not set.");
if (!WHATSAPP_PHONE_NUMBER_ID) console.error("ERROR: WHATSAPP_PHONE_NUMBER_ID not set.");
if (!WHATSAPP_VERIFY_TOKEN) console.error("ERROR: WHATSAPP_VERIFY_TOKEN not set.");

// ---- Google Sheets Setup ----
let sheetsClient = null;
try {
  if (GOOGLE_SHEETS_KEY && GOOGLE_SHEET_ID) {
    const key = JSON.parse(Buffer.from(GOOGLE_SHEETS_KEY, "base64").toString());
    const auth = new google.auth.GoogleAuth({
      credentials: key,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    sheetsClient = google.sheets({ version: "v4", auth });
    console.log("✓ Google Sheets client initialized");
  } else {
    console.warn("⚠ Google Sheets not configured");
  }
} catch (err) {
  console.error("Google Sheets setup error:", err.message);
}

// ---- In-memory conversation storage ----
const conversations = new Map();
// Track processed message IDs to avoid duplicate handling
const processedMessages = new Set();

function getHistory(userId) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  return conversations.get(userId);
}

function addToHistory(userId, role, text) {
  const history = getHistory(userId);
  history.push({ role, content: text });
  while (history.length > HISTORY_LIMIT) history.shift();
}

// ---- Customer Type Detection ----
function detectCustomerType(conversationHistory, latestMessage) {
  const text = (latestMessage + " " + conversationHistory.map(m => m.content).join(" ")).toLowerCase();
  if (/architect|designer|contractor|builder|project|bulk order|multiple sites|construction|commercial|site visit/i.test(text)) return "architect";
  if (/luxury|premium|feature wall|designer|high.?end|expensive|royale|statement|exclusive/i.test(text)) return "premium";
  if (/again|last time|previous|repeat|refill|another room/i.test(text)) return "repeat";
  return "retail";
}

// ---- Extract Lead Details ----
function extractLeadDetails(conversationHistory) {
  const allText = conversationHistory.map(m => m.content).join(" ");
  let name = null, phone = null, requirement = null;

  const nameMatch = allText.match(/(?:name is|i'm|my name|call me)\s+([A-Za-z]+)/i);
  if (nameMatch) name = nameMatch[1];

  const phoneMatch = allText.match(/(\+?91\s?)?([6-9]\d{9})\b/);
  if (phoneMatch) phone = phoneMatch[2];

  const reqMatch = allText.match(/(?:paint|room|project|wall|shade|colour|texture|wallpaper|waterproof|roof|leak|leakage|bathroom|kitchen|bedroom|living|home|apartment|house|office|commercial)\s+([^.,;!?\n]{10,60})/i);
  if (reqMatch) requirement = reqMatch[1].trim();

  return { name, phone, requirement };
}

// ---- Save Lead to Google Sheets ----
async function saveLeadToSheets(userId, name, phone, customerType, requirement) {
  if (!sheetsClient || !GOOGLE_SHEET_ID) return;
  try {
    const timestamp = new Date().toISOString();
    const row = [name || "N/A", phone || userId || "N/A", customerType, requirement || "N/A", timestamp];
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Leads!A:E",
      valueInputOption: "USER_ENTERED",
      resource: { values: [row] },
    });
    console.log(`✓ Lead saved: ${name || phone} (${customerType})`);
  } catch (err) {
    console.error("Error saving lead to Sheets:", err.message);
  }
}

// ---- Call Claude API ----
async function askClaude(userId, userMessage) {
  const history = getHistory(userId);
  const messages = [...history, { role: "user", content: userMessage }];

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: messages,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("Anthropic API error:", response.status, errText);
    throw new Error("Anthropic API error " + response.status);
  }

  const data = await response.json();
  const reply = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  return reply || "Sorry, I couldn't generate a reply. Please call +91 63995 46064.";
}

// ---- Send WhatsApp message via Meta Graph API ----
async function sendWhatsAppMessage(toNumber, message) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.error("Cannot send message: Meta WhatsApp not configured");
    return;
  }
  try {
    const url = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toNumber,
        type: "text",
        text: { body: message },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Error sending WhatsApp message:", response.status, errText);
      return;
    }
    console.log(`✓ WhatsApp reply delivered to ${toNumber}`);
  } catch (err) {
    console.error("Error sending WhatsApp message:", err.message);
  }
}

// ---- Process an incoming message ----
async function processMessage(fromNumber, incomingMessage) {
  try {
    const history = getHistory(fromNumber);
    const customerType = detectCustomerType(history, incomingMessage);

    const reply = await askClaude(fromNumber, incomingMessage);

    addToHistory(fromNumber, "user", incomingMessage);
    addToHistory(fromNumber, "assistant", reply);

    const conversationText = history.map(m => m.content).join(" ");
    if (/phone|number|name|requirement|paint|colour|quote|quotation/i.test(conversationText)) {
      const { name, phone, requirement } = extractLeadDetails(history);
      if (phone || name) {
        await saveLeadToSheets(fromNumber, name, phone, customerType, requirement);
      }
    }

    await sendWhatsAppMessage(fromNumber, reply);
    console.log(`✓ Processed message (Type: ${customerType})`);
  } catch (err) {
    console.error("Failed to process message:", err.message);
    await sendWhatsAppMessage(
      fromNumber,
      "Sorry, our assistant is temporarily busy. Please call +91 63995 46064 and our team will help you."
    );
  }
}

// ============================================================
//  WEBHOOK - GET (verification by Meta)
// ============================================================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    console.log("✓ Webhook verified by Meta");
    return res.status(200).send(challenge);
  }
  console.warn("✗ Webhook verification failed (token mismatch)");
  return res.sendStatus(403);
});

// ============================================================
//  WEBHOOK - POST (incoming messages from Meta)
// ============================================================
app.post("/webhook", (req, res) => {
  // Acknowledge to Meta immediately
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body.object) return;

    const entry = (body.entry || [])[0];
    if (!entry) return;
    const change = (entry.changes || [])[0];
    if (!change || !change.value) return;

    const value = change.value;
    const messages = value.messages;
    if (!messages || messages.length === 0) return; // could be a status update

    const msg = messages[0];

    // Avoid processing the same message twice
    if (msg.id) {
      if (processedMessages.has(msg.id)) return;
      processedMessages.add(msg.id);
      if (processedMessages.size > 1000) {
        // keep the set from growing forever
        processedMessages.clear();
      }
    }

    const fromNumber = msg.from; // customer's WhatsApp number
    let incomingText = "";

    if (msg.type === "text" && msg.text) {
      incomingText = (msg.text.body || "").trim();
    } else {
      // Non-text message (image, audio, etc.)
      incomingText = "";
    }

    console.log(`📱 Message from ${fromNumber}: ${incomingText || "[non-text message]"}`);

    if (incomingText) {
      processMessage(fromNumber, incomingText);
    } else {
      sendWhatsAppMessage(
        fromNumber,
        "Namaste! I'm CCS Rang Sahayak. Please send a text message and I'll help you with paints, colours, and more. Or call +91 63995 46064."
      );
    }
  } catch (err) {
    console.error("Webhook processing error:", err.message);
  }
});

// ---- Health Check ----
app.get("/", (req, res) => {
  res.send("Chandra Color Shoppee WhatsApp bot (Meta v3.0) is running.");
});

app.listen(PORT, () => {
  console.log(`\n✓ CCS WhatsApp bot (META) listening on port ${PORT}`);
  console.log(`✓ Model: ${MODEL}`);
  console.log(`✓ WhatsApp: ${WHATSAPP_TOKEN && WHATSAPP_PHONE_NUMBER_ID ? "configured" : "NOT configured"}`);
  console.log(`✓ Webhook verify token: ${WHATSAPP_VERIFY_TOKEN ? "set" : "NOT set"}`);
  console.log(`✓ Google Sheets: ${sheetsClient ? "configured" : "not configured"}\n`);
});
