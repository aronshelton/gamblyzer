#!/usr/bin/env node

/**
 * Gamblyzer CLI
 * Pick a random bet within an odds range and get an AI-generated case for it.
 * Requires Node 18+ (for global fetch).
 *
 * Usage: node gamblyzer.js
 *
 * Config and saves are stored in the same folder as this script:
 * ./config.json  — your API keys
 * ./saves.json   — your saved picks
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');

// Self-contained: config/saves live next to this script
const CONFIG_DIR = __dirname;
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SAVES_FILE = path.join(CONFIG_DIR, 'saves.json');

const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';

// ANSI styles
const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', italic: '\x1b[3m',
  gray: '\x1b[90m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', white: '\x1b[37m',
};

const style = {
  head: (s) => `${c.bold}${c.white}${s}${c.reset}`,
  sub: (s) => `${c.gray}${s}${c.reset}`,
  accent: (s) => `${c.cyan}${s}${c.reset}`,
  good: (s) => `${c.green}${s}${c.reset}`,
  bad: (s) => `${c.red}${s}${c.reset}`,
  warn: (s) => `${c.yellow}${s}${c.reset}`,
  dim: (s) => `${c.dim}${s}${c.reset}`,
};

// --- Config / saves helpers -------------------------------------------------

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getConfig() { return loadJSON(CONFIG_FILE, {}); }
function setConfig(cfg) { saveJSON(CONFIG_FILE, cfg); }
function getSaves() { return loadJSON(SAVES_FILE, []); }
function setSaves(saves) { saveJSON(SAVES_FILE, saves); }

// One-time migration: if old config exists at ~/.bet-picker, offer to move it
function migrateLegacyConfig() {
  const os = require('os');
  const legacyDir = path.join(os.homedir(), '.bet-picker');
  const legacyConfig = path.join(legacyDir, 'config.json');
  const legacySaves = path.join(legacyDir, 'saves.json');

  if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(legacyConfig)) {
    try {
      fs.copyFileSync(legacyConfig, CONFIG_FILE);
      console.log(style.sub(`Migrated keys from ${legacyConfig} → ${CONFIG_FILE}`));
    } catch { /* ignore */ }
  }
  if (!fs.existsSync(SAVES_FILE) && fs.existsSync(legacySaves)) {
    try {
      fs.copyFileSync(legacySaves, SAVES_FILE);
      console.log(style.sub(`Migrated saves from ${legacySaves} → ${SAVES_FILE}`));
    } catch { /* ignore */ }
  }
}

// --- Readline helpers -------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, (ans) => r(ans.trim())));

async function askHidden(prompt) {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode && stdin.setRawMode(true);
    stdin.resume();
    let input = '';
    const onData = (char) => {
      const s = char.toString('utf8');
      if (s === '\r' || s === '\n' || s === '\u0004') {
        stdin.setRawMode && stdin.setRawMode(wasRaw);
        stdin.removeListener('data', onData);
        stdin.pause();
        process.stdout.write('\n');
        resolve(input);
      } else if (s === '\u0003') {
        process.exit(0);
      } else if (s === '\u007f' || s === '\b') {
        if (input.length > 0) { input = input.slice(0, -1); process.stdout.write('\b \b'); }
      } else {
        input += s;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

// --- Spinner ----------------------------------------------------------------

function startSpinner(text) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r${c.cyan}${frames[i = (i + 1) % frames.length]}${c.reset} ${text}   `);
  }, 80);
  return () => {
    clearInterval(id);
    process.stdout.write('\r' + ' '.repeat(text.length + 10) + '\r');
  };
}

// --- Odds helpers -----------------------------------------------------------

const fmtOdds = (o) => o > 0 ? `+${o}` : `${o}`;
const mktLabel = (k) => ({ h2h: 'Moneyline', spreads: 'Spread', totals: 'Total' })[k] || k;
const gameDate = (iso) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// --- Key management ---------------------------------------------------------

async function ensureKeys() {
  const cfg = getConfig();
  let { oddsKey, claudeKey, geminiKey } = cfg;

  if (!oddsKey) {
    console.log(style.sub('\nGet a free key at the-odds-api.com (500 req/month free tier)'));
    oddsKey = await askHidden(`${c.cyan}Odds API key:${c.reset} `);
    if (!oddsKey) { console.log(style.bad('Required.')); return null; }
  }
  if (!claudeKey) {
    console.log(style.sub('\nGet an Anthropic key at console.anthropic.com'));
    claudeKey = await askHidden(`${c.cyan}Anthropic API key:${c.reset} `);
    if (!claudeKey) { console.log(style.bad('Required.')); return null; }
  }
  if (!geminiKey) {
    console.log(style.sub('\nGet a free Gemini key at aistudio.google.com/app/apikey'));
    geminiKey = await askHidden(`${c.cyan}Gemini API key (for fallback):${c.reset} `);
    if (!geminiKey) { console.log(style.warn('Skipped Gemini fallback.')); }
  }

  if (!cfg.oddsKey || !cfg.claudeKey || (!cfg.geminiKey && geminiKey)) {
    const save = (await ask(`${c.gray}Save keys to ${CONFIG_FILE}? [Y/n]:${c.reset} `)).toLowerCase();
    if (save !== 'n' && save !== 'no') {
      setConfig({ oddsKey, claudeKey, geminiKey });
      console.log(style.sub('Keys saved.\n'));
    }
  }

  return { oddsKey, claudeKey, geminiKey };
}

// --- Core flow --------------------------------------------------------------

async function fetchSports(oddsKey) {
  const stop = startSpinner('Loading sports…');
  try {
    const res = await fetch(`${ODDS_BASE}/sports/?apiKey=${oddsKey}`);
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.message || `API error ${res.status}`);
    }
    const data = await res.json();
    return data.filter((s) => s.active && !s.has_outrights);
  } finally { stop(); }
}

async function selectSports(sports) {
  console.log(`\n${style.head('Active sports:')}`);
  sports.forEach((s, i) => {
    console.log(`  ${style.dim(String(i + 1).padStart(2))}. ${s.title} ${style.sub(`(${s.key})`)}`);
  });
  console.log(style.sub('\nEnter numbers separated by commas (e.g. 1,3,5), a range (1-5), or "all":'));
  const input = (await ask(`${c.cyan}>${c.reset} `)).trim().toLowerCase();

  if (input === 'all' || input === '') return sports;

  const selected = new Set();
  for (const part of input.split(',').map((p) => p.trim())) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const [a, b] = [parseInt(range[1]), parseInt(range[2])];
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
        if (sports[i - 1]) selected.add(sports[i - 1]);
      }
    } else {
      const n = parseInt(part);
      if (!isNaN(n) && sports[n - 1]) selected.add(sports[n - 1]);
    }
  }
  return [...selected];
}

async function askOddsRange() {
  console.log(`\n${style.head('American odds range')} ${style.sub('(e.g. -200 to +300 for favorites through mild dogs)')}`);
  const minStr = await ask(`${c.cyan}Min:${c.reset} `);
  const maxStr = await ask(`${c.cyan}Max:${c.reset} `);
  const min = parseInt(minStr);
  const max = parseInt(maxStr);
  if (isNaN(min) || isNaN(max) || min >= max) {
    console.log(style.bad('Invalid range. Min must be less than max.'));
    return null;
  }
  return { min, max };
}

async function fetchAllBets(oddsKey, selectedSports, min, max) {
  const stop = startSpinner(`Fetching odds for ${selectedSports.length} sport${selectedSports.length !== 1 ? 's' : ''}…`);
  const allBets = [];
  let remaining = null;
  
  // Grab today's date object once as a baseline
  const today = new Date();

  try {
    for (const sport of selectedSports) {
      try {
        const res = await fetch(`${ODDS_BASE}/sports/${sport.key}/odds/?apiKey=${oddsKey}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`);
        if (!res.ok) continue;
        remaining = res.headers.get('x-requests-remaining');
        
        const games = await res.json();
        
        for (const game of games) {
          const gameDate = new Date(game.commence_time);
          
          // Bulletproof check: Compare the exact Year, Month, and Date
          const isToday = gameDate.getDate() === today.getDate() &&
                          gameDate.getMonth() === today.getMonth() &&
                          gameDate.getFullYear() === today.getFullYear();

          // Skip if it isn't today
          if (!isToday) {
            continue;
          }

          const bk = game.bookmakers[0];
          if (!bk) continue;
          
          for (const mkt of bk.markets) {
            for (const oc of mkt.outcomes) {
              if (oc.price >= min && oc.price <= max) {
                allBets.push({
                  sport: sport.title, home: game.home_team, away: game.away_team,
                  time: game.commence_time, book: bk.title, market: mkt.key,
                  outcome: oc.name, odds: oc.price, point: oc.point,
                });
              }
            }
          }
        }
      } catch (e) { /* skip */ }
    }
  } finally { stop(); }

  return { bets: allBets, remaining };
}

function displayBet(bet) {
  const pt = bet.point !== undefined ? ` (${bet.point >= 0 ? '+' : ''}${bet.point})` : '';
  const oddsStr = fmtOdds(bet.odds);
  const coloredOdds = bet.odds > 0 ? style.good(oddsStr) : style.head(oddsStr);

  console.log(`\n${style.sub('─'.repeat(60))}`);
  console.log(`${style.dim(bet.sport.toUpperCase())}`);
  console.log(`${style.head(`${bet.away} @ ${bet.home}`)}`);
  console.log(`${style.sub(gameDate(bet.time))}`);
  console.log();
  console.log(`  ${style.accent(mktLabel(bet.market))}  ${style.sub(bet.book)}`);
  console.log();
  console.log(`  ${style.head(bet.outcome + pt)}  ${c.bold}${coloredOdds}${c.reset}`);
  console.log(`${style.sub('─'.repeat(60))}`);
}

async function generateNarrative(bet, keys) {
  const stop = startSpinner('AI is researching recent news…');
  try {
    const pt = bet.point !== undefined ? ` (${bet.point >= 0 ? '+' : ''}${bet.point})` : '';
    const prompt = `You are a confident sports analyst. A bettor is considering:
Sport: ${bet.sport}
Game: ${bet.away} @ ${bet.home}
Bet: ${bet.outcome}${pt} — ${mktLabel(bet.market)}
Odds: ${fmtOdds(bet.odds)} at ${bet.book}

Search for recent news, injuries, form, and head-to-head context for these teams. Write a compelling 2-3 paragraph case for this bet. Be specific, cite real factors, don't hedge excessively. End with exactly "The case in one line:" followed by one punchy sentence.`;

    // 1. TRY CLAUDE FIRST
    const claudeRes = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': keys.claudeKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (claudeRes.ok) {
      const data = await claudeRes.json();
      return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    }

    // 2. IF CLAUDE FAILS (e.g. out of credits), FALLBACK TO GEMINI
    if (!keys.geminiKey) {
      const e = await claudeRes.json().catch(() => ({}));
      throw new Error(`Claude failed (${e.error?.message || claudeRes.status}) and no Gemini fallback key is configured.`);
    }

    // Stop the spinner briefly to notify the user of the fallback
    stop();
    console.log(`\n  ${style.warn('⚠ Claude out of credits/unavailable. Falling back to Gemini...')}`);
    const stopGemini = startSpinner('Gemini is researching…');

    try {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${keys.geminiKey}`;
      const geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ googleSearch: {} }] // Enables live web search
        }),
      });

      if (!geminiRes.ok) {
        const e = await geminiRes.json().catch(() => ({}));
        throw new Error(e.error?.message || `API error ${geminiRes.status}`);
      }
      const data = await geminiRes.json();
      return data.candidates[0].content.parts[0].text.trim();
    } finally {
      stopGemini();
    }

  } finally { 
    // Ensure the original spinner is stopped if we didn't trigger the fallback
    try { stop(); } catch (e) {} 
  }
}

function displayNarrative(text) {
  console.log(`\n${style.sub('THE CASE')}\n`);
  const parts = text.split(/The case in one line:/i);
  const body = parts[0].trim();
  const caseLine = parts[1] ? parts[1].trim() : '';

  const wrapped = body.split(/\n\n+/).map((p) => wrapText(p.trim(), 72)).join('\n\n');
  console.log(wrapped);

  if (caseLine) {
    console.log(`\n${c.blue}│${c.reset} ${style.head('The case in one line:')} ${caseLine}\n`);
  }
}

function wrapText(text, width) {
  const words = text.replace(/\s+/g, ' ').split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      lines.push(line);
      line = w;
    } else {
      line = (line ? line + ' ' : '') + w;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

// --- Saves ------------------------------------------------------------------

function saveBet(bet, narrative) {
  const pt = bet.point !== undefined ? ` (${bet.point >= 0 ? '+' : ''}${bet.point})` : '';
  const pick = {
    id: Date.now(),
    sport: bet.sport,
    game: `${bet.away} @ ${bet.home}`,
    outcome: bet.outcome + pt,
    market: mktLabel(bet.market),
    odds: bet.odds,
    book: bet.book,
    time: bet.time,
    narrative,
    savedAt: new Date().toISOString(),
  };
  const saves = getSaves();
  saves.unshift(pick);
  setSaves(saves);
  console.log(style.good(`✓ Saved to ${SAVES_FILE}`));
}

async function viewSaves() {
  const saves = getSaves();
  if (saves.length === 0) {
    console.log(style.sub('\nNo saved picks yet.\n'));
    return;
  }
  console.log(`\n${style.head(`Saved picks (${saves.length})`)}\n`);
  saves.forEach((p, i) => {
    const caseLine = (() => {
      const parts = (p.narrative || '').split(/The case in one line:/i);
      return parts[1] ? parts[1].trim() : '';
    })();
    const oddsStr = p.odds > 0 ? style.good(fmtOdds(p.odds)) : style.head(fmtOdds(p.odds));
    const date = new Date(p.savedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    console.log(`${style.dim(String(i + 1).padStart(2))}. ${style.head(p.game)}  ${oddsStr}`);
    console.log(`    ${style.sub(`${p.outcome} · ${p.market} · ${p.book} · ${p.sport} · saved ${date}`)}`);
    if (caseLine) console.log(`    ${c.blue}│${c.reset} ${style.dim(caseLine)}`);
    console.log();
  });

  const answer = (await ask(`${c.cyan}[number] view full · [d N] delete · [enter] back:${c.reset} `)).trim();
  if (!answer) return;

  const delMatch = answer.match(/^d\s+(\d+)$/i);
  if (delMatch) {
    const idx = parseInt(delMatch[1]) - 1;
    if (saves[idx]) {
      saves.splice(idx, 1);
      setSaves(saves);
      console.log(style.sub('Deleted.'));
    }
    return viewSaves();
  }

  const n = parseInt(answer);
  if (!isNaN(n) && saves[n - 1]) {
    const p = saves[n - 1];
    const [away, home] = p.game.split(' @ ');
    console.log(`\n${style.sub('─'.repeat(60))}`);
    console.log(style.dim(p.sport.toUpperCase()));
    console.log(style.head(p.game));
    console.log(style.sub(gameDate(p.time)));
    console.log();
    const oddsStr = p.odds > 0 ? style.good(fmtOdds(p.odds)) : style.head(fmtOdds(p.odds));
    console.log(`  ${style.accent(p.market)}  ${style.sub(p.book)}`);
    console.log();
    console.log(`  ${style.head(p.outcome)}  ${c.bold}${oddsStr}${c.reset}`);
    console.log(style.sub('─'.repeat(60)));
    if (p.narrative) displayNarrative(p.narrative);
    await ask(`\n${c.gray}[enter] back${c.reset} `);
    return viewSaves();
  }
}

// --- Main loop --------------------------------------------------------------

async function pickFlow(keys) {
  const sports = await fetchSports(keys.oddsKey).catch((e) => { console.log(style.bad(`\n✗ ${e.message}\n`)); return null; });
  if (!sports || sports.length === 0) return;

  const selected = await selectSports(sports);
  if (selected.length === 0) { console.log(style.warn('No sports selected.')); return; }

  const range = await askOddsRange();
  if (!range) return;

  const { bets, remaining } = await fetchAllBets(keys.oddsKey, selected, range.min, range.max);

  if (bets.length === 0) {
    console.log(style.warn(`\nNo bets found between ${fmtOdds(range.min)} and ${fmtOdds(range.max)}. Try a wider range.\n`));
    return;
  }

  const remText = remaining !== null ? ` · ${remaining} credits remaining` : '';
  console.log(style.sub(`\nFound ${bets.length} qualifying bet${bets.length !== 1 ? 's' : ''}${remText}`));

  let keepGoing = true;
  while (keepGoing) {
    const bet = bets[Math.floor(Math.random() * bets.length)];
    displayBet(bet);

    let narrative = '';
    try {
      narrative = await generateNarrative(bet, keys);
      displayNarrative(narrative);
    } catch (e) {
      console.log(style.bad(`\n✗ Narrative failed: ${e.message}\n`));
    }

    const action = (await ask(`${c.cyan}[s]ave · [p]ick another · [enter] back:${c.reset} `)).toLowerCase();
    if (action === 's') {
      saveBet(bet, narrative);
      const next = (await ask(`${c.cyan}[p]ick another · [enter] back:${c.reset} `)).toLowerCase();
      if (next !== 'p') keepGoing = false;
    } else if (action !== 'p') {
      keepGoing = false;
    }
  }
}

async function main() {
  console.log(`\n${c.bold}${c.blue}╭─ Gamblyzer ──────────────────────╮${c.reset}`);
  console.log(`${c.bold}${c.blue}│${c.reset} Random bets with an AI case      ${c.bold}${c.blue}│${c.reset}`);
  console.log(`${c.bold}${c.blue}╰──────────────────────────────────╯${c.reset}`);

  migrateLegacyConfig();

  const keys = await ensureKeys();
  if (!keys) { rl.close(); return; }

  while (true) {
    console.log(`\n${style.head('What next?')}`);
    console.log(`  ${style.accent('1')} Find a bet`);
    console.log(`  ${style.accent('2')} View saved picks (${getSaves().length})`);
    console.log(`  ${style.accent('3')} Reset keys`);
    console.log(`  ${style.accent('q')} Quit`);
    const choice = (await ask(`${c.cyan}>${c.reset} `)).trim().toLowerCase();

    if (choice === '1') await pickFlow(keys);
    else if (choice === '2') await viewSaves();
    else if (choice === '3') {
      setConfig({});
      console.log(style.sub('Keys cleared. Exiting — restart to re-enter.'));
      break;
    } else if (choice === 'q' || choice === 'quit' || choice === 'exit') break;
  }

  rl.close();
  console.log(style.sub('\nbye.\n'));
}

main().catch((e) => {
  console.error(style.bad(`\nFatal: ${e.message}`));
  rl.close();
  process.exit(1);
});