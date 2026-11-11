// Return page for "Sign in with Cumulus ID" in the VEIL VPN apps. Only navigates; sends nothing.
(() => {
  const q = new URLSearchParams(location.search);
  const to = q.get('to') || '';
  const code = q.get('code') || '', state = q.get('state') || '';
  const $ = (id) => document.getElementById(id);
  const say = (h, p) => { $('msg').textContent = h; $('sub').textContent = p; };
  if (!code || !state) { say('Sign-in did not finish.', 'Open VEIL VPN and try again.'); return; }
  // Android app: hand the one-time code to the app over its own link scheme.
  const SCHEMES = ['veilvpn', 'veilvpn-debug'];
  if (SCHEMES.includes(to)) {
    const url = `${to}://cid?${new URLSearchParams({ code, state })}`;
    const a = $('open'); a.href = url; a.hidden = false;
    say('Signed in.', 'Tap Open VEIL VPN if the app did not open by itself.');
    location.replace(url);
    return;
  }
  // Browser extension: it watches for this page and closes the tab.
  say('Signed in.', 'You can close this tab and open VEIL VPN from the toolbar.');
})();
