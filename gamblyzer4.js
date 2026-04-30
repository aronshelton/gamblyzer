#!/usr/bin/env node

/**
 * Gamblyzer v4 — core building blocks (NBA only).
 *
 * Step 1: Find bet — list today's NBA fixtures, then show **main lines only**
 * for full-game moneyline, spread, and game totals from DraftKings.
 *
 * OddsPapi returns prices in a unified decimal odds form via `player.price`
 * (see OddsPapi blog on prediction markets vs sportsbooks).
 * https://oddspapi.io/blog/polymarket-api-kalshi-api-vs-sportsbooks-the-developers-guide/
 *
 * Requires Node 18+ (fetch). Config: ./config.json with `oddsPapiKey`.
 *
 * Fixtures: see OddsPapi GET /v4/fixtures — `from`/`to` in ISO 8601, optional
 * `hasOdds` + `bookmakers` can hide games; we list without `hasOdds` and use
 * a wide UTC window so late games are not cut off.
 * https://oddspapi.io/en/docs/get-fixtures
 *
 * Usage: node gamblyzer4.js
 */

/** GET /v4/fixtures cooldown (docs: 2000ms between calls) */
const FIXTURES_COOLDOWN_MS = 2050;
/** Avoid bursting GET /v4/odds when scanning many fixtures */
const ODDS_COOLDOWN_MS = 350;

const readline = require('readline');
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = __dirname;
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const BASE = 'https://api.oddspapi.io/v4';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';

/** Book slugs on your plan — edit if OddsPapi menu differs */
const BOOKMAKERS = ['draftkings', 'polymarket'];

const SESSION = { markets: null };
const DEBUG = process.env.DEBUG === '1' || process.env.GAMBLYZER_DEBUG === '1';

function dbg(msg) {
  if (!DEBUG) return;
  console.log(style.sub(`[debug] ${msg}`));
}

/**
 * OddsPapi does not always use tournamentName === "NBA" for every NBA game.
 * Playoffs / play-in / cups often appear as "NBA Playoffs", slug "nba-playoffs", etc.
 * We include those while excluding obvious non-NBA basketball (G League, 2K, etc.).
 */
function isNbaFixture(f) {
  const name = String(f.tournamentName || '').trim();
  const slug = String(f.tournamentSlug || '').trim().toLowerCase();
  const lower = name.toLowerCase();

  if (/g\s*league|gleague|\b2k\b|esports|e-?nba\b/i.test(name)) return false;

  if (slug === 'nba' || slug.startsWith('nba-')) return true;
  if (lower === 'nba') return true;
  if (lower.startsWith('nba ') || lower.startsWith('nba-')) return true;
  if (lower.startsWith('nba playoffs')) return true;
  if (lower.includes('nba play-in') || lower.includes('nba play in')) return true;

  return false;
}

function isMlbFixture(f) {
  const name = String(f.tournamentName || '').trim();
  const slug = String(f.tournamentSlug || '').trim().toLowerCase();
  const lower = name.toLowerCase();

  // Exclude obvious non-MLB baseball
  if (/\bmilb\b|minor league|triple-a|double-a|single-a|rookie/i.test(name)) return false;
  if (/college|ncaa|juco|kbo|npb|cpbl|mexican league|little league/i.test(name)) return false;

  if (slug === 'mlb' || slug.startsWith('mlb-')) return true;
  if (lower === 'mlb') return true;
  if (lower.startsWith('mlb ') || lower.startsWith('mlb-')) return true;
  if (lower.includes('major league baseball')) return true;
  return false;
}

function isNhlFixture(f) {
  const name = String(f.tournamentName || '').trim();
  const slug = String(f.tournamentSlug || '').trim().toLowerCase();
  const lower = name.toLowerCase();

  // Exclude obvious non-NHL hockey
  if (/\bahl\b|american hockey league|echl|\bwhl\b|\bohl\b|\bqmjhl\b/i.test(name)) return false;
  if (/college|ncaa|khl|shl|liiga|del|national league|swiss|iihf|world championship/i.test(name)) return false;

  if (slug === 'nhl' || slug.startsWith('nhl-')) return true;
  if (lower === 'nhl') return true;
  if (lower.startsWith('nhl ') || lower.startsWith('nhl-')) return true;
  if (lower.includes('national hockey league')) return true;
  return false;
}

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  gray: '\x1b[90m', cyan: '\x1b[36m', green: '\x1b[32m', magenta: '\x1b[35m',
};
const style = {
  head: (s) => `${c.bold}${s}${c.reset}`,
  sub: (s) => `${c.gray}${s}${c.reset}`,
  dim: (s) => `${c.dim}${s}${c.reset}`,
  accent: (s) => `${c.cyan}${s}${c.reset}`,
};

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function getOddsKey() {
  const cfg = loadJSON(CONFIG_FILE, {});
  if (!cfg.oddsPapiKey) throw new Error(`oddsPapiKey missing from ${CONFIG_FILE}`);
  return cfg.oddsPapiKey;
}

function getAiKeys() {
  const cfg = loadJSON(CONFIG_FILE, {});
  if (!cfg.claudeKey) throw new Error(`claudeKey missing from ${CONFIG_FILE}`);
  return { claudeKey: cfg.claudeKey, geminiKey: cfg.geminiKey };
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function startSpinner(label) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r${c.cyan}${frames[i = (i + 1) % frames.length]}${c.reset} ${label}`);
  }, 80);
  return () => { clearInterval(id); process.stdout.write('\r' + ' '.repeat(Math.max(30, label.length + 5)) + '\r'); };
}

function wrapText(text, width) {
  const words = String(text || '').replace(/\s+/g, ' ').split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      if (line) lines.push(line);
      line = w;
    } else {
      line = (line ? line + ' ' : '') + w;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/** Strips an optional GAMBLYZER_SOURCES trailer from the combined narrative+sources string. */
function splitNarrativeAndSources(combined) {
  const s = String(combined || '');
  const m = s.split(/\n<<<GAMBLYZER_SOURCES>>>\n/);
  if (m.length < 2) return { narrative: s.trim(), sources: '' };
  return { narrative: m[0].trim(), sources: m.slice(1).join('\n<<<GAMBLYZER_SOURCES>>>\n').trim() };
}

function displayNarrative(text) {
  const { narrative: mainText, sources } = splitNarrativeAndSources(text);
  console.log(`\n${style.sub('THE CASE')}\n`);
  const parts = String(mainText || '').split(/The case in one line:/i);
  const body = (parts[0] || '').trim();
  const caseLine = parts[1] ? parts[1].trim() : '';
  if (body) console.log(body.split(/\n\n+/).map((p) => wrapText(p.trim(), 72)).join('\n\n'));
  if (caseLine) console.log(`\n${c.magenta}│${c.reset} ${style.head('The case in one line:')} ${caseLine}\n`);
  if (sources) {
    console.log(`\n${style.sub('RESEARCH (sources from web search; verify before relying on)')}\n`);
    console.log(wrapText(sources, 72) + '\n');
  }
}

function marketLabelForRow(r) {
  if (!r) return 'Market';
  if (r.bucket === 'moneyline') return 'Moneyline';
  if (r.bucket === 'spread') return 'Spread';
  if (r.bucket === 'total') return 'Total';
  return r.marketName || 'Market';
}

function outcomeLabelForRow(r) {
  if (!r) return '';
  if (r.bucket === 'spread') return spreadDisplayLabel(r);
  return String(r.outcome || '').trim();
}

function buildGroundingBlock(pick) {
  const { fixture, dkRow, sportLabel } = pick;
  return `GROUNDING DATA (from our feed — do not contradict or “correct” this):
- Sport: ${sportLabel}
- Matchup: ${fixture.participant2Name} @ ${fixture.participant1Name}
- Bet: ${outcomeLabelForRow(dkRow)} — ${marketLabelForRow(dkRow)}
- Odds: ${dkRow.american || '—'} (decimal ${Number.isFinite(dkRow.decimalOdds) ? dkRow.decimalOdds.toFixed(3) : '—'}) at DraftKings`;
}

/** Shorter line for the narrative call only (saves input tokens; research step still uses buildGroundingBlock). */
function buildGroundingBlockNarrative(pick) {
  const { fixture, dkRow, sportLabel } = pick;
  return `Feed facts (unchangeable): ${sportLabel} | ${fixture.participant2Name} @ ${fixture.participant1Name} | bet ${outcomeLabelForRow(dkRow)} / ${marketLabelForRow(dkRow)} | ${dkRow.american || '—'} (${Number.isFinite(dkRow.decimalOdds) ? dkRow.decimalOdds.toFixed(3) : '—'}) DraftKings`;
}

function researchPrompt(grounding) {
  return `You are a careful sports researcher. Gather only citable, search-backed notes for a bet (injuries, recent form, relevant news, H2H if available — but only with a source).

${grounding}

Use web search. For each item you can support with a real page, output ONE line in this exact format:
- FACT: <one sentence> | URL: <full https:// URL> | QUOTE: "<=32 words taken verbatim or nearly verbatim from the page>"

If a topic matters but you could not find a solid source, one line:
- GAP: <short description of what is missing> | (no reliable source in search results)

Do not give betting advice, a narrative, or hedging — bullets only. Aim for 4–10 lines when the web has anything useful. If search is barren, return a single GAP line explaining that.`;
}

function narrativePrompt(grounding, researchText) {
  const research = (researchText || '').trim() || '(No research; use only grounding. State that context was limited. No invented injuries/stats.)';
  return `Sports writer: short bet case (2–3 paragraphs). Facts only from FEED + RESEARCH; no new stats, injuries, or results. No URLs in prose. If research is GAPs/thin, say so, lean on matchup + odds.

${grounding}

RESEARCH:
${research}

End with: The case in one line: <one sentence>`;
}

function claudeTextFromResponse(data) {
  return (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

/** Caps research pasted into the narrative call so two Claude round-trips stay under per-minute input limits. */
const NARR_RESEARCH_BUDGET_CHARS = 9_000;

function compactResearchForNarrative(researchText) {
  const t = String(researchText || '').trim();
  if (t.length <= NARR_RESEARCH_BUDGET_CHARS) return t;
  return (
    `${t.slice(0, NARR_RESEARCH_BUDGET_CHARS)}\n[Truncated for API budget. The RESEARCH section after the case lists full citable lines.]`
  );
}

const CLAUDE_MAX_ATTEMPTS = 4;

/**
 * On failure, reads and discards the body so we can sleep/retry. Final non-OK response is returned with the same text body the caller would have read.
 */
async function claudeWithRetry(claudeKey, makeBody) {
  for (let attempt = 1; attempt <= CLAUDE_MAX_ATTEMPTS; attempt++) {
    const res = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(makeBody()),
    });
    if (res.ok) return res;
    const text = await res.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
    const msg = data?.error?.message || data?.message || text || '';
    const canRetry = (res.status === 429 || res.status >= 500) && attempt < CLAUDE_MAX_ATTEMPTS;
    if (!canRetry) {
      return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    const ra = res.headers.get('retry-after');
    let backoffMs;
    if (ra && /^\d+(\.\d+)?$/.test(String(ra).trim())) {
      backoffMs = Math.min(120_000, Math.max(0, parseFloat(String(ra).trim()) * 1000));
    } else if (res.status === 429) {
      const isTpm = /tokens? per minute|per minute\)|input tokens|rate limit/i.test(String(msg));
      backoffMs = isTpm ? 14_000 * attempt : 1_200 * attempt;
    } else {
      backoffMs = 800 * attempt;
    }
    if (!Number.isFinite(backoffMs) || backoffMs < 800) backoffMs = 1_200 * attempt;
    dbg(
      `Claude retryable error status=${res.status} attempt=${attempt}/${CLAUDE_MAX_ATTEMPTS} msg=${JSON.stringify(msg).slice(0, 200)}… sleepingMs=${backoffMs}`,
    );
    await sleep(backoffMs);
  }
  throw new Error('claudeWithRetry: exhausted without return');
}

async function geminiWithRetry(geminiKey, makePayload) {
  const gemUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
  let lastRes;
  for (let attempt = 1; attempt <= 3; attempt++) {
    lastRes = await fetch(gemUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePayload()),
    });
    if (lastRes.ok) return lastRes;
    if ((lastRes.status === 429 || lastRes.status >= 500) && attempt < 3) {
      const e = await lastRes.json().catch(() => ({}));
      const msg = e?.error?.message || e?.message || lastRes.statusText || '';
      const backoffMs = 800 * attempt;
      dbg(`Gemini retryable error status=${lastRes.status} attempt=${attempt}/3 msg=${JSON.stringify(msg)} sleepingMs=${backoffMs}`);
      await sleep(backoffMs);
      continue;
    }
    break;
  }
  return lastRes;
}

async function generateNarrativeForPick(pick, keys) {
  const grounding = buildGroundingBlock(pick);
  const rPrompt = researchPrompt(grounding);

  let researchText = '';
  let usedProvider = 'claude';

  {
    const stopR = startSpinner('AI is gathering citable research…');
    try {
      let res = await claudeWithRetry(keys.claudeKey, () => ({
        model: 'claude-sonnet-4-6',
        max_tokens: 1_200,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: rPrompt }],
      }));

      if (res.ok) {
        const data = await res.json();
        researchText = claudeTextFromResponse(data);
      } else {
        if (!keys.geminiKey) {
          const e = await res.json().catch(() => ({}));
          const msg = e?.error?.message || e?.message || res.statusText || '';
          throw new Error(`Claude failed (${res.status}): ${msg || 'unknown error'} — no Gemini fallback configured.`);
        }
        const errBody = await res.json().catch(() => ({}));
        const msg = errBody?.error?.message || errBody?.message || res.statusText || '';
        console.log(`\n  ${style.sub(`Claude research failed (${res.status}${msg ? `: ${msg}` : ''}) — falling back to Gemini…`)}`);
        usedProvider = 'gemini';
        res = await geminiWithRetry(keys.geminiKey, () => ({
          contents: [{ parts: [{ text: rPrompt }] }],
          tools: [{ googleSearch: {} }],
        }));
        if (!res.ok) {
          const e2 = await res.json().catch(() => ({}));
          const msg2 = e2?.error?.message || e2?.message || res.statusText || '';
          throw new Error(`Gemini research failed (${res.status}): ${msg2 || 'unknown error'}`);
        }
        const data = await res.json();
        researchText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      }
    } finally {
      try { stopR(); } catch {}
    }
  }

  if (!String(researchText || '').trim()) {
    researchText = '- GAP: No research text returned. | (no reliable source in search results)';
  }

  const nPrompt = narrativePrompt(buildGroundingBlockNarrative(pick), compactResearchForNarrative(researchText));
  let narrative = '';

  // One Claude+search + one plain Claude in the same minute can hit org TPM. Set GAMBLYZER_NARRATE_VIA_GEMINI=1 to do narrative on Gemini when a key exists.
  const narrateOnGemini = Boolean(keys.geminiKey && process.env.GAMBLYZER_NARRATE_VIA_GEMINI === '1');
  {
    const stopN = startSpinner(
      usedProvider === 'claude' && !narrateOnGemini ? 'AI is writing the case…' : 'AI is writing the case (Gemini)…',
    );
    try {
      if (narrateOnGemini) {
        const res2 = await geminiWithRetry(keys.geminiKey, () => ({
          contents: [{ parts: [{ text: nPrompt }] }],
          generationConfig: { temperature: 0.25, maxOutputTokens: 1_000 },
        }));
        if (!res2.ok) {
          const e2 = await res2.json().catch(() => ({}));
          const msg2 = e2?.error?.message || e2?.message || res2.statusText || '';
          throw new Error(`Gemini narrative failed (${res2.status}): ${msg2 || 'unknown error'}`);
        }
        const data = await res2.json();
        narrative = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      } else if (usedProvider === 'claude') {
        let res2 = await claudeWithRetry(keys.claudeKey, () => ({
          model: 'claude-sonnet-4-6',
          max_tokens: 1_000,
          temperature: 0.25,
          messages: [{ role: 'user', content: nPrompt }],
        }));
        if (res2.ok) {
          const data = await res2.json();
          narrative = claudeTextFromResponse(data);
        } else {
          if (!keys.geminiKey) {
            const errBody2 = await res2.json().catch(() => ({}));
            const msg0 = errBody2?.error?.message || errBody2?.message || res2.statusText || '';
            throw new Error(`Claude failed (${res2.status}): ${msg0 || 'unknown error'} — no Gemini fallback configured.`);
          }
          const errBody3 = await res2.json().catch(() => ({}));
          const msg = errBody3?.error?.message || errBody3?.message || res2.statusText || '';
          console.log(`\n  ${style.sub(`Claude narrative failed (${res2.status}${msg ? `: ${msg}` : ''}) — falling back to Gemini…`)}`);
          res2 = await geminiWithRetry(keys.geminiKey, () => ({
            contents: [{ parts: [{ text: nPrompt }] }],
            generationConfig: { temperature: 0.25, maxOutputTokens: 1_000 },
          }));
          if (!res2.ok) {
            const e2 = await res2.json().catch(() => ({}));
            const msg2 = e2?.error?.message || e2?.message || res2.statusText || '';
            throw new Error(`Gemini narrative failed (${res2.status}): ${msg2 || 'unknown error'}`);
          }
          const data = await res2.json();
          narrative = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        }
      } else {
        const res2 = await geminiWithRetry(keys.geminiKey, () => ({
          contents: [{ parts: [{ text: nPrompt }] }],
          generationConfig: { temperature: 0.25, maxOutputTokens: 1_000 },
        }));
        if (!res2.ok) {
          const e2 = await res2.json().catch(() => ({}));
          const msg2 = e2?.error?.message || e2?.message || res2.statusText || '';
          throw new Error(`Gemini narrative failed (${res2.status}): ${msg2 || 'unknown error'}`);
        }
        const data = await res2.json();
        narrative = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      }
    } finally {
      try { stopN(); } catch {}
    }
  }

  if (!String(narrative || '').trim()) {
    narrative = 'Online context was limited. The case in one line: The model returned an empty write-up — use the research bullets and posted odds, and double-check any claims.';
  }

  return `${narrative.trim()}\n\n<<<GAMBLYZER_SOURCES>>>\n${researchText.trim()}`;
}

/**
 * ISO 8601 `from` / `to` for GET /v4/fixtures — one local calendar day (machine TZ).
 * https://oddspapi.io/en/docs/get-fixtures
 */
function localCalendarDayBoundsIso(day = new Date()) {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** Keep only fixtures whose startTime falls on the same local calendar day as `day`. */
function filterFixturesByLocalCalendarDay(fixtures, day = new Date()) {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59, 999);
  return (Array.isArray(fixtures) ? fixtures : []).filter((f) => {
    const t = new Date(f.startTime);
    return !isNaN(t.getTime()) && t >= start && t <= end;
  });
}

function formatLocalCalendarDayLabel(day = new Date()) {
  return day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

/** Rows from GET /v4/tournaments — pick competitions that are NBA (not G League / WNBA / 2K). */
function isNbaTournamentRow(t) {
  const slug = String(t.tournamentSlug || '').toLowerCase();
  const name = String(t.tournamentName || '').toLowerCase();
  if (/g\s*league|gleague|\b2k\b|esports|e-?nba|wnba/i.test(`${slug} ${name}`)) return false;
  return slug === 'nba' || slug.startsWith('nba-') || name === 'nba' || name.startsWith('nba ') || name.startsWith('nba-');
}

function isMlbTournamentRow(t) {
  const slug = String(t.tournamentSlug || '').toLowerCase();
  const name = String(t.tournamentName || '').toLowerCase();
  if (/\bmilb\b|minor league|triple-a|double-a|single-a|rookie|college|ncaa|kbo|npb|cpbl/i.test(`${slug} ${name}`)) return false;
  return slug === 'mlb' || slug.startsWith('mlb-') || name === 'mlb' || name.startsWith('mlb ') || name.startsWith('mlb-') || name.includes('major league baseball');
}

function isNhlTournamentRow(t) {
  const slug = String(t.tournamentSlug || '').toLowerCase();
  const name = String(t.tournamentName || '').toLowerCase();
  if (/\bahl\b|american hockey league|echl|college|ncaa|khl|shl|liiga|del|iihf|world championship/i.test(`${slug} ${name}`)) return false;
  return slug === 'nhl' || slug.startsWith('nhl-') || name === 'nhl' || name.startsWith('nhl ') || name.startsWith('nhl-') || name.includes('national hockey league');
}

async function apiGet(key, pathAndQuery) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `${BASE}${pathAndQuery}${sep}apiKey=${key}`;
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();

    const status = res.status;
    const e = await res.json().catch(() => ({}));

    if (status === 429 && attempt < maxAttempts) {
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterSec =
        (retryAfterHeader && Number.isFinite(parseFloat(retryAfterHeader)) ? parseFloat(retryAfterHeader) : null) ??
        (e?.retryAfterSec != null && Number.isFinite(parseFloat(e.retryAfterSec)) ? parseFloat(e.retryAfterSec) : null) ??
        1;
      const backoffMs = Math.min(15000, Math.max(500, Math.ceil(retryAfterSec * 1000)));
      dbg(`rate limited (429) on ${pathAndQuery}; attempt=${attempt}/${maxAttempts - 1} sleepingMs=${backoffMs}`);
      await sleep(backoffMs);
      continue;
    }

    throw new Error(e.message || `OddsPapi ${status} on ${pathAndQuery}`);
  }

  throw new Error(`OddsPapi 429 on ${pathAndQuery}`);
}

async function fetchSports(key) {
  return apiGet(key, '/sports?language=en');
}

async function fetchTournamentsForSport(key, sportId) {
  return apiGet(key, `/tournaments?sportId=${sportId}&language=en`);
}

async function fetchFixturesQuery(key, query) {
  return apiGet(key, `/fixtures?${query}`);
}

/**
 * NBA fixtures for listing: prefer GET /v4/fixtures?tournamentId=… (per docs
 * tournamentId can be used alone; we still pass from/to for the slate).
 * Do not set hasOdds — with bookmakers it can exclude games your books have not
 * opened yet; without it we still get scheduled games.
 * https://oddspapi.io/en/docs/get-fixtures
 */
async function fetchNbaFixtures(key, sportId) {
  const { from, to } = localCalendarDayBoundsIso();
  const fromEnc = encodeURIComponent(from);
  const toEnc = encodeURIComponent(to);
  const baseQuery = `from=${fromEnc}&to=${toEnc}&statusId=0&language=en`;

  const merged = [];
  const seen = new Set();

  const pushChunk = (arr) => {
    for (const f of Array.isArray(arr) ? arr : []) {
      if (!f?.fixtureId || seen.has(f.fixtureId)) continue;
      if (!isNbaFixture(f)) continue;
      seen.add(f.fixtureId);
      merged.push(f);
    }
  };

  let firstFixtureCall = true;
  const fixtureGet = async (suffix) => {
    if (!firstFixtureCall) await sleep(FIXTURES_COOLDOWN_MS);
    firstFixtureCall = false;
    const data = await fetchFixturesQuery(key, `${suffix}&${baseQuery}`);
    pushChunk(data);
  };

  try {
    const tournaments = await fetchTournamentsForSport(key, sportId);
    // GET /v4/tournaments ~1000ms cooldown; space before first /fixtures call.
    await sleep(1050);
    const nbaTournaments = (Array.isArray(tournaments) ? tournaments : []).filter(isNbaTournamentRow);
    const ids = [...new Set(nbaTournaments.map((t) => t.tournamentId).filter((id) => id != null))];

    for (const tournamentId of ids) {
      await fixtureGet(`tournamentId=${tournamentId}`);
    }
  } catch {
    // fall through to sport-wide
  }

  // Augment with sport-wide query so games under odd tournament labels are not dropped.
  await fixtureGet(`sportId=${sportId}`);

  merged.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  return filterFixturesByLocalCalendarDay(merged);
}

async function fetchMlbFixtures(key, sportId) {
  const { from, to } = localCalendarDayBoundsIso();
  const fromEnc = encodeURIComponent(from);
  const toEnc = encodeURIComponent(to);
  const baseQuery = `from=${fromEnc}&to=${toEnc}&statusId=0&language=en`;

  const merged = [];
  const seen = new Set();

  const pushChunk = (arr) => {
    for (const f of Array.isArray(arr) ? arr : []) {
      if (!f?.fixtureId || seen.has(f.fixtureId)) continue;
      if (!isMlbFixture(f)) continue;
      seen.add(f.fixtureId);
      merged.push(f);
    }
  };

  let firstFixtureCall = true;
  const fixtureGet = async (suffix) => {
    if (!firstFixtureCall) await sleep(FIXTURES_COOLDOWN_MS);
    firstFixtureCall = false;
    const data = await fetchFixturesQuery(key, `${suffix}&${baseQuery}`);
    pushChunk(data);
  };

  try {
    const tournaments = await fetchTournamentsForSport(key, sportId);
    await sleep(1050);
    const mlbTournaments = (Array.isArray(tournaments) ? tournaments : []).filter(isMlbTournamentRow);
    const ids = [...new Set(mlbTournaments.map((t) => t.tournamentId).filter((id) => id != null))];
    for (const tournamentId of ids) {
      await fixtureGet(`tournamentId=${tournamentId}`);
    }
  } catch {
    // fall through
  }

  await fixtureGet(`sportId=${sportId}`);
  merged.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  return filterFixturesByLocalCalendarDay(merged);
}

async function fetchNhlFixtures(key, sportId) {
  const { from, to } = localCalendarDayBoundsIso();
  const fromEnc = encodeURIComponent(from);
  const toEnc = encodeURIComponent(to);
  const baseQuery = `from=${fromEnc}&to=${toEnc}&statusId=0&language=en`;

  const merged = [];
  const seen = new Set();

  const pushChunk = (arr) => {
    for (const f of Array.isArray(arr) ? arr : []) {
      if (!f?.fixtureId || seen.has(f.fixtureId)) continue;
      if (!isNhlFixture(f)) continue;
      seen.add(f.fixtureId);
      merged.push(f);
    }
  };

  let firstFixtureCall = true;
  const fixtureGet = async (suffix) => {
    if (!firstFixtureCall) await sleep(FIXTURES_COOLDOWN_MS);
    firstFixtureCall = false;
    const data = await fetchFixturesQuery(key, `${suffix}&${baseQuery}`);
    pushChunk(data);
  };

  try {
    const tournaments = await fetchTournamentsForSport(key, sportId);
    await sleep(1050);
    const nhlTournaments = (Array.isArray(tournaments) ? tournaments : []).filter(isNhlTournamentRow);
    const ids = [...new Set(nhlTournaments.map((t) => t.tournamentId).filter((id) => id != null))];
    for (const tournamentId of ids) {
      await fixtureGet(`tournamentId=${tournamentId}`);
    }
  } catch {
    // fall through
  }

  await fixtureGet(`sportId=${sportId}`);
  merged.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  return filterFixturesByLocalCalendarDay(merged);
}

async function fetchMarkets(key) {
  if (SESSION.markets) return SESSION.markets;
  const data = await apiGet(key, '/markets?language=en');
  const map = {};
  for (const m of data) {
    const outcomeNames = {};
    for (const o of (m.outcomes || [])) outcomeNames[o.outcomeId] = o.outcomeName;
    map[m.marketId] = {
      name: m.marketName,
      period: m.period,
      playerProp: m.playerProp,
      handicap: m.handicap,
      outcomeNames,
    };
  }
  SESSION.markets = map;
  return map;
}

async function fetchFixtureOdds(key, fixtureId) {
  const books = BOOKMAKERS.join(',');
  // verbosity=3 — richer payload per OddsPapi GET /v4/odds (optional).
  // https://oddspapi.io/en/docs/get-odds
  return apiGet(
    key,
    `/odds?fixtureId=${encodeURIComponent(fixtureId)}&bookmakers=${books}&language=en&verbosity=3`
  );
}

function inferMarketLabel(bookmakerMarketId) {
  const id = String(bookmakerMarketId || '').toLowerCase();
  if (id.includes('moneyline') || id.includes('h2h') || id.includes('1x2')) return 'Moneyline';
  if (id.includes('spread') || id.includes('handicap') || id.includes('asian')) return 'Spread';
  if (id.includes('total') || id.includes('over') || id.includes('under')) return 'Total';
  return 'Market';
}

function inferMarketBucket(marketLabel) {
  const s = String(marketLabel || '').toLowerCase();
  if (s.includes('total') || s.includes('over under') || (s.includes('over') && s.includes('under'))) return 'total';
  if (s.includes('spread') || s.includes('handicap') || s.includes('asian')) return 'spread';
  if (s.includes('moneyline') || s.includes('winner') || s.includes('1x2') || s.includes('result')) return 'moneyline';
  return 'other';
}

function isRegularTimeResultMarketName(marketName) {
  const s = String(marketName || '').toLowerCase();
  return s.includes('regular time result') || s.includes('regulation time result');
}

/** Full-game team totals — not the same as game O/U; exclude from totals comps. */
function isTeamTotalMarketName(marketName) {
  const s = String(marketName || '').toLowerCase();
  return /\bteam\s*[12]\b|\bteam\s*1\b|\bteam\s*2\b|team\s*total|player\s*total/.test(s);
}

/** Spread totals are almost always within this band; book ids look numeric too. */
function isReasonableSpreadHandicap(n) {
  if (!Number.isFinite(n)) return false;
  const a = Math.abs(n);
  return a >= 0.5 && a <= 60;
}

/** OddsPapi /v4/markets `handicap` on spread markets (when present). */
function parseDefHandicap(def) {
  if (!def || def.handicap == null || def.handicap === '') return null;
  const v = parseFloat(String(def.handicap).replace(',', '.'));
  return isReasonableSpreadHandicap(v) ? v : null;
}

/**
 * Some books embed the line in `bookmakerMarketId`, but segments are often huge
 * fixture/market ids (all digits). Scan **right to left** and keep only values
 * that look like real spread numbers.
 */
function parseHandicapFromBookmakerMarketId(bmid) {
  const s = String(bmid || '');
  const parts = s.split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (!/^[-+]?\d+(?:\.\d+)?$/.test(p)) continue;
    const v = parseFloat(p);
    if (isReasonableSpreadHandicap(v)) return v;
  }
  return null;
}

/** Signed spread number for keys/titles (+4.5 / -4.5). */
function formatSignedSpreadLine(n) {
  if (!Number.isFinite(n)) return '';
  if (n === 0) return '0';
  if (n > 0) return `+${n}`;
  return String(n);
}

function isGameLevelMarket(marketLabel, period) {
  const m = String(marketLabel || '').toLowerCase();
  const p = String(period || '').toLowerCase();
  const partialHints = [
    'first quarter', 'second quarter', 'third quarter', 'fourth quarter',
    '1st quarter', '2nd quarter', '3rd quarter', '4th quarter',
    'q1', 'q2', 'q3', 'q4',
    'first half', 'second half', '1st half', '2nd half', 'half time', 'halftime',
    '1h', '2h',
    // Hockey periods
    '1st period', '2nd period', '3rd period', 'first period', 'second period', 'third period',
  ];
  if (partialHints.some((h) => m.includes(h) || p.includes(h))) return false;

  // Baseball: exclude segmented markets (innings / first-5), but keep full-game
  // markets that mention "extra innings" (that's still full game).
  const combined = `${m} ${p}`;
  const hasExtraInnings = /\bextra innings?\b/.test(combined);
  const isInningSegment =
    // e.g. "1st inning", "2nd inning", "inning 1", "inning 2"
    /\b\d+(st|nd|rd|th)\s+inning\b/.test(combined) ||
    /\binning\s*\d+\b/.test(combined) ||
    // generic inning mention, but not "extra innings"
    (!hasExtraInnings && /\binning(s)?\b/.test(combined));
  const isFirstFive =
    /\b(first|1st)\s*(5|five)\b/.test(combined) ||
    /\bf5\b/.test(combined) ||
    /\bfirst\s*5\s*innings?\b/.test(combined);
  if (isInningSegment || isFirstFive) return false;

  return true;
}

function parseOutcomeLabel(bookmakerOutcomeId, p1Name, p2Name) {
  const raw = String(bookmakerOutcomeId || '');
  const id = raw.toLowerCase();
  if (id === 'home' || id === '1') return p1Name || 'Home';
  if (id === 'away' || id === '2') return p2Name || 'Away';
  if (id === 'draw' || id === 'x') return 'Draw';
  const ou = id.match(/^([\d.]+)\/(over|under)$/);
  if (ou) return `${ou[2][0].toUpperCase() + ou[2].slice(1)} ${ou[1]}`;
  const hcp = id.match(/^([+-]?[\d.]+)\/(home|away|1|2)$/);
  if (hcp) {
    const side = (hcp[2] === 'home' || hcp[2] === '1') ? (p1Name || 'Home') : (p2Name || 'Away');
    const val = parseFloat(hcp[1]);
    return `${side} ${val >= 0 ? '+' : ''}${val}`;
  }
  const threepart = id.match(/^(home|away|1|2)\/([+-]?[\d.]+)\/(over|under)$/);
  if (threepart) {
    const side = (threepart[1] === 'home' || threepart[1] === '1') ? (p1Name || 'Home') : (p2Name || 'Away');
    const dir = threepart[3][0].toUpperCase() + threepart[3].slice(1);
    return `${side} ${dir} ${threepart[2]}`;
  }
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : '';
}

function resolveOutcomeLabel({ def, outcomeIdStr, bookmakerOutcomeId, playerName, isPlayerProp, p1, p2 }) {
  let label = null;
  const rawName = def?.outcomeNames?.[parseInt(outcomeIdStr)];
  if (rawName) {
    const n = rawName.trim();
    if (n === '1' || n.toLowerCase() === 'home') label = p1;
    else if (n === '2' || n.toLowerCase() === 'away') label = p2;
    else if (n === 'X' || n.toLowerCase() === 'draw') label = 'Draw';
    else if (n === 'Over' || n === 'Under') {
      const lineFromId = (bookmakerOutcomeId || '').match(/^([\d.]+)\/(over|under)$/i);
      const line = lineFromId ? lineFromId[1] : (def?.handicap ?? null);
      label = line ? `${n} ${line}` : n;
    } else label = n;
  }
  const parsedFromId = parseOutcomeLabel(bookmakerOutcomeId, p1, p2);
  if (!label) label = parsedFromId;
  else {
    const hasLine = /[+-]\d/.test(parsedFromId);
    const isPlainTeam = label === p1 || label === p2;
    if (isPlainTeam && hasLine) label = parsedFromId;
  }
  if (isPlayerProp && playerName) label = `${playerName} ${label}`;
  return label;
}

function inferAbbr(name) {
  const s = String(name || '').replace(/[^A-Za-z]/g, '').toUpperCase();
  return s.length >= 3 ? s.slice(0, 3) : s;
}

function normName(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** participant1 = home, participant2 = away (OddsPapi fixture convention). */
function resolveSpreadSideKey(row) {
  const p1 = row.home;
  const p2 = row.away;
  const oc = String(row.outcome || '').trim();
  const nh = normName(p1);
  const na = normName(p2);
  const no = normName(oc);

  if (no === nh || nh.includes(no) || no.includes(nh)) return 'home';
  if (no === na || na.includes(no) || no.includes(na)) return 'away';

  const tm = oc.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?)\s*$/);
  if (tm) {
    const teamPart = normName(tm[1].trim());
    if (teamPart === nh || nh.includes(teamPart) || teamPart.includes(nh)) return 'home';
    if (teamPart === na || na.includes(teamPart) || teamPart.includes(na)) return 'away';
  }

  const boi = String(row.bookmakerOutcomeId || '').toLowerCase();
  const h = boi.match(/^([+-]?[\d.]+)\/(home|away|1|2)$/);
  if (h) return h[2] === 'home' || h[2] === '1' ? 'home' : 'away';

  return null;
}

/** Signed spread number for this side (home: market handicap, away: negated). */
function signedSpreadLineForRow(row) {
  const side = resolveSpreadSideKey(row);
  if (!side) return null;
  if (Number.isFinite(row.spreadHandicap)) {
    return side === 'home' ? row.spreadHandicap : -row.spreadHandicap;
  }
  const oc = String(row.outcome || '').trim();
  const m = oc.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?)\s*$/);
  if (m) return parseFloat(m[2]);
  const boi = String(row.bookmakerOutcomeId || '').toLowerCase();
  const h = boi.match(/^([+-]?[\d.]+)\/(home|away|1|2)$/);
  if (h) {
    const val = parseFloat(h[1]);
    const boiSide = h[2] === 'home' || h[2] === '1' ? 'home' : 'away';
    return boiSide === side ? val : -val;
  }
  return null;
}

/** Decimal odds → implied win probability (0–100), ignoring vig on multi-way markets */
function decimalToImpliedPct(dec) {
  if (!isFinite(dec) || dec <= 1) return null;
  return (1 / dec) * 100;
}

function fmtOdds(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v > 0) return `+${Math.round(v)}`;
  return `${Math.round(v)}`;
}

function parseAmericanOdds(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  const m = t.match(/^([+-]?\d+)/);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  return Number.isFinite(v) && v !== 0 ? v : null;
}

async function askOddsRange() {
  console.log(`\n${style.head('American odds range')} ${style.sub('(e.g. -200 to +300)')}`);
  const min = parseInt(await ask(`${c.cyan}Min:${c.reset} `), 10);
  const max = parseInt(await ask(`${c.cyan}Max:${c.reset} `), 10);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    console.log(style.sub('Invalid — min must be less than max.'));
    return null;
  }
  return { min, max };
}

/**
 * Flatten core lines from one fixture's odds payload.
 * Primary price: `player.price` (decimal odds) per OddsPapi unified format.
 */
function flattenCoreLines(oddsData, marketDefs, opts = {}) {
  const rows = [];
  if (!oddsData?.bookmakerOdds) return rows;
  const includeAllMarkets = !!opts.includeAllMarkets;

  const p1 = oddsData.participant1Name || 'Home';
  const p2 = oddsData.participant2Name || 'Away';
  const p1Abbr = oddsData.participant1Abbr || oddsData.participant1ShortName || '';
  const p2Abbr = oddsData.participant2Abbr || oddsData.participant2ShortName || '';

  for (const [bookSlug, bookData] of Object.entries(oddsData.bookmakerOdds)) {
    if (!bookData?.bookmakerIsActive || bookData.suspended) continue;

    for (const [marketIdStr, marketData] of Object.entries(bookData.markets || {})) {
      if (!marketData.marketActive) continue;

      const def = marketDefs[parseInt(marketIdStr)];
      const marketName = def ? def.name : inferMarketLabel(marketData.bookmakerMarketId);
      const period = def?.period ?? '';
      const bucket = inferMarketBucket(marketName);
      let spreadHandicap = bucket === 'spread' ? parseDefHandicap(def) : null;
      if (bucket === 'spread' && !Number.isFinite(spreadHandicap)) {
        spreadHandicap = parseHandicapFromBookmakerMarketId(marketData.bookmakerMarketId);
      }

      if (!includeAllMarkets) {
        if (!['moneyline', 'spread', 'total'].includes(bucket)) continue;
        if (def?.playerProp) continue;
        if (!isGameLevelMarket(marketName, period)) continue;
        if (isRegularTimeResultMarketName(marketName)) continue;
        if (bucket === 'total' && isTeamTotalMarketName(marketName)) continue;
      }

      for (const [outcomeIdStr, outcomeData] of Object.entries(marketData.outcomes || {})) {
        for (const [, player] of Object.entries(outcomeData.players || {})) {
          if (!player.active) continue;

          let outcome = resolveOutcomeLabel({
            def,
            outcomeIdStr,
            bookmakerOutcomeId: player.bookmakerOutcomeId,
            playerName: player.playerName,
            isPlayerProp: def?.playerProp || false,
            p1,
            p2,
          });
          const dec = typeof player.price === 'number' ? player.price : parseFloat(player.price);
          const american = player.priceAmerican != null ? String(player.priceAmerican) : '';

          rows.push({
            book: bookSlug,
            bucket,
            marketName,
            marketId: marketIdStr,
            outcomeId: outcomeIdStr,
            outcome,
            decimalOdds: dec,
            american,
            mainLine: !!player.mainLine,
            bookmakerOutcomeId: player.bookmakerOutcomeId ?? '',
            home: p1,
            away: p2,
            homeAbbr: p1Abbr,
            awayAbbr: p2Abbr,
            spreadHandicap,
          });
        }
      }
    }
  }
  return rows;
}

/**
 * DraftKings flags `mainLine` on several alternate spreads. Keep only the market
 * where **both** home and away sides are main — that is the featured full-game
 * spread (one `marketId`, shared handicap in /v4/markets).
 */
function narrowDraftkingsTwoWayMainSpreads(rows) {
  const dk = rows.filter(
    (r) => r.book === 'draftkings' && r.bucket === 'spread' && r.mainLine
  );
  const byMid = new Map();
  for (const r of dk) {
    if (!byMid.has(r.marketId)) byMid.set(r.marketId, []);
    byMid.get(r.marketId).push(r);
  }
  const goodMids = new Set();
  for (const [mid, list] of byMid) {
    const sides = new Set();
    for (const r of list) {
      const s = resolveSpreadSideKey(r);
      if (s) sides.add(s);
    }
    if (sides.has('home') && sides.has('away')) goodMids.add(mid);
  }
  if (!goodMids.size) return rows;
  return rows.filter((r) => {
    if (r.book !== 'draftkings' || r.bucket !== 'spread') return true;
    return goodMids.has(r.marketId);
  });
}

function pad(s, w) {
  const t = String(s);
  return t.length >= w ? t.slice(0, w) : t + ' '.repeat(w - t.length);
}

/**
 * DraftKings sometimes sets `mainLine` on only one moneyline side — keep both.
 */
function rowQualifiesForMainComparison(row) {
  if (row.book === 'draftkings' && row.bucket === 'moneyline') return true;
  return !!row.mainLine;
}

/** Stable key so the same selection across books groups together. */
function computeComparisonKey(row) {
  const p1 = row.home;
  const p2 = row.away;
  const oc = String(row.outcome || '').trim();
  const ocl = oc.toLowerCase();
  const b = row.bucket;

  if (b === 'moneyline') {
    const n1 = normName(p1);
    const n2 = normName(p2);
    const no = normName(oc);
    if (no === n1 || n1.includes(no) || no.includes(n1)) return 'ml::home';
    if (no === n2 || n2.includes(no) || no.includes(n2)) return 'ml::away';

    const a1 = String(row.homeAbbr || inferAbbr(p1)).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const a2 = String(row.awayAbbr || inferAbbr(p2)).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const up = oc.toUpperCase();
    // Ticker-style labels (e.g. trailing -PHI) — use trailing -CODE vs team abbr.
    const suf = up.match(/-([A-Z0-9]{2,5})$/);
    if (suf) {
      const code = suf[1];
      if (code === a1) return 'ml::home';
      if (code === a2) return 'ml::away';
      if (a1 && (a1.startsWith(code) || code.startsWith(a1))) return 'ml::home';
      if (a2 && (a2.startsWith(code) || code.startsWith(a2))) return 'ml::away';
    }

    return `ml::${ocl.replace(/\s+/g, ' ')}`;
  }

  if (b === 'spread') {
    // After `narrowDraftkingsTwoWayMainSpreads`, home/away is stable.
    const side = resolveSpreadSideKey(row);
    if (side) return `sp::side::${side}`;

    const m = oc.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?)\s*$/);
    if (m) {
      const team = m[1].trim().toLowerCase().replace(/\s+/g, ' ');
      const line = m[2];
      return `sp::${team}::${line}`;
    }
    const boi = String(row.bookmakerOutcomeId || '').toLowerCase();
    const h = boi.match(/^([+-]?[\d.]+)\/(home|away|1|2)$/);
    if (h) {
      const num = h[1];
      const sideTag = h[2];
      const t = sideTag === 'home' || sideTag === '1' ? p1 : p2;
      const team = String(t).toLowerCase().replace(/\s+/g, ' ');
      return `sp::${team}::${num}`;
    }
    // bookmakerOutcomeId is often an opaque id (see OddsPapi GET odds examples) —
    // use global market `handicap` from /v4/markets when OddsPapi attaches it.
    if (Number.isFinite(row.spreadHandicap)) {
      const nh = normName(p1);
      const na = normName(p2);
      const no = normName(oc);
      const isHomeSide = no === nh || nh.includes(no) || no.includes(nh);
      const isAwaySide = no === na || na.includes(no) || no.includes(na);
      if (isHomeSide || isAwaySide) {
        const team = (isHomeSide ? p1 : p2).toLowerCase().replace(/\s+/g, ' ');
        const lineVal = isHomeSide ? row.spreadHandicap : -row.spreadHandicap;
        const lineStr = formatSignedSpreadLine(lineVal);
        return `sp::${team}::${lineStr}`;
      }
    }
    return `sp::${ocl.replace(/\s+/g, ' ')}`;
  }

  if (b === 'total') {
    const m = oc.match(/^(over|under)\s+([\d.]+)\s*$/i);
    if (m) return `tot::${m[1].toLowerCase()}::${m[2]}`;
    return `tot::${ocl.replace(/\s+/g, ' ')}`;
  }

  return `misc::${ocl}`;
}

/** Human-readable "Team +4.5" for spread block titles when outcome omits the number. */
function spreadDisplayLabel(row) {
  const oc = String(row.outcome || '').trim();
  const m = oc.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?)\s*$/);
  if (m) return `${m[1].trim()} ${m[2]}`;

  const boi = String(row.bookmakerOutcomeId || '').toLowerCase();
  const h = boi.match(/^([+-]?[\d.]+)\/(home|away|1|2)$/);
  if (h) {
    const num = parseFloat(h[1]);
    const signed = Number.isFinite(num) && num > 0 ? `+${num}` : `${num}`;
    const side = h[2];
    const team = side === 'home' || side === '1' ? row.home : row.away;
    return `${team} ${signed}`;
  }

  if (Number.isFinite(row.spreadHandicap)) {
    const nh = normName(row.home);
    const na = normName(row.away);
    const no = normName(oc);
    const isHomeSide = no === nh || nh.includes(no) || no.includes(nh);
    const isAwaySide = no === na || na.includes(no) || no.includes(na);
    if (isHomeSide || isAwaySide) {
      const lineVal = isHomeSide ? row.spreadHandicap : -row.spreadHandicap;
      return `${oc} ${formatSignedSpreadLine(lineVal)}`;
    }
  }

  return oc;
}

/**
 * Group key for spreads is `sp::<team slug>::<line>` (see computeComparisonKey).
 * Some feeds omit the number in `outcome` but the key still carries it — use that for titles.
 */
function spreadLabelFromGroupKey(key) {
  if (!key || typeof key !== 'string' || !key.startsWith('sp::')) return null;
  if (key.startsWith('sp::side::')) return null;
  const rest = key.slice('sp::'.length);
  const sep = rest.lastIndexOf('::');
  if (sep < 0) return null;
  const teamSlug = rest.slice(0, sep);
  const lineRaw = rest.slice(sep + 2);
  if (!/^[-+]?\d/.test(lineRaw)) return null;
  const team = teamSlug
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  const n = parseFloat(lineRaw);
  const line =
    Number.isFinite(n) && n > 0 && !String(lineRaw).startsWith('+') ? `+${n}` : `${lineRaw}`;
  return `${team} ${line}`;
}

/**
 * When spread/total rows exist but no ≥2-book group printed, explain what the
 * feed contained (some books omit alternate ladders per game).
 */
function printOmittedCrossBookNotes(allRows, comps) {
  if (BOOKMAKERS.length <= 1) return;
  const books = [...BOOKMAKERS];
  const compBuckets = new Set((comps || []).map((g) => g.bucket));

  const countByBook = (bucket) => {
    const o = Object.fromEntries(books.map((b) => [b, 0]));
    for (const r of allRows || []) {
      if (r.bucket === bucket) o[r.book]++;
    }
    return o;
  };

  const lines = [];
  for (const bucket of ['spread', 'total']) {
    if (compBuckets.has(bucket)) continue;
    const c = countByBook(bucket);
    const n = books.reduce((s, b) => s + c[b], 0);
    if (!n) continue;
    const withData = books.filter((b) => c[b] > 0);
    const without = books.filter((b) => !c[b]);
    if (withData.length === 1) {
      lines.push(
        `  No ${bucket} blocks: only ${withData[0]} has ${bucket} data here (${c[withData[0]]} active row${c[withData[0]] === 1 ? '' : 's'}); ${without.join(' and ')} returned none for this fixture.`
      );
    } else {
      lines.push(
        `  No ${bucket} blocks: ${books.map((b) => `${b}=${c[b]}`).join(', ')} — need the same selection on all ${books.length} books.`
      );
    }
  }

  const mainQ = (allRows || []).filter(rowQualifiesForMainComparison);
  const dkTotAll = (allRows || []).filter((r) => r.book === 'draftkings' && r.bucket === 'total').length;
  const dkTotMq = mainQ.filter((r) => r.book === 'draftkings' && r.bucket === 'total').length;
  if (!compBuckets.has('total') && dkTotAll > dkTotMq && dkTotMq > 0) {
    lines.push(
      `  DraftKings also lists ${dkTotAll - dkTotMq} other game-total prices with mainLine=false (ignored for main-line compare).`
    );
  }

  if (lines.length) console.log(style.sub(`\n${lines.join('\n')}\n`));
}

function comparisonBlockTitle(ref, groupKey) {
  if (!ref) return '';
  if (ref.bucket === 'spread') {
    const fromKey = groupKey ? spreadLabelFromGroupKey(groupKey) : null;
    const label = fromKey || spreadDisplayLabel(ref);
    return `spread · ${label} (${ref.marketName})`;
  }
  return `${ref.bucket} · ${ref.outcome} (${ref.marketName})`;
}

/**
 * DK-first view, with Polymarket shown underneath when available.
 */
function printMainLineComparisons(rows) {
  const order = { moneyline: 0, spread: 1, total: 2 };

  const mainRows = (rows || []).filter(rowQualifiesForMainComparison);
  const dk = mainRows.filter((r) => r.book === 'draftkings');
  const polyAll = mainRows.filter((r) => r.book === 'polymarket');

  if (!dk.length) {
    console.log(style.sub('  (no DraftKings main lines for this game)\n'));
    return;
  }

  const dkSpreadTargets = { home: null, away: null };
  for (const r of dk) {
    if (r.bucket !== 'spread') continue;
    const side = resolveSpreadSideKey(r);
    if (!side) continue;
    const v = signedSpreadLineForRow(r);
    if (Number.isFinite(v)) dkSpreadTargets[side] = v;
  }

  const polyBest = new Map();
  for (const r of polyAll) {
    const key = computeComparisonKey(r);
    if (!polyBest.has(key)) {
      polyBest.set(key, r);
      continue;
    }

    const cur = polyBest.get(key);
    if (r.bucket === 'spread') {
      const side = resolveSpreadSideKey(r);
      const t = side ? dkSpreadTargets[side] : null;
      if (Number.isFinite(t)) {
        const dv = signedSpreadLineForRow(r);
        const cv = signedSpreadLineForRow(cur);
        const dd = Number.isFinite(dv) ? Math.abs(dv - t) : Infinity;
        const cd = Number.isFinite(cv) ? Math.abs(cv - t) : Infinity;
        if (dd < cd) polyBest.set(key, r);
      }
    } else {
      if (r.mainLine && !cur.mainLine) polyBest.set(key, r);
    }
  }

  const comps = dk.map((r) => ({
    key: computeComparisonKey(r),
    bucket: r.bucket,
    dk: r,
    poly: null,
  }));

  for (const g of comps) g.poly = polyBest.get(g.key) || null;

  comps.sort((a, b) => {
    const oa = order[a.bucket] ?? 9;
    const ob = order[b.bucket] ?? 9;
    if (oa !== ob) return oa - ob;
    return a.key.localeCompare(b.key);
  });

  const fmtLine = (r) => {
    if (!r || r.bucket !== 'spread') return '—';
    const v = signedSpreadLineForRow(r);
    return Number.isFinite(v) ? formatSignedSpreadLine(v) : '—';
  };

  const fmtRow = (label, r) => {
    const imp = decimalToImpliedPct(r?.decimalOdds);
    const impStr = imp != null ? `${imp.toFixed(1)}%` : '—';
    const decStr = r && isFinite(r.decimalOdds) ? r.decimalOdds.toFixed(3) : '—';
    const amStr = r?.american || '—';
    const lineCol = r?.bucket === 'spread' ? fmtLine(r) : '—';
    return `    ${pad(label, 12)}  ${pad(lineCol, 7)}  ${pad(decStr, 8)}  ${pad(impStr, 8)}  ${pad(amStr, 7)}`;
  };

  console.log(style.sub('\n  DraftKings main lines, with Polymarket underneath when available.\n'));

  for (const g of comps) {
    const title = g.dk ? comparisonBlockTitle(g.dk, g.key) : g.key;
    console.log(`\n  ${style.head('— ' + title + ' —')}`);
    console.log(fmtRow('draftkings', g.dk));
    if (g.poly) console.log(fmtRow('polymarket', g.poly));
    else console.log(style.sub(fmtRow('polymarket', null)));
  }

  console.log();
}

async function findBetFlow(key) {
  const sports = await fetchSports(key);
  const basketball = (Array.isArray(sports) ? sports : []).find((s) => String(s.sportName || '').toLowerCase() === 'basketball');
  const baseball = (Array.isArray(sports) ? sports : []).find((s) => String(s.sportName || '').toLowerCase() === 'baseball');
  const iceHockey = (Array.isArray(sports) ? sports : []).find((s) => String(s.sportName || '').toLowerCase() === 'ice hockey');

  console.log(`${style.head('Choose league:')}`);
  console.log(`  ${style.accent('1')} NBA`);
  console.log(`  ${style.accent('2')} MLB`);
  console.log(`  ${style.accent('3')} NHL`);
  console.log(`  ${style.accent('4')} All (NBA + MLB + NHL)`);
  const leagueChoice = (await ask(`${c.cyan}>${c.reset} `)).trim().toLowerCase();

  let league =
    leagueChoice === '2' || leagueChoice === 'mlb'
      ? { code: 'MLB', sport: baseball, fetchFixtures: fetchMlbFixtures }
      : leagueChoice === '3' || leagueChoice === 'nhl'
        ? { code: 'NHL', sport: iceHockey, fetchFixtures: fetchNhlFixtures }
        : leagueChoice === '4' || leagueChoice === 'all'
          ? { code: 'ALL', sport: null, fetchFixtures: null }
        : { code: 'NBA', sport: basketball, fetchFixtures: fetchNbaFixtures };

  if (league.code !== 'ALL' && !league.sport) {
    const sportName =
      league.code === 'MLB' ? 'Baseball' :
      league.code === 'NHL' ? 'Ice Hockey' :
      'Basketball';
    console.log(style.sub(`\n${sportName} sport not found in /v4/sports.\n`));
    return;
  }

  const stop = (() => {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    const id = setInterval(() => {
      process.stdout.write(`\r${c.cyan}${frames[i = (i + 1) % frames.length]}${c.reset} Loading ${league.code} fixtures…   `);
    }, 80);
    return () => { clearInterval(id); process.stdout.write('\r' + ' '.repeat(40) + '\r'); };
  })();

  let fixtureItems;
  try {
    const t0 = Date.now();
    if (league.code === 'ALL') {
      if (!basketball || !baseball || !iceHockey) {
        console.log(style.sub('\nAll leagues requires Basketball + Baseball + Ice Hockey sports to be present.\n'));
        return;
      }
      // Sequential to avoid bursting /fixtures and tripping 429s.
      const nba = await fetchNbaFixtures(key, basketball.sportId);
      await sleep(FIXTURES_COOLDOWN_MS);
      const mlb = await fetchMlbFixtures(key, baseball.sportId);
      await sleep(FIXTURES_COOLDOWN_MS);
      const nhl = await fetchNhlFixtures(key, iceHockey.sportId);
      const seen = new Set();
      const merged = [];
      const add = (arr, code) => {
        for (const f of arr || []) {
          if (!f?.fixtureId || seen.has(f.fixtureId)) continue;
          seen.add(f.fixtureId);
          merged.push({ fixture: f, leagueCode: code });
        }
      };
      add(nba, 'NBA');
      add(mlb, 'MLB');
      add(nhl, 'NHL');
      fixtureItems = merged.sort((a, b) => new Date(a.fixture.startTime) - new Date(b.fixture.startTime));
    } else {
      const fixtures = await league.fetchFixtures(key, league.sport.sportId);
      fixtureItems = (fixtures || []).map((f) => ({ fixture: f, leagueCode: league.code }));
    }
    dbg(`fixtures fetched: league=${league.code} fixtures=${fixtureItems.length} tookMs=${Date.now() - t0}`);
  } finally {
    stop();
  }

  if (!fixtureItems.length) {
    console.log(style.sub(`\nNo ${league.code} fixtures on ${formatLocalCalendarDayLabel()}.\n`));
    return;
  }

  const dayLabel = formatLocalCalendarDayLabel();
  console.log(`\n${style.head(`${league.code} — ${dayLabel} (${fixtureItems.length} fixture${fixtureItems.length === 1 ? '' : 's'})`)}\n`);

  const range = await askOddsRange();
  if (!range) return;
  dbg(`odds range: min=${range.min} max=${range.max}`);

  const stopOdds = (() => {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    let n = 0;
    const id = setInterval(() => {
      process.stdout.write(
        `\r${c.cyan}${frames[i = (i + 1) % frames.length]}${c.reset} Scanning DraftKings main lines… ${n}/${fixtureItems.length}`
      );
    }, 80);
    return {
      bump: () => { n++; },
      stop: () => { clearInterval(id); process.stdout.write('\r' + ' '.repeat(60) + '\r'); },
    };
  })();

  let marketDefs;
  const candidates = [];
  try {
    marketDefs = await fetchMarkets(key);

    let firstOddsCall = true;
    const t0 = Date.now();
    for (const { fixture, leagueCode } of fixtureItems) {
      if (!firstOddsCall) await sleep(ODDS_COOLDOWN_MS);
      firstOddsCall = false;

      const oddsData = await fetchFixtureOdds(key, fixture.fixtureId).catch(() => null);
      stopOdds.bump();
      if (!oddsData) continue;

      if (!oddsData.participant1Name) oddsData.participant1Name = fixture.participant1Name;
      if (!oddsData.participant2Name) oddsData.participant2Name = fixture.participant2Name;
      if (!oddsData.tournamentName) oddsData.tournamentName = fixture.tournamentName;

      let rows = flattenCoreLines(oddsData, marketDefs, { includeAllMarkets: !!league.rawAllMarkets });
      rows = narrowDraftkingsTwoWayMainSpreads(rows);

      const dkMain = league.rawAllMarkets
        ? rows.filter((r) => r.book === 'draftkings')
        : rows.filter(rowQualifiesForMainComparison).filter((r) => r.book === 'draftkings');

      for (const r of dkMain) {
        const am = parseAmericanOdds(r.american);
        if (am == null) continue;
        if (am < range.min || am > range.max) continue;
        candidates.push({
          fixture,
          dkRow: r,
          key: computeComparisonKey(r),
          rows,
          sportLabel: leagueCode,
        });
      }
    }
    dbg(`odds scan done: league=${league.code} fixtures=${fixtureItems.length} candidates=${candidates.length} tookMs=${Date.now() - t0}`);
  } finally {
    stopOdds.stop();
  }

  if (!candidates.length) {
    console.log(style.sub(`No DraftKings main lines found between ${fmtOdds(range.min)} and ${fmtOdds(range.max)}.\n`));
    return;
  }

  const fmtLine = (r) => {
    if (!r || r.bucket !== 'spread') return '—';
    const v = signedSpreadLineForRow(r);
    return Number.isFinite(v) ? formatSignedSpreadLine(v) : '—';
  };
  const fmtRow = (label, r) => {
    const imp = decimalToImpliedPct(r?.decimalOdds);
    const impStr = imp != null ? `${imp.toFixed(1)}%` : '—';
    const decStr = r && isFinite(r.decimalOdds) ? r.decimalOdds.toFixed(3) : '—';
    const amStr = r?.american || '—';
    const lineCol = r?.bucket === 'spread' ? fmtLine(r) : '—';
    return `    ${pad(label, 12)}  ${pad(lineCol, 7)}  ${pad(decStr, 8)}  ${pad(impStr, 8)}  ${pad(amStr, 7)}`;
  };

  console.log(style.sub(`Pool: ${candidates.length} DraftKings main-line row${candidates.length === 1 ? '' : 's'}\n`));
  console.log(style.sub('Actions: [l]ist DK lines · [lp] list DK + Polymarket · [r]andom pick · [enter] random pick'));
  const action = (await ask(`${c.cyan}>${c.reset} `)).trim().toLowerCase();

  if (action === 'l' || action === 'lp') {
    const includePoly = action === 'lp';
    let lastFixtureId = null;
    for (const it of candidates) {
      const { fixture, dkRow, key: gk, rows } = it;
      if (fixture.fixtureId !== lastFixtureId) {
        lastFixtureId = fixture.fixtureId;
        console.log(`\n${style.head(`${fixture.participant2Name} @ ${fixture.participant1Name}`)} ${style.sub(`(fixtureId=${fixture.fixtureId})`)}`);
      }

      console.log(`\n  ${style.head('— ' + comparisonBlockTitle(dkRow, gk) + ' —')}`);
      console.log(fmtRow('draftkings', dkRow));

      if (includePoly) {
        const polyCandidates = (rows || []).filter((r) => r.book === 'polymarket' && computeComparisonKey(r) === gk);
        let polyRow = polyCandidates.find((r) => r.mainLine) || polyCandidates[0] || null;
        if (dkRow.bucket === 'spread' && polyCandidates.length) {
          const side = resolveSpreadSideKey(dkRow);
          const t = side ? signedSpreadLineForRow(dkRow) : null;
          if (Number.isFinite(t)) {
            let best = null;
            let bestD = Infinity;
            for (const r of polyCandidates) {
              const v = signedSpreadLineForRow(r);
              if (!Number.isFinite(v)) continue;
              const d = Math.abs(v - t);
              if (d < bestD) {
                bestD = d;
                best = r;
              }
            }
            polyRow = best || polyRow;
          }
        }
        if (polyRow) console.log(fmtRow('polymarket', polyRow));
        else console.log(style.sub(fmtRow('polymarket', null)));
      }
    }
    await ask(style.sub('\n[enter] continue to random pick '));
  }

  // Randomization pattern matches gamblyzer.js / gamblyzer3.js
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  const { fixture, dkRow, key: groupKey, rows } = pick;

  const polyCandidates = (rows || []).filter((r) => r.book === 'polymarket' && computeComparisonKey(r) === groupKey);
  let polyRow = polyCandidates.find((r) => r.mainLine) || polyCandidates[0] || null;
  if (dkRow.bucket === 'spread' && polyCandidates.length) {
    const side = resolveSpreadSideKey(dkRow);
    const t = side ? signedSpreadLineForRow(dkRow) : null;
    if (Number.isFinite(t)) {
      let best = null;
      let bestD = Infinity;
      for (const r of polyCandidates) {
        const v = signedSpreadLineForRow(r);
        if (!Number.isFinite(v)) continue;
        const d = Math.abs(v - t);
        if (d < bestD) {
          bestD = d;
          best = r;
        }
      }
      polyRow = best || polyRow;
    }
  }

  console.log(`\n${style.head(`${fixture.participant2Name} @ ${fixture.participant1Name}`)}`);
  console.log(style.sub(`fixtureId=${fixture.fixtureId}  pool=${candidates.length} DK main-line row${candidates.length === 1 ? '' : 's'}`));
  console.log(`\n  ${style.head('— ' + comparisonBlockTitle(dkRow, groupKey) + ' —')}`);
  console.log(fmtRow('draftkings', dkRow));
  if (polyRow) console.log(fmtRow('polymarket', polyRow));
  else console.log(style.sub(fmtRow('polymarket', null)));

  let narrative = '';
  try {
    const aiKeys = getAiKeys();
    narrative = await generateNarrativeForPick(pick, aiKeys);
    if (narrative) displayNarrative(narrative);
  } catch (e) {
    console.log(style.sub(`\nNarrative failed: ${e.message}\n`));
  }

  await ask(style.sub('\n[enter] back '));
}

async function main() {
  console.log(`\n${c.bold}${c.cyan}Gamblyzer v4${c.reset} — NBA core markets (decimal odds)\n`);

  const key = getOddsKey();

  while (true) {
    console.log(`${style.head('What next?')}`);
    console.log(`  ${style.accent('1')} Find bet (today local; random DK main line)`);
    console.log(`  ${style.accent('q')} Quit`);
    const choice = (await ask(`${c.cyan}>${c.reset} `)).trim().toLowerCase();

    if (choice === '1') {
      try {
        await findBetFlow(key);
      } catch (e) {
        console.log(`\n${style.sub('Error:')} ${e.message}\n`);
      }
    } else if (choice === 'q' || choice === 'quit' || choice === 'exit') {
      break;
    }
  }

  rl.close();
  console.log(style.sub('\nbye.\n'));
}

main().catch((e) => {
  console.error(e.message || e);
  rl.close();
  process.exit(1);
});
