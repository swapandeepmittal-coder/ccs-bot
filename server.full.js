/**
 * ============================================================
 *  CHANDRA COLOR SHOPPEE — BOT ENGINE (with Shade Wall Visualiser)
 * ============================================================
 *  Meta WhatsApp Cloud API + Anthropic Claude, on Render/Express.
 *
 *  This is a COMPLETE, runnable engine. It reuses your botConfig.js
 *  (SYSTEM_PROMPT), the 2200-shade CSV (shades.js), the Cloud API client
 *  (whatsapp.js), and the visualiser tool (visualizerTool.js / renderer.js).
 *
 *  IMPORTANT: this rebuild does NOT include Google Sheets lead capture
 *  (that code was not visible). Re-add it where marked "LEAD CAPTURE HOOK"
 *  if your current bot saves leads to a sheet.
 *
 *  Env vars (set in Render):
 *    ANTHROPIC_API_KEY        - Claude key (you already have this)
 *    CLAUDE_MODEL             - e.g. claude-3-5-sonnet-latest (optional)
 *    WHATSAPP_TOKEN           - Cloud API token
 *    WHATSAPP_PHONE_NUMBER_ID - Cloud API phone number id
 *    WHATSAPP_VERIFY_TOKEN    - any string; same value in Meta webhook setup
 *    GEMINI_API_KEY           - for the wall render (Google AI Studio)
 *    IMAGE_PROVIDER           - gemini (default) | stub (free test)
 * ============================================================
 */

const express = require('express');
const { SYSTEM_PROMPT } = require('./botConfig');
const shades = require('./shades');
const wa = require('./whatsapp');
const { TOOL_SPEC, handleToolUse } = require('./visualizerTool');

const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 3000;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-latest';
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'ccs-verify';

// One extra line appended to your prompt so Claude knows the tool exists.
const TOOL_HINT =
  '\n\n## WALL VISUALISER TOOL\nIf the customer has sent a photo of their room/' +
  'wall in this chat AND names or implies an Asian Paints shade to see on it, ' +
  'call the render_wall_in_shade tool with that shade code or name. The image is ' +
  'sent to the customer automatically — after the tool runs, reply with ONE short, ' +
  'friendly line (do not describe the image), and invite them to try another shade ' +
  'or visit the shop. If no photo has been sent yet, ask them to send one first.';
const SYSTEM = SYSTEM_PROMPT + TOOL_HINT;

// ---- per-user state (in-memory; fine for a single Render instance) ----
const sessions = {}; // from -> { history, lastImageMediaId, ts }
const TTL_MS = 60 * 60 * 1000;
function getSession(from) {
  const s = sessions[from];
  if (s && Date.now() - s.ts < TTL_MS) return s;
  const fresh = { history: [], lastImageMediaId: null, ts: Date.now() };
  sessions[from] = fresh;
  return fresh;
}

// ---- attach shade DB results (honours the prompt's contract) ----
function attachShadeResults(text) {
  const t = (text || '').toLowerCase();
  let hits = [];
  // 1) explicit code mentioned (e.g. 9436, L178, 0U42)
  const m = t.match(/\b([a-z]?\d{3,4}|[a-z0-9]\d{2,3})\b/i);
  if (m) { const s = shades.findShade(m[1]); if (s) hits.push(s); }
  // 2) colour family mentioned
  if (hits.length < 5) {
    const fam = shades.FAMILIES.find((f) =>
      t.includes(f.label.toLowerCase()) || t.includes(f.key.split(' ')[0])
    );
    if (fam) hits = hits.concat(shades.shadesInFamily(fam.key, 0).shades);
  }
  // 3) generic colour intent -> a few versatile picks
  if (hits.length === 0 && /(colour|color|shade|paint|wall)/.test(t)) {
    ['9436', '8099', '7809', 'L178', '8302', '7660'].forEach((c) => {
      const s = shades.findShade(c); if (s) hits.push(s);
    });
  }
  hits = hits.slice(0, 8);
  if (!hits.length) return '';
  const lines = hits
    .map((s) => '- ' + s.name + ' (code ' + s.shadeNo + ') ' + s.hex + ' — ' + s.family)
    .join('\n');
  return '\n\n=== ASIAN PAINTS SHADE DATABASE RESULTS ===\n' + lines +
    '\n=== END RESULTS ===';
}

// ---- Anthropic call via fetch (no SDK dependency needed) ----
async function callClaude(messages) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      tools: [TOOL_SPEC],
      messages,
    }),
  });
  if (!resp.ok) throw new Error('Anthropic ' + resp.status + ': ' + (await resp.text()));
  return resp.json();
}
function textFrom(content) {
  return (content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
}

// ---- webhook verification (GET) ----
app.get('/whatsapp', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});
app.get('/', (req, res) => res.send('Chandra Color Shoppee WhatsApp bot is running.'));

// ---- inbound messages (POST) ----
app.post('/whatsapp', (req, res) => {
  res.sendStatus(200); // ACK fast so Meta does not retry
  try {
    for (const entry of req.body.entry || []) {
      for (const ch of entry.changes || []) {
        const val = ch.value || {};
        for (const msg of val.messages || []) {
          handleInbound(msg).catch((e) => console.error('handleInbound error:', e.message));
        }
      }
    }
  } catch (e) {
    console.error('webhook parse error:', e.message);
  }
});

async function handleInbound(msg) {
  const from = msg.from;
  const sess = getSession(from);
  sess.ts = Date.now();

  let userText = '';
  if (msg.type === 'text') {
    userText = (msg.text && msg.text.body) || '';
  } else if (msg.type === 'interactive') {
    const i = msg.interactive || {};
    userText =
      (i.list_reply && (i.list_reply.title || i.list_reply.id)) ||
      (i.button_reply && (i.button_reply.title || i.button_reply.id)) || '';
  } else if (msg.type === 'image') {
    sess.lastImageMediaId = msg.image.id; // remember photo for the visualiser
    const cap = (msg.image.caption || '').trim();
    userText = cap
      ? '[The customer sent a photo of their room/wall with caption:] ' + cap
      : '[The customer sent a photo of their room/wall.]';
  } else {
    userText = '[The customer sent an unsupported message type: ' + msg.type + ']';
  }

  // augment with shade DB results when relevant, then add to history
  sess.history.push({ role: 'user', content: userText + attachShadeResults(userText) });
  if (sess.history.length > 20) sess.history = sess.history.slice(-20);

  let response = await callClaude(sess.history);

  // tool-use loop
  while (response.stop_reason === 'tool_use') {
    sess.history.push({ role: 'assistant', content: response.content });
    const toolResults = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const result = await handleToolUse(block, {
          sender: from,
          lastImageMediaId: sess.lastImageMediaId,
        }).catch((e) => 'Render failed: ' + e.message);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result || 'done' });
      }
    }
    sess.history.push({ role: 'user', content: toolResults });
    response = await callClaude(sess.history);
  }

  sess.history.push({ role: 'assistant', content: response.content });
  const reply = textFrom(response.content);
  if (reply) await wa.sendText(from, reply);

  // ---- LEAD CAPTURE HOOK ----
  // If your previous bot saved name/phone to Google Sheets, re-add that call
  // here (e.g. detect a captured lead in `reply` or keep your own parser).
}

if (require.main === module) {
  app.listen(PORT, () => console.log('CCS bot (with visualiser) listening on ' + PORT));
}

module.exports = { app, handleInbound, attachShadeResults };
