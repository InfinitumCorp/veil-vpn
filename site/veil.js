// Apps menu and the panels under the downloads (one open at a time; #how etc. open a panel directly).
(() => {
  const menuBtn = document.querySelector('[data-menu]');
  const menu = menuBtn && document.getElementById(menuBtn.dataset.menu);
  const setMenu = (open) => { if (!menu) return; menu.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); };
  menuBtn?.addEventListener('click', (e) => { e.stopPropagation(); setMenu(menu.hidden); });
  document.addEventListener('click', (e) => { if (menu && !menu.hidden && !menu.contains(e.target)) setMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
  const tabs = [...document.querySelectorAll('[data-panel]')];
  const show = (id) => tabs.forEach((b) => { const on = b.dataset.panel === id; b.setAttribute('aria-expanded', String(on)); document.getElementById(b.dataset.panel).hidden = !on; });
  tabs.forEach((b) => b.addEventListener('click', () => show(b.getAttribute('aria-expanded') === 'true' ? null : b.dataset.panel)));
  const open = () => { const id = location.hash.slice(1); if (tabs.some((b) => b.dataset.panel === id)) show(id); };
  addEventListener('hashchange', open); open();
})();
