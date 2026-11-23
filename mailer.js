'use strict';
// Minimal SMTP client (no dependencies): plain, STARTTLS or implicit TLS, optional AUTH PLAIN/LOGIN.
// Config comes from env (SMTP_*) and can be overridden from /admin (stored in the settings table).
const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const crypto = require('node:crypto');

const SECURE = ['none', 'starttls', 'tls'];

function envConfig(env) {
  return {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT) || 0,
    secure: SECURE.includes(env.SMTP_SECURE) ? env.SMTP_SECURE : 'starttls',
    verifyTls: env.SMTP_TLS_VERIFY !== 'false',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || '',
    fromName: env.SMTP_FROM_NAME || 'Wensenlijst',
  };
}
const defaultPort = (secure) => (secure === 'tls' ? 465 : secure === 'starttls' ? 587 : 25);

// Reads SMTP replies (handles multi-line "250-..." responses).
function replyReader(getSocket) {
  let buf = '', waiters = [], lines = [];
  const onData = (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), text: lines.join('\n') }; lines = [];
        const w = waiters.shift(); if (w) w.resolve(reply);
      }
    }
  };
  const fail = (e) => { for (const w of waiters.splice(0)) w.reject(e); };
  return {
    attach(sock) { sock.on('data', onData); sock.on('error', fail); sock.on('close', () => fail(new Error('Verbinding met mailserver verbroken.'))); },
    detach(sock) { sock.removeListener('data', onData); },
    next() { return new Promise((resolve, reject) => waiters.push({ resolve, reject })); },
    get socket() { return getSocket(); },
  };
}

const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const addr = (s) => String(s).replace(/[\r\n<>]/g, '').trim();
const b64lines = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');

function buildMessage(cfg, { to, subject, text, html }) {
  const domain = (cfg.from.split('@')[1] || 'localhost').trim();
  const boundary = 'b_' + crypto.randomBytes(12).toString('hex');
  const head = [
    `From: ${encodeHeader(cfg.fromName)} <${addr(cfg.from)}>`,
    `To: <${addr(to)}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
  ];
  if (!html) return [...head, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64lines(text)].join('\r\n');
  return [...head, `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64lines(text),
    `--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64lines(html),
    `--${boundary}--`, ''].join('\r\n');
}

async function sendMail(cfg, mail, timeoutMs = 20000) {
  if (!cfg.host || !cfg.from) throw new Error('E-mail is niet ingesteld.');
  const port = cfg.port || defaultPort(cfg.secure);
  const tlsOpts = { servername: net.isIP(cfg.host) ? undefined : cfg.host, rejectUnauthorized: cfg.verifyTls };
  let sock;
  const r = replyReader(() => sock);
  const timer = setTimeout(() => sock && sock.destroy(new Error('Time-out bij de mailserver.')), timeoutMs);
  const write = (line) => sock.write(line + '\r\n');
  async function cmd(line, expect) {
    if (line != null) write(line);
    const rep = await r.next();
    if (!expect.includes(rep.code)) throw new Error(`Mailserver: ${rep.text.split('\n').pop()}`);
    return rep;
  }
  try {
    sock = cfg.secure === 'tls' ? tls.connect({ host: cfg.host, port, ...tlsOpts }) : net.connect({ host: cfg.host, port });
    r.attach(sock);
    await cmd(null, [220]);
    const helo = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
    let ehlo = await cmd(`EHLO ${helo}`, [250]);
    if (cfg.secure === 'starttls') {
      if (!/STARTTLS/i.test(ehlo.text)) throw new Error('Mailserver ondersteunt geen STARTTLS.');
      await cmd('STARTTLS', [220]);
      r.detach(sock);
      sock = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket: sock, ...tlsOpts }, () => resolve(t));
        t.once('error', reject);
      });
      r.attach(sock);
      ehlo = await cmd(`EHLO ${helo}`, [250]);
    }
    if (cfg.user) {
      if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text)) await cmd('AUTH PLAIN ' + Buffer.from(`\0${cfg.user}\0${cfg.pass}`).toString('base64'), [235]);
      else {
        await cmd('AUTH LOGIN', [334]);
        await cmd(Buffer.from(cfg.user).toString('base64'), [334]);
        await cmd(Buffer.from(cfg.pass).toString('base64'), [235]);
      }
    }
    await cmd(`MAIL FROM:<${addr(cfg.from)}>`, [250]);
    await cmd(`RCPT TO:<${addr(mail.to)}>`, [250, 251]);
    await cmd('DATA', [354]);
    const body = buildMessage(cfg, mail).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..'); // dot-stuffing
    await cmd(body + '\r\n.', [250]);
    write('QUIT');
  } finally {
    clearTimeout(timer);
    if (sock) sock.end();
  }
}

function createMailer({ db, env }) {
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const get = db.prepare("SELECT value FROM settings WHERE key = 'smtp'");
  const set = db.prepare("INSERT INTO settings (key, value) VALUES ('smtp', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const del = db.prepare("DELETE FROM settings WHERE key = 'smtp'");
  const base = envConfig(env);
  function config() {
    let over = {};
    try { const row = get.get(); if (row) over = JSON.parse(row.value); } catch { /* ignore */ }
    return { ...base, ...over };
  }
  return {
    config,
    enabled: () => { const c = config(); return !!(c.host && c.from); },
    overridden: () => !!get.get(),
    // Admin view: never return the password itself.
    publicConfig() { const c = config(); const { pass, ...rest } = c; return { ...rest, hasPass: !!pass, source: get.get() ? 'admin' : 'env' }; },
    save(input) {
      const c = config();
      const next = {
        host: String(input.host || '').trim().slice(0, 200),
        port: Math.max(0, Math.min(65535, Number(input.port) || 0)),
        secure: SECURE.includes(input.secure) ? input.secure : 'starttls',
        verifyTls: input.verifyTls !== false,
        user: String(input.user || '').trim().slice(0, 200),
        pass: typeof input.pass === 'string' && input.pass !== '' ? input.pass.slice(0, 500) : c.pass, // '' = keep
        from: String(input.from || '').trim().slice(0, 200),
        fromName: String(input.fromName || '').trim().slice(0, 100) || 'Wensenlijst',
      };
      if (next.from && !/^[^@\s<>]+@[^@\s<>]+$/.test(next.from)) throw new Error('Ongeldig afzenderadres.');
      if (input.clearPass) next.pass = '';
      set.run(JSON.stringify(next));
    },
    reset() { del.run(); },
    send: (mail) => sendMail(config(), mail),
  };
}

module.exports = { createMailer, sendMail };
