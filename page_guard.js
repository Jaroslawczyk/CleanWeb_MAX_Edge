(() => {
  'use strict';
  const host = location.hostname;
  let lastGesture = 0;
  addEventListener('pointerdown', e => { if (e.isTrusted) lastGesture = Date.now(); }, true);
  addEventListener('keydown', e => { if (e.isTrusted) lastGesture = Date.now(); }, true);

  const suspicious = /(?:doubleclick\.net|googlesyndication\.com|googleadservices\.com|adnxs\.com|popads\.net|popcash\.net|propellerads|adsterra|onclicka|trafficjunky|exoclick|\/popunder\/|\/clickunder\/)/i;
  const originalOpen = window.open;
  try {
    window.open = function(url, ...rest) {
      const u = String(url ?? '');
      const recentGesture = Date.now() - lastGesture < 900;
      if (!recentGesture || suspicious.test(u)) return null;
      return originalOpen.call(this, url, ...rest);
    };
  } catch (_) {}

  try {
    const origBeacon = navigator.sendBeacon?.bind(navigator);
    if (origBeacon) navigator.sendBeacon = function(url, data) {
      const u = String(url || '');
      if (!host.endsWith('youtube.com') && suspicious.test(u)) return true;
      return origBeacon(url, data);
    };
  } catch (_) {}

  return; // YouTube: ничего не подменяем и не блокируем — иначе срабатывает антиблокировщик; рекламу скипает content.js

  const stripAdKeys = obj => {
    const BAD = new Set(['adPlacements','playerAds','adSlots','adBreakHeartbeatParams','adBreakParams','ad3Module']);
    const seen = new WeakSet();
    const walk = v => {
      if (!v || typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v)) { for (const x of v) walk(x); return; }
      for (const k of Object.keys(v)) {
        if (BAD.has(k)) { try { delete v[k]; } catch (_) { v[k]=undefined; } }
        else walk(v[k]);
      }
    };
    walk(obj); return obj;
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/\/(?:pagead|ptracking|api\/stats\/ads)(?:\/|\?|$)/i.test(url)) return new Response('', {status:204,statusText:'No Content'});
      const response = await originalFetch.call(this, input, init);
      if (!/\/youtubei\/v1\/player(?:\?|$)/i.test(url)) return response;
      try {
        const text = await response.clone().text();
        const data = stripAdKeys(JSON.parse(text));
        const headers = new Headers(response.headers); headers.delete('content-length'); headers.delete('content-encoding');
        return new Response(JSON.stringify(data), {status:response.status,statusText:response.statusText,headers});
      } catch (_) { return response; }
    };
  }
})();
