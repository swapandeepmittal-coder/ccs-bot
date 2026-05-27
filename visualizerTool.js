// Claude tool adapter for the Asian Paints wall visualiser, for the Meta Cloud
// API bot (Render + Express + Anthropic Claude).
//
// How it fits your bot:
//   1) In your /whatsapp webhook, when an inbound message has an image, remember
//      that image's media_id for that sender (see TWILIO-vs-CLOUD note in the
//      wiring guide). Pass it as ctx.lastImageMediaId.
//   2) Add TOOL_SPEC to your Anthropic messages.create({ tools: [TOOL_SPEC] }).
//   3) When Claude returns a tool_use for "render_wall_in_shade", call
//      handleToolUse(toolUse, ctx). It downloads the photo, renders the wall in
//      the requested shade, stamps the shade number, sends the image to the
//      customer via the Cloud API, and returns a short tool_result string to
//      feed back to Claude.
//
// Reuses whatsapp.js (Cloud API client), renderer.js (Gemini + stamp), shades.js.

const wa = require('./whatsapp');
const { renderFeatureWall, stampShadeLabel } = require('./renderer');
const { findShade, customShade } = require('./shades');

// Anthropic tool definition — add to messages.create({ tools: [TOOL_SPEC] }).
const TOOL_SPEC = {
  name: 'render_wall_in_shade',
  description:
    "Show the customer how their room looks with one feature wall repainted in a " +
    "specific Asian Paints shade. Use ONLY when the customer has already sent a " +
    "photo of their room/wall in this chat AND names or implies a shade to try " +
    "(by shade code like \"9436\" or name like \"air breeze\"). The rendered image " +
    "is sent to the customer automatically; do not describe the image yourself.",
  input_schema: {
    type: 'object',
    properties: {
      shade: {
        type: 'string',
        description:
          'The Asian Paints shade to apply: a shade code (e.g. "9436") or a shade ' +
          'name (e.g. "air breeze"). Use what the customer asked for.',
      },
    },
    required: ['shade'],
  },
};

// Render the stored room photo in the requested shade and send it back.
// ctx must provide: { sender, lastImageMediaId }.
// Returns a string suitable as the tool_result content for Claude.
async function handleToolUse(toolUse, ctx) {
  if (!toolUse || toolUse.name !== 'render_wall_in_shade') return null;
  const sender = ctx && ctx.sender;
  const mediaId = ctx && ctx.lastImageMediaId;

  if (!sender) throw new Error('handleToolUse: ctx.sender is required');
  if (!mediaId) {
    return 'No room photo on file for this customer yet. Ask them to send a clear ' +
      'photo of the wall first, then try the shade again.';
  }

  const query = (toolUse.input && toolUse.input.shade) || '';
  const shade = findShade(query) || customShade(query);

  // 1) download the room photo (Cloud API media)
  const { buffer, mime } = await wa.downloadMedia(mediaId);
  // 2) render the wall in the shade, then stamp the shade number on the image
  const rendered = await renderFeatureWall(buffer, mime, shade);
  const label = shade.shadeNo ? 'Shade ' + shade.shadeNo : shade.name;
  const stamped = await stampShadeLabel(rendered, label, { hex: shade.hex });
  // 3) send the image back to the customer
  const caption = shade.shadeNo
    ? shade.name + ' — shade ' + shade.shadeNo + (shade.hex ? ' (' + shade.hex + ')' : '') +
      '\nVisit Chandra Color Shoppee to see the physical shade card, or call +91 63995 46064.'
    : shade.name +
      '\nVisit Chandra Color Shoppee to see the physical shade card, or call +91 63995 46064.';
  await wa.sendRenderedImage(sender, stamped, caption);

  // 4) tell Claude what happened (Claude should NOT re-describe the image)
  const matched = shade.shadeNo
    ? 'shade ' + shade.shadeNo + ' (' + shade.name + ')'
    : 'a custom colour (' + shade.name + ')';
  return 'Done — sent the customer a render of their wall in ' + matched +
    '. Reply with one short line inviting them to try another shade or visit the shop.';
}

module.exports = { TOOL_SPEC, handleToolUse };
