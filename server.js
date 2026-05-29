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

  // If this is a WOOD / PU / wood-polish query, do NOT inject wall-paint shades.
  // Wood queries should be answered with WoodTech finishes and the wood PDFs,
  // never the 2200 wall-paint shade database.
  const isWoodQuery = /wood|polish|pu finish|p\.u|furniture|veneer|melamyne|melamine|duco|woodtech|wood tech|emporio|insignia|door finish|wooden/i.test(text);
  if (isWoodQuery) return [];

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
      // SHUFFLE so the bot suggests varied shades each time, not the same first 12
      for (let i = famShades.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [famShades[i], famShades[j]] = [famShades[j], famShades[i]];
      }
      matches.push(...famShades.slice(0, 15));
    }
  }

  // Deduplicate by code
  const seen = new Set();
  matches = matches.filter((s) => {
    if (!s.code || seen.has(s.code)) return false;
    seen.add(s.code);
    return true;
  });

  // FALLBACK: if it's a colour/shade/room query but nothing specific matched
  // (e.g. "suggest colours for my bedroom" with no colour word), inject a FRESH
  // RANDOM sample of real shades so the bot doesn't fall back to the same few
  // made-up names every time.
  const isColourQuery = /colou?r|shade|paint|wall|room|bedroom|living|kitchen|hall|suggest|recommend|idea/i.test(text);
  if (matches.length === 0 && isColourQuery) {
    const pool = shades.slice(); // copy
    // shuffle the whole database
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, 18);
  }

  return matches.slice(0, 20); // cap to keep the prompt small
}
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---- Settings (from environment variables) ----
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // for voice-note transcription (Whisper)
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

// ---- Download an image that a customer sent on WhatsApp ----
// Meta gives us a media ID; we fetch the media URL, then download the bytes.
async function downloadWhatsAppImage(mediaId) {
  try {
    // 1. Get the temporary media URL from Meta
    const metaResp = await fetch(
      `https://graph.facebook.com/v21.0/${mediaId}`,
      { headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}` } }
    );
    if (!metaResp.ok) {
      console.error("Could not get media URL:", metaResp.status);
      return null;
    }
    const metaData = await metaResp.json();
    if (!metaData.url) return null;

    // 2. Download the actual image bytes (also needs the auth header)
    const imgResp = await fetch(metaData.url, {
      headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}` },
    });
    if (!imgResp.ok) {
      console.error("Could not download image:", imgResp.status);
      return null;
    }
    const buffer = Buffer.from(await imgResp.arrayBuffer());
    const base64 = buffer.toString("base64");
    const mediaType = metaData.mime_type || "image/jpeg";
    return { base64, mediaType };
  } catch (err) {
    console.error("Error downloading WhatsApp image:", err.message);
    return null;
  }
}

// ---- Download an audio/voice note that a customer sent on WhatsApp ----
async function downloadWhatsAppAudio(mediaId) {
  try {
    const metaResp = await fetch(
      `https://graph.facebook.com/v21.0/${mediaId}`,
      { headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}` } }
    );
    if (!metaResp.ok) {
      console.error("Could not get audio media URL:", metaResp.status);
      return null;
    }
    const metaData = await metaResp.json();
    if (!metaData.url) return null;

    const audioResp = await fetch(metaData.url, {
      headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}` },
    });
    if (!audioResp.ok) {
      console.error("Could not download audio:", audioResp.status);
      return null;
    }
    const buffer = Buffer.from(await audioResp.arrayBuffer());
    const mimeType = metaData.mime_type || "audio/ogg";
    return { buffer, mimeType };
  } catch (err) {
    console.error("Error downloading WhatsApp audio:", err.message);
    return null;
  }
}

// ---- Transcribe audio to text using OpenAI Whisper ----
async function transcribeAudio(audio) {
  if (!OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY not set — cannot transcribe voice note");
    return null;
  }
  try {
    // WhatsApp voice notes are usually .ogg (opus). Whisper accepts ogg.
    const ext = audio.mimeType.includes("mpeg") ? "mp3"
      : audio.mimeType.includes("mp4") || audio.mimeType.includes("m4a") ? "m4a"
      : audio.mimeType.includes("wav") ? "wav"
      : "ogg";

    const form = new FormData();
    form.append("file", new Blob([audio.buffer], { type: audio.mimeType }), `voice.${ext}`);
    form.append("model", "whisper-1");
    // Let Whisper auto-detect language (handles Hindi/English/Hinglish)

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Whisper transcription failed:", resp.status, errText);
      return null;
    }
    const data = await resp.json();
    return (data.text || "").trim();
  } catch (err) {
    console.error("Error transcribing audio:", err.message);
    return null;
  }
}

// ---- Process an incoming VOICE NOTE / audio message ----
async function processAudioMessage(fromNumber, mediaId) {
  try {
    const audio = await downloadWhatsAppAudio(mediaId);
    if (!audio) {
      await sendWhatsAppMessage(
        fromNumber,
        "I couldn't open that voice note. Please type your question, or call +91 63995 46064."
      );
      return;
    }

    const transcript = await transcribeAudio(audio);
    if (!transcript) {
      await sendWhatsAppMessage(
        fromNumber,
        "🎤 I received your voice note but couldn't understand it clearly. Could you please type your question, or call us at +91 63995 46064?"
      );
      return;
    }

    console.log(`🎤 Voice note from ${fromNumber} transcribed: "${transcript}"`);
    // Feed the transcribed text into the normal message flow
    await processMessage(fromNumber, transcript);
  } catch (err) {
    console.error("Failed to process voice note:", err.message);
    await sendWhatsAppMessage(
      fromNumber,
      "Sorry, I couldn't process that voice note. Please type your question or call +91 63995 46064."
    );
  }
}

// ---- Ask Claude to analyze a customer's photo (waterproofing / wall problem) ----
async function analyzeImageWithClaude(userId, image, customerCaption) {
  const history = getHistory(userId);

  const visionInstruction =
    "A customer of the paint shop has sent this photo. Look at it carefully. " +
    "If it shows a wall/surface problem (damp, seepage, water leakage, peeling " +
    "paint, cracks, fungus/algae, efflorescence/white powder): " +
    "STEP 1 — identify the SURFACE: is it an INTERIOR wall, a TERRACE/ROOF, an " +
    "EXTERIOR wall, a BATHROOM/wet area, or a CRACK/joint? " +
    "STEP 2 — briefly say what the problem looks like and the likely cause. " +
    "STEP 3 — recommend 1-2 SmartCare products ONLY from the matching surface's " +
    "list in your knowledge (interior damp → Hydroloc Xtreme / Damp Sheath " +
    "Interior; terrace → Damp Proof / Damp Proof Ultra; exterior → Damp Proof / " +
    "Damp Sheath Exterior; bathroom → Ultra Block 2K / XtremoSeal; cracks → " +
    "Crack Seal). NEVER recommend a terrace product for an interior wall. " +
    "STEP 4 — do NOT quote any price; advise visiting Chandra Color Shoppee or " +
    "calling +91 63995 46064 for the exact product. " +
    "If the photo is a room they want painted, suggest suitable shades instead. " +
    "If you cannot tell the surface, ask one short question. " +
    "Keep the reply short and WhatsApp-friendly. " +
    (customerCaption ? `The customer also wrote: "${customerCaption}"` : "");

  const messages = [
    ...history,
    {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: image.mediaType,
            data: image.base64,
          },
        },
        { type: "text", text: visionInstruction },
      ],
    },
  ];

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
    console.error("Anthropic vision API error:", response.status, errText);
    throw new Error("Anthropic vision API error " + response.status);
  }

  const data = await response.json();
  return (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

// ---- Process an incoming IMAGE message ----
async function processImageMessage(fromNumber, mediaId, caption) {
  try {
    const image = await downloadWhatsAppImage(mediaId);
    if (!image) {
      await sendWhatsAppMessage(
        fromNumber,
        "I couldn't open that image. Please try sending it again, or call +91 63995 46064 and our team will help you."
      );
      return;
    }

    const reply = await analyzeImageWithClaude(fromNumber, image, caption);

    // Record it in history so the conversation flows naturally afterwards
    addToHistory(fromNumber, "user", caption ? `[sent a photo] ${caption}` : "[sent a photo of a wall]");
    addToHistory(fromNumber, "assistant", reply);

    await sendWhatsAppMessage(fromNumber, reply);
    console.log(`✓ Image analyzed for ${fromNumber}`);
  } catch (err) {
    console.error("Failed to process image:", err.message);
    await sendWhatsAppMessage(
      fromNumber,
      "Sorry, I couldn't analyze that photo right now. Please call +91 63995 46064 — our team can look at it and suggest the right waterproofing solution."
    );
  }
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

// ---- Brochure catalogue ----
// PDFs are downloaded from GitHub by the BOT itself, then uploaded directly to
// Meta. Meta stores the file and returns a media ID. We send that media ID.
// Filenames have spaces, so each is URL-encoded when building the download link.
const GH = "https://raw.githubusercontent.com/swapandeepmittal-coder/ccs-bot/main/";

// Helper: build a brochure entry from the EXACT GitHub filename (spaces allowed)
function brochure(githubFilename, caption) {
  return {
    sourceUrl: GH + encodeURIComponent(githubFilename),
    filename: githubFilename.replace(/\s+/g, "-"), // clean name shown to customer
    caption: caption,
    mediaId: null,
    uploadedAt: 0,
  };
}

const BROCHURES = {
  // ---- BUDGET TEXTURE ----
  budgetTexture1: brochure(
    "BUDGET TEXTURE INTERIOR  Asian Paints Royale PLAY Playlist.pdf",
    "Royale Play Playlist — budget interior textures"),
  budgetTexture2: brochure(
    "BUDGET TEXTURE INTERIOR  PlayList 2 Compact version.pdf",
    "Royale Play Playlist 2 — budget interior textures (compact)"),
  budgetTexture3: brochure(
    "BUDGET TEXTURE INTERIOR AP_RP_NewPattern_PrintShadeCard_LrV1.pdf",
    "Royale Play — texture patterns shade card"),

  // ---- EXTERIOR SHADE CARDS ----
  exterior1: brochure(
    "EXTERIOR SHADE CARD Apex-Ultima-Protek-Shade-Card.pdf",
    "Apex Ultima Protek — exterior shade card"),
  exterior2: brochure(
    "EXTERIOR SHADE CARD ace-apex-shade-card (1).pdf",
    "Ace & Apex — exterior shade card"),
  exterior3: brochure(
    "EXTERIOR SHADE CARD ace-apex-shade-card.pdf",
    "Ace & Apex — exterior shade card"),
  exterior4: brochure(
    "EXTERIOR SHADE CARD apex-ultima-protek-duralife-shade-card.pdf",
    "Apex Ultima Protek Duralife — exterior shade card"),

  // ---- INTERIOR SHADE CARDS ----
  interior1: brochure(
    "INTERIOR SHADE CARD  Royale-Designer-Palette.pdf",
    "Royale Designer Palette — interior shade card"),
  interior2: brochure(
    "INTERIOR SHADE CARD  Royale-Shade-Card-PDF-new.pdf",
    "Royale — interior shade card"),
  interior3: brochure(
    "INTERIOR SHADE CARD  Tractor-emulsion-shadecard.pdf",
    "Tractor Emulsion — interior shade card"),
  interior4: brochure(
    "INTERIOR SHADE CARD Apcolite-Shade-card-Digital.pdf",
    "Apcolite — interior shade card"),

  // ---- LUXURY TEXTURE ----
  luxuryTexture1: brochure(
    "LUXURY TEXTURE Designer-collection.pdf",
    "Royale Play Designer Collection — luxury textures"),
  luxuryTexture2: brochure(
    "LUXURY TEXTURE Final-Lithos-Brochure-HQP-Web.pdf",
    "Royale Play Lithos — luxury stone-inspired finishes"),
  luxuryTexture3: brochure(
    "LUXURY TEXTURE Infinitex_Patterns Book_0816_01_Pragati.pdf",
    "Infinitex Patterns — luxury textures"),
  luxuryTexture4: brochure(
    "LUXURY TEXTURE luxindica-shade-booklet.pdf",
    "Luxindica — luxury shade booklet"),

  // ---- WOOD FINISHES ----
  woodInsignia: brochure(
    "Insignia-Booklet_30.10.pdf",
    "Asian Paints Insignia — wood finishes"),
  woodEmporio: brochure(
    "WF-emporio-magazine.pdf",
    "Asian Paints Emporio — wood coatings & finishes"),

  // ---- FLOOR COATING ----
  floorGuard: brochure(
    "apexfloorguard-shadecard.pdf",
    "Apex Floor Guard — floor coating shade card"),
};


// Meta media IDs are valid for ~30 days; we refresh after 20 days to be safe.
const MEDIA_TTL_MS = 20 * 24 * 60 * 60 * 1000;

// ---- Upload one PDF to Meta, return its media ID ----
async function uploadPdfToMeta(brochure) {
  // Re-use a recent media ID if we already have one
  if (brochure.mediaId && Date.now() - brochure.uploadedAt < MEDIA_TTL_MS) {
    return brochure.mediaId;
  }
  try {
    // 1. Bot downloads the PDF from GitHub (bot fetching its own files is reliable)
    const pdfResp = await fetch(brochure.sourceUrl);
    if (!pdfResp.ok) {
      console.error(`✗ Could not download ${brochure.filename}: ${pdfResp.status}`);
      return null;
    }
    const pdfBuffer = Buffer.from(await pdfResp.arrayBuffer());

    // 2. Upload the file to Meta's media endpoint
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append(
      "file",
      new Blob([pdfBuffer], { type: "application/pdf" }),
      brochure.filename
    );

    const uploadUrl = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/media`;
    const uploadResp = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}` },
      body: form,
    });

    if (!uploadResp.ok) {
      const errText = await uploadResp.text();
      console.error(`✗ Meta upload failed for ${brochure.filename}:`, uploadResp.status, errText);
      return null;
    }
    const data = await uploadResp.json();
    brochure.mediaId = data.id;
    brochure.uploadedAt = Date.now();
    console.log(`✓ Uploaded to Meta: ${brochure.filename} (media id ${data.id})`);
    return data.id;
  } catch (err) {
    console.error(`✗ Error uploading ${brochure.filename}:`, err.message);
    return null;
  }
}

// ---- Send a PDF document via Meta (using an uploaded media ID) ----
async function sendWhatsAppDocument(toNumber, brochure) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) return false;
  try {
    // Make sure the PDF is uploaded to Meta and we have a fresh media ID
    const mediaId = await uploadPdfToMeta(brochure);
    if (!mediaId) {
      console.error(`✗ No media ID for ${brochure.filename} — cannot send`);
      return false;
    }

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
          id: mediaId,
          filename: brochure.filename,
          caption: brochure.caption || "",
        },
      }),
    });
    if (!response.ok) {
      const errText = await response.text();
      console.error("✗ Error sending WhatsApp document:", response.status, errText);
      // If the media ID went stale, clear it so the next try re-uploads
      brochure.mediaId = null;
      return false;
    }
    console.log(`✓ PDF sent to ${toNumber}: ${brochure.filename}`);
    return true;
  } catch (err) {
    console.error("✗ Error sending WhatsApp document:", err.message);
    return false;
  }
}

// ============================================================
//  INSPIRATION-IMAGE VISUALIZER (honest — fresh image, not the
//  customer's room; tied to a real shade/texture from our knowledge)
// ============================================================

// Cost guard: limit how many images one customer can generate per day
const imageQuota = new Map(); // phone -> { count, day }
const MAX_IMAGES_PER_CUSTOMER_PER_DAY = 3;

function canGenerateImage(phone) {
  const today = new Date().toISOString().slice(0, 10);
  const rec = imageQuota.get(phone);
  if (!rec || rec.day !== today) {
    imageQuota.set(phone, { count: 1, day: today });
    return true;
  }
  if (rec.count >= MAX_IMAGES_PER_CUSTOMER_PER_DAY) return false;
  rec.count += 1;
  return true;
}

// Detect a request to SEE/VISUALIZE a colour or texture
function detectVisualizerRequest(message) {
  const text = (message || "").toLowerCase();
  return /visuali[sz]e|see (it|the|my|how)|how (will|would) (it|my).*look|show me (a|how|the look)|preview|imagine|kaisa lagega|dikha|design (idea|preview)|inspiration|mockup|render/i.test(text);
}

// Pick a real shade from the database that matches a colour word in the message
function pickShadeForVisual(message) {
  const found = findRelevantShades(message);
  if (found && found.length) return found[Math.floor(Math.random() * found.length)];
  if (shades.length) return shades[Math.floor(Math.random() * shades.length)];
  return null;
}

// Generate an image via OpenAI, return base64 PNG (or null)
async function generateInspirationImage(promptText) {
  if (!OPENAI_API_KEY) return null;
  try {
    const resp = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: promptText,
        n: 1,
        size: "1024x1024",
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error("OpenAI image generation failed:", resp.status, errText);
      return null;
    }
    const data = await resp.json();
    // gpt-image-1 returns base64 in data[0].b64_json
    const b64 = data?.data?.[0]?.b64_json;
    return b64 || null;
  } catch (err) {
    console.error("Error generating image:", err.message);
    return null;
  }
}

// Upload an image (base64) to Meta and send it to the customer with a caption
async function sendWhatsAppImage(toNumber, base64Png, caption) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) return false;
  try {
    // 1. Upload the image to Meta to get a media ID
    const buffer = Buffer.from(base64Png, "base64");
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", new Blob([buffer], { type: "image/png" }), "inspiration.png");

    const uploadResp = await fetch(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/media`,
      { method: "POST", headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}` }, body: form }
    );
    if (!uploadResp.ok) {
      console.error("Meta image upload failed:", await uploadResp.text());
      return false;
    }
    const { id: mediaId } = await uploadResp.json();

    // 2. Send the image message
    const sendResp = await fetch(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: toNumber,
          type: "image",
          image: { id: mediaId, caption: caption || "" },
        }),
      }
    );
    if (!sendResp.ok) {
      console.error("Meta image send failed:", await sendResp.text());
      return false;
    }
    console.log(`✓ Inspiration image sent to ${toNumber}`);
    return true;
  } catch (err) {
    console.error("Error sending WhatsApp image:", err.message);
    return false;
  }
}

// Full flow: customer wants to visualize → pick shade → generate → send (honestly labelled)
async function processVisualizerRequest(fromNumber, message) {
  // Cost guard
  if (!canGenerateImage(fromNumber)) {
    await sendWhatsAppMessage(
      fromNumber,
      "You've reached today's preview limit 🎨 Please visit Chandra Color Shoppee to see more options on real shade cards, or call +91 63995 46064."
    );
    return;
  }

  // Tell the customer it's being prepared (image takes ~20s)
  await sendWhatsAppMessage(
    fromNumber,
    "🎨 Creating an inspiration image for you... this takes a few seconds. Please wait."
  );

  // EXACT CODE: if the customer typed a specific shade code, use THAT shade.
  // Otherwise pick a relevant shade from the database.
  const text = message.toLowerCase();
  const codeMatch = text.match(/\b\d{3,4}\b/);
  let shade = null;
  if (codeMatch && shades.length) {
    shade = shades.find((s) => s.code === codeMatch[0]) || null;
  }
  if (!shade) shade = pickShadeForVisual(message);
  const shadeName = shade ? `${shade.name} (${shade.code})` : "a warm neutral shade";

  // Detect if they mentioned a texture
  let textureNote = "";
  if (/texture|royale play|lithos|stucco|concrete|marmorino/i.test(text)) {
    textureNote = " with a subtle Royale Play textured finish on one feature wall";
  }

  // Detect room type
  const room = /bedroom/i.test(text) ? "bedroom"
    : /living|hall|drawing/i.test(text) ? "living room"
    : /kitchen/i.test(text) ? "kitchen"
    : /office/i.test(text) ? "office"
    : "living room";

  // Bright, natural, light-toned image (not dark)
  const prompt =
    `A bright, airy, naturally-lit interior design photo of a modern Indian ${room}. ` +
    `Walls painted in a colour similar to "${shade ? shade.name : "warm neutral"}"` +
    `${textureNote}. Tasteful contemporary furniture, plenty of soft natural daylight ` +
    `through windows, light and welcoming atmosphere, clean and uncluttered. ` +
    `Magazine-style interior photography, photorealistic, high quality, no text, ` +
    `no watermark.`;

  const b64 = await generateInspirationImage(prompt);

  if (!b64) {
    await sendWhatsAppMessage(
      fromNumber,
      `I couldn't create the image right now, but I'd suggest *${shadeName}* for your ${room} 🎨 ` +
      `Visit Chandra Color Shoppee to see it on a real shade card, or call +91 63995 46064.`
    );
    return;
  }

  const caption =
    `🎨 Inspiration image — ${room} in *${shadeName}*${textureNote ? " + Royale Play texture" : ""}.\n\n` +
    `⚠️ This is an approximate AI inspiration image, NOT your actual room. The real ` +
    `shade may look different in your light. Please visit us to see the real shade ` +
    `card before deciding.\n📍 Chandra Color Shoppee · 📞 +91 63995 46064`;

  const sent = await sendWhatsAppImage(fromNumber, b64, caption);
  if (!sent) {
    await sendWhatsAppMessage(
      fromNumber,
      `I'd suggest *${shadeName}* for your ${room} 🎨 Visit us to see it on a real shade card, or call +91 63995 46064.`
    );
  }

  addToHistory(fromNumber, "user", `[asked to visualize] ${message}`);
  addToHistory(fromNumber, "assistant", `Sent an inspiration image in ${shadeName} for a ${room}.`);
}


// Decide which brochure(s) the customer is asking for. Returns array of keys.
// Specific product names route to the specific matching PDF.
function detectBrochureRequest(message) {
  const text = (message || "").toLowerCase();

  // ---- SPECIFIC PRODUCT NAMES → SPECIFIC PDFs (checked first, most precise) ----
  // Wood-specific products
  if (/emporio/i.test(text)) return ["woodEmporio"];
  if (/insignia/i.test(text)) return ["woodInsignia"];
  if (/wood|polish|furniture|veneer|melamyne|pu finish|wood coat|woodtech/i.test(text)) {
    return ["woodEmporio", "woodInsignia"];
  }

  // Specific interior products
  if (/tractor/i.test(text)) return ["interior3"]; // Tractor shade card
  if (/apcolite/i.test(text)) return ["interior4"]; // Apcolite shade card
  if (/royale designer|sabyasachi/i.test(text)) return ["interior1"]; // Designer Palette
  if (/royale/i.test(text)) return ["interior2", "interior1"]; // main Royale + Designer

  // Specific exterior products
  if (/ace/i.test(text)) return ["exterior2"]; // Ace shade card
  if (/duralife|protek duralife/i.test(text)) return ["exterior4"]; // Duralife
  if (/ultima|apex ultima/i.test(text)) return ["exterior1"]; // Apex Ultima Protek
  if (/apex/i.test(text)) return ["exterior1", "exterior4"]; // Apex variants

  // Specific texture products
  if (/lithos/i.test(text)) return ["luxuryTexture2"];
  if (/infinitex/i.test(text)) return ["luxuryTexture3"];
  if (/luxindica/i.test(text)) return ["luxuryTexture4"];
  if (/designer collection|royale play designer/i.test(text)) return ["luxuryTexture1"];
  if (/playlist/i.test(text)) return ["budgetTexture1"];

  // Floor
  if (/floor coat|floor guard|floor paint|floor shade/i.test(text)) return ["floorGuard"];

  // ---- GENERIC CATEGORY QUERIES → 2 PDFs MAX ----
  const wanted = [];

  const mentionsExterior = /exterior|outside|outer wall|weatherproof/i.test(text);
  const mentionsInterior = /interior shade|inside shade|interior colour|interior color|interior paint/i.test(text);
  const mentionsLuxuryTexture = /luxury texture|premium texture/i.test(text);
  const mentionsBudgetTexture = /budget texture|cheap texture|affordable texture/i.test(text);
  const mentionsTexture = /texture|royale play|feature wall|designer wall|stucco|marmorino|stellato|archi concrete|calcecruda/i.test(text);
  const mentionsShadeCard = /shade card|shadecard|colour card|color card/i.test(text);

  if (mentionsExterior) wanted.push("exterior1", "exterior4");
  if (mentionsInterior || (mentionsShadeCard && !mentionsExterior)) wanted.push("interior2", "interior1");
  if (mentionsLuxuryTexture) wanted.push("luxuryTexture1", "luxuryTexture2");
  if (mentionsBudgetTexture) wanted.push("budgetTexture1", "budgetTexture3");
  if (mentionsTexture && !mentionsLuxuryTexture && !mentionsBudgetTexture) {
    wanted.push("luxuryTexture1", "budgetTexture1");
  }

  return [...new Set(wanted)];
}


async function processMessage(fromNumber, incomingMessage) {
  try {
    // ---- VISUALIZER: if the customer wants to SEE a colour/texture, generate
    // an inspiration image instead of the normal text flow ----
    if (OPENAI_API_KEY && detectVisualizerRequest(incomingMessage)) {
      console.log(`🖼️  Visualizer request from ${fromNumber}: ${incomingMessage}`);
      await processVisualizerRequest(fromNumber, incomingMessage);
      return;
    }

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
      if (b) {
        await sendWhatsAppDocument(fromNumber, b);
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

    // ---- IMAGE message: analyze the photo (waterproofing / wall diagnosis) ----
    if (msg.type === "image" && msg.image && msg.image.id) {
      const caption = (msg.image.caption || "").trim();
      console.log(`📷 Image from ${fromNumber}${caption ? ": " + caption : ""}`);
      processImageMessage(fromNumber, msg.image.id, caption);
      return;
    }

    // ---- VOICE NOTE / audio message: transcribe then process as text ----
    if (msg.type === "audio" && msg.audio && msg.audio.id) {
      console.log(`🎤 Voice note from ${fromNumber}`);
      processAudioMessage(fromNumber, msg.audio.id);
      return;
    }

    let incomingText = "";

    if (msg.type === "text" && msg.text) {
      incomingText = (msg.text.body || "").trim();
    } else {
      // Other non-text message (audio, video, document, etc.)
      incomingText = "";
    }

    console.log(`📱 Message from ${fromNumber}: ${incomingText || "[non-text message]"}`);

    if (incomingText) {
      processMessage(fromNumber, incomingText);
    } else {
      sendWhatsAppMessage(
        fromNumber,
        "Namaste! I'm CCS Rang Sahayak 🎨 You can send me a text message about paints and colours — or send a *photo of a damp/leaking wall* and I'll suggest the right waterproofing solution. Or call +91 63995 46064."
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
  console.log(`✓ Google Sheets: ${sheetsClient ? "configured" : "not configured"}`);
  console.log(`✓ Voice notes (Whisper): ${OPENAI_API_KEY ? "configured" : "NOT configured — voice notes will ask customer to type"}\n`);

  // Pre-upload all brochure PDFs to Meta in the background so the first
  // customer who asks gets them instantly. Failures here are non-fatal —
  // sendWhatsAppDocument will retry the upload on demand.
  if (WHATSAPP_TOKEN && WHATSAPP_PHONE_NUMBER_ID) {
    console.log("⏳ Pre-uploading brochure PDFs to Meta...");
    (async () => {
      for (const key of Object.keys(BROCHURES)) {
        await uploadPdfToMeta(BROCHURES[key]);
      }
      console.log("✓ Brochure PDF pre-upload finished\n");
    })();
  }
});
