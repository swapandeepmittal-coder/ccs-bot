/**
 * Self-contained Shade Wall Visualiser add-on for the EXISTING CCS bot.
 *
 * It does NOT replace your server or touch your Claude call / lead capture.
 * You add ONE line to your existing webhook loop:
 *
 *     const shadeViz = require('./shadeVisualizer');
 *     // ...inside your "for (const msg of messages)" loop, FIRST thing:
 *     if (await shadeViz.handle(msg)) continue;   // visualiser handled it
 *     // ...your existing bot logic stays exactly as-is below
 *
 * Behaviour (kept deliberately safe so it never hijacks normal chat):
 *   - Customer sends a room photo  -> we remember it (and let your bot reply).
 *   - Customer sends a photo whose CAPTION is a shade code/name -> we render now.
 *   - Customer sends a shade code (e.g. "9436") or exact shade name
 *     (e.g. "air breeze") AND sent a photo in the last 30 min -> we render.
 *   - Anything else -> we return false and your bot handles it normally.
 *
 * Needs: whatsapp.js, renderer.js, shades.js, plus deps sharp + @google/genai,
 * and env GEMINI_API_KEY (or IMAGE_PROVIDER=stub to test free).
 */

const wa = require('./whatsapp');
const { renderFeatureWall, stampShadeLabel } = require('./renderer');
const shades = require('./shades');

const TTL_MS = 30 * 60 * 1000; // remember a customer's photo for 30 min
const lastImg = {}; // from -> { id, ts }

// Strict match only: exact code, exact name, or a clear code token like "9436".
function strictShade(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  for (const s of shades.SHADES) if (s.shadeNo.toLowerCase() === t) return s;
  for (const s of shades.SHADES) if (s.name.toLowerCase() === t) return s;
  const m = t.match(/\b([a-z]?\d{3,4})\b/); // "shade 9436", "code 9436", "9436 air breeze"
  if (m) {
    const c = m[1];
    const hit = shades.SHADES.find((s) => s.shadeNo.toLowerCase() === c);
    if (hit) return hit;
  }
  return null;
}

function recentImage(from) {
  const r = lastImg[from];
  return r && Date.now() - r.ts < TTL_MS ? r.id : null;
}

async function renderAndSend(from, shade, mediaId) {
  await wa.sendText(
    from,
    'Creating your preview in *' + shade.name + '* (shade ' + shade.shadeNo + ')… one moment ⏳'
  );
  const { buffer, mime } = await wa.downloadMedia(mediaId);
  const rendered = await renderFeatureWall(buffer, mime, shade);
  const stamped = await stampShadeLabel(rendered, 'Shade ' + shade.shadeNo, { hex: shade.hex });
  const caption =
    shade.name + ' — shade ' + shade.shadeNo + (shade.hex ? ' (' + shade.hex + ')' : '') +
    '\nSend another shade code to try more. Visit Chandra Color Shoppee or call +91 63995 46064.';
  await wa.sendRenderedImage(from, stamped, caption);
}

// Returns true if this add-on handled the message (your bot should then skip it).
async function handle(msg) {
  try {
    const from = msg.from;
    if (msg.type === 'image') {
      lastImg[from] = { id: msg.image.id, ts: Date.now() };
      const shade = strictShade((msg.image.caption || '').trim());
      if (shade) { await renderAndSend(from, shade, msg.image.id); return true; }
      return false; // photo with no shade -> let your bot welcome them
    }
    if (msg.type === 'text') {
      const shade = strictShade(msg.text.body || '');
      const mediaId = recentImage(from);
      if (shade && mediaId) { await renderAndSend(from, shade, mediaId); return true; }
      return false;
    }
    return false;
  } catch (e) {
    console.error('shadeVisualizer error:', e.message);
    return false; // on any error, fall back to your normal bot
  }
}

module.exports = { handle };
