# 🎁 Wensenlijst

A small, self-hosted wish list app, in the spirit of lijstje.nl. Make a list, share one link, and family and friends tick off what they're buying. **The list owner never sees what has been claimed**, so the surprise stays intact.

No account needed, no ads, no tracking, and **zero npm dependencies**: one Node.js process with the built-in SQLite.

## Features

- **Lists without accounts.** Creating a list gives you a secret *edit link* and a public *share link*.
- **Secret claiming.** Guests click "Ik koop dit" and enter a name. Other givers see it; the owner doesn't. Claims can be undone from the same device.
- **Product auto-fill.** Paste a shop link and the name, price, image and currency are filled in:
  - read from JSON-LD and OpenGraph data;
  - Amazon has its own parser;
  - beslist.nl is used as a fallback.
- **Groups.** One link that bundles the lists of, say, the whole family.
  - Anyone with the link can add their own list, and a list can be in several groups.
  - A group can have an optional password.
- **Optional accounts.** Sign up with a username and password or with a **passkey**, and your lists and groups follow you to every device. Accounts also get:
  - password reset by e-mail;
  - a *koppelcode* (pairing code) to log in on a computer that can't reach your phone's passkey;
  - "log out everywhere else".
- **Admin page.** Admin is a role on a normal account. Admins can manage all lists, groups and accounts, and configure SMTP with a test-mail button.
- **Four languages.** Dutch (default), English, French and German. E-mails are sent in the user's language.
- **Look and feel.**
  - light and dark theme;
  - animations and confetti, which respect *reduce motion*;
  - link previews for WhatsApp and similar apps;
  - a FAQ page.

## Quick start

```sh
docker build -t wensenlijst .
docker run -d --name wensenlijst -p 127.0.0.1:3280:3000 \
  -e ORIGIN=https://wishlist.example.com \
  -v wensenlijst-data:/data \
  wensenlijst
```

Put a reverse proxy with TLS in front of it (Caddy, nginx, Traefik…), for example with this Caddyfile:

```
wishlist.example.com {
  reverse_proxy 127.0.0.1:3280
}
```

There's also an example [`docker-compose.example.yml`](docker-compose.example.yml).

**Without Docker:** you need Node.js 22.13 or newer, for `node:sqlite`.

```sh
ORIGIN=http://localhost:3000 node --disable-warning=ExperimentalWarning server.js
```

### First admin

While no admin exists, the server prints a one-time setup code to its log (`docker logs wensenlijst`). Then:
1. Create an account on `/account`.
2. Open `/admin` and enter the code.
3. From then on you can promote other accounts on the admin page.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `ORIGIN` | *(empty)* | The public URL, e.g. `https://wishlist.example.com`. **Set this in production.** It's used for the cross-site request check, the passkey relying party, links in e-mails and HSTS. |
| `PORT` | `3000` | The HTTP port. |
| `DB_PATH` | `/data/wensen.db` (Docker) | Path to the SQLite database. |
| `SMTP_HOST` / `SMTP_PORT` | — | Mail server. E-mail is optional and only used for password reset and notices. |
| `SMTP_SECURE` | `starttls` | Either `none`, `starttls` or `tls`. |
| `SMTP_TLS_VERIFY` | `true` | Set to `false` for a local relay with a self-signed certificate. |
| `SMTP_USER` / `SMTP_PASS` | — | Optional SMTP login. |
| `SMTP_FROM` / `SMTP_FROM_NAME` | — / `Wensenlijst` | The sender address and name. |

SMTP settings can also be changed on the admin page, which overrides the environment.

**Backups:** everything lives in the one SQLite file. Make a consistent copy while the app is running with:

```sh
sqlite3 wensen.db ".backup backup.db"
```

## Security notes

- **Secret tokens.** Edit links, claim tokens and sessions are random tokens. Sessions and reset tokens are stored only as hashes.
- **Passwords** use scrypt.
- **Passkeys** are verified without dependencies:
  - the public key is SPKI from `getPublicKey()`, so no CBOR parsing is needed;
  - challenge, origin, rpId, user verification and the signature counter are all checked.
- **Browser hardening:**
  - a strict CSP with no inline scripts;
  - `Referrer-Policy: no-referrer`, so edit tokens never leak to shops;
  - SameSite=Strict cookies;
  - an Origin check and a required JSON content type on API writes.
- **Product fetching is SSRF-safe.** Every DNS answer is checked against private and reserved ranges, redirects are re-validated, and responses are size-capped, also after decompression.
- **Rate limits** apply to logins, sign-ups, resets, claims and pairing codes. They use the first `X-Forwarded-For` address, so **only expose the app through your reverse proxy**: bind the port to `127.0.0.1`.
- **Hiding claims is a social feature, not a security boundary.** An owner who really wants to peek can open their own share link in a private window.

## Project layout

```
server.js        HTTP server, lists/items/claims/groups API, product fetching, page shell + link previews
user-api.js      optional accounts: password, passkeys, pairing codes, password reset
admin-api.js     admin endpoints (users with is_admin = 1)
auth-lib.js      shared scrypt / cookie sessions / WebAuthn verification
mailer.js        tiny SMTP client (plain, STARTTLS, TLS; AUTH PLAIN/LOGIN)
public/          frontend: vanilla JS, no build step
  app.js         all user-facing pages
  admin.js       admin page
  i18n-dict.js   translations, [nl, en, fr, de] keyed by the Dutch text (also used server-side for e-mails)
  i18n.js        language menu + automatic translation of fixed UI text
  style.css      theme (light/dark), animations
```

### Adding UI text

The code is written in Dutch, and the Dutch text is the translation key:
- **Fixed texts** are translated automatically when they appear on the page.
- **Texts with variables** use `t('Hoi {0}', name)`.
- **Every new text** needs a row in `public/i18n-dict.js` with its English, French and German version. Without one, it simply stays Dutch.

## License

[MIT](LICENSE). The bundled Fraunces font is licensed under the SIL Open Font License.
