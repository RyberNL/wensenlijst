'use strict';
// Loaded without defer in <head> so the saved theme applies before first paint (no flash).
(() => {
  const root = document.documentElement;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch { /* private mode */ }
  if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
  const current = () => root.dataset.theme || (mq.matches ? 'dark' : 'light');

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const sync = () => {
      const label = current() === 'dark' ? 'Lichte modus' : 'Donkere modus';
      btn.setAttribute('aria-label', label);
      btn.title = label;
    };
    btn.addEventListener('click', () => {
      const next = current() === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch { /* ignore */ }
      sync();
    });
    mq.addEventListener('change', sync);
    sync();
  });
})();
