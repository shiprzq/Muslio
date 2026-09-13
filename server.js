/**
 * Muslio — dedicated Muslim AI.
 *
 * Zero-dependency Node server:
 *   • serves the static app in /public
 *   • serves the local knowledge-base API (full Quran + major hadith collections)
 *   • runs an agentic chat loop against the ChatWave OpenAI-compatible gateway:
 *     local function tools are executed here, streaming answers pipe through,
 *     and live web search is forwarded as an upstream tool.
 *
 * ChatWave enforces an Origin allow-list, so browser calls must pass through
 * this proxy which attaches the required browser-style headers and keeps the
 * API key server-side.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const kb = require('./kb');
const { buildSystemPrompt } = require('./prompt');

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';
const UPSTREAM = 'https://chatwave.crunchflix.site';
const MODEL = 'gpt-5-4'; // single curated model for Muslio
const API_KEY =
  process.env.CHATWAVE_API_KEY ||
  'cw-24bae2681a38806ee10433e890b6eade9457104e993b7399f39287fdd782ab29';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                         */
/* ------------------------------------------------------------------ */
const sendJson = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};

function readBody(req, limitMb = 4) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitMb * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, index) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(index);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=300',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* Knowledge-base API                                                   */
/* ------------------------------------------------------------------ */
function kbRoutes(req, res, pathname, query) {
  // Quran
  if (pathname === '/api/quran/meta') return sendJson(res, 200, kb.quranMeta());

  if (pathname === '/api/quran/search') {
    const q = (query.get('q') || '').trim();
    const limit = Math.min(parseInt(query.get('limit') || '8', 10) || 8, 20);
    if (!q) return sendJson(res, 400, { error: { message: 'Missing q parameter.' } });
    return sendJson(res, 200, { query: q, results: kb.searchQuran(q, limit) });
  }

  let m = pathname.match(/^\/api\/quran\/surah\/([^/]+)$/);
  if (m) {
    const s = kb.getSurah(decodeURIComponent(m[1]));
    if (!s) return sendJson(res, 404, { error: { message: 'Surah not found.' } });
    let from = parseInt(query.get('from') || '1', 10);
    let to = parseInt(query.get('to') || String(s.meta.ay), 10);
    from = Math.max(1, Math.min(from, s.meta.ay));
    to = Math.max(from, Math.min(to, s.meta.ay));
    return sendJson(res, 200, {
      meta: s.meta,
      from,
      to,
      verses: s.ar.slice(from - 1, to).map((ar, i) => ({
        ayah: from + i, arabic: ar, translation: s.en[from - 1 + i],
      })),
    });
  }

  m = pathname.match(/^\/api\/quran\/verse\/([^/]+)\/(\d+)$/);
  if (m) {
    const v = kb.getVerse(decodeURIComponent(m[1]), m[2]);
    return sendJson(res, v.error ? 404 : 200, v);
  }

  // Hadith
  if (pathname === '/api/hadith/index') return sendJson(res, 200, kb.hadithIndex());

  if (pathname === '/api/hadith/search') {
    const q = (query.get('q') || '').trim();
    const book = query.get('book') || '';
    const limit = Math.min(parseInt(query.get('limit') || '10', 10) || 10, 20);
    if (!q) return sendJson(res, 400, { error: { message: 'Missing q parameter.' } });
    return sendJson(res, 200, { query: q, results: kb.searchHadith(q, book, limit) });
  }

  if (pathname === '/api/hadith/featured') {
    const picks = kb.randomHadiths(null, 1, true);
    return sendJson(res, 200, picks[0]);
  }

  m = pathname.match(/^\/api\/hadith\/([^/]+)\/(random|\d+)$/);
  if (m) {
    const book = decodeURIComponent(m[1]);
    if (m[2] === 'random') {
      const picks = kb.randomHadiths(book, 1, true);
      return sendJson(res, picks[0].error ? 404 : 200, picks[0]);
    }
    const h = kb.getHadith(book, parseInt(m[2], 10));
    return sendJson(res, h.error ? 404 : 200, h);
  }

  return false;
}

/* ------------------------------------------------------------------ */
/* Local function tools exposed to the model                            */
/* ------------------------------------------------------------------ */
const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'list_surahs',
      description: 'List all 114 surahs with number, English name, meaning, verse count and type.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_surah',
      description: 'Read Quran verses with exact Uthmani Arabic and Saheeh International English. Returns up to 30 verses; call repeatedly with from/to to read more.',
      parameters: {
        type: 'object',
        properties: {
          surah: { type: 'string', description: 'Surah number (1-114), English name e.g. "Al-Baqarah" or "Kahf", or Arabic name e.g. "البقرة"' },
          from: { type: 'integer', description: 'First verse number (default 1)' },
          to: { type: 'integer', description: 'Last verse number (inclusive). Keep ranges at or below 30 verses.' },
        },
        required: ['surah'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_quran',
      description: 'Full-text search of the whole Quran in Arabic and English by topic, wording or phrase. Returns exact verses with references.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', description: 'Max results, 1-12 (default 6)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_hadith',
      description: 'Fetch one exact hadith by collection id and number, with Arabic, English and grading.',
      parameters: {
        type: 'object',
        properties: {
          collection: { type: 'string', enum: kb.BOOK_IDS },
          number: { type: 'integer', description: 'Hadith number (the hadithnumber used by the collection)' },
        },
        required: ['collection', 'number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_hadith',
      description: 'Search the hadith library (36,000+ narrations from the six canonical collections, Muwatta Malik, Forty Nawawi, Forty Qudsi and Forty Dehlawi) by topic in English or Arabic.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          collection: { type: 'string', enum: kb.BOOK_IDS, description: 'Optional; omit to search across every collection.' },
          limit: { type: 'integer', description: 'Max results, 1-10 (default 6)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'random_hadiths',
      description: 'Get authentic, reasonably short random hadiths. Use for "give me a good hadith", daily hadith, or spiritual reminders.',
      parameters: {
        type: 'object',
        properties: {
          collection: { type: 'string', enum: kb.BOOK_IDS, description: 'Optional; defaults to authentic picks from Bukhari, Muslim and Nawawi.' },
          count: { type: 'integer', description: '1-5 (default 1)' },
        },
        required: [],
      },
    },
  },
];

const ACTIVITY_LABELS = {
  list_surahs: 'Opening the surah index',
  get_surah: 'Reading the Quran',
  search_quran: 'Searching the Quran',
  get_hadith: 'Opening a hadith',
  search_hadith: 'Searching the hadith library',
  random_hadiths: 'Choosing a hadith from the library',
};

function executeTool(name, args) {
  try {
    switch (name) {
      case 'list_surahs':
        return kb.quranMeta();
      case 'get_surah': {
        const s = kb.getSurah(args.surah);
        if (!s) return { error: `Surah "${args.surah}" not found. Use list_surahs.` };
        let from = parseInt(args.from, 10);
        let to = parseInt(args.to, 10);
        if (!Number.isInteger(from) || from < 1) from = 1;
        if (!Number.isInteger(to) || to < from) to = Math.min(s.meta.ay, from + 29);
        to = Math.min(to, from + 29, s.meta.ay);
        return {
          surah: s.meta.n,
          name: s.meta.en,
          arabicName: s.meta.ar,
          meaning: s.meta.tr,
          type: s.meta.type,
          totalVerses: s.meta.ay,
          returnedFrom: from,
          returnedTo: to,
          verses: s.ar.slice(from - 1, to).map((ar, i) => ({
            ref: `${s.meta.en} ${s.meta.n}:${from + i}`,
            arabic: ar,
            translation: s.en[from - 1 + i],
          })),
          note: to < s.meta.ay ? `Only ${from}-${to} shown; call get_surah again with from=${to + 1} to continue.` : undefined,
        };
      }
      case 'search_quran': {
        const limit = Math.min(Math.max(parseInt(args.limit, 10) || 6, 1), 12);
        return { results: kb.searchQuran(String(args.query || ''), limit) };
      }
      case 'get_hadith':
        return kb.getHadith(args.collection, parseInt(args.number, 10));
      case 'search_hadith': {
        const limit = Math.min(Math.max(parseInt(args.limit, 10) || 6, 1), 10);
        const matches = kb.searchHadith(String(args.query || ''), args.collection || null, limit);
        // Give the model exact Arabic immediately, avoiding a second retrieval
        // round just to quote the selected narration.
        const results = matches.map((m) => {
          const exact = kb.getHadith(m.collection, m.number);
          return { ...m, arabic: exact.arabic || '', english: exact.english || m.english };
        });
        return { results };
      }
      case 'random_hadiths': {
        const count = Math.min(Math.max(parseInt(args.count, 10) || 1, 1), 5);
        return { hadiths: kb.randomHadiths(args.collection || null, count, true) };
      }
      default:
        return { error: `Unknown tool ${name}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

/* ------------------------------------------------------------------ */
/* Chat — agentic loop with streaming                                    */
/* ------------------------------------------------------------------ */
async function upstreamChat(messages, tools) {
  return fetch(`${UPSTREAM}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      Origin: UPSTREAM,
      Referer: `${UPSTREAM}/`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({ model: MODEL, stream: true, messages, tools }),
  });
}

/**
 * Read an upstream SSE stream. Content deltas fire onContent live (so the
 * client gets the typewriter effect on the final answer round); tool-call
 * fragments are accumulated for the agent loop.
 */
async function consumeStream(upstream, onContent) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolCalls = new Map();
  let content = '';
  let finish = null;

  const handleData = (data) => {
    if (!data || data === '[DONE]') { finish = finish || 'done'; return; }
    let json;
    try { json = JSON.parse(data); } catch { return; }
    const choice = json.choices && json.choices[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') {
      content += delta.content;
      if (toolCalls.size === 0) onContent(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index || 0;
        if (!toolCalls.has(idx)) {
          toolCalls.set(idx, {
            id: tc.id || `call_${Date.now()}_${idx}`,
            type: 'function',
            function: { name: '', arguments: '' },
          });
        }
        const cur = toolCalls.get(idx);
        if (tc.id) cur.id = tc.id;
        if (tc.function) {
          cur.function.name += tc.function.name || '';
          cur.function.arguments += tc.function.arguments || '';
        }
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data:'));
      if (line) handleData(line.slice(5).trim());
    }
  }
  // flush tail
  const tail = buffer.split('\n').find((l) => l.startsWith('data:'));
  if (tail) handleData(tail.slice(5).trim());

  return { content, toolCalls: [...toolCalls.values()], finish };
}

async function handleChat(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return sendJson(res, 400, { error: { message: 'Invalid JSON body.' } });
  }

  const history = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-24)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 20000) }));

  if (!history.length) return sendJson(res, 400, { error: { message: 'No messages provided.' } });
  const webSearch = body.webSearch !== false;
  const tools = [...TOOL_DEFS];
  if (webSearch) tools.push({ type: 'web_search' });

  const messages = [{ role: 'system', content: buildSystemPrompt() }, ...history];

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.socket && res.socket.setNoDelay && res.socket.setNoDelay(true);

  const emitActivity = (label) => {
    res.write(`event: activity\ndata: ${JSON.stringify({ label })}\n\n`);
  };
  const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    let answered = false;
    for (let round = 0; round < 6; round++) {
      let upstream;
      try {
        upstream = await upstreamChat(messages, tools);
      } catch {
        emit({ choices: [{ delta: { content: '⚠ Muslio could not reach the model service. Please check your connection and try again.' } }] });
        answered = true;
        break;
      }
      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        let msg = `The model service returned an error (${upstream.status}). Please try again.`;
        if (upstream.status === 429) {
          msg = 'The free request limit has been reached (30 requests per minute, 500 per day). Please wait a while and try again.';
        } else {
          try {
            const j = JSON.parse(errText);
            if (j && j.error && j.error.message) msg = j.error.message;
          } catch {}
        }
        emit({ choices: [{ delta: { content: `⚠ ${msg}` } }] });
        answered = true;
        break;
      }

      let roleSent = false;
      const { content, toolCalls, finish } = await consumeStream(upstream, (piece) => {
        if (!roleSent) {
          emit({ choices: [{ delta: { role: 'assistant', content: '' } }] });
          roleSent = true;
        }
        emit({ choices: [{ delta: { content: piece } }] });
      });

      if (finish === 'tool_calls' || toolCalls.length) {
        messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
        for (const tc of toolCalls) {
          const name = tc.function.name;
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
          if (ACTIVITY_LABELS[name]) emitActivity(ACTIVITY_LABELS[name]);
          const result = executeTool(name, args);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name,
            content: JSON.stringify(result).slice(0, 60000),
          });
        }
        continue;
      }

      answered = roleSent || !!content;
      break;
    }

    // Safety net: if the model kept calling tools, ask once more with none.
    if (!answered) {
      const upstream = await upstreamChat(messages, webSearch ? [{ type: 'web_search' }] : []).catch(() => null);
      if (upstream && upstream.ok) {
        await consumeStream(upstream, (piece) => {
          emit({ choices: [{ delta: { content: piece } }] });
        });
      }
    }
    res.write('data: [DONE]\n\n');
  } catch (e) {
    if (!controller.signal.aborted) {
      try { emit({ choices: [{ delta: { content: `⚠ Something went wrong: ${e.message}. Please try again.` } }] }); } catch {}
    }
  } finally {
    res.end();
  }
}

/* ------------------------------------------------------------------ */
/* Router                                                               */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const [urlPath, qs] = req.url.split('?');
  const query = new URLSearchParams(qs || '');

  if (urlPath === '/api/health') {
    return sendJson(res, 200, { status: 'ok', service: 'muslio', model: MODEL });
  }
  if (urlPath.startsWith('/api/')) {
    if (req.method === 'GET') {
      const handled = kbRoutes(req, res, urlPath, query);
      if (handled !== false) return;
    }
    if (urlPath === '/api/chat' && req.method === 'POST') {
      try { return await handleChat(req, res); }
      catch (e) { if (!res.headersSent) return sendJson(res, 500, { error: { message: e.message } }); return res.end(); }
    }
    return sendJson(res, 404, { error: { message: 'Not found.' } });
  }

  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405);
  res.end('Method not allowed');
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, HOST, () => {
  // Reverse proxies (Render) recycle idle keep-alive sockets around ~75s.
  // Node's default keepAliveTimeout is 5s, which produces intermittent 502s.
  // Set these after listen(); some Node versions reset them during bind.
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
  // Node 18+ caps requests at 5 minutes; SSE chat streams must not be cut.
  server.requestTimeout = 0;
  server.timeout = 0;
  console.log(`Muslio is running on ${HOST}:${PORT} (model ${MODEL})`);
  if (!process.env.CHATWAVE_API_KEY) {
    console.warn('CHATWAVE_API_KEY is not set; using the development fallback. Set it as an environment variable for production.');
  }
});
