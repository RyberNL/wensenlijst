'use strict';
// Language runtime (loaded synchronously in <head>, after i18n-dict.js).
// - window.t(dutchKey, ...args) for texts with variables (used explicitly in app.js/admin.js);
// - fixed Dutch texts are translated automatically as they are added to the page;
// - a language menu in the header. Default language: Dutch.
(() => {
  const core = window.I18N_CORE;
  let lang = 'nl';
  try { lang = core.normalize(localStorage.getItem('lang')); } catch { /* storage blocked */ }
  document.documentElement.lang = lang;
  window.I18N = { lang, locale: core.LOCALES[lang] };
  window.t = (key, ...args) => core.t(lang, key, ...args);

  // Native dialogs get the same treatment.
  for (const fn of ['confirm', 'alert', 'prompt']) {
    const orig = window[fn].bind(window);
    window[fn] = (msg, ...rest) => orig(core.translateText(lang, String(msg)) || msg, ...rest);
  }

  if (lang !== 'nl') {
    // User content (list titles, wishes, notes…) is never translated.
    const SKIP = 'script, style, textarea, [translate="no"], .title, .note, .desc, .tile-title';
    const SKIP_ATTR = 'script, style, [translate="no"]'; // textarea/input placeholders are UI text
    const ATTRS = ['placeholder', 'title', 'aria-label'];
    const trText = (node) => {
      const v = node.nodeValue;
      const core_ = v.trim();
      if (!core_ || !/[A-Za-zÀ-ÿ]/.test(core_)) return;
      const parent = node.parentElement;
      if (!parent || parent.closest(SKIP)) return;
      const tr = core.translateText(lang, core_);
      if (tr && tr !== core_) node.nodeValue = v.replace(core_, () => tr);
    };
    const trAttrs = (el) => {
      if (el.closest(SKIP_ATTR)) return;
      for (const a of ATTRS) {
        const v = el.getAttribute(a);
        if (!v) continue;
        const tr = core.translateText(lang, v.trim());
        if (tr && tr !== v) el.setAttribute(a, tr);
      }
    };
    const walk = (root) => {
      if (root.nodeType === 3) return trText(root);
      if (root.nodeType !== 1) return;
      trAttrs(root);
      const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let n = it.nextNode(); n; n = it.nextNode()) (n.nodeType === 3 ? trText(n) : trAttrs(n));
    };
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes') trAttrs(m.target);
        else m.addedNodes.forEach(walk);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ATTRS });
    if (document.title) document.title = core.translateText(lang, document.title) || document.title;
    document.addEventListener('DOMContentLoaded', () => walk(document.body));
  }

  // ---------- language menu ----------
  function globe() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
    for (const d of ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'M3 12h18', 'M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3']) {
      const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.append(p);
    }
    return svg;
  }
  document.addEventListener('DOMContentLoaded', () => {
    const faq = document.getElementById('faq-link');
    if (faq && location.pathname === '/faq') faq.setAttribute('aria-current', 'page');
    const host = document.querySelector('.top-actions');
    if (!host) return;
    const wrap = document.createElement('div'); wrap.className = 'lang';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'lang-btn'; btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', `${window.t('Taal')}: ${core.LANGS[lang]}`); btn.title = window.t('Taal');
    const code = document.createElement('span'); code.textContent = lang.toUpperCase();
    btn.append(globe(), code);
    const menu = document.createElement('div'); menu.className = 'lang-menu'; menu.setAttribute('role', 'menu'); menu.hidden = true;
    for (const [k, name] of Object.entries(core.LANGS)) {
      const item = document.createElement('button');
      item.type = 'button'; item.setAttribute('role', 'menuitemradio'); item.setAttribute('aria-checked', String(k === lang));
      item.setAttribute('translate', 'no'); item.lang = k;
      const c = document.createElement('b'); c.textContent = k.toUpperCase();
      item.append(c, document.createTextNode(name));
      item.addEventListener('click', () => {
        if (k !== lang) { try { localStorage.setItem('lang', k); } catch { /* ignore */ } location.reload(); }
        close();
      });
      menu.append(item);
    }
    const open = () => { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); (menu.querySelector('[aria-checked="true"]') || menu.firstChild).focus(); };
    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', () => (menu.hidden ? open() : close()));
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => {
      if (menu.hidden) return;
      const items = [...menu.children], i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { close(); btn.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
    wrap.append(btn, menu);
    host.prepend(wrap);
  });
})();
