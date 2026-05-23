/**
 * ============================================================
 *  CHANDRA COLOR SHOPPEE - WHATSAPP BOT SERVER - PHASE 2.1
 * ============================================================
 *  IMPORTANT FIX: Asynchronous replies
 *  - The webhook now responds to Twilio INSTANTLY
 *  - The bot's reply is sent separately via Twilio's API
 *  - This fixes the "bot not replying" timeout problem on
 *    Render's free tier (slow cold starts)
 *
 *  REQUIRED ENVIRONMENT VARIABLES (set in Render):
 *  - ANTHROPIC_API_KEY      (your Claude API key)
 *  - TWILIO_ACCOUNT_SID     (from Twilio console)
 *  - TWILIO_AUTH_TOKEN      (from Twilio console)
 *  - TWILIO_WHATSAPP_NUMBER (e.g. whatsapp:+14155238886)
 *
 *  OPTIONAL (for Google Sheets lead capture):
 *  - GOOGLE_SHEET_ID
 *  - GOOGLE_SHEETS_KEY
 *
 *  You do NOT normally edit this file.
 *  To add products/offers/FAQs, edit botConfig.js instead.
 * ============================================================
 */

const express = require("express");
const { SYSTEM_PROMPT } = require("./botConfig");
const { google } = require("googleapis");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---- Settings (from environment variables) ----
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const GOOGLE_SHEETS_KEY = process.env.GOOGLE_SHEETS_KEY;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const PORT = process.env.PORT || 3000;
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 600;
const HISTORY_LIMIT = 15;

if (!ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY not set.");
}

// ---- Twilio Client Setup ----
let twilioClient = null;
try {
  if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    console.log("✓ Twilio client initialized (async replies enabled)");
  } else {
    console.warn("⚠ Twilio credentials missing — falling back to TwiML mode");
    console.warn("  Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER");
  }
} catch (err) {
  console.error("Twilio setup error:", err.message);
}

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
    console.warn("⚠ Google Sheets not configured (GOOGLE_SHEETS_KEY or GOOGLE_SHEET_ID missing)");
  }
} catch (err) {
  console.error("Google Sheets setup error:", err.message);
}

// ---- In-memory conversation storage ----
const conversations = new Map();

function getHistory(userId) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  return conversations.get(userId);
}

function addToHistory(userId, role, text) {
  const history = getHistory(userId);
  history.push({ role, content: text });
  while (history.length > HISTORY_LIMIT) history.shift();
}

// ---- Escape XML for TwiML ----
function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twimlReply(message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`;
}

function emptyTwiml() {
  return `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
}

// ---- Customer Type Detection ----
function detectCustomerType(conversationHistory, latestMessage) {
  const text = (latestMessage + " " + conversationHistory.map(m => m.content).join(" ")).toLowerCase();

  if (/architect|designer|contractor|builder|project|bulk order|multiple sites|construction|commercial|site visit/i.test(text)) {
    return "architect";
  }
  if (/luxury|premium|feature wall|designer|high.?end|expensive|royale|statement|exclusive/i.test(text)) {
    return "premium";
  }
  if (/again|last time|previous|repeat|refill|another room/i.test(text)) {
    return "repeat";
  }
  return "retail";
}

// ---- Extract Lead Details from Conversation ----
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

// ---- Send WhatsApp message via Twilio API ----
async function sendWhatsAppMessage(toNumber, message) {
  if (!twilioClient || !TWILIO_WHATSAPP_NUMBER) {
    console.error("Cannot send message: Twilio not configured");
    return;
  }
  try {
    await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: toNumber,
      body: message,
    });
    console.log(`✓ WhatsApp reply delivered to ${toNumber}`);
  } catch (err) {
    console.error("Error sending WhatsApp message:", err.message);
  }
}

// ---- Process a message (runs after webhook is acknowledged) ----
async function processMessage(fromNumber, incomingMessage) {
  try {
    const history = getHistory(fromNumber);
    const customerType = detectCustomerType(history, incomingMessage);

    const reply = await askClaude(fromNumber, incomingMessage);

    addToHistory(fromNumber, "user", incomingMessage);
    addToHistory(fromNumber, "assistant", reply);

    // Save lead if interest detected
    const conversationText = history.map(m => m.content).join(" ");
    if (/phone|number|name|requirement|paint|colour|quote|quotation/i.test(conversationText)) {
      const { name, phone, requirement } = extractLeadDetails(history);
      if (phone || name) {
        await saveLeadToSheets(fromNumber, name, phone, customerType, requirement);
      }
    }

    // Send the reply via Twilio API
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

// ---- Twilio WhatsApp Webhook ----
app.post("/whatsapp", async (req, res) => {
  const incomingMessage = (req.body.Body || "").trim();
  const fromNumber = req.body.From || "unknown";

  console.log(`📱 Message from ${fromNumber}: ${incomingMessage}`);

  // STEP 1: Acknowledge Twilio INSTANTLY (this fixes the timeout problem)
  res.set("Content-Type", "text/xml");

  if (twilioClient && TWILIO_WHATSAPP_NUMBER) {
    // Async mode: send empty response now, deliver reply via API later
    res.send(emptyTwiml());

    // STEP 2: Process the message AFTER responding (no timeout pressure)
    if (incomingMessage) {
      processMessage(fromNumber, incomingMessage);
    }
  } else {
    // Fallback mode (TwiML): only used if Twilio credentials are missing
    if (!incomingMessage) {
      return res.send(twimlReply("Namaste! I'm CCS Rang Sahayak. How can I help you?"));
    }
    try {
      const reply = await askClaude(fromNumber, incomingMessage);
      addToHistory(fromNumber, "user", incomingMessage);
      addToHistory(fromNumber, "assistant", reply);
      return res.send(twimlReply(reply));
    } catch (err) {
      console.error("Failed to handle message:", err.message);
      return res.send(twimlReply(
        "Sorry, our assistant is temporarily busy. Please call +91 63995 46064."
      ));
    }
  }
});

// ---- Health Check ----
app.get("/", (req, res) => {
  res.send("Chandra Color Shoppee WhatsApp bot (Phase 2.1) is running.");
});

app.listen(PORT, () => {
  console.log(`\n✓ CCS WhatsApp bot listening on port ${PORT}`);
  console.log(`✓ Model: ${MODEL}`);
  console.log(`✓ Reply mode: ${twilioClient ? "ASYNC (via Twilio API)" : "TwiML fallback"}`);
  console.log(`✓ Google Sheets: ${sheetsClient ? "configured" : "not configured"}\n`);
});
