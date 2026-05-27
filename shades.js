// Asian Paints shade catalog, loaded from asian_paints_shades.csv at startup.
//
// CSV columns: name,code,hex,family,temperature,tonality
//
// Because the fandeck has ~2200 shades and a WhatsApp list shows only 10 rows,
// shades are browsed by colour family and paged. Users can also type a shade
// code (e.g. "9436") or name (e.g. "air breeze") to jump straight to one.
//
// Point SHADES_CSV at a different file to use your own list (same columns).

const fs = require('fs');
const path = require('path');

const CSV_PATH = process.env.SHADES_CSV || path.join(__dirname, 'asian_paints_shades.csv');
const PAGE_SIZE = 9; // 9 shades + 1 "More" row keeps within WhatsApp's 10-row list

function clamp(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) : s;
}

// Fold the tiny "whites" family into "off whites" so we land on 10 families.
function normaliseFamily(f) {
  f = (f || '').trim().toLowerCase();
  return f === 'whites' ? 'off whites' : f;
}

// Build a paint-appropriate finish description for the AI prompt.
function describe(name, family, temperature, tonality) {
  const fam = family.replace(/s$/, ''); // "greens" -> "green"
  return (
    name + ' — a ' + tonality + ' ' + temperature + '-toned ' + fam +
    ' paint shade, applied as a smooth even matte wall finish'
  );
}

function makeShade(rec) {
  const family = normaliseFamily(rec.family);
  const hex = (rec.hex || '').trim().toUpperCase();
  const code = (rec.code || '').trim();
  const name = (rec.name || '').trim();
  const temperature = (rec.temperature || '').trim();
  const tonality = (rec.tonality || '').trim();
  return {
    id: 'sh|' + code,
    shadeNo: code,
    name,
    hex,
    family,
    temperature,
    tonality,
    description: describe(name, family, temperature, tonality),
    title: clamp(code + ' · ' + name, 24),
    desc: clamp(tonality + ', ' + temperature + ' · ' + hex, 72),
  };
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  const header = lines.shift().split(',').map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  return lines.map((line) => {
    const p = line.split(',');
    return {
      name: p[idx.name],
      code: p[idx.code],
      hex: p[idx.hex],
      family: p[idx.family],
      temperature: p[idx.temperature],
      tonality: p[idx.tonality],
    };
  });
}

let SHADES = [];
try {
  SHADES = parseCsv(fs.readFileSync(CSV_PATH, 'utf8')).map(makeShade);
} catch (e) {
  console.error('[shades] could not load CSV at ' + CSV_PATH + ': ' + e.message);
  SHADES = [];
}

const byId = new Map(SHADES.map((s) => [s.id, s]));
const byCode = new Map(SHADES.map((s) => [s.shadeNo.toLowerCase(), s]));
const byName = new Map(SHADES.map((s) => [s.name.toLowerCase(), s]));

const FAMILY_ORDER = [
  ['off whites', 'Off-Whites'],
  ['greys', 'Greys'],
  ['browns', 'Browns'],
  ['reds', 'Reds'],
  ['oranges', 'Oranges'],
  ['yellows', 'Yellows'],
  ['greens', 'Greens'],
  ['blues', 'Blues'],
  ['purples', 'Purples'],
  ['pinks', 'Pinks'],
];

const familyShades = {};
for (const s of SHADES) {
  (familyShades[s.family] = familyShades[s.family] || []).push(s);
}

const FAMILIES = FAMILY_ORDER.filter(([key]) => familyShades[key]).map(([key, label]) => ({
  key,
  label,
  count: familyShades[key].length,
}));

function familyLabel(key) {
  const f = FAMILIES.find((x) => x.key === key);
  return f ? f.label : key;
}

function shadesInFamily(familyKey, page = 0) {
  const all = familyShades[familyKey] || [];
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const start = p * PAGE_SIZE;
  return {
    shades: all.slice(start, start + PAGE_SIZE),
    page: p,
    pages,
    hasMore: start + PAGE_SIZE < all.length,
  };
}

function getShade(id) {
  return byId.get(id) || null;
}

function findShade(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  if (byCode.has(t)) return byCode.get(t);
  if (byName.has(t)) return byName.get(t);
  const hit = SHADES.find((s) => s.name.toLowerCase().includes(t));
  return hit || null;
}

function customShade(text) {
  const t = String(text || '').trim();
  return {
    id: 'custom',
    shadeNo: '',
    name: t.slice(0, 40) || 'Custom',
    hex: '',
    family: '',
    description: t,
    title: 'Custom',
    desc: clamp(t, 72),
  };
}

module.exports = {
  SHADES,
  FAMILIES,
  PAGE_SIZE,
  familyLabel,
  shadesInFamily,
  getShade,
  findShade,
  customShade,
};
