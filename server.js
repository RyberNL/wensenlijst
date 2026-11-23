'use strict';
// Wensenlijst — no-account wishlists. Zero dependencies (Node >= 22.13, built-in node:sqlite).
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { createAuth, hashPw, checkPw } = require('./auth-lib');

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'wensen.db');
const ORIGIN = (process.env.ORIGIN || '').replace(/\/$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- database ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS lists (
    id          TEXT PRIMARY KEY,           -- public share id
    edit_token  TEXT NOT NULL UNIQUE,       -- secret owner token
    title       TEXT NOT NULL,
    owner_name  TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id    TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    url        TEXT NOT NULL DEFAULT '',
    price      TEXT NOT NULL DEFAULT '',
    image      TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT '',
    position   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS items_list ON items(list_id, position);
  CREATE TABLE IF NOT EXISTS claims (
    item_id     INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    claim_token TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS groups (
    id          TEXT PRIMARY KEY,           -- public group id
    edit_token  TEXT NOT NULL UNIQUE,       -- secret group admin token
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    pw_hash     TEXT NOT NULL DEFAULT '',   -- '' = no password, else scrypt$salt$hash
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS group_lists (
    group_id  TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    list_id   TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, list_id)
  );
  CREATE INDEX IF NOT EXISTS group_lists_list ON group_lists(list_id);
`);

// migration: separate currency column (prices used to be stored as "€ 12,34")
if (!db.prepare("SELECT 1 FROM pragma_table_info('items') WHERE name = 'currency'").get()) {
  db.exec(`ALTER TABLE items ADD COLUMN currency TEXT NOT NULL DEFAULT 'EUR';
           UPDATE items SET price = trim(replace(price, '€', '')) WHERE price LIKE '%€%';`);
}

const q = {
  insertList: db.prepare('INSERT INTO lists (id, edit_token, title, owner_name, description, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  listByEdit: db.prepare('SELECT * FROM lists WHERE edit_token = ?'),
  listById: db.prepare('SELECT * FROM lists WHERE id = ?'),
  updateList: db.prepare('UPDATE lists SET title = ?, owner_name = ?, description = ? WHERE id = ?'),
  deleteList: db.prepare('DELETE FROM lists WHERE id = ?'),
  items: db.prepare('SELECT id, title, url, price, currency, image, note, position FROM items WHERE list_id = ? ORDER BY position, id'),
  itemsWithClaims: db.prepare(`SELECT i.id, i.title, i.url, i.price, i.currency, i.image, i.note, c.name AS claim_name, c.claim_token
                               FROM items i LEFT JOIN claims c ON c.item_id = i.id WHERE i.list_id = ? ORDER BY i.position, i.id`),
  item: db.prepare('SELECT * FROM items WHERE id = ? AND list_id = ?'),
  maxPos: db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM items WHERE list_id = ?'),
  countItems: db.prepare('SELECT COUNT(*) AS n FROM items WHERE list_id = ?'),
  insertItem: db.prepare('INSERT INTO items (list_id, title, url, price, currency, image, note, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  updateItem: db.prepare('UPDATE items SET title = ?, url = ?, price = ?, currency = ?, image = ?, note = ? WHERE id = ? AND list_id = ?'),
  deleteItem: db.prepare('DELETE FROM items WHERE id = ? AND list_id = ?'),
  setPos: db.prepare('UPDATE items SET position = ? WHERE id = ? AND list_id = ?'),
  claim: db.prepare('SELECT * FROM claims WHERE item_id = ?'),
  insertClaim: db.prepare('INSERT INTO claims (item_id, name, claim_token, created_at) VALUES (?, ?, ?, ?)'),
  deleteClaim: db.prepare('DELETE FROM claims WHERE item_id = ?'),
  insertGroup: db.prepare('INSERT INTO groups (id, edit_token, title, description, pw_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  groupById: db.prepare('SELECT * FROM groups WHERE id = ?'),
  groupByEdit: db.prepare('SELECT * FROM groups WHERE edit_token = ?'),
  updateGroup: db.prepare('UPDATE groups SET title = ?, description = ? WHERE id = ?'),
  setGroupPw: db.prepare('UPDATE groups SET pw_hash = ? WHERE id = ?'),
  deleteGroup: db.prepare('DELETE FROM groups WHERE id = ?'),
  groupMembers: db.prepare(`SELECT l.id, l.title, l.owner_name, (SELECT COUNT(*) FROM items i WHERE i.list_id = l.id) AS items
                            FROM group_lists g JOIN lists l ON l.id = g.list_id WHERE g.group_id = ? ORDER BY g.joined_at, l.id`),
  countMembers: db.prepare('SELECT COUNT(*) AS n FROM group_lists WHERE group_id = ?'),
  countGroupsOf: db.prepare('SELECT COUNT(*) AS n FROM group_lists WHERE list_id = ?'),
  isMember: db.prepare('SELECT 1 FROM group_lists WHERE group_id = ? AND list_id = ?'),
  joinGroup: db.prepare('INSERT OR IGNORE INTO group_lists (group_id, list_id, joined_at) VALUES (?, ?, ?)'),
  leaveGroup: db.prepare('DELETE FROM group_lists WHERE group_id = ? AND list_id = ?'),
  groupsOfList: db.prepare('SELECT g.id, g.title FROM group_lists gl JOIN groups g ON g.id = gl.group_id WHERE gl.list_id = ? ORDER BY gl.joined_at'),
};

// ---------- helpers ----------
const token = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const now = () => Date.now();
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};
function httpUrl(v) {
  const s = str(v, 2000);
  if (!s) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : '';
  } catch { return ''; }
}

const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src * data:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer', // edit tokens live in URLs: never leak them to shops
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  ...(ORIGIN.startsWith('https:') ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
};
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SEC_HEADERS, ...extra });
  res.end(data);
}
const json = (res, status, obj) => send(res, status, obj);
const fail = (res, status, msg) => json(res, status, { error: msg });

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// simple in-memory rate limiter: key -> timestamps
const hits = new Map();
function limited(key, max, windowMs) {
  const t = now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  arr.push(t); hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const t = now(); for (const [k, a] of hits) if (!a.some((x) => t - x < 3600e3)) hits.delete(k); }, 600e3).unref();
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

// ---------- product metadata fetching (SSRF-safe) ----------
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    return l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('64:ff9b') || l.startsWith('2001:db8');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function safeLookup(hostname, opts, cb) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter((a) => !isPrivateIp(a.address));
    if (!ok.length || ok.length !== addrs.length) return cb(new Error('blocked address'));
    if (opts && opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
};
function fetchHtml(urlStr, redirects = 5) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('bad url')); }
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('bad protocol'));
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateIp(u.hostname.replace(/^\[|\]$/g, ''))) return reject(new Error('blocked address'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', headers: BROWSER_HEADERS, lookup: safeLookup, timeout: 8000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        return resolve(fetchHtml(new URL(res.headers.location, u).toString(), redirects - 1));
      }
      if (res.statusCode >= 400) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = []; let size = 0;
      stream.on('data', (c) => {
        size += c.length; chunks.push(c);
        if (size > 3 * 1024 * 1024) { req.destroy(); stream.destroy(); resolve({ html: Buffer.concat(chunks).toString('utf8'), finalUrl: u.toString() }); }
      });
      stream.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8'), finalUrl: u.toString() }));
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|euro);/gi, (m, e) => {
    const l = e.toLowerCase();
    if (l[0] === '#') { const n = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€' }[l];
  });
}
function metaContent(html, names) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const name of names) {
    for (const tag of tags) {
      const key = tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i);
      if (key && key[1].toLowerCase() === name) {
        const c = tag.match(/\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i);
        if (c) { const v = decodeEntities((c[2] ?? c[3] ?? '').trim()); if (v) return v; }
      }
    }
  }
  return '';
}
const PRODUCT_TYPES = new Set(['Product', 'ProductGroup', 'ProductModel', 'IndividualProduct', 'Book', 'Vehicle']);
function jsonLdProduct(html) {
  const blocks = html.match(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  const found = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    const types = [].concat(n['@type'] || []);
    if (n.offers || types.some((t) => PRODUCT_TYPES.has(t))) found.push(n);
    if (n['@graph']) walk(n['@graph']);
    if (n.hasVariant) walk(n.hasVariant);
  };
  for (const b of blocks) {
    const body = b.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    try { walk(JSON.parse(body)); } catch { /* ignore malformed */ }
  }
  if (!found.length) return {};
  const p = found[0];
  const withOffer = found.find((x) => x.offers) || p;
  let offer = withOffer.offers;
  if (Array.isArray(offer)) offer = offer[0];
  let price = offer && (offer.price ?? offer.lowPrice ?? (offer.priceSpecification && offer.priceSpecification.price));
  const currency = offer && (offer.priceCurrency || (offer.priceSpecification && offer.priceSpecification.priceCurrency));
  let image = p.image;
  if (Array.isArray(image)) image = image[0];
  if (image && typeof image === 'object') image = image.url || image.contentUrl;
  return { title: typeof p.name === 'string' ? decodeEntities(p.name) : '', price: price != null ? String(price) : '', currency: detectCurrency(currency), image: typeof image === 'string' ? image : '' };
}
function formatPrice(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/[^\d.,]/g, '');
  if (!s) return '';
  // "1.299,95" or "1,299.95" or "12,5" -> number
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  if (!isFinite(n) || n <= 0) return '';
  return n.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const CURRENCIES = { EUR: '€', USD: '$', GBP: '£' };
// "GBP", "£ 12", "US$9.99" -> supported currency code, or '' if unknown/unsupported
function detectCurrency(raw) {
  const s = String(raw || '').toUpperCase();
  if (/GBP|£/.test(s)) return 'GBP';
  if (/USD|\$/.test(s)) return 'USD';
  if (/EUR|€/.test(s)) return 'EUR';
  return '';
}
const clean = (t) => decodeEntities(String(t || '')).replace(/\s+/g, ' ').trim().slice(0, 200);
function absUrl(u, base) { try { return httpUrl(new URL(u, base).toString()); } catch { return ''; } }

// Generic: JSON-LD Product, then OpenGraph / <title>.
function parseGeneric(html, finalUrl) {
  const ld = jsonLdProduct(html);
  const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const title = ld.title || metaContent(html, ['og:title', 'twitter:title']) || titleTag || '';
  const image = metaContent(html, ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image']) || ld.image || '';
  const price = formatPrice(ld.price || metaContent(html, ['product:price:amount', 'og:price:amount', 'price']));
  const currency = price ? (ld.currency || detectCurrency(metaContent(html, ['product:price:currency', 'og:price:currency', 'pricecurrency']))) : '';
  return { title: clean(title), image: image ? absUrl(image, finalUrl) : '', price, currency };
}

// Amazon has no JSON-LD/OpenGraph; read its product page markup directly.
const isAmazon = (host) => /(^|\.)amazon\.(nl|de|com|co\.uk|fr|be|es|it)$/i.test(host);
function parseAmazon(html, finalUrl) {
  if (/validateCaptcha|api-services-support@amazon|opfcaptcha/i.test(html)) throw new Error('Amazon vraagt om een captcha');
  const u = new URL(finalUrl);
  const asin = (u.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i) || [])[1];
  let title = (html.match(/id="productTitle"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || '';
  if (!title) title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s*:\s*Amazon\.[a-z.]+.*$/i, '').replace(/^Amazon\.[a-z.]+\s*:\s*/i, '');
  // price: first a-offscreen inside the main price block, else first "priceToPay"
  let price = '', currency = '';
  for (const marker of ['id="corePrice_feature_div"', 'id="corePriceDisplay_desktop_feature_div"', 'priceToPay', 'id="apex_desktop"']) {
    const i = html.indexOf(marker);
    if (i < 0) continue;
    const m = html.slice(i, i + 6000).match(/class="a-offscreen">\s*([^<]*\d[^<]*)</);
    if (m) { price = formatPrice(m[1]); currency = detectCurrency(m[1]); if (price) break; }
  }
  const image = (html.match(/data-old-hires="(https:[^"]+)"/) || html.match(/"hiRes":"(https:[^"]+)"/) || html.match(/id="landingImage"[^>]*\ssrc="(https:[^"]+)"/) || [])[1] || '';
  if (price && !currency) currency = /\.co\.uk$/i.test(u.hostname) ? 'GBP' : /\.com$/i.test(u.hostname) ? 'USD' : 'EUR';
  return { title: clean(title), image: httpUrl(image), price, currency: price ? currency : '', url: asin ? `${u.origin}/dp/${asin}` : '' };
}

// Search words from a product URL slug, e.g. /nl/product/_apple-airpods-4-1858385.html -> "apple airpods 4".
function queryFromUrl(url) {
  let u; try { u = new URL(url); } catch { return ''; }
  const segs = u.pathname.split('/').map((x) => decodeURIComponent(x).replace(/\.\w{2,5}$/, ''))
    .filter((x) => /[a-z]{2,}.*[-_+]/i.test(x) || /[-_+].*[a-z]{2,}/i.test(x));
  const best = segs.sort((a, b) => b.length - a.length)[0] || '';
  return best.split(/[-_+]+/).filter((w) => w && !/^\d{7,}$/.test(w) && !/^(?=.*\d)(?=.*[a-z])[a-z0-9]{8,}$/i.test(w)).join(' ').trim();
}

// Fallback: beslist.nl (Dutch price comparison) search, first product of its JSON-LD ItemList.
async function beslistLookup(query) {
  query = query.split(/\s+/).slice(0, 10).join(' ');
  if (query.replace(/[^a-z]/gi, '').length < 3) return null;
  const { html, finalUrl } = await fetchHtml('https://www.beslist.nl/search?query=' + encodeURIComponent(query));
  const blocks = html.match(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocks) {
    let d; try { d = JSON.parse(b.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '')); } catch { continue; }
    if (!d || d['@type'] !== 'ItemList' || !Array.isArray(d.itemListElement)) continue;
    const p = (d.itemListElement[0] || {}).item;
    if (!p || !p.name) continue;
    const o = Array.isArray(p.offers) ? p.offers[0] : p.offers || {};
    const img = Array.isArray(p.image) ? p.image[0] : p.image;
    return { title: clean(p.name), image: img ? absUrl(img, finalUrl) : '', price: formatPrice(o.lowPrice ?? o.price), currency: 'EUR' };
  }
  return null;
}

async function fetchProduct(url) {
  let result = { title: '', image: '', price: '' }, error = null;
  try {
    const { html, finalUrl } = await fetchHtml(url);
    result = isAmazon(new URL(finalUrl).hostname) ? parseAmazon(html, finalUrl) : parseGeneric(html, finalUrl);
    if (!result.url && finalUrl !== url && isAmazon(new URL(finalUrl).hostname)) result.url = finalUrl; // expanded amzn.eu short link
  } catch (e) { error = e; }
  if (result.title && result.price && result.image) return result;

  // Something is missing: look the product up on beslist.nl and fill only the gaps.
  const query = result.title || queryFromUrl(url);
  let fb = null;
  if (query) { try { fb = await beslistLookup(query); } catch { /* fallback is best-effort */ } }
  if (!fb) { if (error) throw error; return result; }
  const filled = [];
  for (const k of ['title', 'price', 'image']) if (!result[k] && fb[k]) { result[k] = fb[k]; filled.push(k); }
  if (filled.includes('price')) result.currency = fb.currency;
  if (filled.length) result.fallback = { source: 'beslist.nl', fields: filled };
  if (!result.title && error) throw error;
  return result;
}

// ---------- API ----------
function itemFields(b) {
  const title = str(b.title, 200);
  const currency = Object.hasOwn(CURRENCIES, b.currency) ? b.currency : 'EUR';
  const price = str(b.price, 40).replace(/[€$£]|\b(?:EUR|USD|GBP)\b/gi, '').trim();
  return { title, url: httpUrl(b.url), price, currency, image: httpUrl(b.image), note: str(b.note, 1000) };
}
// ---------- groups ----------
const MAX_MEMBERS = 100, MAX_GROUPS_PER_LIST = 50;
// Access key for a protected group: changes automatically when the password changes.
const groupKey = (g) => crypto.createHmac('sha256', g.pw_hash).update(g.id).digest('base64url');
const groupUnlocked = (req, g) => !g.pw_hash || safeEqual(String(req.headers['x-group-key'] || ''), groupKey(g));
const publicGroup = (g) => ({ id: g.id, title: g.title, description: g.description, protected: !!g.pw_hash });
const groupMembers = (gid) => q.groupMembers.all(gid).map((l) => ({ id: l.id, title: l.title, owner: l.owner_name, items: l.items }));
// Add a list (proved by its edit token) to a group. Returns an error message or null.
function joinWith(group, editToken) {
  const list = editToken && q.listByEdit.get(editToken);
  if (!list || !safeEqual(list.edit_token, editToken)) return [404, 'Lijst niet gevonden. Klopt de beheerlink?'];
  if (q.isMember.get(group.id, list.id)) return null;
  if (q.countMembers.get(group.id).n >= MAX_MEMBERS) return [400, `Een groep kan maximaal ${MAX_MEMBERS} lijsten hebben.`];
  if (q.countGroupsOf.get(list.id).n >= MAX_GROUPS_PER_LIST) return [400, `Een lijst kan in maximaal ${MAX_GROUPS_PER_LIST} groepen zitten.`];
  q.joinGroup.run(group.id, list.id, now());
  return null;
}
const editTokenFrom = (v) => { const s = str(v, 300); const m = s.match(/\/beheer\/([A-Za-z0-9_-]+)/); return m ? m[1] : s; };

const publicList = (l) => ({ id: l.id, title: l.title, owner: l.owner_name, description: l.description });

async function api(req, res, parts) {
  const m = req.method;
  // POST /api/lists
  if (parts[1] === 'lists' && parts.length === 2 && m === 'POST') {
    if (limited('create:' + clientIp(req), 20, 3600e3)) return fail(res, 429, 'Te veel lijsten aangemaakt, probeer het later opnieuw.');
    const b = await readBody(req);
    const title = str(b.title, 120);
    if (!title) return fail(res, 400, 'Geef je lijst een naam.');
    const id = token(9), edit = token(24);
    q.insertList.run(id, edit, title, str(b.owner, 80), str(b.description, 1000), now());
    const u = users.userFromReq(req);
    if (u) db.prepare('UPDATE lists SET user_id = ? WHERE id = ?').run(u.id, id);
    return json(res, 201, { id, edit });
  }

  // owner routes: /api/edit/:token/...
  if (parts[1] === 'edit' && parts[2]) {
    const list = q.listByEdit.get(parts[2]);
    if (!list || !safeEqual(list.edit_token, parts[2])) return fail(res, 404, 'Lijst niet gevonden.');
    const sub = parts[3];
    if (!sub) {
      if (m === 'GET') return json(res, 200, { list: publicList(list), items: q.items.all(list.id), groups: q.groupsOfList.all(list.id) }); // no claim info: keep it a surprise
      if (m === 'PUT') {
        const b = await readBody(req);
        const title = str(b.title, 120);
        if (!title) return fail(res, 400, 'Geef je lijst een naam.');
        q.updateList.run(title, str(b.owner, 80), str(b.description, 1000), list.id);
        return json(res, 200, { ok: true });
      }
      if (m === 'DELETE') { q.deleteList.run(list.id); return json(res, 200, { ok: true }); }
    }
    if (sub === 'groups' && parts[4] && !parts[5] && m === 'DELETE') { // leave a group from the list's own beheer page
      q.leaveGroup.run(parts[4], list.id);
      return json(res, 200, { ok: true });
    }
    if (sub === 'fetch' && m === 'POST') {
      if (limited('fetch:' + clientIp(req), 60, 600e3)) return fail(res, 429, 'Even rustig aan, probeer het zo opnieuw.');
      const b = await readBody(req);
      const url = httpUrl(b.url);
      if (!url) return fail(res, 400, 'Ongeldige link.');
      try { return json(res, 200, await fetchProduct(url)); }
      catch (e) { return fail(res, 422, 'Kon de productinformatie niet ophalen (' + e.message + '). Vul het zelf in.'); }
    }
    if (sub === 'items' && !parts[4] && m === 'POST') {
      if (q.countItems.get(list.id).n >= 300) return fail(res, 400, 'Maximaal 300 wensen per lijst.');
      const f = itemFields(await readBody(req));
      if (!f.title) return fail(res, 400, 'Geef je wens een naam.');
      const r = q.insertItem.run(list.id, f.title, f.url, f.price, f.currency, f.image, f.note, q.maxPos.get(list.id).p + 1, now());
      return json(res, 201, { id: Number(r.lastInsertRowid) });
    }
    if (sub === 'items' && parts[4]) {
      const id = Number(parts[4]);
      if (!q.item.get(id, list.id)) return fail(res, 404, 'Wens niet gevonden.');
      if (parts[5] === 'move' && m === 'POST') {
        const { dir } = await readBody(req);
        const items = q.items.all(list.id);
        const i = items.findIndex((x) => x.id === id), j = i + (dir === 'up' ? -1 : 1);
        if (j >= 0 && j < items.length) {
          [items[i], items[j]] = [items[j], items[i]];
          db.exec('BEGIN'); items.forEach((x, k) => q.setPos.run(k + 1, x.id, list.id)); db.exec('COMMIT');
        }
        return json(res, 200, { ok: true });
      }
      if (!parts[5] && m === 'PUT') {
        const f = itemFields(await readBody(req));
        if (!f.title) return fail(res, 400, 'Geef je wens een naam.');
        q.updateItem.run(f.title, f.url, f.price, f.currency, f.image, f.note, id, list.id);
        return json(res, 200, { ok: true });
      }
      if (!parts[5] && m === 'DELETE') { q.deleteItem.run(id, list.id); return json(res, 200, { ok: true }); }
    }
    return fail(res, 404, 'Niet gevonden.');
  }

  // POST /api/groups {title, description, password?, list?: editToken}
  if (parts[1] === 'groups' && parts.length === 2 && m === 'POST') {
    if (limited('gcreate:' + clientIp(req), 20, 3600e3)) return fail(res, 429, 'Te veel groepen aangemaakt, probeer het later opnieuw.');
    const b = await readBody(req);
    const title = str(b.title, 120);
    if (!title) return fail(res, 400, 'Geef je groep een naam.');
    const pw = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
    const id = token(9), edit = token(24);
    const pwHash = pw ? hashPw(pw) : '';
    q.insertGroup.run(id, edit, title, str(b.description, 1000), pwHash, now());
    const u = users.userFromReq(req);
    if (u) db.prepare('UPDATE groups SET user_id = ? WHERE id = ?').run(u.id, id);
    const g = q.groupById.get(id);
    if (b.list) { const err = joinWith(g, editTokenFrom(b.list)); if (err) return fail(res, ...err); }
    return json(res, 201, { id, edit, key: pwHash ? groupKey(g) : '' });
  }

  // group owner routes: /api/group-edit/:token/...
  if (parts[1] === 'group-edit' && parts[2]) {
    const g = q.groupByEdit.get(parts[2]);
    if (!g || !safeEqual(g.edit_token, parts[2])) return fail(res, 404, 'Groep niet gevonden.');
    if (!parts[3]) {
      if (m === 'GET') return json(res, 200, { group: publicGroup(g), lists: groupMembers(g.id), key: g.pw_hash ? groupKey(g) : '' });
      if (m === 'PUT') {
        const b = await readBody(req);
        const title = str(b.title, 120);
        if (!title) return fail(res, 400, 'Geef je groep een naam.');
        q.updateGroup.run(title, str(b.description, 1000), g.id);
        return json(res, 200, { ok: true });
      }
      if (m === 'DELETE') { q.deleteGroup.run(g.id); return json(res, 200, { ok: true }); }
    }
    if (parts[3] === 'password' && !parts[4] && m === 'PUT') {
      const b = await readBody(req);
      const pw = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
      const pwHash = pw ? hashPw(pw) : '';
      q.setGroupPw.run(pwHash, g.id);
      return json(res, 200, { ok: true, key: pwHash ? groupKey({ id: g.id, pw_hash: pwHash }) : '' });
    }
    if (parts[3] === 'lists' && parts[4] && !parts[5] && m === 'DELETE') {
      q.leaveGroup.run(g.id, parts[4]);
      return json(res, 200, { ok: true });
    }
    return fail(res, 404, 'Niet gevonden.');
  }

  // public group routes: /api/group/:id/...
  if (parts[1] === 'group' && parts[2]) {
    const g = q.groupById.get(parts[2]);
    if (!g) return fail(res, 404, 'Groep niet gevonden.');
    if (parts[3] === 'unlock' && !parts[4] && m === 'POST') {
      if (limited(`unlock:${clientIp(req)}:${g.id}`, 10, 900e3)) return fail(res, 429, 'Te veel pogingen. Probeer het over een kwartier opnieuw.');
      const b = await readBody(req);
      if (!g.pw_hash) return json(res, 200, { key: '' });
      if (!checkPw(typeof b.password === 'string' ? b.password.slice(0, 200) : '', g.pw_hash)) return fail(res, 403, 'Onjuist wachtwoord.');
      return json(res, 200, { key: groupKey(g) });
    }
    if (!groupUnlocked(req, g)) return json(res, 401, { error: 'Deze groep is beveiligd met een wachtwoord.', locked: true, title: g.title });
    if (!parts[3] && m === 'GET') return json(res, 200, { group: publicGroup(g), lists: groupMembers(g.id) });
    if ((parts[3] === 'join' || parts[3] === 'leave') && !parts[4] && m === 'POST') {
      if (limited('join:' + clientIp(req), 60, 3600e3)) return fail(res, 429, 'Even rustig aan.');
      const b = await readBody(req);
      if (parts[3] === 'join') {
        const err = joinWith(g, editTokenFrom(b.edit));
        return err ? fail(res, ...err) : json(res, 200, { ok: true });
      }
      const t = editTokenFrom(b.edit);
      const list = t && q.listByEdit.get(t);
      if (!list || !safeEqual(list.edit_token, t)) return fail(res, 404, 'Lijst niet gevonden.');
      q.leaveGroup.run(g.id, list.id);
      return json(res, 200, { ok: true });
    }
    return fail(res, 404, 'Niet gevonden.');
  }

  // guest routes: /api/list/:id/...
  if (parts[1] === 'list' && parts[2]) {
    const list = q.listById.get(parts[2]);
    if (!list) return fail(res, 404, 'Lijst niet gevonden.');
    const mine = new Set(String(req.headers['x-claim-tokens'] || '').split(',').filter(Boolean).slice(0, 500));
    if (!parts[3] && m === 'GET') {
      const items = q.itemsWithClaims.all(list.id).map((r) => ({
        id: r.id, title: r.title, url: r.url, price: r.price, currency: r.currency, image: r.image, note: r.note,
        claimed: !!r.claim_name, claimedBy: r.claim_name || '', mine: !!r.claim_token && mine.has(r.claim_token),
      }));
      return json(res, 200, { list: publicList(list), items });
    }
    if (parts[3] === 'items' && parts[4] && (parts[5] === 'claim' || parts[5] === 'unclaim') && m === 'POST') {
      const id = Number(parts[4]);
      if (!q.item.get(id, list.id)) return fail(res, 404, 'Wens niet gevonden.');
      const b = await readBody(req);
      if (parts[5] === 'claim') {
        if (limited('claim:' + clientIp(req), 100, 3600e3)) return fail(res, 429, 'Even rustig aan.');
        const name = str(b.name, 60);
        if (!name) return fail(res, 400, 'Vul je naam in.');
        if (q.claim.get(id)) return fail(res, 409, 'Iemand anders heeft dit cadeau net afgestreept.');
        const t = token(18);
        q.insertClaim.run(id, name, t, now());
        return json(res, 200, { token: t });
      }
      const c = q.claim.get(id);
      if (!c) return json(res, 200, { ok: true });
      if (!safeEqual(c.claim_token, str(b.token, 100))) return fail(res, 403, 'Alleen degene die dit heeft afgestreept kan het terugzetten.');
      q.deleteClaim.run(id);
      return json(res, 200, { ok: true });
    }
    return fail(res, 404, 'Niet gevonden.');
  }
  return fail(res, 404, 'Niet gevonden.');
}

const auth = createAuth({ ORIGIN, token, now });
const mailer = require('./mailer').createMailer({ db, env: process.env });
const deps = { db, auth, mailer, ORIGIN, json, fail, readBody, limited, clientIp, token, str, now };
const users = require('./user-api')(deps);
const adminApi = require('./admin-api')({ ...deps, users });

// ---------- pages & static ----------
const MIME = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
// Cache busting: browsers may cache /app.js etc. for a few minutes, so after a deploy they could
// run old code against new HTML. Append a content hash to every local script/stylesheet URL.
const ASSET_VERSION = crypto.createHash('sha256')
  .update(fs.readdirSync(PUBLIC_DIR).filter((f) => /\.(js|css)$/.test(f)).sort().map((f) => fs.readFileSync(path.join(PUBLIC_DIR, f))).join('\0'))
  .digest('hex').slice(0, 10);
const versioned = (html) => html.replace(/(src|href)="(\/[\w.-]+\.(?:js|css))"/g, `$1="$2?v=${ASSET_VERSION}"`);
const shell = versioned(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'));
const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Link previews (WhatsApp, Signal, iMessage…) don't run JS, so put the list's name in the HTML itself.
function pageWithMeta(req, parts) {
  const base = ORIGIN || `https://${req.headers.host}`;
  let title = 'Wensenlijst: maak en deel je verlanglijst',
    desc = 'Zet je wensen op een lijst en deel hem met één link. Familie en vrienden strepen af wat ze kopen, en jij ziet niet wat er gekocht is. Geen account nodig.',
    pageUrl = base + '/';
  if (parts[0] === 'l') {
    const list = q.listById.get(parts[1]);
    if (list) {
      const n = q.countItems.get(list.id).n;
      title = list.title;
      desc = `${list.owner_name ? `Verlanglijst van ${list.owner_name}` : 'Verlanglijst'} · ${n} ${n === 1 ? 'wens' : 'wensen'}. Bekijk de lijst en streep af wat je koopt.`;
      pageUrl = `${base}/l/${list.id}`;
    }
  } else if (parts[0] === 'g') {
    const g = q.groupById.get(parts[1]);
    if (g) {
      const n = q.countMembers.get(g.id).n;
      title = g.title;
      desc = g.pw_hash ? 'Groep met verlanglijsten · Beveiligd met een wachtwoord.'
        : `Groep met ${n} ${n === 1 ? 'verlanglijst' : 'verlanglijsten'} · Bekijk de lijsten en voeg je eigen lijst toe.`;
      pageUrl = `${base}/g/${g.id}`;
    }
  } else if (parts[0] === 'faq') {
    title = 'Veelgestelde vragen · Wensenlijst';
    desc = 'Antwoorden op veelgestelde vragen over Wensenlijst: lijsten maken en delen, afstrepen, groepen, accounts en privacy.';
    pageUrl = `${base}/faq`;
  } else if (parts[0] === 'account') {
    title = 'Account · Wensenlijst'; desc = ''; pageUrl = '';
  } else if (parts[0] === 'groep') {
    title = 'Groep beheren · Wensenlijst'; desc = ''; pageUrl = '';
  } else if (parts[0] === 'beheer') {
    title = 'Lijst beheren · Wensenlijst'; desc = ''; pageUrl = ''; // never advertise edit pages
  }
  const meta = [
    `<title>${escHtml(title)}</title>`,
    desc && `<meta name="description" content="${escHtml(desc)}">`,
    `<meta property="og:site_name" content="Wensenlijst">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escHtml(title)}">`,
    desc && `<meta property="og:description" content="${escHtml(desc)}">`,
    pageUrl && `<meta property="og:url" content="${escHtml(pageUrl)}">`,
    `<meta property="og:image" content="${escHtml(base)}/og.png">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ].filter(Boolean).join('\n  ');
  return shell.replace('<title>Wensenlijst</title>', meta);
}
const adminShell = versioned(fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html'), 'utf8'));
function serveStatic(res, p) {
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
  let st; try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300', ...SEC_HEADERS });
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'api') {
      if (req.method !== 'GET') {
        const o = req.headers.origin;
        if (ORIGIN && o && o !== ORIGIN) return fail(res, 403, 'Verkeerde origin.');
        if (!String(req.headers['content-type'] || '').startsWith('application/json') && req.method !== 'DELETE') return fail(res, 415, 'JSON verwacht.');
      }
      if (parts[1] === 'admin') return await adminApi(req, res, parts);
      if (parts[1] === 'account') return await users.api(req, res, parts);
      return await api(req, res, parts);
    }
    if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (['GET', 'HEAD'].includes(req.method) && url.pathname === '/admin') return send(res, 200, adminShell, 'text/html; charset=utf-8');
    if (['GET', 'HEAD'].includes(req.method) && (url.pathname === '/' || url.pathname === '/account' || url.pathname === '/faq' || (parts[0] === 'account' && parts[1] === 'herstel' && parts.length === 3) || ['l', 'beheer', 'g', 'groep'].includes(parts[0]) && parts.length === 2))
      return send(res, 200, pageWithMeta(req, parts), 'text/html; charset=utf-8');
    if (['GET', 'HEAD'].includes(req.method) && serveStatic(res, url.pathname)) return;
    send(res, 404, shell, 'text/html; charset=utf-8');
  } catch (e) {
    if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : 'Er ging iets mis.');
    if (!e.status) console.error(e);
  }
});
server.listen(PORT, () => console.log(`Wensenlijst listening on :${PORT} (db: ${DB_PATH})`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
