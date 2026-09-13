# Muslio

Muslio is a Muslim AI web application grounded in a bundled Islamic knowledge library. It combines exact local retrieval for scripture with GPT-5.4 for explanation and live web research for information that changes.

## What is included

### Quran

- All **114 surahs**
- All **6,236 ayat** in Uthmani Arabic
- Saheeh International English translation
- Complete surah reader
- Arabic and English full-text search
- Clickable answer citations such as `[[quran 2:255]]`

### Hadith

**36,512 narrations** in Arabic and English from ten bundled collections:

- Sahih al-Bukhari
- Sahih Muslim
- Sunan Abi Dawud
- Jami' al-Tirmidhi
- Sunan an-Nasa'i
- Sunan Ibn Majah
- Muwatta Malik
- Forty Hadith of an-Nawawi
- Forty Hadith Qudsi
- Forty Hadith of Shah Waliullah Dehlawi

The reader includes collection metadata, available grades, numbered lookups, random readings, cross-collection search, and clickable answer citations such as `[[hadith bukhari 1]]`.

"All hadith" cannot literally mean every narration and chain ever recorded in Islamic history. Muslio includes every Arabic/English narration in the ten listed datasets, including the six canonical Sunni collections and Muwatta Malik. It labels grades and does not treat every Sunan narration as automatically authentic.

## How answers work

1. `prompt.js` gives Muslio its Muslim-first methodology, source hierarchy, madhhab rules, safety behavior, writing style, citation format, and web-research policy.
2. `server.js` exposes six local function tools to GPT-5.4: Quran directory, surah reading, Quran search, hadith lookup, hadith search, and authentic random hadith selection.
3. The model must retrieve exact scripture instead of quoting from memory.
4. Local tool calls run against `kb.js` and the files in `data/`.
5. Final answers stream token by token to the browser.
6. Live web search remains available for prayer times, moon-sighting announcements, current events, weather, and other changing facts. The prompt tells Muslio not to use the web for Quran or hadith text.

## Interface

The application has no model selector. Muslio always uses the curated `gpt-5-4` model.

The UI includes:

- Saved conversations
- Streaming responses and stop control
- Full Quran reader and search
- Full hadith collection index and search
- Source drawer opened directly from answer citations
- A locally selected hadith on the welcome page
- Responsive mobile navigation
- A custom Muslio monogram

The design uses a restrained high-contrast ivory and deep-green system. It intentionally avoids gradients, glassmorphism, low-contrast dark mode, emoji headings, decorative icon grids, scroll reveal effects, and external UI kits.

## Run locally

No npm packages are required. Node 18 or later is enough.

```bash
node server.js
```

Then open `http://localhost:8080`.

Optional environment variables:

```bash
PORT=9000 CHATWAVE_API_KEY=cw-xxxx node server.js
```

Copy `.env.example` if you want a local template. For production, set `CHATWAVE_API_KEY` in the environment instead of relying on the development fallback in `server.js`.

## Deploy on Render

This repo is a Node web service that already binds `0.0.0.0` and `process.env.PORT`.

### Option A — Blueprint (`render.yaml`)

1. Push this repository to GitHub.
2. In [Render](https://dashboard.render.com), choose **New → Blueprint**.
3. Select the repo. Render reads `render.yaml`.
4. Set `CHATWAVE_API_KEY` when prompted (`sync: false` means it is not stored in the file).
5. Deploy.

### Option B — Web Service from the dashboard

| Setting | Value |
| --- | --- |
| Runtime | Node |
| Branch | the branch you want to ship |
| Build command | `npm install` |
| Start command | `npm start` |
| Health check path | `/api/health` |
| Instance | Starter or higher (Free sleeps; first load of the hadith catalog can be a few seconds) |

Environment variables:

| Key | Required | Notes |
| --- | --- | --- |
| `CHATWAVE_API_KEY` | Yes in production | ChatWave API key |
| `NODE_VERSION` | No | Defaults to `20` via `.node-version` |
| `NODE_ENV` | No | Set to `production` |
| `PORT` | No | Render injects this |

The service exposes `GET /api/health` for Render health checks. Streaming chat uses Server-Sent Events; the server disables Node's 5-minute request timeout and raises keep-alive timeouts so Render's proxy does not 502 idle sockets.

## Rebuild the knowledge data

```bash
python3 scripts/build-data.py
rm -rf data/raw
```

The builder downloads the source editions, aligns Arabic and English hadiths by collection number, writes compact collection files, and builds a cross-collection search catalog.

## Project layout

```text
render.yaml               Render Blueprint (Node web service)
server.js                 HTTP server, API proxy, local tool loop
prompt.js                 Muslio's system prompt
kb.js                     Quran and hadith retrieval/search engine
scripts/build-data.py     Reproducible data builder
data/quran/               114 Arabic and English surah files
data/hadith/              10 collections and search catalog
public/index.html         Application shell and library readers
public/styles.css         Responsive visual system
public/app.js             Streaming chat, history, search, citations
public/muslio-mark.svg     Custom product mark
```

## Data sources

- Quran Arabic and Saheeh International edition: [AlQuran Cloud API](https://alquran.cloud/api)
- Hadith Arabic/English editions and metadata: [fawazahmed0/hadith-api](https://github.com/fawazahmed0/hadith-api)
- Model and web search gateway: [ChatWave](https://chatwave.crunchflix.site/docs)

## Important note

Muslio can retrieve source text exactly, but AI explanations can still be mistaken. It is not a mufti and does not replace a qualified scholar. Personal rulings involving divorce, inheritance, medical treatment, finance, or unusual circumstances should be taken to a trustworthy scholar who understands the complete case.
