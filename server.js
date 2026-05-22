/**
 * ============================================================
 *  CHANDRA COLOR SHOPPEE - WHATSAPP BOT SERVER
 * ============================================================
 *  You normally do NOT need to edit this file.
 *  To change what the bot says, edit botConfig.js instead.
 *
 *  This server:
 *    1. Receives WhatsApp messages from Twilio
 *    2. Sends them to Claude (Anthropic API) with the shop's
 *       system prompt + knowledge base
 *    3. Replies to the customer on WhatsApp
 *    4. Remembers the recent conversation per customer
 * ============================================================
 */

const express = require("express");
const { SYSTEM_PROMPT } = require("./botConfig");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---- Settings (read from environment variables) ----
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;
const MODEL = "claude-haiku-4-5-20251001"; // fast + low cost, good for a shop bot
const MAX_TOKENS = 500;                    // keeps replies short and cheap
const HISTORY_LIMIT = 10;                  // remember last 10 messages per customer

if (!ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY is not set. Add it in your host's environment variables.");
}

// ---- Simple in-memory conversation memory ----
// Note: this resets if the server restarts. That is fine for a shop bot.
const conversations = new Map();

function getHistory(userId) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  return conversations.get(userId);
}

function addToHistory(userId, role, text) {
  const history = getHistory(userId);
  history.push({ role, content: text });
  // keep only the most recent messages
  while (history.length > HISTORY_LIMIT) history.shift();
}

// ---- Escape text for safe TwiML XML reply ----
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

// ---- Call the Claude API ----
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

  return reply || "Sorry, I couldn't generate a reply just now. Please call us at +91 63995 46064.";
}

// ---- Twilio WhatsApp webhook ----
app.post("/whatsapp", async (req, res) => {
  const incomingMessage = (req.body.Body || "").trim();
  const fromNumber = req.body.From || "unknown";

  console.log(`Message from ${fromNumber}: ${incomingMessage}`);

  res.set("Content-Type", "text/xml");

  if (!incomingMessage) {
    return res.send(twimlReply(
      "Namaste! Welcome to Chandra Color Shoppee. Please type your question about paints, colours, or our shop."
    ));
  }

  try {
    const reply = await askClaude(fromNumber, incomingMessage);
    addToHistory(fromNumber, "user", incomingMessage);
    addToHistory(fromNumber, "assistant", reply);
    return res.send(twimlReply(reply));
  } catch (err) {
    console.error("Failed to handle message:", err.message);
    return res.send(twimlReply(
      "Sorry, our assistant is busy right now. Please call or WhatsApp us at +91 63995 46064 and our team will help you."
    ));
  }
});

// ---- Health check (open this URL in a browser to test the server is up) ----
app.get("/", (req, res) => {
  res.send("Chandra Color Shoppee WhatsApp bot is running.");
});

app.listen(PORT, () => {
  console.log(`CCS WhatsApp bot listening on port ${PORT}`);
});
