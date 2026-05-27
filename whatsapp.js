// Minimal WhatsApp Cloud API (Meta Graph) client for Node 18+.
// Uses the global fetch / FormData / Blob (no extra HTTP deps).
//
// If your existing bot already has its own send/download helpers, you can skip
// this file and pass your own implementations into featureWall.js via configure().

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';
const GRAPH = 'https://graph.facebook.com/' + API_VERSION;

function token() {
  const t = process.env.WHATSAPP_TOKEN;
  if (!t) throw new Error('WHATSAPP_TOKEN is not set');
  return t;
}

function phoneNumberId() {
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!id) throw new Error('WHATSAPP_PHONE_NUMBER_ID is not set');
  return id;
}

async function checkOk(resp) {
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error('WhatsApp API ' + resp.status + ': ' + body);
  }
  return resp.json();
}

// --- Inbound media: resolve media_id -> url, then download bytes ---
async function downloadMedia(mediaId) {
  const metaResp = await fetch(GRAPH + '/' + mediaId, {
    headers: { Authorization: 'Bearer ' + token() },
  });
  const info = await checkOk(metaResp);
  const mime = info.mime_type || 'image/jpeg';

  const mediaResp = await fetch(info.url, {
    headers: { Authorization: 'Bearer ' + token() },
  });
  if (!mediaResp.ok) {
    throw new Error('Media download failed: ' + mediaResp.status);
  }
  const buf = Buffer.from(await mediaResp.arrayBuffer());
  return { buffer: buf, mime };
}

async function postMessage(payload) {
  const resp = await fetch(GRAPH + '/' + phoneNumberId() + '/messages', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return checkOk(resp);
}

async function sendText(to, body) {
  return postMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: String(body).slice(0, 4096) },
  });
}

// Generic interactive list. rows: [{id,title,description}] (max 10 total).
async function sendList(to, opts) {
  const { header, body, footer, button, rows } = opts;
  const section = {
    rows: rows.slice(0, 10).map((r) => {
      const row = { id: String(r.id).slice(0, 200), title: String(r.title).slice(0, 24) };
      if (r.description) row.description = String(r.description).slice(0, 72);
      return row;
    }),
  };
  const interactive = {
    type: 'list',
    body: { text: String(body || ' ').slice(0, 1024) },
    action: { button: String(button || 'Open').slice(0, 20), sections: [section] },
  };
  if (header) interactive.header = { type: 'text', text: String(header).slice(0, 60) };
  if (footer) interactive.footer = { text: String(footer).slice(0, 60) };
  return postMessage({ messaging_product: 'whatsapp', to, type: 'interactive', interactive });
}

// Upload bytes -> media_id (so we can send by id).
async function uploadMedia(buffer, mime) {
  mime = mime || 'image/png';
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([buffer], { type: mime }), 'render.png');

  const resp = await fetch(GRAPH + '/' + phoneNumberId() + '/media', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token() },
    body: form,
  });
  const json = await checkOk(resp);
  return json.id;
}

async function sendImage(to, mediaId, caption) {
  return postMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: { id: mediaId, caption: String(caption || '').slice(0, 1024) },
  });
}

async function sendRenderedImage(to, buffer, caption) {
  const mediaId = await uploadMedia(buffer, 'image/png');
  return sendImage(to, mediaId, caption || '');
}

module.exports = {
  downloadMedia,
  sendText,
  sendList,
  uploadMedia,
  sendImage,
  sendRenderedImage,
};
