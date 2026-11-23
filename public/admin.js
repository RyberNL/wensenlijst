'use strict';
// Admin page. Admins are normal user accounts with the admin flag: log in on /account.
(() => {
  const app = document.getElementById('app');
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
  let entered = false;
  const render = (...kids) => {
    if (!entered) { entered = true; document.body.classList.add('entering'); setTimeout(() => document.body.classList.remove('entering'), 1400); }
    app.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  };
  async function api(method, url, body) {
    const res = await fetch('/api/admin/' + url, {
      method, credentials: 'same-origin',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-Lang': I18N.lang },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Er ging iets mis.');
    return data;
  }
  let toastTimer;
  function toast(msg, bad) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 3500);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Gekopieerd!'); } catch { prompt('Kopieer:', text); }
  }
  const fmtDate = (t) => new Date(t).toLocaleDateString(I18N.locale, { day: 'numeric', month: 'short', year: 'numeric' });
  const loginUrl = '/account?next=/admin';

  async function main() {
    let s;
    try { s = await api('GET', 'status'); } catch (e) { return render(h('p', {}, e.message)); }
    const link = document.getElementById('account-link');
    if (link) { link.textContent = s.loggedIn ? s.username : 'Inloggen'; if (!s.loggedIn) link.href = loginUrl; }
    if (!s.loggedIn) {
      return render(h('section', { class: 'card stack center' }, h('h1', {}, 'Beheer'),
        h('p', { class: 'muted' }, 'Log in met je account om de beheerpagina te gebruiken.'),
        h('div', {}, h('a', { class: 'btn primary', href: loginUrl }, 'Inloggen'))));
    }
    if (s.isAdmin) return renderAdmin();
    if (s.needsSetup) return renderSetup(s.username);
    render(h('section', { class: 'card stack center' }, h('h1', {}, 'Geen toegang'),
      h('p', {}, t('Je bent ingelogd als {0}, maar dat account is geen beheerder.', s.username)),
      h('div', {}, h('a', { class: 'btn', href: '/account' }, 'Naar mijn account'))));
  }

  function renderSetup(username) {
    const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 8, placeholder: '12345678', required: true });
    const btn = h('button', { class: 'primary', type: 'submit' }, t('{0} beheerder maken', username));
    render(h('form', { class: 'card stack', onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true;
      try { await api('POST', 'setup', { setupCode: code.value.trim() }); toast('Je bent nu beheerder'); renderAdmin(); }
      catch (err) { toast(err.message, true); btn.disabled = false; }
    } },
      h('h1', {}, 'Word beheerder'),
      h('p', {}, t('Er is nog geen beheerder. Maak je account ({0}) beheerder met de eenmalige setupcode uit de serverlog.', username)),
      h('p', { class: 'muted small' }, 'Bekijk die met ', h('code', {}, 'docker logs wensenlijst'), '.'),
      h('label', {}, 'Setupcode', code), btn));
    code.focus();
  }

  async function renderAdmin() {
    let lists, groups, users;
    try { [lists, groups, users] = await Promise.all([api('GET', 'lists'), api('GET', 'groups'), api('GET', 'users')]); }
    catch (e) { toast(e.message, true); return main(); }
    const o = location.origin;
    const rows = lists.map((l) => h('li', { class: 'adminrow card' },
      h('div', { class: 'body' },
        h('div', { class: 'title' }, l.title),
        h('div', { class: 'muted small' }, [l.owner && t('van {0}', l.owner), l.account && t('account {0}', l.account), fmtDate(l.createdAt), l.items === 1 ? t('1 wens') : t('{0} wensen', l.items)].filter(Boolean).join(' · ')),
      ),
      h('div', { class: 'row' },
        h('a', { class: 'btn', href: `/l/${l.id}`, target: '_blank', rel: 'noopener' }, 'Deellink'),
        h('button', { onclick: () => copy(`${o}/l/${l.id}`) }, 'Kopieer deellink'),
        h('a', { class: 'btn', href: `/beheer/${l.edit}`, target: '_blank', rel: 'noopener' }, 'Beheerlink'),
        h('button', { onclick: () => copy(`${o}/beheer/${l.edit}`) }, 'Kopieer beheerlink'),
        h('button', { class: 'danger', onclick: async () => {
          if (!confirm(t('Lijst "{0}" definitief verwijderen?', l.title))) return;
          try { await api('DELETE', `lists/${encodeURIComponent(l.id)}`); toast('Verwijderd'); renderAdmin(); } catch (e) { toast(e.message, true); }
        } }, 'Verwijderen'),
      ),
    ));
    const groupRows = groups.map((g) => h('li', { class: 'adminrow card' },
      h('div', { class: 'body' },
        h('div', { class: 'title' }, g.title, g.protected ? ' 🔒' : ''),
        h('div', { class: 'muted small' }, `${fmtDate(g.createdAt)} · ${g.members === 1 ? t('1 lijst') : t('{0} lijsten', g.members)}`),
      ),
      h('div', { class: 'row' },
        h('a', { class: 'btn', href: `/g/${g.id}`, target: '_blank', rel: 'noopener' }, 'Groeplink'),
        h('button', { onclick: () => copy(`${o}/g/${g.id}`) }, 'Kopieer groeplink'),
        h('a', { class: 'btn', href: `/groep/${g.edit}`, target: '_blank', rel: 'noopener' }, 'Beheerlink'),
        h('button', { onclick: () => copy(`${o}/groep/${g.edit}`) }, 'Kopieer beheerlink'),
        h('button', { class: 'danger', onclick: async () => {
          if (!confirm(t('Groep "{0}" verwijderen? De lijsten zelf blijven bestaan.', g.title))) return;
          try { await api('DELETE', `groups/${encodeURIComponent(g.id)}`); toast('Verwijderd'); renderAdmin(); } catch (e) { toast(e.message, true); }
        } }, 'Verwijderen'),
      ),
    ));
    const userRows = users.map((u) => h('li', { class: 'adminrow card' },
      h('div', { class: 'body' },
        h('div', { class: 'title' }, u.username, u.admin ? h('span', { class: 'badge' }, 'beheerder') : null, u.me ? h('span', { class: 'badge' }, 'jij') : null),
        h('div', { class: 'muted small' }, [u.email, t('sinds {0}', fmtDate(u.createdAt)), u.lists === 1 ? t('1 lijst') : t('{0} lijsten', u.lists),
          [u.hasPassword && t('wachtwoord'), u.passkeys && (u.passkeys === 1 ? t('1 passkey') : t('{0} passkeys', u.passkeys))].filter(Boolean).join(' + ')].filter(Boolean).join(' · ')),
      ),
      h('div', { class: 'row' },
        h('button', { onclick: async () => {
          if (!confirm(u.admin ? t('{0} geen beheerder meer maken?', u.username) : t('{0} beheerder maken? Diegene kan dan alle lijsten, groepen en accounts beheren.', u.username))) return;
          try { await api('PUT', `users/${encodeURIComponent(u.id)}/admin`, { admin: !u.admin }); toast('Opgeslagen'); u.me && u.admin ? main() : renderAdmin(); } catch (e) { toast(e.message, true); }
        } }, u.admin ? 'Beheerrechten intrekken' : 'Beheerder maken'),
        u.me ? null : h('button', { class: 'danger', onclick: async () => {
          if (!confirm(t('Account "{0}" verwijderen? De lijsten en groepen blijven bestaan.', u.username))) return;
          try { await api('DELETE', `users/${encodeURIComponent(u.id)}`); toast('Verwijderd'); renderAdmin(); } catch (e) { toast(e.message, true); }
        } }, 'Verwijderen'),
      ),
    ));
    render(
      h('section', { class: 'listhead row spread' }, h('h1', {}, t('Lijsten ({0})', lists.length)),
        h('a', { class: 'btn', href: '/account' }, 'Mijn account')),
      lists.length ? h('ul', { class: 'items' }, rows) : h('p', { class: 'muted' }, 'Nog geen lijsten.'),
      h('h2', {}, t('Groepen ({0})', groups.length)),
      groups.length ? h('ul', { class: 'items' }, groupRows) : h('p', { class: 'muted' }, 'Nog geen groepen.'),
      h('details', { class: 'card settings' }, h('summary', {}, t('Accounts ({0})', users.length)), h('ul', { class: 'items' }, userRows)),
      mailBox(),
      h('p', { class: 'muted small center' }, 'Je passkeys, wachtwoord en koppelcode beheer je op ', h('a', { href: '/account' }, 'je accountpagina'), '.'),
    );
  }

  function mailBox() {
    const box = h('details', { class: 'card settings' }, h('summary', {}, 'E-mail (SMTP)'), h('p', { class: 'muted' }, 'Laden…'));
    const load = async () => {
      let c; try { c = await api('GET', 'mail'); } catch (e) { return toast(e.message, true); }
      const f = {
        host: h('input', { value: c.host, placeholder: 'host.docker.internal' }),
        port: h('input', { type: 'number', min: 0, max: 65535, value: c.port || '', placeholder: 'standaard' }),
        secure: h('select', {}, [['none', 'Geen (alleen lokaal)'], ['starttls', 'STARTTLS (587)'], ['tls', 'TLS (465)']].map(([v, l]) => h('option', { value: v, selected: c.secure === v }, l))),
        verifyTls: h('input', { type: 'checkbox', checked: c.verifyTls }),
        user: h('input', { value: c.user, autocomplete: 'off' }),
        pass: h('input', { type: 'password', autocomplete: 'new-password', placeholder: c.hasPass ? '•••••• (ongewijzigd)' : '' }),
        from: h('input', { type: 'email', value: c.from, placeholder: 'wensenlijst@voorbeeld.nl' }),
        fromName: h('input', { value: c.fromName }),
      };
      const to = h('input', { type: 'email', placeholder: 'jij@voorbeeld.nl', 'aria-label': 'Testadres' });
      const form = h('form', { class: 'stack mailcfg', onsubmit: async (e) => {
        e.preventDefault();
        const body = { host: f.host.value, port: f.port.value, secure: f.secure.value, verifyTls: f.verifyTls.checked, user: f.user.value, pass: f.pass.value, from: f.from.value, fromName: f.fromName.value };
        try { await api('PUT', 'mail', body); toast('Opgeslagen'); load(); } catch (err) { toast(err.message, true); }
      } },
        h('p', { class: 'small muted' }, c.source === 'admin' ? 'Deze instellingen zijn hier aangepast en overschrijven die uit docker-compose.' : 'Standaardinstellingen uit docker-compose (SMTP_*). Opslaan overschrijft ze.'),
        h('div', { class: 'grid2' }, h('label', {}, 'Server', f.host), h('label', {}, 'Poort', f.port)),
        h('div', { class: 'grid2' }, h('label', {}, 'Beveiliging', f.secure), h('label', { class: 'check' }, f.verifyTls, 'Certificaat controleren')),
        h('div', { class: 'grid2' }, h('label', {}, 'Gebruikersnaam (optioneel)', f.user), h('label', {}, 'Wachtwoord', f.pass)),
        h('div', { class: 'grid2' }, h('label', {}, 'Afzenderadres', f.from), h('label', {}, 'Afzendernaam', f.fromName)),
        h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Opslaan'),
          c.source === 'admin' ? h('button', { type: 'button', onclick: async () => { await api('DELETE', 'mail'); toast('Terug naar docker-compose-instellingen'); load(); } }, 'Standaard herstellen') : null),
      );
      const test = h('form', { class: 'linkrow', onsubmit: async (e) => {
        e.preventDefault();
        const btn = test.querySelector('button'); btn.disabled = true;
        try { await api('POST', 'mail/test', { to: to.value }); toast('Testmail verstuurd'); } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
      } }, to, h('button', { type: 'submit' }, 'Testmail sturen'));
      box.replaceChildren(box.firstChild, h('div', { class: 'stack' }, form, h('p', { class: 'small' }, 'Testen (gebruikt de opgeslagen instellingen):'), test));
    };
    box.addEventListener('toggle', () => { if (box.open) load(); });
    return box;
  }

  main();
})();
