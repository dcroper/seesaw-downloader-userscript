// ==UserScript==
// @name         Seesaw Post Downloader
// @namespace    https://app.seesaw.me/
// @version      1.2.0
// @description  Adds a Download button to each Seesaw feed post. Saves every photo/video in its original format with the "date taken" set to the post date (EXIF for JPEGs, MP4/MOV header for videos).
// @match        https://app.seesaw.me/*
// @author       David Roper
// @license      MIT
// @homepageURL  https://github.com/dcroper/seesaw-downloader-userscript
// @supportURL   https://github.com/dcroper/seesaw-downloader-userscript/issues
// @downloadURL  https://raw.githubusercontent.com/dcroper/seesaw-downloader-userscript/main/seesaw-downloader.user.js
// @updateURL    https://raw.githubusercontent.com/dcroper/seesaw-downloader-userscript/main/seesaw-downloader.user.js
// @require      https://cdn.jsdelivr.net/npm/piexifjs@1.0.6/piexif.js
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      seesaw.me
// @connect      amazonaws.com
// @connect      cloudfront.net
// @connect      *
// @run-at       document-start
// ==/UserScript==

/* global piexif */
(function () {
  'use strict';

  // ------------------------------------------------------------------ config
  const CONFIG = {
    filePrefix: 'seesaw',
    pageWaitMs: 8000, // max wait for a carousel page / video to load
    debug: false,
  };

  const log = (...a) => CONFIG.debug && console.log('[SSDL]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------ selectors
  const SEL = {
    post: 'article.ss-feed-item--content',
    footer: '[data-testid=":feed-item-footer"] .sp-item-footer',
    date: '.sp-item-footer-container .sp-row-col-right-fixed .ss-text-caption--darkgray',
    page: '[data-testid^=":item-item_page."]',
    watchVideo: '[data-testid=":watch-video"]',
    next: '[data-testid=":next-page"]',
    prev: '[data-testid=":prev-page"]',
    indicator: '[data-testid=":page-indicator"]',
  };

  // ------------------------------------------------------------ UI
  let lastCount = -1;
  function addButtons() {
    resetStaleButtons();
    const posts = document.querySelectorAll(SEL.post);
    if (posts.length !== lastCount) {
      lastCount = posts.length;
      console.log(`[SSDL] ${posts.length} post(s) found on ${location.href}`);
    }
    posts.forEach((article) => {
      // Preferred spot: next to Like/Comment. Fallbacks keep the button visible
      // even if that inner footer hasn't rendered or its markup changes.
      const footer = article.querySelector(SEL.footer) ||
        article.querySelector('[data-testid=":feed-item-footer"]') ||
        article.querySelector('.sp-item-footer-container') ||
        article;
      if (article.querySelector('.ssdl-btn')) return;
      const pages = getPageCount(article);
      const makeBtn = (label, aria, mode) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn ss-feed-item-footer__btn ssdl-btn';
        btn.setAttribute('aria-label', aria);
        btn.textContent = label;
        btn.dataset.label = label;
        btn.style.marginLeft = '4px';
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (btn.disabled) return;
          downloadPost(article, btn, mode);
        });
        return btn;
      };
      const btns = pages > 1
        ? [makeBtn('⬇ Download', 'Download the photo or video on the page currently shown', 'current'),
          makeBtn(`⬇ Download All (${pages})`, `Download all ${pages} pages of this post`, 'all')]
        : [makeBtn('⬇ Download', 'Download the photo or video in this post', 'all')];
      const clearDiv = footer.querySelector(':scope > div[style*="clear"]');
      btns.forEach((b) => footer.insertBefore(b, clearDiv || null));
    });
  }

  let pending = false;
  function startUi() {
    console.log('[SSDL] Seesaw Post Downloader loaded', typeof GM_info !== 'undefined' ? GM_info.script.version : '');
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; addButtons(); }, 300);
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      // Flipping pages updates the "1 / 18" text and the page element's
      // data-testid / image src in place, so childList alone misses it.
      characterData: true,
      attributes: true,
      attributeFilter: ['data-testid', 'src'],
    });
    // Also react immediately to clicks/keys/swipes that may change the page.
    const soon = () => { setTimeout(resetStaleButtons, 50); setTimeout(resetStaleButtons, 400); };
    document.addEventListener('click', soon, true);
    document.addEventListener('keyup', soon, true);
    document.addEventListener('touchend', soon, true);
    setInterval(addButtons, 2000); // safety net if mutations are missed
    addButtons();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startUi, { once: true });
  else startUi();

  // ------------------------------------------------------------ Seesaw API
  // Record the query params the app itself sends (_xsrf, _release, user_id, …)
  // so our own /api/item_v2 calls look exactly like the app's.
  const apiParams = {};
  function recordParams(url) {
    const u = new URL(url, location.href);
    if (u.origin !== location.origin || !u.pathname.startsWith('/api/')) return;
    for (const k of ['_bundle', '_release', '_tz_offset', '_xsrf', 'user_id']) {
      const v = u.searchParams.get(k);
      if (v) apiParams[k] = v;
    }
  }
  try {
    const XHR = unsafeWindow.XMLHttpRequest;
    const origOpen = XHR.prototype.open;
    XHR.prototype.open = function (method, url) {
      try { recordParams(String(url)); } catch (_) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };
    const origFetch = unsafeWindow.fetch;
    if (origFetch) {
      unsafeWindow.fetch = function (input) {
        try { recordParams(typeof input === 'string' ? input : input.url); } catch (_) { /* ignore */ }
        return origFetch.apply(this, arguments);
      };
    }
  } catch (e) {
    console.warn('[SSDL] could not hook requests', e);
  }

  /** Full post incl. every page (the feed only carries page 1). */
  async function fetchItemV2(itemId, shareToken) {
    const p = {
      _bundle: 'me.see-saw.web_magiccam',
      _tz_offset: String(-new Date().getTimezoneOffset() * 60),
      ...apiParams,
    };
    if (!p._xsrf) {
      const m = document.cookie.match(/(?:^|;\s*)_xsrf=([^;]+)/);
      if (m) p._xsrf = m[1];
    }
    const u = new URL('/api/item_v2', location.origin);
    Object.entries(p).forEach(([k, v]) => u.searchParams.set(k, v));
    u.searchParams.set('item_id', itemId);
    if (shareToken) u.searchParams.set('share_token', shareToken);
    const r = await fetch(u.href, { credentials: 'include' });
    const j = await r.json();
    if (j.status !== 'OK' || !j.response || !j.response.item) {
      throw new Error(`item_v2 ${r.status} ${j.status || ''} ${JSON.stringify(j.error_dict || {})}`);
    }
    return j.response.item;
  }

  // ------------------------------------------------------------ main flow
  /** mode: 'all' = every page of the post, 'current' = only the page on screen. */
  async function downloadPost(article, btn, mode = 'all') {
    const setStatus = (t) => { btn.textContent = t; };
    btn.disabled = true;
    try {
      setStatus('Finding media…');
      // Capture which page is on screen before any await, in case it changes.
      const shownPage = currentPage(article);
      const shownPageId = shownPage ? (shownPage.dataset.testid || '').replace(/^:item-/, '') : '';
      const shownPageNo = pageIndex(article);
      const feedItem = getAngularItem(article);
      // The feed only carries page 1 of each post; /api/item_v2 returns every
      // page (photos and videos, in order). Fall back to feed data / carousel.
      let item = feedItem;
      if (feedItem && feedItem.item_id) {
        try {
          item = await fetchItemV2(feedItem.item_id, feedItem.share_token);
          log('item_v2', item);
        } catch (e) {
          console.warn('[SSDL] item_v2 failed, falling back', e);
        }
      }
      const date = getPostDate(article, item);
      if (!date) throw new Error('Could not determine the post date');

      // Each page yields its video(s) if it has any, else its image, so mixed
      // photo/video posts come out in page order.
      const expected = (item && item.num_pages) || getPageCount(article);
      const dataPages = (item && item.pages && item.pages.objects) || [];
      let media;
      if (mode === 'current') {
        let idx = dataPages.findIndex((p) => p.item_page_id === shownPageId);
        if (idx < 0 && dataPages.length >= expected) idx = shownPageNo - 1;
        if (idx >= 0 && dataPages[idx]) {
          media = pageMedia(dataPages[idx], idx + 1);
        } else if (shownPage) {
          media = await mediaFromDomPage(article, shownPage, shownPageNo);
        } else {
          media = [];
        }
        log('current page', shownPageNo, media);
      } else {
        const fromData = item ? extractMediaFromItem(item) : [];
        const dataComplete = item && dataPages.length >= expected &&
          (!item.has_canvas_videos || fromData.some((m) => m.kind === 'video'));
        if (dataComplete) {
          media = fromData;
          log('using item data', media);
        } else {
          log('walking carousel; data pages', dataPages.length, 'of', expected);
          media = mergeMedia([], await collectByPaging(article, setStatus, expected));
        }
      }
      if (!media.length) throw new Error('No photos or videos found');
      numberMedia(media);

      const base = baseName(date, item);
      const files = [];
      const errors = [];
      for (let i = 0; i < media.length; i++) {
        setStatus(`Downloading ${i + 1}/${media.length}…`);
        try {
          files.push(await fetchAndStamp(media[i], date, base));
        } catch (err) {
          console.error('[SSDL] failed', media[i], err);
          errors.push(`#${i + 1}: ${err.message}`);
        }
      }

      if (files.length) {
        setStatus('Saving…');
        await saveFiles(files);
      }
      if (errors.length) {
        setStatus(`⚠ ${files.length}/${media.length} saved`);
        alert(`Seesaw downloader: ${errors.length} item(s) failed:\n` + errors.join('\n'));
      } else {
        setStatus(`✓ ${files.length} saved`);
      }
    } catch (err) {
      console.error('[SSDL]', err);
      setStatus('⚠ Failed');
      alert('Seesaw downloader: ' + err.message);
    } finally {
      btn.disabled = false;
      // Show the result until the user flips to another page (checked in
      // addButtons on every DOM change) or for 6 s, whichever comes first.
      btn.dataset.donePage = pageKey(article);
      clearTimeout(btn._ssdlTimer);
      btn._ssdlTimer = setTimeout(() => resetButton(btn), 6000);
    }
  }

  /** Identifies the page currently shown in a post's carousel. */
  function pageKey(article) {
    const p = currentPage(article);
    return `${p ? p.dataset.testid : ''}|${pageIndex(article)}`;
  }

  function resetButton(btn) {
    if (btn.disabled) return; // a new download is running
    clearTimeout(btn._ssdlTimer);
    delete btn.dataset.donePage;
    btn.textContent = btn.dataset.label || '⬇ Download';
  }

  /** Resets "✓ 1 saved" labels as soon as the user navigates to another page. */
  function resetStaleButtons() {
    document.querySelectorAll('.ssdl-btn[data-done-page]').forEach((btn) => {
      const article = btn.closest(SEL.post);
      if (!article || pageKey(article) !== btn.dataset.donePage) resetButton(btn);
    });
  }

  // ------------------------------------------------------------ data sources
  /** AngularJS scope `item` (full post data incl. every page), if debug info is on. */
  function getAngularItem(article) {
    try {
      const ng = unsafeWindow.angular;
      if (!ng) return null;
      const content = article.querySelector('ss-feed-item-content');
      const iso = content && ng.element(content).isolateScope();
      if (iso && iso.item) return iso.item;
      let s = ng.element(article).scope();
      while (s && !s.item) s = s.$parent;
      return s ? s.item : null;
    } catch (e) {
      log('no angular scope', e);
      return null;
    }
  }

  const MEDIA_RE = /^https?:\/\/[^\s"'<>]+?\.(jpe?g|png|gif|webp|heic|mp4|mov|m4v|webm)(?=$|[?#]|:::)/i;
  const VIDEO_EXT = /^(mp4|mov|m4v|webm)$/i;
  // Branches of the post object that hold people/avatars/comments, not post content.
  const SKIP_KEYS = /^\$|author|person|people|profile|avatar|liked|seen|comment|student|teacher|class|tag|folder|icon|thumb|poster|preview|creator|owner|user/i;

  /**
   * Media for one item_page. Videos sit in the page's click map:
   * composite_image_map.compositeImageMap[].actions[{action:'video', payload:{videoSrc}}].
   * A page with a video yields only the video (its composite image is the poster frame).
   */
  function pageMedia(p, pageNo) {
    const vids = [];
    const regions = p.composite_image_map && p.composite_image_map.compositeImageMap;
    (Array.isArray(regions) ? regions : []).forEach((r) => (r.actions || []).forEach((a) => {
      if (a && a.action === 'video' && a.payload && a.payload.videoSrc) vids.push({ url: a.payload.videoSrc, kind: 'video', page: pageNo });
    }));
    if (vids.length) return vids;
    const img = p.composite_image_url || p.composite_image_resizable_url;
    return img ? [{ url: img, kind: 'image', page: pageNo }] : [];
  }

  /** Map of item_page_id -> media, for whatever pages the item data currently holds. */
  function dataPagesById(item) {
    const m = new Map();
    const pages = (item && item.pages && item.pages.objects) || [];
    pages.forEach((p, i) => p.item_page_id && m.set(p.item_page_id, pageMedia(p, i + 1)));
    return m;
  }

  /**
   * Gives every media entry a page number (if it lacks one) and a sub-index for
   * pages holding more than one file, so names stay stable whether you download
   * one page or the whole post: page 3 is always "_03", a 2nd video on it "_03-2".
   */
  function numberMedia(media) {
    const perPage = new Map();
    media.forEach((m, i) => {
      if (!m.page) m.page = i + 1;
      const n = perPage.get(m.page) || 0;
      m.sub = n;
      perPage.set(m.page, n + 1);
    });
    return media;
  }

  function extractMediaFromItem(item) {
    // Known shape (from /api/item_v2 and the feed): item.pages.objects[]
    const pages = item.pages && item.pages.objects;
    if (Array.isArray(pages) && pages.length) {
      const fromPages = pages.flatMap((p, i) => pageMedia(p, i + 1));
      if (fromPages.length) return mergeMedia([], fromPages);
    }
    // Unknown shape: walk the object for media URLs.
    const out = [];
    const seen = new WeakSet();
    (function walk(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth > 8 || seen.has(obj)) return;
      seen.add(obj);
      const entries = Array.isArray(obj) ? obj.map((v, i) => [String(i), v]) : Object.entries(obj);
      const strings = entries.filter(([, v]) => typeof v === 'string' && MEDIA_RE.test(v));
      const vids = strings.filter(([, v]) => VIDEO_EXT.test(v.match(MEDIA_RE)[1]));
      // An object that owns a video: keep only the video (its images are posters).
      (vids.length ? vids : strings).forEach(([k, v]) => {
        if (!Array.isArray(obj) && SKIP_KEYS.test(k)) return;
        out.push({ url: v, kind: VIDEO_EXT.test(v.match(MEDIA_RE)[1]) ? 'video' : 'image' });
      });
      for (const [k, v] of entries) {
        if (v && typeof v === 'object' && (Array.isArray(obj) || !SKIP_KEYS.test(k))) walk(v, depth + 1);
      }
    })(item, 0);
    return mergeMedia([], out);
  }

  function mediaKey(url) {
    const raw = unwrapImaging(url);
    const m = raw.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return m ? m[1].toLowerCase() : raw.split(/:::|[?#]/)[0];
  }

  function mergeMedia(a, b) {
    const seen = new Set();
    return [...a, ...b].filter((m) => {
      const k = mediaKey(m.url);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  function unwrapImaging(url) {
    try {
      const u = new URL(url);
      if (u.hostname === 'imaging.seesaw.me' && u.searchParams.get('url')) return u.searchParams.get('url');
    } catch (_) { /* not a URL */ }
    return url;
  }

  function getPageCount(article) {
    const ind = article.querySelector(SEL.indicator);
    const m1 = ind && ind.textContent.match(/\/\s*(\d+)/);
    if (m1) return +m1[1];
    const m2 = (article.getAttribute('aria-label') || '').match(/(\d+)\s+pages?/i);
    return m2 ? +m2[1] : 1;
  }

  // ------------------------------------------------------------ carousel walk
  function currentPage(article) {
    const pages = [...article.querySelectorAll(SEL.page)];
    if (pages.length <= 1) return pages[0] || null;
    // Several rendered (prefetch): pick the one most inside the post's viewport.
    const boxEl = article.querySelector('[data-testid=":open-item-modal"]');
    if (!boxEl) return pages[0];
    const box = boxEl.getBoundingClientRect();
    const overlap = (el) => {
      const r = el.getBoundingClientRect();
      return Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left));
    };
    return pages.sort((x, y) => overlap(y) - overlap(x))[0];
  }

  function pageIndex(article) {
    const ind = article.querySelector(SEL.indicator);
    const m = ind && ind.textContent.match(/(\d+)\s*\//);
    return m ? +m[1] : 1;
  }

  async function waitFor(fn, timeout = CONFIG.pageWaitMs, step = 150) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  function forceClick(el) {
    const o = { bubbles: true, cancelable: true, view: window, buttons: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }

  async function collectByPaging(article, setStatus, knownTotal) {
    const total = knownTotal || getPageCount(article);
    const out = [];

    // Rewind to page 1.
    for (let guard = 0; pageIndex(article) > 1 && guard < 200; guard++) {
      const prev = article.querySelector(SEL.prev);
      if (!prev) break;
      const before = pageIndex(article);
      forceClick(prev);
      await waitFor(() => pageIndex(article) !== before, 3000);
    }

    for (let i = 1; i <= total; i++) {
      setStatus(`Scanning page ${i}/${total}…`);
      const page = await waitFor(() => {
        const p = currentPage(article);
        return p && (p.querySelector('img[src^="http"]') || p.parentElement.querySelector(SEL.watchVideo)) ? p : null;
      });
      if (page) {
        out.push(...await mediaFromDomPage(article, page, i));
      }
      if (i < total) {
        const next = article.querySelector(SEL.next);
        if (!next) break;
        const beforeId = page && page.dataset.testid;
        const beforeIdx = pageIndex(article);
        forceClick(next);
        await waitFor(() => {
          const p = currentPage(article);
          return pageIndex(article) !== beforeIdx || (p && p.dataset.testid !== beforeId);
        });
        await sleep(250);
      }
    }
    return out;
  }

  /**
   * Media for one rendered carousel page. Prefers the item data for that page
   * (the app may load more pages into it as you flip through); falls back to
   * what the DOM shows.
   */
  async function mediaFromDomPage(article, page, pageNo) {
    const pageId = (page.dataset.testid || '').replace(/^:item-/, '');
    const known = dataPagesById(getAngularItem(article)).get(pageId);
    if (known && known.length) return known.map((m) => ({ ...m, page: pageNo }));
    const video = page.parentElement.querySelector(SEL.watchVideo);
    if (video) {
      const src = await grabVideoSrc(article, video);
      if (src) return [{ url: src, kind: 'video', page: pageNo }];
      console.warn('[SSDL] could not get video URL on page', pageNo);
      return [];
    }
    const img = page.querySelector('img[src^="http"]');
    return img ? [{ url: img.src, kind: 'image', fallback: img.src, page: pageNo }] : [];
  }

  async function grabVideoSrc(article, trigger) {
    const findSrc = () => {
      const vids = [...article.querySelectorAll('video'), ...document.querySelectorAll('[role="dialog"] video')];
      for (const v of vids) {
        const s = v.currentSrc || v.src || (v.querySelector('source') || {}).src;
        if (s && /^https?:/.test(s)) return { v, s };
      }
      return null;
    };
    let found = findSrc();
    if (!found) {
      forceClick(trigger);
      found = await waitFor(findSrc);
    }
    if (!found) return null;
    try { found.v.pause(); } catch (_) { /* ignore */ }
    return found.s;
  }

  // ------------------------------------------------------------ date
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const DATE_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s*(\d{4})?(?:\s*(?:at\s*)?(\d{1,2}):(\d{2})\s*([AP]M)?)?/i;

  function parseDateText(text) {
    const m = text && text.match(DATE_RE);
    if (!m) return null;
    const now = new Date();
    let h = m[4] ? +m[4] : 12;
    const min = m[5] ? +m[5] : 0;
    if (m[6]) {
      const pm = m[6].toUpperCase() === 'PM';
      if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
    }
    let year = m[3] ? +m[3] : now.getFullYear();
    let d = new Date(year, MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2], h, min, 0);
    if (!m[3] && d > now) d.setFullYear(year - 1); // "Dec 30" seen in January
    return d;
  }

  function getPostDate(article, item) {
    // Best: item.create_date = Unix epoch seconds (e.g. 1791340264.4395347).
    if (item && typeof item.create_date === 'number' && item.create_date > 1e9) {
      return new Date(Math.round(item.create_date * 1000));
    }
    // Fallback: the footer's "Oct 6, 2026 7:37 PM" text (local time, minute precision).
    const el = article.querySelector(SEL.date);
    const fromDom = parseDateText(el && el.textContent.trim());
    if (fromDom) return fromDom;
    // Last resort: any date-looking text in the footer.
    const footer = article.querySelector('.sp-item-footer-container');
    return parseDateText(footer && footer.textContent);
  }

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const exifDate = (d) => `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const nameDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  /** e.g. "seesaw_2026-10-06_193104_931d19e1" — date sorts chronologically, post id keeps it unique. */
  function baseName(date, item) {
    const m = item && typeof item.item_id === 'string' && item.item_id.match(/([0-9a-f]{8})-/i);
    return `${CONFIG.filePrefix}_${nameDate(date)}${m ? '_' + m[1].toLowerCase() : ''}`;
  }

  // ------------------------------------------------------------ fetching
  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        timeout: 300000,
        onload: (r) => (r.status >= 200 && r.status < 300 && r.response
          ? resolve(r.response)
          : reject(new Error(`HTTP ${r.status}`))),
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  function candidates(m) {
    const raw = unwrapImaging(m.url);
    const viaImaging = 'https://imaging.seesaw.me/?url=' + encodeURIComponent(raw);
    const list = m.kind === 'video'
      ? [raw, m.url, viaImaging]
      : [raw, viaImaging, m.url, m.fallback]; // original file first; proxy may resize/re-encode
    return [...new Set(list.filter(Boolean))];
  }

  function sniff(buf) {
    const b = new Uint8Array(buf, 0, Math.min(16, buf.byteLength));
    const str = (s, e) => String.fromCharCode(...b.slice(s, e));
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
    if (b[0] === 0x89 && str(1, 4) === 'PNG') return 'png';
    if (str(0, 3) === 'GIF') return 'gif';
    if (str(0, 4) === 'RIFF' && str(8, 12) === 'WEBP') return 'webp';
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
    const box = str(4, 8);
    if (box === 'ftyp') {
      const brand = str(8, 12);
      if (/^(heic|heix|mif1|msf1)$/.test(brand)) return 'heic';
      return brand === 'qt  ' ? 'mov' : 'mp4';
    }
    if (['moov', 'mdat', 'wide', 'free'].includes(box)) return 'mov';
    return null;
  }

  async function fetchAndStamp(m, date, base) {
    let buf = null, type = null, lastErr = null;
    for (const url of candidates(m)) {
      try {
        const b = await gmGet(url);
        const t = sniff(b);
        if (!t) throw new Error('response is not an image/video');
        buf = b; type = t;
        log('fetched', url, type, b.byteLength);
        break;
      } catch (e) {
        lastErr = e;
        log('candidate failed', url, e.message);
      }
    }
    if (!buf) throw lastErr || new Error('download failed');

    let blob;
    if (type === 'jpg') {
      blob = stampJpeg(buf, date);
    } else if (type === 'mp4' || type === 'mov') {
      const n = patchMp4Dates(buf, date);
      if (!n) console.warn('[SSDL] no mvhd/tkhd/mdhd box found; video date not set');
      blob = new Blob([buf], { type: type === 'mov' ? 'video/quicktime' : 'video/mp4' });
    } else {
      console.warn(`[SSDL] ${type}: cannot embed date, saved as-is`);
      blob = new Blob([buf]);
    }
    const suffix = pad(m.page || 1) + (m.sub ? `-${m.sub + 1}` : '');
    return { blob, name: `${base}_${suffix}.${type}` };
  }

  // ------------------------------------------------------------ EXIF (JPEG)
  function abToBin(buf) {
    const u = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return s;
  }
  function binToU8(s) {
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
    return u;
  }

  function stampJpeg(buf, date) {
    const bin = abToBin(buf);
    let exif;
    try {
      exif = piexif.load(bin);
    } catch (_) {
      exif = {};
    }
    exif = { '0th': exif['0th'] || {}, Exif: exif.Exif || {}, GPS: exif.GPS || {}, Interop: exif.Interop || {}, '1st': {}, thumbnail: null };
    const ds = exifDate(date);
    exif['0th'][piexif.ImageIFD.DateTime] = ds;
    exif.Exif[piexif.ExifIFD.DateTimeOriginal] = ds;
    exif.Exif[piexif.ExifIFD.DateTimeDigitized] = ds;
    let out;
    try {
      out = piexif.insert(piexif.dump(exif), bin);
    } catch (e) {
      // Existing EXIF had tags piexif can't re-serialise: start clean.
      log('rebuilding EXIF', e);
      const fresh = { '0th': { [piexif.ImageIFD.DateTime]: ds }, Exif: { [piexif.ExifIFD.DateTimeOriginal]: ds, [piexif.ExifIFD.DateTimeDigitized]: ds }, GPS: {}, Interop: {}, '1st': {}, thumbnail: null };
      out = piexif.insert(piexif.dump(fresh), piexif.remove(bin));
    }
    return new Blob([binToU8(out)], { type: 'image/jpeg' });
  }

  // ------------------------------------------------------------ MP4/MOV
  /** Rewrites creation/modification time in mvhd, tkhd and mdhd in place. Returns boxes patched. */
  function patchMp4Dates(buf, date) {
    const dv = new DataView(buf);
    const t = Math.floor(date.getTime() / 1000) + 2082844800; // seconds since 1904-01-01 UTC
    const CONTAINERS = new Set(['moov', 'trak', 'mdia']);
    let patched = 0;
    const type4 = (p) => String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
    (function walk(start, end) {
      let p = start;
      while (p + 8 <= end) {
        let size = dv.getUint32(p);
        const type = type4(p + 4);
        let hdr = 8;
        if (size === 1) { size = dv.getUint32(p + 8) * 0x100000000 + dv.getUint32(p + 12); hdr = 16; } else if (size === 0) size = end - p;
        if (size < hdr || p + size > end) break;
        if (CONTAINERS.has(type)) {
          walk(p + hdr, p + size);
        } else if (type === 'mvhd' || type === 'tkhd' || type === 'mdhd') {
          const version = dv.getUint8(p + hdr);
          const o = p + hdr + 4;
          if (version === 1) {
            // 64-bit fields written as two 32-bit halves (no BigInt needed).
            const hi = Math.floor(t / 0x100000000), lo = t >>> 0;
            dv.setUint32(o, hi); dv.setUint32(o + 4, lo);
            dv.setUint32(o + 8, hi); dv.setUint32(o + 12, lo);
          } else {
            dv.setUint32(o, t);
            dv.setUint32(o + 4, t);
          }
          patched++;
        }
        p += size;
      }
    })(0, buf.byteLength);
    return patched;
  }

  // ------------------------------------------------------------ saving
  function triggerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function saveFiles(files) {
    for (const f of files) {
      triggerDownload(f.blob, f.name);
      await sleep(400); // browsers throttle bursts of downloads
    }
  }

  // Console helper for troubleshooting: ssdlDebug(0) dumps the first post's data.
  unsafeWindow.ssdlDebug = async (n = 0) => {
    const a = document.querySelectorAll(SEL.post)[n];
    const feed = a && getAngularItem(a);
    let item = feed;
    try { if (feed) item = await fetchItemV2(feed.item_id, feed.share_token); } catch (e) { console.warn('[SSDL] item_v2 failed', e); }
    console.log('[SSDL] apiParams:', apiParams, '\nitem:', item, '\nmedia:', item && extractMediaFromItem(item), '\ndate:', a && getPostDate(a, item), '\npages:', item && item.num_pages);
  };
})();
