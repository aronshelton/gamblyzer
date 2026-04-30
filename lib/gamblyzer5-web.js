const ODDS_COOLDOWN_MS = 450;
const BASE = "https://api.the-odds-api.com/v4";
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";

const BOOKMAKERS = ["draftkings", "polymarket"];
const DEFAULT_REGIONS = process.env.ODDS_API_REGIONS || "us,us2,us_ex";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normName(s) {
  return String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function decimalToAmerican(dec) {
  const d = Number(dec);
  if (!Number.isFinite(d) || d <= 1) return null;
  const am = d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1));
  return am === 0 || !Number.isFinite(am) ? null : am;
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

function sportKeyForLeagueCode(code) {
  if (code === "NBA") return "basketball_nba";
  if (code === "MLB") return "baseball_mlb";
  if (code === "NHL") return "icehockey_nhl";
  return null;
}

function fixtureFromOddsEvent(ev) {
  return {
    fixtureId: ev?.id,
    participant1Name: ev?.home_team || ev?.homeTeam || "Home",
    participant2Name: ev?.away_team || ev?.awayTeam || "Away",
    startTime: ev?.commence_time || ev?.commenceTime || null,
    tournamentName: ev?.sport_title || ev?.sportTitle || "",
  };
}

function filterEventsByLocalCalendarDay(events, day = new Date()) {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59, 999);
  return (Array.isArray(events) ? events : []).filter((e) => {
    const t = new Date(e?.commence_time || e?.commenceTime || e?.start_time || e?.startTime);
    return !Number.isNaN(t.getTime()) && t >= start && t <= end;
  });
}

function signedSpreadLineForRow(row) {
  const oc = String(row.outcome || "").trim();
  const m = oc.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?)\s*$/);
  if (m) return parseFloat(m[2]);
  return null;
}

function resolveSpreadSideKey(row) {
  const p1 = row.home;
  const p2 = row.away;
  const oc = String(row.outcome || "").trim();
  const nh = normName(p1);
  const na = normName(p2);
  const no = normName(oc);

  if (no === nh || nh.includes(no) || no.includes(nh)) return "home";
  if (no === na || na.includes(no) || no.includes(na)) return "away";

  const tm = oc.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?)\s*$/);
  if (tm) {
    const teamPart = normName(tm[1].trim());
    if (teamPart === nh || nh.includes(teamPart) || teamPart.includes(nh)) return "home";
    if (teamPart === na || na.includes(teamPart) || teamPart.includes(na)) return "away";
  }

  const boi = String(row.bookmakerOutcomeId || "").toLowerCase();
  if (boi === "home") return "home";
  if (boi === "away") return "away";
  return null;
}

function computeComparisonKey(row) {
  const p1 = row.home;
  const p2 = row.away;
  const oc = String(row.outcome || "").trim();
  const ocl = oc.toLowerCase();
  const b = row.bucket;

  if (b === "moneyline") {
    const n1 = normName(p1);
    const n2 = normName(p2);
    const no = normName(oc);
    if (no === n1 || n1.includes(no) || no.includes(n1)) return "ml::home";
    if (no === n2 || n2.includes(no) || no.includes(n2)) return "ml::away";
    return `ml::${ocl.replace(/\s+/g, " ")}`;
  }

  if (b === "spread") {
    const side = resolveSpreadSideKey(row);
    const line = signedSpreadLineForRow(row);
    if (side && Number.isFinite(line)) return `sp::${side}::${line}`;
    return `sp::${ocl.replace(/\s+/g, " ")}`;
  }

  if (b === "total") {
    const m = oc.match(/^(over|under)\s+([\d.]+)\s*$/i);
    if (m) return `tot::${m[1].toLowerCase()}::${m[2]}`;
    return `tot::${ocl.replace(/\s+/g, " ")}`;
  }

  return `misc::${ocl}`;
}

function marketLabelForRow(r) {
  if (!r) return "Market";
  if (r.bucket === "moneyline") return "Moneyline";
  if (r.bucket === "spread") return "Spread";
  if (r.bucket === "total") return "Total";
  return r.marketName || "Market";
}

function spreadDisplayLabel(row) {
  const oc = String(row.outcome || "").trim();
  const m = oc.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?)\s*$/);
  if (m) return `${m[1].trim()} ${m[2]}`;
  return oc;
}

function outcomeLabelForRow(r) {
  if (!r) return "";
  if (r.bucket === "spread") return spreadDisplayLabel(r);
  return String(r.outcome || "").trim();
}

function buildGroundingBlock(pick) {
  const { fixture, dkRow, sportLabel } = pick;
  return `GROUNDING DATA (from our feed — do not contradict or “correct” this):
- Sport: ${sportLabel}
- Matchup: ${fixture.participant2Name} @ ${fixture.participant1Name}
- Bet: ${outcomeLabelForRow(dkRow)} — ${marketLabelForRow(dkRow)}
- Odds: ${dkRow.american || "—"} (decimal ${Number.isFinite(dkRow.decimalOdds) ? dkRow.decimalOdds.toFixed(3) : "—"}) at DraftKings`;
}

function buildGroundingBlockNarrative(pick) {
  const { fixture, dkRow, sportLabel } = pick;
  return `Feed facts (unchangeable): ${sportLabel} | ${fixture.participant2Name} @ ${fixture.participant1Name} | bet ${outcomeLabelForRow(dkRow)} / ${marketLabelForRow(dkRow)} | ${dkRow.american || "—"} (${Number.isFinite(dkRow.decimalOdds) ? dkRow.decimalOdds.toFixed(3) : "—"}) DraftKings`;
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
  const research = String(researchText || "").trim() || "(No research; use only grounding. State that context was limited. No invented injuries/stats.)";
  return `Sports writer: short bet case (2–3 paragraphs). Facts only from FEED + RESEARCH; no new stats, injuries, or results. No URLs in prose. If research is GAPs/thin, say so, lean on matchup + odds.

${grounding}

RESEARCH:
${research}

End with: The case in one line: <one sentence>`;
}

function claudeTextFromResponse(data) {
  return (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

const NARR_RESEARCH_BUDGET_CHARS = 9000;
function compactResearchForNarrative(researchText) {
  const t = String(researchText || "").trim();
  if (t.length <= NARR_RESEARCH_BUDGET_CHARS) return t;
  return `${t.slice(0, NARR_RESEARCH_BUDGET_CHARS)}\n[Truncated for API budget. The RESEARCH section after the case lists full citable lines.]`;
}

const CLAUDE_MAX_ATTEMPTS = 4;
async function claudeWithRetry(claudeKey, makeBody) {
  for (let attempt = 1; attempt <= CLAUDE_MAX_ATTEMPTS; attempt++) {
    const res = await fetch(CLAUDE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": claudeKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(makeBody()),
    });
    if (res.ok) return res;
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { message: text }; }
    const msg = data?.error?.message || data?.message || text || "";
    const canRetry = (res.status === 429 || res.status >= 500) && attempt < CLAUDE_MAX_ATTEMPTS;
    if (!canRetry) {
      throw new Error(`Claude failed (${res.status}): ${msg || res.statusText || "unknown error"}`);
    }
    const ra = res.headers.get("retry-after");
    let backoffMs;
    if (ra && /^\d+(\.\d+)?$/.test(String(ra).trim())) backoffMs = Math.min(120000, Math.max(0, parseFloat(String(ra).trim()) * 1000));
    else if (res.status === 429) backoffMs = 14000 * attempt;
    else backoffMs = 800 * attempt;
    if (!Number.isFinite(backoffMs) || backoffMs < 800) backoffMs = 1200 * attempt;
    await sleep(backoffMs);
  }
  throw new Error("claudeWithRetry: exhausted without return");
}

async function geminiWithRetry(geminiKey, makePayload) {
  const gemUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
  let lastRes;
  for (let attempt = 1; attempt <= 3; attempt++) {
    lastRes = await fetch(gemUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makePayload()),
    });
    if (lastRes.ok) return lastRes;
    if ((lastRes.status === 429 || lastRes.status >= 500) && attempt < 3) {
      await sleep(800 * attempt);
      continue;
    }
    break;
  }
  const body = await lastRes.text().catch(() => "");
  throw new Error(`Gemini failed (${lastRes.status}): ${body || lastRes.statusText || "unknown error"}`);
}

async function oddsApiGet(key, pathAndQuery) {
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const url = `${BASE}${pathAndQuery}${sep}apiKey=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) ? (data.message || data.error) : (text || res.statusText);
    throw new Error(`The Odds API ${res.status} on ${pathAndQuery}: ${msg}`);
  }
  const used = res.headers.get("x-requests-used") || res.headers.get("x-requests-used-by-endpoint");
  const remaining = res.headers.get("x-requests-remaining");
  return { data, quota: { used: used || null, remaining: remaining || null } };
}

async function fetchOddsForSport(key, sportKey) {
  const regions = DEFAULT_REGIONS;
  const markets = "h2h,spreads,totals";
  const dateFormat = "iso";
  const oddsFormat = "decimal";
  return oddsApiGet(
    key,
    `/sports/${encodeURIComponent(sportKey)}/odds?regions=${encodeURIComponent(regions)}&markets=${encodeURIComponent(markets)}&dateFormat=${encodeURIComponent(dateFormat)}&oddsFormat=${encodeURIComponent(oddsFormat)}`
  );
}

function flattenCoreLinesFromTheOddsApi(eventOdds) {
  const rows = [];
  const fixture = fixtureFromOddsEvent(eventOdds);
  const home = fixture.participant1Name;
  const away = fixture.participant2Name;

  for (const bm of (eventOdds?.bookmakers || [])) {
    const book = String(bm?.key || "").toLowerCase();
    if (!book) continue;
    if (!BOOKMAKERS.includes(book)) continue;

    for (const m of (bm?.markets || [])) {
      const mk = String(m?.key || "").toLowerCase();
      if (!mk) continue;

      let bucket = "other";
      let marketName = m?.key || "Market";
      if (mk === "h2h") { bucket = "moneyline"; marketName = "Moneyline"; }
      else if (mk === "spreads") { bucket = "spread"; marketName = "Spread"; }
      else if (mk === "totals") { bucket = "total"; marketName = "Total"; }
      else continue;

      for (const o of (m?.outcomes || [])) {
        const name = String(o?.name || "").trim();
        const dec = Number(o?.price);
        if (!name || !Number.isFinite(dec)) continue;

        let outcome = name;
        let bookmakerOutcomeId = "";

        if (bucket === "moneyline") {
          const n = normName(name);
          if (n === normName(home)) bookmakerOutcomeId = "home";
          else if (n === normName(away)) bookmakerOutcomeId = "away";
        } else if (bucket === "spread") {
          const pt = Number(o?.point);
          if (Number.isFinite(pt)) {
            const signed = pt > 0 ? `+${pt}` : `${pt}`;
            outcome = `${name} ${signed}`;
          }
          const n = normName(name);
          if (n === normName(home)) bookmakerOutcomeId = "home";
          else if (n === normName(away)) bookmakerOutcomeId = "away";
        } else if (bucket === "total") {
          const pt = Number(o?.point);
          const n = normName(name);
          if (n === "over" || n === "under") {
            bookmakerOutcomeId = `${Number.isFinite(pt) ? pt : ""}/${n}`.replace(/\/$/, "");
            outcome = Number.isFinite(pt) ? `${name} ${pt}` : name;
          }
        }

        const am = decimalToAmerican(dec);
        rows.push({
          book,
          bucket,
          marketName,
          marketId: String(m?.key || ""),
          outcomeId: String(name),
          outcome,
          decimalOdds: dec,
          american: am != null ? (am > 0 ? `+${am}` : `${am}`) : "",
          mainLine: true,
          bookmakerOutcomeId,
          home,
          away,
          homeAbbr: "",
          awayAbbr: "",
          spreadHandicap: null,
        });
      }
    }
  }

  return rows;
}

function assertPickShape(pick) {
  if (!pick || typeof pick !== "object") throw new Error("Invalid pick payload");
  if (!pick.fixture || typeof pick.fixture !== "object") throw new Error("Invalid pick.fixture");
  if (!pick.dkRow || typeof pick.dkRow !== "object") throw new Error("Invalid pick.dkRow");
  if (!pick.sportLabel) throw new Error("Invalid pick.sportLabel");
}

const ALLOWED_LEAGUES = ["NBA", "MLB", "NHL"];

function normalizeLeagueSelection(leaguesRaw, leagueRaw) {
  if (Array.isArray(leaguesRaw)) {
    if (!leaguesRaw.length) throw new Error("Select at least one league.");
    const out = [...new Set(leaguesRaw.map((x) => String(x || "").toUpperCase().trim()))]
      .filter((c) => ALLOWED_LEAGUES.includes(c));
    if (!out.length) throw new Error("No valid leagues selected (use NBA / MLB / NHL).");
    return out.sort((a, b) => ALLOWED_LEAGUES.indexOf(a) - ALLOWED_LEAGUES.indexOf(b));
  }
  const l = String(leagueRaw || "NBA").toUpperCase().trim();
  if (l === "ALL") return [...ALLOWED_LEAGUES];
  if (!ALLOWED_LEAGUES.includes(l)) {
    throw new Error(`Unsupported league "${l}". Use NBA, MLB, NHL, ALL, or a leagues array.`);
  }
  return [l];
}

const AMERICAN_ODDS_CAP_MIN = -200;
const AMERICAN_ODDS_CAP_MAX = 300;

export async function generatePickOnly({ league, leagues, min, max }) {
  const oddsKey = process.env.ODDS_API_KEY;
  if (!oddsKey) throw new Error("Missing env var ODDS_API_KEY");

  const range = { min: Number(min), max: Number(max) };
  if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min >= range.max) {
    throw new Error("Invalid odds range: min must be less than max.");
  }
  if (range.min < AMERICAN_ODDS_CAP_MIN || range.min > AMERICAN_ODDS_CAP_MAX ||
      range.max < AMERICAN_ODDS_CAP_MIN || range.max > AMERICAN_ODDS_CAP_MAX) {
    throw new Error(`American odds must be between ${AMERICAN_ODDS_CAP_MIN} and +${AMERICAN_ODDS_CAP_MAX}.`);
  }

  const leagueCodes = normalizeLeagueSelection(leagues, league);
  const leaguesLabel = leagueCodes.join("+");

  let todays = [];
  const quotaHints = [];

  for (let i = 0; i < leagueCodes.length; i++) {
    if (i) await sleep(ODDS_COOLDOWN_MS);
    const code = leagueCodes[i];
    const sportKey = sportKeyForLeagueCode(code);
    if (!sportKey) continue;
    const { data, quota } = await fetchOddsForSport(oddsKey, sportKey);
    quotaHints.push({ league: code, ...quota });
    const dayEvs = filterEventsByLocalCalendarDay(data).map((ev) => ({ ev, leagueCode: code }));
    todays.push(...dayEvs);
  }

  if (!todays.length) {
    throw new Error(`No games with odds today for leagues ${leaguesLabel} (server-local calendar day).`);
  }

  const candidates = [];
  for (const item of todays) {
    const ev = item.ev;
    const leagueCode = item.leagueCode || leagueCodes[0];
    const fixture = fixtureFromOddsEvent(ev);
    const rows = flattenCoreLinesFromTheOddsApi(ev);

    const dkRows = rows.filter((r) => r.book === "draftkings" && ["moneyline", "spread", "total"].includes(r.bucket));
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

  if (!candidates.length) {
    throw new Error(`No DraftKings lines found between ${range.min} and ${range.max}.`);
  }

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  const { fixture, dkRow, key: groupKey, rows, sportLabel } = pick;
  const polyCandidates = (rows || []).filter((r) => r.book === "polymarket" && computeComparisonKey(r) === groupKey);
  const polyRow = polyCandidates[0] || null;

  return {
    fixture,
    sportLabel,
    dkRow,
    polyRow,
    poolSize: candidates.length,
    quotaHints,
    selectedLeagues: leagueCodes,
  };
}

export async function generateResearchNarrative(pick) {
  assertPickShape(pick);

  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!claudeKey && !geminiKey) throw new Error("Missing env var ANTHROPIC_API_KEY (or GEMINI_API_KEY as fallback)");

  const grounding = buildGroundingBlock(pick);
  const rPrompt = researchPrompt(grounding);

  let researchText = "";
  let usedProvider = "claude";

  if (claudeKey) {
    const res = await claudeWithRetry(claudeKey, () => ({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 1200,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: rPrompt }],
    }));
    const data = await res.json();
    researchText = claudeTextFromResponse(data);
  } else if (geminiKey) {
    usedProvider = "gemini";
    const res = await geminiWithRetry(geminiKey, () => ({
      contents: [{ parts: [{ text: rPrompt }] }],
      tools: [{ googleSearch: {} }],
    }));
    const data = await res.json();
    researchText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  }

  if (!String(researchText || "").trim()) {
    researchText = "- GAP: No research text returned. | (no reliable source in search results)";
  }

  const nPrompt = narrativePrompt(buildGroundingBlockNarrative(pick), compactResearchForNarrative(researchText));
  let narrative = "";

  const narrateViaGemini = Boolean(geminiKey && process.env.GAMBLYZER_NARRATE_VIA_GEMINI === "1");

  if ((narrateViaGemini || usedProvider !== "claude") && geminiKey) {
    const res2 = await geminiWithRetry(geminiKey, () => ({
      contents: [{ parts: [{ text: nPrompt }] }],
      generationConfig: { temperature: 0.25, maxOutputTokens: 1000 },
    }));
    const data2 = await res2.json();
    narrative = data2?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  } else if (claudeKey) {
    const res2 = await claudeWithRetry(claudeKey, () => ({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 1000,
      temperature: 0.25,
      messages: [{ role: "user", content: nPrompt }],
    }));
    const data2 = await res2.json();
    narrative = claudeTextFromResponse(data2);
  }

  if (!String(narrative || "").trim()) {
    narrative = "Online context was limited. The case in one line: The model returned an empty write-up — use the research bullets and posted odds, and double-check any claims.";
  }

  const narrativeCombined = `${narrative.trim()}\n\n<<<GAMBLYZER_SOURCES>>>\n${String(researchText || "").trim()}`;

  return { narrativeCombined };
}

export async function generatePick({ league, leagues, min, max }) {
  const pick = await generatePickOnly({ league, leagues, min, max });
  const r = await generateResearchNarrative(pick);
  return {
    ...pick,
    ...r,
  };
}

