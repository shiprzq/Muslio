/**
 * kb.js — Muslio's local Islamic knowledge base engine.
 *
 * Data (built by scripts/build-data.py):
 *   data/quran/meta.json + ar|en/<n>.json
 *   data/hadith/<book>.json + index.json + search.json
 *
 * Everything lazy-loads and is cached; on a small-RAM host only what is
 * actually used is parsed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const BOOK_IDS = ['bukhari', 'muslim', 'abudawud', 'tirmidhi', 'nasai', 'ibnmajah', 'malik', 'nawawi', 'qudsi', 'dehlawi'];
const BOOK_TITLES = {
  bukhari: 'Sahih al-Bukhari',
  muslim: 'Sahih Muslim',
  abudawud: 'Sunan Abi Dawud',
  tirmidhi: "Jami' at-Tirmidhi",
  nasai: "Sunan an-Nasa'i",
  ibnmajah: 'Sunan Ibn Majah',
  malik: "Muwatta Malik",
  nawawi: 'Forty Hadith of an-Nawawi',
  qudsi: 'Forty Hadith Qudsi',
  dehlawi: 'Forty Hadith of Shah Waliullah Dehlawi',
};

/* ------------------------------------------------------------------ */
/* small cache                                                          */
/* ------------------------------------------------------------------ */
const cache = new Map();
function loadJson(file) {
  if (!cache.has(file)) {
    cache.set(file, JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return cache.get(file);
}

/* ------------------------------------------------------------------ */
/* Arabic / text normalization + scoring                                */
/* ------------------------------------------------------------------ */
function normalizeArabic(s) {
  return (s || '')
    .replace(/[ً-ٰٟۖ-ۭ]/g, '') // harakat & quranic annotation marks
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ؤئ]/g, (c) => (c === 'ؤ' ? 'و' : 'ي'))
    .replace(/ء/g, '')
    .replace(/ـ/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(
  ('a an the of to in on at for and or is are was were be been being it its this that these those ' +
    'with from by as you your he his she her we our they their i me my mine not no do does did done ' +
    'what which who whom whose when where why how all any can will would shall should may might must ' +
    'about into over under after before between through during above below up down out off again more ' +
    'most some such only own same so than too very s t can will just don should now tell give me ' +
    'allah prophet muhammad ﷺ said says say narrated narration hadith hadiths quran verse surah ' +
    'chapter book messenger messenger\'s lord').split(' ')
);

function tokenizeEn(s) {
  return (s || '').toLowerCase().match(/[a-z0-9']+/g) || [];
}
function tokenizeAr(s) {
  return normalizeArabic(s).match(/[؀-ۿ]+/g) || [];
}

function scoreText(text, enTerms, arTerms) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  let hits = 0;
  for (const t of enTerms) {
    if (!t) continue;
    const stop = STOPWORDS.has(t);
    let idx = lower.indexOf(t);
    let count = 0;
    while (idx !== -1 && count < 8) {
      count++;
      idx = lower.indexOf(t, idx + t.length);
    }
    if (count) {
      hits++;
      score += count * (stop ? 0.15 : 1.4);
    }
  }
  if (arTerms.length) {
    const norm = normalizeArabic(text);
    for (const t of arTerms) {
      let idx = norm.indexOf(t);
      let count = 0;
      while (idx !== -1 && count < 8) {
        count++;
        idx = norm.indexOf(t, idx + t.length);
      }
      if (count) {
        hits++;
        score += count * 2;
      }
    }
  }
  return { score, hits };
}

function makeSnippet(text, terms, radius = 110) {
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    if (t && !STOPWORDS.has(t)) {
      const i = lower.indexOf(t);
      if (i !== -1) { pos = i; break; }
    }
  }
  if (pos === -1) return text.slice(0, radius * 2) + (text.length > radius * 2 ? '…' : '');
  const start = Math.max(0, pos - radius);
  const end = Math.min(text.length, pos + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

/* ------------------------------------------------------------------ */
/* Quran                                                                */
/* ------------------------------------------------------------------ */
let quranDocs = null;
let surahNameMap = null;

function quranMeta() {
  return loadJson(path.join(DATA, 'quran', 'meta.json'));
}

function buildSurahMap() {
  if (surahNameMap) return surahNameMap;
  const meta = quranMeta();
  surahNameMap = new Map();
  const norm = (s) => (s || '').toLowerCase().replace(/['’`-]/g, '').replace(/\s+/g, ' ').trim();
  for (const m of meta) {
    surahNameMap.set(String(m.n), m.n);
    surahNameMap.set(norm(m.en), m.n);
    surahNameMap.set(norm(m.tr), m.n);
    surahNameMap.set(norm(m.ar), m.n);
    // common variants
    const variants = {
      2: ['baqara', 'baqarah', 'the cow'],
      3: ['imran', 'aal imran', 'ali imran', 'the family of imran'],
      4: ['nisa', 'an nisa', 'women'],
      5: ['maidah', 'maida', 'the table spread'],
      6: ['anam', "al an'am"],
      7: ['araf', "a'raf"],
      9: ['tawba', 'tawbah', 'tauba', 'repentance'],
      10: ['yunus', 'jonah'],
      12: ['yusuf', 'joseph'],
      13: ['rad', "ra'd"],
      14: ['ibrahim', 'abraham'],
      16: ['nahl', 'the bee'],
      17: ['isra', 'bani israel', 'the night journey'],
      18: ['kahf', 'the cave'],
      19: ['maryam', 'mary'],
      20: ['taha', 'ta ha'],
      21: ['anbiya', 'the prophets'],
      22: ['hajj', 'the pilgrimage'],
      23: ['muminun', 'the believers'],
      24: ['nur', 'light'],
      25: ['furqan', 'the criterion'],
      33: ['ahzab', 'the clans', 'confederates'],
      35: ['fatir', 'originator'],
      36: ['ya sin', 'yasin', 'yaseen'],
      40: ['ghafir', 'forgiver'],
      41: ['fussilat', 'explained in detail'],
      48: ['fath', 'the victory'],
      49: ['hujurat', 'the rooms'],
      55: ['rahman', 'the entirely merciful'],
      56: ['waqiah', 'the inevitable'],
      59: ['hashr', 'the gathering'],
      62: ['jumuah', 'friday'],
      67: ['mulk', 'the sovereignty', 'kingdom'],
      72: ['jinn'],
      73: ['muzzammil', 'muzzammil'],
      74: ['muddaththir'],
      76: ['insan', 'ad dahr', 'man'],
      78: ['naba', 'the tidings'],
      87: ['ala', 'the most high'],
      93: ['duha', 'the morning hours'],
      94: ['sharh', 'inshirah', 'relief'],
      97: ['qadr', 'power'],
      99: ['zalzalah', 'zalzala', 'the earthquake'],
      100: ['adiyat'],
      101: ['qariah', 'the striking hour'],
      102: ['takathur'],
      103: ['asr', 'time'],
      108: ['kawthar', 'kauthar', 'abundance'],
      109: ['kafirun', 'disbelievers'],
      110: ['nasr', 'divine support'],
      111: ['masad', 'palm fiber'],
      112: ['ikhlas', 'sincerity', 'al ikhlas'],
      113: ['falaq', 'the daybreak'],
      114: ['nas', 'mankind'],
    };
    for (const v of variants[m.n] || []) surahNameMap.set(norm(v), m.n);
  }
  return surahNameMap;
}

function resolveSurah(q) {
  const map = buildSurahMap();
  if (q == null) return null;
  const norm = (s) => String(s).toLowerCase().replace(/['’`-]/g, '').replace(/^(surah|surat|sura|chapter)\s+/, '').replace(/\s+/g, ' ').trim();
  const key = norm(q);
  if (map.has(key)) return map.get(key);
  const asNum = parseInt(q, 10);
  if (!Number.isNaN(asNum) && asNum >= 1 && asNum <= 114) return asNum;
  // partial / contains match
  for (const [name, n] of map) {
    if (name.length > 3 && (name.includes(key) || key.includes(name))) return n;
  }
  return null;
}

function getSurah(ref) {
  const n = resolveSurah(ref);
  if (!n) return null;
  const meta = quranMeta().find((m) => m.n === n);
  return {
    meta,
    ar: loadJson(path.join(DATA, 'quran', 'ar', `${n}.json`)),
    en: loadJson(path.join(DATA, 'quran', 'en', `${n}.json`)),
  };
}

function getVerse(ref, ayahRaw) {
  const n = resolveSurah(ref);
  if (!n) return { error: `Could not find surah "${ref}".` };
  const a = parseInt(ayahRaw, 10);
  const s = getSurah(n);
  if (!Number.isInteger(a) || a < 1 || a > s.meta.ay) {
    return { error: `${s.meta.en} has ${s.meta.ay} verses; verse ${ayahRaw} does not exist.` };
  }
  return {
    surah: n,
    surahName: s.meta.en,
    surahAr: s.meta.ar,
    ayah: a,
    arabic: s.ar[a - 1],
    translation: s.en[a - 1],
  };
}

function ensureQuranDocs() {
  if (quranDocs) return quranDocs;
  quranDocs = [];
  for (const m of quranMeta()) {
    const ar = loadJson(path.join(DATA, 'quran', 'ar', `${m.n}.json`));
    const en = loadJson(path.join(DATA, 'quran', 'en', `${m.n}.json`));
    ar.forEach((t, i) => {
      quranDocs.push({ s: m.n, a: i + 1, ar: t, en: en[i], name: m.en });
    });
  }
  return quranDocs;
}

function searchQuran(query, limit = 8) {
  const enTerms = tokenizeEn(query).filter((t) => !STOPWORDS.has(t));
  const arTerms = tokenizeAr(query);
  if (!enTerms.length && !arTerms.length) return [];
  const docs = ensureQuranDocs();
  const phrase = query.replace(/['’`]/g, '').toLowerCase().trim();
  const arPhrase = normalizeArabic(query);
  const ranked = [];
  for (const d of docs) {
    const r = scoreText(d.en + ' ' + d.name, enTerms, []);
    const ra = scoreText(d.ar, [], arTerms);
    let score = r.score + ra.score;
    const hits = r.hits + ra.hits;
    if (!hits) continue;
    if (phrase && d.en.toLowerCase().includes(phrase)) score += 12;
    if (arPhrase.length > 2 && normalizeArabic(d.ar).includes(arPhrase)) score += 14;
    ranked.push({ ...d, score, hits });
  }
  const need = new Set([...enTerms, ...arTerms].filter(Boolean));
  ranked.sort((a, b) => b.score - a.score);
  let results = ranked.filter((r) => r.hits >= Math.min(need.size, 2));
  if (!results.length) results = ranked;
  return results.slice(0, limit).map((r) => ({
    ref: `${r.name} ${r.s}:${r.a}`,
    surah: r.s,
    ayah: r.a,
    name: r.name,
    arabic: r.ar,
    translation: r.en,
  }));
}

/* ------------------------------------------------------------------ */
/* Hadith                                                               */
/* ------------------------------------------------------------------ */
function hadithIndex() {
  return loadJson(path.join(DATA, 'hadith', 'index.json'));
}

function normalizeBook(b) {
  if (!b) return null;
  const s = String(b).toLowerCase().replace(/['’`\s.-]/g, '');
  const aliases = {
    bukhari: 'bukhari', sahihbukhari: 'bukhari',
    muslim: 'muslim', sahihmuslim: 'muslim',
    abudawud: 'abudawud', abudawood: 'abudawud', abudawoud: 'abudawud',
    abudawood: 'abudawud', sunanabudawud: 'abudawud',
    tirmidhi: 'tirmidhi', termidhi: 'tirmidhi', tirimidhi: 'tirmidhi',
    nasai: 'nasai', nasa: 'nasai', nasai: 'nasai',
    ibnmajah: 'ibnmajah', ibnmaajah: 'ibnmajah', majah: 'ibnmajah',
    malik: 'malik', muwatta: 'malik', muwattamalik: 'malik',
    nawawi: 'nawawi', nawawi40: 'nawawi', fortynawawi: 'nawawi',
    qudsi: 'qudsi', hadithqudsi: 'qudsi', qudsiyya: 'qudsi',
    dehlawi: 'dehlawi', shahwaliullah: 'dehlawi', fortydehlawi: 'dehlawi',
  };
  if (aliases[s]) return aliases[s];
  if (BOOK_IDS.includes(s)) return s;
  for (const id of BOOK_IDS) if (s.includes(id)) return id;
  return null;
}

function loadCollection(book) {
  const id = normalizeBook(book);
  if (!id) return null;
  const doc = loadJson(path.join(DATA, 'hadith', `${id}.json`));
  if (!doc._map) {
    doc._map = new Map();
    doc.hadiths.forEach((h, i) => doc._map.set(h.n, i));
  }
  return doc;
}

function presentHadith(doc, h) {
  return {
    collection: doc.id,
    collectionTitle: doc.title,
    collectionTitleAr: doc.titleAr,
    number: h.n,
    bookRef: h.b,
    hadithRef: h.h,
    grades: h.g,
    english: h.en,
    arabic: h.ar,
    reference: `${doc.title} ${h.n}`,
  };
}

function getHadith(book, numberRaw) {
  const doc = loadCollection(book);
  if (!doc) return { error: `Unknown hadith collection "${book}". Use one of: ${BOOK_IDS.join(', ')}.` };
  const n = parseInt(numberRaw, 10);
  const idx = doc._map.get(n);
  if (idx === undefined) {
    return { error: `${doc.title} has ${doc.count} narrations; number ${numberRaw} does not exist.` };
  }
  return presentHadith(doc, doc.hadiths[idx]);
}

let searchCatalog = null;
function getSearchCatalog() {
  if (!searchCatalog) searchCatalog = loadJson(path.join(DATA, 'hadith', 'search.json'));
  return searchCatalog;
}

function weakGrade(g) {
  if (!g) return false;
  return /da'?if|weak|maudu|mawdu|fabricat/i.test(Array.isArray(g) ? g.join(' ') : String(g));
}

function randomHadiths(book, count = 3, wantStrong = true) {
  const pickFrom = (doc) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const h = doc.hadiths[Math.floor(Math.random() * doc.hadiths.length)];
      const len = (h.en || '').length;
      if (len < 40 || len > 650) continue;
      if (wantStrong && weakGrade(h.g)) continue;
      return presentHadith(doc, h);
    }
    return presentHadith(doc, doc.hadiths[Math.floor(Math.random() * doc.hadiths.length)]);
  };
  const out = [];
  if (book) {
    const doc = loadCollection(book);
    if (!doc) return { error: `Unknown collection "${book}".` };
    for (let i = 0; i < count; i++) out.push(pickFrom(doc));
  } else {
    // default: authentic material from the two Sahih collections
    const pool = ['bukhari', 'muslim', 'nawawi'];
    for (let i = 0; i < count; i++) {
      const doc = loadCollection(pool[Math.floor(Math.random() * pool.length)]);
      out.push(pickFrom(doc));
    }
  }
  return out;
}

function searchHadith(query, book, limit = 8) {
  let enTerms = tokenizeEn(query).filter((t) => !STOPWORDS.has(t));
  // Small Islamic-domain expansion improves topical retrieval when a user
  // says "honesty in trade" but a translation says "the seller told the truth".
  const synonyms = {
    intention: ['intentions', 'intended', 'niyyah'], intentions: ['intention', 'intended', 'niyyah'],
    honesty: ['honest', 'truth', 'truthful', 'truthfulness'], honest: ['honesty', 'truth', 'truthful'],
    trade: ['merchant', 'seller', 'buyer', 'selling', 'buying', 'business', 'transaction'],
    merchant: ['trade', 'seller', 'business'], character: ['manners', 'conduct', 'akhlaq'],
    mercy: ['merciful', 'compassion', 'kindness'], anxiety: ['worry', 'grief', 'distress', 'sadness'],
    patience: ['patient', 'sabr', 'persevere'], prayer: ['salah', 'salat'], charity: ['sadaqah', 'zakat'],
    parents: ['mother', 'father', 'parent'], neighbour: ['neighbor'], neighbor: ['neighbour'],
    knowledge: ['learn', 'scholar', 'teaching'], forgiveness: ['forgive', 'pardoned', 'pardon'],
  };
  const expanded = [...enTerms];
  for (const t of enTerms) for (const s of (synonyms[t] || [])) if (!expanded.includes(s)) expanded.push(s);
  enTerms = expanded;
  const arTerms = tokenizeAr(query);
  if (!enTerms.length && !arTerms.length) return [];
  const id = normalizeBook(book);
  let docs;
  if (id) {
    const col = loadCollection(id);
    docs = col.hadiths.map((h) => ({ c: col.id, n: h.n, b: h.b, h: h.h, g: h.g, t: h.en }));
  } else {
    docs = getSearchCatalog();
  }
  const phrase = query.replace(/['’`]/g, '').toLowerCase().trim();
  const ranked = [];
  for (const d of docs) {
    const r = scoreText(d.t, enTerms, arTerms);
    if (!r.hits) continue;
    const lower = d.t.toLowerCase();
    let score = r.score;
    if (phrase && lower.includes(phrase)) score += 14;
    // Long legal narrations can repeat common words many times. Normalize
    // gently so a concise, focused narration ranks above a large chapter note.
    if (d.t.length > 900) score *= Math.pow(900 / d.t.length, 0.48);
    // Prefer the two rigorously authenticated collections when relevance is
    // otherwise similar, without suppressing stronger topical matches.
    if (!id && (d.c === 'bukhari' || d.c === 'muslim')) score += 1.4;
    // Common topical intent where English translations use different terms.
    if (/honest|truth/.test(String(query).toLowerCase()) && /trade|merchant|business/.test(String(query).toLowerCase()) &&
        /truth|honest/.test(lower) && /buyer|seller|merchant|trade|business|transaction|bargain/.test(lower)) {
      score += 12;
      if (/buyer|seller|merchant/.test(lower) && /transaction|bargain|sale|trade/.test(lower)) score += 16;
    }
    ranked.push({ d, score, hits: r.hits });
  }
  const need = new Set([...enTerms, ...arTerms].filter(Boolean));
  ranked.sort((a, b) => b.score - a.score);
  let results = ranked.filter((r) => r.hits >= Math.min(need.size, 2));
  if (!results.length) results = ranked;
  return results.slice(0, limit).map(({ d }) => ({
    collection: d.c,
    collectionTitle: BOOK_TITLES[d.c] || d.c,
    number: d.n,
    bookRef: d.b,
    hadithRef: d.h,
    grades: d.g,
    english: d.t.length > 900 ? d.t.slice(0, 900) + '…' : d.t,
    reference: `${BOOK_TITLES[d.c] || d.c} ${d.n}`,
  }));
}

module.exports = {
  BOOK_IDS,
  BOOK_TITLES,
  quranMeta,
  resolveSurah,
  getSurah,
  getVerse,
  searchQuran,
  hadithIndex,
  getHadith,
  randomHadiths,
  searchHadith,
  normalizeBook,
};
