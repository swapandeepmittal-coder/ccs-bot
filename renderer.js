// AI feature-wall renderer + shade-number label stamp (Node).
//
//   renderFeatureWall(imageBuffer, mime, shade) -> Promise<Buffer>
//   stampShadeLabel(imageBuffer, text)          -> Promise<Buffer>
//
// renderFeatureWall paints the room's main wall in the shade's colour/finish.
// stampShadeLabel burns a small "Shade <no>" tag onto the rendered image.
//
// Provider via env IMAGE_PROVIDER: "gemini" (default) | "stub".
// "stub" needs no API key — it just returns the original photo so you can test
// the WhatsApp plumbing; the shade-number stamp is applied either way.

const sharp = require('sharp');

function buildPrompt(shade) {
  // Use the shade colour + description so the render matches the real product.
  const colour = shade.hex ? ` in the exact colour ${shade.hex}` : '';
  const named = shade.name ? ` (shade "${shade.name}")` : '';
  const finish = shade.description ? `, finish: ${shade.description}` : '';
  return (
    'You are an interior design visualiser. Edit the provided photo of a real ' +
    'room. Repaint/clad ONLY the main/largest visible wall' +
    colour +
    named +
    finish +
    '. Keep everything else exactly as in the original photo: the same ' +
    'furniture, flooring, windows, doors, ceiling, decor, lighting direction, ' +
    'perspective and camera angle. The new wall must follow the wall’s real ' +
    'perspective and respect objects in front of it. Produce a single ' +
    'photorealistic image.'
  );
}

// --- Gemini ("Nano Banana" image editing) ---
async function renderGemini(imageBuffer, mime, shade) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const resp = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash-image',
    contents: [
      { text: buildPrompt(shade) },
      { inlineData: { mimeType: mime, data: imageBuffer.toString('base64') } },
    ],
  });

  const parts = resp?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData && part.inlineData.data) {
      return Buffer.from(part.inlineData.data, 'base64');
    }
  }
  throw new Error('Gemini returned no image. Text: ' + (resp?.text || '<none>'));
}

// --- Stub: no API key; returns the original bytes (label is added later) ---
async function renderStub(imageBuffer, mime, shade) {
  return imageBuffer;
}

async function renderFeatureWall(imageBuffer, mime, shade) {
  const provider = (process.env.IMAGE_PROVIDER || 'gemini').toLowerCase();
  if (provider === 'gemini') return renderGemini(imageBuffer, mime, shade);
  if (provider === 'stub') return renderStub(imageBuffer, mime, shade);
  throw new Error(`Unknown IMAGE_PROVIDER: ${provider}`);
}

// Escape text for safe inclusion in SVG.
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Burn a "Shade NNN" tag onto the bottom-left of the image.
// Scales with image width so it reads on any photo size.
async function stampShadeLabel(imageBuffer, text, opts = {}) {
  const img = sharp(imageBuffer);
  const meta = await img.metadata();
  const W = meta.width || 1024;
  const H = meta.height || 1024;

  const label = xmlEscape(text);
  const fontSize = Math.max(18, Math.round(W * 0.035));
  const padX = Math.round(fontSize * 0.7);
  const padY = Math.round(fontSize * 0.45);
  const charW = fontSize * 0.62; // rough monospace-ish width estimate
  const tagW = Math.round(label.length * charW + padX * 2);
  const tagH = Math.round(fontSize + padY * 2);
  const margin = Math.round(W * 0.03);
  const x = margin;
  const y = H - tagH - margin;
  const swatch = opts.hex && /^#?[0-9a-fA-F]{6}$/.test(opts.hex)
    ? (opts.hex.startsWith('#') ? opts.hex : '#' + opts.hex)
    : null;
  const swatchW = swatch ? tagH : 0;

  const svg = Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">` +
      `<g>` +
      `<rect x="${x}" y="${y}" width="${tagW + swatchW}" height="${tagH}" rx="${Math.round(
        tagH * 0.22
      )}" fill="rgba(0,0,0,0.72)"/>` +
      (swatch
        ? `<rect x="${x + 4}" y="${y + 4}" width="${swatchW - 8}" height="${tagH - 8}" rx="4" fill="${swatch}"/>`
        : '') +
      `<text x="${x + swatchW + padX}" y="${y + tagH - padY}" ` +
      `font-family="Arial, Helvetica, sans-serif" font-weight="700" ` +
      `font-size="${fontSize}" fill="#ffffff">${label}</text>` +
      `</g></svg>`
  );

  return sharp(imageBuffer)
    .composite([{ input: svg, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

module.exports = { renderFeatureWall, stampShadeLabel, buildPrompt };
