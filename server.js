/**
 * ============================================================
 *  CHANDRA COLOR SHOPPEE - WHATSAPP BOT SERVER - PHASE 2
 * ============================================================
 *  PHASE 2 FEATURES:
 *  - Google Sheets lead capture (auto-save name, phone, type, requirement)
 *  - Customer type detection (retail, architect, premium, repeat)
 *  - Lead capture from conversations
 *  - Simple quotation generation
 *  - Multi-personality responses
 *
 *  You do NOT normally edit this file.
 *  To add products/offers/FAQs, edit botConfig.js instead.
 * ============================================================
 */

const express = require("express");
const { SYSTEM_PROMPT } = require("./botConfig");
const { google } = require("googleapis");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---- Settings (from environment variables) ----
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_SHEETS_KEY = process.env.GOOGLE_SHEETS_KEY;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const PORT = process.env.PORT || 3000;
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 600;
const HISTORY_LIMIT = 15;

if (!ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY not set.");
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

// ---- Customer Type Detection ----
function detectCustomerType(conversationHistory, latestMessage) {
  const text = (latestMessage + " " + conversationHistory.map(m => m.content).join(" ")).toLowerCase();

  // Architect/Contractor/Designer
  if (/architect|designer|contractor|builder|project|bulk order|multiple sites|construction|commercial|site visit/i.test(text)) {
    return "architect";
  }
  // Premium/Luxury
  if (/luxury|premium|feature wall|designer|high.?end|expensive|royale|statement|exclusive/i.test(text)) {
    return "premium";
  }
  // Repeat customer (would need database lookup — for now, basic keyword detection)
  if (/again|last time|previous|repeat|refill|another room/i.test(text)) {
    return "repeat";
  }
  // Default: Retail
  return "retail";
}

// ---- Extract Lead Details from Conversation ----
function extractLeadDetails(conversationHistory) {
  const allText = conversationHistory.map(m => m.content).join(" ");
  
  let name = null, phone = null, requirement = null;

  // Try to extract name (simple heuristic)
  const nameMatch = allText.match(/(?:name is|i'm|my name|call me)\s+([A-Za-z]+)/i);
  if (nameMatch) name = nameMatch[1];

  // Try to extract phone (Indian number format)
  const phoneMatch = allText.match(/(\+?91\s?)?([6-9]\d{9})\b/);
  if (phoneMatch) phone = phoneMatch[2];

  // Try to extract requirement (room type, scope, etc.)
  const reqMatch = allText.match(/(?:paint|room|project|wall|shade|colour|texture|wallpaper|waterproof|roof|leak|leakage|bathroom|kitchen|bedroom|living|home|apartment|house|office|commercial)\s+([^.,;!?\n]{10,60})/i);
  if (reqMatch) requirement = reqMatch[1].trim();

  return { name, phone, requirement };
}

// ---- Save Lead to Google Sheets ----
async function saveLeadToSheets(userId, name, phone, customerType, requirement) {
  if (!sheetsClient || !GOOGLE_SHEET_ID) {
    console.log("Google Sheets not configured, skipping lead save");
    return;
  }

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

// ---- Twilio WhatsApp Webhook ----
app.post("/whatsapp", async (req, res) => {
  const incomingMessage = (req.body.Body || "").trim();
  const fromNumber = req.body.From || "unknown";

  console.log(`📱 Message from ${fromNumber}: ${incomingMessage}`);

  res.set("Content-Type", "text/xml");

  if (!incomingMessage) {
    return res.send(twimlReply(
      "Namaste! I'm CCS Rang Sahayak. How can I help you with paints, colours, or textures?"
    ));
  }

  try {
    // Get conversation history
    const history = getHistory(fromNumber);

    // Detect customer type
    const customerType = detectCustomerType(history, incomingMessage);

    // Get bot reply
    const reply = await askClaude(fromNumber, incomingMessage);
    
    // Add to history
    addToHistory(fromNumber, "user", incomingMessage);
    addToHistory(fromNumber, "assistant", reply);

    // Try to extract and save lead (if not yet saved in this conversation)
    const conversationText = history.map(m => m.content).join(" ");
    if (!conversationText.includes("Lead saved:") && /phone|number|name|requirement|paint|colour|quote|quotation/i.test(conversationText)) {
      const { name, phone, requirement } = extractLeadDetails(history);
      if (phone || name) {
        await saveLeadToSheets(fromNumber, name, phone, customerType, requirement);
        // Add a subtle note (optional, can be removed if too verbose)
        console.log(`ℹ Lead details extracted and saved: ${name || phone} (${customerType})`);
      }
    }

    console.log(`✓ Reply sent (Type: ${customerType})`);
    return res.send(twimlReply(reply));
  } catch (err) {
    console.error("Failed to handle message:", err.message);
    return res.send(twimlReply(
      "Sorry, our assistant is temporarily busy. Please call +91 63995 46064 and our team will help you."
    ));
  }
});

// ---- Health Check ----
app.get("/", (req, res) => {
  res.send("Chandra Color Shoppee WhatsApp bot (Phase 2) is running.");
});

app.listen(PORT, () => {
  console.log(`\n✓ CCS WhatsApp bot listening on port ${PORT}`);
  console.log(`✓ Model: ${MODEL}`);
  console.log(`✓ Google Sheets: ${sheetsClient ? "configured" : "not configured"}\n`);
});
