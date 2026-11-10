(() => {
  const API = globalThis.chrome;
  if (!API?.storage?.local) return;

  let enabled = true;
  let sponsorEnabled = true;
  let styleNode = null;
  let scheduled = false;
  let youtubeAdState = null;
  let sponsorVideoId = '';
  let sponsorSegments = [];
  let lastSponsorRequest = 0;

  const STYLE = `
  [data-cleanweb-hidden="1"],
  [id^="google_ads_"], [id^="div-gpt-ad"], [id*="google-ad" i], [id*="google_ad" i],
  [class~="adsbygoogle"], [class*="ad-slot" i], [class*="ad_slot" i], [class*="ad-container" i], [class*="ad_container" i],
  [class*="advertisement" i], [class*="advert-container" i], [class*="advertising" i],
  [data-ad], [data-ad-slot], [data-ad-unit], [data-adunit], [data-ad-client], [data-testid*="ad-slot" i],
  iframe[src*="doubleclick.net"], iframe[src*="googlesyndication.com"], iframe[src*="googleadservices.com"], iframe[src*="adnxs.com"],
  amp-ad, amp-embed[type="taboola"], amp-embed[type="outbrain"],
  .taboola, [id^="taboola-"], [class*="taboola" i], .OUTBRAIN, [class*="outbrain" i],
  ytd-display-ad-renderer, ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-promoted-sparkles-web-renderer,
  ytd-promoted-video-renderer, ytd-search-pyv-renderer, ytd-banner-promo-renderer, ytd-statement-banner-renderer,
  ytd-player-legacy-desktop-watch-ads-renderer, ytd-engagement-panel-section-list-renderer[target-id*="ads" i],
  #player-ads, #masthead-ad, .ytp-ad-module, .ytp-ad-overlay-container, .ytp-ad-player-overlay, .ytp-ad-image-overlay,
  .ytp-ad-text-overlay, .ytp-ad-progress-list, .video-ads, .ytp-ad-survey, .ytp-ad-action-interstitial,
  shreddit-ad-post, [data-promoted="true"], [data-testid="ad"], [data-testid="promoted-post"],
  [aria-label="Sponsored"], [aria-label="Реклама"], [aria-label="Sponsorowane"] {
    display: none !important; visibility: hidden !important; opacity: 0 !important;
    width: 0 !important; height: 0 !important; min-width: 0 !important; min-height: 0 !important;
    margin: 0 !important; padding: 0 !important; border: 0 !important; pointer-events: none !important;
  }
  html.cleanweb-unlocked, html.cleanweb-unlocked body { overflow: auto !important; }
  `;

  const TRACK_PARAMS = new Set(['gclid','dclid','fbclid','msclkid','yclid','_ga','_gl','mc_cid','mc_eid','igshid','vero_id','wickedid','s_cid','rb_clickid','ttclid','twclid','gbraid','wbraid']);
  const AD_TEXT = new Set(['ad','ads','advertisement','advertising','sponsored','promoted','paid partnership','реклама','рекламный','спонсор','спонсируемое','промо','sponsorowane','reklama','promowane']);
  const antiAdblockRe = /(disable|turn off|remove|whitelist).{0,35}(ad.?block|ad blocker)|(ad.?block|ad blocker).{0,35}(detected|enabled|wyłącz|отключ|обнаруж)|(wyłącz|wyłacz).{0,25}(adblock|blokad)|(отключите|выключите).{0,30}(adblock|блокировщик)/i;

  // YouTube: прячем ТОЛЬКО рекламу в ленте/на странице. Рекламу внутри плеера не трогаем и не ускоряем —
  // иначе сервер видит «непросмотренную» рекламу и отдаёт 403 на видеопоток / показывает стену.
  const IS_YT = location.hostname.endsWith('youtube.com');
  const YT_STYLE = `ytd-display-ad-renderer, ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-promoted-sparkles-web-renderer,
  ytd-promoted-video-renderer, ytd-search-pyv-renderer, ytd-banner-promo-renderer, #masthead-ad { display: none !important; }`;
  function enableStyle() {
    if (styleNode || !document.documentElement) return;
    styleNode = document.createElement('style'); styleNode.id = 'cleanweb-max-style'; styleNode.textContent = IS_YT ? YT_STYLE : STYLE;
    document.documentElement.appendChild(styleNode);
  }
  function disableStyle() { styleNode?.remove(); styleNode = null; document.documentElement?.classList.remove('cleanweb-unlocked'); }
  function markHidden(el, reason='ad') {
    if (!enabled || !el || el.nodeType !== 1 || el === document.documentElement || el === document.body) return;
    el.setAttribute('data-cleanweb-hidden','1'); el.setAttribute('data-cleanweb-reason', reason);
  }

  function cleanUrl(raw) {
    try {
      const u = new URL(raw, location.href); let changed = false;
      for (const key of [...u.searchParams.keys()]) {
        if (key.toLowerCase().startsWith('utm_') || TRACK_PARAMS.has(key.toLowerCase())) { u.searchParams.delete(key); changed = true; }
      }
      return changed ? u.href : raw;
    } catch (_) { return raw; }
  }
  function sanitizeCurrentUrl() {
    try { const cleaned = cleanUrl(location.href); if (cleaned !== location.href) history.replaceState(history.state, '', cleaned); } catch (_) {}
  }
  document.addEventListener('click', e => {
    if (!enabled) return;
    const a = e.target?.closest?.('a[href]'); if (!a) return;
    const cleaned = cleanUrl(a.href); if (cleaned !== a.href) a.href = cleaned;
  }, true);

  function siteSpecific(root=document) {
    const host = location.hostname.replace(/^www\./,'');
    const selectors = [];
    if (host.endsWith('reddit.com')) selectors.push('shreddit-ad-post','[data-promoted="true"]','[data-testid="promoted-post"]');
    if (host.endsWith('linkedin.com')) selectors.push('[data-view-name="feed-ad"]','.ad-banner-container','.feed-shared-update-v2:has(span[aria-label*="Promoted" i])');
    if (host.endsWith('instagram.com')) selectors.push('article:has(span[aria-label="Sponsored"])');
    if (host.endsWith('facebook.com')) selectors.push('[role="article"]:has(a[href*="/ads/"])');
    if (host.endsWith('x.com') || host.endsWith('twitter.com')) selectors.push('article:has([data-testid="placementTracking"]):has(span)');
    if (host.endsWith('twitch.tv')) selectors.push('[data-a-target="video-ad-label"]','[data-test-selector="sad-overlay"]');
    for (const s of selectors) { try { root.querySelectorAll?.(s).forEach(el => markHidden(el,'site-ad')); } catch (_) {} }
  }

  function textAdHeuristics(root=document) {
    const host = location.hostname;
    if (!/(facebook|instagram|linkedin|reddit|twitter|x\.com|google\.|bing\.|yahoo\.)/i.test(host)) return;
    let nodes = [];
    try { nodes = root.querySelectorAll?.('span,small,label') || []; } catch (_) { return; }
    let checked = 0;
    for (const el of nodes) {
      if (++checked > 350) break;
      const t = (el.textContent || '').trim().toLowerCase();
      if (!t || t.length > 30 || !AD_TEXT.has(t)) continue;
      const box = el.closest('article,[role="article"],li,[data-testid="cellInnerDiv"],div[data-text-ad],div[data-content-feature]');
      if (box && box.textContent.length < 12000) markHidden(box,'label-ad');
    }
  }

  function antiAdblock() {
    if (!enabled || !document.body) return;
    const candidates = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal, .popup, [class*="overlay" i], [id*="overlay" i]')].slice(0,120);
    let hid = false;
    for (const el of candidates) {
      const txt = (el.innerText || el.textContent || '').replace(/\s+/g,' ').slice(0,1200);
      if (!antiAdblockRe.test(txt)) continue;
      let cs; try { cs = getComputedStyle(el); } catch (_) { continue; }
      const r = el.getBoundingClientRect();
      const overlayLike = ['fixed','sticky','absolute'].includes(cs.position) || (r.width > innerWidth*.45 && r.height > innerHeight*.25);
      if (overlayLike) { markHidden(el,'anti-adblock'); hid = true; }
    }
    if (hid) document.documentElement.classList.add('cleanweb-unlocked');
  }

  function getVideoId() {
    try {
      const u = new URL(location.href);
      if (u.pathname === '/watch') return u.searchParams.get('v') || '';
      const m = u.pathname.match(/^\/(?:shorts|live)\/([A-Za-z0-9_-]{6,20})/); return m ? m[1] : '';
    } catch (_) { return ''; }
  }
  function loadSponsorSegments() {
    if (!enabled || !sponsorEnabled || !location.hostname.endsWith('youtube.com')) return;
    const id = getVideoId(); if (!id || id === sponsorVideoId || Date.now()-lastSponsorRequest < 1000) return;
    sponsorVideoId = id; sponsorSegments = []; lastSponsorRequest = Date.now();
    try { API.runtime.sendMessage({type:'getSponsorSegments',videoID:id}, res => { if (sponsorVideoId === id && res && Array.isArray(res.segments)) sponsorSegments = res.segments; }); } catch (_) {}
  }
  function skipSponsor(video) {
    if (!enabled || !sponsorEnabled || !video || !sponsorSegments.length) return;
    const t = video.currentTime;
    for (const s of sponsorSegments) {
      const a = Number(s.segment?.[0]), b = Number(s.segment?.[1]);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || b-a > 900) continue;
      if (t >= a && t < b - 0.08 && (!Number.isFinite(video.duration) || b <= video.duration + 2)) {
        try { video.currentTime = b + 0.03; } catch (_) {}
        break;
      }
    }
  }

  function restoreYoutubeVideo(video) {
    if (!youtubeAdState || !video) return;
    try { video.playbackRate = youtubeAdState.rate; } catch (_) {}
    try { video.muted = youtubeAdState.muted; } catch (_) {}
    try { video.volume = youtubeAdState.volume; } catch (_) {}
    youtubeAdState = null;
  }

  let ytFallbackFor = '';
  let ytMainDuration = 0;
  let ytLastKill = 0;
  addEventListener('yt-navigate-start', () => { ytMainDuration = 0; youtubeAdState = null; }, true);
  addEventListener('yt-navigate-finish', () => { ytMainDuration = 0; }, true);
  let ytBlockedSince = 0;
  const WALL_RE = /(блокировщик\w* рекламы нарушают|ad blockers? violate|Ad blockers? are not allowed|Условия использования YouTube)/i;
  function ytFindWall() {
    const known = document.querySelector('ytd-enforcement-message-view-model, yt-playability-error-supported-renderers, #error-screen');
    if (known && WALL_RE.test(known.innerText || known.textContent || '')) return known;
    if (known && known.tagName === 'YTD-ENFORCEMENT-MESSAGE-VIEW-MODEL') return known;
    for (const d of document.querySelectorAll('tp-yt-paper-dialog, ytd-popup-container tp-yt-paper-dialog, #player, #player-container-outer, ytd-player')) {
      const t = (d.innerText || '').slice(0, 800);
      if (WALL_RE.test(t) && /(рекл|ads?)/i.test(t)) return d;
    }
    return null;
  }
  function ytEmbedFallback(video) {
    const id = getVideoId();
    if (!id || ytFallbackFor === id) return;
    ytFallbackFor = id;
    const host = document.querySelector('#player-container-outer, #player-container, #player, ytd-player') || document.querySelector('#movie_player')?.parentElement;
    if (!host) return;
    let t = 0; try { t = Math.floor(+(new URL(location.href).searchParams.get('t') || '0').replace(/s$/, '') || 0); } catch (_) {}
    const f = document.createElement('iframe');
    f.id = 'cleanweb-embed';
    f.src = 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0&start=' + t;
    f.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media';
    f.allowFullscreen = true;
    f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;z-index:2147483000;background:#000';
    try { if (getComputedStyle(host).position === 'static') host.style.position = 'relative'; } catch (_) {}
    host.appendChild(f);
    try { video && video.pause(); } catch (_) {}
  }
  function ytKillEnforcement(video) {
    if (!enabled) return;
    const now = Date.now(); if (now - ytLastKill < 500) return; ytLastKill = now;
    const wall = ytFindWall();
    if (!wall) { ytBlockedSince = 0; return; }
    if (!ytBlockedSince) ytBlockedSince = Date.now();
    const isHost = wall.id === 'player' || wall.id === 'player-container-outer' || wall.tagName === 'YTD-PLAYER';
    if (!isHost) { try { wall.querySelectorAll('[aria-label*="Close" i],[aria-label*="Закры" i]').forEach(b => b.click()); } catch (_) {} }
    if (!isHost) { try { wall.remove(); } catch (_) {} }
    document.querySelectorAll('tp-yt-iron-overlay-backdrop').forEach(n => { try { n.remove(); } catch (_) {} });
    try { document.documentElement.style.overflow = ''; document.body.style.overflow = ''; document.body.removeAttribute('aria-hidden'); } catch (_) {}
    if (video && video.paused) { try { video.play(); } catch (_) {} }
    if (Date.now() - ytBlockedSince > 700 && (!video || video.paused || video.readyState < 2 || video.currentTime < 0.5)) ytEmbedFallback(video);
  }
  addEventListener('yt-navigate-start', () => { ytFallbackFor = ''; document.getElementById('cleanweb-embed')?.remove(); }, true);
  function handleYouTube() {
    if (!location.hostname.endsWith('youtube.com')) return;
    loadSponsorSegments();
    ytKillEnforcement(document.querySelector('video.html5-main-video, video'));
    const player = document.querySelector('.html5-video-player');
    const video = document.querySelector('video.html5-main-video, video');
    if (!enabled) { restoreYoutubeVideo(video); return; }

    // только класс плеера: остаточные .ytp-ad-* узлы в DOM остаются и без рекламы -> раньше это перематывало обычные видео в конец
    const adShowing = !!(player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')));

    const skipSelectors = '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, button.ytp-ad-skip-button-modern, [id^="skip-button"] button, .ytp-ad-overlay-close-button';
    document.querySelectorAll(skipSelectors).forEach(btn => { try { btn.click(); } catch (_) {} });

    if (adShowing && video) {
      if (!youtubeAdState) youtubeAdState = {rate:video.playbackRate||1, muted:video.muted, volume:video.volume};
      try { video.muted = true; } catch (_) {}
    } else {
      if (video && Number.isFinite(video.duration) && video.duration > 0) ytMainDuration = video.duration;
      restoreYoutubeVideo(video);
      skipSponsor(video);
    }
  }

  function scan(root=document) {
    if (!enabled) return;
    enableStyle(); siteSpecific(root); if (!IS_YT) textAdHeuristics(root); handleYouTube();
  }
  function scheduleScan(root=document) {
    if (scheduled) return; scheduled = true;
    queueMicrotask(() => { scheduled = false; scan(root); });
  }
  function start() {
    if (!document.documentElement) return setTimeout(start, 0);
    if (enabled) { enableStyle(); sanitizeCurrentUrl(); scan(document); }
    const observer = new MutationObserver(muts => {
      if (!enabled) return;
      let root = document;
      for (const m of muts) { for (const n of m.addedNodes) { if (n.nodeType === 1) { root = n; break; } } }
      scheduleScan(root);
    });
    observer.observe(document.documentElement,{childList:true,subtree:true});
    setInterval(() => { if (enabled) { antiAdblock(); handleYouTube(); } }, location.hostname.endsWith('youtube.com') ? 250 : 1400);
  }

  API.storage.local.get({enabled:true,sponsorBlock:true}, data => { enabled=data.enabled!==false; sponsorEnabled=data.sponsorBlock!==false; start(); });
  API.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.enabled) { enabled=changes.enabled.newValue!==false; if (enabled) { enableStyle(); scan(document); } else disableStyle(); }
    if (changes.sponsorBlock) sponsorEnabled=changes.sponsorBlock.newValue!==false;
  });
})();
