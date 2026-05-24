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
const fs = require("fs");
const { SYSTEM_PROMPT } = require("./botConfig");
const { google } = require("googleapis");

const app = express();

// ============================================================
//  ASIAN PAINTS SHADE DATABASE (2199 shades)
// ============================================================
let shades = [];
try {
  const csv = fs.readFileSync("./asian_paints_shades.csv", "utf8");
  const lines = csv.split("\n").slice(1); // skip header row
  shades = lines
    .filter((l) => l.trim())
    .map((line) => {
      const [name, code, hex, family, temperature, tonality] = line.split(",");
      return {
        name: (name || "").trim(),
        code: (code || "").trim(),
        hex: (hex || "").trim(),
        family: (family || "").trim(),
        temperature: (temperature || "").trim(),
        tonality: (tonality || "").trim(),
      };
    });
  console.log(`✓ Loaded ${shades.length} Asian Paints shades`);
} catch (err) {
  console.warn("⚠ Could not load shades CSV:", err.message);
}

// Find shades relevant to a customer's message (keeps prompt small & fast)
function findRelevantShades(message) {
  if (!shades.length) return [];
  const text = (message || "").toLowerCase();
  let matches = [];

  // 1. Match by shade code (e.g. "9436")
  const codeMatch = text.match(/\b\d{3,4}\b/g);
  if (codeMatch) {
    for (const code of codeMatch) {
      matches.push(...shades.filter((s) => s.code === code));
    }
  }

  // 2. Match by exact shade name appearing in the message
  for (const s of shades) {
    if (s.name && s.name.length > 3 && text.includes(s.name)) {
      matches.push(s);
    }
  }

  // 3. Match by colour family + optional tonality/temperature
  const familyMap = {
    green: "greens", greens: "greens",
    brown: "browns", browns: "browns",
    purple: "purples", purples: "purples", violet: "purples",
    pink: "pinks", pinks: "pinks",
    grey: "greys", greys: "greys", gray: "greys", grays: "greys",
    blue: "blues", blues: "blues",
    orange: "oranges", oranges: "oranges",
    yellow: "yellows", yellows: "yellows",
    "off white": "off whites", "off whites": "off whites",
    white: "whites", whites: "whites",
    red: "reds", reds: "reds",
  };
  for (const [word, family] of Object.entries(familyMap)) {
    if (text.includes(word)) {
      let famShades = shades.filter((s) => s.family === family);
      // refine by tonality if mentioned
      if (text.includes("light")) famShades = famShades.filter((s) => s.tonality === "light");
      else if (text.includes("dark") || text.includes("deep")) famShades = famShades.filter((s) => s.tonality === "dark");
      else if (text.includes("medium")) famShades = famShades.filter((s) => s.tonality === "medium");
      // refine by temperature if mentioned
      if (text.includes("warm")) famShades = famShades.filter((s) => s.temperature === "warm");
      else if (text.includes("cool")) famShades = famShades.filter((s) => s.temperature === "cool");
      matches.push(...famShades.slice(0, 12));
    }
  }

  // Deduplicate by code
  const seen = new Set();
  matches = matches.filter((s) => {
    if (!s.code || seen.has(s.code)) return false;
    seen.add(s.code);
    return true;
  });

  return matches.slice(0, 15); // cap to keep the prompt small
}
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

// ---- Track which numbers we've already saved as leads (once per conversation) ----
const savedLeads = new Set();

// ---- Detect the actual PRODUCT requirement from the conversation ----
function detectRequirement(conversationHistory) {
  const userMsgs = conversationHistory
    .filter((m) => m.role === "user")
    .map((m) => m.content);
  const text = userMsgs.join(" ").toLowerCase();

  // Menu number mapping (customer picked from the service menu)
  const menuMap = {
    "1": "Wall paint & colour selection",
    "2": "Colour / shade suggestions",
    "3": "Waterproofing (leakage / damp)",
    "4": "Wall textures",
    "5": "Wallpapers",
    "6": "Wood polish & coatings",
    "7": "Full house painting service",
    "8": "Price / quotation enquiry",
    "9": "Shop visit / location enquiry",
  };
  // Check if any user message is just a single menu digit
  const menuPicks = [];
  for (const msg of userMsgs) {
    const trimmed = msg.trim();
    if (/^[1-9]$/.test(trimmed) && menuMap[trimmed]) {
      menuPicks.push(menuMap[trimmed]);
    }
  }

  // Typo-tolerant "paint" matcher
  const paintWord = /p[ia]{1,3}n+t/i;

  const interests = [];
  if (/waterproof|water proof|leak|leakage|damp|seepage/i.test(text)) interests.push("Waterproofing");
  if (/wallpaper|wall paper|nilaya/i.test(text)) interests.push("Wallpaper");
  if (/texture|royale play|stucco/i.test(text)) interests.push("Wall textures");
  if (/wood|polish|furniture|sirca|ica|duco|coating/i.test(text)) interests.push("Wood coatings");
  if (/full house|whole house|entire home|complete home|house\s*p[ia]{1,3}n+t|home\s*p[ia]{1,3}n+t|p[ia]{1,3}n+t.*service|beautiful home|p[ia]{1,3}n+ter/i.test(text)) interests.push("Full house painting service");
  if (/exterior|outside wall|outer wall|apex/i.test(text)) interests.push("Exterior painting");
  if (/interior|inside|room p[ia]{1,3}n+t|wall p[ia]{1,3}n+t/i.test(text)) interests.push("Interior painting");
  if (/colour|color|shade/i.test(text)) interests.push("Colour consultation");
  if (/quotation|quote|estimate|price|cost|rate|budget/i.test(text)) interests.push("Price/quotation enquiry");
  if (/bulk|contractor|architec|project|commercial|multiple/i.test(text)) interests.push("Bulk/project/architect enquiry");

  const rooms = [];
  if (/bedroom/i.test(text)) rooms.push("bedroom");
  if (/living room|hall|drawing room/i.test(text)) rooms.push("living room");
  if (/kitchen/i.test(text)) rooms.push("kitchen");
  if (/bathroom|toilet/i.test(text)) rooms.push("bathroom");
  if (/kids|children|nursery/i.test(text)) rooms.push("kids room");
  if (/office/i.test(text)) rooms.push("office");

  // Combine menu picks + detected interests
  const allInterests = [...new Set([...menuPicks, ...interests])];

  let requirement = "";
  if (allInterests.length > 0) {
    requirement = allInterests.join(", ");
    if (rooms.length > 0) requirement += " (" + rooms.join(", ") + ")";
  } else if (rooms.length > 0) {
    requirement = "Painting — " + rooms.join(", ");
  } else if (paintWord.test(text) || /\bhouse\b|\bhome\b|\bwall\b/i.test(text)) {
    requirement = "General paint enquiry";
  } else {
    requirement = "General enquiry — follow up needed";
  }
  return requirement;
}

// ---- Extract a name ONLY if the customer clearly stated it ----
function extractName(conversationHistory) {
  for (const m of conversationHistory) {
    if (m.role !== "user") continue;
    // Only accept a clearly-introduced name, e.g. "my name is Raj", "I am Priya"
    const match = m.content.match(/(?:my name is|name is|i am|i'm|this is|myself)\s+([A-Z][a-z]{1,19})/i);
    if (match) {
      const candidate = match[1].trim();
      // Reject common false positives
      const blacklist = ["interested", "looking", "thinking", "from", "here", "trying", "planning", "painting"];
      if (!blacklist.includes(candidate.toLowerCase())) {
        return candidate;
      }
    }
  }
  return "Not provided";
}

// ---- Format the customer's WhatsApp number nicely ----
function formatPhone(waNumber) {
  // Meta sends numbers like "917060046064" — keep digits only
  const digits = String(waNumber).replace(/\D/g, "");
  return digits || "Unknown";
}

// ---- Save Lead to Google Sheets ----
async function saveLeadToSheets(phone, name, customerType, requirement) {
  if (!sheetsClient || !GOOGLE_SHEET_ID) return;
  try {
    const timestamp = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    const row = [
      name || "Not provided",
      phone || "Unknown",
      customerType || "retail",
      requirement || "General enquiry",
      timestamp,
    ];
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Leads!A:E",
      valueInputOption: "USER_ENTERED",
      resource: { values: [row] },
    });
    console.log(`✓ Lead saved: ${phone} | name: ${name} (${customerType})`);
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

// ---- Send a PDF document via Meta WhatsApp API ----
async function sendWhatsAppDocument(toNumber, pdfUrl, filename, caption) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) return;
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
        type: "document",
        document: {
          link: pdfUrl,
          filename: filename,
          caption: caption || "",
        },
      }),
    });
    if (!response.ok) {
      const errText = await response.text();
      console.error("Error sending WhatsApp document:", response.status, errText);
      return false;
    }
    console.log(`✓ PDF sent to ${toNumber}: ${filename}`);
    return true;
  } catch (err) {
    console.error("Error sending WhatsApp document:", err.message);
    return false;
  }
}

// ---- Brochure catalogue (PDFs hosted on GitHub) ----
const GH = "https://raw.githubusercontent.com/swapandeepmittal-coder/ccs-bot/main/";
const BROCHURES = {
  woodEmporio: {
    url: GH + "WF-emporio-magazine.pdf",
    filename: "Asian-Paints-Emporio-Wood-Finishes.pdf",
    caption: "Asian Paints Emporio — Wood Coatings & Finishes 🪵",
  },
  woodInsignia: {
    url: GH + "Insignia-Booklet_30.10.pdf",
    filename: "Asian-Paints-Insignia-Wood-Finishes.pdf",
    caption: "Asian Paints Insignia — Wood Finishes Collection 🪵",
  },
  designer: {
    url: GH + "Designer-collection.pdf",
    filename: "Royale-Play-Designer-Collection.pdf",
    caption: "Royale Play Designer Collection — wall textures & finishes 🎨",
  },
  patterns: {
    url: GH + "AP_RP_NewPattern_PrintShadeCard_LrV1.pdf",
    filename: "Royale-Play-Texture-Patterns.pdf",
    caption: "Royale Play — texture patterns shade card 🎨",
  },
  lithos: {
    url: GH + "Final-Lithos-Brochure-HQP-Web.pdf",
    filename: "Royale-Play-Lithos-Stone-Finishes.pdf",
    caption: "Royale Play Lithos — natural stone-inspired finishes 🪨",
  },
};

// Decide which brochure(s) the customer is asking for. Returns array of keys.
function detectBrochureRequest(message) {
  const text = (message || "").toLowerCase();

  const wantsCatalogue = /catalog|catalogue|brochure|book|booklet|pdf|samples?|designs?|show me|send|magazine|shade card/i.test(text);
  const mentionsWood = /wood|polish|furniture|emporio|insignia|veneer|melamyne|pu finish/i.test(text);
  const mentionsTexture = /texture|royale play|archi concrete|calcecruda|designer collection|pattern|feature wall|stucco|marmorino|stellato/i.test(text);
  const mentionsLithos = /lithos|stone finish/i.test(text);

  const wanted = [];

  // Wood takes priority — if they mention wood, send only wood brochures
  if (mentionsWood) {
    wanted.push("woodEmporio", "woodInsignia");
    return wanted; // wood query — don't mix in texture PDFs
  }

  if (mentionsLithos) {
    wanted.push("lithos");
  }
  if (mentionsTexture) {
    wanted.push("designer", "patterns");
  }

  return [...new Set(wanted)];
}


async function processMessage(fromNumber, incomingMessage) {
  try {
    const history = getHistory(fromNumber);
    const customerType = detectCustomerType(history, incomingMessage);

    // Look up relevant Asian Paints shades and add them as context
    const relevantShades = findRelevantShades(incomingMessage);
    let messageForClaude = incomingMessage;
    if (relevantShades.length > 0) {
      const shadeList = relevantShades
        .map((s) => `${s.name} (code ${s.code}, hex ${s.hex}, ${s.family}, ${s.temperature} tone, ${s.tonality})`)
        .join("; ");
      messageForClaude =
        incomingMessage +
        `\n\n=== ASIAN PAINTS SHADE DATABASE RESULTS ===\n` +
        `The shop's official shade database returned these REAL Asian Paints shades for this query. ` +
        `You MUST use these actual shade names and codes in your reply (do not invent other shades). ` +
        `Recommend 3-5 of them that best fit what the customer asked, mention the shade name and code, ` +
        `and briefly say why each suits their room:\n${shadeList}\n` +
        `=== END SHADE DATABASE RESULTS ===`;
      console.log(`  ↳ ${relevantShades.length} shades matched for this query`);
    }

    const reply = await askClaude(fromNumber, messageForClaude);

    // Store the ORIGINAL message in history (not the augmented one)
    addToHistory(fromNumber, "user", incomingMessage);
    addToHistory(fromNumber, "assistant", reply);

    // ---- Save lead (Option B: real WhatsApp number, product-based requirement) ----
    const phone = formatPhone(fromNumber);
    if (!savedLeads.has(phone)) {
      // Look at the FULL conversation so far to detect what they actually want
      const requirement = detectRequirement(history);
      const name = extractName(history);
      const userMsgCount = history.filter((m) => m.role === "user").length;

      // Save once we know the actual product interest,
      // OR after 3 messages so we never lose a lead
      const haveRealRequirement =
        requirement !== "General enquiry — follow up needed";

      if (haveRealRequirement || userMsgCount >= 3) {
        await saveLeadToSheets(phone, name, customerType, requirement);
        savedLeads.add(phone); // don't save this number again this run
      }
    }

    await sendWhatsAppMessage(fromNumber, reply);

    // ---- Send brochure PDF(s) if the customer asked about textures/wood/catalogues ----
    const brochureKeys = detectBrochureRequest(incomingMessage);
    for (const key of brochureKeys) {
      const b = BROCHURES[key];
      if (b && b.url) {
        await sendWhatsAppDocument(fromNumber, b.url, b.filename, b.caption);
      }
    }

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
