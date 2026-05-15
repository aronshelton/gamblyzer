#!/usr/bin/env node

/**
 * Gamblyzer v5 — same CLI as v4, but swaps OddsPapi → The Odds API v4.
 *
 * Data source: https://api.the-odds-api.com/v4
 * Core markets: h2h (moneyline), spreads, totals.
 * Books: DraftKings + Polymarket only (when available in the feed).
 *
 * Requires Node 18+ (fetch). Config: ./config.json with `oddsKey` (The Odds API key).
 *
 * Usage: node gamblyzer5.js
 */

/** Avoid bursting odds calls (The Odds API quota-based, but still be polite) */
const ODDS_COOLDOWN_MS = 450;

const readline = require('readline');
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = __dirname;
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const BASE = 'https://api.the-odds-api.com/v4';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';

/** Only what you asked for */
const BOOKMAKERS = ['draftkings', 'polymarket'];
/** The Odds API's "prediction markets" are typically under regions like us_ex */
const DEFAULT_REGIONS = process.env.ODDS_API_REGIONS || 'us,us2,us_ex';

const DEBUG = process.env.DEBUG === '1' || process.env.GAMBLYZER_DEBUG === '1';
function dbg(msg) {
  if (!DEBUG) return;
  console.log(style.sub(`[debug] ${msg}`));
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

function getOddsApiKey() {
  const cfg = loadJSON(CONFIG_FILE, {});
  const key = cfg.oddsKey || cfg.theOddsApiKey || cfg.oddsApiKey;
  if (!key) throw new Error(`oddsKey missing from ${CONFIG_FILE}`);
  return key;
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
  return `${t.slice(0, NARR_RESEARCH_BUDGET_CHARS)}\n[Truncated for API budget. The RESEARCH section after the case lists full citable lines.]`;
}

const CLAUDE_MAX_ATTEMPTS = 4;
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
    try { data = JSON.parse(text); } catch { data = { message: text }; }
    const msg = data?.error?.message || data?.message || text || '';
    const canRetry = (res.status === 429 || res.status >= 500) && attempt < CLAUDE_MAX_ATTEMPTS;
    if (!canRetry) return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });

    const ra = res.headers.get('retry-after');
    let backoffMs;
    if (ra && /^\d+(\.\d+)?$/.test(String(ra).trim())) backoffMs = Math.min(120_000, Math.max(0, parseFloat(String(ra).trim()) * 1000));
    else if (res.status === 429) backoffMs = 14_000 * attempt;
    else backoffMs = 800 * attempt;
    if (!Number.isFinite(backoffMs) || backoffMs < 800) backoffMs = 1_200 * attempt;
    dbg(`Claude retryable error status=${res.status} attempt=${attempt}/${CLAUDE_MAX_ATTEMPTS} sleepingMs=${backoffMs}`);
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
      await sleep(800 * attempt);
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

  if (!String(researchText || '').trim()) researchText = '- GAP: No research text returned. | (no reliable source in search results)';

  const nPrompt = narrativePrompt(buildGroundingBlockNarrative(pick), compactResearchForNarrative(researchText));
  let narrative = '';

  const narrateOnGemini = Boolean(keys.geminiKey && process.env.GAMBLYZER_NARRATE_VIA_GEMINI === '1');
  {
    const stopN = startSpinner(usedProvider === 'claude' && !narrateOnGemini ? 'AI is writing the case…' : 'AI is writing the case (Gemini)…');
    try {
      if (narrateOnGemini || usedProvider !== 'claude') {
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
      } else {
        const res2 = await claudeWithRetry(keys.claudeKey, () => ({
          model: 'claude-sonnet-4-6',
          max_tokens: 1_000,
          temperature: 0.25,
          messages: [{ role: 'user', content: nPrompt }],
        }));
        if (!res2.ok) {
          const errBody2 = await res2.json().catch(() => ({}));
          const msg0 = errBody2?.error?.message || errBody2?.message || res2.statusText || '';
          throw new Error(`Claude failed (${res2.status}): ${msg0 || 'unknown error'}`);
        }
        const data = await res2.json();
        narrative = claudeTextFromResponse(data);
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

/** ISO day label (machine TZ). */
function formatLocalCalendarDayLabel(day = new Date()) {
  return day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

/** Keep only events whose commence_time falls on the same local calendar day as `day`. */
function filterEventsByLocalCalendarDay(events, day = new Date()) {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59, 999);
  return (Array.isArray(events) ? events : []).filter((e) => {
    const t = new Date(e?.commence_time || e?.commenceTime || e?.start_time || e?.startTime);
    return !isNaN(t.getTime()) && t >= start && t <= end;
  });
}

function pad(s, w) {
  const t = String(s);
  return t.length >= w ? t.slice(0, w) : t + ' '.repeat(w - t.length);
}

function normName(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
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

function decimalToAmerican(dec) {
  const d = Number(dec);
  if (!Number.isFinite(d) || d <= 1) return null;
  const am = d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1));
  return am === 0 || !Number.isFinite(am) ? null : am;
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

async function oddsApiGet(key, pathAndQuery) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `${BASE}${pathAndQuery}${sep}apiKey=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }

  if (!res.ok) {
    const msg = (data && (data.message || data.error)) ? (data.message || data.error) : (text || res.statusText);
    throw new Error(`The Odds API ${res.status} on ${pathAndQuery}: ${msg}`);
  }

  // Helpful quota headers (not always present)
  const used = res.headers.get('x-requests-used') || res.headers.get('x-requests-used-by-endpoint');
  const remaining = res.headers.get('x-requests-remaining');
  if (used || remaining) dbg(`quota headers: used=${used || '—'} remaining=${remaining || '—'}`);

  return data;
}

async function fetchOddsForSport(key, sportKey) {
  const regions = DEFAULT_REGIONS;
  const markets = 'h2h,spreads,totals';
  const dateFormat = 'iso';
  const oddsFormat = 'decimal';

  // NOTE: Do NOT pass `bookmakers=` here.
  // Polymarket is not available for all sports/regions, and hard-filtering can
  // make it look like "no Polymarket" even when it's just under a different region set.
  return oddsApiGet(
    key,
    `/sports/${encodeURIComponent(sportKey)}/odds?regions=${encodeURIComponent(regions)}&markets=${encodeURIComponent(markets)}&dateFormat=${encodeURIComponent(dateFormat)}&oddsFormat=${encodeURIComponent(oddsFormat)}`
  );
}

function sportKeyForLeagueCode(code) {
  if (code === 'NBA') return 'basketball_nba';
  if (code === 'MLB') return 'baseball_mlb';
  if (code === 'NHL') return 'icehockey_nhl';
  if (code === 'EPL') return 'soccer_epl';
  return null;
}

function fixtureFromOddsEvent(ev) {
  return {
    fixtureId: ev?.id,
    participant1Name: ev?.home_team || ev?.homeTeam || 'Home',
    participant2Name: ev?.away_team || ev?.awayTeam || 'Away',
    startTime: ev?.commence_time || ev?.commenceTime || null,
    tournamentName: ev?.sport_title || ev?.sportTitle || '',
  };
}

/**
 * Flatten the The Odds API odds payload into the same row shape v4 expects.
 * - h2h -> moneyline
 * - spreads -> spread (outcome label includes the line)
 * - totals -> total (Over/Under with points)
 */
function flattenCoreLinesFromTheOddsApi(eventOdds) {
  const rows = [];
  const fixture = fixtureFromOddsEvent(eventOdds);
  const home = fixture.participant1Name;
  const away = fixture.participant2Name;

  for (const bm of (eventOdds?.bookmakers || [])) {
    const book = String(bm?.key || '').toLowerCase();
    if (!book) continue;
    if (!BOOKMAKERS.includes(book)) continue;

    for (const m of (bm?.markets || [])) {
      const mk = String(m?.key || '').toLowerCase();
      if (!mk) continue;

      let bucket = 'other';
      let marketName = m?.key || 'Market';
      if (mk === 'h2h') { bucket = 'moneyline'; marketName = 'Moneyline'; }
      else if (mk === 'spreads') { bucket = 'spread'; marketName = 'Spread'; }
      else if (mk === 'totals') { bucket = 'total'; marketName = 'Total'; }
      else continue;

      for (const o of (m?.outcomes || [])) {
        const name = String(o?.name || '').trim();
        const dec = Number(o?.price);
        if (!name || !Number.isFinite(dec)) continue;

        let outcome = name;
        let bookmakerOutcomeId = '';

        if (bucket === 'moneyline') {
          const n = normName(name);
          if (n === normName(home)) bookmakerOutcomeId = 'home';
          else if (n === normName(away)) bookmakerOutcomeId = 'away';
          else if (n === 'draw') bookmakerOutcomeId = 'draw';
        } else if (bucket === 'spread') {
          const pt = Number(o?.point);
          if (Number.isFinite(pt)) {
            const signed = pt > 0 ? `+${pt}` : `${pt}`;
            outcome = `${name} ${signed}`;
          }
          const n = normName(name);
          if (n === normName(home)) bookmakerOutcomeId = 'home';
          else if (n === normName(away)) bookmakerOutcomeId = 'away';
        } else if (bucket === 'total') {
          const pt = Number(o?.point);
          const n = normName(name);
          if (n === 'over' || n === 'under') {
            bookmakerOutcomeId = `${Number.isFinite(pt) ? pt : ''}/${n}`.replace(/\/$/, '');
            outcome = Number.isFinite(pt) ? `${name} ${pt}` : name;
          }
        }

        const am = decimalToAmerican(dec);
        rows.push({
          book,
          bucket,
          marketName,
          marketId: String(m?.key || ''),
          outcomeId: String(name),
          outcome,
          decimalOdds: dec,
          american: am != null ? (am > 0 ? `+${am}` : `${am}`) : '',
          mainLine: true,
          bookmakerOutcomeId,
          home,
          away,
          homeAbbr: '',
          awayAbbr: '',
          spreadHandicap: null,
        });
      }
    }
  }

  return rows;
}

/** participant1 = home, participant2 = away (Gamblyzer convention). */
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
  if (boi === 'home') return 'home';
  if (boi === 'away') return 'away';
  return null;
}

/** Signed spread number parsed from "Team -3.5" */
function signedSpreadLineForRow(row) {
  const oc = String(row.outcome || '').trim();
  const m = oc.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?)\s*$/);
  if (m) return parseFloat(m[2]);
  return null;
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
    return `ml::${ocl.replace(/\s+/g, ' ')}`;
  }

  if (b === 'spread') {
    const side = resolveSpreadSideKey(row);
    const line = signedSpreadLineForRow(row);
    if (side && Number.isFinite(line)) return `sp::${side}::${line}`;
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
  return oc;
}

function comparisonBlockTitle(ref) {
  if (!ref) return '';
  if (ref.bucket === 'spread') return `spread · ${spreadDisplayLabel(ref)} (${ref.marketName})`;
  return `${ref.bucket} · ${ref.outcome} (${ref.marketName})`;
}

function printMainLineComparisons(rows) {
  const order = { moneyline: 0, spread: 1, total: 2 };
  const mainRows = (rows || []).filter((r) => r && r.mainLine);
  const dk = mainRows.filter((r) => r.book === 'draftkings');
  const polyAll = mainRows.filter((r) => r.book === 'polymarket');

  if (!dk.length) {
    console.log(style.sub('  (no DraftKings lines for this game)\n'));
    return;
  }

  const polyBest = new Map();
  for (const r of polyAll) {
    const key = computeComparisonKey(r);
    if (!polyBest.has(key)) polyBest.set(key, r);
  }

  const comps = dk.map((r) => ({ key: computeComparisonKey(r), bucket: r.bucket, dk: r, poly: null }));
  for (const g of comps) g.poly = polyBest.get(g.key) || null;
  comps.sort((a, b) => {
    const oa = order[a.bucket] ?? 9;
    const ob = order[b.bucket] ?? 9;
    if (oa !== ob) return oa - ob;
    return a.key.localeCompare(b.key);
  });

  const fmtRow = (label, r) => {
    const imp = decimalToImpliedPct(r?.decimalOdds);
    const impStr = imp != null ? `${imp.toFixed(1)}%` : '—';
    const decStr = r && isFinite(r.decimalOdds) ? r.decimalOdds.toFixed(3) : '—';
    const amStr = r?.american || '—';
    const lineCol = r?.bucket === 'spread' ? (Number.isFinite(signedSpreadLineForRow(r)) ? String(signedSpreadLineForRow(r)) : '—') : '—';
    return `    ${pad(label, 12)}  ${pad(lineCol, 7)}  ${pad(decStr, 8)}  ${pad(impStr, 8)}  ${pad(amStr, 7)}`;
  };

  console.log(style.sub('\n  DraftKings lines, with Polymarket underneath when available.\n'));
  for (const g of comps) {
    const title = g.dk ? comparisonBlockTitle(g.dk) : g.key;
    console.log(`\n  ${style.head('— ' + title + ' —')}`);
    console.log(fmtRow('draftkings', g.dk));
    if (g.poly) console.log(fmtRow('polymarket', g.poly));
    else console.log(style.sub(fmtRow('polymarket', null)));
  }
  console.log();
}

async function findBetFlow(key) {
  console.log(`${style.head('Choose league:')}`);
  console.log(`  ${style.accent('1')} NBA`);
  console.log(`  ${style.accent('2')} MLB`);
  console.log(`  ${style.accent('3')} NHL`);
  console.log(`  ${style.accent('4')} EPL`);
  console.log(`  ${style.accent('5')} All (NBA + MLB + NHL + EPL)`);
  const leagueChoice = (await ask(`${c.cyan}>${c.reset} `)).trim().toLowerCase();

  const league =
    leagueChoice === '2' || leagueChoice === 'mlb' ? { code: 'MLB' } :
    leagueChoice === '3' || leagueChoice === 'nhl' ? { code: 'NHL' } :
    leagueChoice === '4' || leagueChoice === 'epl' ? { code: 'EPL' } :
    leagueChoice === '5' || leagueChoice === 'all' ? { code: 'ALL' } :
    { code: 'NBA' };

  const range = await askOddsRange();
  if (!range) return;
  dbg(`odds range: min=${range.min} max=${range.max}`);

  const stop = startSpinner(`Loading ${league.code} odds…`);
  let todays = [];
  try {
    if (league.code === 'ALL') {
      const keys = [
        { code: 'NBA', sportKey: sportKeyForLeagueCode('NBA') },
        { code: 'MLB', sportKey: sportKeyForLeagueCode('MLB') },
        { code: 'NHL', sportKey: sportKeyForLeagueCode('NHL') },
        { code: 'EPL', sportKey: sportKeyForLeagueCode('EPL') },
      ].filter((x) => x.sportKey);

      // Sequential to avoid burst + to keep quota usage predictable.
      for (let i = 0; i < keys.length; i++) {
        if (i) await sleep(ODDS_COOLDOWN_MS);
        const evs = await fetchOddsForSport(key, keys[i].sportKey);
        const dayEvs = filterEventsByLocalCalendarDay(evs).map((ev) => ({ ev, leagueCode: keys[i].code }));
        todays.push(...dayEvs);
      }
    } else {
      const sportKey = sportKeyForLeagueCode(league.code);
      if (!sportKey) {
        console.log(style.sub(`\nUnknown league.\n`));
        return;
      }
      const events = await fetchOddsForSport(key, sportKey);
      todays = filterEventsByLocalCalendarDay(events).map((ev) => ({ ev, leagueCode: league.code }));
    }
  } finally {
    try { stop(); } catch {}
  }

  if (!todays.length) {
    console.log(style.sub(`\nNo ${league.code} events with odds on ${formatLocalCalendarDayLabel()}.\n`));
    return;
  }

  const candidates = [];
  const t0 = Date.now();

  let n = 0;
  const scanSpinner = (() => {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    const id = setInterval(() => {
      process.stdout.write(`\r${c.cyan}${frames[i = (i + 1) % frames.length]}${c.reset} Scanning DraftKings lines… ${n}/${todays.length}`);
    }, 80);
    return () => { clearInterval(id); process.stdout.write('\r' + ' '.repeat(60) + '\r'); };
  })();

  try {
    for (const item of todays) {
      if (n) await sleep(ODDS_COOLDOWN_MS);
      n++;
      const ev = item.ev;
      const leagueCode = item.leagueCode || league.code;
      const fixture = fixtureFromOddsEvent(ev);
      const rows = flattenCoreLinesFromTheOddsApi(ev);

      if (DEBUG && n === 1) {
        const keys = (ev?.bookmakers || []).map((b) => String(b?.key || '').toLowerCase()).filter(Boolean);
        dbg(`bookmakers returned (sample event): ${[...new Set(keys)].sort().join(', ') || '(none)'}`);
      }

      const dkRows = rows.filter((r) => r.book === 'draftkings' && ['moneyline', 'spread', 'total'].includes(r.bucket));
      for (const r of dkRows) {
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
  } finally {
    try { scanSpinner(); } catch {}
  }

  dbg(`scan done: league=${league.code} events=${todays.length} candidates=${candidates.length} tookMs=${Date.now() - t0}`);

  if (!candidates.length) {
    console.log(style.sub(`No DraftKings lines found between ${fmtOdds(range.min)} and ${fmtOdds(range.max)}.\n`));
    return;
  }

  console.log(style.sub(`Pool: ${candidates.length} DraftKings row${candidates.length === 1 ? '' : 's'}\n`));
  console.log(style.sub('Actions: [l]ist DK lines · [lp] list DK + Polymarket · [r]andom pick · [enter] random pick'));
  const action = (await ask(`${c.cyan}>${c.reset} `)).trim().toLowerCase();

  const fmtRow = (label, r) => {
    const imp = decimalToImpliedPct(r?.decimalOdds);
    const impStr = imp != null ? `${imp.toFixed(1)}%` : '—';
    const decStr = r && isFinite(r.decimalOdds) ? r.decimalOdds.toFixed(3) : '—';
    const amStr = r?.american || '—';
    const lineCol = r?.bucket === 'spread' ? (Number.isFinite(signedSpreadLineForRow(r)) ? String(signedSpreadLineForRow(r)) : '—') : '—';
    return `    ${pad(label, 12)}  ${pad(lineCol, 7)}  ${pad(decStr, 8)}  ${pad(impStr, 8)}  ${pad(amStr, 7)}`;
  };

  if (action === 'l' || action === 'lp') {
    const includePoly = action === 'lp';
    let lastFixtureId = null;
    for (const it of candidates) {
      const { fixture, dkRow, key: gk, rows } = it;
      if (fixture.fixtureId !== lastFixtureId) {
        lastFixtureId = fixture.fixtureId;
        console.log(`\n${style.head(`${fixture.participant2Name} @ ${fixture.participant1Name}`)} ${style.sub(`(eventId=${fixture.fixtureId})`)}`);
      }

      console.log(`\n  ${style.head('— ' + comparisonBlockTitle(dkRow) + ' —')}`);
      console.log(fmtRow('draftkings', dkRow));

      if (includePoly) {
        const polyCandidates = (rows || []).filter((r) => r.book === 'polymarket' && computeComparisonKey(r) === gk);
        const polyRow = polyCandidates[0] || null;
        if (polyRow) console.log(fmtRow('polymarket', polyRow));
        else console.log(style.sub(fmtRow('polymarket', null)));
      }
    }
    await ask(style.sub('\n[enter] continue to random pick '));
  }

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  const { fixture, dkRow, key: groupKey, rows } = pick;
  const polyCandidates = (rows || []).filter((r) => r.book === 'polymarket' && computeComparisonKey(r) === groupKey);
  const polyRow = polyCandidates[0] || null;

  console.log(`\n${style.head(`${fixture.participant2Name} @ ${fixture.participant1Name}`)}`);
  console.log(style.sub(`eventId=${fixture.fixtureId}  pool=${candidates.length} DK row${candidates.length === 1 ? '' : 's'}`));
  console.log(`\n  ${style.head('— ' + comparisonBlockTitle(dkRow) + ' —')}`);
  console.log(fmtRow('draftkings', dkRow));
  if (polyRow) console.log(fmtRow('polymarket', polyRow));
  else console.log(style.sub(fmtRow('polymarket', null)));

  try {
    const aiKeys = getAiKeys();
    const narrative = await generateNarrativeForPick(pick, aiKeys);
    if (narrative) displayNarrative(narrative);
  } catch (e) {
    console.log(style.sub(`\nNarrative failed: ${e.message}\n`));
  }

  await ask(style.sub('\n[enter] back '));
}

async function main() {
  console.log(`\n${c.bold}${c.cyan}Gamblyzer v5${c.reset} — The Odds API (DK + Polymarket)\n`);
  const key = getOddsApiKey();

  while (true) {
    console.log(`${style.head('What next?')}`);
    console.log(`  ${style.accent('1')} Find bet (today local; random DK line)`);
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

