// ==UserScript==
// @name         Sherlock Tracker Sync
// @namespace    __SHERLOCK_URL__
// @version      1.4.6
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
    if (/^(∞|inf(inity|\.)?|--+|—|-)$/i.test(s)) return { infinite: true, value: null };
    const m = s.match(/\d[\d.,]*/);
    const n = m ? parseLocaleNumber(m[0]) : null;
    return n === null ? null : { infinite: false, value: n };
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
    ratio: [/^(ratio|share ratio|sharing ratio|share-ratio|分享率)$/],
    required_ratio: [/^(required|required ratio|min(imum)? ratio|minimum required ratio|min\.? ratio)$/],
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
  const BYTE_KEYS = ['uploaded', 'downloaded'];
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
    if (key === 'ratio' || key === 'required_ratio') {
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
    const re = /([A-Za-z][A-Za-z &'.\-]{1,28}?)(?:[ \t]*[:：][ \t]*|[ \t]+)((?:∞|\d[\d.,'’]*(?:[ \t]?[KMGTP]i?B)?))(?=\s|$)/g;
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
  function guessName(title, host) {
    const fallback = host.replace(/^www\./, '').split('.')[0].replace(/^./, (c) => c.toUpperCase());
    const parts = String(title || '').split(/\s+[|\-–—:·»«]+\s+|\s*::\s*/).map((s) => s.trim()).filter(Boolean);
    const generic = /^(home|index|login|log in|sign in|welcome|torrents?|profile|account|user|forums?|dashboard|main)$/i;
    const hostWord = host.replace(/^www\./, '').split('.')[0].toLowerCase();
    const named = parts.find((p) => p.toLowerCase().replace(/[^a-z0-9]/g, '').includes(hostWord.replace(/[^a-z0-9]/g, '')));
    const pick = named || parts.filter((p) => !generic.test(p)).pop() || fallback;
    return pick.length > 40 ? fallback : pick;
  }

  function shortNameOf(name) {
    const caps = (name.match(/[A-Z0-9]/g) || []).slice(0, 4).join('');
    return (caps.length >= 2 ? caps : name.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'TRK').slice(0, 8);
  }

  // Combine Sherlock's native dashboard totals with browser-local custom tracker totals.
  // A custom tracker is included only when both uploaded and downloaded are available.
  // Sum native tracker buffer/ratio rows when the dashboard summary is internally inconsistent.
  // Buffer = uploaded - downloaded; ratio = uploaded / downloaded.
  function calculateNativeTrackerTotals(rows) {
    if (!Array.isArray(rows) || !rows.length) return null;
    let uploaded = 0;
    let downloaded = 0;
    let buffer = 0;

    for (const row of rows) {
      if (!row || !Number.isFinite(Number(row.buffer)) || !row.ratio) return null;
      const currentBuffer = Number(row.buffer);
      const ratio = row.ratio;
      let currentUploaded;
      let currentDownloaded;

      if (ratio.infinite) {
        currentUploaded = currentBuffer;
        currentDownloaded = 0;
      } else {
        const value = Number(ratio.value);
        if (!Number.isFinite(value) || value < 0) return null;
        if (value === 0) {
          currentUploaded = 0;
          currentDownloaded = -currentBuffer;
        } else if (Math.abs(value - 1) < 1e-9) {
          // With ratio 1.00 and zero buffer, the two totals cannot be recovered from the card.
          if (Math.abs(currentBuffer) < 1) return null;
          return null;
        } else {
          currentDownloaded = currentBuffer / (value - 1);
          currentUploaded = currentDownloaded * value;
        }
      }

      if (!Number.isFinite(currentUploaded) || !Number.isFinite(currentDownloaded) ||
          currentUploaded < 0 || currentDownloaded < 0) return null;

      uploaded += currentUploaded;
      downloaded += currentDownloaded;
      buffer += currentBuffer;
    }

    return { uploaded, downloaded, buffer };
  }

  // Match Sherlock's Snapshot.buffer() calculation for browser-local custom trackers.
  // "required_ratio" uses floor(uploaded / required_ratio) - downloaded; a missing
  // or non-positive required ratio falls back to the standard 1.0 basis.
  function customTrackerBuffer(stats, bufferBasis) {
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

    // With the normal 1.0 basis, native downloaded = uploaded - buffer.
    // In required-ratio mode the native buffer is adjusted per tracker, so that
    // subtraction cannot recover raw downloaded bytes from the aggregate totals.
    if (downloaded === null && bufferBasis !== 'required_ratio') {
      downloaded = baseUploaded - baseBuffer;
      if (!Number.isFinite(downloaded) || downloaded < 0) downloaded = null;
    }

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
  function isCinemageddonHost(value) {
    const host = String(value || '').trim().toLowerCase()
      .replace(/^https?:\/\//, '').split(/[/:?#]/, 1)[0]
      .replace(/^www\./, '').replace(/\.$/, '');
    return host === 'cinemageddon.net' || host.endsWith('.cinemageddon.net');
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

  // Not in a browser (or no userscript manager): hand the helpers to a test runner and stop.
  if (typeof window === 'undefined' || typeof GM_getValue === 'undefined') {
    if (typeof module !== 'undefined') {
      module.exports = { parseLocaleNumber, parseBytes, parseCount, parseRatio, normLabel, resolveStats, pairsFromText, sizeLabel, guessName, shortNameOf, customTrackerBuffer, calculateDashboardTotals, calculateNativeTrackerTotals, apiByteNumber, mapRartrackerStatus, mapDigitalCoreStatus, mapIptStatValues, mapIptProfileDetails, isIptorrentsHost, normalizeIptorrentsTrackerStore, isCinemageddonHost, mapCinemageddonProfileRows };
    }
    return;
  }

  /* ======================================================================
   * Settings, kept in the userscript manager
   * ==================================================================== */

  const VERSION = '1.4.6';
  const DEFAULT_URL = '';
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
    get url() { return String(GM_getValue('sherlock.url', DEFAULT_URL) || DEFAULT_URL).replace(/\/+$/, ''); },
    set url(v) { GM_setValue('sherlock.url', String(v).trim().replace(/\/+$/, '')); },
    get interval() { return Math.max(15, Number(GM_getValue('sherlock.interval', 60)) || 60); },
    set interval(v) { GM_setValue('sherlock.interval', Math.max(15, Number(v) || 60)); },
    get trackers() {
      let all;
      try { all = JSON.parse(GM_getValue('sherlock.trackers', '{}')) || {}; }
      catch (e) { all = {}; }
      const result = normalizeIptorrentsTrackerStore(all);
      if (result.changed) GM_setValue('sherlock.trackers', JSON.stringify(result.trackers));
      return result.trackers;
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
    const keys = { uploaded: 'uploaded', downloaded: 'downloaded', ratio: 'ratio', points: 'bonus_points', bonus: 'bonus_points', seeding: 'seeding', leeching: 'leeching', buffer: null };
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
    if (isCinemageddonHost(hostname)) return 'cinemageddon';
    return null;
  }

  async function readTracker(tracker, context) {
    context = context || {};
    const origin = context.origin || location.origin;
    const request = context.request || fetchText;
    const apiType = trackerApiType(tracker);
    if (apiType === 'digitalcore') return readDigitalCore(tracker, request);
    if (apiType === 'rartracker') return readRartracker(tracker, request);
    if (apiType === 'iptorrents') return readIptorrents(tracker, context);
    if (apiType === 'cinemageddon') return readCinemageddon(tracker, context);

    const si = !!tracker.si;
    const sourceDocument = Object.prototype.hasOwnProperty.call(context, 'document') ? context.document : document;
    const pageUrl = context.pageUrl || location.href;
    const kinds = tracker.kind === 'gazelle' || tracker.kind === 'profile' ? [tracker.kind] : ['gazelle', 'profile'];
    let lastError;
    for (const kind of kinds) {
      try {
        if (kind === 'gazelle') return await readGazelle(request);
        const link = await discoverProfile(tracker, request, origin, sourceDocument, pageUrl);
        return await readProfile(link.url, link.text, si, request, origin);
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
    ['ratio', 'Ratio', 'number'], ['bonus_points', 'Bonus points', 'number'],
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
      host: HOST, origin: location.origin, name: trackerApiType({ host: HOST, origin: location.origin }) === 'cinemageddon' ? 'Cinemageddon' : guessName(document.title, HOST), shortName: '', enabled: true, kind: 'auto',
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
    if (!existing) {
      detectLogoAgain();
      await reread();
    }
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
    const nextBuffer = Number.isFinite(Number(nextStats.uploaded)) && Number.isFinite(Number(nextStats.downloaded))
      ? Number(nextStats.uploaded) - Number(nextStats.downloaded) : null;
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
      const url = h('input', { type: 'url', value: store.url, placeholder: 'https://your-sherlock-site.example' });
      const interval = h('input', { type: 'number', min: 15, step: 5, value: store.interval });
      const status = h('div', { class: 'note' }, 'No Sherlock API or token is used. Saved trackers auto-update while this dashboard tab is open; the browser must stay open.');
      return h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Sherlock local tracker settings' },
        h('header', {}, h('h2', {}, 'Sherlock settings'), h('button', { class: 'btn', style: 'margin-left:auto', onclick: close }, '×')),
        h('div', { class: 'body' }, status,
          h('label', {}, 'Sherlock dashboard address (optional)', url),
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

  function readNativeTrackerRows(main) {
    const cards = Array.from(main.querySelectorAll('a.card[href^="/trackers/"]'));
    if (!cards.length) return null;

    const rows = [];
    for (const card of cards) {
      const metric = (name) => {
        const dt = Array.from(card.querySelectorAll('dt')).find((node) =>
          (node.textContent || '').trim().toLowerCase() === name
        );
        if (!dt) return null;
        const dd = dt.parentElement && dt.parentElement.querySelector('dd');
        return dd && dd.querySelector('.num');
      };

      const bufferNode = metric('buffer');
      const ratioNode = metric('ratio');
      const buffer = readMetricNodeBytes(bufferNode);
      const ratio = ratioNode ? parseRatio(ratioNode.textContent) : null;
      if (buffer === null || !ratio) return null;
      rows.push({ buffer, ratio });
    }

    return calculateNativeTrackerTotals(rows);
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
        labels.includes('total uploaded') &&
        (labels.includes('buffer, last 24 hours') || labels.includes('total downloaded'));
    });
    if (!summarySection) return;

    const cards = Array.from(summarySection.children).filter((child) => child.classList.contains('card'));
    const labelOf = (card) => {
      const label = card && card.querySelector('.eyebrow');
      return (label && label.textContent || '').trim().toLowerCase();
    };
    const findCard = (labelText) => cards.find((card) => labelOf(card) === labelText);

    const bufferCard = cards.find((card) => bufferLabelPattern.test(labelOf(card)));
    const uploadedCard = findCard('total uploaded');
    const downloadedCard = findCard('total downloaded') || findCard('buffer, last 24 hours');
    if (!bufferCard || !uploadedCard || !downloadedCard) return;

    const bufferBasis = /at required ratio$/.test(labelOf(bufferCard)) ? 'required_ratio' : 'one_to_one';
    const nativeBuffer = readNativeMetricBytes(bufferCard);
    const nativeUploaded = readNativeMetricBytes(uploadedCard);
    if (nativeBuffer === null || nativeUploaded === null) return;

    // Raw native downloaded totals can be derived from the summary only with the 1.0 basis.
    // In required-ratio mode, the native Buffer is adjusted per tracker; don't infer downloads
    // from Uploaded - Buffer or from the displayed (rounded) share ratios.
    let nativeDownloaded = bufferBasis === 'required_ratio' ? null : nativeUploaded - nativeBuffer;
    if (nativeDownloaded !== null && nativeDownloaded < 0) {
      const recovered = readNativeTrackerRows(main);
      nativeDownloaded = recovered ? recovered.downloaded : null;
    }

    const totals = calculateDashboardTotals(
      nativeBuffer,
      nativeUploaded,
      customTrackers,
      nativeDownloaded,
      bufferBasis
    );
    if (!totals) return;

    // These two totals stay anchored to Sherlock's own exact native snapshot sums.
    writeDashboardMetric(bufferCard, totals.buffer);
    writeDashboardMetric(uploadedCard, totals.uploaded);

    const downloadedLabel = downloadedCard.querySelector('.eyebrow');
    if (downloadedLabel) downloadedLabel.textContent = 'Total Downloaded';
    if (totals.downloaded === null) {
      const value = downloadedCard.querySelector('.num');
      if (value) {
        value.textContent = '—';
        value.removeAttribute('title');
      }
    } else {
      writeDashboardMetric(downloadedCard, totals.downloaded);
    }

    // Match Total Uploaded's exact text sizing and colour.
    // The old 24-hour value had "text-muted", which should not apply to Total Downloaded.
    const downloadedValue = downloadedCard.querySelector('.num');
    const totalValueStyle = uploadedCard.querySelector('.num');
    if (downloadedValue && totalValueStyle) {
      downloadedValue.className = totalValueStyle.className;
    }
  }


  function localRatio(stats) {
    if (stats.ratio !== null && stats.ratio !== undefined && Number.isFinite(Number(stats.ratio))) return Number(stats.ratio).toFixed(2);
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

  function bufferHistory(t) {
    const points = Array.isArray(t.history) ? t.history.filter((p) => Number.isFinite(Number(p.buffer))) : [];
    if (points.length) return points.slice(-48).map((p) => Number(p.buffer));
    const stats = t.stats || {};
    const up = Number(stats.uploaded), down = Number(stats.downloaded);
    const current = Number.isFinite(up) && Number.isFinite(down) ? up - down : 0;
    return [current, current, current, current, current, current, current, current];
  }

  function sparkline(values) {
    const width = 100, height = 32, pad = 2;
    const nums = values.filter(Number.isFinite);
    if (!nums.length) return '';
    const min = Math.min(...nums), max = Math.max(...nums), span = max - min || 1;
    const coords = nums.map((v, i) => [nums.length === 1 ? width : (i / (nums.length - 1)) * width,
      height - pad - ((v - min) / span) * (height - pad * 2)]);
    const line = coords.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(2) + ',' + p[1].toFixed(2)).join(' ');
    const area = line + ' L' + width + ',' + height + ' L0,' + height + ' Z';
    return h('svg', { viewBox: '0 0 100 32', preserveAspectRatio: 'none', class: 'h-9 w-full text-accent', 'aria-hidden': 'true' },
      h('path', { d: area, fill: 'currentColor', 'fill-opacity': '0.12' }),
      h('path', { d: line, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'vector-effect': 'non-scaling-stroke' }));
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

    // Update the three existing summary cards without changing their markup or styling.
    updateDashboardTotals(trackers);
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
    // The only card metrics remain Buffer, Ratio and 24h; Uploaded is shown in the sidebar above.
    const section = h('section', {
      id: 'sherlock-local-trackers',
      class: 'mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3',
      'aria-label': 'Custom trackers',
    });

    trackers.forEach((tracker) => {
      const stats = tracker.stats || {};
      const uploaded = stats.uploaded === null || stats.uploaded === undefined ? null : Number(stats.uploaded);
      const downloaded = stats.downloaded === null || stats.downloaded === undefined ? null : Number(stats.downloaded);
      const validTotals = uploaded !== null && downloaded !== null &&
        Number.isFinite(uploaded) && Number.isFinite(downloaded);
      const buffer = validTotals ? uploaded - downloaded : null;
      const history = Array.isArray(tracker.history) ? tracker.history : [];
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const old = history
        .filter((point) => Number(point.at) <= dayAgo && Number.isFinite(Number(point.buffer)))
        .slice(-1)[0];
      const delta24 = old && buffer !== null ? buffer - Number(old.buffer) : null;

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
        class: 'card flex flex-col p-4 hover:border-line-strong',
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
        h('dl', { class: 'mt-4 grid grid-cols-3 gap-2 text-sm' },
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
        ),
        h('div', { class: 'mt-auto pt-4' },
          sparkline(bufferHistory(tracker)),
          h('p', { class: 'hint mt-1 flex justify-between gap-2 text-xs' },
            h('span', {}, 'Buffer, 7 days'),
            h('span', {}, 'Tracking since ' + localDate(tracker.createdAt || tracker.lastSync))
          )
        )
      );

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
    if (trackerApiType({ host: HOST, origin: location.origin })) {
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
      name: trackerApiType({ host: HOST, origin: location.origin }) === 'cinemageddon' ? 'Cinemageddon' : guessName(document.title, HOST),
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
      store.url = location.origin;
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
