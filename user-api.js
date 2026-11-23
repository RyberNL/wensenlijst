'use strict';
// Optional user accounts: username + password and/or passkeys. An account simply remembers which
// lists and groups (and thus their edit tokens) belong to someone, so they can manage them from
// any device. Everything keeps working without an account.
const crypto = require('node:crypto');
const { hashPw, checkPw, DUMMY_HASH, pwInput, sha256 } = require('./auth-lib');
const I18N = require('./public/i18n-dict.js');
const langOf = (req) => I18N.normalize(String(req.headers['x-lang'] || '').slice(0, 5));

const SESSION_DAYS = 90;
const USERNAME_RE = /^[A-Za-z0-9._-]{3,40}$/;
const EMAIL_RE = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;
const RESET_MINUTES = 60;
const PAIR_MINUTES = 10;

module.exports = function createUsers({ db, auth, mailer, ORIGIN, json, fail, readBody, limited, clientIp, token, str, now }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pw_hash    TEXT NOT NULL DEFAULT '',     -- '' = passkey-only account
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_credentials (
      id          TEXT PRIMARY KEY,           -- credential id (base64url)
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      public_key  TEXT NOT NULL,
      alg         INTEGER NOT NULL,
      sign_count  INTEGER NOT NULL DEFAULT 0,
      label       TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS user_credentials_user ON user_credentials(user_id);
    CREATE TABLE IF NOT EXISTS user_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_resets (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
  `);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'email'").get())
    db.exec("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''");
  for (const t of ['lists', 'groups']) {
    if (!db.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name = 'user_id'`).get())
      db.exec(`ALTER TABLE ${t} ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
               CREATE INDEX IF NOT EXISTS ${t}_user ON ${t}(user_id);`);
  }
  const q = {
    insertUser: db.prepare('INSERT INTO users (id, username, pw_hash, created_at) VALUES (?, ?, ?, ?)'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    setPw: db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    creds: db.prepare('SELECT id, label, created_at FROM user_credentials WHERE user_id = ? ORDER BY created_at'),
    credCount: db.prepare('SELECT COUNT(*) AS n FROM user_credentials WHERE user_id = ?'),
    cred: db.prepare('SELECT * FROM user_credentials WHERE id = ?'),
    insertCred: db.prepare('INSERT INTO user_credentials (id, user_id, public_key, alg, label, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    deleteCred: db.prepare('DELETE FROM user_credentials WHERE id = ? AND user_id = ?'),
    setCount: db.prepare('UPDATE user_credentials SET sign_count = ? WHERE id = ?'),
    setEmail: db.prepare('UPDATE users SET email = ? WHERE id = ?'),
    usersByEmail: db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE AND email != '' LIMIT 5"),
    insertReset: db.prepare('INSERT INTO user_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    reset: db.prepare('SELECT * FROM user_resets WHERE token_hash = ? AND expires_at > ?'),
    clearResets: db.prepare('DELETE FROM user_resets WHERE user_id = ? OR expires_at <= ?'),
    clearSessions: db.prepare('DELETE FROM user_sessions WHERE user_id = ?'),
    clearOtherSessions: db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND token_hash != ?'),
    countSessions: db.prepare('SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = ? AND expires_at > ?'),
    lists: db.prepare('SELECT id, edit_token AS edit, title FROM lists WHERE user_id = ? ORDER BY created_at DESC'),
    groups: db.prepare('SELECT id, edit_token AS edit, title FROM groups WHERE user_id = ? ORDER BY created_at DESC'),
    claimList: db.prepare('UPDATE lists SET user_id = ? WHERE edit_token = ? AND user_id IS NULL'),
    claimGroup: db.prepare('UPDATE groups SET user_id = ? WHERE edit_token = ? AND user_id IS NULL'),
    unlinkList: db.prepare('UPDATE lists SET user_id = NULL WHERE edit_token = ? AND user_id = ?'),
    unlinkGroup: db.prepare('UPDATE groups SET user_id = NULL WHERE edit_token = ? AND user_id = ?'),
  };
  const session = auth.sessions(db, { table: 'user_sessions', cookie: 'wl_user', days: SESSION_DAYS, withUser: true });
  // "Recently logged in": the session was created less than 15 minutes ago. Used to protect
  // sensitive changes for accounts without a password (passkey-only) that can't re-enter one.
  const RECENT_MS = 15 * 60e3;
  const recentLogin = (req) => { const s = session.get(req); return !!s && now() - (s.expires_at - SESSION_DAYS * 864e5) < RECENT_MS; };
  // Sensitive changes need the current password, or (passkey-only accounts) a fresh login.
  function reauth(req, user, current) {
    if (user.pw_hash) {
      if (limited('upw:' + user.id, 10, 900e3)) return [429, 'Te veel pogingen.'];
      if (!checkPw(pwInput(current), user.pw_hash)) return [403, 'Huidig wachtwoord klopt niet.'];
      return null;
    }
    return recentLogin(req) ? null : [403, 'Log voor de zekerheid opnieuw in (met je passkey) en probeer het daarna nog eens.'];
  }
  function userFromReq(req) {
    const s = session.get(req);
    return s ? q.userById.get(s.user_id) || null : null;
  }
  function validUsername(name) {
    if (!USERNAME_RE.test(name)) return 'Gebruikersnaam: 3 tot 40 tekens (letters, cijfers, . _ -).';
    if (q.userByName.get(name)) return 'Deze gebruikersnaam is al bezet.';
    return null;
  }
  const validPassword = (pw) => (pw.length < 8 ? 'Kies een wachtwoord van minstens 8 tekens.' : null);
  const me = (u) => ({
    user: { username: u.username, email: u.email, hasPassword: !!u.pw_hash, passkeys: q.credCount.get(u.id).n, isAdmin: !!u.is_admin },
    lists: q.lists.all(u.id), groups: q.groups.all(u.id), mailEnabled: mailer.enabled(),
  });
  // Koppelcode: a logged-in device creates a short-lived one-time code that logs in another device
  // as the same user. For computers that can't reach the phone's passkey (no Bluetooth).
  const pairs = new Map(); // code -> { userId, expires }
  let pairFails = 0;
  const purgePairs = () => { for (const [c, p] of pairs) if (p.expires < now()) pairs.delete(c); };

  const siteUrl = (req) => ORIGIN || `https://${req.headers.host}`;
  async function sendReset(req, u) {
    q.clearResets.run(u.id, now()); // one valid link at a time
    const t = token(32);
    q.insertReset.run(sha256(t).toString('hex'), u.id, now() + RESET_MINUTES * 60e3);
    const link = `${siteUrl(req)}/account/herstel/${t}`;
    const L = langOf(req);
    await mailer.send({
      to: u.email,
      subject: I18N.t(L, 'Wachtwoord herstellen · Wensenlijst'),
      text: I18N.t(L, 'Hoi {0},\n\nJe (of iemand anders) heeft gevraagd om het wachtwoord van je Wensenlijst-account te herstellen. Kies via deze link een nieuw wachtwoord:\n\n{1}\n\nDe link werkt {2} minuten en maar één keer. Heb je dit niet aangevraagd? Dan kun je deze mail negeren; er verandert niets.\n\nWensenlijst', u.username, link, RESET_MINUTES),
    });
  }
  const tokens = (v) => (Array.isArray(v) ? v.filter((t) => typeof t === 'string' && t.length <= 100).slice(0, 200) : []);

  async function api(req, res, parts) {
    const m = req.method, sub = parts.slice(2).join('/');
    const user = userFromReq(req);

    if (sub === 'me' && m === 'GET') return json(res, 200, user ? me(user) : { user: null, lists: [], groups: [], mailEnabled: mailer.enabled() });

    // --- password recovery by e-mail ---
    if (sub === 'reset/request' && m === 'POST') {
      if (limited('reset:' + clientIp(req), 5, 3600e3)) return fail(res, 429, 'Te veel aanvragen, probeer het later opnieuw.');
      if (!mailer.enabled()) return fail(res, 503, 'Wachtwoordherstel per e-mail is niet beschikbaar.');
      const b = await readBody(req);
      const name = str(b.name, 200);
      const found = !name ? [] : name.includes('@') ? q.usersByEmail.all(name) : [q.userByName.get(name)].filter((u) => u && u.email);
      for (const u of found) {
        if (limited('reset-u:' + u.id, 3, 3600e3)) continue;
        // don't await: the response time must not reveal whether an account exists
        sendReset(req, u).catch((e) => console.error('[mail] reset mail failed:', e.message));
      }
      return json(res, 200, { ok: true });
    }
    if (sub === 'reset/confirm' && m === 'POST') {
      if (limited('resetc:' + clientIp(req), 20, 3600e3)) return fail(res, 429, 'Te veel pogingen.');
      const b = await readBody(req);
      const r = q.reset.get(sha256(str(b.token, 100)).toString('hex'), now());
      if (!r) return fail(res, 400, 'Deze herstellink is verlopen of al gebruikt. Vraag een nieuwe aan.');
      const password = pwInput(b.password);
      const err = validPassword(password);
      if (err) return fail(res, 400, err);
      q.setPw.run(hashPw(password), r.user_id);
      q.clearResets.run(r.user_id, now());
      q.clearSessions.run(r.user_id); // log out everywhere else
      session.start(res, r.user_id);
      return json(res, 200, me(q.userById.get(r.user_id)));
    }

    // --- sign up / log in with username + password ---
    if (sub === 'signup' && m === 'POST') {
      if (limited('signup:' + clientIp(req), 10, 3600e3)) return fail(res, 429, 'Te veel accounts aangemaakt, probeer het later opnieuw.');
      const b = await readBody(req);
      const username = str(b.username, 60), password = pwInput(b.password);
      const err = validUsername(username) || validPassword(password);
      if (err) return fail(res, 400, err);
      const id = token(12);
      q.insertUser.run(id, username, hashPw(password), now());
      session.start(res, id);
      return json(res, 201, me(q.userById.get(id)));
    }
    if (sub === 'login' && m === 'POST') {
      const b = await readBody(req);
      const username = str(b.username, 60);
      if (limited('ulogin:' + clientIp(req), 10, 900e3) || limited('ulogin-u:' + username.toLowerCase(), 20, 3600e3))
        return fail(res, 429, 'Te veel pogingen, probeer het later opnieuw.');
      const u = username && q.userByName.get(username);
      const ok = checkPw(pwInput(b.password), u && u.pw_hash ? u.pw_hash : DUMMY_HASH);
      if (!u || !u.pw_hash || !ok) return fail(res, 401, 'Onjuiste gebruikersnaam of wachtwoord.');
      session.start(res, u.id);
      return json(res, 200, me(u));
    }

    // --- passkeys: sign up (new passkey-only account), add to account, log in ---
    if (sub === 'passkey/register/options' && m === 'POST') {
      const b = await readBody(req);
      let data, userId, name;
      if (user) { data = { userId: user.id }; userId = user.id; name = user.username; }
      else {
        if (limited('signup:' + clientIp(req), 10, 3600e3)) return fail(res, 429, 'Te veel accounts aangemaakt, probeer het later opnieuw.');
        name = str(b.username, 60);
        const err = validUsername(name);
        if (err) return fail(res, 400, err);
        userId = token(12);
        data = { newUser: { id: userId, username: name } };
      }
      return json(res, 200, {
        challenge: auth.newChallenge('webauthn.create', data),
        rp: { id: auth.rpId, name: 'Wensenlijst' },
        user: { id: userId, name, displayName: name },
        excludeCredentials: user ? q.creds.all(user.id).map((c) => ({ id: c.id, type: 'public-key' })) : [],
      });
    }
    if (sub === 'passkey/register/verify' && m === 'POST') {
      const b = await readBody(req);
      let r;
      try { r = auth.verifyRegistration(b); } catch (e) { return fail(res, 400, e.message); }
      const d = r.data || {};
      let userId;
      if (d.userId) {
        if (!user || user.id !== d.userId) return fail(res, 403, 'Niet ingelogd.');
        userId = user.id;
      } else if (d.newUser) {
        const err = validUsername(d.newUser.username); // may have been taken meanwhile
        if (err) return fail(res, 400, err);
        q.insertUser.run(d.newUser.id, d.newUser.username, '', now());
        userId = d.newUser.id;
      } else return fail(res, 400, 'Challenge verlopen, probeer opnieuw.');
      if (q.cred.get(r.id)) return fail(res, 400, 'Deze passkey is al geregistreerd.');
      q.insertCred.run(r.id, userId, r.publicKey, r.alg, str(b.label, 60) || 'Passkey', now());
      if (!user) session.start(res, userId);
      return json(res, 200, me(q.userById.get(userId)));
    }
    if (sub === 'passkey/login/options' && m === 'POST') {
      if (limited('pkopt:' + clientIp(req), 60, 600e3)) return fail(res, 429, 'Te veel pogingen, probeer het later opnieuw.');
      return json(res, 200, { challenge: auth.newChallenge('webauthn.get'), rpId: auth.rpId });
    }
    if (sub === 'passkey/login/verify' && m === 'POST') {
      if (limited('ulogin-pk:' + clientIp(req), 30, 3600e3)) return fail(res, 429, 'Te veel pogingen.');
      const b = await readBody(req);
      const cred = q.cred.get(str(b.id, 1024));
      if (!cred) return fail(res, 401, 'Deze passkey hoort bij geen enkel account.');
      try {
        const count = auth.verifyAssertion(b, cred);
        if (count !== null) q.setCount.run(count, cred.id);
      } catch (e) { return fail(res, 401, e.message); }
      session.start(res, cred.user_id);
      return json(res, 200, me(q.userById.get(cred.user_id)));
    }

    if (sub === 'pair/redeem' && m === 'POST') {
      if (limited('pair:' + clientIp(req), 10, 3600e3) || limited('pair-all', 60, 3600e3)) return fail(res, 429, 'Te veel pogingen, probeer het later opnieuw.');
      const b = await readBody(req);
      purgePairs();
      const code = str(b.code, 20).replace(/\D/g, '');
      const p = code.length === 8 && pairs.get(code);
      if (!p) {
        if (++pairFails >= 20) { pairs.clear(); pairFails = 0; } // many wrong guesses: burn all open codes
        return fail(res, 403, 'Onjuiste of verlopen koppelcode.');
      }
      pairs.delete(code); // single use
      const u = q.userById.get(p.userId);
      if (!u) return fail(res, 403, 'Onjuiste of verlopen koppelcode.');
      session.start(res, u.id);
      return json(res, 200, me(u));
    }

    if (sub === 'logout' && m === 'POST') { session.end(req, res); return json(res, 200, { ok: true }); }

    // --- everything below requires a session ---
    if (!user) return fail(res, 401, 'Niet ingelogd.');
    if (sub === 'claim' && m === 'POST') { // attach lists/groups this device knows (by edit token) to the account
      const b = await readBody(req);
      let n = 0;
      for (const t of tokens(b.lists)) n += Number(q.claimList.run(user.id, t).changes);
      for (const t of tokens(b.groups)) n += Number(q.claimGroup.run(user.id, t).changes);
      return json(res, 200, { claimed: n, ...me(user) });
    }
    if (sub === 'unlink' && m === 'POST') { // remove from the account; the list/group itself stays
      const b = await readBody(req);
      if (b.list) q.unlinkList.run(str(b.list, 100), user.id);
      if (b.group) q.unlinkGroup.run(str(b.group, 100), user.id);
      return json(res, 200, me(user));
    }
    if (sub === 'passkeys' && m === 'GET') return json(res, 200, q.creds.all(user.id));
    if (sub === 'pair/create' && m === 'POST') {
      purgePairs();
      for (const [c, p] of pairs) if (p.userId === user.id) pairs.delete(c); // a new code replaces the old one
      let code;
      do code = crypto.randomInt(0, 1e8).toString().padStart(8, '0'); while (pairs.has(code));
      const expires = now() + PAIR_MINUTES * 60e3;
      pairs.set(code, { userId: user.id, expires });
      return json(res, 200, { code, expiresAt: expires });
    }
    if (sub === 'email' && m === 'PUT') {
      const b = await readBody(req);
      const email = str(b.email, 200);
      if (email && !EMAIL_RE.test(email)) return fail(res, 400, 'Ongeldig e-mailadres.');
      if (email.toLowerCase() === (user.email || '').toLowerCase()) return json(res, 200, { ...me(user), mailSent: false });
      const denied = reauth(req, user, b.current);
      if (denied) return fail(res, ...denied);
      q.setEmail.run(email, user.id);
      if (user.email && mailer.enabled()) { // tell the old address, in case this wasn't the owner
        const L = langOf(req);
        mailer.send({ to: user.email, subject: I18N.t(L, 'Je e-mailadres is gewijzigd · Wensenlijst'),
          text: I18N.t(L, 'Hoi {0},\n\nHet e-mailadres van je Wensenlijst-account is zojuist gewijzigd of verwijderd. Deed je dit zelf, dan hoef je niets te doen.\n\nWas jij dit niet? Log dan in, wijzig je wachtwoord en gebruik "Overal anders uitloggen".\n\nWensenlijst', user.username) })
          .catch((e) => console.error('[mail] change notice failed:', e.message));
      }
      let mailSent = false;
      if (email && mailer.enabled() && !limited('emailset:' + user.id, 5, 3600e3)) {
        try {
          const L = langOf(req);
          await mailer.send({ to: email, subject: I18N.t(L, 'E-mailadres ingesteld · Wensenlijst'),
            text: I18N.t(L, 'Hoi {0},\n\nDit e-mailadres is gekoppeld aan je Wensenlijst-account. Ben je je wachtwoord kwijt, dan kun je het hiermee herstellen.\n\nWas jij dit niet? Dan kun je deze mail negeren.\n\nWensenlijst', user.username) });
          mailSent = true;
        } catch (e) { console.error('[mail] confirmation failed:', e.message); }
      }
      return json(res, 200, { ...me(q.userById.get(user.id)), mailSent });
    }
    if (parts[2] === 'passkeys' && parts[3] && !parts[4] && m === 'DELETE') {
      if (q.credCount.get(user.id).n <= 1 && !user.pw_hash) return fail(res, 400, 'Stel eerst een wachtwoord in, anders kun je niet meer inloggen.');
      q.deleteCred.run(parts[3], user.id);
      return json(res, 200, { ok: true });
    }
    if (sub === 'password' && m === 'PUT') {
      const b = await readBody(req);
      const denied = reauth(req, user, b.current);
      if (denied) return fail(res, ...denied);
      const password = pwInput(b.password);
      const err = validPassword(password);
      if (err) return fail(res, 400, err);
      q.setPw.run(hashPw(password), user.id);
      const s = session.get(req);
      if (s) q.clearOtherSessions.run(user.id, s.token_hash); // log out every other device
      return json(res, 200, { ok: true });
    }
    if (sub === 'sessions' && m === 'GET') return json(res, 200, { count: q.countSessions.get(user.id, now()).n });
    if (sub === 'logout-others' && m === 'POST') {
      const s = session.get(req);
      if (s) q.clearOtherSessions.run(user.id, s.token_hash);
      return json(res, 200, { ok: true });
    }
    if (sub === 'delete' && m === 'POST') { // lists and groups stay (user_id SET NULL); their edit links keep working
      q.deleteUser.run(user.id);
      session.end(req, res);
      return json(res, 200, { ok: true });
    }
    return fail(res, 404, 'Niet gevonden.');
  }

  return { api, userFromReq };
};
