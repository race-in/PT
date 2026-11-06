// ==UserScript==
// @name         Sherlock Tracker Sync
// @namespace    __SHERLOCK_URL__
// @version      1.9.8
// @updateURL    https://raw.githubusercontent.com/race-in/PT/main/sherlock-test-main.meta.js
// @downloadURL  https://raw.githubusercontent.com/race-in/PT/main/sherlock%20test%20main.js
// @description  Automatically discovers unsupported trackers and refreshes their dashboard statistics in this browser.
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


  // Canonical tracker identities extracted from the supplied Private Tracker List.
  // Keep full names for matching/API payloads; use short codes for every visible tracker label.
  const TRACKER_DIRECTORY = Object.freeze([
  {
    "name": "3ChangTrai",
    "short": "3CT",
    "source": "official",
    "software": "NexusPHP"
  },
  {
    "name": "Abnormal",
    "short": "ABN",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "ABTorrents",
    "short": "ABT",
    "source": "official",
    "software": "U-232"
  },
  {
    "name": "Aidoru!Online",
    "short": "AO",
    "source": "generated",
    "software": "Custom"
  },
  {
    "name": "Aither",
    "short": "ATH",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "AlphaRatio",
    "short": "AR",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "Anime Datenbank Tracker",
    "short": "ADBT",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "AnimeBytes",
    "short": "AB",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "AnimeTorrents",
    "short": "AnT",
    "source": "official",
    "software": "XBTIT"
  },
  {
    "name": "AnimeWorld",
    "short": "AW",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "Anthelion",
    "short": "ANT",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "AsianCinema",
    "short": "ACM",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "AstraTorrent",
    "short": "AT",
    "source": "generated",
    "software": "Custom"
  },
  {
    "name": "Audionews",
    "short": "AN",
    "source": "official",
    "software": "TorrentPier"
  },
  {
    "name": "AvistaZ",
    "short": "AZ",
    "source": "official",
    "software": "Custom"
  },
  {
    "name": "BakaBT",
    "short": "BBT",
    "source": "official",
    "software": null
  },
  {
    "name": "Bemaniso",
    "short": "SOWS",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "BeyondHD",
    "short": "BHD",
    "source": "official",
    "software": "F3NIX"
  },
  {
    "name": "Bibliotik",
    "short": "BiB",
    "source": "official",
    "software": "Custom"
  },
  {
    "name": "BitBr",
    "short": "BTBR",
    "source": "official",
    "software": "chinese"
  },
  {
    "name": "BitPorn",
    "short": "BP",
    "source": "generated",
    "software": "UNIT3D"
  },
  {
    "name": "BitTorrentFiles",
    "short": "BTF",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "Blutopia",
    "short": "BLU",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "Borgzelle",
    "short": "Borg",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "BrSociety",
    "short": "BRS",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "BrasilTracker",
    "short": "BT",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "BroadcasTheNet",
    "short": "BTN",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "BrokenStones",
    "short": "BRKs",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "BTSCHOOL",
    "short": "BTS",
    "source": "official",
    "software": "NexusPHP"
  },
  {
    "name": "BwTorrents",
    "short": "BwT",
    "source": "official",
    "software": null
  },
  {
    "name": "C411",
    "short": "C411",
    "source": "generated",
    "software": "Custom"
  },
  {
    "name": "Canal Street",
    "short": "CAST",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "CapybaraBR",
    "short": "CBR",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "CarPT",
    "short": "CP",
    "source": "generated",
    "software": "NexusPHP"
  },
  {
    "name": "Cathode-Ray.Tube",
    "short": "CRT",
    "source": "official",
    "software": "Luminance"
  },
  {
    "name": "CGPeers",
    "short": "CGP",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "Cinematik",
    "short": "TiK",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "CinemaZ",
    "short": "CZ",
    "source": "official",
    "software": "Custom"
  },
  {
    "name": "ClearJAV (API)",
    "short": "CJ",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "Coastal Music Crew",
    "short": "CMC",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "Concertos",
    "short": "CONC",
    "source": "generated",
    "software": "UNIT3D"
  },
  {
    "name": "CynicalGen",
    "short": "CG",
    "source": "official",
    "software": "XBTIT"
  },
  {
    "name": "DanishBytes",
    "short": "DBy",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "Dark-Shadow",
    "short": "DS",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "DasUnerwartete",
    "short": "DU",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "DarkPeers",
    "short": "DP",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "DeepBassNine",
    "short": "DB9",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "DesiTorrents",
    "short": "DT",
    "source": "generated",
    "software": null
  },
  {
    "name": "DICMusic",
    "short": "DIC",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "DigitalCore",
    "short": "DC",
    "source": "official",
    "software": null
  },
  {
    "name": "DocsPedia.world",
    "short": "DPW",
    "source": "generated",
    "software": null
  },
  {
    "name": "Empornium",
    "short": "EMP",
    "source": "official",
    "software": "Luminance"
  },
  {
    "name": "eShareNet",
    "short": "ESN",
    "source": "generated",
    "software": "UNIT3D"
  },
  {
    "name": "ExoticaZ",
    "short": "EZ",
    "source": "official",
    "software": "Custom"
  },
  {
    "name": "ExtremeBits",
    "short": "XB",
    "source": "official",
    "software": "TBDev"
  },
  {
    "name": "F1Carreras",
    "short": "F1C",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "F1GP",
    "short": "F1GP",
    "source": "official",
    "software": null
  },
  {
    "name": "Fappaizuri",
    "short": "FAPP",
    "source": "generated",
    "software": null
  },
  {
    "name": "FearNoPeer",
    "short": "FNP",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "Femdomcult",
    "short": "FDC",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "FileList",
    "short": "FL",
    "source": "official",
    "software": "Ocelot"
  },
  {
    "name": "GazelleGames",
    "short": "GGn",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "Gemini Tracker",
    "short": "G3MINI",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "Generation Free",
    "short": "GF",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "GreatPosterWall",
    "short": "GPW",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "GGPT",
    "short": "GGPT",
    "source": "generated",
    "software": "NexusPHP"
  },
  {
    "name": "HappyFappy",
    "short": "HF",
    "source": "official",
    "software": "Luminance"
  },
  {
    "name": "Hawke-UNO",
    "short": "HUNO",
    "source": "official",
    "software": "Custom UNIT3D Fork"
  },
  {
    "name": "HD-Forever",
    "short": "HDF",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "HD-Space",
    "short": "HDS",
    "source": "official",
    "software": "XBTIT"
  },
  {
    "name": "HD-Torrents",
    "short": "HDT",
    "source": "official",
    "software": "XBTIT"
  },
  {
    "name": "HDArea",
    "short": "HDA",
    "source": "official",
    "software": "NexusPHP"
  },
  {
    "name": "HDBits",
    "short": "HDB",
    "source": "official",
    "software": "XBTIT"
  },
  {
    "name": "HDChina",
    "short": "HDC",
    "source": "official",
    "software": "NexusPHP"
  },
  {
    "name": "HDFans",
    "short": "HDFans",
    "source": "official",
    "software": "NexusPHP"
  },
  {
    "name": "HeBits",
    "short": "HEB",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "HomieHelpDesk",
    "short": "HHD",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "Hon3yHD",
    "short": "HH",
    "source": "generated",
    "software": null
  },
  {
    "name": "House of Devil",
    "short": "HoD",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "HQMusic",
    "short": "HQM",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "Immortuos",
    "short": "IMMO",
    "source": "generated",
    "software": "UNIT3D"
  },
  {
    "name": "IndieTorrents",
    "short": "IP",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "Infire",
    "short": "INF",
    "source": "official",
    "software": "U-232"
  },
  {
    "name": "iNSANE",
    "short": "IN",
    "source": "generated",
    "software": null
  },
  {
    "name": "IPTorrents",
    "short": "IPT",
    "source": "official",
    "software": null
  },
  {
    "name": "ItaTorrents",
    "short": "ITT",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "JME-REUNIT3D",
    "short": "JME",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "JPopsuki",
    "short": "JPS",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "JPTVTS",
    "short": "JPTV",
    "source": "generated",
    "software": "Custom"
  },
  {
    "name": "Karagarga",
    "short": "KG",
    "source": "official",
    "software": null
  },
  {
    "name": "Keep Friends",
    "short": "FRDS",
    "source": "official",
    "software": "NexusPHP"
  },
  {
    "name": "KrayTracker",
    "short": "KT",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "Le Saloon",
    "short": "LS",
    "source": "generated",
    "software": "XBTIT"
  },
  {
    "name": "Last Digital Underground",
    "short": "LDU",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "Lat-Team",
    "short": "LT",
    "source": "generated",
    "software": "UNIT3D"
  },
  {
    "name": "LearnFlakes",
    "short": "LF",
    "source": "official",
    "software": "Custom"
  },
  {
    "name": "LegacyHD",
    "short": "LHD",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "Libble",
    "short": "LiB",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "LinkoManija",
    "short": "LM",
    "source": "official",
    "software": "Custom"
  },
  {
    "name": "LST",
    "short": "LST",
    "source": "generated",
    "software": "UNIT3D"
  },
  {
    "name": "LzTr",
    "short": "LZTR",
    "source": "generated",
    "software": "Gazelle"
  },
  {
    "name": "M-Team",
    "short": "M-Team",
    "source": "official",
    "software": "NexusPHP"
  },
  {
    "name": "MaDs Revolution",
    "short": "MaDs",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "Malayabits",
    "short": "MB",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "Materialize",
    "short": "MAT",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "Max New Vision",
    "short": "MNV",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "Milkie",
    "short": "MILK",
    "source": "generated",
    "software": "Custom"
  },
  {
    "name": "MojBlink",
    "short": "MBJ",
    "source": "official",
    "software": "TBDEV"
  },
  {
    "name": "MoreThanTV",
    "short": "MTV",
    "source": "official",
    "software": "Luminance"
  },
  {
    "name": "MusicVids",
    "short": "MV",
    "source": "official",
    "software": null
  },
  {
    "name": "MyAnonaMouse",
    "short": "MAM",
    "source": "official",
    "software": "TBDev"
  },
  {
    "name": "MySpleen",
    "short": "MS",
    "source": "official",
    "software": null
  },
  {
    "name": "nCore",
    "short": "NC",
    "source": "generated",
    "software": "Custom"
  },
  {
    "name": "Nebulance",
    "short": "NBL",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "New Propaganda",
    "short": "NP",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "New Real World",
    "short": "NRW",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "NewHeaven",
    "short": "NH",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "Nostradamus",
    "short": "NOST",
    "source": "generated",
    "software": "Custom"
  },
  {
    "name": "NordicQuality (API)",
    "short": "NQ",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "OldToons",
    "short": "OTW",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "OnlyEncodes+",
    "short": "OE",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "Orpheus",
    "short": "OPS",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "OurBits",
    "short": "OB",
    "source": "official",
    "software": "NexusPHP"
  },
  {
    "name": "PassThePopcorn",
    "short": "PTP",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "Phoenix Project",
    "short": "PHX",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "PixelCove",
    "short": "PxC",
    "source": "official",
    "software": "Luminance"
  },
  {
    "name": "PolishTracker",
    "short": "PT",
    "source": "official",
    "software": "ReaperEngine"
  },
  {
    "name": "Pornbay",
    "short": "PB",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "Portugas",
    "short": "PTG",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "PrivateHD",
    "short": "PHD",
    "source": "official",
    "software": "Custom"
  },
  {
    "name": "PTerClub",
    "short": "PTer",
    "source": "official",
    "software": "NexusPHP"
  },
  {
    "name": "PTFiles",
    "short": "PTF",
    "source": "official",
    "software": "Custom"
  },
  {
    "name": "PTFans",
    "short": "PTFans",
    "source": "official",
    "software": "Custom"
  },
  {
    "name": "punck-tracker",
    "short": "PT2",
    "source": "generated",
    "software": null
  },
  {
    "name": "PuroVicio",
    "short": "PRV",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "Racing4Everyone",
    "short": "R4E",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "RacingForMe",
    "short": "RFM",
    "source": "official",
    "software": "Custom"
  },
  {
    "name": "Rastastugan",
    "short": "RAS",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "Redacted",
    "short": "RED",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "Retroflix",
    "short": "RF",
    "source": "official",
    "software": null
  },
  {
    "name": "ReelFliX",
    "short": "RFX",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "RevolutionTT",
    "short": "RTT",
    "source": "official",
    "software": "TBdev"
  },
  {
    "name": "RocketHD",
    "short": "RHD",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "Samaritano",
    "short": "SAMA",
    "source": "generated",
    "software": "UNIT3D"
  },
  {
    "name": "SceneHD",
    "short": "SH",
    "source": "generated",
    "software": null
  },
  {
    "name": "SceneLinks",
    "short": "SL",
    "source": "official",
    "software": null
  },
  {
    "name": "SceneTime",
    "short": "ST",
    "source": "official",
    "software": null
  },
  {
    "name": "SecretCinema",
    "short": "SC",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "seedpool",
    "short": "SP",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "SeedFile",
    "short": "SF",
    "source": "official",
    "software": null
  },
  {
    "name": "Shareisland",
    "short": "SHR",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "Share Friends Project",
    "short": "SFP",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "Simurg",
    "short": "SIM",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "SkipTheCommercials",
    "short": "STC",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "SnowPT (Skyeysnow)",
    "short": "SSPT",
    "source": "official",
    "software": null
  },
  {
    "name": "SocietyGlitch",
    "short": "SG",
    "source": "official",
    "software": null
  },
  {
    "name": "SpeedApp",
    "short": "SA",
    "source": "generated",
    "software": "Custom"
  },
  {
    "name": "Spirit of Revolution",
    "short": "SoR",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "SportsCult",
    "short": "SC",
    "source": "official",
    "software": null
  },
  {
    "name": "SpringSunday",
    "short": "SSD",
    "source": "official",
    "software": "NexusPHP"
  },
  {
    "name": "SugoiMusic",
    "short": "SM",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "SuperBits",
    "short": "SBS",
    "source": "official",
    "software": "rartracker"
  },
  {
    "name": "Swarmazon",
    "short": "SMZ",
    "source": "official",
    "software": null
  },
  {
    "name": "Tasmanit",
    "short": "TAS",
    "source": "official",
    "software": "TSSE"
  },
  {
    "name": "The Falling Angels",
    "short": "TFA",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "The Horror Charnel",
    "short": "THC",
    "source": "official",
    "software": null
  },
  {
    "name": "The Leach Zone",
    "short": "TLZ",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "The New Retro",
    "short": "TNR",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "The Old School",
    "short": "TOS",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "The Paradiese",
    "short": "TP",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "The Shinning",
    "short": "TSH",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "The-Crazy-Ones",
    "short": "TCO",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "The-New-Fun",
    "short": "TNF",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "TheGeeks",
    "short": "TG",
    "source": "official",
    "software": "TCG"
  },
  {
    "name": "TheMixingBowl",
    "short": "TMB",
    "source": "official",
    "software": null
  },
  {
    "name": "ThePlace",
    "short": "TP",
    "source": "official",
    "software": "TCG"
  },
  {
    "name": "TheScenePlace",
    "short": "TSP",
    "source": "official",
    "software": "XBTIT"
  },
  {
    "name": "TheVault",
    "short": "TV",
    "source": "official",
    "software": "TCG"
  },
  {
    "name": "TNTracker",
    "short": "TN",
    "source": "official",
    "software": "Custom"
  },
  {
    "name": "Torrent Explosiv",
    "short": "TE",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "Torrent Sector Crew",
    "short": "TSC",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "Torrent Trader",
    "short": "TT",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "Torrent-Syndikat",
    "short": "TS",
    "source": "official",
    "software": "Custom"
  },
  {
    "name": "TorrentBD",
    "short": "TBD",
    "source": "official",
    "software": "Custom"
  },
  {
    "name": "TorrentDay",
    "short": "TD",
    "source": "official",
    "software": null
  },
  {
    "name": "TorrentLand",
    "short": "TL2",
    "source": "generated",
    "software": "UNIT3D"
  },
  {
    "name": "TorrentLeech",
    "short": "TL",
    "source": "official",
    "software": null
  },
  {
    "name": "Torrentleech.pl",
    "short": "TL.pl",
    "source": "official",
    "software": null
  },
  {
    "name": "Torrenteros",
    "short": "TTR",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "ToTheGlory",
    "short": "TTG",
    "source": "official",
    "software": "TBSource"
  },
  {
    "name": "TR4KER",
    "short": "T4",
    "source": "official",
    "software": "Custom"
  },
  {
    "name": "TurkSeed",
    "short": "TS2",
    "source": "generated",
    "software": "UNIT3D"
  },
  {
    "name": "TV-Vault",
    "short": "TVV",
    "source": "official",
    "software": "Gazelle"
  },
  {
    "name": "U2",
    "short": "U2",
    "source": "official",
    "software": "NexusPHP"
  },
  {
    "name": "Universal-Torrents",
    "short": "UT",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "Unwalled",
    "short": "UNW",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "upload.cx",
    "short": "ULCX",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "Upscale Vault",
    "short": "UV",
    "source": "official",
    "software": "UNIT3D"
  },
  {
    "name": "Utopia",
    "short": "UTOP",
    "source": "generated",
    "software": "UNIT3D"
  },
  {
    "name": "V3X",
    "short": "VX",
    "source": "generated",
    "software": "Custom"
  },
  {
    "name": "World-of-Tomorrow",
    "short": "WoT",
    "source": "official",
    "software": "NetVision"
  },
  {
    "name": "Xbtmusic",
    "short": "XBT",
    "source": "official",
    "software": "xbtmusic Original"
  },
  {
    "name": "XtremeWrestlingTorrents",
    "short": "XWT",
    "source": "official",
    "software": null
  },
  {
    "name": "YggReborn",
    "short": "YR",
    "source": "generated",
    "software": "Custom"
  },
  {
    "name": "YUSCENE",
    "short": "YUSC",
    "source": "generated",
    "software": "UNIT3D"
  }
]);
  const TRACKER_DIRECTORY_BY_NAME = new Map();
  TRACKER_DIRECTORY.forEach((entry) => {
    const key = normalizeTrackerDirectoryName(entry.name);
    TRACKER_DIRECTORY_BY_NAME.set(key, entry);
    // Parenthetical names in the source also act as aliases (for example, SnowPT).
    const baseAlias = normalizeTrackerDirectoryName(entry.name.replace(/\s*\([^)]*\)\s*$/, ''));
    if (baseAlias && baseAlias !== key && !TRACKER_DIRECTORY_BY_NAME.has(baseAlias)) {
      TRACKER_DIRECTORY_BY_NAME.set(baseAlias, entry);
    }
  });

  function normalizeTrackerDirectoryName(value) {
    return String(value || '').toLowerCase()
      .replace(/\s*\(api\)\s*$/i, '')
      .replace(/[^a-z0-9]+/g, '');
  }

  function trackerDirectoryEntry(value) {
    return TRACKER_DIRECTORY_BY_NAME.get(normalizeTrackerDirectoryName(value)) || null;
  }

  function trackerDirectoryHostEntry(value) {
    const host = trackerHostname(value);
    if (!host) return null;
    const labels = host.split('.').filter(Boolean);
    const twoPartSuffixes = ['co.uk','org.uk','ac.uk','com.au','net.au','org.au','co.nz','com.br','com.tr','com.sg','com.tw','co.in','net.in','org.in','co.za','com.mx','com.ar','com.pl','com.ua'];
    const suffix = labels.slice(-2).join('.');
    const label = labels.length > 2 && twoPartSuffixes.includes(suffix)
      ? labels[labels.length - 3]
      : labels.length > 1 ? labels[labels.length - 2] : labels[0];
    return trackerDirectoryEntry(label);
  }

  function validateTrackerIdentity(name, shortName) {
    const entry = trackerDirectoryEntry(name);
    if (!entry) return { known: false, valid: true, name: String(name || '').trim(), shortName: String(shortName || '').trim(), source: 'custom' };
    const supplied = String(shortName || '').trim();
    return {
      known: true,
      valid: !supplied || supplied === entry.short,
      name: entry.name,
      shortName: entry.short,
      source: entry.source,
    };
  }

  function knownTrackerDisplayName(host, origin, kind, doc) {
    const hosts = [trackerHostname(host), trackerHostname(origin)].filter(Boolean);
    const matches = (fn) => hosts.some((value) => fn(value));
    if (matches(isCinematikHost)) return 'Cinematik';
    if (matches(isKaragargaHost)) return 'Karagarga';
    if (matches(isMTeamHost)) return 'M-Team';
    if (matches(isBlutopiaHost)) return 'Blutopia';
    if (matches(isDesiGaaneHost)) return 'DesiGaane';
    if (matches(isPolishTrackerHost) || isPolishTrackerDocument(doc)) return 'PolishTracker';
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
    const known = knownTrackerDisplayName(tracker.host, tracker.origin, tracker.kind, null);
    if (known) return (trackerDirectoryEntry(known) || {}).name || known;

    const hostEntry = trackerDirectoryHostEntry(tracker.host) || trackerDirectoryHostEntry(tracker.origin);
    if (hostEntry) return hostEntry.name;

    const candidates = [
      tracker.fullName,
      cleanTrackerDisplayName(guessName(tracker.name, tracker.host), tracker.host, tracker.origin),
      cleanTrackerDisplayName(tracker.name, tracker.host, tracker.origin),
    ].filter(Boolean);
    for (const candidate of candidates) {
      const entry = trackerDirectoryEntry(candidate);
      if (entry) return entry.name;
    }
    return candidates[0] || 'Tracker';
  }

  function shortNameOf(name) {
    const entry = trackerDirectoryEntry(name);
    if (entry) return entry.short;
    const value = String(name || '');
    const caps = (value.match(/[A-Z0-9]/g) || []).slice(0, 4).join('');
    return (caps.length >= 2 ? caps : value.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'TRK').slice(0, 8);
  }

  function trackerDisplayName(tracker) {
    if (typeof tracker === 'string') return shortNameOf(tracker);
    tracker = tracker || {};
    const fullName = canonicalSavedTrackerName(tracker);
    const identity = trackerDirectoryEntry(fullName);
    if (identity) return identity.short;
    return String(tracker.shortName || shortNameOf(fullName || tracker.host) || 'TRK').trim().slice(0, 8);
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

  // M-Team runs the custom mTorrent API, not generic NexusPHP/Gazelle profile HTML.
  function mapMTeamProfilePayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const code = String(payload.code ?? '').toUpperCase();
    const message = String(payload.message || '').toUpperCase();
    if (code && !['0', '200', 'SUCCESS'].includes(code)) return null;
    if (!code && message && message !== 'SUCCESS') return null;
    const user = payload.data && typeof payload.data === 'object' ? payload.data : null;
    const counts = user && (user.memberCount || user.member_count || user.count);
    if (!user || !counts || user.id === null || user.id === undefined) return null;

    const uploaded = apiByteNumber(counts.uploaded ?? user.uploaded);
    const downloaded = apiByteNumber(counts.downloaded ?? user.downloaded);
    if (uploaded === null || downloaded === null) return null;

    return {
      kind: 'mteam',
      userId: String(user.id),
      username: String(user.username || user.name || user.nickname || user.id),
      stats: {
        uploaded,
        downloaded,
        ratio: apiRatio(uploaded, downloaded),
        bonus_points: apiOptionalNumber(counts.bonus ?? user.bonus),
        user_class: user.roleName || user.role_name || user.role || null,
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

  function isSherlockDashboardPage() {
    if (!/\/dashboard\/?$/.test(location.pathname)) return false;
    try {
      return location.origin === new URL(SHERLOCK_DASHBOARD_BASE_URL).origin;
    } catch (e) {
      return false;
    }
  }

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

  function isCinematikHost(value) {
    const host = trackerHostname(value);
    return host === 'cinematik.net' || host.endsWith('.cinematik.net');
  }

  function isKaragargaHost(value) {
    const host = trackerHostname(value);
    return host === 'karagarga.in' || host.endsWith('.karagarga.in');
  }

  function isMTeamHost(value) {
    const host = trackerHostname(value);
    return host === 'm-team.cc' || host.endsWith('.m-team.cc') ||
      host === 'm-team.io' || host.endsWith('.m-team.io');
  }

  function mTeamApiOrigin(siteOrigin, URLClass) {
    const URLCtor = URLClass || URL;
    const apiUrl = new URLCtor(siteOrigin);
    const labels = apiUrl.hostname.split('.');
    if (labels.length < 2 || !isMTeamHost(apiUrl.hostname)) {
      throw new Error('Unsupported M-Team site address.');
    }
    // The bare canonical host has no site subdomain to replace.
    if (labels.length === 2 && labels[0] === 'm-team') labels.unshift('api');
    else labels[0] = 'api';
    apiUrl.hostname = labels.join('.');
    apiUrl.pathname = '/';
    apiUrl.search = '';
    apiUrl.hash = '';
    return apiUrl.origin;
  }

  function isBlutopiaHost(value) {
    const host = trackerHostname(value);
    return host === 'blutopia.cc' || host.endsWith('.blutopia.cc') ||
      host === 'blutopia.xyz' || host.endsWith('.blutopia.xyz');
  }

  function isDesiGaaneHost(value) {
    const host = trackerHostname(value);
    return host === 'desigaane.rocks' || host.endsWith('.desigaane.rocks');
  }

  function isPolishTrackerHost(value) {
    const host = trackerHostname(value);
    return host === 'pte.nu' || host.endsWith('.pte.nu') ||
      host === 'polishtracker.net' || host.endsWith('.polishtracker.net');
  }

  function isPolishTrackerDocument(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return false;
    if (!/polishtracker/i.test(String(doc.title || ''))) return false;
    return !!doc.querySelector('#root') &&
      !!doc.querySelector('script[src*="/preview/assets/"]');
  }

  function isKaragargaProfileDocument(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return false;
    if (!/^KG\s*[-–—:]\s*Details for\b/i.test(String(doc.title || ''))) return false;
    let uploaded = false;
    let downloaded = false;
    doc.querySelectorAll('tr').forEach((row) => {
      const cells = Array.from(row.children || []).filter((cell) =>
        String(cell.tagName || '').toLowerCase() === 'td'
      );
      if (cells.length < 2) return;
      const label = normLabel(cells[0].textContent || '');
      if (LABELS.uploaded.some((regex) => regex.test(label)) &&
          parseBytes(cells[1].textContent || '', false) !== null) uploaded = true;
      if (LABELS.downloaded.some((regex) => regex.test(label)) &&
          parseBytes(cells[1].textContent || '', false) !== null) downloaded = true;
    });
    return uploaded && downloaded;
  }

  function mapKaragargaProfileRows(rows, statusText) {
    const stats = resolveStats(rows || [], false);
    const header = String(statusText || '').replace(/[\s\u00a0]+/g, ' ').trim();
    if (stats.ratio === undefined) {
      const ratio = header.match(/\bRatio\s*:\s*(∞|inf(?:inity)?|[-–—]|[\d.,]+)/i);
      if (ratio) {
        const parsed = parseRatio(ratio[1]);
        if (parsed) stats.ratio = parsed.infinite ? Infinity : parsed.value;
      }
    }
    if (stats.ratio === undefined &&
        Number.isFinite(stats.uploaded) && Number.isFinite(stats.downloaded)) {
      stats.ratio = stats.downloaded > 0
        ? stats.uploaded / stats.downloaded
        : (stats.uploaded > 0 ? Infinity : null);
    }
    return stats;
  }

  function findKaragargaProfileLink(doc, base, expectedOrigin) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    let baseUrl;
    try { baseUrl = new URL(base); } catch (e) { return null; }
    const origin = expectedOrigin || baseUrl.origin;
    const candidates = [];
    for (const anchor of doc.querySelectorAll('a[href*="userdetails.php?id="]')) {
      const href = anchor.getAttribute('href') || '';
      let url;
      try { url = new URL(href, baseUrl.href); } catch (e) { continue; }
      if (url.origin !== origin || !/^\/userdetails\.php$/i.test(url.pathname) ||
          !/^\d+$/.test(url.searchParams.get('id') || '')) continue;
      const title = String(anchor.getAttribute('title') || '');
      const greeting = anchor.closest && anchor.closest('nobr');
      const greetingText = String(greeting && greeting.textContent || '').replace(/\s+/g, ' ').trim();
      let score = 0;
      if (/details page/i.test(title)) score += 100;
      if (/^Hi\b/i.test(greetingText)) score += 80;
      if (score) candidates.push({
        url: url.href,
        text: String(anchor.textContent || '').replace(/\s+/g, ' ').trim(),
        score,
      });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? { url: candidates[0].url, text: candidates[0].text } : null;
  }

  async function readKaragarga(tracker, context) {
    context = context || {};
    const origin = context.origin || location.origin;
    const request = context.request || fetchText;
    const sourceDocument = Object.prototype.hasOwnProperty.call(context, 'document')
      ? context.document : document;
    const pageUrl = context.pageUrl || (sourceDocument ? location.href : origin + '/');
    let profileUrl = tracker.profileUrl || null;
    let linkText = tracker.username || '';

    if (!profileUrl && isKaragargaProfileDocument(sourceDocument)) profileUrl = pageUrl;

    if (!profileUrl) {
      let link = findKaragargaProfileLink(sourceDocument, pageUrl, origin);
      if (!link) {
        try {
          const home = await request(new URL('/', origin).href, 'text/html');
          const homeDocument = new DOMParser().parseFromString(home.text, 'text/html');
          link = findKaragargaProfileLink(homeDocument, home.url || new URL('/', origin).href, origin);
        } catch (e) {
          if (e instanceof ReadError) throw e;
          throw new ReadError('Could not read the Karagarga home page to find your profile link.');
        }
      }
      if (!link) throw new ReadError('Could not find the Karagarga "click to see your details page" link.');
      profileUrl = link.url;
      linkText = link.text || linkText;
    }

    let profileDocument = sourceDocument;
    let finalUrl = pageUrl;
    if (!isKaragargaProfileDocument(profileDocument) ||
        new URL(pageUrl, origin).href !== new URL(profileUrl, origin).href) {
      const response = await request(profileUrl, 'text/html');
      if (response.redirected && /login|signin/i.test(response.url)) {
        throw new ReadError('You are signed out of Karagarga. Sign in and try again.');
      }
      profileDocument = new DOMParser().parseFromString(response.text, 'text/html');
      finalUrl = response.url || profileUrl;
    }
    if (profileDocument.querySelector('input[type="password"]')) {
      throw new ReadError('You are signed out of Karagarga. Sign in and try again.');
    }

    const pairs = [];
    profileDocument.querySelectorAll('tr').forEach((row) => {
      const cells = Array.from(row.children || []).filter((cell) =>
        String(cell.tagName || '').toLowerCase() === 'td'
      );
      if (cells.length < 2) return;
      pairs.push({
        label: String(cells[0].textContent || '').replace(/\s+/g, ' ').trim(),
        value: String(cells[1].textContent || '').replace(/\s+/g, ' ').trim(),
      });
    });

    let stats = mapKaragargaProfileRows(pairs, profileDocument.body && profileDocument.body.textContent || '');
    if (!Number.isFinite(stats.uploaded) || !Number.isFinite(stats.downloaded)) {
      stats = Object.assign(stats, mapKaragargaProfileRows(
        pairsFromText(plainText(profileDocument)),
        profileDocument.body && profileDocument.body.textContent || ''
      ));
    }
    if (!Number.isFinite(stats.uploaded) || stats.uploaded < 0 ||
        !Number.isFinite(stats.downloaded) || stats.downloaded < 0) {
      throw new ReadError('Karagarga profile did not contain valid Uploaded and Downloaded totals.');
    }

    const parsedUrl = new URL(finalUrl || profileUrl, origin);
    const userId = parsedUrl.searchParams.get('id') || '';
    const titleName = String(profileDocument.title || '').match(/^KG\s*[-–—:]\s*Details for\s+(.+)$/i);
    const username = linkText || (titleName ? titleName[1].trim() : '');
    return { kind: 'profile', userId, username, profileUrl, stats };
  }

  function trackerNameForNewTracker(title, host, origin, doc) {
    const known = knownTrackerDisplayName(host, origin, '', doc);
    if (known) return (trackerDirectoryEntry(known) || {}).name || known;

    const hostEntry = trackerDirectoryHostEntry(host) || trackerDirectoryHostEntry(origin);
    if (hostEntry) return hostEntry.name;

    const guessed = cleanTrackerDisplayName(guessName(title, host), host, origin);
    return (trackerDirectoryEntry(guessed) || {}).name || guessed || 'Tracker';
  }

  // Not in a browser (or no userscript manager): hand the helpers to a test runner and stop.
  if (typeof window === 'undefined' || typeof GM_getValue === 'undefined') {
    if (typeof module !== 'undefined') {
      module.exports = { parseLocaleNumber, parseBytes, parseCount, parseRatio, normLabel, resolveStats, pairsFromText, sizeLabel, guessName, shortNameOf, customTrackerBuffer, calculateDashboardTotals, trackerTraffic24h, sumTrackerTraffic24h, sumVerifiedDownloads, removeNativeTrackerFooter, centerTrackerMetrics, hasUnit3DStatsBar, unit3dBar, isCinematikHost, isBlutopiaHost, apiByteNumber, mapRartrackerStatus, mapDigitalCoreStatus, mapMTeamProfilePayload, mTeamApiOrigin, isMTeamHost, mapIptStatValues, mapIptProfileDetails, isIptorrentsHost, normalizeIptorrentsTrackerStore, isDigitalCoreHost, trackerNameForNewTracker, trackerHostname, cleanTrackerDisplayName, knownTrackerDisplayName, isDesiGaaneHost, isKaragargaHost, isKaragargaProfileDocument, mapKaragargaProfileRows, findKaragargaProfileLink, isPolishTrackerHost, isPolishTrackerDocument, canonicalSavedTrackerName, trackerDirectory: TRACKER_DIRECTORY, trackerDirectoryEntry, trackerDirectoryHostEntry, validateTrackerIdentity, trackerDisplayName, normalizeTrackerDirectoryName, localRatio, profileAddressFromDocument, isTorrentLeechHost, isTorrentLeechDocument, isTorrentLeechTracker, mapTorrentLeechProfileRows, parseTorrentLeechDocument, isCinemageddonHost, isCinemageddonDocument, isCinemageddonTracker, mapCinemageddonProfileRows, isFileListHost, isFileListDocument, isFileListTracker, mapFileListProfileRows, isMyAnonamouseHost, isMyAnonamouseDocument, isMyAnonamouseTracker, mapMyAnonamouseProfileRows, isTranceTrafficHost, tranceTrafficStatusLink, isTranceTrafficDocument, isTranceTrafficTracker, mapTranceTrafficProfileRows, trackerApiType, sherlockDashboardUrl };
    }
    return;
  }

  /* ======================================================================
   * Settings, kept in the userscript manager
   * ==================================================================== */

  const VERSION = '1.9.8';
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
    get interval() { return Math.max(15, Number(GM_getValue('sherlock.interval', 15)) || 15); },
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
        const officialIdentity = trackerDirectoryEntry(cleanName);
        const expectedShortName = officialIdentity ? officialIdentity.short : (tracker.shortName || shortNameOf(cleanName));
        if (tracker.name !== cleanName || tracker.shortName !== expectedShortName) {
          tracker.name = cleanName;
          tracker.shortName = expectedShortName;
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
    const officialIdentity = trackerDirectoryEntry(cleanName);
    const expectedShortName = officialIdentity ? officialIdentity.short : (t.shortName || shortNameOf(cleanName));
    t.name = cleanName;
    t.shortName = expectedShortName;
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
    const payload = parseTrackerApiJson(response, trackerDisplayName(tracker) || 'Rartracker');
    const data = mapRartrackerStatus(payload);
    if (!data) throw new ReadError('Rartracker /api/v1/status did not contain a signed-in user with valid uploaded and downloaded totals.');

    // This endpoint is part of the public Rartracker schema. Enrichment is optional:
    // keep the verified status totals if a tracker does not expose every profile field.
    try {
      const detailResponse = await fetcher('/api/v1/users/' + encodeURIComponent(data.userId), 'application/json');
      const detailPayload = parseTrackerApiJson(detailResponse, trackerDisplayName(tracker) || 'Rartracker');
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
  function hasUnit3DStatsBar(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return false;
    // #userinfo_stats is shared by Gazelle/Luminance themes and is not UNIT3D proof.
    // The fallback requires UNIT3D-specific ratio-bar markup.
    return !!doc.querySelector(
      '.ratio-bar, [class*="top-nav__ratio-bar"], [class*="ratio-bar__uploaded"], [class*="ratio-bar__downloaded"]'
    );
  }

  function unit3dBar(doc, si) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return {};
    const out = {};
    const keys = {
      uploaded: 'uploaded', downloaded: 'downloaded', ratio: 'ratio',
      points: 'bonus_points', bonus: 'bonus_points',
      seeding: 'seeding', leeching: 'leeching', buffer: 'buffer',
    };
    doc.querySelectorAll('[class*="ratio-bar__"]').forEach((el) => {
      const classText = typeof el.className === 'string'
        ? el.className
        : (el.getAttribute('class') || '');
      const m = classText.match(/(?:^|\s)ratio-bar__([a-z_-]+)/);
      const key = m && keys[m[1]];
      if (!key || key in out) return;
      const value = fits(key, String(el.textContent || '').replace(/\s+/g, ' '), si);
      if (value !== undefined) out[key] = value;
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
    const sels = ['a.top-nav__username--highresolution', 'a.top-nav__username', '.top-nav__right a[href*="/users/"]', '.top-nav__right a[href*="/user/"]', '#userinfo_username a.username', '#userinfo_username a', 'a[href*="userdetails.php?id="]', 'a[href*="user.php?id="]', 'a[href*="/users/"]', 'a[href*="/user/"]', 'a[href*="/profile/"]', 'a[href*="/members/"]'];
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

    // M-Team uses its custom mTorrent API and requires a token from Control Panel → Lab.
    const savedIdentity = trackerDirectoryEntry(tracker && (tracker.name || tracker.fullName));
    if (isMTeamHost(hostname) || (savedIdentity && savedIdentity.name === 'M-Team')) return 'mteam';
    // AnimeBytes is NOT a stock Gazelle JSON tracker. Its /ajax.php endpoint
    // returns HTML; use the same signed-in profile-page fallback as the older
    // working Sherlock reader instead of locking it to the Gazelle adapter.
    if (isPolishTrackerHost(hostname) ||
        (savedIdentity && savedIdentity.name === 'PolishTracker')) return null;
    if (hostname === 'animebytes.tv' || hostname.endsWith('.animebytes.tv') ||
        (savedIdentity && savedIdentity.name === 'AnimeBytes')) return null;

    // Keep dedicated adapters ahead of generic engine detection.
    if (isCinematikHost(hostname)) return 'unit3d';
    if (hostname === 'digitalcore.club' || hostname.endsWith('.digitalcore.club')) return 'digitalcore';
    if (hostname === 'superbits.org' || hostname.endsWith('.superbits.org')) return 'rartracker';
    if (isIptorrentsHost(hostname)) return 'iptorrents';
    if (isTorrentLeechTracker(tracker)) return 'torrentleech';
    if (isTranceTrafficTracker(tracker)) return 'trancetraffic';
    if (isMyAnonamouseTracker(tracker)) return 'myanonamouse';
    if (isFileListTracker(tracker)) return 'filelist';
    if (isCinemageddonTracker(tracker)) return 'cinemageddon';

    // The tracker identity list includes its software family. Use it to select the
    // correct reader instead of guessing from generic DOM IDs shared by themes.
    const identity = trackerDirectoryHostEntry(hostname) ||
      trackerDirectoryEntry(tracker && (tracker.name || tracker.fullName));
    const software = String(identity && identity.software || '').toLowerCase();
    if (software.includes('gazelle')) return 'gazelle';
    if (software.includes('unit3d')) return 'unit3d';
    return null;
  }

  async function readUnit3D(tracker, context) {
    context = context || {};
    const origin = context.origin || location.origin;
    const request = context.request || fetchText;
    const sourceDocument = Object.prototype.hasOwnProperty.call(context, 'document') ? context.document : document;
    const pageUrl = context.pageUrl || (sourceDocument ? location.href : origin + '/');
    const si = !!tracker.si;

    const parseStatsPage = (doc) => {
      if (!doc) return {};
      const result = Object.assign({}, resolveStats(extractPairs(doc), si), unit3dBar(doc, si));
      if (result.uploaded === undefined || result.downloaded === undefined) {
        Object.assign(result, resolveStats(pairsFromText(plainText(doc)), si));
      }
      return result;
    };

    // Read exact counters from the currently open authenticated page first.
    let stats = parseStatsPage(sourceDocument);
    let profileLink = sourceDocument
      ? findProfileLink(sourceDocument, pageUrl, origin)
      : null;

    // Some UNIT3D themes expose the own-account link/counters only on the home-page navbar.
    if (!profileLink || stats.uploaded === undefined || stats.downloaded === undefined) {
      const home = await request(new URL('/', origin).href, 'text/html');
      const homeDocument = new DOMParser().parseFromString(home.text, 'text/html');
      if (!profileLink) {
        profileLink = findProfileLink(homeDocument, home.url || (origin + '/'), origin);
      }
      if (stats.uploaded === undefined || stats.downloaded === undefined) {
        stats = Object.assign({}, parseStatsPage(homeDocument), stats);
      }
    }

    if (!profileLink) {
      throw new ReadError('Could not find your own UNIT3D profile link in the tracker navigation.');
    }
    if (stats.uploaded === undefined || stats.downloaded === undefined) {
      return readProfile(profileLink.url, profileLink.text, si, request, origin);
    }

    const ident = identityFromProfile(profileLink.url, profileLink.text);
    return {
      kind: 'profile',
      userId: ident.userId,
      username: ident.username,
      profileUrl: profileLink.url,
      stats,
    };
  }


  function parsePassThePopcornStats(doc, si) {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    const stats = {};

    // PTP header IDs: Up = total uploaded; Down = total downloaded.
    const uploadedNode = doc.querySelector('#stats_seeding .user-info-bar__text');
    const downloadedNode = doc.querySelector('#stats_leeching .user-info-bar__text');
    const ratioNode = doc.querySelector('#stats_ratio .user-info-bar__text');
    const uploaded = uploadedNode ? parseBytes(uploadedNode.textContent || '', si) : null;
    const downloaded = downloadedNode ? parseBytes(downloadedNode.textContent || '', si) : null;
    if (uploaded !== null) stats.uploaded = uploaded;
    if (downloaded !== null) stats.downloaded = downloaded;

    if (ratioNode) {
      const ratio = parseRatio(ratioNode.textContent || '');
      if (ratio) stats.ratio = ratio.infinite ? null : ratio.value;
    }

    const ratioLink = doc.querySelector('#stats_ratio a[title]');
    const ratioTitle = ratioLink && ratioLink.getAttribute('title') || '';
    const bufferMatch = ratioTitle.match(/\bBuffer\s*:\s*(\d[\d.,'’ ]*\s*[KMGTPE]?i?B)\b/i);
    if (bufferMatch) {
      const buffer = parseBytes(bufferMatch[1], si);
      if (buffer !== null) stats.buffer = buffer;
    }

    // The PTP profile's first sidebar panel is explicitly headed "Stats".
    // Do not scan Community's "Uploaded: 1 (2)" torrent count as a byte value.
    const panels = Array.from(doc.querySelectorAll('.sidebar .panel') || []);
    const statsPanel = panels.find((panel) => {
      const heading = panel.querySelector('.panel__heading__title');
      return heading && normLabel(heading.textContent) === 'stats';
    });
    if (statsPanel) {
      const lines = Array.from(statsPanel.querySelectorAll('li') || [])
        .map((node) => String(node.textContent || '').replace(/\s+/g, ' ').trim());
      const readBytesLabel = (label) => {
        const escaped = label.replace(/[.*+?^$|(){}[\]\\]/g, '\\$&');
        const re = new RegExp('^' + escaped + '\\s*:\\s*(.+)$', 'i');
        for (const line of lines) {
          const match = line.match(re);
          if (!match) continue;
          const value = parseBytes(match[1], si);
          if (value !== null) return value;
        }
        return null;
      };
      if (stats.uploaded === undefined) {
        const value = readBytesLabel('Uploaded');
        if (value !== null) stats.uploaded = value;
      }
      if (stats.downloaded === undefined) {
        const value = readBytesLabel('Downloaded');
        if (value !== null) stats.downloaded = value;
      }
      if (stats.ratio === undefined) {
        const line = lines.find((value) => /^Ratio\s*:/i.test(value));
        if (line) {
          const ratio = parseRatio(line.replace(/^Ratio\s*:\s*/i, ''));
          if (ratio) stats.ratio = ratio.infinite ? null : ratio.value;
        }
      }
      const required = lines.find((value) => /^Required ratio\s*:/i.test(value));
      if (required) {
        const ratio = parseRatio(required.replace(/^Required ratio\s*:\s*/i, ''));
        if (ratio) stats.required_ratio = ratio.infinite ? null : ratio.value;
      }
      const userClass = lines.find((value) => /^Class\s*:/i.test(value));
      if (userClass) stats.user_class = userClass.replace(/^Class\s*:\s*/i, '').trim();
    }

    return Number.isFinite(stats.uploaded) && Number.isFinite(stats.downloaded) ? stats : null;
  }

  async function readPassThePopcorn(tracker, context) {
    context = context || {};
    const origin = context.origin || location.origin;
    const request = context.request || fetchText;
    const sourceDocument = Object.prototype.hasOwnProperty.call(context, 'document') ? context.document : document;
    const pageUrl = context.pageUrl || (sourceDocument ? location.href : origin + '/');
    const si = !!tracker.si;
    let profileLink = null;
    let profileError = null;

    const readDocument = (doc, link, responseUrl, redirected) => {
      if ((redirected && /login|signin/i.test(responseUrl || '')) ||
          (doc && doc.querySelector && doc.querySelector('input[type="password"]'))) {
        throw new ReadError('PassThePopcorn session expired. Sign in again and refresh.');
      }
      const stats = parsePassThePopcornStats(doc, si);
      if (!stats) throw new ReadError('PTP profile HTML did not contain its account Uploaded/Downloaded values.');
      const identity = link
        ? identityFromProfile(link.url, link.text)
        : { userId: tracker.userId || null, username: tracker.username || '' };
      return {
        kind: 'profile',
        userId: identity.userId || tracker.userId || null,
        username: identity.username || tracker.username || '',
        profileUrl: link ? link.url : (tracker.profileUrl || null),
        stats,
      };
    };

    // Prefer PTP's profile page. Its own HTML contains all primary account stats;
    // no /ajax.php?action=index request is needed.
    try {
      profileLink = await discoverProfile(tracker, request, origin, sourceDocument, pageUrl);
      const profileResponse = await request(profileLink.url, 'text/html');
      const profileDoc = new DOMParser().parseFromString(profileResponse.text, 'text/html');
      return readDocument(profileDoc, profileLink, profileResponse.url || profileLink.url, profileResponse.redirected);
    } catch (e) {
      if (!(e instanceof ReadError)) throw e;
      profileError = e;
    }

    // Fallback to the authenticated source page or PTP homepage header.
    let fallbackDocument = sourceDocument;
    let fallbackUrl = pageUrl;
    if (!fallbackDocument) {
      try {
        const home = await request(new URL('/', origin).href, 'text/html');
        fallbackDocument = new DOMParser().parseFromString(home.text, 'text/html');
        fallbackUrl = home.url || new URL('/', origin).href;
        return readDocument(fallbackDocument, null, fallbackUrl, home.redirected);
      } catch (e) {
        if (!(e instanceof ReadError)) throw e;
        profileError = e;
      }
    } else {
      try {
        return readDocument(fallbackDocument, null, fallbackUrl, false);
      } catch (e) {
        if (!(e instanceof ReadError)) throw e;
        profileError = e;
      }
    }

    throw new ReadError(
      'PTP stats could not be read from its profile or signed-in header. ' +
      (profileError && profileError.message ? profileError.message : 'The PTP Uploaded/Downloaded fields were not found.')
    );
  }

  function isPassThePopcornTrackerRecord(tracker, doc) {
    tracker = tracker || {};
    const host = trackerHostname(tracker.host || tracker.origin);
    const identity = trackerDirectoryEntry(tracker.name || tracker.fullName);
    const nameKey = normalizeTrackerDirectoryName(tracker.name || tracker.fullName || '');
    const shortKey = String(tracker.shortName || '').trim().toUpperCase();
    return host === 'passthepopcorn.me' || host.endsWith('.passthepopcorn.me') ||
      !!(identity && identity.name === 'PassThePopcorn') ||
      nameKey === 'ptp' || nameKey === 'passthepopcorn' ||
      shortKey === 'PTP' || trackerDisplayName(tracker).toUpperCase() === 'PTP' ||
      isPassThePopcornDocument(doc);
  }

  function isPassThePopcornDocument(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return false;
    const title = String(doc.title || '');
    if (!/PassThePopcorn/i.test(title)) return false;
    // Require the PTP member header and its classic stats list as well as the title.
    return !!doc.querySelector('#userinfo_stats') &&
      !!doc.querySelector('#userinfo_username a[href*="user.php?id="]');
  }

  function polishTrackerApiValue(object, names) {
    if (!object || typeof object !== 'object') return undefined;
    for (const name of names) if (Object.prototype.hasOwnProperty.call(object, name) && object[name] !== null && object[name] !== undefined && object[name] !== '') return object[name];
    return undefined;
  }

  function findPolishTrackerApiObject(root, predicate, depth, seen) {
    depth = depth || 0;
    seen = seen || new Set();
    if (!root || typeof root !== 'object' || Array.isArray(root) || seen.has(root) || depth > 6) return null;
    seen.add(root);
    if (predicate(root)) return root;
    for (const key of Object.keys(root).slice(0, 60)) {
      const child = root[key];
      if (child && typeof child === 'object') {
        const found = findPolishTrackerApiObject(child, predicate, depth + 1, seen);
        if (found) return found;
      }
    }
    return null;
  }

  function polishTrackerApiBytes(value, si) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    const text = String(value).trim();
    const numeric = Number(text);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : parseBytes(text, si);
  }

  function mapPolishTrackerApiPayload(payload, si) {
    const upNames = ['uploaded', 'upload', 'uploaded_bytes', 'uploadedBytes', 'total_uploaded', 'totalUploaded', 'uploaded_total', 'uploadedTotal', 'up'];
    const downNames = ['downloaded', 'download', 'downloaded_bytes', 'downloadedBytes', 'total_downloaded', 'totalDownloaded', 'downloaded_total', 'downloadedTotal', 'down'];
    const account = findPolishTrackerApiObject(payload, (value) =>
      polishTrackerApiValue(value, upNames) !== undefined && polishTrackerApiValue(value, downNames) !== undefined);
    if (!account) return null;
    const identity = findPolishTrackerApiObject(payload, (value) =>
      polishTrackerApiValue(value, ['id', 'user_id', 'userId', 'uuid']) !== undefined ||
      polishTrackerApiValue(value, ['username', 'user_name', 'userName', 'login']) !== undefined);
    const uploaded = polishTrackerApiBytes(polishTrackerApiValue(account, upNames), si);
    const downloaded = polishTrackerApiBytes(polishTrackerApiValue(account, downNames), si);
    if (!Number.isFinite(uploaded) || !Number.isFinite(downloaded)) return null;

    const stats = { uploaded, downloaded };
    const ratioRaw = polishTrackerApiValue(account, ['ratio', 'share_ratio', 'shareRatio', 'sharing_ratio', 'sharingRatio']) ??
      (identity ? polishTrackerApiValue(identity, ['ratio', 'share_ratio', 'shareRatio']) : undefined);
    if (ratioRaw !== undefined) {
      const ratio = parseRatio(String(ratioRaw));
      if (ratio) stats.ratio = ratio.infinite ? null : ratio.value;
    }
    const bufferRaw = polishTrackerApiValue(account, ['buffer', 'seed_buffer', 'seedBuffer', 'upload_buffer', 'uploadBuffer']);
    if (bufferRaw !== undefined) {
      const buffer = polishTrackerApiBytes(bufferRaw, si);
      if (buffer !== null) stats.buffer = buffer;
    }
    if (stats.buffer === undefined) stats.buffer = uploaded - downloaded;
    const requiredRaw = polishTrackerApiValue(account, ['required_ratio', 'requiredRatio', 'minimum_ratio', 'minimumRatio', 'min_ratio', 'minRatio']);
    if (requiredRaw !== undefined) {
      const required = parseRatio(String(requiredRaw));
      if (required && !required.infinite) stats.required_ratio = required.value;
    }
    const bonusRaw = polishTrackerApiValue(account, ['bonus_points', 'bonusPoints', 'bonus', 'points', 'karma']) ??
      (identity ? polishTrackerApiValue(identity, ['bonus_points', 'bonusPoints', 'bonus', 'points', 'karma']) : undefined);
    if (bonusRaw !== undefined && Number.isFinite(Number(bonusRaw))) stats.bonus_points = Number(bonusRaw);
    const classRaw = polishTrackerApiValue(account, ['user_class', 'userClass', 'class', 'rank', 'role']) ??
      (identity ? polishTrackerApiValue(identity, ['user_class', 'userClass', 'class', 'rank', 'role']) : undefined);
    if (classRaw !== undefined) stats.user_class = String(classRaw).trim();

    return {
      kind: 'profile',
      userId: String((identity && polishTrackerApiValue(identity, ['id', 'user_id', 'userId', 'uuid'])) || polishTrackerApiValue(account, ['id', 'user_id', 'userId', 'uuid']) || ''),
      username: String((identity && polishTrackerApiValue(identity, ['username', 'user_name', 'userName', 'login'])) || polishTrackerApiValue(account, ['name']) || ''),
      profileUrl: (identity && polishTrackerApiValue(identity, ['profile_url', 'profileUrl'])) || polishTrackerApiValue(account, ['profile_url', 'profileUrl']) || null,
      stats,
    };
  }

  async function readPolishTrackerApi(tracker, apiKey) {
    const key = String(apiKey || '').trim();
    if (!key) throw new ReadError('PolishTracker background sync needs an API key. Open Edit PT, enter the key from PolishTracker Settings → API, then press Read again and Save.');
    const endpoints = ['https://api.pte.nu/api/v3/users/me', 'https://api.pte.nu/users/myprofile'];
    const errors = [];
    for (const endpoint of endpoints) {
      try {
        const response = await managerFetchText(endpoint, 'application/json', { 'API-Key': key });
        let payload;
        try { payload = JSON.parse(response.text); }
        catch (e) { throw new ReadError('PolishTracker account API returned invalid JSON.'); }
        const data = mapPolishTrackerApiPayload(payload, !!tracker.si);
        if (data) return data;
        errors.push('No Uploaded/Downloaded totals in ' + new URL(endpoint).pathname + '.');
      } catch (e) {
        const message = e && e.message ? e.message : 'API request failed.';
        if (/HTTP 401|HTTP 403/i.test(message)) throw new ReadError('PolishTracker rejected the API key. Check Settings → API and replace the saved key.');
        errors.push(message);
      }
    }
    throw new ReadError('PolishTracker account API could not provide Uploaded and Downloaded totals. ' + errors.join(' '));
  }

  function parsePolishTrackerStats(doc, si) {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    const root = doc.querySelector('#root') || doc.body || doc;
    if (!root || typeof root.querySelectorAll !== 'function') return null;

    const pairs = extractPairs(root);
    const text = String(root.innerText || root.textContent || '');
    const textPairs = pairsFromText(text);
    const stats = resolveStats(pairs, si);
    const fallback = resolveStats(textPairs, si);

    ['uploaded', 'downloaded', 'ratio', 'buffer', 'bonus_points', 'required_ratio', 'user_class'].forEach((key) => {
      if ((stats[key] === undefined || stats[key] === null) && fallback[key] !== undefined) {
        stats[key] = fallback[key];
      }
    });

    return Number.isFinite(stats.uploaded) && Number.isFinite(stats.downloaded) ? stats : null;
  }

  async function readPolishTracker(tracker, context) {
    context = context || {};
    const sourceDocument = Object.prototype.hasOwnProperty.call(context, 'document') ? context.document : document;
    const si = !!tracker.si;
    if (sourceDocument) {
      const stats = parsePolishTrackerStats(sourceDocument, si);
      if (stats) {
        return {
          kind: 'profile',
          userId: tracker.userId || '',
          username: tracker.username || '',
          profileUrl: tracker.profileUrl || (context.pageUrl && new URL(context.pageUrl).pathname !== '/' ? context.pageUrl : null),
          stats,
        };
      }
    }
    const apiKey = tracker.apiKey || GM_getValue('sherlock.polishtracker.apiKey', '');
    return readPolishTrackerApi(tracker, apiKey);
  }

  async function readMTeam(tracker, context) {
    context = context || {};
    const origin = context.origin || tracker.origin || ('https://' + tracker.host);
    const token = String(tracker.apiKey || GM_getValue('sherlock.mteam.apiKey', '') || '').trim();
    if (!token) {
      throw new ReadError('M-Team requires an API token. Open Control Panel → Lab on M-Team, create an access token, then paste it into the M-Team API Token field in Sherlock.');
    }

    let apiUrl;
    try {
      apiUrl = mTeamApiOrigin(origin) + '/api/member/profile';
    } catch (e) {
      throw new ReadError('Could not determine the M-Team API host from ' + origin + '.');
    }

    const payload = await new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new ReadError('Userscript manager cross-origin requests are unavailable.'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'POST',
        url: apiUrl,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-api-key': token,
          Origin: new URL(origin).origin,
        },
        data: '{}',
        responseType: 'text',
        timeout: 25000,
        anonymous: false,
        fetch: true,
        cookiePartition: { topLevelSite: new URL(origin).origin },
        onload: (response) => {
          const status = Number(response.status) || 0;
          const raw = typeof response.responseText === 'string'
            ? response.responseText
            : (typeof response.response === 'string' ? response.response : '');
          if (status < 200 || status >= 300) {
            if (status === 401 || status === 403) {
              reject(new ReadError('M-Team rejected the API token (HTTP ' + status + '). Create/check the token in Control Panel → Lab.'));
            } else {
              reject(new ReadError('M-Team API returned HTTP ' + status + ' at /api/member/profile.'));
            }
            return;
          }
          let json = response.response && typeof response.response === 'object' ? response.response : null;
          if (!json) {
            try { json = JSON.parse(raw); }
            catch (e) {
              reject(new ReadError('M-Team API did not return valid JSON. Check the API host and token.'));
              return;
            }
          }
          resolve(json);
        },
        onerror: () => reject(new ReadError('Could not connect to the M-Team API host.')),
        ontimeout: () => reject(new ReadError('M-Team API request timed out.')),
        onabort: () => reject(new ReadError('M-Team API request was cancelled.')),
      });
    });

    const result = mapMTeamProfilePayload(payload);
    if (!result) {
      const message = String(payload && (payload.message || payload.msg) || 'Unknown API response');
      throw new ReadError('M-Team API could not verify the member profile: ' + message +
        '. Confirm that the access token is valid and has profile access.');
    }
    result.profileUrl = new URL('/user/profile', origin).href;
    return result;
  }

  async function readTracker(tracker, context) {
    context = context || {};
    const origin = context.origin || location.origin;
    const request = context.request || fetchText;
    const sourceDocument = Object.prototype.hasOwnProperty.call(context, 'document') ? context.document : document;
    const pageUrl = context.pageUrl || (sourceDocument ? location.href : origin + '/');
    const apiType = trackerApiType(tracker);
    const trackerHost = trackerHostname(tracker.host || tracker.origin || origin);
    const trackerIdentity = trackerDirectoryEntry(tracker.name || tracker.fullName);
    const trackerNameKey = normalizeTrackerDirectoryName(tracker.name || tracker.fullName || '');
    const trackerShortKey = String(tracker.shortName || '').trim().toUpperCase();
    const isPolishTracker = isPolishTrackerHost(trackerHost) ||
      !!(trackerIdentity && trackerIdentity.name === 'PolishTracker') ||
      trackerNameKey === 'polishtracker' || trackerShortKey === 'PT' ||
      isPolishTrackerDocument(sourceDocument);
    const isMTeam = isMTeamHost(trackerHost) ||
      !!(trackerIdentity && trackerIdentity.name === 'M-Team') ||
      trackerNameKey === 'mteam' || trackerShortKey === 'M-TEAM';
    const isKaragarga = isKaragargaHost(trackerHost) ||
      !!(trackerIdentity && trackerIdentity.name === 'Karagarga') ||
      trackerNameKey === 'karagarga' || trackerShortKey === 'KG' ||
      isKaragargaProfileDocument(sourceDocument);
    const isAnimeBytes = trackerHost === 'animebytes.tv' || trackerHost.endsWith('.animebytes.tv') ||
      !!(trackerIdentity && trackerIdentity.name === 'AnimeBytes');
    const isPassThePopcorn = isPassThePopcornTrackerRecord(tracker, sourceDocument);
    const complete = async (result) =>
      attachProfileAddress(await result, tracker, { origin, document: sourceDocument, pageUrl }, request);

    // M-Team mTorrent statistics come from its token-authenticated member API.
    if (isMTeam) return readMTeam(tracker, { origin });

    // PTP uses the authenticated profile/header reader, not the generic Gazelle index adapter.
    if (isPassThePopcorn) return complete(readPassThePopcorn(tracker, { origin, request, document: sourceDocument, pageUrl }));

    // Karagarga uses its authenticated legacy userdetails.php profile.
    if (isKaragarga) return complete(readKaragarga(tracker, { origin, request, document: sourceDocument, pageUrl }));

    // PolishTracker uses ReaperEngine, not Gazelle or UNIT3D.
    if (isPolishTracker) return complete(readPolishTracker(tracker, { origin, request, document: sourceDocument, pageUrl }));

    // AnimeBytes may share generic #userinfo_stats markup with older UNIT3D
    // themes. Its host/identity exception must win before the DOM fallback.
    if (!isAnimeBytes && (apiType === 'unit3d' || (!apiType && hasUnit3DStatsBar(sourceDocument)))) return complete(readUnit3D(tracker, { origin, request, document: sourceDocument, pageUrl }));
    if (apiType === 'digitalcore') return complete(readDigitalCore(tracker, request));
    if (apiType === 'rartracker') return complete(readRartracker(tracker, request));
    if (apiType === 'iptorrents') return complete(readIptorrents(tracker, { origin, request, document: sourceDocument, pageUrl }));
    if (apiType === 'torrentleech' || isTorrentLeechDocument(sourceDocument)) return complete(readTorrentLeech(tracker, { origin, request, document: sourceDocument, pageUrl }));
    if (apiType === 'trancetraffic' || isTranceTrafficDocument(sourceDocument)) return complete(readTranceTraffic(tracker, { origin, request, document: sourceDocument, pageUrl }));
    if (apiType === 'myanonamouse' || isMyAnonamouseDocument(sourceDocument)) return complete(readMyAnonamouse(tracker, { origin, request, document: sourceDocument, pageUrl }));
    if (apiType === 'filelist' || isFileListDocument(sourceDocument)) return complete(readFileList(tracker, { origin, request, document: sourceDocument, pageUrl }));
    if (apiType === 'cinemageddon' || isCinemageddonDocument(sourceDocument)) return complete(readCinemageddon(tracker, { origin, request, document: sourceDocument, pageUrl }));

    const si = !!tracker.si;
    // Old saved AnimeBytes records may already say "gazelle". Still allow the
    // authenticated profile reader after its non-stock /ajax.php endpoint fails.
    const kinds = isAnimeBytes
      ? (tracker.kind === 'profile' ? ['profile'] : ['gazelle', 'profile'])
      // A saved record may retain kind="gazelle" even when its mirror/alias host
      // is not in the directory. Never let that bypass the profile-page fallback.
      : (apiType === 'gazelle' || tracker.kind === 'gazelle'
        ? ['gazelle', 'profile']
        : (tracker.kind === 'profile' ? ['profile'] : ['gazelle', 'profile']));
    let lastError;
    for (const kind of kinds) {
      try {
        if (kind === 'gazelle') return await complete(readGazelle(request));
        const link = await discoverProfile(tracker, request, origin, sourceDocument, pageUrl);
        return await complete(readProfile(link.url, link.text, si, request, origin));
      } catch (e) {
        if (!(e instanceof ReadError)) throw e;
        lastError = e;
      }
    }
    throw lastError || new ReadError('Could not read this tracker.');
  }

  function managerFetchText(url, accept, extraHeaders) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') return reject(new ReadError('Userscript manager requests are unavailable.'));
      let requestUrl;
      try { requestUrl = new URL(url); }
      catch (e) { return reject(new ReadError('The tracker request URL is invalid.')); }
      GM_xmlhttpRequest({
        method: 'GET',
        url: requestUrl.href,
        headers: Object.assign({ Accept: accept || '*/*' }, extraHeaders || {}),
        responseType: 'text',
        timeout: 25000,
        anonymous: false,
        // Tampermonkey 5.6+ may otherwise use the dashboard tab's cookie partition
        // instead of the tracker tab's first-party partition. Violentmonkey ignores
        // these Tampermonkey-specific options and continues with its normal GM request.
        fetch: true,
        cookiePartition: { topLevelSite: requestUrl.origin },
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

    const isPolishTrackerForm = isPolishTrackerHost(tracker.host) ||
      (trackerDirectoryEntry(tracker.name) || {}).name === 'PolishTracker';
    const isMTeamForm = isMTeamHost(tracker.host) ||
      (trackerDirectoryEntry(tracker.name) || {}).name === 'M-Team';
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
      const t = Object.assign({}, tracker, {
        si: refs.si.checked,
        kind: refs.profileUrl.value.trim() ? 'profile' : tracker.kind,
        profileUrl: refs.profileUrl.value.trim() || null,
        apiKey: refs.apiKey ? refs.apiKey.value.trim() :
          (isMTeamForm ? GM_getValue('sherlock.mteam.apiKey', '') : GM_getValue('sherlock.polishtracker.apiKey', '')),
      });
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
    const previewName = h('div', { class: 'preview-name' }, trackerDisplayName(tracker) || HOST);
    const previewUploaded = h('strong', {}, fieldText('bytes', state.stats.uploaded) || 'Not detected yet');
    let shortNameDirectoryLocked = !!trackerDirectoryEntry(tracker.name);
    const updatePreview = () => {
      const enteredName = refs.name.value.trim() || tracker.name || HOST;
      const canonicalName = trackerNameForNewTracker(enteredName, tracker.host || HOST, tracker.origin || location.origin, document);
      const identity = trackerDirectoryEntry(enteredName) || trackerDirectoryEntry(canonicalName);
      if (identity) {
        refs.shortName.value = identity.short;
        refs.shortName.readOnly = true;
        shortNameDirectoryLocked = true;
      } else {
        if (shortNameDirectoryLocked) refs.shortName.value = shortNameOf(canonicalName || enteredName);
        refs.shortName.readOnly = false;
        shortNameDirectoryLocked = false;
      }
      previewName.textContent = refs.shortName.value.trim() || shortNameOf(canonicalName || enteredName) || HOST;
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

        const requestedName = refs.name.value.trim() || tracker.name;
        const canonicalName = trackerNameForNewTracker(requestedName, tracker.host || HOST, tracker.origin || location.origin, document);
        const identity = validateTrackerIdentity(canonicalName, refs.shortName.value);
        const next = Object.assign({}, tracker, {
          name: identity.known ? identity.name : canonicalName,
          shortName: (identity.known ? identity.shortName : (refs.shortName.value.trim() || shortNameOf(canonicalName))).slice(0, 8),
          profileUrl: refs.profileUrl.value.trim() || tracker.profileUrl || null, username, userId: state.userId || username.toLowerCase(),
          si, enabled: true, logo: state.logo, stats,
          kind: state.readOk && state.kind !== 'manual' ? state.kind : 'manual',
        });
        busy = true; submit.disabled = true; submit.textContent = 'Sending…';
        try {
          if (isMTeamForm) {
            const token = refs.apiKey && refs.apiKey.value.trim();
            if (!token) throw new ReadError('M-Team API token is required. Create it in Control Panel → Lab.');
            GM_setValue('sherlock.mteam.apiKey', token);
            next.lastAttempt = 0;
            next.lastError = null;
          } else if (isPolishTrackerForm && refs.apiKey && refs.apiKey.value.trim()) {
            GM_setValue('sherlock.polishtracker.apiKey', refs.apiKey.value.trim());
            // A newly supplied key should bypass this tracker's previous failure cooldown.
            next.lastAttempt = 0;
            next.lastError = null;
          }
          await push(next, { stats });
          next.enabled = !!refs.auto.checked;
          saveTracker(next);
          close();
          toast(trackerDisplayName(next) + ' saved locally. Open your Sherlock dashboard in this browser to see it.', { kind: 'ok', ttl: 9000, actions: store.url ? [{ label: 'Open Sherlock', href: store.url + '/dashboard' }] : [] });
        } catch (e) {
          showNote(e.message, 'err');
          busy = false; submit.disabled = false; submit.textContent = existing ? 'Save and send' : 'Add to Sherlock';
        }
      } }, existing ? 'Save and send' : 'Add to Sherlock');

      const nameField = input('name', 'Canonical tracker name (used for validation)', 'text', tracker.name, { maxlength: 60 });
      // Create both identity fields before attaching listeners. refs.shortName is populated by input().
      const shortNameField = input('shortName', 'Short name / abbreviation', 'text', tracker.shortName, { maxlength: 8 });
      refs.name.addEventListener('input', updatePreview);
      refs.shortName.addEventListener('input', updatePreview);
      refs.f_uploaded.addEventListener('input', updatePreview);
      const fields = h('div', { class: 'panel-fields' },
        note,
        h('div', { class: 'grid' }, nameField, shortNameField),
        h('div', { class: 'row', style: 'border:0;padding:0;flex-wrap:wrap' },
          h('button', { class: 'btn', type: 'button', onclick: () => pickFile.click() }, 'Choose logo'),
          h('button', { class: 'btn', type: 'button', onclick: detectLogoAgain }, 'Use the site icon'),
          pickFile),
        h('div', { class: 'grid' }, input('username', 'Your username', 'text', tracker.username, { maxlength: 64 }),
          h('label', {}, 'Address', h('input', { value: tracker.origin, readonly: true, disabled: true }))),
        input('profileUrl', 'Profile page address (optional)', 'url', tracker.profileUrl || '', { placeholder: tracker.origin + '/users/yourname' }),
        isMTeamForm
          ? input('apiKey', 'M-Team API token (required for automatic updates)', 'password',
              GM_getValue('sherlock.mteam.apiKey', ''),
              { autocomplete: 'new-password', placeholder: 'Paste your token from Control Panel → Lab' })
          : (isPolishTrackerForm
            ? input('apiKey', 'PolishTracker API key (required for automatic dashboard updates)', 'password',
                GM_getValue('sherlock.polishtracker.apiKey', ''),
                { autocomplete: 'new-password', placeholder: 'Paste your key from Settings → API' })
            : null),
        h('div', { class: 'grid' }, fieldInputs),
        h('label', { class: 'check' }, (refs.si = h('input', { type: 'checkbox', checked: tracker.si, onchange: updatePreview })), 'This tracker counts GB and TB as 1000, not 1024'),
        h('label', { class: 'check' }, (refs.auto = h('input', { type: 'checkbox', checked: tracker.enabled !== false })), 'Automatically update while the Sherlock dashboard is open or when I visit this tracker'),
        h('div', { class: 'muted' }, isMTeamForm
          ? 'M-Team API token is stored only in this browser profile and sent only to the M-Team API host for account statistics. Create it in Control Panel → Lab. Do not share it in chat.'
          : (isPolishTrackerForm
            ? 'PolishTracker API key is stored only in this browser profile and is sent only to api.pte.nu for account statistics. Other trackers do not use this key.'
            : 'Saved only in this browser profile. The tracker appears on your Sherlock dashboard in this browser and auto-updates while that dashboard tab is open. No Sherlock API or token is used.')));
      const preview = h('aside', { class: 'tracker-preview' }, logoBox, previewName,
        h('div', { class: 'preview-stat' }, h('small', {}, 'Uploaded data'), previewUploaded));
      const body = h('div', { class: 'body' }, h('div', { class: 'panel-layout' }, preview, fields));

      return h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Add tracker to Sherlock' },
        h('header', {}, h('h2', {}, existing ? 'Edit ' + trackerDisplayName(tracker) : 'Add ' + trackerDisplayName(tracker) + ' to Sherlock'), h('button', { class: 'btn', style: 'margin-left:auto', onclick: close }, '×')),
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

  function recordTrackerHistory(tracker, stats, buffer, now) {
    if (!tracker || !stats) return;
    const uploaded = Number(stats.uploaded);
    const downloaded = Number(stats.downloaded);
    if (!Number.isFinite(uploaded) || uploaded < 0 ||
        !Number.isFinite(downloaded) || downloaded < 0 ||
        !Number.isFinite(Number(buffer))) return;

    const timestamp = Number(now);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return;
    const history = (Array.isArray(tracker.history) ? tracker.history : [])
      .filter((point) => point && Number.isFinite(Number(point.at)) &&
        Number(point.at) > 0 &&
        Number.isFinite(Number(point.uploaded)) && Number(point.uploaded) >= 0 &&
        Number.isFinite(Number(point.downloaded)) && Number(point.downloaded) >= 0 &&
        Number.isFinite(Number(point.buffer)))
      .sort((a, b) => Number(a.at) - Number(b.at));

    const last = history[history.length - 1];
    if (!last || timestamp - Number(last.at) >= 5 * 60 * 1000 || timestamp < Number(last.at)) {
      history.push({ at: timestamp, buffer: Number(buffer), uploaded, downloaded });
    }

    const cutoff = timestamp - 8 * 24 * 60 * 60 * 1000;
    // 576 snapshots = 48 hours at the 5-minute observation cadence.
    tracker.history = history
      .filter((point) => Number(point.at) >= cutoff)
      .slice(-576);
  }

  // Calculate both traffic directions against one interpolated 24-hour boundary.
  // Missing history and counter resets are never converted into fabricated traffic.
  function trackerTraffic24h(tracker) {
    const stats = tracker && tracker.stats || {};
    const currentUploaded = Number(stats.uploaded);
    const currentDownloaded = Number(stats.downloaded);
    const currentAt = Number(tracker && tracker.lastSync);

    if (!Number.isFinite(currentUploaded) || currentUploaded < 0 ||
        !Number.isFinite(currentDownloaded) || currentDownloaded < 0 ||
        !Number.isFinite(currentAt) || currentAt <= 0) return null;

    const cutoff = currentAt - 24 * 60 * 60 * 1000;
    const points = (Array.isArray(tracker && tracker.history) ? tracker.history : [])
      .filter((point) => point &&
        Number.isFinite(Number(point.at)) && Number(point.at) > 0 &&
        Number(point.at) <= currentAt &&
        Number.isFinite(Number(point.uploaded)) && Number(point.uploaded) >= 0 &&
        Number.isFinite(Number(point.downloaded)) && Number(point.downloaded) >= 0)
      .slice()
      .sort((a, b) => Number(a.at) - Number(b.at));

    if (!points.length) return null;

    let before = null;
    let after = null;
    for (const point of points) {
      if (Number(point.at) <= cutoff) before = point;
      else { after = point; break; }
    }
    // If this tracker was first added less than 24 hours ago, there cannot be
    // a snapshot at the 24-hour cutoff yet. Use the first successful observation
    // as its baseline and count every verified increase since then immediately.
    // This reports the observed part of the rolling window instead of waiting a
    // full day and silently dropping the tracker's first hours of traffic.
    if (!before) {
      const firstObserved = points[0];
      if (!firstObserved || Number(firstObserved.at) <= cutoff) return null;
      before = firstObserved;
      after = null;
    }

    const beforeAt = Number(before.at);
    const beforeUploaded = Number(before.uploaded);
    const beforeDownloaded = Number(before.downloaded);
    let baselineUploaded = beforeUploaded;
    let baselineDownloaded = beforeDownloaded;
    let baselineAt = beforeAt;

    if (after) {
      const afterAt = Number(after.at);
      const afterUploaded = Number(after.uploaded);
      const afterDownloaded = Number(after.downloaded);
      const span = afterAt - beforeAt;
      if (span <= 0 || afterUploaded < beforeUploaded || afterDownloaded < beforeDownloaded) return null;

      const progress = Math.max(0, Math.min(1, (cutoff - beforeAt) / span));
      baselineUploaded = beforeUploaded + (afterUploaded - beforeUploaded) * progress;
      baselineDownloaded = beforeDownloaded + (afterDownloaded - beforeDownloaded) * progress;
      baselineAt = cutoff;
    } else if (cutoff - beforeAt > 60 * 60 * 1000) {
      return null;
    }

    if (currentUploaded < baselineUploaded || currentDownloaded < baselineDownloaded) return null;

    const uploaded = currentUploaded - baselineUploaded;
    const downloaded = currentDownloaded - baselineDownloaded;
    return {
      uploaded,
      downloaded,
      buffer: uploaded - downloaded,
      baselineAt,
      currentAt,
      baselineUploaded: Math.round(baselineUploaded),
      baselineDownloaded: Math.round(baselineDownloaded),
      currentUploaded: Math.round(currentUploaded),
      currentDownloaded: Math.round(currentDownloaded),
    };
  }

  function sumTrackerTraffic24h(customTrackers) {
    const trackers = (Array.isArray(customTrackers) ? customTrackers : [])
      .filter((tracker) => tracker && tracker.enabled !== false);
    let uploaded = 0;
    let downloaded = 0;
    let buffer = 0;
    let ready = 0;

    trackers.forEach((tracker) => {
      const traffic = trackerTraffic24h(tracker);
      if (!traffic) return;
      uploaded += traffic.uploaded;
      downloaded += traffic.downloaded;
      buffer += traffic.buffer;
      ready++;
    });

    return { uploaded, downloaded, buffer, ready, total: trackers.length, complete: ready === trackers.length };
  }

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
    // Store both cumulative counters on every valid observation. The 24h net
    // buffer is calculated later from their deltas, never from lifetime totals.
    const hasTrafficTotals =
      Number.isFinite(Number(nextStats.uploaded)) && Number(nextStats.uploaded) >= 0 &&
      Number.isFinite(Number(nextStats.downloaded)) && Number(nextStats.downloaded) >= 0;
    if (hasTrafficTotals) {
      const historyBuffer = Number(nextStats.uploaded) - Number(nextStats.downloaded);
      recordTrackerHistory(t, nextStats, historyBuffer, now);
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
      if (opts.manual) toast(trackerDisplayName(t) + ' updated in this browser and on your local Sherlock dashboard.', { kind: 'ok', ttl: 9000,
        actions: store.url ? [{ label: 'Open dashboard', href: store.url + '/dashboard' }] : [] });
    } catch (e) {
      t.lastError = e.message || 'Could not read tracker statistics.';
      saveTracker(t);
      if (opts.manual) toast(t.lastError, { kind: 'err', title: 'Sherlock: ' + trackerDisplayName(t), ttl: 12000 });
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
          h('label', {}, 'Refresh tracker statistics automatically every … minutes (15 minimum)', interval),
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

  function updateDashboard24hBuffer(customTrackers, nativeTrackers) {
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

    const preferredCards = summarySection
      ? Array.from(summarySection.children).filter((child) => child.classList.contains('card'))
      : [];
    const otherCards = Array.from(main.querySelectorAll('section .card')).filter((candidate) =>
      !candidate.hasAttribute('data-sherlock-custom-host') &&
      !candidate.closest('#sherlock-local-trackers') &&
      !(candidate.matches && candidate.matches('a[href^="/trackers/"]'))
    );
    const cards = Array.from(new Set(preferredCards.concat(otherCards)));
    const card = cards.find((candidate) => {
      const text = (candidate.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return /\bbuffer\b/.test(text) && /(?:last\s*)?24\s*(?:h\b|hours?\b)/.test(text);
    });
    if (!card) return null;

    const customTraffic = sumTrackerTraffic24h(customTrackers);
    const nativeTraffic = sumTrackerTraffic24h(nativeTrackers);
    const totalTrackers = customTraffic.total + nativeTraffic.total;
    const readyTrackers = customTraffic.ready + nativeTraffic.ready;

    // The native Sherlock 24h card can be stale/zero. Recalculate it from the
    // actual per-tracker cumulative Upload and Download snapshots in this browser.
    if (!totalTrackers || !customTraffic.complete || !nativeTraffic.complete) {
      const valueNode = card.querySelector('.num');
      if (valueNode) {
        // Avoid leaving Sherlock's old/stale 0 B value visible while the new
        // local 24-hour history window is still being collected.
        valueNode.textContent = 'Collecting';
        valueNode.dataset.sherlock24hCoverage = readyTrackers + '/' + totalTrackers;
        valueNode.title = 'Collecting 24-hour upload/download history: ' +
          readyTrackers + '/' + totalTrackers + ' trackers have a complete window.';
      }
      return null;
    }

    const uploaded = customTraffic.uploaded + nativeTraffic.uploaded;
    const downloaded = customTraffic.downloaded + nativeTraffic.downloaded;
    const buffer = uploaded - downloaded;
    writeDashboardMetric(card, buffer);

    const valueNode = card.querySelector('.num');
    if (valueNode) {
      valueNode.dataset.sherlock24hUploaded = String(Math.round(uploaded));
      valueNode.dataset.sherlock24hDownloaded = String(Math.round(downloaded));
      valueNode.dataset.sherlock24hCoverage = readyTrackers + '/' + totalTrackers;
      valueNode.setAttribute('aria-label',
        '24-hour buffer: ' + localBytes(uploaded) + ' uploaded minus ' +
        localBytes(downloaded) + ' downloaded across ' + totalTrackers + ' trackers');
      valueNode.title = '24h Upload: ' + localBytes(uploaded) +
        ' · 24h Download: ' + localBytes(downloaded) +
        ' · Net Buffer: ' + signedBytes(buffer) +
        ' · Coverage: ' + readyTrackers + '/' + totalTrackers + ' trackers';
    }
    return { uploaded, downloaded, buffer, ready: readyTrackers, total: totalTrackers, complete: true };
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

  const nativeTrafficCache = new Map();
  let nativeTrafficCacheAt = 0;
  let nativeTrafficFetchPromise = null;
  const NATIVE_HISTORY_KEY = 'sherlock.native.tracker.history.v1';

  function getNativeTrackerHistoryStore() {
    try {
      const value = JSON.parse(GM_getValue(NATIVE_HISTORY_KEY, '{}')) || {};
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (e) {
      return {};
    }
  }

  function recordNativeTrackerObservations(rows) {
    const all = getNativeTrackerHistoryStore();
    const now = Date.now();
    const cutoff = now - 8 * 24 * 60 * 60 * 1000;
    let changed = false;

    (Array.isArray(rows) ? rows : []).forEach((row) => {
      if (!row || !row.key ||
          !Number.isFinite(Number(row.uploaded)) || Number(row.uploaded) < 0 ||
          !Number.isFinite(Number(row.downloaded)) || Number(row.downloaded) < 0 ||
          !Number.isFinite(Number(row.at)) || Number(row.at) <= 0) return;

      const history = (Array.isArray(all[row.key]) ? all[row.key] : [])
        .filter((point) => point &&
          Number.isFinite(Number(point.at)) && Number(point.at) > 0 &&
          Number.isFinite(Number(point.uploaded)) && Number(point.uploaded) >= 0 &&
          Number.isFinite(Number(point.downloaded)) && Number(point.downloaded) >= 0)
        .sort((a, b) => Number(a.at) - Number(b.at));
      const last = history[history.length - 1];

      if (!last || Number(row.at) - Number(last.at) >= 5 * 60 * 1000 || Number(row.at) < Number(last.at)) {
        history.push({
          at: Number(row.at),
          uploaded: Number(row.uploaded),
          downloaded: Number(row.downloaded),
          buffer: Number(row.uploaded) - Number(row.downloaded),
        });
        changed = true;
      }

      all[row.key] = history.filter((point) => Number(point.at) >= cutoff).slice(-576);
    });

    // Remove old tracker entries so this GM store remains bounded.
    Object.keys(all).forEach((key) => {
      const history = all[key];
      if (!Array.isArray(history) || !history.length ||
          Number(history[history.length - 1].at) < cutoff) {
        delete all[key];
        changed = true;
      }
    });

    if (changed) GM_setValue(NATIVE_HISTORY_KEY, JSON.stringify(all));
    return all;
  }

  function nativeTrackerHistoryRecords(rows) {
    const all = getNativeTrackerHistoryStore();
    const now = Date.now();
    return (Array.isArray(rows) ? rows : []).map((row) => {
      const history = row && row.key && Array.isArray(all[row.key]) ? all[row.key] : [];
      const last = history.length ? history[history.length - 1] : null;
      // Keep failed/unreadable official trackers in the denominator. A partial
      // aggregate must never be presented as the complete dashboard total.
      if (!last || now - Number(last.at) > 60 * 60 * 1000) {
        return { enabled: true, stats: {}, history: [], lastSync: 0 };
      }
      return {
        enabled: true,
        stats: { uploaded: Number(last.uploaded), downloaded: Number(last.downloaded) },
        history,
        lastSync: Number(last.at),
      };
    });
  }

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
    dl.classList.remove('grid-cols-3', 'grid-cols-4');
    const columnCount = Math.max(3, Math.min(4, dl.children.length));
    dl.classList.add('grid-cols-' + columnCount, 'w-full');

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

  function removeNativePerTracker24hField(dl) {
    if (!dl) return 0;
    let removed = 0;
    Array.from(dl.children).forEach((field) => {
      const label = field.querySelector('dt');
      const text = String(label && label.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^(?:24\s*h(?:\s*(?:dl|download(?:ed)?|upload(?:ed)?|buffer))?|last\s*24\s*hours?|24\s*hours?)$/i.test(text)) {
        field.remove();
        removed++;
      }
    });
    return removed;
  }

  function ensureNativeDownloadedField(card) {
    const dl = card && card.querySelector('dl');
    if (!dl) return null;
    removeNativeTrackerFooter(card, dl);
    removeNativePerTracker24hField(dl);
    // Keep native cards aligned to the same three metrics as custom cards.
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

  async function fetchNativeTrackerTraffic(card) {
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
      if (stats.uploaded === undefined || stats.downloaded === undefined) {
        stats = Object.assign(stats, resolveStats(pairsFromText(plainText(doc)), false));
      }
      const uploaded = stats.uploaded;
      const downloaded = stats.downloaded;
      if (!Number.isFinite(uploaded) || uploaded < 0 ||
          !Number.isFinite(downloaded) || downloaded < 0) return null;
      return { uploaded, downloaded };
    } catch (e) {
      return null;
    }
  }

  async function readNativeTrackerTraffic(cards) {
    const list = Array.isArray(cards) ? cards : [];
    const keys = list.map((card) => card.getAttribute('href') || '');
    const cacheFresh = Date.now() - nativeTrafficCacheAt < 5 * 60 * 1000;
    const allCached = keys.every((key) => key && nativeTrafficCache.has(key));

    if (!cacheFresh || !allCached) {
      if (!nativeTrafficFetchPromise) {
        nativeTrafficFetchPromise = (async () => {
          const values = await Promise.all(list.map((card) => fetchNativeTrackerTraffic(card)));
          const sampledAt = Date.now();
          keys.forEach((key, index) => {
            if (key) {
              const value = values[index];
              nativeTrafficCache.set(key, value
                ? { uploaded: value.uploaded, downloaded: value.downloaded, at: sampledAt }
                : null);
            }
          });
          nativeTrafficCacheAt = sampledAt;
        })().finally(() => {
          nativeTrafficFetchPromise = null;
        });
      }
      await nativeTrafficFetchPromise;
    }

    return list.map((card) => {
      const key = card.getAttribute('href') || '';
      const value = nativeTrafficCache.get(key);
      return {
        card,
        key,
        uploaded: value ? value.uploaded : null,
        downloaded: value ? value.downloaded : null,
        at: value ? value.at : null,
      };
    });
  }

  async function refreshDownloadedMetrics(customTrackers) {
    const dashboardMain = document.querySelector('main') || document.querySelector('#main') || document.body;
    const nativeCards = Array.from(dashboardMain.querySelectorAll('a.card[href^="/trackers/"]'))
      .filter((card) => !card.hasAttribute('data-sherlock-custom-host'));
    nativeCards.forEach((card) => {
      card.classList.add('h-full', 'min-w-0');
      ensureNativeDownloadedField(card);
    });

    const rows = await readNativeTrackerTraffic(nativeCards);
    if (!document.body.contains(dashboardMain) ||
        (location.pathname !== '/dashboard' && location.pathname !== '/dashboard/')) return;

    // Persist independent cumulative Upload/Download observations for native
    // Sherlock trackers, just as we already do for browser-local custom trackers.
    recordNativeTrackerObservations(rows);
    rows.forEach(({ card, downloaded }) => {
      const value = ensureNativeDownloadedField(card);
      setMetricNodeBytes(value, downloaded);
    });

    const totalCard = dashboardMain.querySelector('[data-sherlock-total-downloaded]');
    const totalValue = totalCard && totalCard.querySelector('.num');
    const total = sumVerifiedDownloads(rows, customTrackers);
    setMetricNodeBytes(totalValue, total);

    const nativeTrackers = nativeTrackerHistoryRecords(rows);
    updateDashboard24hBuffer(customTrackers, nativeTrackers);
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
          title: trackerDisplayName(tracker),
          'data-sherlock-custom-nav-host': tracker.host,
        },
          logo,
          h('span', {
            class: 'flex-1 truncate',
          }, trackerDisplayName(tracker)),
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
    // Three metrics only: Buffer, Ratio and Downloaded; Uploaded remains in the sidebar above.
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

      const updatedLabel = tracker.lastSync
        ? 'Last successful update: ' + new Date(Number(tracker.lastSync)).toLocaleString()
        : 'No successful update yet';
      const lastAttemptLabel = tracker.lastAttempt
        ? 'Last attempt: ' + new Date(Number(tracker.lastAttempt)).toLocaleString()
        : 'Not attempted yet';
      const errorText = tracker.lastError ? String(tracker.lastError) : '';
      const status = tracker.lastError
        ? h('span', { class: 'tag-down', title: errorText }, 'Error')
        : h('span', { class: 'tag-up', title: updatedLabel }, tracker.lastSync ? 'OK' : 'Waiting');

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
            title: trackerDisplayName(tracker),
          }, trackerDisplayName(tracker)),
          status
        ),
        h('p', {
          class: 'mt-1 text-xs text-muted truncate',
          title: errorText || updatedLabel + ' · ' + lastAttemptLabel,
        }, errorText ? 'Update failed: ' + errorText : (tracker.lastSync ? updatedLabel : lastAttemptLabel)),
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
      title: 'Add ' + shortNameOf(name) + ' to Sherlock?',
      ttl: 12000,
      actions: [{ label: 'Add tracker', onClick: () => openTrackerPanel(null), primary: true }],
    });
  }

  function looksLikeTracker() {
    if (isMTeamHost(PAGE_HOST)) {
      if (document.querySelector('input[type="password"]') ||
          /\/(?:login|signin|auth)(?:\/|$)/i.test(location.pathname)) return false;
      // The mTorrent frontend is a SPA; it does not expose classic NexusPHP
      // userdetails.php markup for the generic profile detector.
      return /m-team|mtorrent/i.test(String(document.title || '') + ' ' +
        String((document.body && document.body.innerText) || '').slice(0, 3000)) ||
        !!document.querySelector('a[href*="/user/profile"], [class*="user-avatar"], [class*="user-menu"]');
    }

    if (isKaragargaHost(PAGE_HOST) || isKaragargaProfileDocument(document)) {
      if (document.querySelector('input[type="password"]')) return false;
      const authenticatedProfile = isKaragargaProfileDocument(document);
      const ownProfileLink = !!findKaragargaProfileLink(document, location.href, location.origin);
      if (!authenticatedProfile && !ownProfileLink) return false;
      const versionKey = 'sherlock.karagarga.autodetect.version.' + PAGE_HOST;
      if (GM_getValue(versionKey, '') !== VERSION) {
        GM_setValue(versionKey, VERSION);
        GM_setValue('sherlock.autoadd.attempt.' + PAGE_HOST, 0);
        GM_setValue('sherlock.autoadd.failures.' + PAGE_HOST, 0);
        GM_setValue('sherlock.autoadd.lock.' + PAGE_HOST, 0);
      }
      return true;
    }

    if (isTorrentLeechDocument(document)) {
      if (document.querySelector('input[type="password"]')) return false;
      const versionKey = 'sherlock.torrentleech.autodetect.version.' + PAGE_HOST;
      if (GM_getValue(versionKey, '') !== VERSION) {
        GM_setValue(versionKey, VERSION);
        GM_setValue('sherlock.autoadd.attempt.' + PAGE_HOST, 0);
        GM_setValue('sherlock.autoadd.failures.' + PAGE_HOST, 0);
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
        GM_setValue('sherlock.autoadd.failures.' + PAGE_HOST, 0);
      }
      return true;
    }
    if (isFileListDocument(document)) {
      if (document.querySelector('input[type="password"]')) return false;
      const versionKey = 'sherlock.filelist.autodetect.version.' + PAGE_HOST;
      if (GM_getValue(versionKey, '') !== VERSION) {
        GM_setValue(versionKey, VERSION);
        GM_setValue('sherlock.autoadd.attempt.' + PAGE_HOST, 0);
        GM_setValue('sherlock.autoadd.failures.' + PAGE_HOST, 0);
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
        GM_setValue('sherlock.autoadd.failures.' + PAGE_HOST, 0);
      }
      return true;
    }
    if (isPolishTrackerHost(PAGE_HOST) || isPolishTrackerDocument(document)) {
      if (document.querySelector('input[type="password"]') ||
          /\/(?:login|signin|auth)(?:\/|$)/i.test(location.pathname)) return false;
      const versionKey = 'sherlock.polishtracker.autodetect.version.' + PAGE_HOST;
      if (GM_getValue(versionKey, '') !== VERSION) {
        GM_setValue(versionKey, VERSION);
        GM_setValue('sherlock.autoadd.attempt.' + PAGE_HOST, 0);
        GM_setValue('sherlock.autoadd.failures.' + PAGE_HOST, 0);
        GM_setValue('sherlock.autoadd.lock.' + PAGE_HOST, 0);
      }
      return !!GM_getValue('sherlock.polishtracker.apiKey', '') || !!parsePolishTrackerStats(document, false);
    }

    const isAnimeBytesHost = HOST === 'animebytes.tv' || HOST.endsWith('.animebytes.tv');
    if (isAnimeBytesHost) {
      const loginPath = /\/(?:login|signin)(?:\.php|\/|$)/i.test(location.pathname);
      const profileLink = findProfileLink(document, location.href, location.origin);
      const statsBar = document.querySelector('#userinfo_stats, #userinfo, #userinfo_username');
      const statsText = String((statsBar && statsBar.textContent) || '');
      const pageText = String((document.body && document.body.innerText) || '').slice(0, 6000);
      const hasVisibleAccountStats =
        (/\b(upload(?:ed)?|up)\b\s*[:：]?\s*\d[\d.,]*\s*[KMGTP]i?B/i.test(statsText) &&
         /\b(download(?:ed)?|down)\b\s*[:：]?\s*\d[\d.,]*\s*[KMGTP]i?B/i.test(statsText)) ||
        (/\b(upload(?:ed)?|up)\b\s*[:：]?\s*\d[\d.,]*\s*[KMGTP]i?B/i.test(pageText) &&
         /\b(download(?:ed)?|down)\b\s*[:：]?\s*\d[\d.,]*\s*[KMGTP]i?B/i.test(pageText));
      const authenticatedPage = !loginPath && (!!profileLink || hasVisibleAccountStats);
      if (authenticatedPage) {
        const versionKey = 'sherlock.animebytes.autodetect.version.' + PAGE_HOST;
        if (GM_getValue(versionKey, '') !== VERSION) {
          GM_setValue(versionKey, VERSION);
          GM_setValue('sherlock.autoadd.attempt.' + PAGE_HOST, 0);
          GM_setValue('sherlock.autoadd.failures.' + PAGE_HOST, 0);
          GM_setValue('sherlock.autoadd.lock.' + PAGE_HOST, 0);
        }
      }
      return authenticatedPage;
    }

    const detectedApiType = trackerApiType({ host: HOST, origin: location.origin });
    if (detectedApiType === 'unit3d') {
      const versionKey = 'sherlock.cinematik.autodetect.version.' + PAGE_HOST;
      if (GM_getValue(versionKey, '') !== VERSION) {
        GM_setValue(versionKey, VERSION);
        GM_setValue('sherlock.autoadd.attempt.' + PAGE_HOST, 0);
        GM_setValue('sherlock.autoadd.failures.' + PAGE_HOST, 0);
      }
      return hasUnit3DStatsBar(document) && !document.querySelector('input[type="password"]');
    }
    if (detectedApiType) {
      // Upgrade migration clears stale cooldowns for API-based adapters, including DigitalCore.
      const versionKey = 'sherlock.autodetect.version.' + PAGE_HOST;
      if (GM_getValue(versionKey, '') !== VERSION) {
        GM_setValue(versionKey, VERSION);
        GM_setValue('sherlock.autoadd.attempt.' + PAGE_HOST, 0);
        GM_setValue('sherlock.autoadd.failures.' + PAGE_HOST, 0);
      }
      return !document.querySelector('input[type="password"]');
    }
    if (hasUnit3DStatsBar(document)) {
      const versionKey = 'sherlock.unit3d.autodetect.version.' + PAGE_HOST;
      if (GM_getValue(versionKey, '') !== VERSION) {
        GM_setValue(versionKey, VERSION);
        GM_setValue('sherlock.autoadd.attempt.' + PAGE_HOST, 0);
        GM_setValue('sherlock.autoadd.failures.' + PAGE_HOST, 0);
      }
      return !document.querySelector('input[type="password"]');
    }
    const head = ((document.body && document.body.innerText) || '').slice(0, 6000);
    return /\b(upload(ed)?|up)\b\s*[:：]?\s*\d[\d.,]*\s*[KMGTP]i?B/i.test(head) && /\b(download(ed)?|down)\b\s*[:：]?\s*\d[\d.,]*\s*[KMGTP]i?B/i.test(head);
  }

  let menusRegistered = false;
  function registerMenus() {
    if (menusRegistered) return;
    menusRegistered = true;
    GM_registerMenuCommand('Sherlock: Add this tracker', () => {
      if (isSherlockDashboardPage()) return toast('Open the tracker website first, then choose Add this tracker.', { kind: 'err' });
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
      if (!window.confirm('Remove ' + trackerDisplayName(t) + ' from this browser’s custom trackers?')) return;
      delete all[HOST]; store.trackers = all;
      // Permit immediate re-detection after explicit removal.
      GM_setValue('sherlock.autoadd.attempt.' + PAGE_HOST, 0);
      GM_setValue('sherlock.autoadd.failures.' + PAGE_HOST, 0);
      GM_setValue('sherlock.autoadd.lock.' + PAGE_HOST, 0);
      if (isSherlockDashboardPage()) renderLocalDashboard();
      toast(trackerDisplayName(t) + ' removed from this browser.', { kind: 'ok' });
    });
    GM_registerMenuCommand('Sherlock: Settings', openSettings);
  }

  function autoAddRetryDelay(failures) {
    const count = Math.max(0, Math.floor(Number(failures) || 0));
    return count > 0
      ? Math.min(6 * 60 * 60 * 1000, 30 * 60 * 1000 * Math.pow(2, count - 1))
      : 30 * 60 * 1000;
  }

  async function autoAddTracker() {
    const attemptHost = PAGE_HOST;
    if (isMTeamHost(attemptHost) && !String(GM_getValue('sherlock.mteam.apiKey', '') || '').trim()) {
      const promptKey = 'sherlock.mteam.token-prompt.' + attemptHost;
      const lastPrompt = Number(GM_getValue(promptKey, 0)) || 0;
      if (Date.now() - lastPrompt > 6 * 60 * 60 * 1000) {
        GM_setValue(promptKey, Date.now());
        toast('M-Team uses a token-authenticated mTorrent API. Add your token from Control Panel → Lab to finish automatic setup.', {
          kind: 'err', title: 'M-Team needs an API token', ttl: 15000,
        });
        openTrackerPanel(null);
      }
      return;
    }
    const cooldownKey = 'sherlock.autoadd.attempt.' + attemptHost;
    const failuresKey = 'sherlock.autoadd.failures.' + attemptHost;
    const lockKey = 'sherlock.autoadd.lock.' + attemptHost;
    const now = Date.now();
    const failures = Math.max(0, Math.floor(Number(GM_getValue(failuresKey, 0)) || 0));
    if (now - Number(GM_getValue(cooldownKey, 0)) < autoAddRetryDelay(failures)) return;
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
      GM_setValue(failuresKey, 0);
      toast(trackerDisplayName(tracker) + ' was detected and added automatically.', {
        kind: 'ok', ttl: 10000,
        actions: store.url ? [{ label: 'Open Sherlock dashboard', href: store.url + '/dashboard' }] : [],
      });
    } catch (e) {
      // Keep the failed-attempt timestamp and increase the next retry delay exponentially.
      GM_setValue(failuresKey, Math.min(8, failures + 1));
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

  async function dashboardAutoSync(force = false) {
    if (dashboardSyncRunning || !isSherlockDashboardPage()) return;
    dashboardSyncRunning = true;
    try {
      const now = Date.now();
      const due = Object.values(store.trackers)
        .filter((tracker) => tracker && tracker.host && tracker.enabled !== false)
        .filter((tracker) => now - Number(tracker.lastAttempt || 0) >= 10 * 60000)
        .filter((tracker) => force || now - Number(tracker.lastSync || 0) >= store.interval * 60000)
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
    // Refresh immediately on dashboard entry, unless the tracker was attempted in the last 10 minutes.
    dashboardAutoSync(true);
    dashboardSyncTimer = window.setInterval(() => {
      if (!isSherlockDashboardPage()) {
        window.clearInterval(dashboardSyncTimer);
        dashboardSyncTimer = null;
        return;
      }
      dashboardAutoSync();
    }, 60000);
  }

  function migrateLegacyPtpGazelleError() {
    const migrationKey = 'sherlock.ptp.gazelle-error-migration';
    if (GM_getValue(migrationKey, '') === VERSION) return false;
    const all = store.trackers;
    let changed = false;
    Object.values(all).forEach((tracker) => {
      if (!tracker || !isPassThePopcornTrackerRecord(tracker)) return;
      if (!/Not a Gazelle tracker/i.test(String(tracker.lastError || ''))) return;
      tracker.lastError = null;
      tracker.lastAttempt = 0;
      tracker.lastOutcome = 'retry-queued';
      changed = true;
    });
    if (changed) store.trackers = all;
    GM_setValue(migrationKey, VERSION);
    return changed;
  }

  let polishTrackerObserver = null;
  let polishTrackerObserverTimer = null;

  function startPolishTrackerAutoDetectObserver() {
    if (!isPolishTrackerHost(PAGE_HOST) && !isPolishTrackerDocument(document)) return;
    if (polishTrackerObserver || typeof MutationObserver !== 'function' || !document.documentElement) return;
    polishTrackerObserver = new MutationObserver(() => {
      if (store.trackers[HOST] || store.dismissed[HOST]) {
        polishTrackerObserver.disconnect();
        polishTrackerObserver = null;
        if (polishTrackerObserverTimer) clearTimeout(polishTrackerObserverTimer);
        return;
      }
      if (polishTrackerObserverTimer) clearTimeout(polishTrackerObserverTimer);
      polishTrackerObserverTimer = setTimeout(() => {
        polishTrackerObserverTimer = null;
        if (looksLikeTracker()) {
          polishTrackerObserver.disconnect();
          polishTrackerObserver = null;
          autoAddTracker();
        }
      }, 350);
    });
    polishTrackerObserver.observe(document.documentElement, { childList: true, subtree: true });
    window.setTimeout(() => {
      if (polishTrackerObserver) { polishTrackerObserver.disconnect(); polishTrackerObserver = null; }
      if (polishTrackerObserverTimer) { clearTimeout(polishTrackerObserverTimer); polishTrackerObserverTimer = null; }
    }, 30000);
  }

  function migratePolishTrackerReactShellError() {
    const key = 'sherlock.polishtracker.react-shell-migration';
    if (GM_getValue(key, '') === VERSION) return false;
    const all = store.trackers;
    let changed = false;
    Object.values(all).forEach((tracker) => {
      if (!tracker) return;
      const identity = trackerDirectoryEntry(tracker.name || tracker.fullName);
      const host = trackerHostname(tracker.host || tracker.origin);
      const isPte = host === 'pte.nu' || host.endsWith('.pte.nu') ||
        !!(identity && identity.name === 'PolishTracker') ||
        String(tracker.shortName || '').toUpperCase() === 'PT';
      if (!isPte || !/PolishTracker is a React application|HTML shell contains no account stats/i.test(String(tracker.lastError || ''))) return;
      tracker.lastError = null;
      tracker.lastAttempt = 0;
      tracker.lastOutcome = 'retry-queued';
      changed = true;
    });
    if (changed) store.trackers = all;
    GM_setValue(key, VERSION);
    return changed;
  }

  function main() {
    registerMenus();
    const isDashboard = isSherlockDashboardPage();
    if (isDashboard) {
      migrateLegacyPtpGazelleError();
      migratePolishTrackerReactShellError();
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
    startPolishTrackerAutoDetectObserver();
  }

  main();
  // Sherlock uses Turbo navigation; refresh automatically when the dashboard tab becomes active again.
  document.addEventListener('turbo:load', main);
  document.addEventListener('turbo:render', main);
  window.addEventListener('pageshow', main);
  window.addEventListener('focus', () => {
    if (isSherlockDashboardPage()) dashboardAutoSync(true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isSherlockDashboardPage()) dashboardAutoSync(true);
  });

})();
