const ODDS_COOLDOWN_MS = 450;
const BASE = "https://api.the-odds-api.com/v4";
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";

const BOOKMAKERS = ["draftkings", "bovada", "polymarket"];
const DEFAULT_REGIONS = process.env.ODDS_API_REGIONS || "us,us2,us_ex";
const DEFAULT_SPORTSBOOK = "draftkings";

/** Main pricing book per league (Polymarket still used for comparison when available). */
const LEAGUE_SPORTSBOOK = {
  EPL: String(process.env.GAMBLYZER_EPL_SPORTSBOOK || "bovada").toLowerCase().trim(),
};

function sportsbookForLeagueCode(leagueCode) {
  const code = String(leagueCode || "").toUpperCase().trim();
  return LEAGUE_SPORTSBOOK[code] || DEFAULT_SPORTSBOOK;
}

const DEFAULT_BUCKETS = ["moneyline", "spread", "total"];

/** Per-league eligible market buckets (EPL: ML + match totals only). */
const LEAGUE_BUCKETS = {
  EPL: ["moneyline", "total"],
};

function allowedBucketsForLeague(leagueCode) {
  const code = String(leagueCode || "").toUpperCase().trim();
  return LEAGUE_BUCKETS[code] || DEFAULT_BUCKETS;
}

function marketsQueryForLeague(leagueCode) {
  const buckets = allowedBucketsForLeague(leagueCode);
  const mk = [];
  if (buckets.includes("moneyline")) mk.push("h2h");
  if (buckets.includes("spread")) mk.push("spreads");
  if (buckets.includes("total")) mk.push("totals");
  return mk.join(",");
}

function sportsbookDisplayName(bookKey) {
  const k = String(bookKey || "").toLowerCase();
  if (k === "draftkings") return "DraftKings";
  if (k === "bovada") return "Bovada";
  if (k === "polymarket") return "Polymarket";
  if (!k) return "Sportsbook";
  return k.charAt(0).toUpperCase() + k.slice(1);
}

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
  if (code === "EPL") return "soccer_epl";
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

const DEFAULT_FEED_TIMEZONE = process.env.GAMBLYZER_FEED_TIMEZONE || "America/New_York";

function dayKeyInTimeZone(date, timeZone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(date); // YYYY-MM-DD
  } catch {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(date);
  }
}

const EVENT_START_GRACE_MS = Math.min(
  6 * 60_000,
  Math.max(0, Math.floor(Number(process.env.GAMBLYZER_EVENT_START_GRACE_MS) || 120_000))
);

function eventStartMs(e) {
  const t = new Date(e?.commence_time || e?.commenceTime || e?.start_time || e?.startTime);
  const ms = t.getTime();
  return Number.isNaN(ms) ? null : ms;
}

function filterEventsByEarliestUpcomingLocalDay(events, timeZone = DEFAULT_FEED_TIMEZONE, nowMs = Date.now()) {
  const evs = Array.isArray(events) ? events : [];
  let earliestMs = null;
  for (const e of evs) {
    const ms = eventStartMs(e);
    if (ms === null) continue;
    if (ms < nowMs - EVENT_START_GRACE_MS) continue; // already started (with grace)
    if (earliestMs === null || ms < earliestMs) earliestMs = ms;
  }
  if (earliestMs === null) return [];

  const earliest = new Date(earliestMs);
  const earliestKey = dayKeyInTimeZone(earliest, timeZone);
  if (!earliestKey) return [];

  return evs.filter((e) => {
    const ms = eventStartMs(e);
    if (ms === null) return false;
    if (ms < nowMs - EVENT_START_GRACE_MS) return false;
    return dayKeyInTimeZone(new Date(ms), timeZone) === earliestKey;
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
    if (no === "draw" || ocl === "draw") return "ml::draw";
    return `ml::${ocl.replace(/\s+/g, " ")}`;
  }

  if (b === "spread") {
    const side = resolveSpreadSideKey(row);
    const line = signedSpreadLineForRow(row);
    if (side && Number.isFinite(line)) return `sp::${side}::${line}`;
    return `sp::${ocl.replace(/\s+/g, " ")}`;
  }

  if (b === "total") {
    const m = oc.match(/^(over|under)\s+([\d.]+)(?:\s+\((.+)\))?\s*$/i);
    if (m) {
      const team = m[3] ? normName(m[3]) : "";
      return team
        ? `tot::${m[1].toLowerCase()}::${m[2]}::${team}`
        : `tot::${m[1].toLowerCase()}::${m[2]}`;
    }
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

/** Prevents home/away and spread-sign mixups in model prose (Away @ Home = participant2 @ participant1). */
function buildFixtureScheduleLines(fixture) {
  const h = String(fixture?.participant1Name || "Home").trim();
  const a = String(fixture?.participant2Name || "Away").trim();
  return `SCHEDULE (authoritative — do not swap home/away):
- Home team: ${h}
- Away team: ${a}
- Matchup string "Away @ Home" lists the away team first, then the home team — the game is played at ${h}'s home venue.
- Use "at home", "on the road", "host", or "visitor" only in ways that match these assignments (never flip which team is home).`;
}

function buildSpreadLineAuthorityLines(dkRow) {
  if (!dkRow || dkRow.bucket !== "spread") return "";
  const posted = outcomeLabelForRow(dkRow);
  const lineNum = signedSpreadLineForRow(dkRow);
  const sideKey = resolveSpreadSideKey(dkRow);
  const home = String(dkRow.home || "").trim();
  const away = String(dkRow.away || "").trim();
  const ticketTeam =
    sideKey === "home" && home ? home : sideKey === "away" && away ? away : "";
  let coverRule = "";
  if (ticketTeam && Number.isFinite(lineNum) && lineNum !== 0) {
    if (lineNum > 0) {
      coverRule = `${ticketTeam} covers this posted line if they lose by fewer than ${lineNum} points or tie/win (standard ATS with half-point; no push).`;
    } else {
      const abs = Math.abs(lineNum);
      coverRule = `${ticketTeam} covers this posted line if they win by more than ${abs} points (half-point; no push).`;
    }
  }
  return `SPREAD LINE (authoritative — never flip the sign for the team named on this ticket):
- Posted outcome (copy exactly when referring to this wager): ${posted}
- The +/− number applies only to that named team’s side. Do not restate this ticket as the same team with the opposite sign (e.g. never turn a +3.5 side into −3.5 for that same team).
${coverRule ? `- Cover rule for this ticket: ${coverRule}` : ""}`;
}

function buildGroundingBlock(pick) {
  const { fixture, dkRow, sportLabel } = pick;
  const bookLabel = sportsbookDisplayName(dkRow?.book || sportsbookForLeagueCode(sportLabel));
  const schedule = buildFixtureScheduleLines(fixture);
  const spreadAuth = buildSpreadLineAuthorityLines(dkRow);
  return `GROUNDING DATA (from our feed — do not contradict or “correct” this):
- Sport: ${sportLabel}
- Matchup: ${fixture.participant2Name} @ ${fixture.participant1Name}
- Bet: ${outcomeLabelForRow(dkRow)} — ${marketLabelForRow(dkRow)}
- Odds: ${dkRow.american || "—"} (decimal ${Number.isFinite(dkRow.decimalOdds) ? dkRow.decimalOdds.toFixed(3) : "—"}) at ${bookLabel}

${schedule}
${spreadAuth}`.trim();
}

function buildGroundingBlockNarrative(pick) {
  const { fixture, dkRow, sportLabel } = pick;
  const h = String(fixture?.participant1Name || "Home").trim();
  const a = String(fixture?.participant2Name || "Away").trim();
  const spreadHint =
    dkRow?.bucket === "spread"
      ? ` | spread ticket: use exact "${outcomeLabelForRow(dkRow)}"; home=${h} away=${a}`
      : ` | home=${h} away=${a}`;
  const bookLabel = sportsbookDisplayName(dkRow?.book || sportsbookForLeagueCode(sportLabel));
  return `Feed facts (unchangeable): ${sportLabel} | ${fixture.participant2Name} @ ${fixture.participant1Name} | bet ${outcomeLabelForRow(dkRow)} / ${marketLabelForRow(dkRow)} | ${dkRow.american || "—"} (${Number.isFinite(dkRow.decimalOdds) ? dkRow.decimalOdds.toFixed(3) : "—"}) ${bookLabel}${spreadHint}`;
}

const _envResearchUserCap = Number(process.env.GAMBLYZER_RESEARCH_USER_TEXT_MAX_CHARS);
const RESEARCH_USER_TEXT_MAX_CHARS = Math.min(
  8000,
  Math.max(500, Number.isFinite(_envResearchUserCap) && _envResearchUserCap > 0 ? Math.floor(_envResearchUserCap) : 4000)
);

function sanitizeUserResearchText(raw) {
  const t = String(raw || "").replace(/\u0000/g, "").trim();
  if (!t) return null;
  if (t.length > RESEARCH_USER_TEXT_MAX_CHARS) {
    return `${t.slice(0, RESEARCH_USER_TEXT_MAX_CHARS)}\n[User text truncated for research payload budget.]`;
  }
  return t;
}

function researchUserDirectionBlock(userContext) {
  const block = sanitizeUserResearchText(userContext);
  if (!block) return "";
  return `

═══════════════════════════════════════════════════════
BETTOR DIRECTIONS (what to look for)
═══════════════════════════════════════════════════════
The user wants this pass to emphasize the following (specific outlets, stats, angles, or sources). **Honor these in your search queries and prioritization**, while still obeying the FACT line format (URL, QUOTE, SIGNAL) and rules below. Do not invent citations.

${block}`;
}

function researchGapClosureBlock(gapClosure) {
  const block = sanitizeUserResearchText(gapClosure);
  if (!block) return "";
  return `

═══════════════════════════════════════════════════════
USER gap closures (integrate + verify when possible)
═══════════════════════════════════════════════════════
The bettor supplied notes below — often to fill an earlier GAP (e.g. confirmed starting pitcher). **Try briefly to verify each claim on the web** and emit normal FACT lines (FACT | URL | QUOTE | SIGNAL) when you find a citable page. If you cannot verify after a short search, add at most one line per distinct user claim:
- USER_NOTE: <one concise sentence from the user’s claim> | NOTE: user-supplied, not web-verified

USER NOTES:
${block}`;
}

const PASS2_SOURCE_TAXONOMY = `
PASS 2 PRIMARY SOURCE TAXONOMY (apply to any sport):

TIER 2 — Process Metrics vs. Surface Stats
  MLB:     Baseball Savant (baseballsavant.mlb.com) — pitch mix shifts, xERA vs ERA gap,
           barrel%, hard-hit%, exit velo trend
  NBA:     Cleaning the Glass (cleaningtheglass.com) or NBA.com/stats — shot quality,
           on/off splits, true shooting% vs. xTS (not raw box score)
  NHL:     Natural Stat Trick (naturalstattrick.com) or MoneyPuck (moneypuck.com) —
           GSAx, HDCA%, HDCF%, zone entry/exit rates, xG differential
  SOCCER:  FBref (fbref.com) or Understat (understat.com) — xG vs actual goals gap,
           xGA vs actual goals allowed, shot quality (xG/shot), pressing intensity
           (PPDA), progressive passes/carries; large xG vs goals gap = regression risk
  ANY:     Find a gap between what the surface stat shows and what the process metric
           shows. This gap is rarely covered in aggregator pick content.

TIER 3 — Matchup-Specific Splits
  MLB:     Batter vs. pitcher handedness split; road/home ERA split (Baseball Savant)
  NBA:     Specific defender matchup data, pace differential vs. this opponent,
           bench depth vs. opponent's bench (NBA.com matchup tool)
  NHL:     Line matchup deployment tendency, PP vs. PK efficiency in this
           head-to-head (Natural Stat Trick game-level filters)
  SOCCER:  Head-to-head xG history (Understat H2H), home/away xG split for each side,
           form table filtered to home or away only (not combined); FBref squad
           attack/defense splits vs. high vs. low defensive lines
  ANY:     Find a split specific to THIS matchup — not just season-wide numbers.

TIER 4 — Environmental / Schedule / Contextual Factors
  MLB:     UmpScorecards (umpscorecards.com) for umpire zone tendency and K/BB rates;
           wind speed/direction and temp at ballpark (weather.com)
  NBA:     Back-to-back or 3-games-in-4-nights flag; travel direction (west-to-east
           fatigue is measurable); days rest differential between teams
  NHL:     Back-to-back flag; goalie starts in last 5 days; home/away save% split;
           cross-timezone travel back-to-back
  SOCCER:  Fixture congestion (days since last match for each side — check official
           league fixture list); European competition midweek fatigue; referee
           assignment + card/foul tendency (WorldFootball.net or Transfermarkt
           referee stats); altitude or travel for away side; weather for outdoor
           stadiums (wind/rain materially affects totals)
  ANY:     Rest differential, travel burden, schedule spot — things preview sites
           routinely skip.

TIER 5 — Recent Game Log Trend
  MLB:     Last 2–3 game logs for starter/reliever (MLB.com game logs)
  NBA:     Last 3–5 game logs for key player (NBA.com game logs)
  NHL:     Last 3 starts for goalie (NHL.com game logs)
  SOCCER:  Last 3–5 match logs for team xG/xGA (Understat match log) and key
           player shot/assist data (FBref player match logs); note if a team is
           scoring well above or below their xG trend — reversion likely
  ANY:     Look for a short-term trend NOT captured in season averages.

TIER 6 — Betting Market Structure (check on every bet)
  SOURCES (priority order):
    Action Network     actionnetwork.com  — bet % AND money % split, line movement history
    DraftKings         sportsbook.draftkings.com — live consensus bet % for this matchup
    Pregame.com or Bet Labs              — sharp money indicators, reverse line movement
    Sports Insights / Sportsbook Review  — public vs. sharp % divergence

  CITATION (mandatory): Bet %, money %, and line-movement claims belong **only** in a
    full FACT line whose URL is the page where those exact figures appear (e.g. Action
    Network matchup). If you cannot open such a page, do **not** state percentages —
    use a GAP line for Tier 6 instead.

  WHAT TO LOOK FOR:
    Bet % vs. Money % divergence
      If 70% of tickets are on one side but only 45% of money is — large/sharp
      bettors are on the other side. This is actionable and almost never in pick content.

    Reverse Line Movement (RLM)
      Line moves AGAINST the public side despite lopsided ticket count.
      Example: 75% of public on one side but line drifts shorter for the other.
      Strong indicator of sharp money on the less-popular side.

    Line open vs. current
      Movement of 10+ cents (or 5+ points on a total) since open = meaningful
      one-sided action; note direction.

    Public lean thresholds
      >65% tickets on one side = meaningful public lean.
      >80% tickets on one side = potential fade candidate.

  SIGNAL RULE: All Tier 6 findings are UNDERREPORTED by default.
  Always tag Tier 6 facts as SIGNAL: UNDERREPORTED.
`;

function researchPrompt(grounding) {
  return `You are a careful sports researcher. Gather citable, materially relevant notes
for THIS exact posted bet.
${grounding}

SEARCH STRATEGY — two explicit passes:

PASS 1 (aggregator scan + injury baseline — 1–2 searches max):
Search pick/preview aggregators to identify saturated narratives AND confirm injury/roster
status. Injuries and lineup scratches appearing in mainstream coverage are SATURATED by
definition — note them as context but do not produce FACT lines from them unless the news
is breaking within ~2 hours of your search and has not yet reached aggregators.
Discard any injury/roster item already on ESPN, Rotoworld, or pick preview sites.

PASS 2 (primary source dig — 2–3 searches):
Using the SOURCE TAXONOMY below, select the 2–3 tiers most relevant to THIS specific bet.
Search those tiers using primary sources only.
This pass MUST produce at least 1 UNDERREPORTED FACT. If your first tier dig fails,
move to the next tier before declaring a GAP.

${PASS2_SOURCE_TAXONOMY}

STRICT OUTPUT BUDGET:
- 2–3 FACT lines total (hard max 4 if all cover clearly different topics)
- At least 1 FACT must carry SIGNAL: UNDERREPORTED
- At most 1 optional GAP line

Each FACT line — exact format (all four parts required on **one** line; no exceptions):
FACT: <one sentence> | URL: <full https:// URL> | QUOTE: "<=28 words" | SIGNAL: [SATURATED|UNDERREPORTED]

Never start a line with FACT: unless URL:, QUOTE:, and SIGNAL: all appear on that same line.
If you lack any one of them (common with Tier 6 if no page loads), output GAP: for that
angle instead — do not leave a dangling FACT.

SIGNAL rules:
- SATURATED = appears on 3+ pick/preview sites today (includes all injury/roster news
  that has reached mainstream coverage)
- UNDERREPORTED = sourced from Tier 2–5 primary source; absent from aggregators
  (Tier 6 ticket/money splits: UNDERREPORTED when the cited page is Action Network or
  another Tier 6 primary listed above, unless pick sites already lead with that exact split today — then SATURATED)

De-duplication: one line per distinct claim, best source wins.
Each FACT must introduce new information vs the others.

If primary dig genuinely finds nothing after trying 2+ tiers:
GAP: <topic + tier searched> | (checked <source name>; no usable result)

Output shape: emit **only** FACT: or GAP: lines (one claim per line). No preamble, no
pass commentary, no headings, no numbered summaries — those are invalid output.`;
}

function narrativePrompt(grounding, researchText) {
  const research = String(researchText || "").trim() || "(No research; use only grounding. State that context was limited. No invented injuries/stats.)";
  return `Sports writer: **1–2 tight paragraphs** (max ~120 words) making the bet case. Facts only from FEED + RESEARCH; no new stats, injuries, or results. No URLs in prose. If research is GAPs/thin, say so early; do not pad.

${grounding}

RESEARCH:
${research}

End with: The case in one line: <one sentence>`;
}

function counterResearchPrompt(grounding) {
  return `You research the CONTRARY / FADE case for ONE posted wager. Find citable material that
undermines THIS exact line. Do not balance both sides — hurt this ticket with evidence.
${grounding}

SEARCH STRATEGY — two explicit passes:

PASS 1 (aggregator scan — 1 search):
Quickly identify what contra arguments are already saturated in pick content. Note them;
do not use aggregators as your FACT sources.

PASS 2 (primary source dig — 2–3 searches):
Using the SOURCE TAXONOMY below, select the 2–3 tiers most likely to surface contra evidence
for THIS bet type (e.g. regression risk → Tier 2; matchup splits → Tier 3; schedule/fatigue → Tier 4; recent form → Tier 5).
Search those tiers for evidence that undermines the favorite/posted line.

This pass MUST attempt at least 1 primary source tier. If the first attempt finds nothing,
try a second tier before declaring a GAP.

${PASS2_SOURCE_TAXONOMY}

STRICT OUTPUT BUDGET:
- 2–3 FACT lines total (hard max 4)
- At least 1 FACT must carry SIGNAL: UNDERREPORTED
- At most 1 optional GAP line

Each FACT line — exact format (all four parts required on **one** line; no exceptions):
FACT: <one sentence> | URL: <full https:// URL> | QUOTE: "<=28 words" | SIGNAL: [SATURATED|UNDERREPORTED]

Never start a line with FACT: unless URL:, QUOTE:, and SIGNAL: all appear on that same line.
If you lack any one of them (common with Tier 6 if no page loads), output GAP: for that
angle instead — do not leave a dangling FACT.

SIGNAL rules:
- SATURATED = appears on 3+ pick/preview sites today (includes all injury/roster news
  that has reached mainstream coverage)
- UNDERREPORTED = sourced from Tier 2–5 primary source; absent from aggregators
  (Tier 6 ticket/money splits: UNDERREPORTED when the cited page is Action Network or
  another Tier 6 primary listed above, unless pick sites already lead with that exact split today — then SATURATED)

De-duplication: one line per distinct claim, best source wins.

If primary dig genuinely finds nothing after trying 2+ tiers:
GAP: <topic + tier searched> | (checked <source name>; no usable result)

Output shape: emit **only** FACT: or GAP: lines (one claim per line). No preamble, no
pass commentary, no headings, no numbered summaries — those are invalid output.`;

}

function counterNarrativePrompt(groundingFeedFacts, researchText) {
  const research = String(researchText || "").trim() || "(No research bullets; grounding only.)";
  return `Sports writer — **1–2 short paragraphs** (max ~120 words) for ONLY the skeptic / contra case (FEED + CONTRA RESEARCH). No cheering this ticket. No URLs in prose. If bullets are thin, say so; no filler.

FEED FACTS (unchanged):
${groundingFeedFacts}

CONTRA RESEARCH:
${research}

End with: The skeptic case in one line: <one sentence>`;
}

// ─── BIAS NARRATIVE PROMPT ───────────────────────────────────────────────────

/**
 * Bias/overpricing analysis — identifies narratives bettors over-price and
 * surfaces underreported market structure signals.
 * No web search — synthesizes pro + contra research only. Lowest token cost.
 */
function biasNarrativePrompt(grounding, proResearch, contraResearch) {
  const pro = String(proResearch || "").trim() || "(none)";
  const contra = String(contraResearch || "").trim() || "(none)";

  return `Sports betting analyst. Identify narratives bettors are likely to encounter
and over-price for THIS exact line. Use only facts already present in PRO RESEARCH
and CONTRA RESEARCH — do not introduce new stats, injuries, or results.

The closing one-line target may indict **either** the pro-ticket story or the contra story
(or both) — whichever the bullets show as most overpriced vs. most neglected.

${grounding}

PRO RESEARCH:
${pro}

CONTRA RESEARCH:
${contra}

OUTPUT FORMAT — strict, no deviations:

OVER-PRICED: <narrative name>
  WHY WEAK: <one sentence — sample size, recency bias, or public visibility>
  SIGNAL: SATURATED
  MARKET: <Tier 6 bet%/money% or RLM note if available; omit if no Tier 6 data>

  Rules: 2–3 OVER-PRICED lines max. Only flag claims where SIGNAL = SATURATED
  in research. Stop at 2 strong ones — do not pad.

UNDERPRICED: <narrative name>
  WHY MATTERS: <one sentence>
  SIGNAL: UNDERREPORTED
  MARKET: <Tier 6 sharp side indicator if available; omit if no Tier 6 data>

  Rules: 1–2 UNDERPRICED lines. This section is REQUIRED if any UNDERREPORTED
  facts exist in either research block — it is not optional filler.
  Tier 6 findings (bet % divergence, RLM) should always appear here if present.
  If genuinely no UNDERREPORTED facts exist in either research block, write:
    UNDERPRICED: none found in research pass.

No URLs, no hedging, no "on the other hand" balance — overpricing case only.

End with — Sharpest fade or edge target in one line: <one sentence>`;
}

function claudeTextFromResponse(data) {
  return (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

function claudeUsageFromResponse(data) {
  const u = data?.usage || null;
  const inputTokens = Number(u?.input_tokens);
  const outputTokens = Number(u?.output_tokens);
  return {
    input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
  };
}

function sumUsage(a, b) {
  const ai = Number(a?.input_tokens) || 0;
  const ao = Number(a?.output_tokens) || 0;
  const bi = Number(b?.input_tokens) || 0;
  const bo = Number(b?.output_tokens) || 0;
  return { input_tokens: ai + bi, output_tokens: ao + bo };
}

function estimateAnthropicCostUsd(usage, { inputUsdPerMTok, outputUsdPerMTok }) {
  const i = Number(usage?.input_tokens) || 0;
  const o = Number(usage?.output_tokens) || 0;
  if (!Number.isFinite(inputUsdPerMTok) || !Number.isFinite(outputUsdPerMTok)) return null;
  if (inputUsdPerMTok <= 0 || outputUsdPerMTok <= 0) return null;
  return (i / 1e6) * inputUsdPerMTok + (o / 1e6) * outputUsdPerMTok;
}

/** Vercel/.env values are strings; tolerate $, commas, spaces (e.g. "$3", "3.00", " 15 "). */
function parseEnvUsdPerMillionTokens(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw)
    .trim()
    .replace(/^\$/, "")
    .replace(/,/g, "");
  if (s === "") return null;
  const n = parseFloat(s, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Optional flat USD per web_search tool invocation; 0 means “no extra line item”. */
function parseEnvWebSearchUsd(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw)
    .trim()
    .replace(/^\$/, "")
    .replace(/,/g, "");
  if (s === "") return null;
  const n = parseFloat(s, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function anthropicPricingFromEnv() {
  return {
    anthropicInputUsdPerMTok: parseEnvUsdPerMillionTokens(process.env.GAMBLYZER_ANTHROPIC_INPUT_USD_PER_MTOK),
    anthropicOutputUsdPerMTok: parseEnvUsdPerMillionTokens(process.env.GAMBLYZER_ANTHROPIC_OUTPUT_USD_PER_MTOK),
    webSearchCostUsd: parseEnvWebSearchUsd(process.env.GAMBLYZER_WEB_SEARCH_COST_USD),
  };
}

const _pasteEnv = Number(process.env.GAMBLYZER_RESEARCH_PASTE_CHARS);
const NARR_RESEARCH_BUDGET_CHARS = Math.min(
  12_000,
  Math.max(3500, Number.isFinite(_pasteEnv) && _pasteEnv > 0 ? Math.floor(_pasteEnv) : 6500)
);

function researchSearchMaxTokens() {
  const n = Number(process.env.GAMBLYZER_RESEARCH_MAX_TOKENS);
  if (!Number.isFinite(n)) return 640;
  return Math.min(2000, Math.max(256, Math.floor(n)));
}

function narrativeWriteMaxTokens() {
  const n = Number(process.env.GAMBLYZER_NARRATIVE_MAX_TOKENS);
  if (!Number.isFinite(n)) return 768;
  return Math.min(2000, Math.max(256, Math.floor(n)));
}

function compactResearchForNarrative(researchText) {
  const t = String(researchText || "").trim();
  if (t.length <= NARR_RESEARCH_BUDGET_CHARS) return t;
  return `${t.slice(0, NARR_RESEARCH_BUDGET_CHARS)}\n[Truncated for API budget. The RESEARCH section after the case lists full citable lines.]`;
}

const BIAS_RESEARCH_BUDGET_CHARS = Math.min(12_000, Math.max(4000, NARR_RESEARCH_BUDGET_CHARS + 1500));

function truncateForBiasInput(researchText) {
  const t = String(researchText || "").trim();
  if (t.length <= BIAS_RESEARCH_BUDGET_CHARS) return t;
  return `${t.slice(0, BIAS_RESEARCH_BUDGET_CHARS)}\n[Truncated for bias synthesis budget.]`;
}

function biasNarrativeMaxTokens() {
  const n = Number(process.env.GAMBLYZER_BIAS_NARRATIVE_MAX_TOKENS);
  if (!Number.isFinite(n)) return 900;
  return Math.min(2000, Math.max(256, Math.floor(n)));
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

function bucketFromMarketKey(mk) {
  if (mk === "h2h") return { bucket: "moneyline", marketName: "Moneyline" };
  if (mk === "spreads") return { bucket: "spread", marketName: "Spread" };
  if (mk === "totals") return { bucket: "total", marketName: "Total" };
  return null;
}

async function fetchOddsForSport(key, sportKey, leagueCode) {
  const regions = DEFAULT_REGIONS;
  const markets = marketsQueryForLeague(leagueCode);
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

      const mapped = bucketFromMarketKey(mk);
      if (!mapped) continue;
      let { bucket, marketName } = mapped;

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
          else if (n === "draw") bookmakerOutcomeId = "draw";
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
          const team = String(o?.description || "").trim();
          if (n === "over" || n === "under") {
            bookmakerOutcomeId = `${Number.isFinite(pt) ? pt : ""}/${n}`.replace(/\/$/, "");
            if (team) {
              const teamSlug = normName(team).replace(/\s+/g, "_");
              bookmakerOutcomeId = `${bookmakerOutcomeId}/${teamSlug}`;
              outcome = Number.isFinite(pt) ? `${name} ${pt} (${team})` : `${name} (${team})`;
            } else {
              outcome = Number.isFinite(pt) ? `${name} ${pt}` : name;
            }
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

const ALLOWED_LEAGUES = ["NBA", "MLB", "NHL", "EPL"];

function normalizeLeagueSelection(leaguesRaw, leagueRaw) {
  if (Array.isArray(leaguesRaw)) {
    if (!leaguesRaw.length) throw new Error("Select at least one league.");
    const out = [...new Set(leaguesRaw.map((x) => String(x || "").toUpperCase().trim()))]
      .filter((c) => ALLOWED_LEAGUES.includes(c));
    if (!out.length) throw new Error("No valid leagues selected (use NBA / MLB / NHL / EPL).");
    return out.sort((a, b) => ALLOWED_LEAGUES.indexOf(a) - ALLOWED_LEAGUES.indexOf(b));
  }
  const l = String(leagueRaw || "NBA").toUpperCase().trim();
  if (l === "ALL") return [...ALLOWED_LEAGUES];
  if (!ALLOWED_LEAGUES.includes(l)) {
    throw new Error(`Unsupported league "${l}". Use NBA, MLB, NHL, EPL, ALL, or a leagues array.`);
  }
  return [l];
}

const AMERICAN_ODDS_CAP_MIN = -200;
const AMERICAN_ODDS_CAP_MAX = 300;

const BUCKET_ORDER = { moneyline: 0, spread: 1, total: 2 };

const MAX_RESTRICT_POOL_INDICES = 400;

/** Valid unique indices into sorted candidates; throws if absent/invalid usable entries. */
function normalizeRestrictPoolIndices(indices, sortedLength) {
  if (indices === undefined || indices === null) return null;
  if (!Array.isArray(indices)) throw new Error("restrictPoolIndices must be an array of integers.");
  if (sortedLength < 1) throw new Error("Pool is empty; cannot restrict.");
  const seen = new Set();
  const acc = [];
  for (const raw of indices) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n >= sortedLength) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    acc.push(n);
    if (acc.length >= MAX_RESTRICT_POOL_INDICES) break;
  }
  acc.sort((a, b) => a - b);
  if (!acc.length) {
    throw new Error("restrictPoolIndices must contain at least one valid index (0 … pool size − 1).");
  }
  return acc;
}

const MAX_PICK_BATCH = 12;

/** Fisher–Yates shuffle then take first k (unique when k ≤ arr.length). */
function sampleUniqueRandom(arr, k) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  const take = Math.min(k, copy.length);
  return copy.slice(0, take);
}

/**
 * For the random-pick step we treat both sides of one DK main market as the same group.
 * For a given fixture, moneyline home vs away, the two spread sides, and over vs under
 * on a total are all literal opposites; we never want two of them in one draw.
 */
function marketGroupKey(candidate) {
  const fid = candidate?.fixture?.fixtureId;
  const bucket = candidate?.dkRow?.bucket;
  if (!fid || !bucket) return null;
  return `${fid}::${bucket}`;
}

/**
 * Shuffle drawPool indices, then take up to k while skipping any index whose
 * candidate maps to a group already represented in the draw. Indices without a
 * resolvable group key (shouldn't normally happen) are always allowed through.
 */
function sampleUniqueRandomByGroup(drawPool, candidates, k, groupKeyFn) {
  const shuffled = [...drawPool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const taken = [];
  const seenGroups = new Set();
  for (const idx of shuffled) {
    if (taken.length >= k) break;
    const g = groupKeyFn(candidates[idx]);
    if (g && seenGroups.has(g)) continue;
    if (g) seenGroups.add(g);
    taken.push(idx);
  }
  return taken;
}

function allSortedIndices(n) {
  return Array.from({ length: n }, (_, i) => i);
}

function buildPickAtSortedIndex(candidates, idx, fullPoolSize, quotaHints, leagueCodes, extras) {
  const pick = candidates[idx];
  const { fixture, dkRow, key: groupKey, rows, sportLabel } = pick;
  const polyCandidates = (rows || []).filter((r) => r.book === "polymarket" && computeComparisonKey(r) === groupKey);
  const polyRow = polyCandidates[0] || null;

  return {
    fixture,
    sportLabel,
    dkRow,
    polyRow,
    poolSize: fullPoolSize,
    pickIndex: idx,
    quotaHints,
    selectedLeagues: leagueCodes,
    ...extras,
  };
}

function parsePickBatchCount(raw, hasPickIndex) {
  if (hasPickIndex) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_PICK_BATCH, Math.max(1, Math.floor(n)));
}

function sortCandidatesStable(list) {
  return [...list].sort((a, b) => {
    const ta = new Date(a.fixture?.startTime || 0).getTime();
    const tb = new Date(b.fixture?.startTime || 0).getTime();
    if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta - tb;
    if (!Number.isNaN(ta) && Number.isNaN(tb)) return -1;
    if (Number.isNaN(ta) && !Number.isNaN(tb)) return 1;

    const lc = String(a.sportLabel || "").localeCompare(String(b.sportLabel || ""));
    if (lc !== 0) return lc;
    const fa = String(a.fixture?.fixtureId || "");
    const fb = String(b.fixture?.fixtureId || "");
    const fc = fa.localeCompare(fb);
    if (fc !== 0) return fc;
    const ba = BUCKET_ORDER[a.dkRow.bucket] ?? 99;
    const bb = BUCKET_ORDER[b.dkRow.bucket] ?? 99;
    if (ba !== bb) return ba - bb;
    const ka = computeComparisonKey(a.dkRow).localeCompare(computeComparisonKey(b.dkRow));
    if (ka !== 0) return ka;
    const oa = String(a.dkRow?.outcome || "").localeCompare(String(b.dkRow?.outcome || ""));
    if (oa !== 0) return oa;
    const aa = parseAmericanOdds(a.dkRow?.american);
    const ab = parseAmericanOdds(b.dkRow?.american);
    if (aa !== ab && Number.isFinite(aa) && Number.isFinite(ab)) return aa - ab;
    const da = Number(a.dkRow?.decimalOdds);
    const db = Number(b.dkRow?.decimalOdds);
    if (Number.isFinite(da) && Number.isFinite(db) && da !== db) return da - db;
    return 0;
  });
}

async function buildSortedCandidates({ league, leagues, min, max }) {
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
    const { data, quota } = await fetchOddsForSport(oddsKey, sportKey, code);
    quotaHints.push({ league: code, ...quota });
    const dayEvs = filterEventsByEarliestUpcomingLocalDay(data).map((ev) => ({ ev, leagueCode: code }));
    todays.push(...dayEvs);
  }

  if (!todays.length) {
    throw new Error(`No upcoming games with odds for leagues ${leaguesLabel} (could not find a valid commence_time).`);
  }

  const candidates = [];
  for (const item of todays) {
    const ev = item.ev;
    const leagueCode = item.leagueCode || leagueCodes[0];
    const fixture = fixtureFromOddsEvent(ev);
    const rows = flattenCoreLinesFromTheOddsApi(ev);

    const book = sportsbookForLeagueCode(leagueCode);
    const buckets = allowedBucketsForLeague(leagueCode);
    const bookRows = rows.filter((r) => r.book === book && buckets.includes(r.bucket));
    for (const r of bookRows) {
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
    const booksLabel = [...new Set(leagueCodes.map(sportsbookForLeagueCode).map(sportsbookDisplayName))].join(" / ");
    throw new Error(`No ${booksLabel} lines found between ${range.min} and ${range.max}.`);
  }

  const sorted = sortCandidatesStable(candidates);

  return { sorted, quotaHints, leagueCodes, range };
}

/** Returns a preview-only list plus total pool size for the UI. */
export async function listEligibleLines({ league, leagues, min, max, limit = 250 }) {
  const { sorted, quotaHints, leagueCodes, range } = await buildSortedCandidates({ league, leagues, min, max });
  const cap = Math.min(400, Math.max(1, Number(limit) || 250));
  const previews = sorted.slice(0, cap).map((c, i) => ({
    index: i,
    fixture: {
      fixtureId: c.fixture?.fixtureId,
      participant1Name: c.fixture?.participant1Name,
      participant2Name: c.fixture?.participant2Name,
      startTime: c.fixture?.startTime,
    },
    sportLabel: c.sportLabel,
    dkRow: {
      book: c.dkRow.book,
      bucket: c.dkRow.bucket,
      marketName: c.dkRow.marketName,
      outcome: c.dkRow.outcome,
      american: c.dkRow.american || "",
      decimalOdds: c.dkRow.decimalOdds,
    },
    sportsbookLabel: sportsbookDisplayName(c.dkRow.book),
    comparisonKey: c.key,
  }));
  return {
    poolSize: sorted.length,
    previews,
    previewsTruncated: sorted.length > previews.length,
    range,
    quotaHints,
    selectedLeagues: leagueCodes,
  };
}

/**
 * One odds fetch, then N distinct random picks (no replacement within the draw pool).
 * @param {number} [count] — ignored when pickIndex is set (always 1).
 */
export async function generatePicks({ league, leagues, min, max, pickIndex, restrictPoolIndices, count }) {
  const { sorted: candidates, quotaHints, leagueCodes } = await buildSortedCandidates({ league, leagues, min, max });
  const fullPoolSize = candidates.length;

  const restricted = normalizeRestrictPoolIndices(restrictPoolIndices, fullPoolSize);
  const userPoolExtras = restricted ? { userPoolRestricted: true, userPoolSize: restricted.length } : {};

  const hasPickIndex = pickIndex !== undefined && pickIndex !== null;
  const requestedN = parsePickBatchCount(count, hasPickIndex);

  let chosenIdxs;

  if (hasPickIndex) {
    const n = Number(pickIndex);
    if (!Number.isInteger(n) || n < 0 || n >= fullPoolSize) {
      throw new Error(`pickIndex must be between 0 and ${fullPoolSize - 1}`);
    }
    if (restricted && !restricted.includes(n)) {
      throw new Error(`pickIndex #${n} is not in restrictPoolIndices for this pick.`);
    }
    chosenIdxs = [n];
  } else {
    const drawPool = restricted || allSortedIndices(fullPoolSize);
    const take = Math.min(requestedN, drawPool.length);
    chosenIdxs = sampleUniqueRandomByGroup(drawPool, candidates, take, marketGroupKey);
    chosenIdxs.sort((a, b) => a - b); // deterministic order by line index after draw
  }

  const picks = chosenIdxs.map((idx) =>
    buildPickAtSortedIndex(candidates, idx, fullPoolSize, quotaHints, leagueCodes, userPoolExtras)
  );

  const batchTruncated = !hasPickIndex && picks.length < requestedN;

  return {
    picks,
    pickBatchRequested: requestedN,
    pickBatchReturned: picks.length,
    poolSize: fullPoolSize,
    batchTruncated,
  };
}

export async function generatePickOnly(params) {
  const { picks } = await generatePicks(params);
  return picks[0];
}

async function runResearchLeg(pick, { counter, userContext, gapClosure, claudeKey, geminiKey, model }) {
  const grounding = buildGroundingBlock(pick);
  const baseR = counter ? counterResearchPrompt(grounding) : researchPrompt(grounding);
  const rPrompt = baseR + researchUserDirectionBlock(userContext) + researchGapClosureBlock(gapClosure);
  let researchText = "";
  let usedProvider = "claude";
  let usageEntry = null;
  let webSearchCalls = 0;

  if (claudeKey) {
    const res = await claudeWithRetry(claudeKey, () => ({
      model,
      max_tokens: researchSearchMaxTokens(),
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: rPrompt }],
    }));
    const data = await res.json();
    researchText = claudeTextFromResponse(data);
    const u = claudeUsageFromResponse(data);
    usageEntry = {
      provider: "anthropic",
      model,
      step: counter ? "counter_research" : "research",
      usage: u,
    };
    webSearchCalls = 1;
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
  return { researchText, usageEntry, webSearchCalls, usedProvider, model };
}

async function runNarrativeLeg(pick, {
  counter,
  researchText,
  narrateViaGemini,
  researchUsedProvider,
  claudeKey,
  geminiKey,
  model,
}) {
  const feedFactsLine = buildGroundingBlockNarrative(pick);
  const compactR = compactResearchForNarrative(researchText);
  const nPrompt = counter ? counterNarrativePrompt(feedFactsLine, compactR) : narrativePrompt(feedFactsLine, compactR);
  let narrative = "";
  let usageEntry = null;
  const narrCap = narrativeWriteMaxTokens();
  if ((narrateViaGemini || researchUsedProvider !== "claude") && geminiKey) {
    const res2 = await geminiWithRetry(geminiKey, () => ({
      contents: [{ parts: [{ text: nPrompt }] }],
      generationConfig: { temperature: counter ? 0.28 : 0.25, maxOutputTokens: narrCap },
    }));
    const data2 = await res2.json();
    narrative = data2?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  } else if (claudeKey) {
    const res2 = await claudeWithRetry(claudeKey, () => ({
      model,
      max_tokens: narrCap,
      temperature: counter ? 0.28 : 0.25,
      messages: [{ role: "user", content: nPrompt }],
    }));
    const data2 = await res2.json();
    narrative = claudeTextFromResponse(data2);
    const u2 = claudeUsageFromResponse(data2);
    usageEntry = {
      provider: "anthropic",
      model,
      step: counter ? "counter_narrative" : "narrative",
      usage: u2,
    };
  }
  return { narrative, usageEntry };
}

async function runBiasLeg(feedFactsLine, proResearchFull, contraResearchFull, {
  narrateViaGemini,
  researchUsedProvider,
  claudeKey,
  geminiKey,
  model,
}) {
  const prompt = biasNarrativePrompt(
    feedFactsLine,
    truncateForBiasInput(proResearchFull),
    truncateForBiasInput(contraResearchFull)
  );
  let text = "";
  let usageEntry = null;
  const biasCap = biasNarrativeMaxTokens();
  if ((narrateViaGemini || researchUsedProvider !== "claude") && geminiKey) {
    const res = await geminiWithRetry(geminiKey, () => ({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.22, maxOutputTokens: biasCap },
    }));
    const data = await res.json();
    text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  } else if (claudeKey) {
    const res = await claudeWithRetry(claudeKey, () => ({
      model,
      max_tokens: biasCap,
      temperature: 0.22,
      messages: [{ role: "user", content: prompt }],
    }));
    const data = await res.json();
    text = claudeTextFromResponse(data);
    const u = claudeUsageFromResponse(data);
    usageEntry = { provider: "anthropic", model, step: "bias_narrative", usage: u };
  }
  if (!String(text || "").trim()) {
    text =
      "Bias synthesis returned empty. Sharpest fade or edge target in one line: Re-read primary and counter FACT lines for market vs. process signals.";
  }
  return { text, usageEntry };
}

function buildResearchLlmUsage({
  usedProvider,
  model,
  usageByStep,
  usageTotal,
  webSearchCalls,
  anthropicInputUsdPerMTok,
  anthropicOutputUsdPerMTok,
  webSearchCostUsd,
}) {
  const totalTokens = (Number(usageTotal.input_tokens) || 0) + (Number(usageTotal.output_tokens) || 0);
  const tokenCostUsd =
    usedProvider === "claude"
      ? estimateAnthropicCostUsd(usageTotal, {
          inputUsdPerMTok: anthropicInputUsdPerMTok,
          outputUsdPerMTok: anthropicOutputUsdPerMTok,
        })
      : null;
  const toolCostUsd =
    usedProvider === "claude" && webSearchCalls > 0 && Number.isFinite(webSearchCostUsd) && webSearchCostUsd > 0
      ? webSearchCalls * webSearchCostUsd
      : null;
  const estimatedCostUsd =
    usedProvider === "claude" && (tokenCostUsd != null || toolCostUsd != null)
      ? (tokenCostUsd || 0) + (toolCostUsd || 0)
      : null;
  return {
    provider: usedProvider,
    model: usedProvider === "claude" ? model : null,
    usage_total: usedProvider === "claude" ? { ...usageTotal, total_tokens: totalTokens } : null,
    usage_by_step: usedProvider === "claude" ? usageByStep : [],
    estimated_cost_usd: estimatedCostUsd,
    web_search_calls: usedProvider === "claude" ? webSearchCalls : 0,
    tool_cost_usd: toolCostUsd,
    pricing_hint:
      usedProvider === "claude" && estimatedCostUsd === null
        ? {
            env: [
              "GAMBLYZER_ANTHROPIC_INPUT_USD_PER_MTOK",
              "GAMBLYZER_ANTHROPIC_OUTPUT_USD_PER_MTOK",
              "GAMBLYZER_WEB_SEARCH_COST_USD",
            ],
          }
        : null,
  };
}

async function generateResearchArtifacts(pick, { counter = false, userContext = "", gapClosure = "" } = {}) {
  assertPickShape(pick);

  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!claudeKey && !geminiKey) throw new Error("Missing env var ANTHROPIC_API_KEY (or GEMINI_API_KEY as fallback)");

  const { anthropicInputUsdPerMTok, anthropicOutputUsdPerMTok, webSearchCostUsd } = anthropicPricingFromEnv();

  const model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
  const narrateViaGemini = Boolean(geminiKey && process.env.GAMBLYZER_NARRATE_VIA_GEMINI === "1");

  const r = await runResearchLeg(pick, { counter, userContext, gapClosure, claudeKey, geminiKey, model });
  const n = await runNarrativeLeg(pick, {
    counter,
    researchText: r.researchText,
    narrateViaGemini,
    researchUsedProvider: r.usedProvider,
    claudeKey,
    geminiKey,
    model,
  });

  let narrative = n.narrative;
  if (!String(narrative || "").trim()) {
    narrative = counter
      ? "Thin contrarian sourcing. The skeptic case in one line: Returned empty prose — inspect contra bullets behind the divider."
      : "Online context was limited. The case in one line: The model returned an empty write-up — use the research bullets and posted odds, and double-check any claims.";
  }

  const narrativeCombined = `${narrative.trim()}\n\n<<<GAMBLYZER_SOURCES>>>\n${String(r.researchText || "").trim()}`;

  const usageByStep = [];
  let usageTotal = { input_tokens: 0, output_tokens: 0 };
  if (r.usageEntry) {
    usageByStep.push(r.usageEntry);
    usageTotal = sumUsage(usageTotal, r.usageEntry.usage);
  }
  if (n.usageEntry) {
    usageByStep.push(n.usageEntry);
    usageTotal = sumUsage(usageTotal, n.usageEntry.usage);
  }

  let llmUsage = buildResearchLlmUsage({
    usedProvider: r.usedProvider,
    model,
    usageByStep,
    usageTotal,
    webSearchCalls: r.webSearchCalls,
    anthropicInputUsdPerMTok,
    anthropicOutputUsdPerMTok,
    webSearchCostUsd,
  });

  if (counter) {
    const nc = String(pick?.narrativeCombined || "").trim();
    if (nc.includes("<<<GAMBLYZER_SOURCES>>>")) {
      const proSplit = splitNarrativeAndSourcesBlock(nc);
      const proResearchBullets = String(proSplit.sources || "").trim();
      const feedFactsLine = buildGroundingBlockNarrative(pick);
      try {
        const bOut = await runBiasLeg(feedFactsLine, proResearchBullets, r.researchText, {
          narrateViaGemini,
          researchUsedProvider: r.usedProvider,
          claudeKey,
          geminiKey,
          model,
        });
        if (bOut.usageEntry) {
          usageByStep.push(bOut.usageEntry);
          usageTotal = sumUsage(usageTotal, bOut.usageEntry.usage);
        }
        llmUsage = buildResearchLlmUsage({
          usedProvider: r.usedProvider,
          model,
          usageByStep,
          usageTotal,
          webSearchCalls: r.webSearchCalls,
          anthropicInputUsdPerMTok,
          anthropicOutputUsdPerMTok,
          webSearchCostUsd,
        });
        return {
          counterNarrativeCombined: narrativeCombined,
          biasNarrative: String(bOut.text || "").trim(),
          llmUsage,
        };
      } catch {
        /* bias is best-effort when counter is added after primary */
      }
    }
    return { counterNarrativeCombined: narrativeCombined, llmUsage };
  }

  return { narrativeCombined, llmUsage };
}

async function generateResearchArtifactsPrimaryWithBias(pick, { userContext = "", gapClosure = "" } = {}) {
  assertPickShape(pick);

  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!claudeKey && !geminiKey) throw new Error("Missing env var ANTHROPIC_API_KEY (or GEMINI_API_KEY as fallback)");

  const { anthropicInputUsdPerMTok, anthropicOutputUsdPerMTok, webSearchCostUsd } = anthropicPricingFromEnv();

  const model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
  const narrateViaGemini = Boolean(geminiKey && process.env.GAMBLYZER_NARRATE_VIA_GEMINI === "1");

  const rPro = await runResearchLeg(pick, {
    counter: false,
    userContext,
    gapClosure,
    claudeKey,
    geminiKey,
    model,
  });

  const feedFactsLine = buildGroundingBlockNarrative(pick);
  const researchUsedProvider = rPro.usedProvider;

  const [nPro, bOut] = await Promise.all([
    runNarrativeLeg(pick, {
      counter: false,
      researchText: rPro.researchText,
      narrateViaGemini,
      researchUsedProvider,
      claudeKey,
      geminiKey,
      model,
    }),
    runBiasLeg(feedFactsLine, rPro.researchText, "(none)", {
      narrateViaGemini,
      researchUsedProvider,
      claudeKey,
      geminiKey,
      model,
    }),
  ]);

  let proNarr = nPro.narrative;
  if (!String(proNarr || "").trim()) {
    proNarr =
      "Online context was limited. The case in one line: The model returned an empty write-up — use the research bullets and posted odds, and double-check any claims.";
  }

  const narrativeCombined = `${proNarr.trim()}\n\n<<<GAMBLYZER_SOURCES>>>\n${String(rPro.researchText || "").trim()}`;
  const biasNarrative = String(bOut.text || "").trim();

  const usageByStep = [];
  let usageTotal = { input_tokens: 0, output_tokens: 0 };
  let webSearchCalls = 0;
  for (const leg of [rPro]) {
    if (leg.usageEntry) {
      usageByStep.push(leg.usageEntry);
      usageTotal = sumUsage(usageTotal, leg.usageEntry.usage);
    }
    webSearchCalls += leg.webSearchCalls;
  }
  for (const entry of [nPro.usageEntry, bOut.usageEntry]) {
    if (entry) {
      usageByStep.push(entry);
      usageTotal = sumUsage(usageTotal, entry.usage);
    }
  }

  const llmUsage = buildResearchLlmUsage({
    usedProvider: researchUsedProvider,
    model,
    usageByStep,
    usageTotal,
    webSearchCalls,
    anthropicInputUsdPerMTok,
    anthropicOutputUsdPerMTok,
    webSearchCostUsd,
  });

  return { narrativeCombined, biasNarrative, llmUsage };
}

async function generateResearchArtifactsParallel(
  pick,
  {
    userContext = "",
    gapClosure = "",
    counterUserContext = "",
    counterGapClosure = "",
  } = {}
) {
  assertPickShape(pick);

  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!claudeKey && !geminiKey) throw new Error("Missing env var ANTHROPIC_API_KEY (or GEMINI_API_KEY as fallback)");

  const { anthropicInputUsdPerMTok, anthropicOutputUsdPerMTok, webSearchCostUsd } = anthropicPricingFromEnv();

  const model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
  const narrateViaGemini = Boolean(geminiKey && process.env.GAMBLYZER_NARRATE_VIA_GEMINI === "1");

  const [rPro, rCon] = await Promise.all([
    runResearchLeg(pick, {
      counter: false,
      userContext,
      gapClosure,
      claudeKey,
      geminiKey,
      model,
    }),
    runResearchLeg(pick, {
      counter: true,
      userContext: counterUserContext,
      gapClosure: counterGapClosure,
      claudeKey,
      geminiKey,
      model,
    }),
  ]);

  const feedFactsLine = buildGroundingBlockNarrative(pick);
  const researchUsedProvider = rPro.usedProvider;

  const [nPro, nCon, bOut] = await Promise.all([
    runNarrativeLeg(pick, {
      counter: false,
      researchText: rPro.researchText,
      narrateViaGemini,
      researchUsedProvider,
      claudeKey,
      geminiKey,
      model,
    }),
    runNarrativeLeg(pick, {
      counter: true,
      researchText: rCon.researchText,
      narrateViaGemini,
      researchUsedProvider,
      claudeKey,
      geminiKey,
      model,
    }),
    runBiasLeg(feedFactsLine, rPro.researchText, rCon.researchText, {
      narrateViaGemini,
      researchUsedProvider,
      claudeKey,
      geminiKey,
      model,
    }),
  ]);

  let proNarr = nPro.narrative;
  let conNarr = nCon.narrative;
  if (!String(proNarr || "").trim()) {
    proNarr =
      "Online context was limited. The case in one line: The model returned an empty write-up — use the research bullets and posted odds, and double-check any claims.";
  }
  if (!String(conNarr || "").trim()) {
    conNarr =
      "Thin contrarian sourcing. The skeptic case in one line: Returned empty prose — inspect contra bullets behind the divider.";
  }

  const narrativeCombined = `${proNarr.trim()}\n\n<<<GAMBLYZER_SOURCES>>>\n${String(rPro.researchText || "").trim()}`;
  const counterNarrativeCombined = `${conNarr.trim()}\n\n<<<GAMBLYZER_SOURCES>>>\n${String(rCon.researchText || "").trim()}`;
  const biasNarrative = String(bOut.text || "").trim();

  const usageByStep = [];
  let usageTotal = { input_tokens: 0, output_tokens: 0 };
  let webSearchCalls = 0;
  for (const leg of [rPro, rCon]) {
    if (leg.usageEntry) {
      usageByStep.push(leg.usageEntry);
      usageTotal = sumUsage(usageTotal, leg.usageEntry.usage);
    }
    webSearchCalls += leg.webSearchCalls;
  }
  for (const entry of [nPro.usageEntry, nCon.usageEntry, bOut.usageEntry]) {
    if (entry) {
      usageByStep.push(entry);
      usageTotal = sumUsage(usageTotal, entry.usage);
    }
  }

  const llmUsage = buildResearchLlmUsage({
    usedProvider: researchUsedProvider,
    model,
    usageByStep,
    usageTotal,
    webSearchCalls,
    anthropicInputUsdPerMTok,
    anthropicOutputUsdPerMTok,
    webSearchCostUsd,
  });

  return { narrativeCombined, counterNarrativeCombined, biasNarrative, llmUsage };
}

export async function generateResearchNarrative(pick, options = {}) {
  if (options.includeCounter === true) {
    return generateResearchArtifactsParallel(pick, options);
  }
  return generateResearchArtifactsPrimaryWithBias(pick, options);
}

export async function generateCounterResearchNarrative(pick, options = {}) {
  return generateResearchArtifacts(pick, { counter: true, ...options });
}

function splitNarrativeAndSourcesBlock(combined) {
  const s = String(combined || "");
  const parts = s.split(/\n<<<GAMBLYZER_SOURCES>>>\n/);
  if (parts.length < 2) return { narrative: s.trim(), sources: "" };
  return { narrative: parts[0].trim(), sources: parts.slice(1).join("\n<<<GAMBLYZER_SOURCES>>>\n").trim() };
}

const JUDGE_PER_PICK_CHAR_BUDGET = 7600;
const _envJudgeUserCtxCap = Number(process.env.GAMBLYZER_JUDGE_USER_CONTEXT_MAX_CHARS);
const JUDGE_USER_CONTEXT_MAX_CHARS = Math.min(
  16_000,
  Math.max(
    2000,
    Number.isFinite(_envJudgeUserCtxCap) && _envJudgeUserCtxCap > 0 ? _envJudgeUserCtxCap : 8000
  )
);

function sanitizeUserJudgeContext(raw) {
  const t = String(raw || "").replace(/\u0000/g, "").trim();
  if (!t) return null;
  if (t.length > JUDGE_USER_CONTEXT_MAX_CHARS) {
    return `${t.slice(0, JUDGE_USER_CONTEXT_MAX_CHARS)}\n[User-supplied context truncated for judge payload budget.]`;
  }
  return t;
}

function userContextJudgeAddendum(userContext, { allowWeb = false } = {}) {
  const block = sanitizeUserJudgeContext(userContext);
  if (!block) return "";
  const factualRules = allowWeb
    ? `**Factual assertions in USER NOTES** → you may use **web_search** sparingly to verify or refute them. Still reconcile findings with dossier FACT/GAP lines; if search contradicts a dossier cite, call that out explicitly.`
    : `**Factual assertions** → do **not** treat as proven; reconcile with dossier FACT/GAP lines. If user text conflicts with cites, privilege **cited** dossier material and say so.`;
  return `

═══════════════════════════════════════════════════════
USER-SUPPLIED CONTEXT (not from Mahowny dossiers${allowWeb ? "; web verification allowed below" : "; not web-fetched here"})
═══════════════════════════════════════════════════════
The bettor added the notes below. Treat them as **unverified** unless they are clearly **preferences only** (e.g. bankroll rules, leagues they avoid).

Rules for using this block:
- **Preferences / strategy** → apply directly when choosing among options or stance (e.g. “no heavy juice”, “prefer unders”).
${factualRules}
- **Rumors or “I heard”** → label as low-trust; do not upgrade to fact.
- Explain in your reasoning **how** this context changed (or did not change) your verdict versus a read of dossiers alone.

USER NOTES:
${block}`;
}

function truncateForJudge(s, max) {
  const t = String(s || "").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n[Truncated for judge context budget.]`;
}

function judgeBiasReadBlock(pick) {
  const b = String(pick?.biasNarrative || "").trim();
  if (!b) return "(No bias read on file for this option — integrate only support + counter + grounding.)";
  const cap = Math.min(4000, Math.max(1200, Math.floor(JUDGE_PER_PICK_CHAR_BUDGET / 2)));
  return truncateForJudge(b, cap);
}

/** ~even split so pro/con/bias fit inside per-option caps. */
function judgePromptForBatch(picks, userContext, allowWeb) {
  const q = Math.floor(JUDGE_PER_PICK_CHAR_BUDGET / 5);
  let body = "";
  for (let i = 0; i < picks.length; i++) {
    const grounding = buildGroundingBlock(picks[i]);
    const { narrative, sources } = splitNarrativeAndSourcesBlock(picks[i].narrativeCombined);
    const hasCounter = Boolean(
      picks[i]?.counterNarrativeCombined &&
      String(picks[i].counterNarrativeCombined).includes("<<<GAMBLYZER_SOURCES>>>")
    );
    const ctr = hasCounter ? splitNarrativeAndSourcesBlock(picks[i].counterNarrativeCombined) : null;
    const counterBlock =
      ctr && hasCounter
        ? `
COUNTER CASE (contrarian dossier — narrative):

${truncateForJudge(ctr.narrative, q)}

COUNTER CASE — cites / FACT lines:

${truncateForJudge(ctr.sources, q)}`
        : `
(No counter dossier was generated for this option — you may still weigh SUPPORT + BIAS; other options may have fuller contra material.)`;

    const biasBlock = `
BIAS READ (narrative over/under-pricing — no separate URL list):
${judgeBiasReadBlock(picks[i])}`;

    body += `\n═══════════════════════════════════════════════════════
OPTION ${i + 1} · SLOT_INDEX: ${i} (SLOT_INDEX is 0-based for **this batch only**; in your prose, ALWAYS say “Option ${i + 1}”, never “Option ${i}”)
═══════════════════════════════════════════════════════
${grounding}

SUPPORTING CASE (Mahowny research — narrative):

${truncateForJudge(narrative, q)}

SUPPORTING CASE — research bullets:

${truncateForJudge(sources, q)}
${counterBlock}
${biasBlock}
`;
  }

  const n = picks.length;
  const maxIx = Math.max(0, n - 1);
  const webRule = allowWeb
    ? `You have a **web_search** tool. Use it **only when needed** to verify factual claims that appear **solely** in USER-SUPPLIED CONTEXT — not to replace reading the dossiers. Ticket-vs-ticket reasoning must still cite dossier strengths/weaknesses; search calibrates trust in bettor-typed facts only.`
    : `You MUST NOT browse the web; use only pasted text.`;

  return `You adjudicate among ${picks.length} DIFFERENT bet tickets (“options”) submitted in this batch. Each option’s **full dossier** may include:
- SUPPORTING dossier (pro-case narrative + research bullets)
- optional COUNTER dossier (contrarian narrative + research bullets)
- optional BIAS read (synthesis on over- vs under-priced narratives — treat as part of the same dossier, not external trivia)

${webRule}

CRITICAL LABELING RULE:
- In your DETAILED REASONING, refer to tickets as **Option 1..${picks.length}** (human-facing). Do **not** use “Option 0”.
- SLOT_INDEX is 0-based **within this batch** and is used ONLY for RECOMMENDED_PICK_INDEX and FULL_RANKING_SLOTS.

WEIGHTING (no numeric scores — holistic judgment):
- **Primary factor:** narrative strength and **defensibility** of each wing and of the overall ticket story (how well arguments hang together vs hand-waving), read across SUPPORT + COUNTER + BIAS together with grounding.
- **Fact quality over quantity:** judge how **material, specific, and well-supported** the cited facts are — **not** how many FACT vs GAP lines appear. A few sharp, well-cited points outweigh a long list of weak or redundant bullets.
- **Counter dossier:** you may side with the **contrarian** read for any option when that wing (plus bias, when relevant) is more defensible than support. **RECOMMENDED_PICK_INDEX may name an option whose clearest epistemic conclusion is to favor the counter / fade the posted line** — say so plainly in ONE_LINE_SUMMARY and in the ranking rationale (this is not a “pick the best bet to play” contest; it is a comparative read of dossier quality and coherence).
- If an option has no counter dossier, note that blind spot vs options with fuller debate, but do **not** rank by bullet counts.

TASK (information quality — NOT predicting game outcomes):
- For each OPTION, integrate SUPPORT, COUNTER (if present), and BIAS into one mental model of how strong each ticket’s overall case is.
- Compare options on **defensibility and coherence** of the whole dossier, not on tallying FACT/GAP lines.
- Order options by your comparative judgment; **#1 may be an option where the counter + bias story is the strongest read** (e.g. best-documented fade among the batch).

RULES:
- Quote/paraphrase dossiers (including bias prose where it matters) when comparing options.
${allowWeb ? "- You may cite **web_search** results **only** when checking USER-SUPPLIED CONTEXT — not as a substitute for dossier-based comparison." : "- Outside knowledge is not factual input for this verdict."}
- Emit RECOMMENDED_PICK_INDEX as the **#1** option’s SLOT_INDEX after cross-reading all dossiers — not “favorite team” intuition.
- Emit FULL_RANKING_SLOTS as **every** SLOT_INDEX **0–${maxIx}** ordered **best → worst** (comma-separated, no duplicates). RECOMMENDED_PICK_INDEX must equal the **first** integer in FULL_RANKING_SLOTS.

${body}
${userContextJudgeAddendum(userContext, { allowWeb })}

REQUIRED FORMAT — verbatim first lines (machine-parsable):
RECOMMENDED_PICK_INDEX: <integer 0-${maxIx} — SLOT_INDEX of the #1 option in this batch; must match first entry of FULL_RANKING_SLOTS>
FULL_RANKING_SLOTS: <e.g. for 3 picks "1,0,2" means slot 1 is 1st best, slot 0 is 2nd, slot 2 is 3rd — use SLOT_INDEX integers only>
CONFIDENCE: <low|medium|high>
ONE_LINE_SUMMARY: <single line>

Blank line then DETAILED REASONING (compare options; when USER-SUPPLIED CONTEXT exists, integrate it explicitly; reference bias where it changes your read).`;

}

function validatePrimaryResearchBlob(pick) {
  const nc = String(pick?.narrativeCombined || "").trim();
  if (!nc || !nc.includes("<<<GAMBLYZER_SOURCES>>>")) {
    throw new Error("Each pick must include completed primary research before judging.");
  }
}

function validateCounterResearchBlob(pick) {
  const cc = String(pick?.counterNarrativeCombined || "").trim();
  if (!cc || !cc.includes("<<<GAMBLYZER_SOURCES>>>")) {
    throw new Error("Single-ticket judgment needs a generated counter dossier (counter narrative + sources).");
  }
}

function judgePromptSingleTicketProCon(pick, userContext, allowWeb) {
  validatePrimaryResearchBlob(pick);
  validateCounterResearchBlob(pick);
  const grounding = buildGroundingBlock(pick);
  const pro = splitNarrativeAndSourcesBlock(pick.narrativeCombined);
  const contra = splitNarrativeAndSourcesBlock(pick.counterNarrativeCombined);
  const B = Math.floor(JUDGE_PER_PICK_CHAR_BUDGET / 5);
  const webRule = allowWeb
    ? `Dossiers below are fixed. If USER-SUPPLIED CONTEXT appears, you **may** use **web_search** sparingly to verify factual claims stated **only** there — not to re-litigate the whole ticket without dossier cites.`
    : `Texts come from earlier search-backed passes — you MUST NOT browse the web.`;

  const bookLabel = sportsbookDisplayName(pick?.dkRow?.book || sportsbookForLeagueCode(pick?.sportLabel));
  return `You balance ONE wager’s **full dossier**: SUPPORTING case, CONTRARY case, and BIAS read (same posted ${bookLabel} line below). ${webRule}

GROUNDING TICKET (authoritative matchup + line):
${grounding}

—— SUPPORT narrative:
${truncateForJudge(pro.narrative, B)}

—— SUPPORT bullets / URLs:
${truncateForJudge(pro.sources, B)}

—— COUNTER / SKEPTIC narrative:
${truncateForJudge(contra.narrative, B)}

—— COUNTER bullets / URLs:
${truncateForJudge(contra.sources, B)}

—— BIAS READ (over/under-priced narratives):
${judgeBiasReadBlock(pick)}

WEIGHTING (holistic — NOT a game-score prediction):
- **Primary:** narrative strength and **defensibility** of each wing and of the overall story (support vs counter vs bias as one integrated read).
- **Fact quality:** weigh how **material and well-supported** key facts are — **not** how many FACT or GAP lines appear.
- You are **not** required to side with SUPPORT. **FAVOR_COUNTER_DOSSIER** is always on the table when the contrarian dossier (including how bias frames the ticket) is the more defensible read.

TASK: After reading SUPPORT, COUNTER, and BIAS together with grounding, decide which stance best matches the evidence. Prefer **FAVOR_COUNTER_DOSSIER** whenever the skeptic side is clearly more defensible — do not soften into TAKE to be polite to the bet.
${userContextJudgeAddendum(userContext, { allowWeb })}

STANCE CHOICE (pick exactly one — machine token matters):
- **TAKE_TICKET** — after integrating all three layers, the SUPPORTING case for playing this priced side remains more grounded than counter + bias suggest.
- **FAVOR_COUNTER_DOSSIER** — the COUNTER / skeptic read (as informed by bias) is **more defensible** than support for this ticket; fading or passing is the stronger epistemic read.
- **PASS_TICKET** — both wings plus bias read as weak, muddled, or non-actionable; walk away without declaring counter the winner.
- **TOO_CLOSE_TO_CALL** — genuinely balanced strength on both sides after integrating bias.

RESPONSE FORMAT — verbatim headers first:
RECOMMENDED_STANCE: <TAKE_TICKET | FAVOR_COUNTER_DOSSIER | PASS_TICKET | TOO_CLOSE_TO_CALL>
CONFIDENCE: <low|medium|high>
ONE_LINE_SUMMARY: <one line verdict>

Blank line, then DETAILED REASONING (compare wing vs wing and cite bias where it shifts the read; if USER-SUPPLIED CONTEXT exists, integrate it explicitly).`;
}

function mapTicketStanceToken(raw) {
  if (!raw) return null;
  const u = String(raw).toUpperCase().trim();
  if (u.includes("FAVOR_COUNTER")) return "counter";
  if (u.includes("TAKE_TICKET")) return "take";
  if (u.includes("PASS_TICKET")) return "pass";
  if (u.includes("TOO_CLOSE")) return "split";
  return null;
}

function parseJudgeSingleTicketOutput(rawText) {
  const text = String(rawText || "").trim();
  const stanceMatch = text.match(/RECOMMENDED_STANCE:\s*([^\n]+)/i);
  const confMatch = text.match(/CONFIDENCE:\s*(low|medium|high)\b/i);
  const lineMatch = text.match(/ONE_LINE_SUMMARY:\s*([^\n]+)/i);

  const ticketStance = mapTicketStanceToken(stanceMatch ? stanceMatch[1].trim() : null);
  const confidence = confMatch ? confMatch[1].toLowerCase() : null;
  const oneLineSummary = lineMatch ? lineMatch[1].trim() : "";

  let reasoning = text;
  for (let k = 0; k < 6; k++) {
    const next = reasoning
      .replace(/^\s*RECOMMENDED_STANCE:\s*[^\n]+\n?/im, "")
      .replace(/^\s*CONFIDENCE:\s*(low|medium|high)\s*\n?/im, "")
      .replace(/^\s*ONE_LINE_SUMMARY:\s*[^\n]+\n?/im, "")
      .trim();
    if (next === reasoning) break;
    reasoning = next;
  }
  if (!reasoning) reasoning = text;

  return {
    judgeMode: "single_pro_contra",
    ticketStance,
    chosenSlotIndex: 0,
    confidence,
    oneLineSummary,
    reasoning,
    rawText: text,
    pickCount: 1,
  };
}

function parseFullRankingSlots(text, nOptions) {
  const m = String(text || "").match(/FULL_RANKING_SLOTS:\s*([\d,\s]+)/i);
  if (!m) return null;
  const parts = m[1]
    .split(/[,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 10));
  if (parts.length !== nOptions) return null;
  const seen = new Set();
  for (const p of parts) {
    if (!Number.isInteger(p) || p < 0 || p >= nOptions) return null;
    if (seen.has(p)) return null;
    seen.add(p);
  }
  return parts;
}

function parseJudgeModelOutput(rawText, nOptions) {
  const text = String(rawText || "").trim();
  const idxMatch = text.match(/RECOMMENDED_PICK_INDEX:\s*(\d+)/i);
  const confMatch = text.match(/CONFIDENCE:\s*(low|medium|high)\b/i);
  const lineMatch = text.match(/ONE_LINE_SUMMARY:\s*([^\n]+)/i);

  let chosenSlotIndex = idxMatch ? parseInt(idxMatch[1], 10) : null;
  if (
    chosenSlotIndex === null ||
    !Number.isInteger(chosenSlotIndex) ||
    chosenSlotIndex < 0 ||
    chosenSlotIndex >= nOptions
  ) {
    chosenSlotIndex = null;
  }

  let rankingSlotOrder = parseFullRankingSlots(text, nOptions);
  if (rankingSlotOrder?.length) {
    if (chosenSlotIndex === null) chosenSlotIndex = rankingSlotOrder[0];
    else if (chosenSlotIndex !== rankingSlotOrder[0]) chosenSlotIndex = rankingSlotOrder[0];
  } else if (chosenSlotIndex !== null) {
    rankingSlotOrder = [
      chosenSlotIndex,
      ...Array.from({ length: nOptions }, (_, i) => i).filter((i) => i !== chosenSlotIndex),
    ];
  }

  const confidence = confMatch ? confMatch[1].toLowerCase() : null;
  const oneLineSummary = lineMatch ? lineMatch[1].trim() : "";

  let reasoning = text;
  for (let k = 0; k < 8; k++) {
    const next = reasoning
      .replace(/^\s*RECOMMENDED_PICK_INDEX:\s*\d+\s*\n?/im, "")
      .replace(/^\s*FULL_RANKING_SLOTS:\s*[\d,\s]+\n?/im, "")
      .replace(/^\s*CONFIDENCE:\s*(low|medium|high)\s*\n?/im, "")
      .replace(/^\s*ONE_LINE_SUMMARY:\s*[^\n]+\n?/im, "")
      .trim();
    if (next === reasoning) break;
    reasoning = next;
  }
  if (!reasoning) reasoning = text;

  return {
    judgeMode: "multi_pick",
    chosenSlotIndex,
    rankingSlotOrder: rankingSlotOrder || null,
    confidence,
    oneLineSummary,
    reasoning,
    rawText: text,
  };
}

/**
 * Claude-only: multi-pick comparison and/or single-ticket pro vs counter when both dossiers exist.
 */
export async function judgeResearchedPicks(picks, options = {}) {
  if (!Array.isArray(picks) || picks.length < 1) throw new Error("Judge needs picks.");
  if (picks.length > 12) throw new Error("Judge supports at most 12 picks per call.");

  const userContextApplied = Boolean(sanitizeUserJudgeContext(options?.userContext));
  const judgeAllowWeb = userContextApplied;

  for (const p of picks) assertPickShape(p);

  const claudeKey = process.env.ANTHROPIC_API_KEY;
  if (!claudeKey) throw new Error("Judge requires ANTHROPIC_API_KEY (Claude).");

  const { anthropicInputUsdPerMTok, anthropicOutputUsdPerMTok, webSearchCostUsd } = anthropicPricingFromEnv();

  const judgeModel = process.env.CLAUDE_JUDGE_MODEL || process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

  if (picks.length === 1) {
    const prompt = judgePromptSingleTicketProCon(picks[0], options?.userContext, judgeAllowWeb);
    const res = await claudeWithRetry(claudeKey, () => {
      const body = {
        model: judgeModel,
        max_tokens: userContextApplied ? 4800 : 3500,
        temperature: 0.14,
        messages: [{ role: "user", content: prompt }],
      };
      if (judgeAllowWeb) {
        body.tools = [{ type: "web_search_20250305", name: "web_search" }];
      }
      return body;
    });
    const data = await res.json();
    const full = claudeTextFromResponse(data);
    const parsed = parseJudgeSingleTicketOutput(full);
    const usage = claudeUsageFromResponse(data);
    const totalTokens = (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0);
    const tokenCostUsd = estimateAnthropicCostUsd(usage, {
      inputUsdPerMTok: anthropicInputUsdPerMTok,
      outputUsdPerMTok: anthropicOutputUsdPerMTok,
    });
    const webSearchCalls = judgeAllowWeb ? 1 : 0;
    const toolCostUsd =
      webSearchCalls > 0 && Number.isFinite(webSearchCostUsd) && webSearchCostUsd > 0 ? webSearchCalls * webSearchCostUsd : null;
    const estimatedCostUsd =
      tokenCostUsd != null || toolCostUsd != null ? (tokenCostUsd || 0) + (toolCostUsd || 0) : null;
    const llmUsage = {
      provider: "claude",
      model: judgeModel,
      usage_total: { ...usage, total_tokens: totalTokens },
      usage_by_step: [{ provider: "anthropic", model: judgeModel, step: "judge_single", usage }],
      estimated_cost_usd: estimatedCostUsd,
      web_search_calls: webSearchCalls,
      tool_cost_usd: toolCostUsd,
      pricing_hint:
        estimatedCostUsd === null
          ? {
              env: [
                "GAMBLYZER_ANTHROPIC_INPUT_USD_PER_MTOK",
                "GAMBLYZER_ANTHROPIC_OUTPUT_USD_PER_MTOK",
                "GAMBLYZER_WEB_SEARCH_COST_USD",
              ],
            }
          : null,
    };
    return { ...parsed, model: judgeModel, pickCount: 1, userContextApplied, judgeWebSearchEnabled: judgeAllowWeb, llmUsage };
  }

  if (picks.length < 2) throw new Error("Judge among tickets needs at least two picks.");

  for (const p of picks) validatePrimaryResearchBlob(p);

  const prompt = judgePromptForBatch(picks, options?.userContext, judgeAllowWeb);
  const res = await claudeWithRetry(claudeKey, () => {
    const body = {
      model: judgeModel,
      max_tokens: userContextApplied ? 5200 : 4000,
      temperature: 0.15,
      messages: [{ role: "user", content: prompt }],
    };
    if (judgeAllowWeb) {
      body.tools = [{ type: "web_search_20250305", name: "web_search" }];
    }
    return body;
  });
  const data = await res.json();
  const full = claudeTextFromResponse(data);
  const parsed = parseJudgeModelOutput(full, picks.length);
  const usage = claudeUsageFromResponse(data);
  const totalTokens = (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0);
  const tokenCostUsd = estimateAnthropicCostUsd(usage, {
    inputUsdPerMTok: anthropicInputUsdPerMTok,
    outputUsdPerMTok: anthropicOutputUsdPerMTok,
  });
  const webSearchCalls = judgeAllowWeb ? 1 : 0;
  const toolCostUsd =
    webSearchCalls > 0 && Number.isFinite(webSearchCostUsd) && webSearchCostUsd > 0 ? webSearchCalls * webSearchCostUsd : null;
  const estimatedCostUsd =
    tokenCostUsd != null || toolCostUsd != null ? (tokenCostUsd || 0) + (toolCostUsd || 0) : null;
  const llmUsage = {
    provider: "claude",
    model: judgeModel,
    usage_total: { ...usage, total_tokens: totalTokens },
    usage_by_step: [{ provider: "anthropic", model: judgeModel, step: "judge_multi", usage }],
    estimated_cost_usd: estimatedCostUsd,
    web_search_calls: webSearchCalls,
    tool_cost_usd: toolCostUsd,
    pricing_hint:
      estimatedCostUsd === null
        ? {
            env: [
              "GAMBLYZER_ANTHROPIC_INPUT_USD_PER_MTOK",
              "GAMBLYZER_ANTHROPIC_OUTPUT_USD_PER_MTOK",
              "GAMBLYZER_WEB_SEARCH_COST_USD",
            ],
          }
        : null,
  };

  return {
    ...parsed,
    model: judgeModel,
    pickCount: picks.length,
    userContextApplied,
    judgeWebSearchEnabled: judgeAllowWeb,
    llmUsage,
  };
}

export async function generatePick({ league, leagues, min, max, pickIndex, restrictPoolIndices, count }) {
  const { picks } = await generatePicks({ league, leagues, min, max, pickIndex, restrictPoolIndices, count });
  if (picks.length !== 1) {
    throw new Error("Pick + narrative in one call supports only one pick (omit count or set count to 1).");
  }
  const pick = picks[0];
  const r = await generateResearchNarrative(pick, {
    includeCounter: process.env.GAMBLYZER_INCLUDE_COUNTER_ON_GENERATE === "1",
  });
  return {
    ...pick,
    ...r,
  };
}

