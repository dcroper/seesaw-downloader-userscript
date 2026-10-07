// ==UserScript==
// @name         Seesaw Post Downloader
// @namespace    https://app.seesaw.me/
// @version      1.1.1
// @description  Adds a Download button to each Seesaw feed post. Saves every photo/video in its original format with the "date taken" set to the post date (EXIF for JPEGs, MP4/MOV header for videos).
// @match        https://app.seesaw.me/*
// @author       David Roper
// @license      MIT
// @homepageURL  https://github.com/dcroper/seesaw-downloader-userscript
// @supportURL   https://github.com/dcroper/seesaw-downloader-userscript/issues
// @downloadURL  https://raw.githubusercontent.com/dcroper/seesaw-downloader-userscript/main/seesaw-downloader.user.js
// @updateURL    https://raw.githubusercontent.com/dcroper/seesaw-downloader-userscript/main/seesaw-downloader.user.js
// @require      https://cdn.jsdelivr.net/npm/piexifjs@1.0.6/piexif.js
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      seesaw.me
// @connect      amazonaws.com
// @connect      cloudfront.net
// @connect      *
// @run-at       document-start
// ==/UserScript==

/* global piexif, JSZip, GM_info, GM_xmlhttpRequest, unsafeWindow */
(function () {
  'use strict';

  // ------------------------------------------------------------------ config
  const CONFIG = {
    // 'files' = one download per photo/video, 'zip' = one .zip per post
    // (zip entries also carry the post date as their file modified time).
    downloadMode: 'files',
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
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ss-feed-item-footer__btn ssdl-btn';
      btn.setAttribute('aria-label', 'Download photos and videos from this post');
      btn.textContent = '⬇ Download';
      btn.style.marginLeft = '4px';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (btn.disabled) return;
        downloadPost(article, btn);
      });
      const clearDiv = footer.querySelector(':scope > div[style*="clear"]');
      footer.insertBefore(btn, clearDiv || null);
    });
  }

  let pending = false;
  function startUi() {
    console.log('[SSDL] Seesaw Post Downloader loaded', typeof GM_info !== 'undefined' ? GM_info.script.version : '');
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; addButtons(); }, 300);
    }).observe(document.documentElement, { childList: true, subtree: true });
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
  async function downloadPost(article, btn) {
    const setStatus = (t) => { btn.textContent = t; };
    btn.disabled = true;
    try {
      setStatus('Finding media…');
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
      const fromData = item ? extractMediaFromItem(item) : [];
      const dataComplete = item && dataPages.length >= expected &&
        (!item.has_canvas_videos || fromData.some((m) => m.kind === 'video'));
      let media;
      if (dataComplete) {
        media = fromData;
        log('using item data', media);
      } else {
        log('walking carousel; data pages', dataPages.length, 'of', expected);
        media = mergeMedia([], await collectByPaging(article, setStatus, expected));
      }
      if (!media.length) throw new Error('No photos or videos found in this post');

      const base = baseName(date, item);
      const files = [];
      const errors = [];
      for (let i = 0; i < media.length; i++) {
        setStatus(`Downloading ${i + 1}/${media.length}…`);
        try {
          files.push(await fetchAndStamp(media[i], date, i + 1, base));
        } catch (err) {
          console.error('[SSDL] failed', media[i], err);
          errors.push(`#${i + 1}: ${err.message}`);
        }
      }

      if (files.length) {
        setStatus('Saving…');
        await saveFiles(files, date, base);
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
      setTimeout(() => { btn.textContent = '⬇ Download'; }, 6000);
    }
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
  function pageMedia(p) {
    const vids = [];
    const regions = p.composite_image_map && p.composite_image_map.compositeImageMap;
    (Array.isArray(regions) ? regions : []).forEach((r) => (r.actions || []).forEach((a) => {
      if (a && a.action === 'video' && a.payload && a.payload.videoSrc) vids.push({ url: a.payload.videoSrc, kind: 'video' });
    }));
    if (vids.length) return vids;
    const img = p.composite_image_url || p.composite_image_resizable_url;
    return img ? [{ url: img, kind: 'image' }] : [];
  }

  /** Map of item_page_id -> media, for whatever pages the item data currently holds. */
  function dataPagesById(item) {
    const m = new Map();
    const pages = (item && item.pages && item.pages.objects) || [];
    pages.forEach((p) => p.item_page_id && m.set(p.item_page_id, pageMedia(p)));
    return m;
  }

  function extractMediaFromItem(item) {
    // Known shape (from /api/person/parent/feed): item.pages.objects[].composite_image_url
    const pages = item.pages && item.pages.objects;
    if (Array.isArray(pages) && pages.length) {
      const fromPages = pages.flatMap(pageMedia);
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
    const box = article.querySelector('[data-testid=":open-item-modal"]').getBoundingClientRect();
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
        // Prefer the item data for this page (the app may load more pages into
        // it as we flip through); fall back to what the DOM shows.
        const pageId = (page.dataset.testid || '').replace(/^:item-/, '');
        const known = dataPagesById(getAngularItem(article)).get(pageId);
        const video = page.parentElement.querySelector(SEL.watchVideo);
        if (known && known.length) {
          out.push(...known);
        } else if (video) {
          const src = await grabVideoSrc(article, video);
          if (src) out.push({ url: src, kind: 'video' });
          else console.warn('[SSDL] could not get video URL on page', i);
        } else {
          const img = page.querySelector('img[src^="http"]');
          if (img) out.push({ url: img.src, kind: 'image', fallback: img.src });
        }
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

  async function fetchAndStamp(m, date, index, base) {
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
    return { blob, name: `${base}_${pad(index)}.${type}` };
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

  async function saveFiles(files, date, base) {
    if (CONFIG.downloadMode === 'zip') {
      const zip = new JSZip();
      files.forEach((f) => zip.file(f.name, f.blob, { date, binary: true }));
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      triggerDownload(blob, `${base}.zip`);
      return;
    }
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
