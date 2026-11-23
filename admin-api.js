'use strict';
// Admin area. There is no separate admin login: admins are normal user accounts (see user-api.js)
// with users.is_admin = 1. Log in on /account, then /admin works.
const crypto = require('node:crypto');
const I18N = require('./public/i18n-dict.js');

module.exports = function createAdmin({ db, users, mailer, json, fail, readBody, limited, clientIp, str, now }) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'is_admin'").get())
    db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  migrateLegacyAdmin(db, now);

  const q = {
    adminCount: db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1'),
    setAdmin: db.prepare('UPDATE users SET is_admin = ? WHERE id = ?'),
    users: db.prepare(`SELECT u.id, u.username, u.email, u.is_admin, u.created_at, u.pw_hash != '' AS has_pw,
                         (SELECT COUNT(*) FROM user_credentials c WHERE c.user_id = u.id) AS passkeys,
                         (SELECT COUNT(*) FROM lists l WHERE l.user_id = u.id) AS lists
                       FROM users u ORDER BY u.created_at`),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    lists: db.prepare(`SELECT l.id, l.edit_token, l.title, l.owner_name, l.created_at, u.username,
                         (SELECT COUNT(*) FROM items i WHERE i.list_id = l.id) AS items,
                         (SELECT COUNT(*) FROM items i JOIN claims c ON c.item_id = i.id WHERE i.list_id = l.id) AS claimed
                       FROM lists l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.created_at DESC`),
    deleteList: db.prepare('DELETE FROM lists WHERE id = ?'),
    groups: db.prepare(`SELECT g.id, g.edit_token, g.title, g.pw_hash != '' AS protected, g.created_at,
                          (SELECT COUNT(*) FROM group_lists gl WHERE gl.group_id = g.id) AS members
                        FROM groups g ORDER BY g.created_at DESC`),
    deleteGroup: db.prepare('DELETE FROM groups WHERE id = ?'),
  };

  // One-time setup code: only while no admin exists. Printed to the container log so a random
  // visitor can't make themselves admin before the owner does.
  let setupCode = null;
  function refreshSetupCode() {
    if (q.adminCount.get().n === 0) {
      if (!setupCode) {
        setupCode = crypto.randomInt(0, 1e8).toString().padStart(8, '0');
        console.log(`[admin] Nog geen beheerder. Log in op /account en vul op /admin deze eenmalige setupcode in: ${setupCode}`);
      }
    } else setupCode = null;
  }
  refreshSetupCode();

  return async function adminApi(req, res, parts) {
    const m = req.method, sub = parts.slice(2).join('/');
    const user = users.userFromReq(req);
    const isAdmin = !!(user && user.is_admin);
    refreshSetupCode();

    if (sub === 'status' && m === 'GET')
      return json(res, 200, { loggedIn: !!user, username: user ? user.username : '', isAdmin, needsSetup: q.adminCount.get().n === 0 });

    // First admin: a logged-in user proves ownership of the server with the setup code from the log.
    if (sub === 'setup' && m === 'POST') {
      if (!user) return fail(res, 401, 'Log eerst in.');
      if (!setupCode) return fail(res, 403, 'Er is al een beheerder.');
      if (limited('setup:' + clientIp(req), 10, 3600e3)) return fail(res, 429, 'Te veel pogingen.');
      const b = await readBody(req);
      if (str(b.setupCode, 20) !== setupCode) return fail(res, 403, 'Onjuiste setupcode.');
      q.setAdmin.run(1, user.id);
      setupCode = null;
      return json(res, 200, { ok: true });
    }

    // --- everything below requires an admin ---
    if (!user) return fail(res, 401, 'Niet ingelogd.');
    if (!isAdmin) return fail(res, 403, 'Je account is geen beheerder.');

    if (sub === 'lists' && m === 'GET') {
      return json(res, 200, q.lists.all().map((l) => ({
        id: l.id, edit: l.edit_token, title: l.title, owner: l.owner_name, account: l.username || '', createdAt: l.created_at, items: l.items, claimed: l.claimed,
      })));
    }
    if (parts[2] === 'lists' && parts[3] && !parts[4] && m === 'DELETE') {
      q.deleteList.run(parts[3]);
      return json(res, 200, { ok: true });
    }
    if (sub === 'groups' && m === 'GET') {
      return json(res, 200, q.groups.all().map((g) => ({
        id: g.id, edit: g.edit_token, title: g.title, protected: !!g.protected, createdAt: g.created_at, members: g.members,
      })));
    }
    if (parts[2] === 'groups' && parts[3] && !parts[4] && m === 'DELETE') {
      q.deleteGroup.run(parts[3]);
      return json(res, 200, { ok: true });
    }

    // --- user accounts ---
    if (sub === 'users' && m === 'GET') {
      return json(res, 200, q.users.all().map((u) => ({
        id: u.id, username: u.username, email: u.email, admin: !!u.is_admin, createdAt: u.created_at,
        hasPassword: !!u.has_pw, passkeys: u.passkeys, lists: u.lists, me: u.id === user.id,
      })));
    }
    if (parts[2] === 'users' && parts[3] && parts[4] === 'admin' && m === 'PUT') {
      const target = q.user.get(parts[3]);
      if (!target) return fail(res, 404, 'Gebruiker niet gevonden.');
      const b = await readBody(req);
      if (!b.admin && target.is_admin && q.adminCount.get().n <= 1) return fail(res, 400, 'Er moet minstens één beheerder overblijven.');
      q.setAdmin.run(b.admin ? 1 : 0, target.id);
      return json(res, 200, { ok: true });
    }
    if (parts[2] === 'users' && parts[3] && !parts[4] && m === 'DELETE') {
      const target = q.user.get(parts[3]);
      if (!target) return fail(res, 404, 'Gebruiker niet gevonden.');
      if (target.id === user.id) return fail(res, 400, 'Je kunt je eigen account hier niet verwijderen.');
      q.deleteUser.run(target.id); // lists/groups stay (user_id SET NULL)
      return json(res, 200, { ok: true });
    }

    // --- e-mail (SMTP) settings: env defaults, overridable here ---
    if (sub === 'mail' && m === 'GET') return json(res, 200, mailer.publicConfig());
    if (sub === 'mail' && m === 'PUT') {
      try { mailer.save(await readBody(req)); } catch (e) { return fail(res, 400, e.message); }
      return json(res, 200, mailer.publicConfig());
    }
    if (sub === 'mail' && m === 'DELETE') { mailer.reset(); return json(res, 200, mailer.publicConfig()); }
    if (sub === 'mail/test' && m === 'POST') {
      const b = await readBody(req);
      const to = str(b.to, 200);
      if (!/^[^@\s<>]+@[^@\s<>]+$/.test(to)) return fail(res, 400, 'Ongeldig e-mailadres.');
      try {
        const L = I18N.normalize(String(req.headers['x-lang'] || ''));
        await mailer.send({ to, subject: I18N.t(L, 'Testmail van Wensenlijst'), text: I18N.t(L, 'Het werkt! Deze testmail is verstuurd vanaf de beheerpagina van Wensenlijst.') });
      } catch (e) { return fail(res, 502, e.message); }
      return json(res, 200, { ok: true });
    }
    return fail(res, 404, 'Niet gevonden.');
  };
};

// Before 2026-11-22 the admin had its own login (admin_password + admin_credentials). Turn that
// into a normal user account with is_admin = 1, keeping the password hash and passkeys (same
// rpId, so they keep working). Runs once; the old tables are renamed to *_legacy as a backup.
function migrateLegacyAdmin(db, now) {
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  if (!has('admin_credentials') && !has('admin_password')) return;
  const pw = has('admin_password') ? db.prepare('SELECT * FROM admin_password WHERE id = 1').get() : null;
  const creds = has('admin_credentials') ? db.prepare('SELECT * FROM admin_credentials').all() : [];
  db.exec('BEGIN');
  try {
    if (pw || creds.length) {
      let name = (pw && /^[A-Za-z0-9._-]{3,40}$/.test(pw.username) ? pw.username : 'beheer');
      const taken = (n) => !!db.prepare('SELECT 1 FROM users WHERE username = ?').get(n);
      for (let i = 2; taken(name); i++) name = `${name.replace(/-\d+$/, '')}-${i}`;
      const id = crypto.randomBytes(12).toString('base64url');
      db.prepare('INSERT INTO users (id, username, pw_hash, created_at, is_admin) VALUES (?, ?, ?, ?, 1)').run(id, name, pw ? pw.pw_hash : '', now());
      const ins = db.prepare('INSERT OR IGNORE INTO user_credentials (id, user_id, public_key, alg, sign_count, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const c of creds) ins.run(c.id, id, c.public_key, c.alg, c.sign_count, c.label, c.created_at);
      console.log(`[admin] Oude beheerderslogin omgezet naar gebruiker "${name}" (beheerder, ${creds.length} passkey(s)${pw ? ', wachtwoord' : ''}).`);
    }
    for (const t of ['admin_credentials', 'admin_password']) if (has(t)) db.exec(`ALTER TABLE ${t} RENAME TO ${t}_legacy`);
    if (has('admin_sessions')) db.exec('DROP TABLE admin_sessions');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
