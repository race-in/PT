// ==UserScript==
// @name         Sherlock Tracker Sync
// @namespace    __SHERLOCK_URL__
// @version      1.6.6
// @description  Automatically discovers and syncs unsupported trackers locally in this browser; no Sherlock API or token required.
// @author       Sherlock
// @match        http://*/*
// @match        https://*/*
// @noframes
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

/*
 * Browser-local mode:
 * - On the first signed-in visit, attempts to detect and add a tracker when valid stats are readable.
 * - Stores custom tracker data in the userscript manager (GM storage).
 * - While the Sherlock dashboard is open, polls enabled saved trackers at the configured interval.
 * - Uses the userscript manager's cross-origin request permission for remote tracker reads.
 * - Does not call Sherlock APIs, use a Sherlock token, or send tracker data to a server.
 * - Data is not shared with another browser, device, or Sherlock account session.
 */

(function () {
  'use strict';

  /* ======================================================================
   * Pure helpers: no DOM, no GM_*. Kept apart so they can be tested in Node.
   * ==================================================================== */

  const UNIT_EXP = { '': 0, K: 1, M: 2, G: 3, T: 4, P: 5, E: 6 };

  // "1.234,5" and "1,234.5" and "1 234,5" -> 1234.5. A lone comma is a decimal one only when one or two
  // digits follow it; "1,234" is a thousand separator.
  function parseLocaleNumber(raw) {
    let s = String(raw).replace(/[\s\u00a0'’]/g, '');
    if (!/\d/.test(s)) return null;
    const comma = s.lastIndexOf(','), dot = s.lastIndexOf('.');
    if (comma !== -1 && dot !== -1) {
      s = comma > dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (comma !== -1) {
      s = /,\d{1,2}$/.test(s) && (s.match(/,/g) || []).length === 1 ? s.replace(',', '.') : s.replace(/,/g, '');
    } else if ((s.match(/\./g) || []).length > 1) {
      s = s.replace(/\./g, '');
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  // "1.23 TiB", "512,5 GB", "800 MB" -> bytes. IEC units (KiB) are 1024-based; KB, MB, GB are 1024-based
  // too unless the tracker is known to count in thousands (si). Returns null when there is no size unit,
  // so a plain count is never mistaken for bytes.
  function parseBytes(text, si) {
    const m = String(text).replace(/\u00a0/g, ' ').match(/(\d[\d.,'’ ]*)\s*([KMGTPE]?)(i?)B(?:ytes?)?(?![a-z])/i);
    if (!m) return null;
    const n = parseLocaleNumber(m[1]);
    if (n === null || n < 0) return null;
    const base = m[3] || !si ? 1024 : 1000;
    return Math.round(n * Math.pow(base, UNIT_EXP[m[2].toUpperCase()]));
  }

  // An integer: "12", "1,234", "12 (1.2 TiB)" -> 12, 1234, 12. null when there is no digit.
  function parseCount(text) {
    const m = String(text).match(/\d[\d,.'’ ]*/);
    if (!m) return null;
    const grouped = m[0].trim().replace(/[,.'’ ](?=\d{3}(?!\d))/g, '');
    const n = Number(grouped.replace(/[^\d]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  // A ratio: "2.31", "2,31", "∞", "Inf.", "--". Infinite ratios have no number; Sherlock works it out.
  function parseRatio(text) {
    const s = String(text).trim();
    // Trackers sometimes use -1 as an "unknown/infinite" sentinel. Never turn it into +1.
    if (/^[−-]\s*\d/.test(s)) return null;
    if (/^(∞|inf(inity|\.)?|--+|—|-)$/i.test(s)) return { infinite: true, value: null };
    const m = s.match(/\d[\d.,]*/);
    const n = m ? parseLocaleNumber(m[0]) : null;
    return n === null || n < 0 ? null : { infinite: false, value: n };
  }

  function normLabel(text) {
    return String(text)
      .toLowerCase()
      .replace(/\([^)]*\)\s*$/, '')
      .replace(/[\s\u00a0]+/g, ' ')
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      .trim();
  }

  // What each stat is called on the trackers we know of (English first, some Chinese for NexusPHP).
  const LABELS = {
    uploaded: [/^(uploaded|upload|up|upped|ul|total uploaded|上传量|上傳量|上传|上傳)$/],
    downloaded: [/^(downloaded|download|down|dl|total downloaded|下载量|下載量|下载|下載)$/],
    buffer: [/^(buffer|seed buffer|upload buffer)$/],
    ratio: [/^(ratio|share ratio|sharing ratio|share-ratio|分享率)$/],
    required_ratio: [/^(required|required ratio|min(imum)? ratio|minimum required ratio|min\.? ratio)$/],
    required_class_ratio: [/^(required class ratio|class required ratio|minimum class ratio|min\.? class ratio)$/],
    bonus_points: [/^(bon|bonus|bonus points?|karma|karma points?|seed ?bonus( points?)?|魔力值|魔力)$/, /^(points|credits?|bp)$/],
    seeding: [/^(seeding|seeds?|currently seeding|active seeding|seeding torrents|做种|做種|做种中|做種中)$/],
    leeching: [/^(leeching|leeches|currently leeching|active leeching|downloading|下载中|下載中)$/],
    snatched: [/^(snatched|snatches|completed|completed torrents|grabs|已完成|完成)$/],
    hit_and_runs: [/^(hit ?(and|&|n|'n') ?runs?|hit & runs?|h&r|hnr)$/],
    uploads: [/^(uploads|torrents uploaded|uploaded torrents|upload count)$/],
    forum_posts: [/^(forum posts|posts)$/],
    torrent_comments: [/^(torrent comments|comments)$/],
    user_class: [/^(class|user ?class|rank|user group|group|等级|等級|用户等级|用戶等級)$/],
  };

  const STARTS_WITH_SIZE = /^\s*[\d.,'’ ]+\s*[KMGTPE]i?B\b/i;
  const BYTE_KEYS = ['uploaded', 'downloaded', 'buffer'];
  const COUNT_KEYS = ['seeding', 'leeching', 'snatched', 'hit_and_runs', 'uploads', 'forum_posts', 'torrent_comments'];

  // pairs: [{label, value}] in page order. The first pair whose label is known and whose value fits wins.
  function resolveStats(pairs, si) {
    const stats = {};
    for (const key of Object.keys(LABELS)) {
      for (const regex of LABELS[key]) {
        const hit = pairs.find((p) => regex.test(normLabel(p.label)) && fits(key, p.value, si) !== undefined);
        if (hit) { stats[key] = fits(key, hit.value, si); break; }
      }
    }
    return stats;
  }

  // The parsed value of a label's text for this stat, or undefined when the text can't be that stat.
  function fits(key, text, si) {
    const value = String(text).trim();
    if (BYTE_KEYS.includes(key)) { const n = parseBytes(value, si); return n === null ? undefined : n; }
    if (key === 'ratio' || key === 'required_ratio' || key === 'required_class_ratio') {
      const r = parseRatio(value);
      if (!r) return undefined;
      return r.infinite ? null : r.value;
    }
    if (key === 'bonus_points') { const n = STARTS_WITH_SIZE.test(value) ? null : parseLocaleNumber((value.match(/\d[\d.,'’ ]*/) || [''])[0]); return n === null ? undefined : n; }
    if (COUNT_KEYS.includes(key)) { const n = STARTS_WITH_SIZE.test(value) ? null : parseCount(value); return n === null ? undefined : n; }
    if (key === 'user_class') return value.length >= 2 && value.length <= 40 && !/^[\d.,\s]+$/.test(value) ? value : undefined;
    return undefined;
  }

  // Last resort when the page has no labelled cells: "Uploaded: 1.2 TB" runs in plain text.
  function pairsFromText(text) {
    const pairs = [];
    const re = /([A-Za-z][A-Za-z &'.\-]{1,28}?)(?:[ \t]*[:：][ \t]*|[ \t]+)((?:∞|[−-]?\d[\d.,'’]*(?:[ \t]?[KMGTP]i?B)?))(?=\s|$)/g;
    let m;
    const body = String(text).slice(0, 60000);
    while ((m = re.exec(body)) !== null) pairs.push({ label: m[1], value: m[2] });
    return pairs;
  }

  function sizeLabel(bytes) {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let i = 0, n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? String(n) : n.toFixed(n >= 100 ? 1 : 2).replace(/\.?0+$/, '')) + ' ' + units[i];
  }

  // The tracker's name from the page title: "Home :: Aither" -> "Aither", "Aither - Login" -> "Aither".
  function trackerHostname(value) {
    return String(value || '').trim().toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .replace(/^\/\//, '')
      .split(/[/:?#]/, 1)[0]
      .replace(/^www\./, '')
      .replace(/\.$/, '');
  }

  function cleanTrackerDisplayName(value, host, origin) {
    let name = String(value || '').replace(/[\s\u00a0]+/g, ' ').trim();
    if (!name) return '';
    name = name.replace(/\bhttps?:\/\/[^\s<>()]+/gi, ' ');
    const hostnames = [trackerHostname(host), trackerHostname(origin)].filter(Boolean);
    for (const hostname of hostnames) {
      const escaped = hostname.replace(/[.*+?^$|(){}[\]\\]/g, '\\$&');
      name = name.replace(new RegExp('(^|[^a-z0-9])(?:www\\\\.)?' + escaped + '(?=$|[^a-z0-9])', 'gi'), ' ');
    }
    name = name
      .replace(/\b(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s<>()]*)?/gi, ' ')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, ' ')
      .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s|:·»«–—\-()[\]{}]+|[\s|:·»«–—\-()[\]{}]+$/g, '')
      .trim();
    name = name
      .replace(/^(?:details?|profile|account|user)\s+(?:for|of)\s+.+$/i, '')
      .replace(/\s+(?:details?|profile|account)\s+(?:for|of)\s+.+$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    return name ? name.slice(0, 40) : '';
  }

  function knownTrackerDisplayName(host, origin, kind, doc) {
    const hosts = [trackerHostname(host), trackerHostname(origin)].filter(Boolean);
    const matches = (fn) => hosts.some((value) => fn(value));
    if (matches(isDesiGaaneHost)) return 'DesiGaane';
    if (kind === 'digitalcore' || matches(isDigitalCoreHost)) return 'DigitalCore';
    if (kind === 'torrentleech' || matches(isTorrentLeechHost) || isTorrentLeechDocument(doc)) return 'TorrentLeech';
    if (kind === 'rartracker' || matches((value) => value === 'superbits.org' || value.endsWith('.superbits.org'))) return 'SuperBits';
    if (kind === 'iptorrents' || matches(isIptorrentsHost)) return 'IPTorrents';
    if (kind === 'trancetraffic' || matches(isTranceTrafficHost) || isTranceTrafficDocument(doc)) return 'TranceTraffic';
    if (kind === 'myanonamouse' || matches(isMyAnonamouseHost) || isMyAnonamouseDocument(doc)) return 'MyAnonamouse';
    if (kind === 'filelist' || matches(isFileListHost) || isFileListDocument(doc)) return 'FileList';
    if (kind === 'cinemageddon' || matches(isCinemageddonHost) || isCinemageddonDocument(doc)) return 'Cinemageddon';
    return '';
  }

  function guessName(title, host) {
    const parts = String(title || '')
      .split(/\s+[|\-–—:·»«⠶]+\s+|\s*::\s*/)
      .map((part) => cleanTrackerDisplayName(part, host, ''))
      .filter(Boolean);
    const generic = /^(home|index|login|log in|sign in|welcome|browse torrents?|torrents?|profile|user\s+profile|account|user|users?|details?|forum|forums?|dashboard|main|tracker)$/i;
    const profileBoilerplate = /^(?:details?|profile|account|user)\s+(?:for|of)\b/i;
    const candidates = parts.filter((part) => !generic.test(part) && !profileBoilerplate.test(part));
    return candidates.pop() || 'Tracker';
  }

  function canonicalSavedTrackerName(tracker) {
    tracker = tracker || {};
    return knownTrackerDisplayName(tracker.host, tracker.origin, tracker.kind, null) ||
      cleanTrackerDisplayName(guessName(tracker.name, tracker.host), tracker.host, tracker.origin) ||
      cleanTrackerDisplayName(tracker.name, tracker.host, tracker.origin) ||
      'Tracker';
  }

  function shortNameOf(name) {
    const caps = (name.match(/[A-Z0-9]/g) || []).slice(0, 4).join('');
    return (caps.length >= 2 ? caps : name.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'TRK').slice(0, 8);
  }

  // Combine Sherlock's native dashboard totals with browser-local custom tracker totals.
  // A custom tracker is included only when both uploaded and downloaded are available.
  // Sum native tracker buffer/ratio rows when the dashboard summary is internally inconsistent.
  // Buffer = uploaded - downloaded; ratio = uploaded / downloaded.
  function customTrackerBuffer(stats, bufferBasis) {
    // An explicit tracker Buffer is authoritative; only infer when the tracker does not supply one.
    const suppliedBuffer = stats && stats.buffer;
    if (suppliedBuffer !== null && suppliedBuffer !== undefined && suppliedBuffer !== '' &&
        Number.isFinite(Number(suppliedBuffer))) {
      return Number(suppliedBuffer);
    }

    const uploaded = Number(stats && stats.uploaded);
    const downloaded = Number(stats && stats.downloaded);
    if (!Number.isFinite(uploaded) || !Number.isFinite(downloaded)) return null;

    if (bufferBasis === 'required_ratio') {
      const requiredRatio = Number(stats.required_ratio);
      const divisor = Number.isFinite(requiredRatio) && requiredRatio > 0 ? requiredRatio : 1;
      return Math.floor(uploaded / divisor) - downloaded;
    }

    return uploaded - downloaded;
  }

  // Add browser-local custom tracker totals to Sherlock's authoritative native summary values.
  function calculateDashboardTotals(nativeBuffer, nativeUploaded, customTrackers, nativeDownloadedOverride, bufferBasis) {
    const baseBuffer = Number(nativeBuffer);
    const baseUploaded = Number(nativeUploaded);
    if (!Number.isFinite(baseBuffer) || !Number.isFinite(baseUploaded)) return null;

    let uploaded = baseUploaded;
    let downloaded = nativeDownloadedOverride === null || nativeDownloadedOverride === undefined
      ? null
      : Number(nativeDownloadedOverride);
    if (!Number.isFinite(downloaded)) downloaded = null;
    let buffer = baseBuffer;

    // Do not derive downloaded from aggregate Uploaded and Buffer. They may use
    // different time windows or a tracker-specific buffer basis. Only an explicit,
    // independently verified downloaded total may populate this value.

    for (const tracker of customTrackers || []) {
      const stats = tracker && tracker.stats || {};
      const rawUploaded = stats.uploaded;
      const rawDownloaded = stats.downloaded;
      const hasUploaded = rawUploaded !== null && rawUploaded !== undefined && rawUploaded !== '';
      const hasDownloaded = rawDownloaded !== null && rawDownloaded !== undefined && rawDownloaded !== '';

      const trackerUploaded = hasUploaded ? Number(rawUploaded) : null;
      const trackerDownloaded = hasDownloaded ? Number(rawDownloaded) : null;
      const validUploaded = trackerUploaded !== null && Number.isFinite(trackerUploaded) && trackerUploaded >= 0;
      const validDownloaded = trackerDownloaded !== null && Number.isFinite(trackerDownloaded) && trackerDownloaded >= 0;

      // Uploaded and downloaded totals are independent: count either one when available.
      if (validUploaded) uploaded += trackerUploaded;
      if (validDownloaded && downloaded !== null) downloaded += trackerDownloaded;

      // Buffer needs both values and uses the same preference basis as Sherlock.
      if (validUploaded && validDownloaded) {
        const trackerBuffer = customTrackerBuffer(stats, bufferBasis || 'one_to_one');
        if (trackerBuffer !== null) buffer += trackerBuffer;
      }
    }

    return {
      uploaded,
      downloaded,
      buffer,
    };
  }


  function sumVerifiedDownloads(nativeRows, customTrackers) {
    const native = Array.isArray(nativeRows) ? nativeRows : [];
    const custom = Array.isArray(customTrackers) ? customTrackers : [];
    if (!native.length && !custom.length) return null;

    let total = 0;
    for (const row of native) {
      const value = row && row.downloaded;
      if (value === null || value === undefined || value === '' ||
          !Number.isFinite(Number(value)) || Number(value) < 0) return null;
      total += Number(value);
    }
    for (const tracker of custom) {
      const value = tracker && tracker.stats && tracker.stats.downloaded;
      if (value === null || value === undefined || value === '' ||
          !Number.isFinite(Number(value)) || Number(value) < 0) return null;
      total += Number(value);
    }
    return total;
  }


  // Strict byte-count parsing for JSON APIs. Do not guess units or turn missing values into zero.
  function apiByteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  }

  function apiOptionalNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function apiRatio(uploaded, downloaded) {
    return downloaded > 0 ? uploaded / downloaded : null;
  }

  function mapRartrackerStatus(payload) {
    const user = payload && payload.user;
    if (!user || user.id === null || user.id === undefined) return null;
    const uploaded = apiByteNumber(user.uploaded);
    const downloaded = apiByteNumber(user.downloaded);
    if (uploaded === null || downloaded === null) return null;
    return {
      kind: 'rartracker',
      userId: String(user.id),
      username: String(user.username || ''),
      stats: {
        uploaded,
        downloaded,
        ratio: apiOptionalNumber(user.ratio) ?? apiRatio(uploaded, downloaded),
        bonus_points: apiOptionalNumber(user.bonuspoang),
        user_class: user.className || user.class_name || (typeof user.class === 'string' ? user.class : null),
      },
    };
  }

  function mapDigitalCoreStatus(payload) {
    const user = payload && payload.user;
    if (!user || user.id === null || user.id === undefined) return null;
    const uploaded = apiByteNumber(user.uploaded);
    const downloaded = apiByteNumber(user.downloaded);
    if (uploaded === null || downloaded === null) return null;
    const classes = {
      0: 'Rogue', 10: 'Sentinel', 20: 'Viceroy', 30: 'Sentry', 31: 'Guardian',
      32: 'Vanguard', 50: 'Uploader', 51: 'Titan', 60: 'Developer',
      70: 'VIP', 75: 'FLS', 80: 'Moderator', 90: 'Administrator',
    };
    const classId = user.class;
    return {
      kind: 'digitalcore',
      userId: String(user.id),
      username: String(user.username || ''),
      stats: {
        uploaded,
        downloaded,
        ratio: apiRatio(uploaded, downloaded),
        bonus_points: apiOptionalNumber(user.bonuspoang),
        user_class: classId === null || classId === undefined ? null : (classes[String(classId)] || ('Class ' + classId)),
        seeding: apiOptionalNumber(user.myseedstotal),
        hit_and_runs: apiOptionalNumber(user.hit_and_run_total) ?? apiOptionalNumber(user.hnr),
      },
    };
  }

  // IPTorrents displays decimal GB/TB units in its account stats bar.
  function isTranceTrafficHost(value) {
    const host = String(value || '').trim().toLowerCase()
      .replace(/^https?:\/\//, '').split(/[/:?#]/, 1)[0]
      .replace(/^www\./, '').replace(/\.$/, '');
    return host === 'trancetraffic.com' || host.endsWith('.trancetraffic.com');
  }

  function tranceTrafficStatusLink(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    for (const link of doc.querySelectorAll('a[href*="userdetails.php?id="]')) {
      const cell = link.closest && link.closest('td.layout');
      if (cell && /^\s*Welcome back\s*,/i.test(cell.textContent || '')) return link;
    }
    return null;
  }

  function isTranceTrafficDocument(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return false;
    return /trancetraffic/i.test(String(doc.title || '')) && !!tranceTrafficStatusLink(doc);
  }

  function isTranceTrafficTracker(tracker, doc) {
    tracker = tracker || {};
    return tracker.kind === 'trancetraffic' ||
      /^trancetraffic(?:\s|$)/i.test(String(tracker.name || '').trim()) ||
      isTranceTrafficHost(tracker.host) ||
      isTranceTrafficHost(tracker.origin) ||
      isTranceTrafficDocument(doc);
  }

  function mapTranceTrafficProfileRows(rows, statusText) {
    const stats = resolveStats(rows || [], false);
    const header = String(statusText || '').replace(/[\s\u00a0]+/g, ' ').trim();
    if (stats.ratio === undefined) {
      const ratio = header.match(/\bRatio\s*:\s*(\d[\d.,]*)/i);
      if (ratio) { const parsed = parseRatio(ratio[1]); if (parsed && !parsed.infinite) stats.ratio = parsed.value; }
    }
    if (stats.uploaded === undefined) {
      const uploaded = header.match(/\bUploaded\s*:\s*(\d[\d.,]*\s*[KMGTPE]?i?B)\b/i);
      if (uploaded) stats.uploaded = parseBytes(uploaded[1], false);
    }
    if (stats.downloaded === undefined) {
      const downloaded = header.match(/\bDownloaded\s*:\s*(\d[\d.,]*\s*[KMGTPE]?i?B)\b/i);
      if (downloaded) stats.downloaded = parseBytes(downloaded[1], false);
    }
    if (Number.isFinite(stats.uploaded) && Number.isFinite(stats.downloaded) && stats.ratio === undefined) {
      stats.ratio = stats.downloaded > 0 ? stats.uploaded / stats.downloaded : (stats.uploaded > 0 ? Infinity : null);
    }
    return stats;
  }

  const SHERLOCK_DASHBOARD_BASE_URL = 'https://app.whatstatus.info';

  function sherlockDashboardUrl() {
    return SHERLOCK_DASHBOARD_BASE_URL.replace(/\/+$/, '') + '/dashboard';
  }

  function isMyAnonamouseHost(value) {
    const host = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/:?#]/, 1)[0].replace(/^www\./, '').replace(/\.$/, '');
    return host === 'myanonamouse.net' || host.endsWith('.myanonamouse.net');
  }
  function isMyAnonamouseDocument(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return false;
    if (!doc.querySelector('#userStat') || !doc.querySelector('#mainmenu .mmUserStats a.myInfo[href*="/u/"]')) return false;
    const title = String(doc.title || '');
    const icon = doc.querySelector('link[rel~="icon"][href*="myanonamouse.net"], link[rel="apple-touch-icon"][href*="myanonamouse.net"]');
    return /my anonamouse/i.test(title) || !!icon;
  }
  function isMyAnonamouseTracker(tracker, doc) {
    tracker = tracker || {};
    return tracker.kind === 'myanonamouse' ||
      /^(my\s*)?anonamouse$/i.test(String(tracker.name || '').trim()) ||
      isMyAnonamouseHost(tracker.host) || isMyAnonamouseHost(tracker.origin) ||
      isMyAnonamouseDocument(doc);
  }
  function mapMyAnonamouseProfileRows(rows, headerText) {
    const stats = resolveStats(rows || [], false);
    const header = String(headerText || '').replace(/\s+/g, ' ').trim();
    if (stats.ratio === undefined) {
      const ratio = header.match(/\b(?:ratio|share ratio)\s*:?\s*(\d[\d.,]*)/i);
      if (ratio) { const parsed = parseRatio(ratio[1]); if (parsed && !parsed.infinite) stats.ratio = parsed.value; }
    }
    if (stats.bonus_points === undefined) {
      const bonus = header.match(/\bBonus\s*:\s*(\d[\d.,]*)/i);
      if (bonus) stats.bonus_points = parseLocaleNumber(bonus[1]);
    }
    if (Number.isFinite(stats.uploaded) && Number.isFinite(stats.downloaded) && stats.ratio === undefined) {
      stats.ratio = stats.downloaded > 0 ? stats.uploaded / stats.downloaded : (stats.uploaded > 0 ? Infinity : null);
    }
    return stats;
  }

  function isFileListHost(value) {
    const host = String(value || '').trim().toLowerCase()
      .replace(/^https?:\/\//, '').split(/[/:?#]/, 1)[0]
      .replace(/^www\./, '').replace(/\.$/, '');
    return host === 'filelist.io' || host.endsWith('.filelist.io');
  }

  function isFileListDocument(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return false;
    const statusUser = doc.querySelector('.statusbar a[href*="userdetails.php?id="]');
    if (!statusUser) return false;
    const title = String(doc.title || '');
    const footerBrand = doc.querySelector('#copyright a[href*="filelist.io"], #copyrightInner a[href*="filelist.io"]');
    const rss = doc.querySelector('link[rel="alternate"][title="Latest Torrents"][href*="filelist.io"]');
    return /filelist/i.test(title) || !!footerBrand || !!rss;
  }

  function isFileListTracker(tracker, doc) {
    tracker = tracker || {};
    return tracker.kind === 'filelist' ||
      /^filelist(?:\s|$)/i.test(String(tracker.name || '').trim()) ||
      isFileListHost(tracker.host) ||
      isFileListHost(tracker.origin) ||
      isFileListDocument(doc);
  }

  function mapFileListProfileRows(rows, statusText, seedText) {
    const stats = resolveStats(rows || [], false);
    const header = String(statusText || '').replace(/\s+/g, ' ').trim();

    if (stats.uploaded === undefined) {
      const uploaded = header.match(/\bUploaded\s*:?\s*(\d[\d.,]*\s*[KMGTPE]?i?B)\b/i);
      if (uploaded) stats.uploaded = parseBytes(uploaded[1], false);
    }
    if (stats.downloaded === undefined) {
      const downloaded = header.match(/\bDownloaded\s*:?\s*(\d[\d.,]*\s*[KMGTPE]?i?B)\b/i);
      if (downloaded) stats.downloaded = parseBytes(downloaded[1], false);
    }
    if (stats.ratio === undefined) {
      const ratio = header.match(/\bRatio\s*:?\s*(\d[\d.,]+)/i);
      if (ratio) {
        const parsed = parseRatio(ratio[1]);
        if (parsed && !parsed.infinite) stats.ratio = parsed.value;
      }
    }
    if (stats.user_class === undefined) {
      const statusClass = header.match(/\[([^\]]{2,40})\]/);
      if (statusClass) stats.user_class = statusClass[1].trim();
    }

    const seed = String(seedText || '');
    if (stats.seeding === undefined) {
      const count = seed.match(/\bSeeding\s+([\d,]+)/i);
      if (count) stats.seeding = parseCount(count[1]);
    }
    if (Number.isFinite(stats.uploaded) && Number.isFinite(stats.downloaded) &&
        stats.ratio === undefined) {
      stats.ratio = stats.downloaded > 0
        ? stats.uploaded / stats.downloaded
        : (stats.uploaded > 0 ? Infinity : null);
    }
    return stats;
  }

  function isCinemageddonHost(value) {
    const host = String(value || '').trim().toLowerCase()
      .replace(/^https?:\/\//, '').split(/[/:?#]/, 1)[0]
      .replace(/^www\./, '').replace(/\.$/, '');
    return host === 'cinemageddon.net' || host.endsWith('.cinemageddon.net');
  }

  function isCinemageddonDocument(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return false;
    const statusUser = doc.querySelector('.statusbar a[href*="userdetails.php?id="]');
    if (!statusUser) return false;
    const title = String(doc.title || '');
    const description = doc.querySelector('meta[name="description"]')?.getAttribute('content') || '';
    const keywords = doc.querySelector('meta[name="keywords"]')?.getAttribute('content') || '';
    return /cinemageddon/i.test(title + ' ' + description + ' ' + keywords);
  }

  function isCinemageddonTracker(tracker, doc) {
    tracker = tracker || {};
    return tracker.kind === 'cinemageddon' ||
      /^cinemageddon(?:\s|$)/i.test(String(tracker.name || '').trim()) ||
      isCinemageddonHost(tracker.host) ||
      isCinemageddonHost(tracker.origin) ||
      isCinemageddonDocument(doc);
  }

  function mapCinemageddonProfileRows(rows, si, statusText) {
    const stats = resolveStats(rows || [], !!si);
    const header = String(statusText || '');

    if (stats.ratio === undefined) {
      const ratio = header.match(/\br\s*:\s*(\d[\d.,]*)/i);
      if (ratio) {
        const parsed = parseRatio(ratio[1]);
        if (parsed && !parsed.infinite) stats.ratio = parsed.value;
      }
    }
    if (stats.uploaded === undefined) {
      const uploaded = header.match(/\bu\s*:\s*(\d[\d.,]*\s*[KMGTPE]?i?B)\b/i);
      if (uploaded) stats.uploaded = parseBytes(uploaded[1], !!si);
    }
    if (stats.downloaded === undefined) {
      const downloaded = header.match(/\bd\s*:\s*(\d[\d.,]*\s*[KMGTPE]?i?B)\b/i);
      if (downloaded) stats.downloaded = parseBytes(downloaded[1], !!si);
    }
    const credits = header.match(/\bcredits\s*:\s*(\d[\d.,]*)/i);
    if (credits && stats.bonus_points === undefined) {
      stats.bonus_points = parseLocaleNumber(credits[1]);
    }
    if (Number.isFinite(stats.uploaded) && Number.isFinite(stats.downloaded) &&
        stats.ratio === undefined) {
      stats.ratio = stats.downloaded > 0
        ? stats.uploaded / stats.downloaded
        : (stats.uploaded > 0 ? Infinity : null);
    }
    return stats;
  }

  function mapIptProfileDetails(data) {
    data = data || {};
    const out = {};
    const uploaded = parseBytes(data.uploadedBytes, true);
    const downloaded = parseBytes(data.downloadedBytes, true);
    if (uploaded !== null) out.uploaded = uploaded;
    if (downloaded !== null) out.downloaded = downloaded;
    if (Number.isFinite(out.uploaded) && Number.isFinite(out.downloaded)) {
      out.ratio = out.downloaded > 0
        ? out.uploaded / out.downloaded
        : (out.uploaded > 0 ? Infinity : null);
    }

    const userClass = String(data.userClass || '').replace(/\s+/g, ' ').trim();
    if (userClass) out.user_class = userClass.slice(0, 50);

    const joined = String(data.joinedAt || '').match(/^\d{4}-\d{2}-\d{2}/);
    const lastSeen = String(data.lastSeenAt || '').match(/^\d{4}-\d{2}-\d{2}/);
    if (joined) out.joined_at = joined[0];
    if (lastSeen) out.last_access = lastSeen[0];
    return out;
  }

  function mapIptStatValues(items) {
    const out = {};
    for (const item of items || []) {
      const label = String(item && item.label || '').trim().toLowerCase();
      const value = String(item && item.value || '').trim();
      if (!value) continue;
      if (label === 'uploaded' || label === 'downloaded') {
        const bytes = parseBytes(value, true);
        if (bytes !== null) out[label] = bytes;
      } else if (label === 'bonus points') {
        const numberMatch = value.match(/\d[\d.,'’ ]*/);
        const number = numberMatch ? parseLocaleNumber(numberMatch[0]) : null;
        if (number !== null) out.bonus_points = number;
      } else if (label === 'active torrents') {
        const counts = value.match(/\d+/g);
        if (counts && counts.length >= 2) {
          out.seeding = Number(counts[0]);
          out.leeching = Number(counts[1]);
        }
      }
    }
    if (Number.isFinite(out.uploaded) && Number.isFinite(out.downloaded)) {
      out.ratio = out.downloaded > 0 ? out.uploaded / out.downloaded : (out.uploaded > 0 ? Infinity : null);
    }
    return out;
  }

  // IPTorrents mirror hostnames shared in the tracker announcement.
  // octopus.town is wildcarded: anyName.octopus.town is a supported mirror.
  const IPTORRENTS_MIRROR_HOSTS = new Set([
    'ipt.cool',
    'ipt.world',
    'ipt.lol',
    'ip.findnemo.net',
    'ip.getcrazy.me',
    'ip.venom.global',
    'ip.workisboring.net',
  ]);

  function isIptorrentsHost(value) {
    const host = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .split(/[/:?#]/, 1)[0]
      .replace(/^www\./, '')
      .replace(/\.$/, '');
    return host === 'iptorrents.com' ||
      host.endsWith('.iptorrents.com') ||
      IPTORRENTS_MIRROR_HOSTS.has(host) ||
      (host.endsWith('.octopus.town') && host !== 'octopus.town');
  }

  function isDigitalCoreHost(value) {
    const host = String(value || '').trim().toLowerCase()
      .replace(/^https?:\/\//, '').split(/[/:?#]/, 1)[0]
      .replace(/^www\./, '').replace(/\.$/, '');
    return host === 'digitalcore.club' || host.endsWith('.digitalcore.club');
  }

  function isDesiGaaneHost(value) {
    const host = trackerHostname(value);
    return host === 'desigaane.rocks' || host.endsWith('.desigaane.rocks');
  }

  function trackerNameForNewTracker(title, host, origin, doc) {
    return knownTrackerDisplayName(host, origin, '', doc) ||
      cleanTrackerDisplayName(guessName(title, host), host, origin) ||
      'Tracker';
  }

  // Not in a browser (or no userscript manager): hand the helpers to a test runner and stop.
  if (typeof window === 'undefined' || typeof GM_getValue === 'undefined') {
    if (typeof module !== 'undefined') {
      module.exports = { parseLocaleNumber, parseBytes, parseCount, parseRatio, normLabel, resolveStats, pairsFromText, sizeLabel, guessName, shortNameOf, customTrackerBuffer, calculateDashboardTotals, sumVerifiedDownloads, removeNativeTrackerFooter, centerTrackerMetrics, apiByteNumber, mapRartrackerStatus, mapDigitalCoreStatus, mapIptStatValues, mapIptProfileDetails, isIptorrentsHost, normalizeIptorrentsTrackerStore, isDigitalCoreHost, trackerNameForNewTracker, trackerHostname, cleanTrackerDisplayName, knownTrackerDisplayName, isDesiGaaneHost, canonicalSavedTrackerName, localRatio, profileAddressFromDocument, isTorrentLeechHost, isTorrentLeechDocument, isTorrentLeechTracker, mapTorrentLeechProfileRows, parseTorrentLeechDocument, isCinemageddonHost, isCinemageddonDocument, isCinemageddonTracker, mapCinemageddonProfileRows, isFileListHost, isFileListDocument, isFileListTracker, mapFileListProfileRows, isMyAnonamouseHost, isMyAnonamouseDocument, isMyAnonamouseTracker, mapMyAnonamouseProfileRows, isTranceTrafficHost, tranceTrafficStatusLink, isTranceTrafficDocument, isTranceTrafficTracker, mapTranceTrafficProfileRows, sherlockDashboardUrl };
    }
    return;
  }

  /* ======================================================================
   * Settings, kept in the userscript manager
   * ==================================================================== */

  const VERSION = '1.6.6';
  const DEFAULT_URL = SHERLOCK_DASHBOARD_BASE_URL;
  function normalizeIptorrentsTrackerStore(all) {
    const entries = Object.entries(all || {}).filter(([key, tracker]) =>
      tracker && (
        isIptorrentsHost(key) ||
        isIptorrentsHost(tracker.host) ||
        isIptorrentsHost(tracker.origin)
      )
    );
    if (!entries.length) return { trackers: all || {}, changed: false };

    const bySync = entries.slice().sort((a, b) =>
      Number(b[1].lastSync || 0) - Number(a[1].lastSync || 0)
    );
    const byVisit = entries.slice().sort((a, b) =>
      Number(b[1].lastSeenAt || b[1].lastSync || 0) -
      Number(a[1].lastSeenAt || a[1].lastSync || 0)
    );
    const freshest = Object.assign({}, bySync[0][1]);
    const mostRecent = byVisit[0][1];
    const points = new Map();

    entries.forEach(([, tracker]) => {
      (Array.isArray(tracker.history) ? tracker.history : []).forEach((point) => {
        const at = Number(point && point.at);
        if (Number.isFinite(at) && at > 0 && Number.isFinite(Number(point.buffer))) {
          points.set(at, point);
        }
      });
    });

    const history = Array.from(points.values())
      .sort((a, b) => Number(a.at) - Number(b.at))
      .slice(-240);
    const created = entries
      .map(([, tracker]) => Number(tracker.createdAt || 0))
      .filter((value) => value > 0 && Number.isFinite(value));

    freshest.host = 'iptorrents.com';
    freshest.origin = mostRecent.origin || freshest.origin || 'https://iptorrents.com';
    freshest.lastSeenAt = Math.max(...entries.map(([, tracker]) =>
      Number(tracker.lastSeenAt || tracker.lastSync || 0)
    ));
    freshest.history = history;
    if (created.length) freshest.createdAt = Math.min(...created);

    const normalized = Object.assign({}, all);
    entries.forEach(([key]) => {
      if (key !== 'iptorrents.com') delete normalized[key];
    });
    normalized['iptorrents.com'] = freshest;

    const changed = entries.length !== 1 ||
      entries[0][0] !== 'iptorrents.com' ||
      entries[0][1].host !== 'iptorrents.com';
    return { trackers: normalized, changed };
  }

  const store = {
    get url() { return DEFAULT_URL; },
    // Migrate any previously saved mimas/alias URL to the canonical public dashboard.
    set url(v) { GM_setValue('sherlock.url', DEFAULT_URL); },
    get interval() { return Math.max(15, Number(GM_getValue('sherlock.interval', 60)) || 60); },
    set interval(v) { GM_setValue('sherlock.interval', Math.max(15, Number(v) || 60)); },
    get trackers() {
      let all;
      try { all = JSON.parse(GM_getValue('sherlock.trackers', '{}')) || {}; }
      catch (e) { all = {}; }
      const result = normalizeIptorrentsTrackerStore(all);
      const trackers = result.trackers;
      let changed = result.changed;
      Object.values(trackers).forEach((tracker) => {
        if (!tracker || typeof tracker !== 'object') return;
        const cleanName = canonicalSavedTrackerName(tracker);
        if (tracker.name !== cleanName) {
          tracker.name = cleanName;
          tracker.shortName = shortNameOf(cleanName);
          changed = true;
        } else if (!tracker.shortName) {
          tracker.shortName = shortNameOf(cleanName);
          changed = true;
        }
      });
      if (changed) GM_setValue('sherlock.trackers', JSON.stringify(trackers));
      return trackers;
    },
    set trackers(v) { GM_setValue('sherlock.trackers', JSON.stringify(v)); },
    get dismissed() { try { return JSON.parse(GM_getValue('sherlock.dismissed', '{}')) || {}; } catch (e) { return {}; } },
    set dismissed(v) { GM_setValue('sherlock.dismissed', JSON.stringify(v)); },
  };

  const PAGE_HOST = location.hostname.toLowerCase().replace(/^www\./, '');
  // All IPTorrents mirrors represent one tracker/account in Sherlock totals.
  const HOST = isIptorrentsHost(PAGE_HOST) ? 'iptorrents.com' : PAGE_HOST;
  const sessionSkipped = new Set();

  function saveTracker(t) {
    const all = store.trackers;
    const key = isIptorrentsHost(t.host) || isIptorrentsHost(t.origin) ? 'iptorrents.com' : t.host;
    t.host = key;
    const cleanName = canonicalSavedTrackerName(t);
    if (t.name !== cleanName) t.shortName = shortNameOf(cleanName);
    t.name = cleanName;
    if (!t.shortName) t.shortName = shortNameOf(cleanName);
    all[key] = t;
    store.trackers = all;
  }

  /* ======================================================================
   * Local-only storage. No Sherlock API calls are made.
   * ==================================================================== */

  class ReadError extends Error {}

  /* ======================================================================
   * Reading the tracker: Gazelle JSON first, then the profile page
   * ==================================================================== */

  async function fetchText(url, accept) {
    const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: accept || '*/*' }, redirect: 'follow' });
    if (!res.ok) throw new ReadError('The tracker answered ' + res.status + ' for ' + new URL(url, location.href).pathname + '.');
    return { text: await res.text(), url: res.url, redirected: res.redirected };
  }

  async function readGazelle(request) {
    const fetcher = request || fetchText;
    let index;
    try {
      const result = await fetcher('/ajax.php?action=index', 'application/json');
      index = JSON.parse(result.text);
    } catch (e) {
      throw new ReadError('Not a Gazelle tracker, or its index endpoint is unavailable.');
    }
    const response = index && index.status === 'success' && index.response;
    if (!response || !response.userstats || response.id == null) throw new ReadError('Not a Gazelle tracker, or you are signed out.');
    const userStats = response.userstats;
    const stats = {
      uploaded: toNumber(userStats.uploaded), downloaded: toNumber(userStats.downloaded),
      ratio: toNumber(userStats.ratio), required_ratio: toNumber(userStats.requiredratio),
      bonus_points: toNumber(userStats.bonusPoints), user_class: userStats.class || null,
    };
    try {
      const result = await fetcher('/ajax.php?action=community_stats&userid=' + encodeURIComponent(response.id), 'application/json');
      const community = JSON.parse(result.text).response || {};
      stats.seeding = toNumber(community.seeding);
      stats.leeching = toNumber(community.leeching);
      stats.snatched = toNumber(community.snatched);
    } catch (e) { /* optional */ }
    try {
      const result = await fetcher('/ajax.php?action=user&id=' + encodeURIComponent(response.id), 'application/json');
      const user = JSON.parse(result.text).response || {};
      const community = user.community || {};
      if (stats.seeding == null) stats.seeding = toNumber(community.seeding);
      if (stats.leeching == null) stats.leeching = toNumber(community.leeching);
      if (stats.snatched == null) stats.snatched = toNumber(community.snatched);
      stats.uploads = toNumber(community.uploaded);
      stats.forum_posts = toNumber(community.posts);
      stats.torrent_comments = toNumber(community.torrentComments);
    } catch (e) { /* optional */ }
    if (!Number.isFinite(stats.uploaded) || !Number.isFinite(stats.downloaded)) {
      throw new ReadError('The tracker did not report uploaded and downloaded.');
    }
    return { kind: 'gazelle', userId: String(response.id), username: String(response.username || ''), profileUrl: null, stats };
  }

  function toNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }


  function parseTrackerApiJson(result, siteName) {
    try {
      return JSON.parse(result.text);
    } catch (e) {
      const body = String(result.text || '').slice(0, 500).toLowerCase();
      if (body.includes('<!doctype') || body.includes('<html') || body.includes('<body')) {
        throw new ReadError(siteName + ' API returned HTML instead of JSON. Login session or Cloudflare challenge may be blocking the request.');
      }
      throw new ReadError(siteName + ' API returned invalid JSON.');
    }
  }

  async function readRartracker(tracker, request) {
    const fetcher = request || fetchText;
    const response = await fetcher('/api/v1/status', 'application/json');
    const payload = parseTrackerApiJson(response, tracker.name || 'Rartracker');
    const data = mapRartrackerStatus(payload);
    if (!data) throw new ReadError('Rartracker /api/v1/status did not contain a signed-in user with valid uploaded and downloaded totals.');

    // This endpoint is part of the public Rartracker schema. Enrichment is optional:
    // keep the verified status totals if a tracker does not expose every profile field.
    try {
      const detailResponse = await fetcher('/api/v1/users/' + encodeURIComponent(data.userId), 'application/json');
      const detailPayload = parseTrackerApiJson(detailResponse, tracker.name || 'Rartracker');
      const detail = detailPayload && (detailPayload.user || detailPayload);
      if (detail && typeof detail === 'object') {
        const bonus = apiOptionalNumber(detail.bonuspoang);
        if (bonus !== null) data.stats.bonus_points = bonus;
        if (!data.username && detail.username) data.username = String(detail.username);
      }
    } catch (e) { /* core status is sufficient */ }

    if (!data.username) data.username = data.userId;
    return data;
  }

  async function readDigitalCore(tracker, request) {
    const fetcher = request || fetchText;
    const response = await fetcher('/api/v1/status', 'application/json');
    const payload = parseTrackerApiJson(response, 'DigitalCore');
    const data = mapDigitalCoreStatus(payload);
    if (!data) throw new ReadError('DigitalCore /api/v1/status did not contain a signed-in user with valid uploaded and downloaded totals.');

    // DigitalCore requires its uid/pass session cookies for user endpoints. The browser's
    // same-origin fetch or GM request with anonymous:false supplies the current session.
    // Keep the core status if optional profile enrichment is unavailable.
    try {
      const detailResponse = await fetcher('/api/v1/users/' + encodeURIComponent(data.userId), 'application/json');
      const detailPayload = parseTrackerApiJson(detailResponse, 'DigitalCore');
      const detail = detailPayload && (detailPayload.user || detailPayload);
      if (detail && typeof detail === 'object') {
        const bonus = apiOptionalNumber(detail.bonuspoang);
        const leeching = apiOptionalNumber(detail.peersLeecher);
        const hitAndRuns = apiOptionalNumber(detail.hnr);
        if (bonus !== null) data.stats.bonus_points = bonus;
        if (leeching !== null) data.stats.leeching = leeching;
        if (hitAndRuns !== null) data.stats.hit_and_runs = hitAndRuns;
        if (detail.forumPosts !== undefined) data.stats.forum_posts = apiOptionalNumber(detail.forumPosts);
        if (detail.torrentComments !== undefined) data.stats.torrent_comments = apiOptionalNumber(detail.torrentComments);
        if (detail.added) data.stats.joined_at = detail.added;
        if (detail.last_access) data.stats.last_access = detail.last_access;
        if (detail.username && !data.username) data.username = String(detail.username);
      }
    } catch (e) { /* verified core status remains usable */ }

    if (!data.username) data.username = data.userId;
    return data;
  }


  // Cells and elements that sit next to each other and look like "label, value".
  function extractPairs(doc) {
    const pairs = [];
    const add = (label, value) => {
      const l = (label || '').replace(/\s+/g, ' ').trim(), v = (value || '').replace(/\s+/g, ' ').trim();
      if (l && v && l.length <= 40 && v.length <= 120) pairs.push({ label: l, value: v });
    };
    // Neighbours: table cells, dt/dd, spans in a row, list items.
    doc.querySelectorAll('tr, dl, ul, ol, div, p, li, span, section').forEach((el) => {
      const kids = el.children;
      if (kids.length < 2 || kids.length > 12 || (el.textContent || '').length > 600) return;
      for (let i = 0; i + 1 < kids.length; i++) add(kids[i].textContent, kids[i + 1].textContent);
    });
    // "Label: value" in one element.
    doc.querySelectorAll('li, p, span, div, td, th, a, b, strong, label, dd').forEach((el) => {
      if (el.children.length > 4) return;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length > 100) return;
      const m = text.match(/^(.{2,30}?)\s*[:：]\s*(.+)$/);
      if (m) add(m[1], m[2]);
    });
    // Icon-only stats (UNIT3D's ratio bar) say what they are in a title.
    doc.querySelectorAll('[title]').forEach((el) => add(el.getAttribute('title'), el.textContent));
    return pairs;
  }

  // UNIT3D shows upload, download, ratio, bonus and seeding in a bar on every page: class names say which.
  function unit3dBar(doc, si) {
    const bar = doc.querySelector('.ratio-bar, [class*="ratio-bar"]');
    if (!bar) return {};
    const out = {};
    const keys = { uploaded: 'uploaded', downloaded: 'downloaded', ratio: 'ratio', points: 'bonus_points', bonus: 'bonus_points', seeding: 'seeding', leeching: 'leeching', buffer: 'buffer' };
    bar.querySelectorAll('[class*="ratio-bar__"]').forEach((el) => {
      const m = el.className.match(/ratio-bar__([a-z_-]+)/);
      const key = m && keys[m[1]];
      if (!key || key in out) return;
      const v = fits(key, el.textContent.replace(/\s+/g, ' '), si);
      if (v !== undefined) out[key] = v;
    });
    return out;
  }

  function plainText(doc) {
    if (!doc.body) return '';
    const copy = doc.body.cloneNode(true);
    copy.querySelectorAll('script, style, noscript, template').forEach((n) => n.remove());
    return (copy.textContent || '').replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n');
  }

  const PROFILE_HINT = /\/(?:users?|profile|members?|u)\/[^/?#]+|(?:userdetails|user|profile|member)\.php\?(?:[^#]*&)?id=\d+|\/user\/\d+/i;
  const NOT_PROFILE = /(login|logout|register|signup|settings|edit|messages?|inbox|notifications?|bookmarks?|invites?|\/users\/?$|\/members\/?$)/i;
  const HEADER_ZONE = 'header, nav, #header, #userinfo, #info_block, #userinfo_username, .top-nav, .header, #menu, .user-menu, [class*="userinfo"], [id*="userinfo"], [class*="top-nav"]';

  // The member's own profile link, found in the header of a tracker page. It's the link to a profile
  // that sits in the header, not one of the many profile links further down (latest comments, etc).
  function findProfileLink(doc, base, expectedOrigin) {
    const sels = ['a.top-nav__username', '#userinfo_username a.username', '#userinfo_username a', 'a[href*="userdetails.php?id="]', 'a[href*="user.php?id="]', 'a[href*="/users/"]', 'a[href*="/user/"]', 'a[href*="/profile/"]', 'a[href*="/members/"]'];
    for (const sel of sels) {
      for (const a of doc.querySelectorAll(sel)) {
        const href = a.getAttribute('href') || '';
        if (!PROFILE_HINT.test(href) || NOT_PROFILE.test(href)) continue;
        if (!a.closest(HEADER_ZONE) && !sel.startsWith('a.top-nav') && !sel.startsWith('#userinfo')) continue;
        const url = new URL(href, base);
        if (url.origin !== (expectedOrigin || location.origin)) continue;
        return { url: url.href, text: (a.textContent || '').trim() };
      }
    }
    return null;
  }

  function identityFromProfile(url, linkText) {
    const u = new URL(url);
    const id = u.searchParams.get('id') || (u.pathname.match(/\/(\d+)(?:\/|$)/) || [])[1] || null;
    const slug = decodeURIComponent((u.pathname.match(/\/(?:users?|profile|members?|u)\/([^/?#]+)/i) || [])[1] || '');
    const fromLink = linkText && linkText.length <= 64 && !/\s{2,}/.test(linkText) ? linkText : '';
    const username = (slug && !/^\d+$/.test(slug) ? slug : '') || fromLink || '';
    return { userId: id || username.toLowerCase() || null, username };
  }

  function profileAddressFromDocument(doc, baseOrigin, data, pageUrl, URLCtor) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    const URLClass = URLCtor || (typeof URL !== 'undefined' ? URL : null);
    if (!URLClass) return null;
    const profileHint = /\/(?:users?|profile|members?|u)\/[^/?#]+|(?:userdetails|user|profile|member)\.php\?(?:[^#]*&)?id=\d+|\/user\/\d+/i;
    const notProfile = /(login|logout|register|signup|settings|edit|messages?|inbox|notifications?|bookmarks?|invites?|\/users?\/?$|\/members?\/?$)/i;
    const headerZone = 'header, nav, #header, #userinfo, #info_block, #userinfo_username, .top-nav, .header, #menu, .user-menu, [class*="userinfo"], [id*="userinfo"], [class*="top-nav"]';
    let base;
    try { base = new URLClass(baseOrigin).origin; } catch (e) { return null; }
    const expectedId = String(data && data.userId || '').trim().toLowerCase();
    const expectedName = String(data && data.username || '').trim().toLowerCase();
    const hasExpectedIdentity = !!(expectedId || expectedName);
    const candidates = [];
    const seen = new Set();

    const addCandidate = (href, text, element, isCurrentPage) => {
      if (!href) return;
      let url;
      try { url = new URLClass(href, base); } catch (e) { return; }
      if (url.origin !== base || !profileHint.test(url.pathname + url.search) ||
          notProfile.test(url.pathname + url.search) || seen.has(url.href)) return;
      seen.add(url.href);
      const pathId = (url.pathname.match(/\/(\d+)(?:\/|$)/) || [])[1] || '';
      const foundId = String(url.searchParams.get('id') || pathId).trim().toLowerCase();
      const slug = (url.pathname.match(/\/(?:users?|profile|members?|u)\/([^/?#]+)/i) || [])[1] || '';
      const foundName = String((slug && !/^\d+$/.test(slug) ? slug : text) || '').trim().toLowerCase();
      const idMatch = !!(expectedId && foundId && expectedId === foundId);
      const nameMatch = !!(expectedName && foundName && expectedName === foundName);
      let score = 0;
      if (idMatch) score += 120;
      if (nameMatch) score += 90;
      if (score && element && element.closest && element.closest(headerZone)) score += 15;
      if (score && isCurrentPage) score += 25;
      // Without an API/profile identity, only the site's own header profile link is safe.
      if (!score && !hasExpectedIdentity && element && element.closest &&
          element.closest(headerZone)) score = 20;
      if (score > 0) candidates.push({ url: url.href, score });
    };

    if (pageUrl) addCandidate(pageUrl, '', null, true);
    for (const anchor of doc.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href') || '';
      if (!href) continue;
      addCandidate(href, anchor.textContent || anchor.getAttribute('aria-label') ||
        anchor.getAttribute('title') || '', anchor, false);
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].url : null;
  }

  async function attachProfileAddress(data, tracker, context, request) {
    if (!data || data.profileUrl) return data;
    if (tracker && tracker.profileUrl) data.profileUrl = tracker.profileUrl;
    if (data.profileUrl) return data;
    context = context || {};
    const origin = context.origin || location.origin;
    const sourceDocument = Object.prototype.hasOwnProperty.call(context, 'document')
      ? context.document : document;
    const pageUrl = context.pageUrl || (sourceDocument ? location.href : origin + '/');
    let profileUrl = profileAddressFromDocument(sourceDocument, origin, data, pageUrl);
    const fetcher = request || context.request;
    if (!profileUrl && fetcher) {
      try {
        const home = await fetcher(new URL('/', origin).href, 'text/html');
        const homeDocument = new DOMParser().parseFromString(home.text, 'text/html');
        profileUrl = profileAddressFromDocument(homeDocument, origin, data, home.url || new URL('/', origin).href);
      } catch (e) { /* optional profile URL must not block verified stats */ }
    }
    if (profileUrl) data.profileUrl = profileUrl;
    return data;
  }

  // A profile page, read with the session you are signed in with. Works for UNIT3D, NexusPHP, TBDev,
  // Luminance, TorrentPier and most others: it looks for the stats by their labels.
  async function readProfile(profileUrl, linkText, si, request, origin) {
    const baseOrigin = origin || location.origin;
    const fetcher = request || fetchText;
    let target;
    try { target = new URL(profileUrl, baseOrigin); } catch (e) { throw new ReadError('That is not a valid address.'); }
    if (target.origin !== baseOrigin) throw new ReadError('The profile page has to be on ' + new URL(baseOrigin).host + '.');
    profileUrl = target.href;
    const { text, url, redirected } = await fetcher(profileUrl, 'text/html');
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const stats = Object.assign({}, resolveStats(extractPairs(doc), si), unit3dBar(doc, si));
    if (stats.uploaded === undefined || stats.downloaded === undefined) {
      Object.assign(stats, resolveStats(pairsFromText(plainText(doc)), si));
    }
    if (stats.uploaded === undefined || stats.downloaded === undefined) {
      const signedOut = (redirected && /login|signin/i.test(url)) || doc.querySelector('input[type="password"]');
      throw new ReadError(signedOut ? 'You are signed out of this tracker. Sign in and try again.' : 'Could not find uploaded and downloaded on that page.');
    }
    const ident = identityFromProfile(profileUrl, linkText);
    return { kind: 'profile', userId: ident.userId, username: ident.username, profileUrl, stats };
  }

  async function discoverProfile(tracker, request, origin, sourceDocument, pageUrl) {
    const baseOrigin = origin || location.origin;
    const fetcher = request || fetchText;
    if (tracker.profileUrl) return { url: new URL(tracker.profileUrl, baseOrigin).href, text: tracker.username };
    let link = sourceDocument ? findProfileLink(sourceDocument, pageUrl || location.href, baseOrigin) : null;
    if (!link) {
      const { text } = await fetcher(new URL('/', baseOrigin).href, 'text/html');
      link = findProfileLink(new DOMParser().parseFromString(text, 'text/html'), baseOrigin + '/', baseOrigin);
    }
    if (!link) throw new ReadError('Could not find your profile link. Paste the address of your profile page below.');
    return link;
  }

  // The same reader can operate on the current page or use an authenticated
  // userscript-manager request while Sherlock's dashboard is open.
  function iptValueAfterLabel(element, label) {
    const clone = element.cloneNode(true);
    const tip = clone.querySelector('.tTip');
    if (tip) tip.remove();
    const raw = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    return raw || String(element.textContent || '').replace(label, '').replace(/\s+/g, ' ').trim();
  }

  function iptProfileIdFromUrl(url, origin) {
    try {
      const parsed = new URL(url, origin);
      if (parsed.origin !== origin) return null;
      const match = parsed.pathname.match(/^\/u\/(\d+)\/?$/);
      return match ? Number(match[1]) : null;
    } catch (e) { return null; }
  }

  function parseIptDocument(doc, hostname, profileId, origin) {
    const html = String(doc.documentElement && doc.documentElement.innerHTML || '').toLowerCase();
    const title = String(doc.title || '').toLowerCase();
    if (/\/auth\/login|\/login/.test(html) || doc.querySelector('input[type="password"]')) {
      throw new ReadError('IPTorrents login session expired. Sign in again and refresh.');
    }
    if (/just a moment|checking your browser|cloudflare/.test(title + ' ' + html.slice(0, 5000)) ||
        doc.querySelector('#cf-challenge-running, .cf-challenge, input[name="cf-turnstile-response"]')) {
      throw new ReadError('IPTorrents Cloudflare challenge blocked the request.');
    }

    const statsDiv = doc.querySelector('.stats');
    if (!statsDiv) throw new ReadError('IPTorrents stats bar was not found. The page may not be authenticated or its layout changed.');

    const userElement = statsDiv.querySelector('.uname');
    const username = userElement
      ? (userElement.cloneNode(true).querySelector('.tTip')
          ? (() => { const clone = userElement.cloneNode(true); const tip = clone.querySelector('.tTip'); if (tip) tip.remove(); return (clone.textContent || '').trim(); })()
          : (userElement.textContent || '').replace(/^Profile/i, '').trim())
      : '';
    let ownId = null;
    const href = userElement && userElement.getAttribute('href');
    if (href) {
      try {
        const link = new URL(href, origin);
        const match = link.origin === origin ? link.pathname.match(/^\/u\/(\d+)\/?$/) : null;
        if (match) ownId = Number(match[1]);
      } catch (e) { /* leave id unknown */ }
    }

    const items = [];
    for (const wrap of statsDiv.querySelectorAll('.tTipWrap')) {
      const tip = wrap.querySelector('.tTip');
      const label = (tip && tip.textContent || '').trim();
      if (!label) continue;
      items.push({ label, value: iptValueAfterLabel(wrap, label) });
    }
    let stats = mapIptStatValues(items);

    const isOwnProfile = profileId !== null && profileId !== undefined && ownId === Number(profileId);
    if (stats.uploaded === undefined && stats.downloaded === undefined && isOwnProfile) {
      const fallbackItems = [];
      for (const card of doc.querySelectorAll('.up-stat')) {
        const label = (card.querySelector('.up-stat-label')?.textContent || '').trim();
        const value = (card.querySelector('.up-stat-value')?.textContent || '').trim();
        if (/^balance$/i.test(label)) fallbackItems.push({ label: 'Bonus Points', value });
        else fallbackItems.push({ label, value });
      }
      stats = Object.assign(stats, mapIptStatValues(fallbackItems));
    }

    if (!Number.isFinite(stats.uploaded) || !Number.isFinite(stats.downloaded)) {
      throw new ReadError('IPTorrents could not extract both Uploaded and Downloaded from its stats bar.');
    }

    if (isOwnProfile) {
      const profileTimes = Array.from(doc.querySelectorAll('.upf-meta time[datetime]'))
        .map((time) => time.getAttribute('datetime') || '');
      const profileDetails = mapIptProfileDetails({
        // The profile page exposes exact byte counts here; prefer them over
        // the rounded TB values in the compact header stats bar.
        uploadedBytes: doc.querySelector('.upf-stat--up .ipx-stat__sub')?.textContent,
        downloadedBytes: doc.querySelector('.upf-stat--down .ipx-stat__sub')?.textContent,
        userClass: doc.querySelector('.upf-class')?.textContent ||
          doc.querySelector('span.up-class-badge')?.textContent,
        joinedAt: profileTimes[0],
        lastSeenAt: profileTimes[1],
      });
      Object.assign(stats, profileDetails);

      // Older IPT profile layouts used .up-field instead of the current .upf-meta.
      for (const field of doc.querySelectorAll('.up-field')) {
        const label = (field.querySelector('.up-field-label')?.textContent || '').replace(/\s+/g, ' ').trim();
        const value = (field.querySelector('.up-field-value')?.textContent || '').replace(/\s+/g, ' ').trim();
        const date = value.match(/^\d{4}-\d{2}-\d{2}/);
        if (date && label === 'Join Date' && !stats.joined_at) stats.joined_at = date[0];
        if (date && label === 'Last Seen' && !stats.last_access) stats.last_access = date[0];
      }
      if (!stats.user_class) {
        const vip = doc.querySelector('.hdr-vip');
        if (vip && /vip/i.test(vip.getAttribute('title') || '')) stats.user_class = 'VIP';
      }
    }

    return {
      kind: 'iptorrents',
      userId: ownId ? String(ownId) : (profileId ? String(profileId) : ''),
      username,
      stats,
    };
  }

  function parseTranceTrafficProfile(doc, profileUrl, origin, si) {
    const html = String(doc.documentElement && doc.documentElement.innerHTML || '').toLowerCase();
    if (doc.querySelector('input[type="password"]') || /\/login\.php(?:[?#"']|$)|name=["']login["']/.test(html)) {
      throw new ReadError('TranceTraffic login session is not available. Sign in and refresh.');
    }
    const statusLink = tranceTrafficStatusLink(doc);
    if (!statusLink) throw new ReadError('TranceTraffic logged-in status bar was not found.');
    const statusUrl = new URL(statusLink.getAttribute('href'), origin);
    const userId = statusUrl.origin === origin && /^\/userdetails\.php$/i.test(statusUrl.pathname) ? (statusUrl.searchParams.get('id') || '') : '';
    if (!/^\d+$/.test(userId)) throw new ReadError('TranceTraffic could not identify the logged-in user.');

    const rows = [];
    for (const row of doc.querySelectorAll('table tr')) {
      const cells = Array.from(row.children).filter((cell) => cell.tagName === 'TD');
      if (cells.length < 2 || !cells[0].classList.contains('rowhead')) continue;
      const label = (cells[0].textContent || '').replace(/[\s\u00a0]+/g, ' ').trim();
      const value = (cells[1].textContent || '').replace(/[\s\u00a0]+/g, ' ').trim();
      if (label && value) rows.push({ label, value });
    }

    const statusCell = statusLink.closest('td.layout');
    const statusText = (statusCell && statusCell.textContent || '').replace(/[\s\u00a0]+/g, ' ').trim();
    const stats = mapTranceTrafficProfileRows(rows, statusText);
    for (const [key, selector] of [
      ['seeding', 'img[alt="Torrents seeding"], img[title="Torrents seeding"]'],
      ['leeching', 'img[alt="Torrents leeching"], img[title="Torrents leeching"]'],
    ]) {
      const icon = statusCell && statusCell.querySelector(selector);
      const value = icon && icon.nextElementSibling;
      if (value) { const count = parseCount(value.textContent || ''); if (count !== null) stats[key] = count; }
    }

    const requestedProfile = new URL(profileUrl, origin);
    if (requestedProfile.origin !== origin || !/^\/userdetails\.php$/i.test(requestedProfile.pathname) ||
        requestedProfile.searchParams.get('id') !== userId) {
      throw new ReadError('TranceTraffic returned a profile that does not match the logged-in account.');
    }
    if (!Number.isFinite(stats.uploaded) || !Number.isFinite(stats.downloaded)) {
      throw new ReadError('TranceTraffic could not read both Uploaded and Downloaded values.');
    }
    const titleMatch = String(doc.title || '').match(/Details for\s+(.+?)\s*$/i);
    const username = titleMatch ? titleMatch[1].trim() : (statusLink.textContent || '').trim();
    return { kind: 'trancetraffic', userId, username, profileUrl: requestedProfile.href, stats };
  }

  async function readTranceTraffic(tracker, context) {
    context = context || {};
    const origin = context.origin || location.origin;
    const request = context.request || fetchText;
    const sourceDocument = Object.prototype.hasOwnProperty.call(context, 'document') ? context.document : document;
    const pageUrl = context.pageUrl || location.href;
    let homeDocument = sourceDocument;
    let statusLink = tranceTrafficStatusLink(homeDocument);
    if (!statusLink) {
      const result = await request(new URL('/', origin).href, 'text/html');
      homeDocument = new DOMParser().parseFromString(result.text, 'text/html');
      statusLink = tranceTrafficStatusLink(homeDocument);
    }
    if (!statusLink) throw new ReadError('TranceTraffic could not find the logged-in profile link. Sign in and retry.');
    const profileUrl = new URL(statusLink.getAttribute('href'), origin);
    if (profileUrl.origin !== origin || !/^\/userdetails\.php$/i.test(profileUrl.pathname) ||
        !/^\d+$/.test(profileUrl.searchParams.get('id') || '')) {
      throw new ReadError('TranceTraffic returned an invalid userdetails.php profile link.');
    }

    let profileDocument = null;
    try {
      const current = new URL(pageUrl, origin);
      if (sourceDocument && current.origin === origin && /^\/userdetails\.php$/i.test(current.pathname) &&
          current.searchParams.get('id') === profileUrl.searchParams.get('id')) profileDocument = sourceDocument;
    } catch (e) { /* fetch profile below */ }

    if (!profileDocument) {
      const result = await request(profileUrl.href, 'text/html');
      if (/\/login\.php/i.test(result.url || '')) throw new ReadError('TranceTraffic session expired. Sign in again and refresh.');
      profileDocument = new DOMParser().parseFromString(result.text, 'text/html');
    }
    return parseTranceTrafficProfile(profileDocument, profileUrl.href, origin, !!tracker.si);
  }

  function isTorrentLeechHost(value) {
    const host = trackerHostname(value);
    return host === 'torrentleech.org' || host.endsWith('.torrentleech.org');
  }

  function isTorrentLeechDocument(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return false;
    const title = String(doc.title || '');
    const meta = doc.querySelector('meta[name="description"]')?.getAttribute('content') || '';
    const user = doc.querySelector('.user_tlgoduser, .profile-username .user_tlgoduser');
    const menu = doc.querySelector('.navbar.loggedin .menu-info, .sub-navbar .menu-info');
    const stats = doc.querySelector('.menu-info [title="Uploaded (Seeding)"], .menu-info [title="Downloaded (Leeching)"], .profile-info .profile-uploaded-details');
    return /torrentleech/i.test(title + ' ' + meta) && !!user && !!menu && !!stats;
  }

  function isTorrentLeechTracker(tracker, doc) {
    tracker = tracker || {};
    return tracker.kind === 'torrentleech' ||
      /^torrentleech(?:\s|$)/i.test(String(tracker.name || '').trim()) ||
      isTorrentLeechHost(tracker.host) ||
      isTorrentLeechHost(tracker.origin) ||
      isTorrentLeechDocument(doc);
  }

  function mapTorrentLeechProfileRows(rows, values) {
    const stats = resolveStats(rows || [], false);
    values = values || {};
    const bytes = (value) => {
      const parsed = parseBytes(String(value || ''), false);
      return parsed === null ? undefined : parsed;
    };
    const number = (value) => {
      const parsed = parseRatio(String(value || ''));
      return parsed && !parsed.infinite ? parsed.value : undefined;
    };
    const count = (value) => {
      const parsed = parseCount(String(value || ''));
      return parsed === null ? undefined : parsed;
    };
    const uploaded = bytes(values.uploaded);
    const downloaded = bytes(values.downloaded);
    const ratio = number(values.ratio);
    const bonus = values.bonus_points === undefined ? undefined : parseLocaleNumber(String(values.bonus_points));
    const seeding = count(values.seeding);
    const leeching = count(values.leeching);
    const hnr = count(values.hit_and_runs);
    if (uploaded !== undefined) stats.uploaded = uploaded;
    if (downloaded !== undefined) stats.downloaded = downloaded;
    if (ratio !== undefined) stats.ratio = ratio;
    else if (String(values.ratio || '').trim() && /^(?:∞|inf(?:inity|\.)?|--+|—|-)$/i.test(String(values.ratio).trim())) stats.ratio = null;
    if (bonus !== null && bonus !== undefined) stats.bonus_points = bonus;
    if (seeding !== undefined) stats.seeding = seeding;
    if (leeching !== undefined) stats.leeching = leeching;
    if (hnr !== undefined) stats.hit_and_runs = hnr;
    if (values.user_class) stats.user_class = String(values.user_class).trim().slice(0, 50);
    if (values.torrent_comments !== undefined) {
      const parsed = count(values.torrent_comments);
      if (parsed !== undefined) stats.torrent_comments = parsed;
    }
    if (values.invites !== undefined) {
      const parsed = count(values.invites);
      if (parsed !== undefined) stats.invites = parsed;
    }
    if (values.joined_at) stats.joined_at = String(values.joined_at).trim();
    if (values.last_access) stats.last_access = String(values.last_access).trim();
    if (Number.isFinite(stats.uploaded) && Number.isFinite(stats.downloaded) && stats.ratio === undefined) {
      stats.ratio = stats.downloaded > 0 ? stats.uploaded / stats.downloaded : (stats.uploaded > 0 ? Infinity : null);
    }
    return stats;
  }

  function parseTorrentLeechDocument(doc, pageUrl, origin) {
    const html = String(doc.documentElement && doc.documentElement.innerHTML || '').toLowerCase();
    const title = String(doc.title || '');
    if (doc.querySelector('input[type="password"]') || /\/user\/account\/login|name=["']password["']/.test(html)) {
      throw new ReadError('TorrentLeech login session is not available. Sign in and refresh.');
    }
    if (!isTorrentLeechDocument(doc)) {
      throw new ReadError('TorrentLeech logged-in account bar was not found. The page may not be authenticated or its layout changed.');
    }

    const userNode = doc.querySelector('.user_tlgoduser, .profile-username .user_tlgoduser');
    const username = (userNode && userNode.textContent || '').replace(/\s+/g, ' ').trim();
    if (!username) throw new ReadError('TorrentLeech could not identify the signed-in username.');

    const getText = (selector) => {
      const node = doc.querySelector(selector);
      return node ? (node.textContent || '').replace(/\s+/g, ' ').trim() : '';
    };
    const uploaded = getText('.profile-info .profile-uploaded-details') ||
      getText('.menu-info [title="Uploaded (Seeding)"] .link') ||
      getText('.menu-info [title="Uploaded (Seeding)"]');
    const downloaded = getText('.profile-info .profile-downloaded .profile-info-details') ||
      getText('.profile-info .profile-downloaded-details') ||
      getText('.menu-info [title="Downloaded (Leeching)"] .link') ||
      getText('.menu-info [title="Downloaded (Leeching)"]');
    const ratio = getText('.profile-info .profile-ratio-details') ||
      getText('.menu-info [title="Ratio"] .link') ||
      getText('.menu-info [title="Ratio"]');
    const bonus = getText('.total-TL-points') ||
      getText('.menu-info [title*="TL Points"]');
    const seedingNode = doc.querySelector('.menu-info [title="Uploaded (Seeding)"]');
    const leechingNode = doc.querySelector('.menu-info [title="Downloaded (Leeching)"]');
    const hnrNode = doc.querySelector('.menu-info [title="Hit and Run"]');
    const countInParens = (node) => {
      const match = String(node && node.textContent || '').match(/\((\d[\d,.'’ ]*)\)/);
      return match ? match[1] : '';
    };

    const rows = [];
    for (const row of doc.querySelectorAll('.profileViewTable tr')) {
      const cells = Array.from(row.children || []).filter((cell) => cell.tagName === 'TD');
      if (cells.length < 2) continue;
      const label = (cells[0].textContent || '').replace(/[\s\u00a0]+/g, ' ').trim().replace(/:$/, '');
      const value = (cells[1].textContent || '').replace(/[\s\u00a0]+/g, ' ').trim();
      if (label && value) rows.push({ label, value });
    }
    const rowValue = (label) => {
      const row = rows.find((entry) => entry.label.toLowerCase() === label.toLowerCase());
      return row ? row.value : '';
    };
    const userClass = getText('.label-user-class') || rowValue('Class');
    const rawHtml = String(doc.documentElement && doc.documentElement.innerHTML || '');
    const idMatch = rawHtml.match(/\buserLogUserID\s*=\s*['"]?(\d+)['"]?/i) ||
      rawHtml.match(/\bbookmarkTorrentsUserID\s*=\s*(\d+)/i);
    const userId = idMatch ? idMatch[1] : '';

    let profileUrl = '';
    const URLClass = typeof URL !== 'undefined' ? URL : null;
    if (URLClass) {
      try {
        const current = new URLClass(pageUrl || origin, origin);
        const currentMatch = current.pathname.match(/^\/profile\/([^/]+)\/view\/?$/i);
        if (current.origin === origin && currentMatch &&
            decodeURIComponent(currentMatch[1]).toLowerCase() === username.toLowerCase()) profileUrl = current.href;
      } catch (e) { /* discover profile route below */ }
      if (!profileUrl) {
        for (const anchor of doc.querySelectorAll('a[href*="/profile/"]')) {
          const href = anchor.getAttribute('href') || '';
          try {
            const candidate = new URLClass(href, origin);
            const match = candidate.pathname.match(/^\/profile\/([^/]+)\/view\/?$/i);
            if (candidate.origin === origin && match &&
                decodeURIComponent(match[1]).toLowerCase() === username.toLowerCase()) {
              profileUrl = candidate.href;
              break;
            }
          } catch (e) { /* try next profile link */ }
        }
      }
      if (!profileUrl) {
        for (const clickable of doc.querySelectorAll('[onclick*="/profile/"]')) {
          const onclick = clickable.getAttribute('onclick') || '';
          const match = onclick.match(/(['"])(\/profile\/[^'"]+\/view(?:\?[^'"]*)?)\1/i);
          if (!match) continue;
          try {
            const candidate = new URLClass(match[2], origin);
            const route = candidate.pathname.match(/^\/profile\/([^/]+)\/view\/?$/i);
            if (candidate.origin === origin && route &&
                decodeURIComponent(route[1]).toLowerCase() === username.toLowerCase()) {
              profileUrl = candidate.href;
              break;
            }
          } catch (e) { /* try next clickable profile link */ }
        }
      }
    }
    if (!profileUrl && username && URLClass) {
      profileUrl = new URLClass('/profile/' + encodeURIComponent(username) + '/view', origin).href;
    }

    const stats = mapTorrentLeechProfileRows(rows, {
      uploaded, downloaded, ratio, bonus_points: bonus,
      seeding: countInParens(seedingNode),
      leeching: countInParens(leechingNode),
      hit_and_runs: hnrNode && hnrNode.textContent,
      user_class: userClass,
      torrent_comments: rowValue('Torrent comments'),
      invites: rowValue('Invitations'),
      joined_at: rowValue('Registration date'),
      last_access: rowValue('Last visit'),
    });
    if (!Number.isFinite(stats.uploaded) || !Number.isFinite(stats.downloaded)) {
      throw new ReadError('TorrentLeech could not extract both Uploaded and Downloaded values.');
    }
    return { kind: 'torrentleech', userId: userId || username.toLowerCase(), username, profileUrl, stats };
  }

  async function readTorrentLeech(tracker, context) {
    context = context || {};
    const origin = context.origin || location.origin;
    const request = context.request || fetchText;
    const sourceDocument = Object.prototype.hasOwnProperty.call(context, 'document') ? context.document : document;
    const pageUrl = context.pageUrl || location.href;

    let homeDocument = sourceDocument;
    if (!isTorrentLeechDocument(homeDocument)) {
      const result = await request(new URL('/', origin).href, 'text/html');
      homeDocument = new DOMParser().parseFromString(result.text, 'text/html');
    }
    const homeUrl = (() => {
      try { return new URL(pageUrl || '/', origin).href; } catch (e) { return new URL('/', origin).href; }
    })();
    const homeData = parseTorrentLeechDocument(homeDocument, homeUrl, origin);
    const profileUrl = homeData.profileUrl || tracker.profileUrl;
    if (!profileUrl) throw new ReadError('TorrentLeech could not find the signed-in profile page.');

    let profileData = null;
    try {
      const current = new URL(pageUrl || '/', origin);
      const target = new URL(profileUrl, origin);
      if (sourceDocument && current.origin === origin && current.href === target.href) {
        profileData = homeData;
      } else {
        const result = await request(target.href, 'text/html');
        if (/\/user\/account\/login/i.test(result.url || '')) throw new ReadError('TorrentLeech session expired. Sign in again and refresh.');
        const profileDocument = new DOMParser().parseFromString(result.text, 'text/html');
        profileData = parseTorrentLeechDocument(profileDocument, target.href, origin);
      }
    } catch (e) {
      // A valid authenticated top-bar is still sufficient if profile enrichment is temporarily unavailable.
      if (!homeData || !Number.isFinite(homeData.stats.uploaded) || !Number.isFinite(homeData.stats.downloaded)) throw e;
    }

    const chosen = profileData || homeData;
    chosen.profileUrl = profileUrl;
    chosen.stats = Object.assign({}, homeData.stats || {}, chosen.stats || {});
    if (!Number.isFinite(chosen.stats.uploaded) || !Number.isFinite(chosen.stats.downloaded)) {
      throw new ReadError('TorrentLeech did not return valid Uploaded and Downloaded values.');
    }
    return chosen;
  }

  function parseMyAnonamouseProfile(doc, profileUrl, origin, si) {
    const html = String(doc.documentElement && doc.documentElement.innerHTML || '').toLowerCase();
    if (doc.querySelector('input[type="password"]') || /\/login(?:\.php)?(?:[?#"']|$)|name=["']login["']/.test(html)) {
      throw new ReadError('MyAnonamouse login session is not available. Sign in and refresh.');
    }
    if (!doc.querySelector('#userStat')) throw new ReadError('MyAnonamouse account status header was not found. The page may not be authenticated or its layout changed.');
    const uidInput = doc.querySelector('input[name="uid"]');
    const pageProfile = new URL(profileUrl, origin);
    const pathId = (pageProfile.pathname.match(/^\/u\/(\d+)\/?$/) || [])[1] || '';
    const pageUid = uidInput ? String(uidInput.value || uidInput.getAttribute('value') || '').trim() : '';
    const userId = pageUid || pathId;
    if (!/^\d+$/.test(userId) || (pathId && pathId !== userId)) throw new ReadError('MyAnonamouse could not verify the signed-in profile ID.');

    const rows = [];
    for (const row of doc.querySelectorAll('#userDetailsMain table.fullWidth tr, #userDetailsMain table.umtjc tr, table.fullWidth.umtjc tr')) {
      const cells = Array.from(row.children).filter((cell) => cell.tagName === 'TD');
      if (cells.length < 2) continue;
      const label = (cells[0].textContent || '').replace(/[\s\u00a0]+/g, ' ').trim();
      const value = (cells[1].textContent || '').replace(/[\s\u00a0]+/g, ' ').trim();
      if (label && value) rows.push({ label, value });
    }
    const header = doc.querySelector('#userStat');
    const stats = mapMyAnonamouseProfileRows(rows, header && header.textContent);
    if (stats.uploaded === undefined) { const value = doc.querySelector('#uploadedTD'); if (value) stats.uploaded = parseBytes(value.textContent, false); }
    if (stats.downloaded === undefined) { const value = doc.querySelector('#downloadedTD'); if (value) stats.downloaded = parseBytes(value.textContent, false); }
    if (stats.ratio === undefined) {
      const value = doc.querySelector('#tmR');
      if (value) { const parsed = parseRatio(value.textContent); if (parsed && !parsed.infinite) stats.ratio = parsed.value; }
    }
    if (stats.bonus_points === undefined) {
      const value = doc.querySelector('#tmBP');
      const match = value && (value.textContent || '').match(/Bonus\s*:\s*(\d[\d.,]*)/i);
      if (match) stats.bonus_points = parseLocaleNumber(match[1]);
    }
    if (!Number.isFinite(stats.uploaded) || !Number.isFinite(stats.downloaded)) {
      throw new ReadError('MyAnonamouse could not extract both Uploaded and Downloaded from your profile.');
    }
    const menuUser = doc.querySelector('#userMenu');
    const titleMatch = String(doc.title || '').match(/^Details for\s+(.+?)\s*\|\s*My Anonamouse/i);
    const username = (titleMatch && titleMatch[1]) || (menuUser && (menuUser.textContent || '').replace(/[\/↓\s]+$/g, '').trim()) || '';
    return { kind: 'myanonamouse', userId, username, profileUrl: pageProfile.href, stats };
  }

  async function readMyAnonamouse(tracker, context) {
    context = context || {};
    const origin = context.origin || location.origin;
    const request = context.request || fetchText;
    const sourceDocument = Object.prototype.hasOwnProperty.call(context, 'document') ? context.document : document;
    const pageUrl = context.pageUrl || location.href;
    let homeDocument = sourceDocument;
    if (!homeDocument || !homeDocument.querySelector('#mainmenu .mmUserStats a.myInfo[href*="/u/"]')) {
      const result = await request(new URL('/index.php', origin).href, 'text/html');
      homeDocument = new DOMParser().parseFromString(result.text, 'text/html');
    }
    const profileLink = homeDocument.querySelector('#mainmenu .mmUserStats a.myInfo[href*="/u/"]');
    if (!profileLink) throw new ReadError('MyAnonamouse could not find the logged-in My Info profile link. Sign in and retry.');
    const profileUrl = new URL(profileLink.getAttribute('href'), origin);
    if (profileUrl.origin !== origin || !/^\/u\/\d+\/?$/.test(profileUrl.pathname)) throw new ReadError('MyAnonamouse returned an invalid My Info profile link.');
    let profileDocument = null;
    try {
      const current = new URL(pageUrl, origin);
      if (sourceDocument && current.origin === origin && /^\/u\/\d+\/?$/.test(current.pathname) &&
          current.pathname.replace(/\/$/, '') === profileUrl.pathname.replace(/\/$/, '')) profileDocument = sourceDocument;
    } catch (e) { /* fetch profile below */ }
    if (!profileDocument) {
      const result = await request(profileUrl.href, 'text/html');
      if (/\/login(?:\.php)?(?:[?#]|$)/i.test(result.url || '')) throw new ReadError('MyAnonamouse session expired. Sign in again and refresh.');
      profileDocument = new DOMParser().parseFromString(result.text, 'text/html');
    }
    return parseMyAnonamouseProfile(profileDocument, profileUrl.href, origin, !!tracker.si);
  }

  function parseFileListProfile(doc, profileUrl, origin, si) {
    const html = String(doc.documentElement && doc.documentElement.innerHTML || '').toLowerCase();
    if (doc.querySelector('input[type="password"]') ||
        /\/login\.php(?:[?#"']|$)|name=["']login["']/.test(html)) {
      throw new ReadError('FileList login session is not available. Sign in and refresh.');
    }

    const statusbar = doc.querySelector('.statusbar');
    if (!statusbar) throw new ReadError('FileList status bar was not found. The page may not be authenticated or its layout changed.');
    const userLink = statusbar.querySelector('a[href*="userdetails.php?id="]');
    if (!userLink) throw new ReadError('FileList could not find the logged-in account profile link.');

    let userId = '';
    let username = '';
    try {
      const link = new URL(userLink.getAttribute('href'), origin);
      if (link.origin === origin && /\/userdetails\.php$/i.test(link.pathname)) {
        userId = link.searchParams.get('id') || '';
      }
    } catch (e) { /* validate below */ }
    username = (userLink.textContent || '').replace(/\s+/g, ' ').trim();

    const rows = [];
    for (const row of doc.querySelectorAll('table tr')) {
      const cells = Array.from(row.children).filter((cell) => cell.tagName === 'TD');
      if (cells.length < 2) continue;
      const label = (cells[0].textContent || '').replace(/\s+/g, ' ').trim();
      const value = (cells[1].textContent || '').replace(/\s+/g, ' ').trim();
      if (label && value) rows.push({ label, value });
    }

    const seedRow = rows.find((row) => /^seed bonus$/i.test(row.label));
    const statusText = (statusbar.textContent || '').replace(/\s+/g, ' ').trim();
    const stats = mapFileListProfileRows(rows, statusText, seedRow && seedRow.value);
    if (!Number.isFinite(stats.uploaded) || !Number.isFinite(stats.downloaded)) {
      throw new ReadError('FileList could not extract both Uploaded and Downloaded values from the profile.');
    }

    const profile = new URL(profileUrl, origin);
    const profileId = profile.searchParams.get('id') || '';
    if (!/^\d+$/.test(userId) || !/^\d+$/.test(profileId) || userId !== profileId) {
      throw new ReadError('FileList returned a profile that does not match the logged-in account.');
    }

    return {
      kind: 'filelist',
      userId,
      username,
      profileUrl: profile.href,
      stats,
    };
  }

  async function readFileList(tracker, context) {
    context = context || {};
    const origin = context.origin || location.origin;
    const request = context.request || fetchText;
    const sourceDocument = Object.prototype.hasOwnProperty.call(context, 'document') ? context.document : document;
    const pageUrl = context.pageUrl || location.href;

    let homeDocument = sourceDocument;
    if (!homeDocument || !homeDocument.querySelector('.statusbar a[href*="userdetails.php?id="]')) {
      const result = await request(new URL('/index.php', origin).href, 'text/html');
      homeDocument = new DOMParser().parseFromString(result.text, 'text/html');
    }

    const statusLink = homeDocument.querySelector('.statusbar a[href*="userdetails.php?id="]');
    if (!statusLink) {
      throw new ReadError('FileList could not find the signed-in user profile link. Sign in and retry.');
    }

    const profileUrl = new URL(statusLink.getAttribute('href'), origin);
    if (profileUrl.origin !== origin || !/\/userdetails\.php$/i.test(profileUrl.pathname) ||
        !/^\d+$/.test(profileUrl.searchParams.get('id') || '')) {
      throw new ReadError('FileList returned an invalid user profile link.');
    }

    let profileDocument = null;
    try {
      const current = new URL(pageUrl, origin);
      if (sourceDocument && current.origin === origin &&
          /\/userdetails\.php$/i.test(current.pathname) &&
          current.searchParams.get('id') === profileUrl.searchParams.get('id')) {
        profileDocument = sourceDocument;
      }
    } catch (e) { /* fetch profile below */ }

    if (!profileDocument) {
      const result = await request(profileUrl.href, 'text/html');
      if (/\/login\.php/i.test(result.url || '')) {
        throw new ReadError('FileList session expired. Sign in again and refresh.');
      }
      profileDocument = new DOMParser().parseFromString(result.text, 'text/html');
    }

    return parseFileListProfile(profileDocument, profileUrl.href, origin, !!tracker.si);
  }

  function parseCinemageddonProfile(doc, profileUrl, origin, si) {
    const html = String(doc.documentElement && doc.documentElement.innerHTML || '').toLowerCase();
    if (doc.querySelector('input[type="password"]') ||
        /\/login\.php|\/login\.php\?|name=["']login["']/.test(html)) {
      throw new ReadError('Cinemageddon login session is not available. Sign in and refresh.');
    }
    const statusbar = doc.querySelector('.statusbar');
    if (!statusbar) throw new ReadError('Cinemageddon status bar was not found. The page may not be authenticated or its layout changed.');

    const userLink = statusbar.querySelector('a[href*="userdetails.php?id="]');
    let userId = '';
    let username = '';
    if (userLink) {
      try {
        const link = new URL(userLink.getAttribute('href'), origin);
        if (link.origin === origin && /\/userdetails\.php$/i.test(link.pathname)) {
          userId = link.searchParams.get('id') || '';
        }
      } catch (e) { /* identity remains empty */ }
      username = (userLink.textContent || '').replace(/\s+/g, ' ').trim();
    }

    const rows = [];
    for (const row of doc.querySelectorAll('table.frames tr')) {
      const cells = Array.from(row.children).filter((cell) => cell.tagName === 'TD');
      if (cells.length < 2) continue;
      const label = (cells[0].textContent || '').replace(/\s+/g, ' ').trim();
      const value = (cells[1].textContent || '').replace(/\s+/g, ' ').trim();
      if (label && value) rows.push({ label: label.replace(/\s+/g, ' '), value });
    }

    const statusText = (statusbar.textContent || '').replace(/\s+/g, ' ').trim();
    const stats = mapCinemageddonProfileRows(rows, si, statusText);

    const torrentCounts = [
      ['seeding', statusbar.querySelector('img[alt="seeding"], img[title="seeding"]')],
      ['leeching', statusbar.querySelector('img[alt="leeching"], img[title="leeching"]')],
    ];
    for (const [key, icon] of torrentCounts) {
      if (!icon) continue;
      let value = icon.nextElementSibling;
      while (value && value.tagName !== 'B') value = value.nextElementSibling;
      if (value) {
        const count = parseCount(value.textContent || '');
        if (count !== null) stats[key] = count;
      }
    }

    if (!Number.isFinite(stats.uploaded) || !Number.isFinite(stats.downloaded)) {
      throw new ReadError('Cinemageddon could not extract both Uploaded and Downloaded from the profile or status bar.');
    }

    const profile = new URL(profileUrl, origin);
    const idFromUrl = profile.searchParams.get('id') || '';
    if (userId && idFromUrl && userId !== idFromUrl) {
      throw new ReadError('Cinemageddon returned a different member profile than the logged-in account.');
    }
    if (!userId) userId = idFromUrl;

    return {
      kind: 'cinemageddon',
      userId,
      username,
      profileUrl: profile.href,
      stats,
    };
  }

  async function readCinemageddon(tracker, context) {
    context = context || {};
    const origin = context.origin || location.origin;
    const request = context.request || fetchText;
    const sourceDocument = Object.prototype.hasOwnProperty.call(context, 'document') ? context.document : document;
    const pageUrl = context.pageUrl || location.href;

    let homeDocument = sourceDocument;
    let homeUrl = pageUrl;
    if (!homeDocument || !homeDocument.querySelector('.statusbar a[href*="userdetails.php?id="]')) {
      const result = await request(new URL('/index.php', origin).href, 'text/html');
      homeDocument = new DOMParser().parseFromString(result.text, 'text/html');
      homeUrl = result.url || new URL('/index.php', origin).href;
    }

    const statusLink = homeDocument.querySelector('.statusbar a[href*="userdetails.php?id="]');
    if (!statusLink) {
      throw new ReadError('Cinemageddon could not find the signed-in user profile link. Sign in and retry.');
    }

    const profileUrl = new URL(statusLink.getAttribute('href'), origin);
    if (profileUrl.origin !== origin || !/\/userdetails\.php$/i.test(profileUrl.pathname) ||
        !/^\d+$/.test(profileUrl.searchParams.get('id') || '')) {
      throw new ReadError('Cinemageddon returned an invalid user profile link.');
    }

    let profileDocument = null;
    try {
      const current = new URL(pageUrl, origin);
      if (sourceDocument && current.origin === origin &&
          /\/userdetails\.php$/i.test(current.pathname) &&
          current.searchParams.get('id') === profileUrl.searchParams.get('id')) {
        profileDocument = sourceDocument;
      }
    } catch (e) { /* fetch the profile below */ }

    if (!profileDocument) {
      const result = await request(profileUrl.href, 'text/html');
      if (/\/login\.php/i.test(result.url || '')) {
        throw new ReadError('Cinemageddon session expired. Sign in again and refresh.');
      }
      profileDocument = new DOMParser().parseFromString(result.text, 'text/html');
    }

    return parseCinemageddonProfile(profileDocument, profileUrl.href, origin, !!tracker.si);
  }

  async function readIptorrents(tracker, context) {
    context = context || {};
    const origin = context.origin || location.origin;
    const request = context.request || fetchText;
    const sourceDocument = Object.prototype.hasOwnProperty.call(context, 'document') ? context.document : document;
    const pageUrl = context.pageUrl || location.href;
    const host = new URL(origin).hostname;

    let current = null;
    if (sourceDocument && sourceDocument.querySelector('.stats')) {
      const profileId = iptProfileIdFromUrl(pageUrl, origin);
      current = parseIptDocument(sourceDocument, host, profileId, origin);
    }

    let userId = String((current && current.userId) || tracker.userId || '').trim();
    if (!/^\d+$/.test(userId)) {
      // On first discovery, the logged-in member's /u/{id} link is in the stats bar.
      const home = await request(new URL('/', origin).href, 'text/html');
      const homeDoc = new DOMParser().parseFromString(home.text, 'text/html');
      const parsedHome = parseIptDocument(homeDoc, host, null, origin);
      userId = String(parsedHome.userId || '');
      if (!/^\d+$/.test(userId)) throw new ReadError('IPTorrents could not find your own /u/{id} profile link.');
      current = parsedHome;
    }

    const profileUrl = new URL('/u/' + encodeURIComponent(userId), origin).href;
    let profileData = null;
    if (sourceDocument && iptProfileIdFromUrl(pageUrl, origin) === Number(userId)) {
      profileData = parseIptDocument(sourceDocument, host, Number(userId), origin);
    } else {
      try {
        const result = await request(profileUrl, 'text/html');
        if (/\/auth\/login|\/login/i.test(result.url || '')) {
          throw new ReadError('IPTorrents login session expired. Sign in again and refresh.');
        }
        const profileDoc = new DOMParser().parseFromString(result.text, 'text/html');
        profileData = parseIptDocument(profileDoc, host, Number(userId), origin);
      } catch (e) {
        // The logged-in stats bar is already sufficient for correct totals.
        if (!current) throw e;
      }
    }

    const chosen = profileData || current;
    if (!chosen || !Number.isFinite(chosen.stats.uploaded) || !Number.isFinite(chosen.stats.downloaded)) {
      throw new ReadError('IPTorrents did not return valid Uploaded and Downloaded statistics.');
    }
    chosen.userId = chosen.userId || userId;
    chosen.username = chosen.username || (tracker.username || userId);
    chosen.profileUrl = profileUrl;
    return chosen;
  }

  function trackerApiType(tracker) {
    let hostname = String(tracker && tracker.host || '');
    try {
      if (tracker && tracker.origin) hostname = new URL(tracker.origin).hostname;
    } catch (e) { /* fall back to the saved host */ }
    hostname = String(hostname).toLowerCase().replace(/^www\./, '');
    if (hostname === 'digitalcore.club' || hostname.endsWith('.digitalcore.club')) return 'digitalcore';
    if (hostname === 'superbits.org' || hostname.endsWith('.superbits.org')) return 'rartracker';
    if (isIptorrentsHost(hostname)) return 'iptorrents';
    if (isTorrentLeechTracker(tracker)) return 'torrentleech';
    if (isTranceTrafficTracker(tracker)) return 'trancetraffic';
    if (isMyAnonamouseTracker(tracker)) return 'myanonamouse';
    if (isFileListTracker(tracker)) return 'filelist';
    if (isCinemageddonTracker(tracker)) return 'cinemageddon';
    return null;
  }

  async function readTracker(tracker, context) {
    context = context || {};
    const origin = context.origin || location.origin;
    const request = context.request || fetchText;
    const sourceDocument = Object.prototype.hasOwnProperty.call(context, 'document') ? context.document : document;
    const pageUrl = context.pageUrl || (sourceDocument ? location.href : origin + '/');
    const apiType = trackerApiType(tracker);
    const complete = async (result) =>
      attachProfileAddress(await result, tracker, { origin, document: sourceDocument, pageUrl }, request);

    if (apiType === 'digitalcore') return complete(readDigitalCore(tracker, request));
    if (apiType === 'rartracker') return complete(readRartracker(tracker, request));
    if (apiType === 'iptorrents') return complete(readIptorrents(tracker, { origin, request, document: sourceDocument, pageUrl }));
    if (apiType === 'torrentleech' || isTorrentLeechDocument(sourceDocument)) return complete(readTorrentLeech(tracker, { origin, request, document: sourceDocument, pageUrl }));
    if (apiType === 'trancetraffic' || isTranceTrafficDocument(sourceDocument)) return complete(readTranceTraffic(tracker, { origin, request, document: sourceDocument, pageUrl }));
    if (apiType === 'myanonamouse' || isMyAnonamouseDocument(sourceDocument)) return complete(readMyAnonamouse(tracker, { origin, request, document: sourceDocument, pageUrl }));
    if (apiType === 'filelist' || isFileListDocument(sourceDocument)) return complete(readFileList(tracker, { origin, request, document: sourceDocument, pageUrl }));
    if (apiType === 'cinemageddon' || isCinemageddonDocument(sourceDocument)) return complete(readCinemageddon(tracker, { origin, request, document: sourceDocument, pageUrl }));

    const si = !!tracker.si;
    const kinds = tracker.kind === 'gazelle' || tracker.kind === 'profile' ? [tracker.kind] : ['gazelle', 'profile'];
    let lastError;
    for (const kind of kinds) {
      try {
        if (kind === 'gazelle') return complete(readGazelle(request));
        const link = await discoverProfile(tracker, request, origin, sourceDocument, pageUrl);
        return complete(readProfile(link.url, link.text, si, request, origin));
      } catch (e) {
        if (!(e instanceof ReadError)) throw e;
        lastError = e;
      }
    }
    throw lastError || new ReadError('Could not read this tracker.');
  }

  function managerFetchText(url, accept) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') return reject(new ReadError('Userscript manager requests are unavailable.'));
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { Accept: accept || '*/*' },
        responseType: 'text',
        timeout: 25000,
        anonymous: false,
        onload: (response) => {
          const status = Number(response.status) || 0;
          const text = typeof response.responseText === 'string' ? response.responseText
            : (typeof response.response === 'string' ? response.response : '');
          const finalUrl = response.finalUrl || url;
          if (status < 200 || status >= 300) {
            reject(new ReadError('Tracker request returned HTTP ' + status + ' for ' + new URL(url).pathname + '.'));
            return;
          }
          resolve({ text, url: finalUrl, redirected: finalUrl !== url });
        },
        onerror: () => reject(new ReadError('The userscript manager could not connect to this tracker.')),
        ontimeout: () => reject(new ReadError('The tracker request timed out.')),
        onabort: () => reject(new ReadError('The tracker request was cancelled.')),
      });
    });
  }

  async function readTrackerRemote(tracker) {
    let origin;
    try { origin = new URL(tracker.origin || ('https://' + tracker.host)).origin; }
    catch (e) { throw new ReadError('The saved tracker address is invalid.'); }
    const request = (url, accept) => managerFetchText(new URL(url, origin).href, accept);
    return readTracker(tracker, { request, origin, document: null, pageUrl: origin + '/' });
  }

  /* ======================================================================
   * The tracker's logo: the page's own icon, as a small PNG
   * ==================================================================== */

  function iconCandidates() {
    const found = [];
    document.querySelectorAll('link[rel~="apple-touch-icon"], link[rel~="apple-touch-icon-precomposed"], link[rel~="icon"], link[rel="shortcut icon"]').forEach((l) => {
      const href = l.getAttribute('href');
      if (!href || href.startsWith('data:')) return;
      const size = ((l.getAttribute('sizes') || '').match(/(\d+)x/) || [])[1];
      const score = (/apple/.test(l.rel) ? 1000 : 0) + (size ? Number(size) : 0) - (/\.svg(\?|$)/i.test(href) ? 500 : 0);
      found.push({ url: new URL(href, location.href).href, score });
    });
    ['/apple-touch-icon.png', '/favicon.png', '/favicon.ico'].forEach((p, i) => found.push({ url: location.origin + p, score: -100 - i }));
    const seen = new Set();
    return found.sort((a, b) => b.score - a.score).filter((c) => !seen.has(c.url) && seen.add(c.url)).slice(0, 6).map((c) => c.url);
  }

  function gmBlob(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'blob', anonymous: true, timeout: 15000,
        onload: (r) => (r.status >= 200 && r.status < 300 && r.response && r.response.size ? resolve(r.response) : reject(new Error('no icon'))),
        onerror: () => reject(new Error('no icon')), ontimeout: () => reject(new Error('no icon')),
      });
    });
  }

  async function iconBlob(url) {
    if (new URL(url).origin === location.origin) {
      try {
        const res = await fetch(url, { credentials: 'omit' });
        if (res.ok) { const blob = await res.blob(); if (blob.size) return blob; }
      } catch (e) { /* try the manager's request */ }
    }
    return gmBlob(url);
  }

  async function blobToPng(blob, size) {
    let bitmap;
    try { bitmap = await createImageBitmap(blob); } catch (e) {
      bitmap = await new Promise((resolve, reject) => {
        const img = new Image(), src = URL.createObjectURL(blob);
        img.onload = () => { URL.revokeObjectURL(src); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(src); reject(new Error('undecodable')); };
        img.src = src;
      });
    }
    const w0 = bitmap.width || bitmap.naturalWidth, h0 = bitmap.height || bitmap.naturalHeight;
    if (!w0 || !h0) throw new Error('empty');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const scale = Math.min(size / w0, size / h0), w = w0 * scale, h = h0 * scale;
    ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
    const pixels = ctx.getImageData(0, 0, size, size).data;
    let visible = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 16) visible++;
    if (visible < 40) throw new Error('blank');
    return canvas.toDataURL('image/png');
  }

  async function detectLogo() {
    for (const url of iconCandidates()) {
      try {
        const png = await blobToPng(await iconBlob(url), 128);
        if (png.length < 300000) return png;
      } catch (e) { /* next candidate */ }
    }
    return null;
  }

  /* ======================================================================
   * Little UI: a toast and a panel in a shadow root, so no page style leaks in or out
   * ==================================================================== */

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .toast { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; max-width: 360px; padding: 12px 14px; border-radius: 10px;
      background: #1e293b; color: #f8fafc; font-size: 13px; line-height: 1.4; box-shadow: 0 8px 28px rgba(0,0,0,.35); display: flex; gap: 10px; align-items: flex-start; }
    .toast.err { background: #7f1d1d; } .toast.ok { background: #14532d; }
    .toast b { display: block; margin-bottom: 2px; }
    .toast .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .toast button, .toast a { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,.35); background: transparent; color: #fff; cursor: pointer; text-decoration: none; }
    .toast button.primary { background: #fff; color: #0f172a; border-color: #fff; }
    .toast .x { margin-left: auto; border: 0; font-size: 16px; line-height: 1; padding: 0 2px; opacity: .7; }
    .scrim { position: fixed; inset: 0; z-index: 2147483646; background: rgba(2,6,23,.55); display: flex; align-items: center; justify-content: center; padding: 16px; }
    .panel { width: min(920px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: #fff; color: #0f172a; border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,.45); font-size: 14px; }
    .panel-layout { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 18px; align-items: start; }
    .tracker-preview { position: sticky; top: 0; align-self: start; padding: 16px; border: 1px solid rgba(148,163,184,.28); border-radius: 12px; background: rgba(148,163,184,.08); min-width: 0; }
    .tracker-preview .logo { width: 76px; height: 76px; margin: 0 auto 12px; border-radius: 16px; font-size: 11px; }
    .preview-name { text-align: center; font-size: 15px; font-weight: 700; overflow-wrap: anywhere; margin-bottom: 16px; }
    .preview-stat { padding: 12px; border-radius: 9px; background: rgba(37,99,235,.09); }
    .preview-stat small { display: block; color: #64748b; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
    .preview-stat strong { display: block; margin-top: 5px; font-size: 17px; overflow-wrap: anywhere; }
    .panel-fields { min-width: 0; display: grid; gap: 12px; }
    @media (max-width: 680px) { .panel-layout { grid-template-columns: 1fr; } .tracker-preview { position: static; display: grid; grid-template-columns: 64px minmax(0,1fr); gap: 4px 12px; align-items: center; } .tracker-preview .logo { width: 56px; height: 56px; grid-row: span 2; margin: 0; } .preview-name { text-align: left; margin: 0; } .preview-stat { grid-column: 1 / -1; } }
    @media (prefers-color-scheme: dark) { .panel { background: #0f172a; color: #e2e8f0; } input, select { background: #1e293b !important; color: #e2e8f0 !important; border-color: #334155 !important; } .muted { color: #94a3b8 !important; } .row { border-color: #1e293b !important; } }
    .panel header { display: flex; align-items: center; gap: 12px; padding: 16px 18px; border-bottom: 1px solid rgba(148,163,184,.25); }
    .panel h2 { margin: 0; font-size: 16px; }
    .panel .body { padding: 14px 18px; display: grid; gap: 12px; }
    .panel footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 18px 16px; border-top: 1px solid rgba(148,163,184,.25); }
    .logo { width: 44px; height: 44px; border-radius: 10px; object-fit: contain; background: rgba(148,163,184,.18); flex: none; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #64748b; }
        label { display: grid; gap: 4px; font-size: 12px; font-weight: 600; }
    input, select { font: inherit; font-weight: 400; font-size: 14px; padding: 7px 9px; border-radius: 8px; border: 1px solid #cbd5e1; background: #fff; color: #0f172a; width: 100%; }
    input[type=checkbox] { width: auto; }
    .check { display: flex; align-items: center; gap: 8px; font-weight: 400; font-size: 13px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .muted { color: #64748b; font-weight: 400; font-size: 12px; }
    .note { padding: 8px 10px; border-radius: 8px; font-size: 12.5px; background: rgba(234,179,8,.15); }
    .note.err { background: rgba(239,68,68,.15); } .note.ok { background: rgba(34,197,94,.15); }
    button.btn { font: inherit; font-weight: 600; font-size: 13px; padding: 8px 14px; border-radius: 8px; border: 1px solid #cbd5e1; background: transparent; color: inherit; cursor: pointer; }
    button.btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
    button.btn:disabled { opacity: .55; cursor: default; }
    .row { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-top: 1px solid #e2e8f0; font-size: 13px; }
    .row .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `;

  let hostEl = null, root = null;
  function ui() {
    if (root) return root;
    hostEl = document.createElement('div');
    hostEl.id = 'sherlock-sync-root';
    document.documentElement.appendChild(hostEl);
    root = hostEl.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    return root;
  }

  // h('div', {class: 'x', onclick: fn}, child, 'text'): elements from code, never from strings of markup.
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }

  let toastEl = null, toastTimer = null;
  function toast(message, opts) {
    opts = opts || {};
    if (toastEl) toastEl.remove();
    clearTimeout(toastTimer);
    const close = () => { if (toastEl) toastEl.remove(); toastEl = null; };
    toastEl = h('div', { class: 'toast ' + (opts.kind || ''), role: 'status' },
      h('div', {}, opts.title ? h('b', {}, opts.title) : null, message,
        opts.actions ? h('div', { class: 'actions' }, opts.actions.map((a) => (a.href
          ? h('a', { href: a.href, target: '_blank', rel: 'noopener' }, a.label)
          : h('button', { class: a.primary ? 'primary' : '', onclick: () => { close(); a.onClick && a.onClick(); } }, a.label)))) : null),
      h('button', { class: 'x', title: 'Close', onclick: close }, '×'));
    ui().appendChild(toastEl);
    if (opts.ttl !== 0) toastTimer = setTimeout(close, opts.ttl || 7000);
  }

  function openPanel(build) {
    const scrim = h('div', { class: 'scrim' });
    const close = () => scrim.remove();
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
    scrim.appendChild(build(close));
    ui().appendChild(scrim);
    return close;
  }

  /* ======================================================================
   * Adding a tracker, or editing one: a panel with what was found, all of it changeable
   * ==================================================================== */

  const FIELDS = [
    ['uploaded', 'Uploaded', 'bytes'], ['downloaded', 'Downloaded', 'bytes'],
    ['buffer', 'Buffer', 'bytes'], ['ratio', 'Ratio', 'number'],
    ['required_ratio', 'Required Ratio', 'number'], ['required_class_ratio', 'Required Class Ratio', 'number'],
    ['bonus_points', 'Bonus points', 'number'],
    ['seeding', 'Seeding', 'count'], ['leeching', 'Leeching', 'count'],
    ['snatched', 'Snatched', 'count'], ['user_class', 'Class', 'text'],
  ];

  function fieldText(kind, value) {
    if (value === null || value === undefined) return '';
    return kind === 'bytes' ? sizeLabel(value) : String(value);
  }

  function readField(kind, text, si) {
    const t = String(text).trim();
    if (!t) return null;
    if (kind === 'bytes') return parseBytes(t, si) ?? (/^\d+$/.test(t) ? Number(t) : null);
    if (kind === 'number') { const r = parseRatio(t); return r && !r.infinite ? r.value : null; }
    if (kind === 'count') return parseCount(t);
    return t.slice(0, 50);
  }

  async function openTrackerPanel(existing) {
    const tracker = existing || {
      host: HOST, origin: location.origin, name: trackerNameForNewTracker(document.title, HOST, location.origin, document), shortName: '', enabled: true, kind: 'auto',
      profileUrl: null, username: '', userId: '', si: false, logo: null, lastSync: 0, stats: {},
    };
    if (!tracker.shortName) tracker.shortName = shortNameOf(tracker.name);

    const state = { stats: Object.assign({}, tracker.stats), userId: tracker.userId, username: tracker.username, kind: tracker.kind, readOk: !!existing, logo: tracker.logo };
    const refs = {};
    let busy = false;

    const note = h('div', { class: 'note', hidden: true });
    const showNote = (text, kind) => { note.hidden = !text; note.className = 'note ' + (kind || ''); note.textContent = text || ''; };
    const logoBox = h('div', { class: 'logo' }, 'logo');
    const paintLogo = () => {
      logoBox.replaceChildren();
      if (state.logo) logoBox.appendChild(h('img', { src: state.logo, style: 'width:100%;height:100%;object-fit:contain;border-radius:10px' }));
      else logoBox.textContent = 'no logo';
    };

    const input = (key, label, type, value, extra) => {
      const el = h('input', Object.assign({ type: type || 'text', value: value ?? '', autocomplete: 'off', spellcheck: 'false' }, extra || {}));
      refs[key] = el;
      return h('label', {}, label, el);
    };

    const fill = (data) => {
      state.stats = data.stats || {};
      state.userId = data.userId || state.userId;
      state.username = data.username || state.username;
      state.kind = data.kind;
      if (data.profileUrl) refs.profileUrl.value = data.profileUrl;
      refs.username.value = state.username || '';
      for (const [key, , kind] of FIELDS) refs['f_' + key].value = fieldText(kind, state.stats[key]);
      state.readOk = true;
    };

    const reread = async () => {
      const t = Object.assign({}, tracker, { si: refs.si.checked, kind: refs.profileUrl.value.trim() ? 'profile' : tracker.kind, profileUrl: refs.profileUrl.value.trim() || null });
      showNote('Reading your stats from ' + t.host + '…', '');
      try {
        fill(await readTracker(t));
        updatePreview();
        showNote('Found your stats. Check them, then add the tracker.', 'ok');
      } catch (e) {
        state.readOk = false;
        showNote((e.message || 'Could not read the page.') + ' You can paste your profile page address, or type the numbers in by hand.', 'err');
      }
    };

    const detectLogoAgain = async () => {
      state.logo = await detectLogo();
      paintLogo();
    };

    const pickFile = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/x-icon,.ico', hidden: true,
      onchange: async (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        try { state.logo = await blobToPng(f, 128); paintLogo(); } catch (err) { showNote('That image could not be read.', 'err'); }
      } });

    const fieldInputs = FIELDS.map(([key, label, kind]) => input('f_' + key, label, 'text', fieldText(kind, state.stats[key])));
    const previewName = h('div', { class: 'preview-name' }, tracker.name || HOST);
    const previewUploaded = h('strong', {}, fieldText('bytes', state.stats.uploaded) || 'Not detected yet');
    const updatePreview = () => {
      previewName.textContent = refs.name.value.trim() || tracker.name || HOST;
      const raw = refs.f_uploaded.value.trim();
      const parsed = readField('bytes', raw, refs.si.checked);
      previewUploaded.textContent = parsed === null ? (raw || 'Not detected yet') : sizeLabel(parsed);
    };
    const panel = (close) => {
      const submit = h('button', { class: 'btn primary', onclick: async () => {
        if (busy) return;
        const si = refs.si.checked;
        const stats = {};
        for (const [key, , kind] of FIELDS) { const v = readField(kind, refs['f_' + key].value, si); if (v !== null) stats[key] = v; }
        // required_ratio is detected by the tracker readers even though it is not a visible edit field.
        // Preserve it when saving the panel so required-ratio buffer calculations keep working.
        const detectedRequiredRatio = state.stats && state.stats.required_ratio;
        if (detectedRequiredRatio !== null && detectedRequiredRatio !== undefined &&
            Number.isFinite(Number(detectedRequiredRatio)) && Number(detectedRequiredRatio) >= 0) {
          stats.required_ratio = Number(detectedRequiredRatio);
        }
        if (stats.uploaded == null || stats.downloaded == null) return showNote('Uploaded and downloaded are needed, for example 1.5 TiB.', 'err');
        const username = refs.username.value.trim();
        if (!username) return showNote('Enter your username on this tracker.', 'err');

        const next = Object.assign({}, tracker, {
          name: refs.name.value.trim() || tracker.name, shortName: (refs.shortName.value.trim() || shortNameOf(refs.name.value)).slice(0, 8),
          profileUrl: refs.profileUrl.value.trim() || tracker.profileUrl || null, username, userId: state.userId || username.toLowerCase(),
          si, enabled: true, logo: state.logo, stats,
          kind: state.readOk && state.kind !== 'manual' ? state.kind : 'manual',
        });
        busy = true; submit.disabled = true; submit.textContent = 'Sending…';
        try {
          await push(next, { stats });
          next.enabled = !!refs.auto.checked;
          saveTracker(next);
          close();
          toast(next.name + ' saved locally. Open your Sherlock dashboard in this browser to see it.', { kind: 'ok', ttl: 9000, actions: store.url ? [{ label: 'Open Sherlock', href: store.url + '/dashboard' }] : [] });
        } catch (e) {
          showNote(e.message, 'err');
          busy = false; submit.disabled = false; submit.textContent = existing ? 'Save and send' : 'Add to Sherlock';
        }
      } }, existing ? 'Save and send' : 'Add to Sherlock');

      const nameField = input('name', 'Tracker name', 'text', tracker.name, { maxlength: 60 });
      refs.name.addEventListener('input', updatePreview);
      refs.f_uploaded.addEventListener('input', updatePreview);
      const fields = h('div', { class: 'panel-fields' },
        note,
        h('div', { class: 'grid' }, nameField, input('shortName', 'Short name', 'text', tracker.shortName, { maxlength: 8 })),
        h('div', { class: 'row', style: 'border:0;padding:0;flex-wrap:wrap' },
          h('button', { class: 'btn', type: 'button', onclick: () => pickFile.click() }, 'Choose logo'),
          h('button', { class: 'btn', type: 'button', onclick: detectLogoAgain }, 'Use the site icon'),
          pickFile),
        h('div', { class: 'grid' }, input('username', 'Your username', 'text', tracker.username, { maxlength: 64 }),
          h('label', {}, 'Address', h('input', { value: tracker.origin, readonly: true, disabled: true }))),
        input('profileUrl', 'Profile page address (optional)', 'url', tracker.profileUrl || '', { placeholder: tracker.origin + '/users/yourname' }),
        h('div', { class: 'grid' }, fieldInputs),
        h('label', { class: 'check' }, (refs.si = h('input', { type: 'checkbox', checked: tracker.si, onchange: updatePreview })), 'This tracker counts GB and TB as 1000, not 1024'),
        h('label', { class: 'check' }, (refs.auto = h('input', { type: 'checkbox', checked: tracker.enabled !== false })), 'Automatically update while the Sherlock dashboard is open or when I visit this tracker'),
        h('div', { class: 'muted' }, 'Saved only in this browser profile. The tracker appears on your Sherlock dashboard in this browser and auto-updates while that dashboard tab is open. No Sherlock API or token is used.'));
      const preview = h('aside', { class: 'tracker-preview' }, logoBox, previewName,
        h('div', { class: 'preview-stat' }, h('small', {}, 'Uploaded data'), previewUploaded));
      const body = h('div', { class: 'body' }, h('div', { class: 'panel-layout' }, preview, fields));

      return h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Add tracker to Sherlock' },
        h('header', {}, h('h2', {}, existing ? 'Edit ' + tracker.name : 'Add ' + tracker.name + ' to Sherlock'), h('button', { class: 'btn', style: 'margin-left:auto', onclick: close }, '×')),
        body,
        h('footer', {}, h('button', { class: 'btn', type: 'button', onclick: reread }, 'Read again'), h('button', { class: 'btn', onclick: close }, 'Cancel'), submit));
    };

    openPanel(panel);
    paintLogo();
    updatePreview();
    refs.profileUrl.addEventListener('change', () => { if (refs.profileUrl.value.trim()) reread(); });
    if (!existing) detectLogoAgain();
    // Discover the optional profile address for existing legacy entries when it is missing.
    if (!existing || !tracker.profileUrl) await reread();
  }

  /* ======================================================================
   * Saving and syncing locally
   * ==================================================================== */

  async function push(t, opts) {
    opts = opts || {};
    let stats = opts.stats;
    if (!stats) {
      const data = opts.remote ? await readTrackerRemote(t) : await readTracker(t);
      t.kind = data.kind;
      t.userId = data.userId || t.userId;
      t.username = data.username || t.username;
      if (data.profileUrl) t.profileUrl = data.profileUrl;
      stats = data.stats;
    }
    const now = Date.now();
    const nextStats = Object.assign({}, stats);
    if (nextStats.ratio !== null && nextStats.ratio !== undefined && nextStats.ratio !== '' &&
        Number.isFinite(Number(nextStats.ratio)) && Number(nextStats.ratio) < 0) {
      nextStats.ratio = null;
    }
    const nextBuffer = customTrackerBuffer(nextStats, 'one_to_one');
    t.createdAt = Number(t.createdAt) || now;
    t.history = Array.isArray(t.history) ? t.history : [];
    // Keep real observations only. The dashboard uses these for the 24-hour delta and mini chart.
    if (nextBuffer !== null) {
      const last = t.history[t.history.length - 1];
      if (!last || now - Number(last.at || 0) >= 5 * 60 * 1000) {
        t.history.push({ at: now, buffer: nextBuffer, uploaded: Number(nextStats.uploaded), downloaded: Number(nextStats.downloaded) });
      } else {
        t.history[t.history.length - 1] = { at: now, buffer: nextBuffer, uploaded: Number(nextStats.uploaded), downloaded: Number(nextStats.downloaded) };
      }
      const cutoff = now - 8 * 24 * 60 * 60 * 1000;
      t.history = t.history.filter((point) => Number(point.at) >= cutoff).slice(-240);
    }
    t.stats = nextStats;
    t.lastSync = now;
    t.lastError = null;
    t.lastOutcome = 'updated';
    return { outcome: 'updated', url: store.url ? store.url + '/dashboard' : null };
  }

  async function syncTracker(t, opts) {
    opts = opts || {};
    const lockKey = 'sherlock.lock.' + t.host;
    if (!opts.manual && Date.now() - Number(GM_getValue(lockKey, 0)) < 60000) return;
    GM_setValue(lockKey, Date.now());
    t.lastAttempt = Date.now();
    try {
      await push(t, { remote: !!opts.remote });
      saveTracker(t);
      if (opts.manual) toast(t.name + ' updated in this browser and on your local Sherlock dashboard.', { kind: 'ok', ttl: 9000,
        actions: store.url ? [{ label: 'Open dashboard', href: store.url + '/dashboard' }] : [] });
    } catch (e) {
      t.lastError = e.message || 'Could not read tracker statistics.';
      saveTracker(t);
      if (opts.manual) toast(t.lastError, { kind: 'err', title: 'Sherlock: ' + t.name, ttl: 12000 });
    } finally {
      GM_setValue(lockKey, 0);
    }
  }

  /* ======================================================================
   * Settings panel
   * ==================================================================== */

  function openSettings() {
    openPanel((close) => {
      const url = h('input', { type: 'url', value: store.url, disabled: true, placeholder: DEFAULT_URL });
      const interval = h('input', { type: 'number', min: 15, step: 5, value: store.interval });
      const status = h('div', { class: 'note' }, 'No Sherlock API or token is used. Saved trackers auto-update while this dashboard tab is open; the browser must stay open.');
      return h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Sherlock local tracker settings' },
        h('header', {}, h('h2', {}, 'Sherlock settings'), h('button', { class: 'btn', style: 'margin-left:auto', onclick: close }, '×')),
        h('div', { class: 'body' }, status,
          h('label', {}, 'Sherlock dashboard address', url),
          h('label', {}, 'Try automatic updates at most every … minutes (15 or more)', interval),
          h('div', { class: 'muted' }, 'Custom tracker data is saved by Tampermonkey/Greasemonkey in this browser only. It will not sync to another device or appear to other Sherlock users.'),
          h('div', { class: 'muted' }, 'Trackers on this browser: ' + Object.keys(store.trackers).length)),
        h('footer', {},
          h('button', { class: 'btn', onclick: () => { if (store.url) window.open(store.url + '/dashboard', '_blank', 'noopener'); } }, 'Open dashboard'),
          h('button', { class: 'btn primary', onclick: () => { store.url = url.value; store.interval = interval.value; close(); toast('Local settings saved.', { kind: 'ok' }); } }, 'Save')));
    });
  }

  /* ======================================================================
   * Sherlock dashboard: render browser-local custom tracker cards
   * ==================================================================== */

  function localBytes(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    let n = Number(value), i = 0;
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    while (Math.abs(n) >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(n >= 100 ? 1 : 2).replace(/\.?0+$/, '') : String(Math.round(n))) + ' ' + units[i];
  }

  function parseMetricBytes(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const negative = /^[−-]/.test(text);
    const unsigned = text.replace(/^[−-]\s*/, '');
    const parsed = parseBytes(unsigned, false);
    return parsed === null ? null : (negative ? -parsed : parsed);
  }

  function readMetricNodeBytes(valueNode) {
    if (!valueNode) return null;
    const title = valueNode.getAttribute('title') || '';
    return parseMetricBytes(title) ?? parseMetricBytes(valueNode.textContent);
  }

  function readNativeMetricBytes(card) {
    const valueNode = card && card.querySelector('.num');
    if (!valueNode) return null;

    const title = valueNode.getAttribute('title') || '';
    const savedBase = valueNode.dataset.sherlockNativeBytes;
    const lastOutputTitle = valueNode.dataset.sherlockLastOutputTitle;

    // Keep our original native total on repeated Turbo renders. If Sherlock updates
    // the title itself, detect the changed server value and refresh the stored base.
    if (savedBase !== undefined && (title === lastOutputTitle || !title)) {
      const saved = Number(savedBase);
      return Number.isFinite(saved) ? saved : null;
    }

    const parsed = parseMetricBytes(title) ?? parseMetricBytes(valueNode.textContent);
    if (parsed === null) return null;
    valueNode.dataset.sherlockNativeBytes = String(parsed);
    return parsed;
  }

  function writeDashboardMetric(card, bytes) {
    const valueNode = card && card.querySelector('.num');
    if (!valueNode || !Number.isFinite(bytes)) return;
    const title = Math.round(bytes).toLocaleString() + ' bytes';
    valueNode.textContent = localBytes(bytes);
    valueNode.setAttribute('title', title);
    valueNode.dataset.sherlockLastOutputTitle = title;
  }

  function updateDashboardTotals(customTrackers) {
    const main = document.querySelector('main') || document.querySelector('#main') || document.body;
    const bufferLabelPattern = /^total buffer(?: at required ratio)?$/;
    const summarySection = Array.from(main.querySelectorAll('section')).find((section) => {
      const cards = Array.from(section.children).filter((child) => child.classList.contains('card'));
      const labels = cards.map((card) => {
        const label = card.querySelector('.eyebrow');
        return (label && label.textContent || '').trim().toLowerCase();
      });
      return labels.some((label) => bufferLabelPattern.test(label)) &&
        labels.includes('total uploaded');
    });
    if (!summarySection) return null;

    const cards = Array.from(summarySection.children).filter((child) => child.classList.contains('card'));
    const labelOf = (card) => {
      const label = card && card.querySelector('.eyebrow');
      return (label && label.textContent || '').trim().toLowerCase();
    };
    const bufferCard = cards.find((card) => bufferLabelPattern.test(labelOf(card)));
    const uploadedCard = cards.find((card) => labelOf(card) === 'total uploaded');
    if (!bufferCard || !uploadedCard) return null;

    summarySection.classList.remove('sm:grid-cols-3', 'lg:grid-cols-3');
    summarySection.classList.add('sm:grid-cols-2', 'lg:grid-cols-4', 'w-full');
    cards.forEach((card) => {
      card.classList.add('h-full', 'min-w-0');
    });

    let downloadedCard = cards.find((card) => labelOf(card) === 'total downloaded') ||
      summarySection.querySelector('[data-sherlock-total-downloaded]');
    if (!downloadedCard) {
      downloadedCard = uploadedCard.cloneNode(true);
      downloadedCard.dataset.sherlockTotalDownloaded = 'true';
      const label = downloadedCard.querySelector('.eyebrow');
      const value = downloadedCard.querySelector('.num');
      if (label) label.textContent = 'Total downloaded';
      if (value) {
        value.textContent = '—';
        value.removeAttribute('title');
        delete value.dataset.sherlockNativeBytes;
        delete value.dataset.sherlockLastOutputTitle;
      }
      uploadedCard.after(downloadedCard);
    } else {
      downloadedCard.dataset.sherlockTotalDownloaded = 'true';
    }
    // The fourth card must share the exact same sizing rules as the original three.
    downloadedCard.classList.add('h-full', 'min-w-0');

    const bufferBasis = /at required ratio$/.test(labelOf(bufferCard)) ? 'required_ratio' : 'one_to_one';
    const nativeBuffer = readNativeMetricBytes(bufferCard);
    const nativeUploaded = readNativeMetricBytes(uploadedCard);
    if (nativeBuffer === null || nativeUploaded === null) return bufferBasis;

    const totals = calculateDashboardTotals(
      nativeBuffer,
      nativeUploaded,
      customTrackers,
      null,
      bufferBasis
    );
    if (!totals) return bufferBasis;

    writeDashboardMetric(bufferCard, totals.buffer);
    writeDashboardMetric(uploadedCard, totals.uploaded);
    return bufferBasis;
  }


  function localRatio(stats) {
    const ratio = stats && stats.ratio;
    if (ratio !== null && ratio !== undefined && Number.isFinite(Number(ratio)) && Number(ratio) >= 0) {
      return Number(ratio).toFixed(2);
    }
    const up = Number(stats.uploaded), down = Number(stats.downloaded);
    if (!Number.isFinite(up) || !Number.isFinite(down)) return '—';
    if (down === 0) return up > 0 ? '∞' : '—';
    return (up / down).toFixed(2);
  }

  function localDate(timestamp) {
    if (!timestamp) return '—';
    try { return new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (_) { return '—'; }
  }

  function signedBytes(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    const n = Number(value);
    return (n > 0 ? '+' : n < 0 ? '−' : '') + localBytes(Math.abs(n));
  }

  const nativeDownloadedCache = new Map();
  let nativeDownloadedCacheAt = 0;
  let nativeDownloadedFetchPromise = null;

  function removeNativeTrackerFooter(card, dl) {
    if (!card || !dl) return 0;
    let removed = 0;
    let footer = dl.nextElementSibling;
    while (footer) {
      const next = footer.nextElementSibling;
      const content = footer.textContent || '';
      const hasSparkline = !!(footer.querySelector && footer.querySelector('svg'));
      const hasFooterLabels = /buffer\s*,\s*7\s*days|tracking\s+since/i.test(content);
      if (hasSparkline || hasFooterLabels) {
        footer.remove();
        removed++;
      }
      footer = next;
    }
    return removed;
  }

  function centerTrackerMetrics(dl) {
    if (!dl) return;
    dl.classList.remove('grid-cols-4');
    dl.classList.add('grid-cols-3', 'w-full');

    Array.from(dl.children).forEach((field) => {
      field.classList.add('min-w-0', 'text-center');
      const label = field.querySelector('dt');
      if (label) label.classList.add('text-center');
      const valueCell = field.querySelector('dd');
      if (valueCell) valueCell.classList.add('text-center');
      const value = valueCell && valueCell.querySelector('.num');
      if (value) value.classList.add('block', 'text-center');
    });
  }

  function ensureNativeDownloadedField(card) {
    const dl = card && card.querySelector('dl');
    if (!dl) return null;
    removeNativeTrackerFooter(card, dl);
    // 24h is omitted from tracker cards to keep only three useful metrics.
    Array.from(dl.children).forEach((field) => {
      const label = field.querySelector('dt');
      if (label && /^24h$/i.test((label.textContent || '').trim())) field.remove();
    });
    centerTrackerMetrics(dl);

    let field = dl.querySelector('[data-sherlock-native-downloaded]');
    if (!field) {
      field = h('div', { 'data-sherlock-native-downloaded': 'true' },
        h('dt', { class: 'eyebrow' }, 'Downloaded'),
        h('dd', { class: 'mt-1' },
          h('span', { class: 'num', title: 'Exact Downloaded value not available yet.' }, '—')
        )
      );
      const ratioField = Array.from(dl.children).find((child) => {
        const label = child.querySelector('dt');
        return label && (label.textContent || '').trim().toLowerCase() === 'ratio';
      });
      if (ratioField) ratioField.after(field);
      else dl.appendChild(field);
    }
    centerTrackerMetrics(dl);
    return field.querySelector('.num');
  }

  function setMetricNodeBytes(valueNode, bytes) {
    if (!valueNode) return;
    if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes)) || Number(bytes) < 0) {
      valueNode.textContent = '—';
      valueNode.removeAttribute('title');
      return;
    }
    valueNode.textContent = localBytes(Number(bytes));
    valueNode.setAttribute('title', Math.round(Number(bytes)).toLocaleString() + ' bytes');
  }

  async function fetchNativeTrackerDownloaded(card) {
    try {
      const href = card && card.getAttribute('href');
      if (!href) return null;
      const target = new URL(href, location.origin);
      if (target.origin !== location.origin ||
          !target.pathname.startsWith('/trackers/') ||
          target.pathname.split('/').filter(Boolean).length !== 2) return null;

      const response = await fetch(target.href, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'follow',
        headers: { Accept: 'text/html' },
      });
      if (!response.ok) return null;
      const finalUrl = new URL(response.url || target.href, location.origin);
      if (finalUrl.origin !== location.origin ||
          finalUrl.pathname.toLowerCase().includes('login') ||
          finalUrl.pathname.toLowerCase().includes('signin')) return null;

      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      if (doc.querySelector('input[type="password"]')) return null;

      let stats = resolveStats(extractPairs(doc), false);
      if (stats.downloaded === undefined) {
        stats = Object.assign(stats, resolveStats(pairsFromText(plainText(doc)), false));
      }
      const downloaded = stats.downloaded;
      return Number.isFinite(downloaded) && downloaded >= 0 ? downloaded : null;
    } catch (e) {
      return null;
    }
  }

  async function readNativeTrackerDownloads(cards) {
    const list = Array.isArray(cards) ? cards : [];
    const keys = list.map((card) => card.getAttribute('href') || '');
    const cacheFresh = Date.now() - nativeDownloadedCacheAt < 5 * 60 * 1000;
    const allCached = keys.every((key) => key && nativeDownloadedCache.has(key));

    if (!cacheFresh || !allCached) {
      if (!nativeDownloadedFetchPromise) {
        nativeDownloadedFetchPromise = (async () => {
          const values = await Promise.all(list.map((card) => fetchNativeTrackerDownloaded(card)));
          keys.forEach((key, index) => {
            if (key) nativeDownloadedCache.set(key, values[index]);
          });
          nativeDownloadedCacheAt = Date.now();
        })().finally(() => {
          nativeDownloadedFetchPromise = null;
        });
      }
      await nativeDownloadedFetchPromise;
    }

    return list.map((card) => ({
      card,
      downloaded: nativeDownloadedCache.get(card.getAttribute('href') || '') ?? null,
    }));
  }

  async function refreshDownloadedMetrics(customTrackers) {
    const dashboardMain = document.querySelector('main') || document.querySelector('#main') || document.body;
    const nativeCards = Array.from(dashboardMain.querySelectorAll('a.card[href^="/trackers/"]'))
      .filter((card) => !card.hasAttribute('data-sherlock-custom-host'));
    nativeCards.forEach((card) => {
      card.classList.add('h-full', 'min-w-0');
      ensureNativeDownloadedField(card);
    });

    const rows = await readNativeTrackerDownloads(nativeCards);
    if (!document.body.contains(dashboardMain) ||
        (location.pathname !== '/dashboard' && location.pathname !== '/dashboard/')) return;

    rows.forEach(({ card, downloaded }) => {
      const value = ensureNativeDownloadedField(card);
      setMetricNodeBytes(value, downloaded);
    });

    const totalCard = dashboardMain.querySelector('[data-sherlock-total-downloaded]');
    const totalValue = totalCard && totalCard.querySelector('.num');
    const total = sumVerifiedDownloads(rows, customTrackers);
    setMetricNodeBytes(totalValue, total);
  }


  function renderLocalDashboard() {
    // Remove only custom content from an earlier render. Never remove native Sherlock tracker items.
    const previous = document.getElementById('sherlock-local-trackers');
    if (previous) previous.remove();
    document.querySelectorAll('[data-sherlock-custom-host]').forEach((el) => el.remove());
    document.querySelectorAll('[data-sherlock-custom-nav-host]').forEach((el) => el.remove());

    const trackers = Object.values(store.trackers)
      .filter((tracker) => tracker && tracker.host)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Expand the summary and native tracker cards to four metrics.
    const bufferBasis = updateDashboardTotals(trackers) || 'one_to_one';
    const dashboardMain = document.querySelector('main') || document.querySelector('#main') || document.body;
    // Keep Sherlock's original centered max-width dashboard area.
    // The summary row and tracker grid share this same centered width.
    dashboardMain.classList.remove('w-full', 'max-w-none');
    dashboardMain.classList.add('mx-auto', 'max-w-6xl');
    Array.from(dashboardMain.querySelectorAll('a.card[href^="/trackers/"]'))
      .filter((card) => !card.hasAttribute('data-sherlock-custom-host'))
      .forEach(ensureNativeDownloadedField);
    refreshDownloadedMetrics(trackers);
    if (!trackers.length) return;

    // 1) Add custom trackers to BOTH responsive sidebar navigation lists.
    // Match the native sidebar row: logo | tracker name | uploaded amount.
    document.querySelectorAll('nav[aria-label="Main"]').forEach((nav) => {
      const trackerHeading = Array.from(nav.querySelectorAll('p.eyebrow')).find((el) =>
        /^trackers$/i.test((el.textContent || '').trim())
      );
      if (!trackerHeading) return;

      const addTrackerLink = Array.from(nav.querySelectorAll('a[href="/trackers/add"]'))[0] || null;

      trackers.forEach((tracker) => {
        const stats = tracker.stats || {};
        const uploaded = stats.uploaded === null || stats.uploaded === undefined ? null : Number(stats.uploaded);
        const uploadedLabel = uploaded !== null && Number.isFinite(uploaded) ? localBytes(uploaded) : '—';

        const logo = tracker.logo
          ? h('img', {
              alt: '',
              class: 'size-5 shrink-0 rounded-md object-contain',
              src: tracker.logo,
            })
          : h('span', {
              class: 'size-5 shrink-0 rounded-md bg-sunken flex items-center justify-center text-[9px] font-semibold text-muted',
            }, (tracker.shortName || 'TRK').slice(0, 4));

        const item = h('a', {
          class: 'nav-link',
          href: tracker.origin || '#',
          target: '_blank',
          rel: 'noopener noreferrer',
          title: tracker.name || tracker.host,
          'data-sherlock-custom-nav-host': tracker.host,
        },
          logo,
          h('span', {
            class: 'flex-1 truncate',
          }, tracker.name || tracker.host),
          h('span', {
            class: 'text-xs text-muted',
          }, uploadedLabel)
        );

        if (addTrackerLink && addTrackerLink.parentNode === nav) {
          addTrackerLink.before(item);
        } else {
          trackerHeading.after(item);
        }
      });
    });

    // 2) Render dashboard cards with the SAME layout as Sherlock's native tracker cards.
    // Four metrics: Buffer, Ratio, Downloaded and 24h; Uploaded remains in the sidebar above.
    const section = h('section', {
      id: 'sherlock-local-trackers',
      class: 'mt-6 grid w-full items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-4',
      'aria-label': 'Custom trackers',
    });

    trackers.forEach((tracker) => {
      const stats = tracker.stats || {};
      const uploaded = stats.uploaded === null || stats.uploaded === undefined ? null : Number(stats.uploaded);
      const downloaded = stats.downloaded === null || stats.downloaded === undefined ? null : Number(stats.downloaded);
      const buffer = customTrackerBuffer(stats, bufferBasis);

      const logo = tracker.logo
        ? h('img', {
            alt: '',
            class: 'size-6 shrink-0 rounded-md object-contain',
            src: tracker.logo,
          })
        : h('span', {
            class: 'size-6 shrink-0 rounded-md bg-sunken flex items-center justify-center text-[9px] font-semibold text-muted',
          }, (tracker.shortName || 'TRK').slice(0, 4));

      const status = tracker.lastError
        ? h('span', { class: 'tag-down' }, 'Error')
        : h('span', { class: 'tag-up' }, 'OK');

      const card = h('a', {
        class: 'card flex h-full min-w-0 flex-col p-4 hover:border-line-strong',
        href: tracker.origin || '#',
        target: '_blank',
        rel: 'noopener noreferrer',
        'data-sherlock-custom-host': tracker.host,
      },
        h('div', { class: 'flex items-center gap-2 min-w-0' },
          logo,
          h('span', {
            class: 'flex-1 min-w-0 truncate font-medium',
            title: tracker.name || tracker.host,
          }, tracker.name || tracker.host),
          status
        ),
        h('dl', { class: 'mt-4 grid grid-cols-3 gap-3 text-sm' },
          h('div', {},
            h('dt', { class: 'eyebrow' }, 'Buffer'),
            h('dd', { class: 'mt-1' },
              h('span', {
                class: 'num',
                title: buffer === null ? '' : Math.round(buffer).toLocaleString() + ' bytes',
              }, localBytes(buffer))
            )
          ),
          h('div', {},
            h('dt', { class: 'eyebrow' }, 'Ratio'),
            h('dd', { class: 'mt-1' },
              h('span', { class: 'num' }, localRatio(stats))
            )
          ),
          h('div', {},
            h('dt', { class: 'eyebrow' }, 'Downloaded'),
            h('dd', { class: 'mt-1' },
              h('span', { class: 'num' }, localBytes(downloaded))
            )
          )
        )
      );
      centerTrackerMetrics(card.querySelector('dl'));

      section.appendChild(card);
    });

    const main = document.querySelector('main') || document.querySelector('#main') || document.body;
    const nativeGrid = Array.from(main.querySelectorAll('section')).find((el) =>
      el !== section &&
      el.classList.contains('grid') &&
      el.querySelector('a[href^="/trackers/"] .card, a.card[href^="/trackers/"]')
    );
    const nativeTrackerCards = Array.from(main.querySelectorAll('a.card[href^="/trackers/"]'));
    const nativeSection = nativeGrid || (nativeTrackerCards[0] && nativeTrackerCards[0].parentElement);

    if (nativeSection && nativeSection.classList.contains('grid')) {
      // Keep the native tracker grid aligned with the four-card summary row.
      nativeSection.classList.remove('lg:grid-cols-3');
      nativeSection.classList.add('sm:grid-cols-2', 'lg:grid-cols-4', 'w-full', 'items-stretch');
      nativeTrackerCards.forEach((card) => card.classList.add('h-full', 'min-w-0'));
      // Mix custom cards into the same native grid so they look exactly like built-in trackers.
      nativeSection.append(...Array.from(section.children));
      section.remove();
    } else {
      const dashboardHeading = Array.from(main.querySelectorAll('h1')).find((el) =>
        /dashboard/i.test(el.textContent || '')
      );
      const headingRow = dashboardHeading && dashboardHeading.parentElement && dashboardHeading.parentElement.parentElement;
      if (headingRow && headingRow.parentNode) headingRow.insertAdjacentElement('afterend', section);
      else main.appendChild(section);
    }
  }

  /* ======================================================================
   * Page detection and userscript menu
   * ==================================================================== */

  // Offer the add action only on pages that look like a tracker. The toast
  // API uses an actions array (not a singular action property).
  function offerToAdd() {
    const name = guessName(document.title, HOST);
    toast('This tracker is not in your custom list yet.', {
      title: 'Add ' + name + ' to Sherlock?',
      ttl: 12000,
      actions: [{ label: 'Add tracker', onClick: () => openTrackerPanel(null), primary: true }],
    });
  }

  function looksLikeTracker() {
    if (isTorrentLeechDocument(document)) {
      if (document.querySelector('input[type="password"]')) return false;
      const versionKey = 'sherlock.torrentleech.autodetect.version.' + PAGE_HOST;
      if (GM_getValue(versionKey, '') !== VERSION) {
        GM_setValue(versionKey, VERSION);
        GM_setValue('sherlock.autoadd.attempt.' + PAGE_HOST, 0);
      }
      return true;
    }
    if (isTranceTrafficDocument(document)) {
      if (document.querySelector('input[type="password"]')) return false;
      const versionKey = 'sherlock.trancetraffic.autodetect.version.' + PAGE_HOST;
      if (GM_getValue(versionKey, '') !== VERSION) { GM_setValue(versionKey, VERSION); GM_setValue('sherlock.autoadd.attempt.' + PAGE_HOST, 0); }
      return true;
    }
    if (isMyAnonamouseDocument(document)) {
      if (document.querySelector('input[type="password"]')) return false;
      const versionKey = 'sherlock.myanonamouse.autodetect.version.' + PAGE_HOST;
      if (GM_getValue(versionKey, '') !== VERSION) {
        GM_setValue(versionKey, VERSION);
        GM_setValue('sherlock.autoadd.attempt.' + PAGE_HOST, 0);
      }
      return true;
    }
    if (isFileListDocument(document)) {
      if (document.querySelector('input[type="password"]')) return false;
      const versionKey = 'sherlock.filelist.autodetect.version.' + PAGE_HOST;
      if (GM_getValue(versionKey, '') !== VERSION) {
        GM_setValue(versionKey, VERSION);
        GM_setValue('sherlock.autoadd.attempt.' + PAGE_HOST, 0);
      }
      return true;
    }
    if (isCinemageddonDocument(document)) {
      if (document.querySelector('input[type="password"]')) return false;
      // Reset a stale failed auto-detection cooldown once when this parser version is installed.
      const versionKey = 'sherlock.cinemageddon.autodetect.version.' + PAGE_HOST;
      if (GM_getValue(versionKey, '') !== VERSION) {
        GM_setValue(versionKey, VERSION);
        GM_setValue('sherlock.autoadd.attempt.' + PAGE_HOST, 0);
      }
      return true;
    }
    const detectedApiType = trackerApiType({ host: HOST, origin: location.origin });
    if (detectedApiType) {
      // Upgrade migration clears stale cooldowns for API-based adapters, including DigitalCore.
      const versionKey = 'sherlock.autodetect.version.' + PAGE_HOST;
      if (GM_getValue(versionKey, '') !== VERSION) {
        GM_setValue(versionKey, VERSION);
        GM_setValue('sherlock.autoadd.attempt.' + PAGE_HOST, 0);
      }
      return !document.querySelector('input[type="password"]');
    }
    if (document.querySelector('.ratio-bar, #userinfo_stats')) return true;
    const head = ((document.body && document.body.innerText) || '').slice(0, 6000);
    return /\b(upload(ed)?|up)\b\s*[:：]?\s*\d[\d.,]*\s*[KMGTP]i?B/i.test(head) && /\b(download(ed)?|down)\b\s*[:：]?\s*\d[\d.,]*\s*[KMGTP]i?B/i.test(head);
  }

  let menusRegistered = false;
  function registerMenus() {
    if (menusRegistered) return;
    menusRegistered = true;
    GM_registerMenuCommand('Sherlock: Add this tracker', () => {
      if (/\/dashboard\/?$/.test(location.pathname)) return toast('Open the tracker website first, then choose Add this tracker.', { kind: 'err' });
      openTrackerPanel();
    });
    GM_registerMenuCommand('Sherlock: Sync current tracker now', () => {
      const t = store.trackers[HOST];
      if (t) syncTracker(t, { manual: true });
      else toast('This tracker has not been added yet.', { kind: 'err' });
    });
    GM_registerMenuCommand('Sherlock: Edit current tracker', () => {
      const t = store.trackers[HOST];
      if (t) openTrackerPanel(t);
      else toast('This tracker has not been added yet.', { kind: 'err' });
    });
    GM_registerMenuCommand('Sherlock: Remove current tracker', () => {
      const all = store.trackers;
      const t = all[HOST];
      if (!t) return toast('This tracker has not been added yet.', { kind: 'err' });
      if (!window.confirm('Remove ' + (t.name || t.host) + ' from this browser’s custom trackers?')) return;
      delete all[HOST]; store.trackers = all;
      // Permit immediate re-detection after explicit removal.
      GM_setValue('sherlock.autoadd.attempt.' + PAGE_HOST, 0);
      GM_setValue('sherlock.autoadd.lock.' + PAGE_HOST, 0);
      if (/\/dashboard\/?$/.test(location.pathname)) renderLocalDashboard();
      toast((t.name || t.host) + ' removed from this browser.', { kind: 'ok' });
    });
    GM_registerMenuCommand('Sherlock: Settings', openSettings);
  }

  async function autoAddTracker() {
    const attemptHost = PAGE_HOST;
    const cooldownKey = 'sherlock.autoadd.attempt.' + attemptHost;
    const lockKey = 'sherlock.autoadd.lock.' + attemptHost;
    const now = Date.now();
    if (now - Number(GM_getValue(cooldownKey, 0)) < 30 * 60 * 1000) return;
    if (now - Number(GM_getValue(lockKey, 0)) < 60000) return;
    GM_setValue(cooldownKey, now);
    GM_setValue(lockKey, now);

    const tracker = {
      host: HOST,
      origin: location.origin,
      name: trackerNameForNewTracker(document.title, HOST, location.origin, document),
      shortName: '',
      kind: 'auto',
      profileUrl: null,
      username: '',
      userId: '',
      si: false,
      logo: null,
      lastSync: 0,
      lastAttempt: now,
      lastSeenAt: now,
      stats: {},
      enabled: true,
      history: [],
      autoAdded: true,
    };

    try {
      const data = await readTracker(tracker);
      if (!data || !data.stats ||
          !Number.isFinite(Number(data.stats.uploaded)) || Number(data.stats.uploaded) < 0 ||
          !Number.isFinite(Number(data.stats.downloaded)) || Number(data.stats.downloaded) < 0) {
        throw new ReadError('Uploaded and downloaded could not both be verified.');
      }
      tracker.kind = data.kind || 'profile';
      tracker.profileUrl = data.profileUrl || null;
      tracker.userId = data.userId || '';
      tracker.username = data.username || data.userId || '';
      tracker.logo = await detectLogo();
      tracker.shortName = shortNameOf(tracker.name);
      await push(tracker, { stats: data.stats });
      saveTracker(tracker);
      toast(tracker.name + ' was detected and added automatically.', {
        kind: 'ok', ttl: 10000,
        actions: store.url ? [{ label: 'Open Sherlock dashboard', href: store.url + '/dashboard' }] : [],
      });
    } catch (e) {
      // Failed reads can retry after five minutes instead of locking out auto-detection for 30 minutes.
      GM_setValue(cooldownKey, Date.now() - 25 * 60000);
      const message = e && e.message ? e.message : 'The tracker stats could not be read.';
      toast('Automatic detection could not add this tracker: ' + message, {
        kind: 'err', title: 'Sherlock auto-detection',
        ttl: 14000,
        actions: [{ label: 'Add tracker manually', onClick: () => openTrackerPanel(null), primary: true }],
      });
    } finally {
      GM_setValue(lockKey, 0);
    }
  }

  let dashboardSyncTimer = null;
  let dashboardSyncRunning = false;

  async function dashboardAutoSync() {
    if (dashboardSyncRunning || !/\/dashboard\/?$/.test(location.pathname)) return;
    dashboardSyncRunning = true;
    try {
      const due = Object.values(store.trackers)
        .filter((tracker) => tracker && tracker.host && tracker.enabled !== false)
        .filter((tracker) => Date.now() - Number(tracker.lastSync || 0) >= store.interval * 60000 &&
          Date.now() - Number(tracker.lastAttempt || 0) >= 10 * 60000)
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      for (const tracker of due) {
        // Re-read storage before each request in case the user removed/edited a tracker.
        const current = store.trackers[tracker.host];
        if (!current || current.enabled === false) continue;
        await syncTracker(current, { remote: true });
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
      renderLocalDashboard();
    } finally {
      dashboardSyncRunning = false;
    }
  }

  function startDashboardAutoSync() {
    if (dashboardSyncTimer) return;
    dashboardAutoSync();
    dashboardSyncTimer = window.setInterval(() => {
      if (!/\/dashboard\/?$/.test(location.pathname)) {
        window.clearInterval(dashboardSyncTimer);
        dashboardSyncTimer = null;
        return;
      }
      dashboardAutoSync();
    }, 60000);
  }

  function main() {
    registerMenus();
    const isDashboard = /\/dashboard\/?$/.test(location.pathname);
    if (isDashboard) {
      // The dashboard's own origin is the destination; no API calls are made to it.
      // Keep links pinned to the canonical public dashboard, not the VPS origin alias.
      store.url = DEFAULT_URL;
      renderLocalDashboard();
      startDashboardAutoSync();
      return;
    }

    const tracker = store.trackers[HOST];
    if (tracker) {
      // Remember the latest working mirror so dashboard remote sync uses it.
      if (trackerApiType({ host: HOST, origin: location.origin }) === 'iptorrents') {
        tracker.host = 'iptorrents.com';
        tracker.origin = location.origin;
        tracker.lastSeenAt = Date.now();
        saveTracker(tracker);
      }
      const due = Date.now() - (tracker.lastSync || 0) > store.interval * 60000 && Date.now() - (tracker.lastAttempt || 0) > 10 * 60000;
      if (tracker.enabled !== false && due) syncTracker(tracker, {});
      return;
    }
    if (store.dismissed[HOST] || sessionSkipped.has(HOST)) return;
    if (looksLikeTracker()) autoAddTracker();
  }

  main();
  // Sherlock uses Turbo navigation; redraw the local section when navigating without a full reload.
  document.addEventListener('turbo:load', main);
  document.addEventListener('turbo:render', main);
  window.addEventListener('pageshow', main);

})();
