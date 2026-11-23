'use strict';
// Shared auth building blocks (no dependencies): scrypt passwords, cookie sessions and WebAuthn
// verification. The browser hands us the credential public key as SPKI DER
// (AuthenticatorAttestationResponse.getPublicKey()), so we never have to parse CBOR.
const crypto = require('node:crypto');

const ALGS = { '-7': 'sha256', '-257': 'sha256', '-8': null }; // ES256, RS256, Ed25519
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const b64 = (s) => Buffer.from(String(s || ''), 'base64url');

function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64url')}$${crypto.scryptSync(String(pw), salt, 32).toString('base64url')}`;
}
function checkPw(pw, stored) {
  const [, salt, hash] = String(stored || '').split('$');
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64url'), 32);
  const want = Buffer.from(hash, 'base64url');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
// Used when a username doesn't exist, so a failed login takes as long as a wrong password.
const DUMMY_HASH = hashPw(crypto.randomBytes(16).toString('hex'));
const pwInput = (v) => (typeof v === 'string' ? v.slice(0, 200) : '');

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function createAuth({ ORIGIN, token, now }) {
  const rp = ORIGIN ? new URL(ORIGIN) : null;
  const rpId = rp ? rp.hostname : 'localhost';
  const rpIdHash = sha256(rpId);
  const cookieAttrs = `Path=/; HttpOnly; SameSite=Strict${rp && rp.protocol === 'https:' ? '; Secure' : ''}`;

  const challenges = new Map(); // challenge -> { type, data, expires }
  const MAX_CHALLENGES = 5000; // bound memory: these are created by unauthenticated requests
  let lastPurge = 0;
  function newChallenge(type, data = null) {
    if (now() - lastPurge > 10e3 || challenges.size >= MAX_CHALLENGES) {
      lastPurge = now();
      for (const [k, v] of challenges) if (v.expires < now()) challenges.delete(k);
    }
    if (challenges.size >= MAX_CHALLENGES) throw Object.assign(new Error('Even te druk, probeer het zo opnieuw.'), { status: 503 });
    const c = token(32);
    challenges.set(c, { type, data, expires: now() + 5 * 60e3 });
    return c;
  }
  // Validates clientDataJSON and consumes its challenge. Returns the challenge's data, throws a message otherwise.
  function checkClientData(clientDataB64, type) {
    let cd;
    try { cd = JSON.parse(b64(clientDataB64).toString('utf8')); } catch { throw new Error('Ongeldige clientData.'); }
    if (cd.type !== type) throw new Error('Verkeerd type.');
    const ch = challenges.get(cd.challenge);
    challenges.delete(cd.challenge);
    if (!ch || ch.type !== type || ch.expires <= now()) throw new Error('Challenge verlopen, probeer opnieuw.');
    if (ORIGIN && cd.origin !== ORIGIN) throw new Error('Verkeerde origin.');
    return ch.data;
  }
  function checkAuthData(authData) {
    if (authData.length < 37 || !authData.subarray(0, 32).equals(rpIdHash)) throw new Error('Verkeerde rpId.');
    const flags = authData[32];
    if (!(flags & 0x01)) throw new Error('Gebruiker niet aanwezig.');
    if (!(flags & 0x04)) throw new Error('Gebruiker niet geverifieerd.');
    return authData.readUInt32BE(33);
  }
  // Registration: returns { id, publicKey (b64url SPKI), alg, data } or throws.
  function verifyRegistration(b) {
    const data = checkClientData(b.clientDataJSON, 'webauthn.create');
    checkAuthData(b64(b.authenticatorData));
    const alg = Number(b.alg);
    if (!(String(alg) in ALGS)) throw new Error('Niet-ondersteund algoritme.');
    const spki = b64(b.publicKey);
    try { crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }); } catch { throw new Error('Ongeldige sleutel.'); }
    const id = typeof b.id === 'string' ? b.id.slice(0, 1024) : '';
    if (!id) throw new Error('Geen credential id.');
    return { id, publicKey: spki.toString('base64url'), alg, data };
  }
  // Assertion: verifies the signature against a stored credential. Returns the new sign count
  // to store (or null when the authenticator doesn't count), throws on failure.
  function verifyAssertion(b, cred) {
    const clientData = b64(b.clientDataJSON);
    checkClientData(b.clientDataJSON, 'webauthn.get');
    const authData = b64(b.authenticatorData);
    const count = checkAuthData(authData);
    const key = crypto.createPublicKey({ key: Buffer.from(cred.public_key, 'base64url'), format: 'der', type: 'spki' });
    if (!crypto.verify(ALGS[String(cred.alg)], Buffer.concat([authData, sha256(clientData)]), key, b64(b.signature)))
      throw new Error('Ongeldige handtekening.');
    if (count === 0 && cred.sign_count === 0) return null;
    if (count <= cred.sign_count) throw new Error('Passkey-teller klopt niet (mogelijk gekloond).');
    return count;
  }

  // Cookie sessions stored hashed in `table` (token_hash, expires_at[, user_id]).
  function sessions(db, { table, cookie, days, withUser = false }) {
    const q = {
      insert: db.prepare(withUser ? `INSERT INTO ${table} (token_hash, user_id, expires_at) VALUES (?, ?, ?)` : `INSERT INTO ${table} (token_hash, expires_at) VALUES (?, ?)`),
      get: db.prepare(`SELECT * FROM ${table} WHERE token_hash = ? AND expires_at > ?`),
      del: db.prepare(`DELETE FROM ${table} WHERE token_hash = ?`),
      purge: db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`),
    };
    const hashOf = (req) => { const t = parseCookies(req)[cookie]; return t ? sha256(t).toString('hex') : null; };
    return {
      get(req) { const h = hashOf(req); return h ? q.get.get(h, now()) || null : null; },
      start(res, userId) {
        q.purge.run(now());
        const t = token(32), h = sha256(t).toString('hex'), exp = now() + days * 864e5;
        if (withUser) q.insert.run(h, userId, exp); else q.insert.run(h, exp);
        res.setHeader('Set-Cookie', `${cookie}=${t}; ${cookieAttrs}; Max-Age=${days * 86400}`);
      },
      end(req, res) {
        const h = hashOf(req);
        if (h) q.del.run(h);
        res.setHeader('Set-Cookie', `${cookie}=; ${cookieAttrs}; Max-Age=0`);
      },
    };
  }

  return { rpId, newChallenge, verifyRegistration, verifyAssertion, sessions };
}

module.exports = { createAuth, hashPw, checkPw, DUMMY_HASH, pwInput, sha256 };
