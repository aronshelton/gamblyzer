#!/usr/bin/env node

/**
 * Gamblyzer CLI
 * Pick a random bet within an odds range and get an AI-generated case for it.
 * Requires Node 18+ (for global fetch).
 *
 * Usage: node gamblyzer.js
 *
 * Config and saves live next to this script:
 *   ./config.json  — your API keys
 *   ./saves.json   — your saved picks
 *
 * OddsPapi v4 flow used here:
 *   1. GET /v4/sports                          → list all sports
 *   2. GET /v4/fixtures?sportId=X&from=&to=    → today's fixtures (includes participant names)
 *   3. GET /v4/odds?fixtureId=X&bookmakers=Y   → odds for each fixture
 *
 * Run menu option 4 first to see which bookmaker slugs are on your plan,
 * then update DEFAULT_BOOKMAKERS below accordingly.
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');

const CONFIG_DIR  = __dirname;
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SAVES_FILE  = path.join(CONFIG_DIR, 'saves.json');

const BASE       = 'https://api.oddspapi.io/v4';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';

// Update these after running menu option 4 to see your actual available slugs
const DEFAULT_BOOKMAKERS = ['draftkings'];
const PREDICTION_MARKET_SLUGS = ['kalshi', 'polymarket'];

// In-memory cache — avoids re-fetching market definitions each search
const SESSION = { markets: null };

// --- ANSI styles ------------------------------------------------------------
const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  gray: '\x1b[90m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m',
  white: '\x1b[37m', magenta: '\x1b[35m',
};
const style = {
  head:   (s) => `${c.bold}${c.white}${s}${c.reset}`,
  sub:    (s) => `${c.gray}${s}${c.reset}`,
  accent: (s) => `${c.cyan}${s}${c.reset}`,
  good:   (s) => `${c.green}${s}${c.reset}`,
  bad:    (s) => `${c.red}${s}${c.reset}`,
  warn:   (s) => `${c.yellow}${s}${c.reset}`,
  dim:    (s) => `${c.dim}${s}${c.reset}`,
  pred:   (s) => `${c.magenta}${s}${c.reset}`,
};

// --- Config / saves ---------------------------------------------------------
function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function getConfig() { return loadJSON(CONFIG_FILE, {}); }
function setConfig(cfg) { saveJSON(CONFIG_FILE, cfg); }
function getSaves()  { return loadJSON(SAVES_FILE, []); }
function setSaves(s) { saveJSON(SAVES_FILE, s); }

function migrateLegacyConfig() {
  const os = require('os');
  const legacyDir = path.join(os.homedir(), '.bet-picker');
  if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(path.join(legacyDir, 'config.json'))) {
    try { fs.copyFileSync(path.join(legacyDir, 'config.json'), CONFIG_FILE); } catch {}
  }
  if (!fs.existsSync(SAVES_FILE) && fs.existsSync(path.join(legacyDir, 'saves.json'))) {
    try { fs.copyFileSync(path.join(legacyDir, 'saves.json'), SAVES_FILE); } catch {}
  }
  const cfg = loadJSON(CONFIG_FILE, {});
  if (cfg.oddsKey && !cfg.oddsPapiKey) {
    cfg.oddsPapiKey = cfg.oddsKey;
    delete cfg.oddsKey;
    saveJSON(CONFIG_FILE, cfg);
  }
}

function loadKeys() {
  const cfg = getConfig();
  if (!cfg.oddsPapiKey) throw new Error(`oddsPapiKey missing from ${CONFIG_FILE}`);
  if (!cfg.claudeKey)   throw new Error(`claudeKey missing from ${CONFIG_FILE}`);
  return { oddsPapiKey: cfg.oddsPapiKey, claudeKey: cfg.claudeKey, geminiKey: cfg.geminiKey };
}

// --- Readline ---------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

// --- Spinner ----------------------------------------------------------------
function startSpinner(text) {
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r${c.cyan}${frames[i = (i+1) % frames.length]}${c.reset} ${text}   `);
  }, 80);
  return () => {
    clearInterval(id);
    process.stdout.write('\r' + ' '.repeat(text.length + 10) + '\r');
  };
}

// --- Odds helpers -----------------------------------------------------------
const fmtOdds  = (o) => o > 0 ? `+${o}` : `${o}`;
const fmtProb  = (dec) => `${Math.round((1 / dec) * 100)}%`;
const gameDate = (iso) => new Date(iso).toLocaleString('en-US', {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

// American odds → implied probability as a percentage (0–100)
function americanToImplied(american) {
  if (american < 0) return Math.abs(american) / (Math.abs(american) + 100) * 100;
  return 100 / (american + 100) * 100;
}

// Implied probability (0..1) → American odds
function probToAmerican(p) {
  if (!isFinite(p) || p <= 0 || p >= 1) return NaN;
  if (p >= 0.5) return Math.round(-(p / (1 - p)) * 100);
  return Math.round(((1 - p) / p) * 100);
}

function extractAskAmericanFromExchangeMeta(exchangeMeta) {
  if (!exchangeMeta || typeof exchangeMeta !== 'object') return NaN;

  // Try common "ask American" fields first.
  const americanCandidates = [
    exchangeMeta.askPriceAmerican,
    exchangeMeta.askAmerican,
    exchangeMeta.ask_price_american,
    exchangeMeta.ask?.priceAmerican,
    exchangeMeta.ask?.american,
    exchangeMeta.ask?.price_american,
    // Sometimes the market is explicitly "yes"/"no"
    exchangeMeta.yesAskPriceAmerican,
    exchangeMeta.yesAskAmerican,
    exchangeMeta.yes?.askPriceAmerican,
    exchangeMeta.yes?.askAmerican,
  ];
  for (const v of americanCandidates) {
    const n = parseInt(v);
    if (!isNaN(n)) return n;
  }

  // Otherwise, try ask probability / cents and convert.
  const probCandidates = [
    exchangeMeta.askPrice,
    exchangeMeta.askProbability,
    exchangeMeta.askProb,
    exchangeMeta.ask?.price,
    exchangeMeta.ask?.probability,
    exchangeMeta.ask?.prob,
    // Common "yes ask" style fields (often cents)
    exchangeMeta.yesAsk,
    exchangeMeta.yesAskPrice,
    exchangeMeta.yesAskProbability,
    exchangeMeta.yes?.ask,
    exchangeMeta.yes?.askPrice,
    exchangeMeta.yes?.askProbability,
    // Orderbook-like shapes
    exchangeMeta.orderBook?.ask,
    exchangeMeta.orderbook?.ask,
    exchangeMeta.orderBook?.asks?.[0]?.price,
    exchangeMeta.orderbook?.asks?.[0]?.price,
  ];
  for (const v of probCandidates) {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (!isFinite(n)) continue;
    const p = n > 1 ? n / 100 : n; // normalize cents/percent → 0..1
    const american = probToAmerican(p);
    if (!isNaN(american)) return american;
  }

  return NaN;
}

function todayRange() {
  const now    = new Date();
  const pad    = (n) => String(n).padStart(2, '0');
  const fmt    = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const today  = fmt(now);
  const tom    = new Date(now); tom.setDate(tom.getDate() + 1);
  return { from: today, to: fmt(tom) };
}

// Parse bookmakerOutcomeId into a readable label.
// OddsPapi uses labels like "home", "away", "draw", "3.5/over", "3.5/under",
// "-1.5/home" etc. for most bookmakers. Some use numeric IDs — fall back
// to p1Name/p2Name based on position in that case.
function parseOutcomeLabel(bookmakerOutcomeId, p1Name, p2Name, outcomePosition) {
  const raw = String(bookmakerOutcomeId || '');
  const id  = raw.toLowerCase();

  if (id === 'home' || id === '1')  return p1Name || 'Home';
  if (id === 'away' || id === '2')  return p2Name || 'Away';
  if (id === 'draw' || id === 'x')  return 'Draw';

  // "3.5/over" or "3.5/under"
  const ou = id.match(/^([\d.]+)\/(over|under)$/);
  if (ou) return `${ou[2][0].toUpperCase() + ou[2].slice(1)} ${ou[1]}`;

  // "-1.5/home" or "+2/away" handicap
  const hcp = id.match(/^([+-]?[\d.]+)\/(home|away|1|2)$/);
  if (hcp) {
    const side = (hcp[2] === 'home' || hcp[2] === '1') ? (p1Name || 'Home') : (p2Name || 'Away');
    const val  = parseFloat(hcp[1]);
    return `${side} ${val >= 0 ? '+' : ''}${val}`;
  }

  // Pinnacle three-part format: "home/29.5/over", "away/4.5/under", "team/line/direction"
  const threepart = id.match(/^(home|away|1|2)\/([+-]?[\d.]+)\/(over|under)$/);
  if (threepart) {
    const side = (threepart[1] === 'home' || threepart[1] === '1') ? (p1Name || 'Home') : (p2Name || 'Away');
    const dir  = threepart[3][0].toUpperCase() + threepart[3].slice(1);
    return `${side} ${dir} ${threepart[2]}`;
  }

  // Pinnacle numeric ID fallback: use position to infer home/away/draw
  if (/^\d+$/.test(raw)) {
    if (outcomePosition === 0) return p1Name || 'Home';
    if (outcomePosition === 1) return p2Name || 'Away';
    if (outcomePosition === 2) return 'Draw';
  }

  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function inferMarketLabel(bookmakerMarketId) {
  const id = (bookmakerMarketId || '').toLowerCase();
  if (id.includes('moneyline') || id.includes('h2h') || id.includes('1x2')) return 'Moneyline';
  if (id.includes('spread') || id.includes('handicap') || id.includes('asian')) return 'Spread';
  if (id.includes('total') || id.includes('over') || id.includes('under')) return 'Total';
  return 'Market';
}

function inferMarketBucket(marketLabel) {
  const s = String(marketLabel || '').toLowerCase();
  if (s.includes('total') || s.includes('over') || s.includes('under')) return 'total';
  if (s.includes('spread') || s.includes('handicap') || s.includes('asian')) return 'spread';
  if (s.includes('moneyline') || s.includes('winner') || s.includes('1x2') || s.includes('result')) return 'moneyline';
  return 'other';
}

function normalizePeriod(period) {
  const p = String(period || '').toLowerCase().trim();
  // We don’t know OddsPapi’s exact enum set across all sports, so normalize lightly.
  return p || 'unknown';
}

function isGameLevelMarket(marketLabel, period) {
  const m = String(marketLabel || '').toLowerCase();
  const p = String(period || '').toLowerCase();

  // Exclude partial-game markets (quarters/halves/periods/innings etc.)
  // We prefer a conservative filter: if it *mentions* a partial segment, skip it.
  const partialHints = [
    'first quarter', 'second quarter', 'third quarter', 'fourth quarter',
    '1st quarter', '2nd quarter', '3rd quarter', '4th quarter',
    'q1', 'q2', 'q3', 'q4',
    'first half', 'second half', '1st half', '2nd half', 'half time', 'halftime',
    '1h', '2h',
    'period', '1st period', '2nd period', '3rd period',
    'inning', '1st inning', '2nd inning', '3rd inning', '4th inning', '5th inning', '6th inning', '7th inning', '8th inning', '9th inning',
  ];
  if (partialHints.some(h => m.includes(h) || p.includes(h))) return false;

  // If the market explicitly says it’s full-game / match / incl overtime, treat as game-level.
  const gameHints = ['incl. overtime', 'including overtime', 'match', 'game', 'full time', 'full-time', 'regulation'];
  if (gameHints.some(h => m.includes(h) || p.includes(h))) return true;

  // Default: if it didn't look partial, allow.
  return true;
}

function outcomeKeyParts(outcomeLabel) {
  const raw = String(outcomeLabel || '').trim();
  const lower = raw.toLowerCase();

  // Over/Under keys: "Over 214.5" / "Under 214.5"
  const ou = lower.match(/^(over|under)\s+([+-]?\d+(?:\.\d+)?)$/);
  if (ou) return { core: ou[1], line: ou[2] };

  // Spread keys: "FC Barcelona -4.5" / "Boston Celtics +2"
  const spread = raw.match(/^(.*)\s+([+-]\d+(?:\.\d+)?)$/);
  if (spread) return { core: spread[1].trim().toLowerCase(), line: spread[2] };

  // Default: team name / draw / yes / no etc.
  return { core: lower, line: '' };
}

function inferAbbr(name) {
  const s = String(name || '').replace(/[^A-Za-z]/g, '').toUpperCase();
  if (s.length >= 3) return s.slice(0, 3);
  return s;
}

function normalizeKalshiOutcomeLabel(label, p1Name, p2Name, p1Abbr, p2Abbr) {
  const raw = String(label || '').trim();
  if (!raw) return raw;

  // If it already looks human-readable, keep it.
  if (raw.includes(' ') || /[+-]\d/.test(raw) || /^over|under/i.test(raw)) return raw;

  const up = raw.toUpperCase();
  const a1 = String(p1Abbr || inferAbbr(p1Name)).toUpperCase();
  const a2 = String(p2Abbr || inferAbbr(p2Name)).toUpperCase();

  // Common Kalshi-style tickers end in "-PHI" / "-BOS" etc.
  const tail = up.match(/(?:-|_)([A-Z]{2,4})$/);
  if (tail) {
    if (tail[1] === a1) return p1Name;
    if (tail[1] === a2) return p2Name;
  }

  // Or they may contain the abbr somewhere in the ticker.
  if (a1 && up.includes(a1)) return p1Name;
  if (a2 && up.includes(a2)) return p2Name;

  return raw;
}

// --- OddsPapi v4 API calls --------------------------------------------------
async function apiGet(key, pathAndQuery) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `${BASE}${pathAndQuery}${sep}apiKey=${key}`;
  const res = await fetch(url);
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.message || `OddsPapi ${res.status} on ${pathAndQuery}`);
  }
  return res.json();
}

// GET /v4/sports → [{ sportId, slug, sportName }]
async function fetchSports(key) {
  return apiGet(key, '/sports?language=en');
}

function filterAllowedSports(sports) {
  // Strict allowlist: you said your account only has these top-level sports.
  // This intentionally excludes variants like American Football, Field Hockey,
  // Basketball 3x3, Beach Soccer, eSports, Specials, etc.
  const allowedNames = new Set(['soccer', 'baseball', 'basketball', 'ice hockey']);
  const allowedSlugs = new Set([
    'soccer',
    'baseball',
    'basketball',
    'ice-hockey',
    'ice_hockey',
    'icehockey',
  ]);

  return (Array.isArray(sports) ? sports : []).filter((s) => {
    const slug = String(s?.slug || '').toLowerCase().trim();
    const name = String(s?.sportName || '').toLowerCase().trim();
    return allowedNames.has(name) || allowedSlugs.has(slug);
  });
}

// GET /v4/bookmakers → [{ bookmakerName, slug, liveOdds, cloneOf }]
async function fetchBookmakers(key) {
  return apiGet(key, '/bookmakers');
}

// GET /v4/fixtures — today's fixtures for a sport, with participant names embedded
// Returns [{ fixtureId, participant1Name, participant2Name, startTime, sportName, tournamentName, ... }]
async function fetchTodaysFixtures(key, sportId) {
  const { from, to } = todayRange();
  return apiGet(key, `/fixtures?sportId=${sportId}&from=${from}&to=${to}&statusId=0&hasOdds=true&language=en`);
}

// GET /v4/odds — odds for a single fixture, participant names also embedded
// Returns { fixtureId, participant1Name, participant2Name, bookmakerOdds: { [slug]: { markets: {...} } } }
async function fetchFixtureOdds(key, fixtureId, bookmakerSlugs) {
  const books = bookmakerSlugs.join(',');
  return apiGet(key, `/odds?fixtureId=${fixtureId}&bookmakers=${books}&language=en`);
}

// GET /v4/markets — all market definitions (no sportId filter — endpoint doesn't support it)
// Market IDs are globally unique across sports. Cached once for the session.
async function fetchMarkets(key) {
  if (SESSION.markets) return SESSION.markets;
  const data = await apiGet(key, '/markets?language=en');
  const map = {};
  for (const m of data) {
    const outcomeNames = {};
    for (const o of (m.outcomes || [])) outcomeNames[o.outcomeId] = o.outcomeName;
    map[m.marketId] = {
      name:         m.marketName,
      period:       m.period,
      playerProp:   m.playerProp,
      type:         m.marketType,
      handicap:     m.handicap,
      outcomeNames,
    };
  }
  SESSION.markets = map;
  return map;
}

// --- Parse a single fixture's odds into flat bet objects -------------------
function parseFixtureBets(oddsData, marketDefs, min, max) {
  const bets = [];
  if (!oddsData?.bookmakerOdds) return bets;

  const p1 = oddsData.participant1Name || 'Home';
  const p2 = oddsData.participant2Name || 'Away';
  const p1Abbr = oddsData.participant1Abbr || oddsData.participant1ShortName || '';
  const p2Abbr = oddsData.participant2Abbr || oddsData.participant2ShortName || '';

  for (const [bookSlug, bookData] of Object.entries(oddsData.bookmakerOdds)) {
    if (!bookData?.bookmakerIsActive || bookData.suspended) continue;

    for (const [marketIdStr, marketData] of Object.entries(bookData.markets || {})) {
      if (!marketData.marketActive) continue;

      const def          = marketDefs[parseInt(marketIdStr)];
      const marketLabel  = def ? def.name : inferMarketLabel(marketData.bookmakerMarketId);
      const marketPeriod = normalizePeriod(def?.period);
      const marketBucket = inferMarketBucket(marketLabel);
      const isPlayerProp = def?.playerProp || false;

      // Only consider full-game core markets to maximize apples-to-apples comparisons.
      if (isPlayerProp) continue;
      if (!['moneyline', 'spread', 'total'].includes(marketBucket)) continue;
      if (!isGameLevelMarket(marketLabel, marketPeriod)) continue;

      for (const [outcomeIdStr, outcomeData] of Object.entries(marketData.outcomes || {})) {
        for (const [, player] of Object.entries(outcomeData.players || {})) {
          if (!player.active) continue;

          const isPredMkt = PREDICTION_MARKET_SLUGS.includes(bookSlug);
          const isKalshi  = bookSlug === 'kalshi';

          // For Kalshi: if bid/ask is present, use ASK for a "buy" comparison.
          const rawAmerican = parseInt(player.priceAmerican);
          const askAmerican = isKalshi ? extractAskAmericanFromExchangeMeta(player.exchangeMeta) : NaN;
          const americanForCompare = (!isNaN(askAmerican) ? askAmerican : rawAmerican);
          const oddsSource = (!isNaN(askAmerican) ? 'ask' : 'headline');

          // For sportsbooks: only keep the primary line and filter by odds range
          // For prediction markets: keep everything — we need all prices for comparison
          if (!isPredMkt) {
            if (!player.mainLine) continue;
            const american = americanForCompare;
            if (isNaN(american) || american < min || american > max) continue;
          }

          const american = americanForCompare;
          if (isNaN(american)) continue;

          let outcomeLabel = resolveOutcomeLabel({
            def, outcomeIdStr,
            bookmakerOutcomeId: player.bookmakerOutcomeId,
            playerName:         player.playerName,
            isPlayerProp, p1, p2,
          });

          // Kalshi often uses tickers instead of human-readable team names.
          // Normalize those so we can match against sportsbook team-name outcomes.
          if (bookSlug === 'kalshi' && marketBucket === 'moneyline') {
            outcomeLabel = normalizeKalshiOutcomeLabel(outcomeLabel, p1, p2, p1Abbr, p2Abbr);
          }

          const { core: outcomeCore, line: outcomeLine } = outcomeKeyParts(outcomeLabel);

          bets.push({
            fixtureId:   oddsData.fixtureId,
            marketId:    parseInt(marketIdStr),
            outcomeId:   parseInt(outcomeIdStr),
            sport:       oddsData.sportName      || 'Sport',
            tournament:  oddsData.tournamentName || '',
            home:        p1,
            away:        p2,
            time:        oddsData.startTime,
            book:        bookSlug,
            bookType:    isPredMkt ? 'prediction-market' : 'sportsbook',
            market:      marketLabel,
            period:      marketPeriod,
            marketBucket,
            outcome:     outcomeLabel,
            outcomeCore,
            outcomeLine,
            odds:        american,
            oddsSource,
            oddsHeadline: rawAmerican,
            oddsAsk:      askAmerican,
            decimalOdds: player.price,
            bookmakerOutcomeId: player.bookmakerOutcomeId,
          });
        }
      }
    }
  }
  return bets;
}

// Resolve a readable outcome label using OddsPapi's market outcome definitions.
// Falls back to bookmakerOutcomeId parsing only if the definition isn't available.
function resolveOutcomeLabel({ def, outcomeIdStr, bookmakerOutcomeId, playerName, isPlayerProp, p1, p2 }) {
  let label = null;

  // Primary: use the OddsPapi outcome name (language-independent, not bookmaker-specific)
  const rawName = def?.outcomeNames?.[parseInt(outcomeIdStr)];
  if (rawName) {
    const n = rawName.trim();
    if (n === '1' || n.toLowerCase() === 'home')       label = p1;
    else if (n === '2' || n.toLowerCase() === 'away')  label = p2;
    else if (n === 'X' || n.toLowerCase() === 'draw')  label = 'Draw';
    else if (n === 'Over' || n === 'Under') {
      // Try to get the line from bookmakerOutcomeId (e.g. "224.5/over" from Pinnacle)
      const lineFromId = (bookmakerOutcomeId || '').match(/^([\d.]+)\/(over|under)$/i);
      const line = lineFromId ? lineFromId[1] : (def?.handicap || null);
      label = line ? `${n} ${line}` : n;
    } else {
      label = n;
    }
  }

  // If the market is a handicap/spread, OddsPapi outcome names can be "Home/Away"
  // which hides the actual line (e.g. -4.5). Prefer parsing bookmakerOutcomeId
  // when it carries the line so display matches what you see on books.
  const parsedFromId = parseOutcomeLabel(bookmakerOutcomeId, p1, p2, 0);
  if (!label) label = parsedFromId;
  else {
    // If we got a plain team name but the parsed label includes a line, use it.
    const hasLine = /[+-]\d/.test(parsedFromId);
    const isPlainTeam = label === p1 || label === p2;
    if (isPlainTeam && hasLine) label = parsedFromId;
  }

  // Prepend player name for props
  if (isPlayerProp && playerName) label = `${playerName} ${label}`;

  return label;
}

// --- Main bet fetching flow -------------------------------------------------
async function fetchAllBets(keys, selectedSports, bookmakerSlugs, min, max, opts = {}) {
  const stop = startSpinner('Finding today\'s fixtures…');
  let allBets = [];
  let fixtureCount = 0;
  let errorLog = [];

  try {
    // Step 1: fetch markets once + today's fixtures per sport in parallel
    const [marketDefs, ...fixturesBySport] = await Promise.all([
      fetchMarkets(keys.oddsPapiKey),
      ...selectedSports.map(async (sport) => {
        try {
          const fixtures = await fetchTodaysFixtures(keys.oddsPapiKey, sport.sportId);
          return { sport, fixtures: Array.isArray(fixtures) ? fixtures : [] };
        } catch (e) {
          errorLog.push(`${sport.sportName}: ${e.message}`);
          return { sport, fixtures: [] };
        }
      }),
    ]);

    let allFixtures = fixturesBySport.flatMap(({ fixtures }) => fixtures);
    const leagueFilters = Array.isArray(opts?.leagues) ? opts.leagues : null;
    if (leagueFilters && leagueFilters.length) {
      const allowed = new Set(leagueFilters.map(l => `${l.sportId}::${String(l.tournamentName || '').toLowerCase().trim()}`));
      allFixtures = allFixtures.filter(f => allowed.has(`${f.sportId}::${String(f.tournamentName || '').toLowerCase().trim()}`));
    }
    fixtureCount = allFixtures.length;

    if (fixtureCount === 0) {
      stop();
      return { bets: [], fixtureCount: 0, errorLog };
    }

    // Step 2: fetch odds for each fixture (sequentially to respect 500ms rate limit)
    stop();
    const stopOdds = startSpinner(`Fetching odds for ${fixtureCount} fixture${fixtureCount !== 1 ? 's' : ''}…`);

    try {
      for (const fixture of allFixtures) {
        try {
          const oddsData = await fetchFixtureOdds(keys.oddsPapiKey, fixture.fixtureId, bookmakerSlugs);
          // GET /v4/odds doesn't always return names — fill from fixtures call
          if (!oddsData.participant1Name) oddsData.participant1Name = fixture.participant1Name;
          if (!oddsData.participant2Name) oddsData.participant2Name = fixture.participant2Name;
          if (!oddsData.sportName)        oddsData.sportName        = fixture.sportName;
          if (!oddsData.tournamentName)   oddsData.tournamentName   = fixture.tournamentName;
          const bets = parseFixtureBets(oddsData, marketDefs, min, max);
          allBets = allBets.concat(bets);
        } catch (e) {
          errorLog.push(`Fixture ${fixture.fixtureId}: ${e.message}`);
        }
        // Respect the 500ms rate limit on GET /v4/odds
        await new Promise(r => setTimeout(r, 550));
      }
    } finally {
      stopOdds();
    }

  } catch (e) {
    stop();
    throw e;
  }

  return { bets: allBets, fixtureCount, errorLog };
}

// Returns all matched pairs regardless of edge — used for diagnostics
// Group bets by fixtureId + outcome name (case-insensitive).
// OddsPapi uses different marketIds for sportsbooks vs prediction markets,
// so ID-based matching fails. Outcome names (team names) are consistent across both.
function buildGroups(allBets) {
  const groups = {};
  for (const bet of allBets) {
    // Apples-to-apples grouping:
    // - fixtureId
    // - period (1Q vs 1H vs full game)
    // - market bucket (spread/total/moneyline)
    // - outcome core + line (so -4.5 doesn't match ML)
    const key = [
      bet.fixtureId,
      String(bet.period || 'unknown'),
      String(bet.marketBucket || 'other'),
      String(bet.outcomeCore || bet.outcome || '').toLowerCase().trim(),
      String(bet.outcomeLine || '').trim(),
    ].join('::');
    if (!groups[key]) groups[key] = { meta: bet, sportsbook: [], predMarket: [] };
    if (bet.bookType === 'sportsbook') groups[key].sportsbook.push(bet);
    else groups[key].predMarket.push(bet);
  }
  return groups;
}

function findAllMatchedPairs(allBets) {
  const groups = buildGroups(allBets);
  const pairs = [];
  for (const group of Object.values(groups)) {
    if (!group.sportsbook.length || !group.predMarket.length) continue;
    const sbBet     = group.sportsbook.reduce((best, b) => b.odds > best.odds ? b : best);
    const pmBet     = group.predMarket.reduce((best, b) => americanToImplied(b.odds) > americanToImplied(best.odds) ? b : best);
    const sbImplied = americanToImplied(sbBet.odds);
    const pmImplied = americanToImplied(pmBet.odds);
    pairs.push({ ...group.meta, sbBet, pmBet, sbImplied: Math.round(sbImplied), pmImplied: Math.round(pmImplied), edge: pmImplied - sbImplied });
  }
  return pairs;
}

// --- Match sportsbook vs prediction market prices and filter by edge -------
function findValueBets(allBets, threshold) {
  const groups = buildGroups(allBets);

  const sbOnly  = Object.values(groups).filter(g => g.sportsbook.length > 0 && g.predMarket.length === 0).length;
  const pmOnly  = Object.values(groups).filter(g => g.sportsbook.length === 0 && g.predMarket.length > 0).length;
  const matched = Object.values(groups).filter(g => g.sportsbook.length > 0 && g.predMarket.length > 0).length;

  const opportunities = [];
  for (const group of Object.values(groups)) {
    if (!group.sportsbook.length || !group.predMarket.length) continue;
    const sbBet     = group.sportsbook.reduce((best, b) => b.odds > best.odds ? b : best);
    const pmBet     = group.predMarket.reduce((best, b) => americanToImplied(b.odds) > americanToImplied(best.odds) ? b : best);
    const sbImplied = americanToImplied(sbBet.odds);
    const pmImplied = americanToImplied(pmBet.odds);
    const edge      = pmImplied - sbImplied;
    if (edge >= threshold) {
      opportunities.push({
        ...group.meta,
        sbBet,
        pmBet,
        // Keep the full set so we can display all comparisons.
        sportsbookBets: group.sportsbook,
        predMarketBets: group.predMarket,
        sbImplied: Math.round(sbImplied),
        pmImplied: Math.round(pmImplied),
        edge: Math.round(edge * 10) / 10,
      });
    }
  }

  return { opportunities: opportunities.sort((a, b) => b.edge - a.edge), sbOnly, pmOnly, matched };
}
async function selectSports(sports) {
  console.log(`\n${style.head('Available sports:')}`);
  sports.forEach((s, i) => console.log(`  ${style.dim(String(i+1).padStart(2))}. ${s.sportName}`));
  console.log(style.sub('\nNumbers separated by commas (1,3,5), a range (1-5), or "all":'));
  const input = (await ask(`${c.cyan}>${c.reset} `)).trim().toLowerCase();
  if (input === 'all' || input === '') return sports;

  const selected = new Set();
  for (const part of input.split(',').map(p => p.trim())) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const [a, b] = [parseInt(range[1]), parseInt(range[2])];
      for (let i = Math.min(a,b); i <= Math.max(a,b); i++) if (sports[i-1]) selected.add(sports[i-1]);
    } else {
      const n = parseInt(part);
      if (!isNaN(n) && sports[n-1]) selected.add(sports[n-1]);
    }
  }
  return [...selected];
}

async function selectLeagues(fixtures, selectedSports) {
  // Build a stable list of unique (sportId, tournamentName) pairs from today’s fixtures.
  const sportNameById = new Map((selectedSports || []).map(s => [s.sportId, s.sportName]));
  const seen = new Set();
  const leagues = [];
  for (const f of (fixtures || [])) {
    const sportId = f?.sportId;
    const tournament = (f?.tournamentName || '').trim();
    if (!sportId || !tournament) continue;
    const key = `${sportId}::${tournament.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    leagues.push({ sportId, sportName: sportNameById.get(sportId) || f.sportName || 'Sport', tournamentName: tournament });
  }

  leagues.sort((a, b) =>
    a.sportName.localeCompare(b.sportName) || a.tournamentName.localeCompare(b.tournamentName)
  );

  if (leagues.length === 0) return null;

  console.log(`\n${style.head('Available leagues today:')}`);
  leagues.forEach((l, i) => console.log(`  ${style.dim(String(i+1).padStart(2))}. ${l.sportName} · ${l.tournamentName}`));
  console.log(style.sub('\nNumbers separated by commas, a range (1-5), or "all" (enter = all):'));
  const input = (await ask(`${c.cyan}>${c.reset} `)).trim().toLowerCase();
  if (input === 'all' || input === '') return leagues;

  const selected = new Set();
  for (const part of input.split(',').map(p => p.trim())) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const [a, b] = [parseInt(range[1]), parseInt(range[2])];
      for (let i = Math.min(a,b); i <= Math.max(a,b); i++) if (leagues[i-1]) selected.add(leagues[i-1]);
    } else {
      const n = parseInt(part);
      if (!isNaN(n) && leagues[n-1]) selected.add(leagues[n-1]);
    }
  }
  return [...selected];
}

// --- Edge threshold input ---------------------------------------------------
async function askEdgeThreshold() {
  console.log(`\n${style.head('Minimum edge')} ${style.sub('(prediction market % − sportsbook % — try 5 to start)')}`);
  const input = await ask(`${c.cyan}Points:${c.reset} `);
  const threshold = parseFloat(input);
  if (isNaN(threshold) || threshold < 0) {
    console.log(style.bad('Invalid — enter a number like 5'));
    return null;
  }
  return threshold;
}

// --- Odds range input -------------------------------------------------------
async function askOddsRange() {
  console.log(`\n${style.head('American odds range')} ${style.sub('(e.g. -200 to +300)')}`);
  const min = parseInt(await ask(`${c.cyan}Min:${c.reset} `));
  const max = parseInt(await ask(`${c.cyan}Max:${c.reset} `));
  if (isNaN(min) || isNaN(max) || min >= max) {
    console.log(style.bad('Invalid — min must be less than max.'));
    return null;
  }
  return { min, max };
}

// --- Display ----------------------------------------------------------------
function displayValueBet(opp) {
  const tourney  = opp.tournament ? style.dim(` · ${opp.tournament}`) : '';
  const sbOdds   = opp.sbBet.odds > 0 ? style.good(fmtOdds(opp.sbBet.odds)) : style.head(fmtOdds(opp.sbBet.odds));
  const edgeColor = opp.edge >= 10 ? c.green : opp.edge >= 5 ? c.yellow : c.white;

  const sbMarket = opp.sbBet.market || opp.market;
  const pmMarket = opp.pmBet.market || opp.market;
  const marketStr = sbMarket === pmMarket ? sbMarket : `${sbMarket} / ${pmMarket}`;

  console.log(`\n${style.sub('─'.repeat(60))}`);
  console.log(style.dim(`${opp.sport.toUpperCase()}${tourney}`));
  console.log(style.head(`${opp.away} @ ${opp.home}`));
  console.log(style.sub(gameDate(opp.time)));
  console.log();
  console.log(`  ${style.accent(marketStr)}`);
  console.log();
  console.log(`  ${style.head(opp.outcome)}`);
  console.log();
  console.log(`  ${style.sub(opp.sbBet.book.padEnd(12))} ${c.bold}${sbOdds}${c.reset}  ${style.sub(`${opp.sbImplied}% implied`)}`);
  console.log(`  ${style.pred(opp.pmBet.book.padEnd(12))} ${style.pred(fmtOdds(opp.pmBet.odds))}  ${style.pred(`${opp.pmImplied}% implied`)}`);
  console.log();
  console.log(`  ${c.bold}${edgeColor}Edge: +${opp.edge} pts${c.reset}  ${style.dim(`crowd prices this ${opp.edge} points higher than ${opp.sbBet.book}`)}`);

  // Show all other available prices for this same outcome group (if present).
  const sbAll = Array.isArray(opp.sportsbookBets) ? opp.sportsbookBets : [];
  const pmAll = Array.isArray(opp.predMarketBets) ? opp.predMarketBets : [];
  const pmRefImplied = americanToImplied(opp.pmBet.odds);

  const dedupeBy = (arr, keyFn) => {
    const seen = new Set();
    const out = [];
    for (const item of arr) {
      const k = keyFn(item);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
    return out;
  };

  // OddsPapi can surface the same book/outcome/price multiple times via different
  // market IDs. For display, dedupe by (book, odds, market, outcome).
  const sbDeduped = dedupeBy(sbAll, (b) => `${b.book}::${b.odds}::${(b.market || '').toLowerCase()}::${(b.outcome || '').toLowerCase()}`);
  const pmDeduped = dedupeBy(pmAll, (b) => `${b.book}::${b.odds}::${(b.market || '').toLowerCase()}::${(b.outcome || '').toLowerCase()}`);

  const sbSorted = sbDeduped.slice().sort((a, b) => (b.odds - a.odds) || a.book.localeCompare(b.book));
  const pmSorted = pmDeduped.slice().sort((a, b) => (americanToImplied(b.odds) - americanToImplied(a.odds)) || a.book.localeCompare(b.book));

  // Only print the section if we actually have multiples to show.
  const hasExtra =
    sbSorted.length > 1 ||
    pmSorted.length > 1 ||
    (sbSorted.length === 1 && sbSorted[0].book !== opp.sbBet.book) ||
    (pmSorted.length === 1 && pmSorted[0].book !== opp.pmBet.book);

  if (hasExtra) {
    console.log();
    console.log(style.sub('Other prices (same outcome):'));

    if (sbSorted.length) {
      console.log(style.sub('  Sportsbooks:'));
      for (const b of sbSorted) {
        const imp = americanToImplied(b.odds);
        const e = Math.round((pmRefImplied - imp) * 10) / 10;
        const oddsStr = b.odds > 0 ? style.good(fmtOdds(b.odds)) : style.head(fmtOdds(b.odds));
        const edgeStr = e >= 0 ? style.good(`+${e}pt`) : style.bad(`${e}pt`);
        console.log(`    ${style.sub(b.book.padEnd(12))} ${c.bold}${oddsStr}${c.reset}  ${style.sub(`${Math.round(imp)}%`)}  ${style.sub('edge')} ${edgeStr}`);
      }
    }

    if (pmSorted.length) {
      console.log(style.sub('  Prediction markets:'));
      for (const b of pmSorted) {
        const imp = americanToImplied(b.odds);
        const oddsStr = style.pred(fmtOdds(b.odds));
        const src = b.oddsSource === 'ask' ? style.pred(' (ask)') : '';
        console.log(`    ${style.pred(b.book.padEnd(12))} ${oddsStr}${src}  ${style.pred(`${Math.round(imp)}% implied`)}`);
      }
    }
  }

  console.log(style.sub('─'.repeat(60)));
}

// --- Narrative (Claude + Gemini fallback) -----------------------------------
async function generateNarrative(opp, keys) {
  const stop = startSpinner('AI is researching recent news…');
  try {
    const prompt = `You are a confident sports analyst helping a bettor understand and evaluate a value bet.

Bet details:
Sport: ${opp.sport}${opp.tournament ? ` — ${opp.tournament}` : ''}
Game: ${opp.away} @ ${opp.home}
Market: ${opp.market}
Outcome: ${opp.outcome}
Sportsbook: ${opp.sbBet.book} at ${fmtOdds(opp.sbBet.odds)} (${opp.sbImplied}% implied)
Prediction market: ${opp.pmBet.book} pricing this at ${opp.pmImplied}% implied probability
Edge: +${opp.edge} points — the crowd thinks this is ${opp.edge} percentage points more likely than the sportsbook does

First, in one plain-English sentence, explain exactly what this bet means — what has to happen for it to win. Then search for recent news, injuries, current form, and head-to-head context and write a compelling 2-3 paragraph case for taking it, factoring in both the statistical edge and real-world factors. Be specific, cite real factors, don't hedge excessively. End with exactly "The case in one line:" followed by one punchy sentence.`;

    const claudeRes = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': keys.claudeKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (claudeRes.ok) {
      const data = await claudeRes.json();
      return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    }

    if (!keys.geminiKey) {
      const e = await claudeRes.json().catch(() => ({}));
      throw new Error(`Claude failed (${e.error?.message || claudeRes.status}) — no Gemini fallback configured.`);
    }

    stop();
    console.log(`\n  ${style.warn('⚠ Claude unavailable — falling back to Gemini…')}`);
    const stopG = startSpinner('Gemini is researching…');
    try {
      const gemRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${keys.geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            tools: [{ googleSearch: {} }],
          }),
        }
      );
      if (!gemRes.ok) { const e = await gemRes.json().catch(() => ({})); throw new Error(e.error?.message || `Gemini ${gemRes.status}`); }
      const data = await gemRes.json();
      return data.candidates[0].content.parts[0].text.trim();
    } finally { stopG(); }

  } finally { try { stop(); } catch {} }
}

function displayNarrative(text) {
  console.log(`\n${style.sub('THE CASE')}\n`);
  const parts    = text.split(/The case in one line:/i);
  const body     = parts[0].trim();
  const caseLine = parts[1] ? parts[1].trim() : '';
  console.log(body.split(/\n\n+/).map(p => wrapText(p.trim(), 72)).join('\n\n'));
  if (caseLine) console.log(`\n${c.blue}│${c.reset} ${style.head('The case in one line:')} ${caseLine}\n`);
}

function wrapText(text, width) {
  const words = text.replace(/\s+/g, ' ').split(' ');
  const lines = []; let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) { lines.push(line); line = w; }
    else { line = (line ? line + ' ' : '') + w; }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

// --- Save / view ------------------------------------------------------------
function saveBet(opp, narrative) {
  const saves = getSaves();
  saves.unshift({
    id: Date.now(),
    sport: opp.sport, tournament: opp.tournament,
    game: `${opp.away} @ ${opp.home}`,
    outcome: opp.outcome, market: opp.market,
    sbBook: opp.sbBet.book, sbOdds: opp.sbBet.odds, sbImplied: opp.sbImplied,
    pmBook: opp.pmBet.book, pmOdds: opp.pmBet.odds, pmImplied: opp.pmImplied,
    edge: opp.edge, time: opp.time, narrative,
    savedAt: new Date().toISOString(),
  });
  setSaves(saves);
  console.log(style.good(`✓ Saved to ${SAVES_FILE}`));
}

async function viewSaves() {
  const saves = getSaves();
  if (saves.length === 0) { console.log(style.sub('\nNo saved picks yet.\n')); return; }
  console.log(`\n${style.head(`Saved picks (${saves.length})`)}\n`);
  saves.forEach((p, i) => {
    const caseLine = (() => { const pts = (p.narrative||'').split(/The case in one line:/i); return pts[1] ? pts[1].trim() : ''; })();
    const sbOdds   = p.sbOdds > 0 ? style.good(fmtOdds(p.sbOdds)) : style.head(fmtOdds(p.sbOdds));
    const date     = new Date(p.savedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    console.log(`${style.dim(String(i+1).padStart(2))}. ${style.head(p.game)}  ${sbOdds}  ${style.yellow(`+${p.edge}pt edge`)}`);
    console.log(`    ${style.sub(`${p.outcome} · ${p.market} · ${p.sbBook} vs ${p.pmBook} · ${p.sport} · ${date}`)}`);
    if (caseLine) console.log(`    ${c.blue}│${c.reset} ${style.dim(caseLine)}`);
    console.log();
  });

  const answer = (await ask(`${c.cyan}[number] view full · [d N] delete · [enter] back:${c.reset} `)).trim();
  if (!answer) return;
  const delMatch = answer.match(/^d\s+(\d+)$/i);
  if (delMatch) {
    const idx = parseInt(delMatch[1]) - 1;
    if (saves[idx]) { saves.splice(idx, 1); setSaves(saves); console.log(style.sub('Deleted.')); }
    return viewSaves();
  }
  const n = parseInt(answer);
  if (!isNaN(n) && saves[n-1]) {
    const p = saves[n-1];
    console.log(`\n${style.sub('─'.repeat(60))}`);
    console.log(style.dim(p.sport.toUpperCase()));
    console.log(style.head(p.game)); console.log(style.sub(gameDate(p.time))); console.log();
    console.log(`  ${style.accent(p.market)}`); console.log();
    console.log(`  ${style.head(p.outcome)}`); console.log();
    const sbOdds = p.sbOdds > 0 ? style.good(fmtOdds(p.sbOdds)) : style.head(fmtOdds(p.sbOdds));
    console.log(`  ${style.sub(p.sbBook.padEnd(12))} ${c.bold}${sbOdds}${c.reset}  ${style.sub(`${p.sbImplied}% implied`)}`);
    console.log(`  ${style.pred(p.pmBook.padEnd(12))} ${style.pred(fmtOdds(p.pmOdds))}  ${style.pred(`${p.pmImplied}% implied`)}`);
    console.log();
    console.log(`  ${c.bold}${c.yellow}Edge: +${p.edge} pts${c.reset}`);
    console.log(style.sub('─'.repeat(60)));
    if (p.narrative) displayNarrative(p.narrative);
    await ask(`\n${c.gray}[enter] back${c.reset} `);
    return viewSaves();
  }
}

// --- List bookmakers --------------------------------------------------------
async function listBookmakers(keys) {
  const stop = startSpinner('Fetching bookmakers…');
  try {
    const books = await fetchBookmakers(keys.oddsPapiKey);
    stop();
    console.log(`\n${style.head(`Bookmakers on your plan (${books.length} total)`)}\n`);
    const predFound = books.filter(b => PREDICTION_MARKET_SLUGS.includes(b.slug));
    if (predFound.length > 0) {
      console.log(style.pred('Prediction markets found:'));
      predFound.forEach(b => console.log(`  ${style.pred('◈')} ${b.bookmakerName} · slug: ${style.accent(b.slug)}`));
      console.log();
    } else {
      console.log(style.warn('Kalshi / Polymarket not found — may require OddsPapi v5 B2B plan.\n'));
    }
    console.log(style.sub('All slugs (update DEFAULT_BOOKMAKERS at top of script with ones you want):'));
    const slugs = books.map(b => b.slug);
    for (let i = 0; i < slugs.length; i += 5) {
      console.log('  ' + slugs.slice(i, i+5).map(s => s.padEnd(22)).join(''));
    }
    console.log();
  } catch (e) {
    stop();
    console.log(style.bad(`\n✗ ${e.message}\n`));
  }
  await ask(`${c.gray}[enter] back${c.reset} `);
}

// --- Main pick flow ---------------------------------------------------------
async function pickFlow(keys) {
  let sports;
  const stopS = startSpinner('Loading sports…');
  try { sports = await fetchSports(keys.oddsPapiKey); stopS(); }
  catch (e) { stopS(); console.log(style.bad(`\n✗ ${e.message}\n`)); return; }
  if (!sports?.length) { console.log(style.warn('\nNo sports returned.\n')); return; }

  sports = filterAllowedSports(sports);
  if (!sports.length) {
    console.log(style.warn('\nNo allowed sports found on your account (expected soccer/baseball/basketball/ice hockey).\n'));
    return;
  }

  const selectedSports = await selectSports(sports);
  if (!selectedSports.length) { console.log(style.warn('No sports selected.')); return; }

  // Optional: constrain picks to specific leagues/tournaments (e.g. NBA vs Euroleague).
  // We fetch fixtures once here to build the league list; then we reuse the selection
  // as a filter when fetching odds.
  let leagueSelection = null;
  try {
    const stopF = startSpinner('Loading today\'s leagues…');
    const fixturesBySport = await Promise.all(
      selectedSports.map(async (sport) => {
        try {
          const fixtures = await fetchTodaysFixtures(keys.oddsPapiKey, sport.sportId);
          return Array.isArray(fixtures) ? fixtures : [];
        } catch {
          return [];
        } finally {
          // nothing
        }
      })
    );
    stopF();
    const allFixtures = fixturesBySport.flat();
    leagueSelection = await selectLeagues(allFixtures, selectedSports);
  } catch {
    // If league selection fails for any reason, just proceed without it.
    leagueSelection = null;
  }

  const range = await askOddsRange();
  if (!range) return;

  const threshold = await askEdgeThreshold();
  if (threshold === null) return;

  // Always fetch sportsbooks + prediction markets so we can compare them
  const allBookmakers = [...DEFAULT_BOOKMAKERS, ...PREDICTION_MARKET_SLUGS];
  const { bets, fixtureCount, errorLog } = await fetchAllBets(keys, selectedSports, allBookmakers, range.min, range.max, { leagues: leagueSelection });

  if (errorLog.length > 0) {
    console.log(style.warn(`\n⚠ ${errorLog.length} error(s) during fetch:`));
    errorLog.slice(0, 3).forEach(e => console.log(style.sub(`  ${e}`)));
    if (errorLog.length > 3) console.log(style.sub(`  … and ${errorLog.length - 3} more`));
  }

  if (fixtureCount === 0) {
    console.log(style.warn('\nNo fixtures found today — check bookmaker slugs via menu option 4.\n'));
    return;
  }

  const { opportunities, sbOnly, pmOnly, matched } = findValueBets(bets, threshold);

  // Always show matching diagnostic so we can see if the join is working
  console.log(style.sub(`  Matching: ${matched} paired · ${sbOnly} sportsbook-only · ${pmOnly} prediction market-only`));

  if (matched === 0) {
    console.log(style.warn('\nNo sportsbook/prediction market pairs matched on the same outcome.'));
    console.log(style.sub('This likely means OddsPapi uses different market/outcome IDs for prediction markets vs sportsbooks.'));
    console.log(style.sub('Printing sample IDs to diagnose:\n'));
    const sbSample = bets.filter(b => b.bookType === 'sportsbook').slice(0, 3);
    const pmSample = bets.filter(b => b.bookType === 'prediction-market').slice(0, 3);
    console.log(style.head('Sportsbook samples:'));
    sbSample.forEach(b => console.log(
      `  fixtureId=${b.fixtureId}  period=${b.period}  bucket=${b.marketBucket}  marketId=${b.marketId}  outcomeId=${b.outcomeId}  market="${b.market}"  outcome="${b.outcome}"  line="${b.outcomeLine || ''}"  book=${b.book}`
    ));
    console.log(style.head('\nPrediction market samples:'));
    pmSample.forEach(b => console.log(
      `  fixtureId=${b.fixtureId}  period=${b.period}  bucket=${b.marketBucket}  marketId=${b.marketId}  outcomeId=${b.outcomeId}  market="${b.market}"  outcome="${b.outcome}"  line="${b.outcomeLine || ''}"  source=${b.oddsSource || ''}  book=${b.book}`
    ));
    return;
  }

  if (opportunities.length === 0) {
    console.log(style.warn(`\nNo value bets found with edge ≥ ${threshold} points across ${matched} matched pairs.`));

    // Show actual edge values so we can understand the distribution
    const allMatched = findAllMatchedPairs(bets);
    if (allMatched.length > 0) {
      console.log(style.sub('\nEdge distribution for matched pairs (pmImplied − sbImplied):'));
      allMatched
        .sort((a, b) => b.edge - a.edge)
        .forEach(p => {
          const edgeStr = p.edge >= 0 ? style.good(`+${p.edge.toFixed(1)}pts`) : style.bad(`${p.edge.toFixed(1)}pts`);
          console.log(`  ${edgeStr}  ${style.head(p.outcome)}  ${style.sub(`${p.market} · ${p.sbBet.book} ${fmtOdds(p.sbBet.odds)} (${p.sbImplied}%) vs ${p.pmBet.book} ${fmtOdds(p.pmBet.odds)} (${p.pmImplied}%)`)}`);
        });
    }
    return;
  }

  console.log(style.sub(`\nFound ${opportunities.length} value bet${opportunities.length !== 1 ? 's' : ''} with ≥${threshold}pt edge across ${fixtureCount} fixtures (sorted best edge first)`));

  let keepGoing = true;
  while (keepGoing) {
    // Pick randomly from the top half to surface best edges more often
    const pool = opportunities.slice(0, Math.max(1, Math.ceil(opportunities.length / 2)));
    const opp  = pool[Math.floor(Math.random() * pool.length)];
    displayValueBet(opp);

    let narrative = '';
    try {
      narrative = await generateNarrative(opp, keys);
      displayNarrative(narrative);
    } catch (e) {
      console.log(style.bad(`\n✗ Narrative failed: ${e.message}\n`));
    }

    const action = (await ask(`${c.cyan}[s]ave · [p]ick another · [enter] back:${c.reset} `)).toLowerCase();
    if (action === 's') {
      saveBet(opp, narrative);
      if ((await ask(`${c.cyan}[p]ick another · [enter] back:${c.reset} `)).toLowerCase() !== 'p') keepGoing = false;
    } else if (action !== 'p') {
      keepGoing = false;
    }
  }
}

// --- Main -------------------------------------------------------------------
async function main() {
  console.log(`\n${c.bold}${c.blue}╭─ Gamblyzer ──────────────────────╮${c.reset}`);
  console.log(`${c.bold}${c.blue}│${c.reset} Random bets · AI narrative       ${c.bold}${c.blue}│${c.reset}`);
  console.log(`${c.bold}${c.blue}│${c.reset} Powered by OddsPapi v4           ${c.bold}${c.blue}│${c.reset}`);
  console.log(`${c.bold}${c.blue}╰──────────────────────────────────╯${c.reset}`);

  migrateLegacyConfig();
  const keys = loadKeys();

  while (true) {
    console.log(`\n${style.head('What next?')}`);
    console.log(`  ${style.accent('1')} Find a bet`);
    console.log(`  ${style.accent('2')} View saved picks (${getSaves().length})`);
    console.log(`  ${style.accent('3')} Reset keys`);
    console.log(`  ${style.accent('4')} List available bookmakers`);
    console.log(`  ${style.accent('q')} Quit`);
    const choice = (await ask(`${c.cyan}>${c.reset} `)).trim().toLowerCase();

    if      (choice === '1') await pickFlow(keys);
    else if (choice === '2') await viewSaves();
    else if (choice === '3') { setConfig({}); console.log(style.sub('Keys cleared. Restart to re-enter.')); break; }
    else if (choice === '4') await listBookmakers(keys);
    else if (choice === 'q' || choice === 'quit' || choice === 'exit') break;
  }

  rl.close();
  console.log(style.sub('\nbye.\n'));
}

main().catch((e) => {
  console.error(style.bad(`\nFatal: ${e.message}`));
  rl.close();
  process.exit(1);
});