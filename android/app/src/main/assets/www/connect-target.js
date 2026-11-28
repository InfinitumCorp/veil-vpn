/**
 * Which server the Connect button should use, and the label on the bottom Connect tab.
 *
 * A location the user just picked wins. Otherwise Connect reuses the last connection
 * instead of failing or doing nothing. The first offered server is only a stand-in
 * when this device has never connected and the user has not picked one.
 */

export function connectTarget({ picked = false, selected = null, last = null, servers = [] } = {}) {
  const list = Array.isArray(servers) ? servers : [];
  const known = (id) => typeof id === 'string' && id.length > 0 && (list.length === 0 || list.some((s) => s && s.id === id));
  if (picked && known(selected)) return selected;
  if (known(last)) return last;
  const shown = list.find((s) => s && s.id && s.online !== false) || list.find((s) => s && s.id);
  return shown ? shown.id : null;
}

/** Bottom navigation label for the Connect tab. Layout stays the same; only the word tracks the tunnel. */
export function bottomConnectLabel(state) {
  if (state === 'on') return 'Connected';
  if (state === 'connecting' || state === 'error') return 'Connecting';
  return 'Connect';
}
