'use strict';
(async () => {
  const app = document.getElementById('app');

  // ---------- tiny helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }
  // replaceChildren() would render null as the text "null"; skip empty slots.
  // The first real render of a page plays the entrance animation; later re-renders (after edits) don't.
  let entered = false;
  const render = (...kids) => {
    if (!entered) {
      entered = true;
      document.body.classList.add('entering');
      setTimeout(() => document.body.classList.remove('entering'), 1400);
    }
    app.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  };
  // Confetti burst from an element (or the top of the screen). Purely decorative.
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function celebrate(from, count = 36) {
    if (reduceMotion()) return;
    const r = from && from.getBoundingClientRect ? from.getBoundingClientRect() : null;
    const x = r ? r.left + r.width / 2 : window.innerWidth / 2, y = r ? r.top + r.height / 2 : window.innerHeight * 0.28;
    const colors = ['#f97316', '#fb923c', '#db2777', '#f472b6', '#facc15', '#22c55e', '#38bdf8'];
    const box = document.createElement('div'); box.className = 'confetti'; box.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < count; i++) {
      const bit = document.createElement('i');
      const angle = Math.random() * Math.PI * 2, dist = 80 + Math.random() * 160;
      const set = (k, v) => bit.style.setProperty(k, v);
      set('--x', x + 'px'); set('--y', y + 'px');
      set('--dx', Math.cos(angle) * dist + 'px'); set('--dy', Math.sin(angle) * dist * 0.8 + 90 + Math.random() * 120 + 'px');
      set('--r', (Math.random() * 720 - 360) + 'deg'); set('--d', 0.9 + Math.random() * 0.7 + 's');
      set('--c', colors[i % colors.length]);
      if (i % 3 === 0) { set('--w', '9px'); set('--h', '9px'); set('--br', '50%'); }
      box.append(bit);
    }
    document.body.append(box);
    setTimeout(() => box.remove(), 1900);
  }
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  async function api(method, url, body, headers = {}) {
    const res = await fetch(url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-Lang': I18N.lang, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Er ging iets mis.'), { status: res.status, data });
    return data;
  }
  let toastTimer;
  function toast(msg, bad) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 3200);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Gekopieerd!'); }
    catch { prompt('Kopieer deze link:', text); }
  }
  const origin = location.origin;
  const shareUrl = (id) => `${origin}/l/${id}`;
  const editUrl = (t) => `${origin}/beheer/${t}`;
  const ownLists = () => store.get('ownLists', []); // [{id, edit, title}]
  function rememberOwn(entry) {
    const prev = ownLists().find((x) => x.edit === entry.edit);
    const all = ownLists().filter((x) => x.edit !== entry.edit);
    all.unshift({ ...entry, acct: (prev && prev.acct) || undefined }); store.set('ownLists', all.slice(0, 50));
  }
  const groupUrl = (id) => `${origin}/g/${id}`;
  const groupEditUrl = (t) => `${origin}/groep/${t}`;
  const ownGroups = () => store.get('ownGroups', []); // [{id, edit, title}]
  function rememberGroup(entry) {
    const prev = ownGroups().find((x) => x.edit === entry.edit);
    const all = ownGroups().filter((x) => x.edit !== entry.edit);
    all.unshift({ ...entry, acct: (prev && prev.acct) || undefined }); store.set('ownGroups', all.slice(0, 50));
  }
  const groupKeys = () => store.get('groupKeys', {}); // groupId -> access key for password-protected groups
  function setGroupKey(id, key) {
    const k = groupKeys();
    if (key) k[id] = key; else delete k[id];
    store.set('groupKeys', k);
  }
  const groupApi = (method, id, sub, body) =>
    api(method, `/api/group/${encodeURIComponent(id)}${sub ? '/' + sub : ''}`, body, { 'X-Group-Key': groupKeys()[id] || '' });
  // Share card: link + copy + WhatsApp/share, optionally with a secret beheerlink.
  function shareCard({ heading, url, text, title, highlight, secret }) {
    return h('section', { class: 'card stack share' + (highlight ? ' highlight' : '') },
      h('h2', {}, heading),
      h('div', { class: 'linkrow' }, h('input', { readonly: true, value: url, onfocus: (e) => e.target.select() }),
        h('button', { class: 'primary', onclick: () => copy(url) }, 'Kopieer')),
      h('div', { class: 'row' },
        h('a', { class: 'btn', href: `https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Delen via WhatsApp'),
        navigator.share ? h('button', { onclick: () => navigator.share({ title, text, url }).catch(() => {}) }, 'Delen…') : null,
      ),
      secret ? h('details', { class: 'secret', open: highlight },
        h('summary', {}, secret.summary),
        h('p', { class: 'small' }, secret.text),
        h('div', { class: 'linkrow' }, h('input', { readonly: true, value: secret.url, onfocus: (e) => e.target.select() }),
          h('button', { onclick: () => copy(secret.url) }, 'Kopieer')),
      ) : null,
    );
  }
  function listFields(values = {}) {
    return [
      h('label', {}, 'Naam van de lijst', h('input', { name: 'title', required: true, maxlength: 120, placeholder: 'Bijv. Sinterklaas 2026', value: values.title || '' })),
      h('label', {}, 'Jouw naam', h('input', { name: 'owner', maxlength: 80, placeholder: 'Bijv. Elias', value: values.owner || store.get('name', '') })),
      h('label', {}, 'Toelichting (optioneel)', h('textarea', { name: 'description', maxlength: 1000, rows: 2, placeholder: 'Bijv. maat M, liefst geen plastic' })),
    ];
  }
  // Small inline SVG icons (built with DOM APIs; CSP forbids inline markup tricks).
  function icon(paths) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
    for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.append(p); }
    return svg;
  }
  const ICON_EDIT = ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'];
  const ICON_UNLINK = ['M18 6 6 18', 'M6 6l12 12'];
  const ICON_EYE = ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z', 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6'];
  // Compact icon actions for group member rows: view (eye) and, where allowed, remove (cross).
  function rowTools(viewHref, name, onRemove, removeLabel) {
    return h('div', { class: 'row-tools' },
      h('a', { class: 'row-btn', href: viewHref, title: 'Bekijk', 'aria-label': t('Lijst "{0}" bekijken', name) }, icon(ICON_EYE)),
      onRemove ? h('button', { type: 'button', class: 'row-btn danger', title: removeLabel, 'aria-label': `${t(removeLabel)}: ${name}`, onclick: onRemove }, icon(ICON_UNLINK)) : null);
  }
  // Square tiles for "my lists / my groups": the tile opens the list or group, the pencil opens its beheer page.
  const hueOf = (s) => { let x = 0; for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) >>> 0; return [18, 32, 345, 330, 8, 45][x % 6]; };
  function tiles(entries, kind, { onUnlink, onForget, addTile } = {}) {
    const isList = kind === 'list';
    return h('div', { class: 'tiles' },
      entries.map((x) => {
        const name = x.title || (isList ? 'Naamloze lijst' : 'Naamloze groep');
        const tile = h('div', { class: 'tile' + (isList ? '' : ' group') },
          h('a', { class: 'tile-main', href: isList ? `/l/${x.id}` : `/g/${x.id}`, title: isList ? t('Lijst "{0}" bekijken', name) : t('Groep "{0}" bekijken', name) },
            h('span', { class: 'tile-emoji', 'aria-hidden': 'true' }, isList ? '🎁' : '👨‍👩‍👧‍👦'),
            h('span', { class: 'tile-title' }, name),
            h('span', { class: 'tile-kind' }, isList ? 'Lijst' : 'Groep')),
          h('div', { class: 'tile-tools' },
            h('a', { class: 'tile-btn', href: isList ? `/beheer/${x.edit}` : `/groep/${x.edit}`, title: 'Bewerken', 'aria-label': t('{0} bewerken', name) }, icon(ICON_EDIT)),
            onUnlink ? h('button', { type: 'button', class: 'tile-btn', title: 'Uit account halen', 'aria-label': t('{0} uit je account halen', name), onclick: () => onUnlink(x) }, icon(ICON_UNLINK)) : null,
            onForget && !x.acct ? h('button', { type: 'button', class: 'tile-btn', title: 'Van dit apparaat verwijderen', 'aria-label': t('{0} van dit apparaat verwijderen', name), onclick: () => onForget(x) }, icon(ICON_UNLINK)) : null));
        tile.style.setProperty('--hue', hueOf(x.id));
        return tile;
      }),
      addTile ? h('a', { class: 'tile tile-add', href: addTile.href }, h('span', { class: 'tile-plus', 'aria-hidden': 'true' }, '+'), h('span', { class: 'tile-title' }, t(addTile.label))) : null);
  }
  // Forget a list/group on this device only (the list/group itself is untouched; its edit link still works).
  function forgetLocal(kind, x) {
    if (kind === 'list') store.set('ownLists', ownLists().filter((e) => e.edit !== x.edit));
    else { store.set('ownGroups', ownGroups().filter((e) => e.edit !== x.edit)); setGroupKey(x.id, ''); }
  }
  const askForget = (kind, x, after) => {
    const name = x.title || (kind === 'list' ? t('Naamloze lijst') : t('Naamloze groep'));
    if (!confirm(t('"{0}" van dit apparaat verwijderen? De lijst of groep zelf blijft bestaan; met de beheerlink kun je er later weer bij.', name))) return;
    forgetLocal(kind, x); toast(t('Van dit apparaat verwijderd')); after();
  };
  function thumb(item) {
    if (!item.image) return h('div', { class: 'thumb empty', 'aria-hidden': 'true' }, '🎁');
    const img = h('img', { class: 'thumb', src: item.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(h('div', { class: 'thumb empty', 'aria-hidden': 'true' }, '🎁')));
    return img;
  }
  const CURRENCIES = { EUR: '€', USD: '$', GBP: '£' };
  const money = (it) => (it.price ? `${CURRENCIES[it.currency] || '€'} ${it.price}` : '');
  const shopLink = (url) => url && h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'shop' }, 'Bekijk in winkel ↗');

  // ---------- account ----------
  // An account just stores which lists/groups are yours. We mirror them into the same localStorage
  // entries the rest of the app already uses (flagged acct:true, removed again on logout).
  let me = { user: null, lists: [], groups: [] };
  function mirror(key, fromAccount) {
    const ids = new Set(fromAccount.map((x) => x.edit));
    const local = store.get(key, []).filter((x) => !x.acct || ids.has(x.edit)) // drop account entries that are gone
      .map((x) => (ids.has(x.edit) ? { ...x, acct: true } : x));
    const known = new Set(local.map((x) => x.edit));
    const added = fromAccount.filter((x) => !known.has(x.edit)).map((x) => ({ id: x.id, edit: x.edit, title: x.title, acct: true }));
    store.set(key, [...local, ...added].slice(0, 200));
  }
  function applyMe(data) {
    me = data;
    mirror('ownLists', me.lists); mirror('ownGroups', me.groups);
    const link = document.getElementById('account-link');
    if (link) { link.textContent = me.user ? me.user.username : 'Inloggen'; link.title = me.user ? 'Mijn account' : 'Inloggen of account maken'; }
    const adminLink = document.getElementById('admin-link');
    if (adminLink) adminLink.hidden = !(me.user && me.user.isAdmin);
  }
  async function syncAccount() { try { applyMe(await api('GET', '/api/account/me')); } catch { /* offline: keep local state */ } }

  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const webauthnOk = !!(window.PublicKeyCredential && navigator.credentials);
  const deviceLabel = () => {
    const ua = navigator.userAgent;
    return /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Passkey';
  };
  const friendly = (e) => (e && e.name === 'NotAllowedError' ? 'Geannuleerd of verlopen.' : e && e.name === 'InvalidStateError' ? 'Deze passkey is al toegevoegd.' : e.message);
  async function passkeyRegister(username) {
    const o = await api('POST', '/api/account/passkey/register/options', { username });
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: unb64u(o.challenge), rp: o.rp,
      user: { id: new TextEncoder().encode(o.user.id), name: o.user.name, displayName: o.user.displayName },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: o.excludeCredentials.map((c) => ({ type: 'public-key', id: unb64u(c.id) })),
      attestation: 'none', timeout: 120000,
    } });
    const r = cred.response;
    if (!r.getPublicKey) throw new Error('Deze browser is te oud voor passkeys. Probeer een recente Chrome, Safari of Firefox.');
    return api('POST', '/api/account/passkey/register/verify', {
      id: cred.id, label: deviceLabel(),
      clientDataJSON: b64u(r.clientDataJSON), authenticatorData: b64u(r.getAuthenticatorData()),
      publicKey: b64u(r.getPublicKey()), alg: r.getPublicKeyAlgorithm(),
    });
  }
  async function passkeyLogin() {
    const o = await api('POST', '/api/account/passkey/login/options', {});
    const cred = await navigator.credentials.get({ publicKey: { challenge: unb64u(o.challenge), rpId: o.rpId, userVerification: 'required', timeout: 120000 } });
    const r = cred.response;
    return api('POST', '/api/account/passkey/login/verify', {
      id: cred.id, clientDataJSON: b64u(r.clientDataJSON), authenticatorData: b64u(r.authenticatorData), signature: b64u(r.signature),
    });
  }

  function renderAccount() {
    document.title = 'Account · Wensenlijst';
    return me.user ? renderAccountHome() : renderAccountLogin();
  }
  // ?next=/admin etc.: go back where the user came from (same-site paths only)
  const nextPath = () => {
    const n = new URLSearchParams(location.search).get('next') || '';
    try { const u = new URL(n, location.origin); return n.startsWith('/') && u.origin === location.origin ? u.pathname + u.search : ''; } catch { return ''; }
  };
  const afterLogin = (data, msg) => {
    applyMe(data);
    if (nextPath()) { location.href = nextPath(); return; }
    toast(msg); renderAccount();
  };

  function renderAccountLogin() {
    const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (e) { toast(friendly(e), true); } finally { btn.disabled = false; } };
    const lu = h('input', { name: 'username', required: true, maxlength: 40, autocomplete: 'username webauthn', autocapitalize: 'none' });
    const lp = h('input', { name: 'password', type: 'password', required: true, maxlength: 200, autocomplete: 'current-password' });
    const loginForm = h('form', { class: 'stack', onsubmit: (e) => {
      e.preventDefault();
      busy(e.submitter || loginForm.querySelector('button[type=submit]'), async () => afterLogin(await api('POST', '/api/account/login', { username: lu.value, password: lp.value }), 'Ingelogd'));
    } },
      h('label', {}, 'Gebruikersnaam', lu), h('label', {}, 'Wachtwoord', lp),
      h('button', { class: 'primary', type: 'submit' }, 'Inloggen'));
    const pkLogin = webauthnOk ? h('button', { type: 'button', onclick: (e) => busy(e.target, async () => afterLogin(await passkeyLogin(), 'Ingelogd')) }, 'Inloggen met passkey') : null;

    const su = h('input', { name: 'username', required: true, maxlength: 40, autocomplete: 'username', autocapitalize: 'none', pattern: '[A-Za-z0-9._\\-]{3,40}', placeholder: 'Bijv. elias' });
    const sp = h('input', { name: 'password', type: 'password', maxlength: 200, minlength: 8, autocomplete: 'new-password', placeholder: 'Minstens 8 tekens' });
    const signupForm = h('form', { class: 'stack', onsubmit: (e) => {
      e.preventDefault();
      if (!sp.value) return toast('Kies een wachtwoord, of maak je account met een passkey.', true);
      busy(e.submitter, async () => afterLogin(await api('POST', '/api/account/signup', { username: su.value, password: sp.value }), 'Account gemaakt'));
    } },
      h('label', {}, 'Gebruikersnaam', su),
      h('label', {}, 'Wachtwoord', sp),
      h('button', { class: 'primary', type: 'submit' }, 'Account maken'),
      webauthnOk ? h('div', { class: 'or' }, 'of') : null,
      webauthnOk ? h('button', { type: 'button', onclick: (e) => {
        if (!su.reportValidity()) return;
        busy(e.target, async () => afterLogin(await passkeyRegister(su.value.trim()), 'Account gemaakt met passkey'));
      } }, 'Account maken met passkey (zonder wachtwoord)') : null,
    );
    const fname = h('input', { required: true, maxlength: 200, autocomplete: 'username', autocapitalize: 'none', placeholder: 'Gebruikersnaam of e-mailadres' });
    const forgot = me.mailEnabled ? h('details', { class: 'pairlogin' }, h('summary', {}, 'Wachtwoord vergeten?'),
      h('form', { class: 'stack', onsubmit: (e) => {
        e.preventDefault();
        busy(e.submitter, async () => {
          await api('POST', '/api/account/reset/request', { name: fname.value });
          toast('Als er een account met dat e-mailadres bestaat, is er een herstelmail onderweg.');
          e.target.closest('details').replaceChildren(h('p', { class: 'small' }, '📬 Kijk in je mail (ook bij spam) voor een link om een nieuw wachtwoord te kiezen. De link werkt een uur.'));
        });
      } },
        h('p', { class: 'small muted' }, 'Werkt alleen als je een e-mailadres aan je account hebt gekoppeld.'),
        fname, h('div', {}, h('button', { type: 'submit' }, 'Herstelmail sturen'))))
      : null;
    const pairCode = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 9, placeholder: '1234 5678', required: true, class: 'paircode-input' });
    const pairLogin = h('details', { class: 'pairlogin' }, h('summary', {}, 'Passkey staat op een ander apparaat?'),
      h('form', { class: 'stack', onsubmit: (e) => {
        e.preventDefault();
        busy(e.submitter, async () => afterLogin(await api('POST', '/api/account/pair/redeem', { code: pairCode.value }), 'Ingelogd'));
      } },
        h('p', { class: 'small' }, 'Open ', h('strong', {}, 'Account'), ' op een apparaat waar je al bent ingelogd (bijv. je iPhone), kies "Ander apparaat koppelen" en vul de code hier in.'),
        h('label', {}, 'Koppelcode', pairCode),
        h('div', {}, h('button', { type: 'submit' }, 'Inloggen met code'))));
    render(
      h('section', { class: 'hero' },
        h('h1', {}, 'Je account'),
        h('p', { class: 'muted' }, 'Een account is niet nodig, maar handig: je lijsten en groepen staan dan op al je apparaten, ook als je je beheerlinks kwijt bent.')),
      h('section', { class: 'card stack' }, h('h2', {}, 'Inloggen'), pkLogin, pkLogin ? h('div', { class: 'or' }, 'of met wachtwoord') : null, loginForm, forgot, pairLogin),
      h('section', { class: 'card stack' }, h('h2', {}, 'Account maken'), signupForm),
    );
  }

  function renderAccountHome() {
    const u = me.user;
    const listsHere = ownLists().filter((x) => !x.acct), groupsHere = ownGroups().filter((x) => !x.acct);
    const refresh = async () => { await syncAccount(); renderAccount(); };
    const unlink = (body, title) => async () => {
      if (!confirm(t('"{0}" uit je account halen? De lijst of groep zelf blijft bestaan en de beheerlink blijft werken.', title))) return;
      try { applyMe(await api('POST', '/api/account/unlink', body)); renderAccount(); } catch (e) { toast(e.message, true); }
    };

    const importCard = listsHere.length + groupsHere.length ? h('section', { class: 'card stack notice' },
      h('p', {}, listsHere.length + groupsHere.length === 1 ? t('Op dit apparaat staat 1 lijst of groep die nog niet aan je account gekoppeld is:') : t('Op dit apparaat staan {0} lijsten of groepen die nog niet aan je account gekoppeld zijn:', listsHere.length + groupsHere.length)),
      h('div', {}, [...listsHere.map((x) => ['list', x]), ...groupsHere.map((x) => ['group', x])].map(([kind, x]) => h('div', { class: 'acctrow' },
        h('a', { href: kind === 'list' ? `/beheer/${x.edit}` : `/groep/${x.edit}`, translate: 'no' }, (kind === 'list' ? '🎁 ' : '👨‍👩‍👧‍👦 ') + (x.title || t('Naamloos'))),
        h('button', { class: 'link small', onclick: () => askForget(kind, x, renderAccount) }, 'van dit apparaat verwijderen')))),
      h('div', {}, h('button', { class: 'primary', onclick: async () => {
        try {
          const r = await api('POST', '/api/account/claim', { lists: listsHere.map((x) => x.edit), groups: groupsHere.map((x) => x.edit) });
          applyMe(r); toast(t('{0} gekoppeld', r.claimed)); renderAccount();
        } catch (e) { toast(e.message, true); }
      } }, 'Aan mijn account koppelen'), ' ',
        listsHere.length + groupsHere.length < 2 ? null : h('button', { onclick: () => {
          if (!confirm(t('Alle {0} lijsten en groepen die niet aan je account gekoppeld zijn van dit apparaat verwijderen? Ze blijven zelf bestaan.', listsHere.length + groupsHere.length))) return;
          for (const x of listsHere) forgetLocal('list', x);
          for (const x of groupsHere) forgetLocal('group', x);
          toast(t('Van dit apparaat verwijderd')); renderAccount();
        } }, 'Alles van dit apparaat verwijderen')),
      h('p', { class: 'muted small' }, 'Lijsten die al aan een ander account hangen worden overgeslagen.'),
    ) : null;

    const pkBox = h('details', { class: 'card settings' }, h('summary', {}, t('Passkeys ({0})', u.passkeys)), h('p', { class: 'muted' }, 'Laden…'));
    pkBox.addEventListener('toggle', async () => {
      if (!pkBox.open) return;
      let keys = [];
      try { keys = await api('GET', '/api/account/passkeys'); } catch (e) { return toast(e.message, true); }
      pkBox.replaceChildren(pkBox.firstChild, h('div', { class: 'stack' },
        h('p', { class: 'small muted' }, 'Met een passkey log je in met je vingerafdruk, gezicht of apparaatpincode. Je hoeft dan geen wachtwoord te onthouden.'),
        keys.length ? h('div', {}, keys.map((k) => h('div', { class: 'acctrow' }, `${k.label} · ${new Date(k.created_at).toLocaleDateString(I18N.locale)}`,
          h('button', { class: 'link danger small', onclick: async () => {
            if (!confirm('Deze passkey verwijderen?')) return;
            try { await api('DELETE', `/api/account/passkeys/${encodeURIComponent(k.id)}`); toast('Verwijderd'); refresh(); } catch (e) { toast(e.message, true); }
          } }, 'verwijderen')))) : null,
        webauthnOk ? h('div', {}, h('button', { onclick: async (e) => {
          e.target.disabled = true;
          try { applyMe(await passkeyRegister()); toast('Passkey toegevoegd'); renderAccount(); } catch (err) { toast(friendly(err), true); e.target.disabled = false; }
        } }, 'Passkey op dit apparaat toevoegen')) : h('p', { class: 'small' }, 'Deze browser ondersteunt geen passkeys.'),
      ));
    });

    const cur = h('input', { type: 'password', maxlength: 200, autocomplete: 'current-password', required: true });
    const np = h('input', { type: 'password', maxlength: 200, minlength: 8, autocomplete: 'new-password', required: true });
    const pwForm = h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      try { await api('PUT', '/api/account/password', { current: cur.value, password: np.value }); toast('Wachtwoord opgeslagen'); refresh(); }
      catch (err) { toast(err.message, true); }
    } },
      u.hasPassword ? h('label', {}, 'Huidig wachtwoord', cur) : h('p', { class: 'small muted' }, 'Je account heeft nog geen wachtwoord. Handig als reserve voor als je je passkey niet bij de hand hebt.'),
      h('label', {}, 'Nieuw wachtwoord', np),
      h('div', {}, h('button', { class: 'primary', type: 'submit' }, 'Opslaan')));
    if (!u.hasPassword) cur.remove();

    const em = h('input', { type: 'email', maxlength: 200, autocomplete: 'email', value: u.email || '', placeholder: 'jij@voorbeeld.nl' });
    const emCur = h('input', { type: 'password', maxlength: 200, autocomplete: 'current-password', required: true });
    const emailForm = h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await api('PUT', '/api/account/email', { email: em.value.trim(), current: emCur.value });
        applyMe(r);
        toast(!em.value.trim() ? 'E-mailadres verwijderd' : r.mailSent ? 'Opgeslagen. Je hebt een bevestigingsmail gekregen.' : 'Opgeslagen');
        renderAccount();
      } catch (err) { toast(err.message, true); }
    } },
      h('p', { class: 'small muted' }, me.mailEnabled
        ? 'Alleen gebruikt om je wachtwoord te herstellen als je het kwijt bent. We sturen geen andere mail.'
        : 'Alleen gebruikt voor wachtwoordherstel. (E-mail versturen staat op deze server nog uit.)'),
      h('label', {}, 'E-mailadres', em),
      u.hasPassword ? h('label', {}, 'Huidig wachtwoord (ter bevestiging)', emCur) : h('p', { class: 'small muted' }, 'Ter beveiliging kan dit alleen binnen 15 minuten na het inloggen.'),
      h('div', {}, h('button', { class: 'primary', type: 'submit' }, 'Opslaan')));
    const sessBox = h('details', { class: 'card settings' }, h('summary', {}, 'Ingelogde apparaten'), h('p', { class: 'muted' }, 'Laden…'));
    sessBox.addEventListener('toggle', async () => {
      if (!sessBox.open) return;
      let n = 0; try { n = (await api('GET', '/api/account/sessions')).count; } catch (e) { return toast(e.message, true); }
      sessBox.replaceChildren(sessBox.firstChild, h('div', { class: 'stack' },
        h('p', { class: 'small' }, n > 1 ? t('Je bent op {0} apparaten of browsers ingelogd (inclusief deze).', n) : 'Je bent alleen op dit apparaat ingelogd.'),
        n > 1 ? h('div', {}, h('button', { class: 'danger', onclick: async () => {
          if (!confirm('Alle andere apparaten uitloggen?')) return;
          try { await api('POST', '/api/account/logout-others', {}); toast('Andere apparaten uitgelogd'); sessBox.open = false; } catch (e) { toast(e.message, true); }
        } }, 'Overal anders uitloggen')) : null,
        h('p', { class: 'small muted' }, 'Na het wijzigen van je wachtwoord worden andere apparaten ook automatisch uitgelogd.')));
    });
    let pairTimer;
    const pairOut = h('div', { class: 'stack' });
    const pairBtn = h('button', { onclick: async () => {
      try {
        const r = await api('POST', '/api/account/pair/create', {});
        const codeEl = h('div', { class: 'paircode', 'aria-label': 'Koppelcode' }, `${r.code.slice(0, 4)} ${r.code.slice(4)}`);
        const left = h('p', { class: 'muted small' });
        const tick = () => {
          const sec = Math.max(0, Math.round((r.expiresAt - Date.now()) / 1000));
          left.textContent = sec ? t('Nog {0} geldig · eenmalig te gebruiken', `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`) : t('Verlopen, maak een nieuwe code.');
          if (!sec) { clearInterval(pairTimer); codeEl.classList.add('expired'); }
        };
        clearInterval(pairTimer); pairTimer = setInterval(tick, 1000); tick();
        pairOut.replaceChildren(codeEl, left); pairBtn.textContent = 'Nieuwe code';
      } catch (e) { toast(e.message, true); }
    } }, 'Koppelcode maken');
    const pairBox = h('details', { class: 'card settings' }, h('summary', {}, 'Ander apparaat koppelen'),
      h('div', { class: 'stack' },
        h('p', { class: 'small' }, 'Inloggen op een computer die je passkey niet kan bereiken (bijv. zonder Bluetooth)? Maak hier een code en kies daar bij het inloggen "Passkey staat op een ander apparaat?".'),
        h('div', {}, pairBtn), pairOut));
    render(
      h('section', { class: 'listhead row spread' }, h('h1', {}, t('Hoi {0}', u.username)),
        u.isAdmin ? h('a', { class: 'btn', href: '/admin' }, 'Beheerpagina') : null,
        h('button', { onclick: async () => {
          await api('POST', '/api/account/logout', {}).catch(() => {});
          applyMe({ user: null, lists: [], groups: [] }); toast('Uitgelogd'); renderAccount();
        } }, 'Uitloggen')),
      importCard,
      h('section', { class: 'card stack' }, h('h2', {}, t('Mijn lijsten ({0})', me.lists.length)),
        tiles(me.lists, 'list', { onUnlink: (x) => unlink({ list: x.edit }, x.title)(), addTile: { href: '/', label: 'Nieuwe lijst' } })),
      h('section', { class: 'card stack' }, h('h2', {}, t('Mijn groepen ({0})', me.groups.length)),
        me.groups.length ? tiles(me.groups, 'group', { onUnlink: (x) => unlink({ group: x.edit }, x.title)() }) : h('p', { class: 'muted small' }, 'Nog geen groepen in je account. Maak er een op de startpagina of open een groeplink.')),
      pkBox,
      pairBox,
      sessBox,
      h('details', { class: 'card settings' }, h('summary', {}, u.hasPassword ? 'Wachtwoord wijzigen' : 'Wachtwoord instellen'), pwForm),
      h('details', { class: 'card settings', open: u.hasPassword && !u.email && me.mailEnabled }, h('summary', {}, u.email ? t('E-mailadres ({0})', u.email) : 'E-mailadres voor wachtwoordherstel'), emailForm),
      h('details', { class: 'card settings' }, h('summary', {}, 'Account verwijderen'), h('div', { class: 'stack' },
        h('p', { class: 'small' }, 'Je lijsten en groepen blijven bestaan en blijven werken via hun beheerlinks. Ze hangen dan alleen niet meer aan een account. Bewaar die links dus eerst!'),
        h('div', {}, h('button', { class: 'danger', onclick: async () => {
          if (!confirm('Account definitief verwijderen?')) return;
          try {
            await api('POST', '/api/account/delete', {});
            // keep the lists on this device so the beheerlinks aren't lost
            for (const k of ['ownLists', 'ownGroups']) store.set(k, store.get(k, []).map(({ acct, ...x }) => x));
            applyMe({ user: null, lists: [], groups: [] }); toast('Account verwijderd'); renderAccount();
          } catch (e) { toast(e.message, true); }
        } }, 'Account verwijderen')))),
    );
  }

  function renderReset(tokenStr) {
    document.title = 'Nieuw wachtwoord · Wensenlijst';
    history.replaceState(null, '', '/account'); // keep the token out of history and screenshots
    const p1 = h('input', { type: 'password', required: true, minlength: 8, maxlength: 200, autocomplete: 'new-password' });
    const p2 = h('input', { type: 'password', required: true, minlength: 8, maxlength: 200, autocomplete: 'new-password' });
    const form = h('form', { class: 'card stack', onsubmit: async (e) => {
      e.preventDefault();
      if (p1.value !== p2.value) return toast('De wachtwoorden zijn niet hetzelfde.', true);
      try { applyMe(await api('POST', '/api/account/reset/confirm', { token: tokenStr, password: p1.value })); toast('Nieuw wachtwoord ingesteld, je bent ingelogd'); renderAccount(); }
      catch (err) { toast(err.message, true); }
    } },
      h('h1', {}, 'Nieuw wachtwoord kiezen'),
      h('label', {}, 'Nieuw wachtwoord', p1), h('label', {}, 'Nog een keer', p2),
      h('button', { class: 'primary', type: 'submit' }, 'Opslaan en inloggen'),
      h('p', { class: 'muted small' }, 'Je wordt daarna op je andere apparaten uitgelogd.'));
    render(form); p1.focus();
  }

  // ---------- home ----------
  function renderHome() {
    document.title = 'Wensenlijst';
    const form = h('form', { class: 'card stack', onsubmit: async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const btn = form.querySelector('button'); btn.disabled = true;
      try {
        const r = await api('POST', '/api/lists', { title: fd.get('title'), owner: fd.get('owner'), description: fd.get('description') });
        rememberOwn({ id: r.id, edit: r.edit, title: fd.get('title') });
        location.href = `/beheer/${r.edit}?nieuw=1`;
      } catch (err) { toast(err.message, true); btn.disabled = false; }
    } },
      h('h2', {}, 'Nieuwe verlanglijst'),
      h('label', {}, 'Naam van de lijst', h('input', { name: 'title', required: true, maxlength: 120, placeholder: 'Bijv. Sinterklaas 2026' })),
      h('label', {}, 'Jouw naam', h('input', { name: 'owner', maxlength: 80, placeholder: 'Bijv. Elias' })),
      h('label', {}, 'Toelichting (optioneel)', h('textarea', { name: 'description', maxlength: 1000, rows: 2, placeholder: 'Bijv. maat M, liefst geen plastic' })),
      h('button', { class: 'primary', type: 'submit' }, 'Lijst maken'),
    );
    const gform = h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      const fd = new FormData(gform);
      const btn = gform.querySelector('button'); btn.disabled = true;
      try {
        const r = await api('POST', '/api/groups', { title: fd.get('title'), description: fd.get('description'), password: fd.get('password') });
        rememberGroup({ id: r.id, edit: r.edit, title: fd.get('title') });
        if (r.key) setGroupKey(r.id, r.key);
        location.href = `/groep/${r.edit}?nieuw=1`;
      } catch (err) { toast(err.message, true); btn.disabled = false; }
    } },
      h('p', { class: 'muted small' }, 'Een groep bundelt de lijsten van bijvoorbeeld de hele familie onder één link. Iedereen met de link kan zijn eigen lijst toevoegen.'),
      h('label', {}, 'Naam van de groep', h('input', { name: 'title', required: true, maxlength: 120, placeholder: 'Bijv. Kerst met de familie' })),
      h('label', {}, 'Toelichting (optioneel)', h('textarea', { name: 'description', maxlength: 1000, rows: 2, placeholder: 'Bijv. budget rond de € 25' })),
      h('label', {}, 'Wachtwoord (optioneel)', h('input', { name: 'password', type: 'password', maxlength: 200, autocomplete: 'new-password', placeholder: 'Leeg laten voor geen wachtwoord' })),
      h('button', { class: 'primary', type: 'submit' }, 'Groep maken'),
    );
    const own = ownLists(), groups = ownGroups();
    render(
      h('section', { class: 'hero' },
        h('div', { class: 'hero-gift', 'aria-hidden': 'true' }, '🎁'),
        h('h1', {}, 'Maak een verlanglijst en deel hem met één link'),
        h('p', { class: 'muted' }, 'Geen account nodig. Familie en vrienden strepen af wat ze kopen, en jij ziet niet wat er al gekocht is.'),
        me.user ? null : h('p', { class: 'small' }, h('a', { href: '/account' }, 'Inloggen of account maken'), ' om je lijsten op al je apparaten te hebben (optioneel).'),
      ),
      form,
      own.length ? h('section', { class: 'card stack' },
        h('h2', {}, 'Mijn lijsten op dit apparaat'),
        tiles(own, 'list', { onForget: (x) => askForget('list', x, renderHome) }),
        me.user ? h('p', { class: 'muted small' }, 'Lijsten in je account staan op al je apparaten. ', h('a', { href: '/account' }, 'Account beheren')) : h('p', { class: 'muted small' }, 'Deze lijst wordt alleen in deze browser bewaard. Bewaar je beheerlinks ook ergens anders, of ', h('a', { href: '/account' }, 'maak een account'), '.'),
      ) : null,
      groups.length ? h('section', { class: 'card stack' },
        h('h2', {}, 'Mijn groepen op dit apparaat'),
        tiles(groups, 'group', { onForget: (x) => askForget('group', x, renderHome) }),
      ) : null,
      h('details', { class: 'card settings' }, h('summary', {}, 'Groep maken'), gform),
      h('p', { class: 'center small' }, h('a', { href: '/faq' }, 'Vragen? Bekijk de veelgestelde vragen')),
    );
  }

  // ---------- owner / manage ----------
  async function renderManage(tokenStr) {
    let data;
    try { data = await api('GET', `/api/edit/${encodeURIComponent(tokenStr)}`); }
    catch (e) { return renderError(e.message); }
    const { list, items, groups = [] } = data;
    const viaAdmin = new URLSearchParams(location.search).get('via') === 'admin'; // opened from /admin: don't keep it on this device
    if (!viaAdmin) rememberOwn({ id: list.id, edit: tokenStr, title: list.title });
    document.title = t('{0} beheren · Wensenlijst', list.title);
    const base = `/api/edit/${encodeURIComponent(tokenStr)}`;
    const isNew = new URLSearchParams(location.search).has('nieuw');
    const reload = () => renderManage(tokenStr);
    const share = shareUrl(list.id);
    const shareText = list.owner ? t('Verlanglijst van {0}: "{1}"', list.owner, list.title) : t('Mijn verlanglijst: "{0}"', list.title);

    const shareBox = h('section', { class: 'card stack share' + (isNew ? ' highlight' : '') },
      h('h2', {}, isNew ? '🎉 Je lijst is klaar! Deel deze link' : 'Deellink'),
      h('div', { class: 'linkrow' }, h('input', { readonly: true, value: share, onfocus: (e) => e.target.select() }),
        h('button', { class: 'primary', onclick: () => copy(share) }, 'Kopieer')),
      h('div', { class: 'row' },
        h('a', { class: 'btn', href: `https://wa.me/?text=${encodeURIComponent(`${shareText}\n${share}`)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Delen via WhatsApp'),
        navigator.share ? h('button', { onclick: () => navigator.share({ title: list.title, text: shareText, url: share }).catch(() => {}) }, 'Delen…') : null,
      ),
      h('details', { class: 'secret', open: isNew },
        h('summary', {}, '🔑 Jouw beheerlink (geheim houden!)'),
        h('p', { class: 'small' }, 'Zonder account is dit de enige manier om je lijst later te bewerken. Bewaar hem goed, bijvoorbeeld in je bladwijzers of mail hem naar jezelf. Deel hem met niemand.'),
        h('div', { class: 'linkrow' }, h('input', { readonly: true, value: editUrl(tokenStr), onfocus: (e) => e.target.select() }),
          h('button', { onclick: () => copy(editUrl(tokenStr)) }, 'Kopieer')),
      ),
    );

    const header = h('section', { class: 'listhead' },
      h('h1', { translate: 'no' }, list.title),
      list.owner ? h('p', { class: 'muted' }, t('van {0}', list.owner)) : null,
      list.description ? h('p', { class: 'desc' }, list.description) : null,
    );

    const ul = h('ul', { class: 'items' }, items.map((it, i) => manageItem(it, i, items.length, base, reload)));
    const empty = !items.length ? h('p', { class: 'muted center' }, 'Nog geen wensen. Voeg hieronder je eerste wens toe.') : null;

    render(header,
      viaAdmin ? h('p', { class: 'card notice small' }, 'Je bekijkt dit als beheerder; het wordt niet op dit apparaat bewaard.') : null,
      shareBox,
      h('section', { class: 'stack' }, h('h2', {}, t('Wensen ({0})', items.length)), empty, ul),
      itemForm(null, base, reload),
      groupsBox(groups, base, tokenStr, reload),
      settingsBox(list, base, tokenStr),
    );
    if (isNew) { history.replaceState(null, '', location.pathname); setTimeout(() => celebrate(null, 70), 450); }
  }

  function manageItem(it, i, n, base, reload) {
    const li = h('li', { class: 'item' },
      thumb(it),
      h('div', { class: 'body' },
        h('div', { class: 'title' }, it.title),
        it.price ? h('div', { class: 'price' }, money(it)) : null,
        it.note ? h('div', { class: 'note' }, it.note) : null,
        shopLink(it.url),
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'icon', title: 'Omhoog', 'aria-label': 'Omhoog', disabled: i === 0, onclick: () => move('up') }, '↑'),
        h('button', { class: 'icon', title: 'Omlaag', 'aria-label': 'Omlaag', disabled: i === n - 1, onclick: () => move('down') }, '↓'),
        h('button', { class: 'icon', title: 'Bewerken', 'aria-label': 'Bewerken', onclick: () => li.replaceWith(itemForm(it, base, reload)) }, '✎'),
        h('button', { class: 'icon danger', title: 'Verwijderen', 'aria-label': 'Verwijderen', onclick: async () => {
          if (!confirm(t('"{0}" verwijderen?', it.title))) return;
          try { await api('DELETE', `${base}/items/${it.id}`); reload(); } catch (e) { toast(e.message, true); }
        } }, '✕'),
      ),
    );
    async function move(dir) { try { await api('POST', `${base}/items/${it.id}/move`, { dir }); reload(); } catch (e) { toast(e.message, true); } }
    return li;
  }

  function itemForm(it, base, reload) {
    const editing = !!it;
    const defaultCurrency = () => (CURRENCIES[store.get('currency')] ? store.get('currency') : 'EUR');
    const v = it || { title: '', url: '', price: '', currency: defaultCurrency(), image: '', note: '' };
    const f = {
      url: h('input', { name: 'url', type: 'url', value: v.url, placeholder: 'https://www.bol.com/…', inputmode: 'url' }),
      title: h('input', { name: 'title', required: true, maxlength: 200, value: v.title, placeholder: 'Wat wil je graag?' }),
      currency: h('select', { name: 'currency', 'aria-label': 'Valuta', onchange: (e) => store.set('currency', e.target.value) },
        Object.entries(CURRENCIES).map(([code, sym]) => h('option', { value: code, selected: code === (v.currency || 'EUR') }, `${sym} ${code}`))),
      price: h('input', { name: 'price', maxlength: 40, value: v.price, placeholder: '19,99', inputmode: 'decimal' }),
      image: h('input', { name: 'image', type: 'url', value: v.image, placeholder: 'https://… (optioneel)' }),
      note: h('textarea', { name: 'note', maxlength: 1000, rows: 2, placeholder: 'Kleur, maat, versie… (optioneel)' }, v.note),
    };
    const preview = h('div', { class: 'preview' });
    const updatePreview = () => preview.replaceChildren(f.image.value ? thumb({ image: f.image.value }) : '');
    f.image.addEventListener('input', updatePreview); updatePreview();
    // Auto-fetch product info on paste (or when a typed link is confirmed). No button needed.
    const status = h('div', { class: 'fetchstatus', role: 'status', hidden: true },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Productinformatie ophalen…');
    const details = h('fieldset', { class: 'details stack' });
    let seq = 0, lastFetched = v.url;
    function setLoading(on) {
      status.hidden = !on;
      details.disabled = on;
      form.classList.toggle('loading', on);
      submitBtn.disabled = on;
    }
    async function doFetch() {
      const url = f.url.value.trim();
      if (!url || !f.url.checkValidity()) return;
      lastFetched = url;
      const my = ++seq;
      setLoading(true);
      try {
        const r = await api('POST', `${base}/fetch`, { url });
        if (my !== seq) return; // a newer paste or a clear happened meanwhile
        if (r.title) f.title.value = r.title;
        if (r.price) f.price.value = r.price;
        if (r.price && CURRENCIES[r.currency]) f.currency.value = r.currency;
        if (r.image) f.image.value = r.image;
        if (r.url) { f.url.value = r.url; lastFetched = r.url; }
        updatePreview();
        const names = { title: 'naam', price: 'prijs', image: 'afbeelding' };
        if (r.fallback) toast(t('{0} via {1}, controleer even of het klopt', r.fallback.fields.map((k) => t(names[k])).join(', '), r.fallback.source));
        else toast(r.title ? 'Gegevens opgehaald' : 'Weinig gevonden, vul de rest zelf in');
        setLoading(false);
        if (!editing) f.title.focus();
      } catch (e) { if (my === seq) toast(e.message, true); }
      finally { if (my === seq) setLoading(false); }
    }
    function clearForm() {
      seq++; setLoading(false);
      for (const [k, el] of Object.entries(f)) if (k !== 'currency') el.value = '';
      lastFetched = '';
      updatePreview();
      f.url.focus();
    }
    f.url.addEventListener('paste', () => setTimeout(doFetch, 0));
    f.url.addEventListener('change', () => { if (f.url.value.trim() !== lastFetched) doFetch(); });
    f.url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (f.url.value.trim() !== lastFetched) doFetch(); } });
    const submitBtn = h('button', { class: 'primary', type: 'submit' }, editing ? 'Opslaan' : 'Toevoegen');
    const form = h('form', { class: 'card stack itemform', onsubmit: async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
      try {
        if (editing) await api('PUT', `${base}/items/${it.id}`, body);
        else await api('POST', `${base}/items`, body);
        if (!editing) celebrate(submitBtn, 22);
        toast(editing ? 'Opgeslagen' : 'Wens toegevoegd ✨');
        reload();
      } catch (err) { toast(err.message, true); }
    } },
      h('h2', {}, editing ? 'Wens bewerken' : 'Wens toevoegen'),
      h('label', {}, 'Link naar product (optioneel)', f.url),
      status,
      h('p', { class: 'muted small' }, 'Plak een link en de naam, prijs en afbeelding worden automatisch opgehaald. Dat lukt niet bij elke winkel.'),
      details,
      h('div', { class: 'row' },
        submitBtn,
        editing ? h('button', { type: 'button', onclick: reload }, 'Annuleren')
          : h('button', { type: 'button', onclick: clearForm }, 'Wissen')),
    );
    details.append(
      h('label', {}, 'Wens', f.title),
      h('div', { class: 'grid2' }, h('label', {}, 'Prijs', h('div', { class: 'pricefield' }, f.currency, f.price)), h('label', {}, 'Afbeelding-URL', f.image)),
      preview,
      h('label', {}, 'Opmerking', f.note),
    );
    return editing ? h('li', { class: 'item editing' }, form) : form;
  }

  function groupsBox(groups, base, tokenStr, reload) {
    const name = h('input', { required: true, maxlength: 120, placeholder: 'Bijv. Kerst met de familie', 'aria-label': 'Naam van de groep' });
    const form = h('form', { class: 'linkrow', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/api/groups', { title: name.value, list: tokenStr });
        rememberGroup({ id: r.id, edit: r.edit, title: name.value.trim() });
        location.href = `/groep/${r.edit}?nieuw=1`;
      } catch (err) { toast(err.message, true); }
    } }, name, h('button', { type: 'submit' }, 'Groep maken'));
    return h('details', { class: 'card settings', open: groups.length > 0 }, h('summary', {}, t('Groepen ({0})', groups.length)),
      h('div', { class: 'stack' },
        groups.length
          ? h('ul', { class: 'plain' }, groups.map((g) => h('li', {}, h('a', { href: `/g/${g.id}` }, g.title), ' ',
            h('button', { class: 'link danger', onclick: async () => {
              if (!confirm(t('Je lijst uit de groep "{0}" halen?', g.title))) return;
              try { await api('DELETE', `${base}/groups/${encodeURIComponent(g.id)}`); toast('Uit de groep gehaald'); reload(); } catch (e) { toast(e.message, true); }
            } }, 'uit groep halen'))))
          : h('p', { class: 'muted small' }, 'Deze lijst zit nog in geen enkele groep. Open de link van een groep om mee te doen, of maak hier zelf een groep.'),
        h('p', { class: 'small' }, 'Nieuwe groep met deze lijst:'), form,
      ));
  }

  // ---------- groups ----------
  function groupHead(group) {
    return h('section', { class: 'listhead' },
      h('p', { class: 'muted small eyebrow' }, 'Groep'),
      h('h1', { translate: 'no' }, group.title),
      group.description ? h('p', { class: 'desc' }, group.description) : null,
    );
  }
  function renderGroupLock(id, title) {
    document.title = t('{0} · Wensenlijst', title);
    const pw = h('input', { type: 'password', required: true, maxlength: 200, autocomplete: 'current-password' });
    const form = h('form', { class: 'card stack', onsubmit: async (e) => {
      e.preventDefault();
      try { const r = await groupApi('POST', id, 'unlock', { password: pw.value }); setGroupKey(id, r.key); renderGroup(id); }
      catch (err) { toast(err.message, true); pw.select(); }
    } },
      h('p', {}, '🔒 Deze groep is beveiligd. Vul het wachtwoord in dat je van de maker hebt gekregen.'),
      h('label', {}, 'Wachtwoord', pw),
      h('button', { class: 'primary', type: 'submit' }, 'Openen'));
    render(groupHead({ title }), form);
    pw.focus();
  }
  async function renderGroup(id) {
    let data;
    try { data = await groupApi('GET', id); }
    catch (e) {
      if (e.data && e.data.locked) { setGroupKey(id, ''); return renderGroupLock(id, e.data.title); }
      return renderError(e.message);
    }
    const { group, lists } = data;
    document.title = t('{0} · Wensenlijst', group.title);
    const reload = () => renderGroup(id);
    const mine = new Map(ownLists().map((l) => [l.id, l]));
    const memberIds = new Set(lists.map((l) => l.id));
    const ownedGroup = ownGroups().find((g) => g.id === id);
    if (ownedGroup && ownedGroup.title !== group.title) rememberGroup({ ...ownedGroup, title: group.title });
    const join = async (edit) => { await groupApi('POST', id, 'join', { edit }); toast('Toegevoegd aan de groep'); reload(); };

    const members = lists.length ? h('ul', { class: 'items' }, lists.map((l) => {
      const own = mine.get(l.id);
      return h('li', { class: 'item grouprow' },
        h('div', { class: 'thumb empty', 'aria-hidden': 'true' }, '🎁'),
        h('div', { class: 'body' },
          h('a', { class: 'title', href: `/l/${l.id}?groep=${encodeURIComponent(id)}` }, l.title),
          h('div', { class: 'muted small' }, [l.owner && t('van {0}', l.owner), l.items === 1 ? t('1 wens') : t('{0} wensen', l.items)].filter(Boolean).join(' · '),
            own ? h('span', { class: 'badge' }, 'jouw lijst') : null),
        ),
        rowTools(`/l/${l.id}?groep=${encodeURIComponent(id)}`, l.title, own ? async () => {
          if (!confirm(t('"{0}" uit deze groep halen?', l.title))) return;
          try { await groupApi('POST', id, 'leave', { edit: own.edit }); toast('Uit de groep gehaald'); reload(); } catch (e) { toast(e.message, true); }
        } : null, 'Uit de groep halen'),
      );
    })) : h('p', { class: 'muted center' }, 'Nog geen lijsten in deze groep. Voeg hieronder de eerste toe!');

    const notIn = ownLists().filter((l) => !memberIds.has(l.id));
    const newForm = h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      const fd = new FormData(newForm);
      const btn = newForm.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        if (fd.get('owner')) store.set('name', fd.get('owner'));
        const r = await api('POST', '/api/lists', { title: fd.get('title'), owner: fd.get('owner'), description: fd.get('description') });
        rememberOwn({ id: r.id, edit: r.edit, title: fd.get('title') });
        await groupApi('POST', id, 'join', { edit: r.edit });
        location.href = `/beheer/${r.edit}?nieuw=1`;
      } catch (err) { toast(err.message, true); btn.disabled = false; }
    } }, ...listFields(), h('button', { class: 'primary', type: 'submit' }, 'Lijst maken en toevoegen'));
    const pasted = h('input', { required: true, placeholder: `${origin}/beheer/…`, 'aria-label': 'Beheerlink' });
    const pasteForm = h('form', { class: 'linkrow', onsubmit: async (e) => {
      e.preventDefault();
      try { await join(pasted.value.trim()); } catch (err) { toast(err.message, true); }
    } }, pasted, h('button', { type: 'submit' }, 'Toevoegen'));

    const addCard = h('section', { class: 'card stack' },
      h('h2', {}, 'Mijn lijst toevoegen'),
      notIn.length ? h('p', { class: 'small muted' }, 'Kies een van je lijsten:') : null,
      notIn.length ? h('ul', { class: 'plain stack' }, notIn.map((l) => h('li', { class: 'row spread' }, h('span', {}, l.title || 'Naamloze lijst'),
        h('button', { class: 'primary', onclick: async (e) => { e.target.disabled = true; try { await join(l.edit); } catch (err) { toast(err.message, true); e.target.disabled = false; } } }, 'Toevoegen')))) : null,
      h('details', { class: 'settings', open: !notIn.length && !lists.some((l) => mine.has(l.id)) },
        h('summary', {}, 'Nieuwe lijst maken'), newForm),
      h('details', { class: 'settings' }, h('summary', {}, 'Bestaande lijst toevoegen'),
        h('div', { class: 'stack' },
          h('p', { class: 'small muted' }, 'Staat je lijst hier niet? Plak de beheerlink van je lijst: de geheime link waarmee je hem bewerkt. Anderen in de groep zien alleen je deellink.'),
          pasteForm,
          me.user ? null : h('p', { class: 'small' }, h('a', { href: '/account' }, 'Tip: log in'), ', dan staan al je lijsten hier vanzelf.'))),
    );

    render(groupHead(group),
      ownedGroup ? h('p', { class: 'small' }, h('a', { class: 'btn', href: `/groep/${ownedGroup.edit}` }, 'Groep beheren')) : null,
      h('section', { class: 'stack' }, h('h2', {}, t('Lijsten ({0})', lists.length)), members),
      addCard,
      shareCard({ heading: 'Groep delen', url: groupUrl(id), title: group.title,
        text: t('Groep "{0}": bekijk de verlanglijsten en voeg je eigen lijst toe', group.title) }),
      group.protected ? h('p', { class: 'muted small center' }, '🔒 Wie de link krijgt heeft ook het wachtwoord nodig.') : null,
      h('p', { class: 'center small' }, h('a', { href: '/' }, 'Naar de startpagina')),
    );
  }

  async function renderGroupManage(tokenStr) {
    let data;
    try { data = await api('GET', `/api/group-edit/${encodeURIComponent(tokenStr)}`); }
    catch (e) { return renderError(e.message); }
    const { group, lists, key } = data;
    const viaAdmin = new URLSearchParams(location.search).get('via') === 'admin'; // opened from /admin: don't keep it on this device
    if (!viaAdmin) { rememberGroup({ id: group.id, edit: tokenStr, title: group.title }); setGroupKey(group.id, key); }
    document.title = t('{0} beheren · Wensenlijst', group.title);
    const base = `/api/group-edit/${encodeURIComponent(tokenStr)}`;
    const isNew = new URLSearchParams(location.search).has('nieuw');
    const reload = () => renderGroupManage(tokenStr);

    const members = lists.length ? h('ul', { class: 'items' }, lists.map((l) => h('li', { class: 'item grouprow' },
      h('div', { class: 'thumb empty', 'aria-hidden': 'true' }, '🎁'),
      h('div', { class: 'body' },
        h('a', { class: 'title', href: `/l/${l.id}?groep=${encodeURIComponent(group.id)}` }, l.title),
        h('div', { class: 'muted small' }, [l.owner && t('van {0}', l.owner), l.items === 1 ? t('1 wens') : t('{0} wensen', l.items)].filter(Boolean).join(' · '))),
      rowTools(`/l/${l.id}?groep=${encodeURIComponent(group.id)}`, l.title, async () => {
        if (!confirm(t('"{0}" uit de groep verwijderen? De lijst zelf blijft bestaan.', l.title))) return;
        try { await api('DELETE', `${base}/lists/${encodeURIComponent(l.id)}`); toast('Verwijderd uit de groep'); reload(); } catch (e) { toast(e.message, true); }
      }, 'Uit de groep halen'),
    ))) : h('p', { class: 'muted' }, 'Nog geen lijsten. Deel de groeplink zodat anderen hun lijst kunnen toevoegen.');

    const form = h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try { await api('PUT', base, { title: fd.get('title'), description: fd.get('description') }); toast('Opgeslagen'); reload(); }
      catch (err) { toast(err.message, true); }
    } },
      h('label', {}, 'Naam van de groep', h('input', { name: 'title', required: true, maxlength: 120, value: group.title })),
      h('label', {}, 'Toelichting', h('textarea', { name: 'description', maxlength: 1000, rows: 2 }, group.description)),
      h('div', { class: 'row' },
        h('button', { class: 'primary', type: 'submit' }, 'Opslaan'),
        h('button', { type: 'button', class: 'danger', onclick: async () => {
          if (!confirm('Deze groep verwijderen? De lijsten zelf blijven bestaan.')) return;
          try { await api('DELETE', base); store.set('ownGroups', ownGroups().filter((x) => x.edit !== tokenStr)); location.href = '/'; }
          catch (err) { toast(err.message, true); }
        } }, 'Groep verwijderen')),
    );
    const pw = h('input', { type: 'password', maxlength: 200, autocomplete: 'new-password', required: true, placeholder: group.protected ? 'Nieuw wachtwoord' : 'Wachtwoord' });
    const setPw = async (password) => {
      try { const r = await api('PUT', `${base}/password`, { password }); setGroupKey(group.id, r.key); toast(password ? 'Wachtwoord ingesteld' : 'Wachtwoord verwijderd'); reload(); }
      catch (err) { toast(err.message, true); }
    };
    const pwForm = h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); setPw(pw.value); } },
      h('p', { class: 'small' }, group.protected
        ? '🔒 Deze groep heeft een wachtwoord. Wie de groeplink opent moet het invullen. Na een wijziging moet iedereen het nieuwe wachtwoord invullen.'
        : 'Zonder wachtwoord kan iedereen met de link de groep zien.'),
      h('p', { class: 'muted small' }, 'Het wachtwoord beschermt het overzicht van de groep. De afzonderlijke lijsten blijven bereikbaar via hun eigen deellink.'),
      h('div', { class: 'linkrow' }, pw, h('button', { type: 'submit' }, group.protected ? 'Wijzigen' : 'Instellen')),
      group.protected ? h('div', {}, h('button', { type: 'button', class: 'danger', onclick: () => { if (confirm('Wachtwoord verwijderen?')) setPw(''); } }, 'Wachtwoord verwijderen')) : null,
    );

    render(groupHead(group),
      viaAdmin ? h('p', { class: 'card notice small' }, 'Je bekijkt dit als beheerder; het wordt niet op dit apparaat bewaard.') : null,
      shareCard({ heading: isNew ? '🎉 Je groep is klaar! Deel deze link' : 'Groeplink', url: groupUrl(group.id), title: group.title, highlight: isNew,
        text: t('Groep "{0}": bekijk de verlanglijsten en voeg je eigen lijst toe', group.title),
        secret: { summary: '🔑 Beheerlink van de groep (geheim houden!)', url: groupEditUrl(tokenStr),
          text: 'Hiermee kun je de groep later aanpassen, lijsten verwijderen of een wachtwoord instellen. Bewaar hem goed en deel hem niet.' } }),
      h('p', {}, h('a', { class: 'btn', href: `/g/${group.id}` }, 'Groep bekijken en eigen lijst toevoegen')),
      h('section', { class: 'stack' }, h('h2', {}, t('Lijsten ({0})', lists.length)), members),
      h('details', { class: 'card settings', open: group.protected }, h('summary', {}, group.protected ? 'Wachtwoord 🔒' : 'Wachtwoord'), pwForm),
      h('details', { class: 'card settings' }, h('summary', {}, 'Groepsinstellingen'), form),
    );
    if (isNew) { history.replaceState(null, '', location.pathname); setTimeout(() => celebrate(null, 70), 450); }
  }

  function settingsBox(list, base, tokenStr) {
    const form = h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        await api('PUT', base, { title: fd.get('title'), owner: fd.get('owner'), description: fd.get('description') });
        toast('Opgeslagen'); renderManage(tokenStr);
      } catch (err) { toast(err.message, true); }
    } },
      h('label', {}, 'Naam van de lijst', h('input', { name: 'title', required: true, maxlength: 120, value: list.title })),
      h('label', {}, 'Jouw naam', h('input', { name: 'owner', maxlength: 80, value: list.owner })),
      h('label', {}, 'Toelichting', h('textarea', { name: 'description', maxlength: 1000, rows: 2 }, list.description)),
      h('div', { class: 'row' },
        h('button', { class: 'primary', type: 'submit' }, 'Opslaan'),
        h('button', { type: 'button', class: 'danger', onclick: async () => {
          if (!confirm('Weet je zeker dat je deze hele lijst wilt verwijderen? Dit kan niet ongedaan worden gemaakt.')) return;
          try {
            await api('DELETE', base);
            store.set('ownLists', ownLists().filter((x) => x.edit !== tokenStr));
            location.href = '/';
          } catch (err) { toast(err.message, true); }
        } }, 'Lijst verwijderen')),
    );
    return h('details', { class: 'card settings' }, h('summary', {}, 'Lijstinstellingen'), form);
  }

  // ---------- guest / share ----------
  async function renderShare(id, reveal) {
    const claims = store.get('claims', {}); // itemId -> token
    let data;
    try { data = await api('GET', `/api/list/${encodeURIComponent(id)}`, null, { 'X-Claim-Tokens': Object.values(claims).join(',') }); }
    catch (e) { return renderError(e.message); }
    const { list, items } = data;
    document.title = t('{0} · Wensenlijst', list.title);
    const isOwner = ownLists().some((x) => x.id === list.id);
    const hideClaims = isOwner && !reveal;
    const reload = () => renderShare(id, reveal);

    const fromGroup = new URLSearchParams(location.search).get('groep');
    const head = h('section', { class: 'listhead' },
      fromGroup ? h('a', { class: 'small back', href: `/g/${encodeURIComponent(fromGroup)}` }, '← Terug naar de groep') : null,
      h('h1', { translate: 'no' }, list.title),
      list.owner ? h('p', { class: 'muted' }, t('Verlanglijst van {0}', list.owner)) : null,
      list.description ? h('p', { class: 'desc' }, list.description) : null,
    );
    const ownerNote = isOwner ? h('div', { class: 'card notice' },
      h('p', {}, hideClaims
        ? 'Dit is jouw eigen lijst. Om de verrassing niet te bederven verbergen we wat er al gekocht is.'
        : 'Je ziet nu wat er is afgestreept. Spoiler!'),
      h('div', { class: 'row' },
        hideClaims ? h('button', { onclick: () => { if (confirm('Weet je het zeker? Dan zie je wat je krijgt.')) renderShare(id, true); } }, 'Toch laten zien') : null,
        h('a', { class: 'btn', href: `/beheer/${ownLists().find((x) => x.id === list.id).edit}` }, 'Lijst bewerken')),
    ) : h('p', { class: 'muted small intro' }, 'Koop je iets van deze lijst? Streep het af, dan weten anderen dat het al geregeld is. Degene van de lijst ziet niet wat er afgestreept is.');

    const open = items.filter((x) => hideClaims || !x.claimed).length;
    render(head, ownerNote,
      items.length
        ? h('ul', { class: 'items' }, items.map((it) => shareItem(it, id, hideClaims, reload)))
        : h('p', { class: 'muted center' }, 'Deze lijst is nog leeg.'),
      !hideClaims && items.length ? h('p', { class: 'muted small center' }, t('{0} van {1} wensen nog beschikbaar', open, items.length)) : null,
      h('p', { class: 'center small' }, h('a', { href: '/' }, 'Zelf ook een verlanglijst maken?')),
    );
  }

  function shareItem(it, listId, hideClaims, reload) {
    const claimed = !hideClaims && it.claimed;
    const base = `/api/list/${encodeURIComponent(listId)}/items/${it.id}`;
    let status = null;
    if (!hideClaims) {
      if (it.mine) status = h('div', { class: 'status mine' }, '✓ Jij koopt dit ',
        h('button', { class: 'link', onclick: async () => {
          const claims = store.get('claims', {});
          try {
            await api('POST', `${base}/unclaim`, { token: claims[it.id] });
            delete claims[it.id]; store.set('claims', claims); toast('Teruggezet'); reload();
          } catch (e) { toast(e.message, true); }
        } }, 'ongedaan maken'));
      else if (it.claimed) status = h('div', { class: 'status' }, it.claimedBy ? t('Wordt al gekocht door {0}', it.claimedBy) : t('Wordt al gekocht'));
      else status = h('button', { class: 'primary', onclick: (e) => claimDialog(it, base, reload, e.currentTarget) }, 'Ik koop dit');
    }
    return h('li', { class: 'item' + (claimed ? ' claimed' : '') },
      thumb(it),
      h('div', { class: 'body' },
        h('div', { class: 'title' }, it.title),
        it.price ? h('div', { class: 'price' }, money(it)) : null,
        it.note ? h('div', { class: 'note' }, it.note) : null,
        shopLink(it.url),
      ),
      h('div', { class: 'actions claim' }, status),
    );
  }

  function claimDialog(it, base, reload, anchor) { // anchor: the "Ik koop dit" button, confetti starts there
    const input = h('input', { required: true, maxlength: 60, value: store.get('name', ''), placeholder: 'Bijv. Tante Ans', autocomplete: 'name' });
    const dlg = h('dialog', { class: 'card' },
      h('form', { method: 'dialog', class: 'stack', onsubmit: async (e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        store.set('name', name);
        try {
          const r = await api('POST', `${base}/claim`, { name });
          const claims = store.get('claims', {}); claims[it.id] = r.token; store.set('claims', claims);
          dlg.close(); celebrate(anchor); toast('Afgestreept, top! 🎉'); reload();
        } catch (err) { toast(err.message, true); dlg.close(); reload(); }
      } },
        h('h2', { translate: 'no' }, t('"{0}" afstrepen', it.title)),
        h('label', {}, 'Je naam (zien andere gevers, niet degene van de lijst)', input),
        h('div', { class: 'row' },
          h('button', { class: 'primary', type: 'submit' }, 'Afstrepen'),
          h('button', { type: 'button', onclick: () => dlg.close() }, 'Annuleren')),
      ),
    );
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg); dlg.showModal(); input.focus();
  }

  // ---------- FAQ ----------
  // Written in Dutch; translations live in i18n-dict.js like all other UI text.
  const FAQ = [
    ['Algemeen', [
      ['wat', 'Wat is Wensenlijst?', 'Een plek om verlanglijstjes te maken en te delen. Familie en vrienden strepen af wat ze kopen, zodat niemand hetzelfde cadeau koopt. Degene van de lijst ziet niet wat er gekocht is, dus de verrassing blijft.'],
      ['account-nodig', 'Heb ik een account nodig?', 'Nee. Je maakt een lijst en krijgt meteen een link om te delen. Een account is optioneel: dan staan je lijsten en groepen op al je apparaten en kun je je wachtwoord herstellen.'],
      ['kosten', 'Kost het iets?', 'Nee. Wensenlijst is gratis, zonder advertenties en zonder tracking.'],
    ]],
    ['Lijsten en wensen', [
      ['wens-toevoegen', 'Hoe voeg ik een wens toe?', 'Plak een link naar het product in "Wens toevoegen". De naam, prijs en afbeelding worden dan automatisch opgehaald. Dat lukt bij de meeste winkels, maar niet bij allemaal; vul anders zelf aan wat ontbreekt.'],
      ['links', 'Wat is het verschil tussen de deellink en de beheerlink?', 'De deellink stuur je naar familie en vrienden: daarmee bekijken ze je lijst en strepen ze af. De beheerlink is geheim en is voor jou: daarmee voeg je wensen toe en pas je de lijst aan. Deel de beheerlink met niemand.'],
      ['beheerlink-kwijt', 'Ik ben mijn beheerlink kwijt. Wat nu?', 'Op het apparaat waarop je de lijst maakte staat hij onder "Mijn lijsten" op de startpagina. Met een account vind je je lijsten op al je apparaten. Lukt het niet, vraag het dan aan de beheerder van deze site.'],
      ['verwijderen', 'Kan ik een lijst of wens verwijderen?', 'Ja. Een wens verwijder je met het kruisje op de beheerpagina, een hele lijst via "Lijstinstellingen" onderaan die pagina.'],
    ]],
    ['Cadeaus afstrepen', [
      ['afstrepen-zien', 'Ziet degene van de lijst wat er gekocht is?', 'Nee. Op de beheerpagina en op het eigen apparaat van de maker wordt verborgen wat er is afgestreept. Andere gevers zien het wel, zodat niemand iets dubbel koopt. Wie per se wil spieken kan de deellink in een privévenster openen: het is een verrassing, geen kluis.'],
      ['ongedaan', 'Ik heb per ongeluk iets afgestreept.', 'Geen probleem: bij de wens staat "ongedaan maken". Dat werkt op het apparaat waarmee je hebt afgestreept.'],
      ['naam', 'Moet ik mijn echte naam invullen bij het afstrepen?', 'Je naam is te zien voor andere gevers, niet voor degene van de lijst. Een bijnaam mag ook, zolang de anderen weten wie je bent.'],
    ]],
    ['Groepen', [
      ['groep-wat', 'Wat is een groep?', 'Een groep bundelt de lijsten van bijvoorbeeld de hele familie onder één link. Handig voor Sinterklaas of Kerst. Een lijst kan in meerdere groepen tegelijk zitten.'],
      ['groep-meedoen', 'Hoe voeg ik mijn lijst aan een groep toe?', 'Open de groeplink en kies "Mijn lijst toevoegen". Je kunt daar een bestaande lijst kiezen of meteen een nieuwe maken.'],
      ['groep-wachtwoord', 'Waarom vraagt een groep om een wachtwoord?', 'De maker van de groep heeft een wachtwoord ingesteld, zodat alleen genodigden het overzicht zien. Vraag het wachtwoord aan degene die je de link stuurde.'],
    ]],
    ['Account en privacy', [
      ['passkey', 'Wat is een passkey?', 'Met een passkey log je in met je vingerafdruk, gezicht of apparaatpincode in plaats van een wachtwoord. Dat is veiliger en makkelijker. Wil je inloggen op een computer die je passkey niet kan bereiken? Gebruik dan een koppelcode vanaf je telefoon.'],
      ['wachtwoord-vergeten', 'Ik ben mijn wachtwoord vergeten.', 'Kies "Wachtwoord vergeten?" bij het inloggen. Dat werkt als je een e-mailadres aan je account hebt gekoppeld. Heb je een passkey of een ander ingelogd apparaat, dan kun je daarmee ook inloggen en een nieuw wachtwoord instellen.'],
      ['gegevens', 'Welke gegevens worden bewaard?', 'Alleen wat je zelf invult: je lijsten, wensen, de namen bij het afstrepen en, als je een account hebt, je gebruikersnaam, je versleutelde wachtwoord en eventueel je e-mailadres. Er zijn geen advertenties of trackers; de enige cookie is die om ingelogd te blijven. Gegevens worden met niemand gedeeld.'],
    ]],
  ];
  function renderFaq() {
    document.title = t('Veelgestelde vragen') + ' · ' + t('Wensenlijst');
    const search = h('input', { type: 'search', placeholder: 'Zoek in de vragen…', 'aria-label': 'Zoek in de vragen…', autocomplete: 'off' });
    const empty = h('p', { class: 'muted center', hidden: true }, 'Geen vragen gevonden.');
    const sections = FAQ.map(([cat, qs]) => h('section', { class: 'faq-cat stack' },
      h('h2', {}, cat),
      h('div', { class: 'faq-list' }, qs.map(([id, q, a]) => h('details', { class: 'faq-item card', id },
        h('summary', {}, q),
        h('p', {}, a))))));
    search.addEventListener('input', () => {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      for (const sec of sections) {
        let any = false;
        for (const item of sec.querySelectorAll('.faq-item')) {
          const hit = words.every((w) => item.textContent.toLowerCase().includes(w));
          item.hidden = !hit; any = any || hit; if (hit) shown++;
          item.open = !!words.length && hit;
        }
        sec.hidden = !any;
      }
      empty.hidden = shown > 0;
    });
    render(
      h('section', { class: 'hero faq-hero' },
        h('div', { class: 'hero-gift', 'aria-hidden': 'true' }, '💬'),
        h('h1', {}, 'Veelgestelde vragen'),
        h('p', { class: 'muted' }, 'Alles over lijsten maken, afstrepen, groepen en je account.')),
      h('div', { class: 'faq-search' }, search),
      ...sections, empty,
      h('p', { class: 'center small' }, h('a', { href: '/' }, 'Naar de startpagina')),
    );
    // deep link: /faq#afstrepen-zien opens and scrolls to that question (also when only the # changes)
    const openHash = (delay) => {
      const target = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (target && target.classList.contains('faq-item')) { target.open = true; setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'center' }), delay); }
    };
    openHash(300);
    window.addEventListener('hashchange', () => openHash(0));
  }

  function renderError(msg) {
    document.title = 'Niet gevonden · Wensenlijst';
    render(h('section', { class: 'card stack center' },
      h('h1', {}, 'Oeps'), h('p', {}, msg || 'Deze pagina bestaat niet.'), h('p', {}, h('a', { href: '/' }, 'Naar de startpagina'))));
  }

  // ---------- router ----------
  const [, a, b, c] = location.pathname.split('/');
  await syncAccount();
  if (!a) renderHome();
  else if (a === 'account' && b === 'herstel' && c) renderReset(decodeURIComponent(c));
  else if (a === 'account') renderAccount();
  else if (a === 'faq') renderFaq();
  else if (a === 'beheer' && b) renderManage(decodeURIComponent(b));
  else if (a === 'l' && b) renderShare(decodeURIComponent(b), false);
  else if (a === 'g' && b) renderGroup(decodeURIComponent(b));
  else if (a === 'groep' && b) renderGroupManage(decodeURIComponent(b));
  else renderError();
})();
