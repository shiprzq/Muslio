/* Muslio client: chat, streaming, citations, Quran reader and hadith library. */
'use strict';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const el = {
  sidebar: $('#sidebar'), scrim: $('#scrim'), sidebarClose: $('#sidebarClose'), menuBtn: $('#menuBtn'),
  brandHome: $('#brandHome'), newChat: $('#newChatBtn'), clearHistory: $('#clearHistoryBtn'), convoList: $('#convoList'),
  topbarTitle: $('#topbarTitle'), statusDot: $('#statusDot'), statusText: $('#statusText'), deleteChat: $('#deleteChatBtn'),
  openQuranTop: $('#openQuranTop'), chatScroll: $('#chatScroll'), welcome: $('#welcome'), messages: $('#messages'),
  suggestGrid: $('#suggestGrid'), scrollDown: $('#scrollDown'), composer: $('#composer'), input: $('#input'),
  send: $('#sendBtn'), stop: $('#stopBtn'), composerNote: $('#composerNote'),
  featuredText: $('#featuredText'), featuredSource: $('#featuredSource'), anotherHadith: $('#anotherHadithBtn'),
  askFeatured: $('#askFeatured'), hadithCountSide: $('#hadithCountSide'), hadithCountHero: $('#hadithCountHero'),
  libraryView: $('#libraryView'), libraryClose: $('#libraryClose'), libraryTitle: $('#libraryTitle'),
  librarySubtitle: $('#librarySubtitle'), libraryIndex: $('#libraryIndex'), libraryContent: $('#libraryContent'),
  referenceDrawer: $('#referenceDrawer'), referenceTitle: $('#referenceTitle'), referenceBody: $('#referenceBody'),
  referenceClose: $('#referenceClose'), drawerScrim: $('#drawerScrim'), toast: $('#toast'),
};

const STORE_KEY = 'muslio_conversations_v2';
const OLD_STORE_KEY = 'muslio_conversations_v1';
const state = {
  conversations: loadConversations(),
  activeId: null,
  streaming: false,
  controller: null,
  framePending: false,
  featured: null,
  quranMeta: null,
  hadithIndex: null,
  libraryMode: null,
  activeSurah: null,
  activeCollection: null,
  toastTimer: null,
};

function loadConversations() {
  try {
    const own = localStorage.getItem(STORE_KEY);
    const old = localStorage.getItem(OLD_STORE_KEY);
    const parsed = JSON.parse(own || old || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 80).map((c) => ({
      id: String(c.id || uid('c')),
      title: String(c.title || 'New conversation'),
      createdAt: Number(c.createdAt || Date.now()),
      updatedAt: Number(c.updatedAt || Date.now()),
      messages: (Array.isArray(c.messages) ? c.messages : []).filter((m) => m && ['user', 'assistant'].includes(m.role)).map((m) => ({
        id: String(m.id || uid('m')), role: m.role, content: String(m.content || ''), error: !!m.error,
      })),
    }));
  } catch { return []; }
}
function persist() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state.conversations)); } catch {}
}
function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function activeConversation() { return state.conversations.find((c) => c.id === state.activeId) || null; }
function escapeHtml(s = '') { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function safeUrl(url) { return /^https?:\/\//i.test(url) ? url : '#'; }
function truncate(s, n) { s = String(s || '').trim(); return s.length <= n ? s : s.slice(0, n).trimEnd() + '…'; }
function numberFormat(n) { return Number(n || 0).toLocaleString('en-US'); }

/* ------------------------------------------------------------------ */
/* Markdown + source token rendering                                   */
/* ------------------------------------------------------------------ */
function inlineFormat(raw) {
  let s = escapeHtml(raw);
  s = s.replace(/\[\[quran\s+(\d+):(\d+)(?:-(\d+))?\]\]/gi, (_m, surah, from, to) =>
    `<button type="button" class="citation-link" data-cite="quran" data-surah="${surah}" data-from="${from}" data-to="${to || from}">Quran ${surah}:${from}${to ? '-' + to : ''}</button>`);
  s = s.replace(/\[\[hadith\s+([a-z0-9]+)\s+(\d+)\]\]/gi, (_m, book, number) =>
    `<button type="button" class="citation-link" data-cite="hadith" data-book="${book.toLowerCase()}" data-number="${number}">${displayBook(book)} ${number}</button>`);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) =>
    `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,!?])/g, '$1<em>$2</em>');
  return s;
}

function arabicLine(raw) {
  const chars = (raw.match(/[\u0600-\u06ff]/g) || []).length;
  const letters = (raw.match(/[\p{L}]/gu) || []).length;
  return chars > 5 && chars >= Math.max(5, letters * .5);
}

function renderMarkdown(source = '') {
  const blocks = [];
  let src = String(source).replace(/```([^\n]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const i = blocks.length;
    blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\n§§CODE${i}§§\n`;
  });
  const lines = src.split('\n');
  const out = [];
  let list = null;
  let quote = [];
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushQuote = () => {
    if (!quote.length) return;
    out.push(`<blockquote>${quote.map((x) => arabicLine(x) ? `<span class="arabic" dir="rtl">${inlineFormat(x)}</span>` : `<span>${inlineFormat(x)}</span>`).join('<br>')}</blockquote>`);
    quote = [];
  };

  for (const raw of lines) {
    const code = raw.match(/^§§CODE(\d+)§§$/);
    if (code) { flushQuote(); closeList(); out.push(blocks[Number(code[1])]); continue; }
    if (!raw.trim()) { flushQuote(); closeList(); continue; }
    if (/^\s*(?:>|&gt;)\s?/.test(raw)) { closeList(); quote.push(raw.replace(/^\s*(?:>|&gt;)\s?/, '')); continue; }
    flushQuote();
    const heading = raw.match(/^(#{1,4})\s+(.+)$/);
    if (heading) { closeList(); const level = Math.min(heading[1].length + 1, 4); out.push(`<h${level}>${inlineFormat(heading[2])}</h${level}>`); continue; }
    if (/^\s*---+\s*$/.test(raw)) { closeList(); out.push('<hr>'); continue; }
    const ul = raw.match(/^\s*[-*•]\s+(.+)$/);
    const ol = raw.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) { closeList(); list = kind; out.push(`<${kind}>`); }
      const text = (ul || ol)[1];
      out.push(`<li>${arabicLine(text) ? `<span class="arabic" dir="rtl">${inlineFormat(text)}</span>` : inlineFormat(text)}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${arabicLine(raw) ? `<span class="arabic" dir="rtl">${inlineFormat(raw)}</span>` : inlineFormat(raw)}</p>`);
  }
  flushQuote(); closeList();
  return out.join('');
}

function displayBook(id) {
  const map = {
    bukhari: 'Bukhari', muslim: 'Muslim', abudawud: 'Abu Dawud', tirmidhi: 'Tirmidhi',
    nasai: "Nasa'i", ibnmajah: 'Ibn Majah', nawawi: 'Nawawi 40', qudsi: 'Hadith Qudsi',
    malik: 'Muwatta Malik', dehlawi: 'Dehlawi 40',
  };
  return map[String(id).toLowerCase()] || id;
}

function muslioAvatar() {
  return `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M13 46V18h8.5L32 33.1 42.5 18H51v28h-9V31.7L32 45.5 22 31.7V46H13Z" fill="#fffaf0"/><path d="M27.5 18.1c0-3.2 2-5.7 4.5-7.1 2.5 1.4 4.5 3.9 4.5 7.1v1.8h-9v-1.8Z" fill="#d4a72c"/></svg>`;
}

/* ------------------------------------------------------------------ */
/* Conversation views                                                   */
/* ------------------------------------------------------------------ */
function setStatus(mode, text) {
  el.statusDot.className = mode === 'busy' ? 'busy' : mode === 'error' ? 'error' : '';
  el.statusText.textContent = text || (mode === 'busy' ? 'Working' : mode === 'error' ? 'Connection issue' : 'Ready');
}

function renderSidebar() {
  el.convoList.innerHTML = '';
  const sorted = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  if (!sorted.length) {
    el.convoList.innerHTML = '<p class="convo-empty">Your conversations will appear here.</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const c of sorted) {
    const b = document.createElement('button');
    b.className = 'convo-item' + (c.id === state.activeId ? ' active' : '');
    b.innerHTML = `<span class="convo-line"></span><span class="convo-title">${escapeHtml(c.title)}</span>`;
    b.addEventListener('click', () => { state.activeId = c.id; persist(); renderAll(); closeSidebar(); closeLibrary(); });
    frag.appendChild(b);
  }
  el.convoList.appendChild(frag);
}

function createMessageNode(msg) {
  const row = document.createElement('article');
  row.className = `msg-row ${msg.role}`;
  row.dataset.messageId = msg.id;
  if (msg.role === 'assistant') {
    const avatar = document.createElement('div');
    avatar.className = 'avatar ai'; avatar.innerHTML = muslioAvatar(); row.appendChild(avatar);
  }
  const bubble = document.createElement('div'); bubble.className = 'bubble';
  const sender = document.createElement('div'); sender.className = 'sender'; sender.textContent = msg.role === 'assistant' ? 'Muslio' : 'You';
  const content = document.createElement('div'); content.className = `msg-content md${msg.error ? ' error-content' : ''}`;
  if (msg.role === 'assistant' && msg.streaming && !msg.content) {
    content.innerHTML = `<span class="activity-note"><span class="activity-mark"></span><span>${escapeHtml(msg.activity || 'Consulting the knowledge library')}</span></span>`;
  } else {
    content.innerHTML = renderMarkdown(msg.content) + (msg.streaming ? '<span class="stream-caret"></span>' : '');
  }
  bubble.append(sender, content);
  if (msg.role === 'assistant' && msg.content && !msg.streaming) {
    const actions = document.createElement('div'); actions.className = 'msg-actions';
    const copy = document.createElement('button'); copy.className = 'msg-action'; copy.type = 'button';
    copy.innerHTML = `<svg viewBox="0 0 20 20"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M13 5V3H3v10h2"/></svg><span>Copy</span>`;
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(msg.content); copy.classList.add('copied'); $('span', copy).textContent = 'Copied'; setTimeout(() => { copy.classList.remove('copied'); $('span', copy).textContent = 'Copy'; }, 1400); } catch { toast('Could not copy'); }
    });
    actions.appendChild(copy); bubble.appendChild(actions);
  }
  row.appendChild(bubble);
  return row;
}

function renderMessages(scroll = true) {
  const c = activeConversation();
  const has = !!(c && c.messages.length);
  el.welcome.hidden = has;
  el.messages.hidden = !has;
  el.messages.innerHTML = '';
  if (has) {
    const frag = document.createDocumentFragment();
    c.messages.forEach((m) => frag.appendChild(createMessageNode(m)));
    el.messages.appendChild(frag);
    if (scroll) requestAnimationFrame(() => scrollBottom(true));
  }
  el.topbarTitle.textContent = c ? c.title : 'New conversation';
}

function renderAll() { renderSidebar(); renderMessages(); }
function scrollBottom(immediate = false) { el.chatScroll.scrollTo({ top: el.chatScroll.scrollHeight, behavior: immediate ? 'auto' : 'smooth' }); }

function updateStreamingMessage(msg) {
  if (state.framePending) return;
  state.framePending = true;
  requestAnimationFrame(() => {
    state.framePending = false;
    const row = el.messages.querySelector(`[data-message-id="${CSS.escape(msg.id)}"]`);
    if (!row) return;
    const content = $('.msg-content', row);
    content.className = `msg-content md${msg.error ? ' error-content' : ''}`;
    if (!msg.content) {
      content.innerHTML = `<span class="activity-note"><span class="activity-mark"></span><span>${escapeHtml(msg.activity || 'Consulting the knowledge library')}</span></span>`;
    } else {
      content.innerHTML = renderMarkdown(msg.content) + '<span class="stream-caret"></span>';
    }
    const distance = el.chatScroll.scrollHeight - el.chatScroll.scrollTop - el.chatScroll.clientHeight;
    if (distance < 260) scrollBottom();
  });
}

function newConversation() {
  if (state.streaming && state.controller) state.controller.abort();
  state.activeId = null; persist(); closeLibrary(); renderAll(); closeSidebar(); el.input.focus();
}

function deleteConversation() {
  const c = activeConversation();
  if (!c) return;
  if (!window.confirm('Delete this conversation?')) return;
  state.conversations = state.conversations.filter((x) => x.id !== c.id);
  state.activeId = null; persist(); renderAll();
}

function clearHistory() {
  if (!state.conversations.length || !window.confirm('Clear every saved conversation?')) return;
  if (state.controller) state.controller.abort();
  state.conversations = []; state.activeId = null; persist(); renderAll(); closeSidebar();
}

/* ------------------------------------------------------------------ */
/* Chat streaming                                                       */
/* ------------------------------------------------------------------ */
async function sendMessage(text) {
  text = String(text || '').trim();
  if (!text || state.streaming) return;
  closeLibrary();
  let c = activeConversation();
  if (!c) {
    c = { id: uid('c'), title: truncate(text.replace(/\s+/g, ' '), 52), messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    state.conversations.push(c); state.activeId = c.id;
  }
  c.messages.push({ id: uid('m'), role: 'user', content: text });
  const reply = { id: uid('m'), role: 'assistant', content: '', streaming: true, activity: 'Consulting the knowledge library' };
  c.messages.push(reply); c.updatedAt = Date.now(); persist(); renderAll(); setStreaming(true); setStatus('busy', 'Consulting sources');

  const controller = new AbortController(); state.controller = controller;
  try {
    const response = await fetch('/api/chat', {
      method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webSearch: true,
        messages: c.messages.filter((m) => m !== reply).map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!response.ok || !response.body) {
      let msg = `Request failed (${response.status})`;
      try { const j = await response.json(); msg = j.error?.message || msg; } catch {}
      throw new Error(msg);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const processBlock = (block) => {
      let eventName = 'message'; const dataLines = [];
      block.split('\n').forEach((line) => {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      });
      const data = dataLines.join('\n').trim();
      if (!data || data === '[DONE]') return;
      try {
        const j = JSON.parse(data);
        if (eventName === 'activity') {
          reply.activity = j.label || reply.activity;
          setStatus('busy', reply.activity);
          updateStreamingMessage(reply);
          return;
        }
        const piece = j.choices?.[0]?.delta?.content;
        if (typeof piece === 'string') { reply.content += piece; updateStreamingMessage(reply); }
      } catch {}
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      const parts = buffer.split('\n\n'); buffer = parts.pop() || '';
      parts.forEach(processBlock);
    }
    if (buffer.trim()) processBlock(buffer);
    if (!reply.content) throw new Error('Muslio returned no answer. Please try once more.');
    setStatus('ready', 'Ready');
  } catch (err) {
    if (err.name === 'AbortError') {
      if (!reply.content) reply.content = 'Response stopped.';
    } else {
      reply.error = true;
      reply.content = `**Something went wrong**\n\n${err.message || 'Please try again in a moment.'}`;
      setStatus('error', 'Could not complete');
    }
  } finally {
    reply.streaming = false; delete reply.activity; c.updatedAt = Date.now(); persist(); state.controller = null; setStreaming(false); renderMessages(false);
  }
}

function setStreaming(on) {
  state.streaming = on; el.stop.hidden = !on; el.send.hidden = on; el.input.disabled = on;
  el.send.disabled = on || !el.input.value.trim();
}
function autoGrow() { el.input.style.height = 'auto'; el.input.style.height = Math.min(el.input.scrollHeight, 170) + 'px'; }

/* ------------------------------------------------------------------ */
/* Featured hadith                                                     */
/* ------------------------------------------------------------------ */
async function loadFeatured() {
  el.featuredText.innerHTML = '<span class="skeleton-line wide"></span><span class="skeleton-line"></span><span class="skeleton-line short"></span>';
  el.featuredSource.disabled = true; el.askFeatured.disabled = true;
  try {
    const r = await fetch('/api/hadith/featured');
    if (!r.ok) throw new Error();
    const h = await r.json(); state.featured = h;
    el.featuredText.textContent = truncate(h.english, 520);
    el.featuredSource.textContent = h.reference;
    el.featuredSource.disabled = false; el.askFeatured.disabled = false;
  } catch {
    el.featuredText.textContent = 'The local hadith library could not be opened.';
    el.featuredSource.textContent = 'Try again'; el.featuredSource.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Full library                                                        */
/* ------------------------------------------------------------------ */
async function ensureLibraryData() {
  const jobs = [];
  if (!state.quranMeta) jobs.push(fetch('/api/quran/meta').then((r) => r.json()).then((d) => { state.quranMeta = d; }));
  if (!state.hadithIndex) jobs.push(fetch('/api/hadith/index').then((r) => r.json()).then((d) => {
    state.hadithIndex = d;
    const total = d.reduce((sum, x) => sum + Number(x.count || 0), 0);
    el.hadithCountSide.textContent = `${numberFormat(total)} narrations`;
    el.hadithCountHero.textContent = numberFormat(total);
  }));
  await Promise.all(jobs);
}

async function openLibrary(mode) {
  closeSidebar(); closeReference();
  state.libraryMode = mode; el.libraryView.hidden = false;
  el.libraryTitle.textContent = mode === 'quran' ? 'Quran' : 'Hadith';
  el.librarySubtitle.textContent = mode === 'quran' ? 'Uthmani Arabic with Saheeh International' : 'Search and read the major collections';
  el.libraryIndex.innerHTML = '<div class="loading-state"><span class="activity-mark"></span>Opening library</div>';
  el.libraryContent.innerHTML = '<div class="loading-state"><span class="activity-mark"></span>Preparing the index</div>';
  try {
    await ensureLibraryData();
    if (mode === 'quran') renderQuranIndex(); else renderHadithIndex();
  } catch {
    el.libraryContent.innerHTML = '<div class="library-empty"><h2>Library unavailable</h2><p>Please refresh and try again.</p></div>';
  }
}
function closeLibrary() { el.libraryView.hidden = true; state.libraryMode = null; }

function searchBox(kind) {
  return `<form class="library-search" data-search-kind="${kind}">
    <input type="search" name="q" autocomplete="off" placeholder="${kind === 'quran' ? 'Search verses or topics' : 'Search every collection'}" aria-label="Search ${kind}">
    <button type="submit" aria-label="Search"><svg viewBox="0 0 20 20"><circle cx="9" cy="9" r="5.5"/><path d="m13 13 4 4"/></svg></button>
  </form>`;
}

function renderQuranIndex() {
  el.libraryIndex.innerHTML = searchBox('quran') + '<p class="index-heading">114 surahs</p><div class="surah-index-list"></div>';
  const list = $('.surah-index-list', el.libraryIndex);
  for (const s of state.quranMeta) {
    const b = document.createElement('button');
    b.className = 'surah-index-button' + (s.n === state.activeSurah ? ' active' : ''); b.dataset.surah = s.n;
    b.innerHTML = `<span class="surah-number">${s.n}</span><span><strong>${escapeHtml(s.en)}</strong><small>${s.ay} verses · ${escapeHtml(s.tr)}</small></span><span class="surah-ar" lang="ar" dir="rtl">${escapeHtml(s.ar)}</span>`;
    b.addEventListener('click', () => loadSurah(s.n)); list.appendChild(b);
  }
  if (state.activeSurah) loadSurah(state.activeSurah);
  else el.libraryContent.innerHTML = `<div class="library-empty"><div class="empty-mark">ق</div><h2>The complete Quran</h2><p>Select a surah, or search every Arabic verse and English translation by word or topic.</p></div>`;
}

async function loadSurah(number, focusAyah = null) {
  state.activeSurah = Number(number); $$('.surah-index-button', el.libraryIndex).forEach((b) => b.classList.toggle('active', Number(b.dataset.surah) === state.activeSurah));
  el.libraryContent.innerHTML = '<div class="loading-state"><span class="activity-mark"></span>Opening surah</div>';
  try {
    const r = await fetch(`/api/quran/surah/${state.activeSurah}`); const d = await r.json();
    el.libraryContent.innerHTML = `<header class="reader-heading"><p class="kicker">Surah ${d.meta.n} · ${escapeHtml(d.meta.type)}</p><h1>${escapeHtml(d.meta.en)} <span lang="ar" dir="rtl">${escapeHtml(d.meta.ar)}</span></h1><p>${escapeHtml(d.meta.tr)} · ${d.meta.ay} verses · Saheeh International translation</p></header><div class="verse-list"></div>`;
    const list = $('.verse-list', el.libraryContent);
    const frag = document.createDocumentFragment();
    d.verses.forEach((v) => {
      const section = document.createElement('section'); section.className = 'verse'; section.id = `verse-${d.meta.n}-${v.ayah}`;
      section.innerHTML = `<span class="verse-ref">${d.meta.n}:${v.ayah}</span><p class="verse-arabic" lang="ar" dir="rtl">${escapeHtml(v.arabic)}</p><p class="verse-translation">${escapeHtml(v.translation)}</p>`;
      frag.appendChild(section);
    });
    list.appendChild(frag);
    el.libraryContent.scrollTop = 0;
    if (focusAyah) requestAnimationFrame(() => $(`#verse-${d.meta.n}-${focusAyah}`)?.scrollIntoView({ block: 'start' }));
  } catch { el.libraryContent.innerHTML = '<div class="library-empty"><h2>Could not open this surah</h2><p>Please try again.</p></div>'; }
}

async function searchQuran(query) {
  el.libraryContent.innerHTML = '<div class="loading-state"><span class="activity-mark"></span>Searching all 6,236 verses</div>';
  try {
    const r = await fetch(`/api/quran/search?q=${encodeURIComponent(query)}&limit=20`); const d = await r.json();
    el.libraryContent.innerHTML = `<div class="search-results"><h1>Quran search</h1><p>${d.results.length} results for “${escapeHtml(query)}”</p><div class="result-list"></div></div>`;
    const list = $('.result-list', el.libraryContent);
    if (!d.results.length) list.innerHTML = '<p class="result-text">No close matches. Try fewer or different words.</p>';
    d.results.forEach((x) => {
      const b = document.createElement('button'); b.className = 'result-row';
      b.innerHTML = `<span class="result-ref">${escapeHtml(x.ref)}</span><p class="result-arabic" lang="ar" dir="rtl">${escapeHtml(x.arabic)}</p><p class="result-text">${escapeHtml(x.translation)}</p>`;
      b.addEventListener('click', () => loadSurah(x.surah, x.ayah)); list.appendChild(b);
    });
  } catch { el.libraryContent.innerHTML = '<div class="library-empty"><h2>Search failed</h2><p>Please try again.</p></div>'; }
}

function renderHadithIndex() {
  el.libraryIndex.innerHTML = searchBox('hadith') + `<p class="index-heading">${state.hadithIndex.length} collections</p><div class="collection-index-list"></div>`;
  const list = $('.collection-index-list', el.libraryIndex);
  state.hadithIndex.forEach((c) => {
    const b = document.createElement('button'); b.className = 'collection-index-button' + (c.id === state.activeCollection ? ' active' : ''); b.dataset.book = c.id;
    b.innerHTML = `<span><strong>${escapeHtml(c.title)}</strong><small>${numberFormat(c.count)} narrations</small></span>`;
    b.addEventListener('click', () => showCollection(c.id)); list.appendChild(b);
  });
  if (state.activeCollection) showCollection(state.activeCollection);
  else el.libraryContent.innerHTML = `<div class="library-empty"><div class="empty-mark">ح</div><h2>The hadith library</h2><p>Search across ${numberFormat(state.hadithIndex.reduce((s,c) => s + c.count, 0))} narrations, or choose a collection to read an exact numbered hadith.</p></div>`;
}

function showCollection(id) {
  state.activeCollection = id; const c = state.hadithIndex.find((x) => x.id === id); if (!c) return;
  $$('.collection-index-button', el.libraryIndex).forEach((b) => b.classList.toggle('active', b.dataset.book === id));
  el.libraryContent.innerHTML = `<div class="hadith-reading"><header class="reader-heading"><p class="kicker">Hadith collection</p><h1>${escapeHtml(c.title)} <span lang="ar" dir="rtl">${escapeHtml(c.titleAr)}</span></h1><p>${escapeHtml(c.author)} · ${numberFormat(c.count)} narrations</p></header><div class="hadith-meta"><p><strong>Grading note:</strong> ${escapeHtml(c.grading)}</p></div><form class="number-lookup" data-book="${escapeHtml(id)}" style="margin-top:24px;display:flex;gap:8px"><input name="number" type="number" min="1" placeholder="Hadith number" style="height:40px;flex:1;border:1px solid #c8c4b9;border-radius:7px;padding:0 11px;background:#fffef9"><button type="submit" class="text-action">Open hadith</button><button type="button" class="text-action random-in-collection">Random</button></form></div>`;
  el.libraryContent.scrollTop = 0;
}

async function searchHadith(query) {
  el.libraryContent.innerHTML = '<div class="loading-state"><span class="activity-mark"></span>Searching the hadith library</div>';
  try {
    const r = await fetch(`/api/hadith/search?q=${encodeURIComponent(query)}&limit=20`); const d = await r.json();
    el.libraryContent.innerHTML = `<div class="search-results"><h1>Hadith search</h1><p>${d.results.length} results for “${escapeHtml(query)}”</p><div class="result-list"></div></div>`;
    const list = $('.result-list', el.libraryContent);
    if (!d.results.length) list.innerHTML = '<p class="result-text">No close matches. Try a simpler topic or another wording.</p>';
    d.results.forEach((x) => {
      const b = document.createElement('button'); b.className = 'result-row';
      b.innerHTML = `<span class="result-ref">${escapeHtml(x.reference)}</span><p class="result-text">${escapeHtml(truncate(x.english, 650))}</p>`;
      b.addEventListener('click', () => openHadithReference(x.collection, x.number)); list.appendChild(b);
    });
  } catch { el.libraryContent.innerHTML = '<div class="library-empty"><h2>Search failed</h2><p>Please try again.</p></div>'; }
}

/* ------------------------------------------------------------------ */
/* Citation/source drawer                                               */
/* ------------------------------------------------------------------ */
function openReferenceShell(title) {
  el.referenceTitle.textContent = title; el.referenceBody.innerHTML = '<p class="reference-loading">Opening the source…</p>';
  el.referenceDrawer.classList.add('open'); el.referenceDrawer.setAttribute('aria-hidden', 'false'); el.drawerScrim.classList.add('show');
}
function closeReference() { el.referenceDrawer.classList.remove('open'); el.referenceDrawer.setAttribute('aria-hidden', 'true'); el.drawerScrim.classList.remove('show'); }

async function openQuranReference(surah, from, to = from) {
  openReferenceShell(`Quran ${surah}:${from}${String(to) !== String(from) ? '-' + to : ''}`);
  try {
    const r = await fetch(`/api/quran/surah/${surah}?from=${from}&to=${to}`); const d = await r.json();
    el.referenceTitle.textContent = `${d.meta.en} ${d.meta.n}:${d.from}${d.to !== d.from ? '-' + d.to : ''}`;
    el.referenceBody.innerHTML = d.verses.map((v) => `<section class="verse"><span class="verse-ref">${d.meta.n}:${v.ayah}</span><p class="reference-arabic" lang="ar" dir="rtl">${escapeHtml(v.arabic)}</p><p class="reference-translation">${escapeHtml(v.translation)}</p></section>`).join('') + `<div class="reference-details"><p><strong>Translation:</strong> Saheeh International</p><p><strong>Surah:</strong> ${escapeHtml(d.meta.en)} (${escapeHtml(d.meta.tr)})</p></div><div class="reference-actions"><button class="primary" data-open-surah="${d.meta.n}" data-ayah="${d.from}">Open in Quran reader</button><button data-ask-ref="quran" data-ref="${d.meta.n}:${d.from}${d.to !== d.from ? '-' + d.to : ''}">Ask Muslio</button></div>`;
  } catch { el.referenceBody.innerHTML = '<p class="reference-loading">This verse could not be opened.</p>'; }
}

async function openHadithReference(book, number, known = null) {
  openReferenceShell(`${displayBook(book)} ${number}`);
  try {
    const h = known || await fetch(`/api/hadith/${book}/${number}`).then((r) => { if (!r.ok) throw new Error(); return r.json(); });
    el.referenceTitle.textContent = h.reference;
    el.referenceBody.innerHTML = `${h.arabic ? `<p class="reference-arabic" lang="ar" dir="rtl">${escapeHtml(h.arabic)}</p>` : ''}<p class="reference-translation">${escapeHtml(h.english)}</p><div class="reference-details"><p><strong>Collection:</strong> ${escapeHtml(h.collectionTitle)}</p><p><strong>Hadith number:</strong> ${escapeHtml(h.number)}</p>${h.bookRef ? `<p><strong>Book reference:</strong> ${escapeHtml(h.bookRef)}:${escapeHtml(h.hadithRef)}</p>` : ''}${h.grades?.length ? `<p><strong>Grades:</strong> ${escapeHtml(h.grades.join(', '))}</p>` : ''}</div><div class="reference-actions"><button class="primary" data-ask-ref="hadith" data-ref="${escapeHtml(h.collection)} ${escapeHtml(h.number)}">Ask Muslio about this</button></div>`;
  } catch { el.referenceBody.innerHTML = '<p class="reference-loading">This hadith could not be opened.</p>'; }
}

/* ------------------------------------------------------------------ */
/* UI events                                                            */
/* ------------------------------------------------------------------ */
function openSidebar() { el.sidebar.classList.add('open'); el.scrim.classList.add('show'); }
function closeSidebar() { el.sidebar.classList.remove('open'); el.scrim.classList.remove('show'); }
function toast(message) { clearTimeout(state.toastTimer); el.toast.textContent = message; el.toast.classList.add('show'); state.toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1800); }

el.composer.addEventListener('submit', (e) => { e.preventDefault(); const text = el.input.value; if (!text.trim()) return; el.input.value = ''; autoGrow(); sendMessage(text); });
el.input.addEventListener('input', () => { autoGrow(); el.send.disabled = !el.input.value.trim() || state.streaming; });
el.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.composer.requestSubmit(); } });
el.stop.addEventListener('click', () => state.controller?.abort());
el.newChat.addEventListener('click', newConversation); el.brandHome.addEventListener('click', (e) => { e.preventDefault(); newConversation(); });
el.deleteChat.addEventListener('click', deleteConversation); el.clearHistory.addEventListener('click', clearHistory);
el.menuBtn.addEventListener('click', openSidebar); el.sidebarClose.addEventListener('click', closeSidebar); el.scrim.addEventListener('click', closeSidebar);
el.openQuranTop.addEventListener('click', () => openLibrary('quran')); el.libraryClose.addEventListener('click', closeLibrary);
$$('[data-library]').forEach((b) => b.addEventListener('click', () => openLibrary(b.dataset.library)));
el.referenceClose.addEventListener('click', closeReference); el.drawerScrim.addEventListener('click', closeReference);
el.suggestGrid.addEventListener('click', (e) => { const b = e.target.closest('button[data-prompt]'); if (b) sendMessage(b.dataset.prompt); });
el.anotherHadith.addEventListener('click', loadFeatured);
el.featuredSource.addEventListener('click', () => { if (state.featured) openHadithReference(state.featured.collection, state.featured.number, state.featured); else loadFeatured(); });
el.askFeatured.addEventListener('click', () => { if (state.featured) sendMessage(`Explain ${state.featured.reference} in a clear way. What are its main lessons and how can I apply it today?`); });
el.scrollDown.addEventListener('click', () => scrollBottom());
el.chatScroll.addEventListener('scroll', () => { const d = el.chatScroll.scrollHeight - el.chatScroll.scrollTop - el.chatScroll.clientHeight; el.scrollDown.hidden = d < 260; });

el.messages.addEventListener('click', (e) => {
  const c = e.target.closest('.citation-link'); if (!c) return;
  if (c.dataset.cite === 'quran') openQuranReference(c.dataset.surah, c.dataset.from, c.dataset.to);
  else openHadithReference(c.dataset.book, c.dataset.number);
});

el.libraryIndex.addEventListener('submit', (e) => {
  const form = e.target.closest('.library-search'); if (!form) return; e.preventDefault();
  const q = new FormData(form).get('q')?.trim(); if (!q) return;
  if (form.dataset.searchKind === 'quran') searchQuran(q); else searchHadith(q);
});
el.libraryContent.addEventListener('submit', (e) => {
  const form = e.target.closest('.number-lookup'); if (!form) return; e.preventDefault();
  const n = new FormData(form).get('number'); if (n) openHadithReference(form.dataset.book, n);
});
el.libraryContent.addEventListener('click', async (e) => {
  const random = e.target.closest('.random-in-collection');
  if (random) {
    const form = random.closest('.number-lookup');
    openReferenceShell(`Random ${displayBook(form.dataset.book)} hadith`);
    try { const h = await fetch(`/api/hadith/${form.dataset.book}/random`).then((r) => r.json()); openHadithReference(h.collection, h.number, h); } catch { el.referenceBody.innerHTML = '<p class="reference-loading">Could not select a hadith.</p>'; }
  }
});
el.referenceBody.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open-surah]');
  if (open) { closeReference(); openLibrary('quran').then(() => loadSurah(open.dataset.openSurah, open.dataset.ayah)); return; }
  const ask = e.target.closest('[data-ask-ref]');
  if (ask) {
    const prompt = ask.dataset.askRef === 'quran' ? `Explain Quran ${ask.dataset.ref} with context, key lessons, and practical application.` : `Explain the hadith ${ask.dataset.ref}. Give its context, authenticity, main lessons, and practical application.`;
    closeReference(); sendMessage(prompt);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeReference(); if (!el.libraryView.hidden) closeLibrary(); closeSidebar(); }
  if ((e.key === 'n' || e.key === 'N') && !/INPUT|TEXTAREA/.test(document.activeElement.tagName) && !e.metaKey && !e.ctrlKey) newConversation();
});

/* Init */
if (state.conversations.length) state.activeId = [...state.conversations].sort((a,b) => b.updatedAt - a.updatedAt)[0].id;
renderAll(); autoGrow(); setStatus('ready', 'Ready'); loadFeatured(); ensureLibraryData().catch(() => {});
