"use client";

import { useEffect, useMemo, useRef, useState } from "react";

function fmtOdds(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (v > 0) return `+${Math.round(v)}`;
  return `${Math.round(v)}`;
}

function splitNarrativeAndSources(combined) {
  const s = String(combined || "");
  const parts = s.split(/\n<<<GAMBLYZER_SOURCES>>>\n/);
  if (parts.length < 2) return { narrative: s.trim(), sources: "" };
  return { narrative: parts[0].trim(), sources: parts.slice(1).join("\n<<<GAMBLYZER_SOURCES>>>\n").trim() };
}

function pickHasResearchForJudge(p) {
  const nc = String(p?.narrativeCombined || "").trim();
  return nc.length >= 80 && nc.includes("<<<GAMBLYZER_SOURCES>>>");
}

function pickHasCounterForJudge(p) {
  const cc = String(p?.counterNarrativeCombined || "").trim();
  return cc.length >= 80 && cc.includes("<<<GAMBLYZER_SOURCES>>>");
}

function primaryPickButtonLabel({ picking, pickCount, myPoolSize }) {
  if (picking) return "Picking…";
  if (pickCount > 1 && myPoolSize > 0) return `Generate ${pickCount} picks from my pool (${myPoolSize})`;
  if (pickCount > 1) return `Generate ${pickCount} random picks`;
  if (myPoolSize > 0) return `Random from my pool (${myPoolSize})`;
  return "Generate Mahowny’s Pick";
}

const ALL_LEAGUES = ["NBA", "MLB", "NHL"];
const ODDS_CAP_MIN = -200;
const ODDS_CAP_MAX = 300;

/**
 * Must stay slightly above `/api/research` server timeout (`GAMBLYZER_RESEARCH_TIMEOUT_MS`,
 * default 240s); raise both if slow models keep timing out.
 */
const RESEARCH_FETCH_TIMEOUT_MS = 240_000 + 65_000;

/** Slightly above `GAMBLYZER_JUDGE_TIMEOUT_MS` (default 180s on `/api/judge`). */
const JUDGE_FETCH_TIMEOUT_MS = 180_000 + 8000;

/** Pick quantities for one Odds fetch (distinct lines; capped server-side). */
const PICK_COUNT_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10, 12];

export default function Page() {
  const generationRef = useRef(0);
  const pickBundleRef = useRef(null);
  const [leagues, setLeagues] = useState(["NBA"]);
  const [minOdds, setMinOdds] = useState(-110);
  const [maxOdds, setMaxOdds] = useState(110);
  const [pickCount, setPickCount] = useState(1);
  const [picking, setPicking] = useState(false);
  /** Busy slot — primary vs counter dossier builds share the same Odds/league UX lock. */
  const [researchBusy, setResearchBusy] = useState(null);
  const [judging, setJudging] = useState(false);
  const [judgeVerdict, setJudgeVerdict] = useState(null);
  const [judgeUserContextDraft, setJudgeUserContextDraft] = useState("");
  const [err, setErr] = useState("");
  const [pickBundle, setPickBundle] = useState(null);
  const [poolPreview, setPoolPreview] = useState(null);
  const [poolLoading, setPoolLoading] = useState(false);
  const [myPool, setMyPool] = useState(() => new Set());

  const rangesOk = useMemo(() => {
    const a = Number(minOdds);
    const b = Number(maxOdds);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (a >= b) return false;
    if (a < ODDS_CAP_MIN || a > ODDS_CAP_MAX || b < ODDS_CAP_MIN || b > ODDS_CAP_MAX) return false;
    return true;
  }, [minOdds, maxOdds]);

  const leaguesOk = Array.isArray(leagues) && leagues.length > 0;

  const judgeEligibleMulti = useMemo(() => {
    if (!pickBundle?.picks || pickBundle.picks.length < 2) return false;
    return pickBundle.picks.every(pickHasResearchForJudge);
  }, [pickBundle]);

  const judgeEligibleSingle = useMemo(() => {
    if (!pickBundle?.picks || pickBundle.picks.length !== 1) return false;
    const p = pickBundle.picks[0];
    return pickHasResearchForJudge(p) && pickHasCounterForJudge(p);
  }, [pickBundle]);

  const judgeGate = judgeEligibleMulti || judgeEligibleSingle;

  useEffect(() => {
    setJudgeVerdict(null);
    setJudgeUserContextDraft("");
  }, [pickBundle?.batchId]);

  pickBundleRef.current = pickBundle;

  const allLeaguesSelected = useMemo(() => {
    const set = new Set(Array.isArray(leagues) ? leagues : []);
    return ALL_LEAGUES.every((c) => set.has(c));
  }, [leagues]);

  function selectAllLeagues() {
    setLeagues([...ALL_LEAGUES]);
  }

  function toggleLeague(code) {
    const c = String(code || "").toUpperCase();
    if (!c) return;
    setLeagues((prev) => {
      const cur = Array.isArray(prev) ? prev : [];
      const has = cur.includes(c);
      const next = has ? cur.filter((x) => x !== c) : [...cur, c];
      return next;
    });
  }

  useEffect(() => {
    setPoolPreview(null);
    setMyPool(new Set());
  }, [leagues, minOdds, maxOdds]);

  function toggleMyPool(index) {
    const n = Number(index);
    if (!Number.isInteger(n) || n < 0) return;
    setMyPool((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  }

  function clearMyPool() {
    setMyPool(new Set());
  }

  async function fetchPoolPreviews() {
    setErr("");
    if (!rangesOk) {
      setErr(
        `Odds must be American numbers from ${ODDS_CAP_MIN} to +${ODDS_CAP_MAX}, with min strictly less than max.`
      );
      return;
    }
    if (!leaguesOk) {
      setErr("Select at least one league.");
      return;
    }
    setPoolLoading(true);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      const res = await fetch("/api/pool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leagues, min: Number(minOdds), max: Number(maxOdds) }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || res.statusText);
      setPoolPreview(data);
      const cap = typeof data.poolSize === "number" ? data.poolSize : 0;
      setMyPool((prev) => {
        const next = new Set();
        prev.forEach((i) => {
          if (Number.isInteger(i) && i >= 0 && i < cap) next.add(i);
        });
        return next;
      });
    } catch (e) {
      const msg =
        e?.name === "AbortError"
          ? "Timed out waiting for /api/pool (30s). Odds API may be slow/unreachable, or ODDS_API_KEY may be missing."
          : (e?.message || String(e));
      setErr(msg);
    } finally {
      setPoolLoading(false);
    }
  }

  async function runPick(opts = {}) {
    const { pickIndex, useFullPool } = opts;
    setErr("");
    setPickBundle(null);
    if (!rangesOk) {
      setErr(
        `Odds must be American numbers from ${ODDS_CAP_MIN} to +${ODDS_CAP_MAX}, with min strictly less than max.`
      );
      return;
    }
    if (!leaguesOk) {
      setErr("Select at least one league.");
      return;
    }
    generationRef.current += 1;
    const batchId = generationRef.current;
    const body = { leagues, min: Number(minOdds), max: Number(maxOdds) };
    if (pickIndex !== undefined && pickIndex !== null) {
      body.pickIndex = pickIndex;
    } else {
      body.count = Math.min(Math.max(1, pickCount), PICK_COUNT_OPTIONS[PICK_COUNT_OPTIONS.length - 1]);
      if (!useFullPool && myPool.size > 0) {
        body.restrictPoolIndices = [...myPool].sort((a, b) => a - b);
      }
    }
    setPicking(true);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      const res = await fetch("/api/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || res.statusText);
      if (batchId !== generationRef.current) return;
      const picks = Array.isArray(data.picks)
        ? data.picks
        : data?.fixture || data?.dkRow
          ? [data]
          : [];
      if (!picks.length) throw new Error("Pick response missing picks.");
      setPickBundle({
        batchId,
        picks,
        pickBatchReturned: data.pickBatchReturned ?? picks.length,
        pickBatchRequested: data.pickBatchRequested ?? picks.length,
        poolSize: data.poolSize ?? picks[0]?.poolSize ?? 0,
        batchTruncated: Boolean(data.batchTruncated),
      });
    } catch (e) {
      const msg =
        e?.name === "AbortError"
          ? "Timed out waiting for /api/pick (30s). Odds API may be slow/unreachable, or ODDS_API_KEY may be missing."
          : (e?.message || String(e));
      setErr(msg);
    } finally {
      setPicking(false);
    }
  }

  async function runResearch(slotIdx, opts = {}) {
    const { counter = false } = opts;
    if (!pickBundle?.picks?.[slotIdx]) return;
    const batchSnapshot = pickBundle.batchId;
    const pickPayload = pickBundle.picks[slotIdx];
    setErr("");
    setResearchBusy({ slotIdx, counter: Boolean(counter) });
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), RESEARCH_FETCH_TIMEOUT_MS);
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pick: pickPayload, counter: Boolean(counter) }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || res.statusText);
      if (pickBundleRef.current?.batchId === batchSnapshot) setJudgeVerdict(null);
      setPickBundle((prev) => {
        if (!prev || prev.batchId !== batchSnapshot) return prev;
        const row = prev.picks[slotIdx];
        if (!row) return prev;
        const merged = [...prev.picks];
        const nextRow = { ...(merged[slotIdx] || {}), ...data };
        if (!counter && data?.narrativeCombined) {
          delete nextRow.counterNarrativeCombined;
        }
        merged[slotIdx] = nextRow;
        return { ...prev, picks: merged };
      });
    } catch (e) {
      const msg =
        e?.name === "AbortError"
          ? `Timed out waiting for /api/research (${Math.round(RESEARCH_FETCH_TIMEOUT_MS / 1000)}s). The AI step may need a higher GAMBLYZER_RESEARCH_TIMEOUT_MS on the server.`
          : (e?.message || String(e));
      setErr(msg);
    } finally {
      setResearchBusy(null);
    }
  }

  async function runJudge(includeUserContext) {
    if (!pickBundle?.picks?.length || !judgeGate) return;
    const notes = judgeUserContextDraft.trim();
    if (includeUserContext && !notes) {
      setErr("Add notes for the judge in the box below before re-running with context.");
      return;
    }
    setJudgeVerdict(null);
    setErr("");
    setJudging(true);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), JUDGE_FETCH_TIMEOUT_MS);
      const res = await fetch("/api/judge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          picks: pickBundle.picks,
          ...(includeUserContext ? { userContext: notes } : {}),
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || res.statusText);
      setJudgeVerdict(data);
    } catch (e) {
      const msg =
        e?.name === "AbortError"
          ? `Timed out waiting for /api/judge (${Math.round(JUDGE_FETCH_TIMEOUT_MS / 1000)}s). Raise GAMBLYZER_JUDGE_TIMEOUT_MS if needed.`
          : e?.message || String(e);
      setErr(msg);
    } finally {
      setJudging(false);
    }
  }

  const mahownyPickLabel = primaryPickButtonLabel({ picking, pickCount, myPoolSize: myPool.size });

  return (
    <div className="grid">
      <section className="card">
        <h2>Mahowny 1.0</h2>
        <div className="row1">
          <div>
            <div className="leaguesLabelRow">
              <label>Leagues</label>
              <button
                type="button"
                className="btnSelectAll"
                onClick={selectAllLeagues}
                disabled={picking || researchBusy !== null || judging || poolLoading || allLeaguesSelected}
              >
                Select all
              </button>
            </div>
            <div className="toggleRow">
              {ALL_LEAGUES.map((c) => {
                const on = leagues.includes(c);
                return (
                  <button
                    key={c}
                    type="button"
                    className={`toggleBtn ${on ? "toggleBtnOn" : ""}`}
                    onClick={() => toggleLeague(c)}
                    disabled={picking || researchBusy !== null || judging || poolLoading}
                    aria-pressed={on}
                  >
                    {c}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="row">
            <div>
              <label>Min American odds</label>
              <input
                value={minOdds}
                onChange={(e) => setMinOdds(e.target.value)}
                inputMode="numeric"
                disabled={picking || researchBusy !== null || judging || poolLoading}
              />
            </div>
            <div>
              <label>Max American odds</label>
              <input
                value={maxOdds}
                onChange={(e) => setMaxOdds(e.target.value)}
                inputMode="numeric"
                disabled={picking || researchBusy !== null || judging || poolLoading}
              />
            </div>
          </div>

          <div className="row">
            <div className="pickCountField">
              <label htmlFor="pickCountSel">Random picks per run</label>
              <select
                id="pickCountSel"
                className="selectInput"
                value={pickCount}
                onChange={(e) => setPickCount(Number(e.target.value))}
                disabled={picking || researchBusy !== null || judging || poolLoading}
              >
                {PICK_COUNT_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="btnRow">
            <button
              type="button"
              className="btnSecondary"
              disabled={picking || researchBusy !== null || judging || poolLoading || !rangesOk || !leaguesOk}
              onClick={fetchPoolPreviews}
            >
              {poolLoading ? "Loading eligible lines…" : "Preview eligible lines"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={picking || researchBusy !== null || judging || poolLoading || !rangesOk || !leaguesOk}
              onClick={() => runPick()}
            >
              {mahownyPickLabel}
            </button>
          </div>

          {poolPreview?.poolSize != null && myPool.size > 0 ? (
            <button
              type="button"
              className="linkLikeBtn"
              disabled={picking || researchBusy !== null || judging || poolLoading}
              onClick={() => runPick({ useFullPool: true })}
            >
              Random pick{pickCount > 1 ? "s" : ""} from full eligible pool ({poolPreview.poolSize} lines), ignoring my pool
            </button>
          ) : null}

          {poolPreview && Array.isArray(poolPreview.previews) && poolPreview.previews.length ? (
            <div className="poolPanel">
              <div className="pill pillBlock" style={{ borderRadius: 0, border: "none", borderBottom: "1px solid rgba(255,255,255,0.10)" }}>
                <span className="muted" style={{ fontSize: 12, lineHeight: 1.4 }}>
                  Eligible DraftKings lines (same sort as the random pick).{" "}
                  {poolPreview.previewsTruncated
                    ? `Showing first ${poolPreview.previews.length} of ${poolPreview.poolSize}.`
                    : `All ${poolPreview.poolSize} listed.`}{" "}
                  Choose how many picks to draw above. Tap &quot;+ Pool&quot; to limit random draws — &quot;Use&quot; still pins one line (&quot;Use&quot; always requests a single lineup).
                </span>
              </div>
              {myPool.size > 0 ? (
                <div className="pill pillBlock poolBar" style={{ margin: 0, borderRadius: 0 }}>
                  <span>
                    <strong>My pool:</strong> {myPool.size} line{myPool.size === 1 ? "" : "s"} selected
                  </span>
                  <button type="button" className="btnClearPool" disabled={picking || researchBusy !== null || judging || poolLoading} onClick={clearMyPool}>
                    Clear my pool
                  </button>
                </div>
              ) : null}
              <div className="poolScroll">
                {poolPreview.previews.map((p) => {
                  const away = p?.fixture?.participant2Name || "Away";
                  const home = p?.fixture?.participant1Name || "Home";
                  const dec = Number(p?.dkRow?.decimalOdds);
                  const inPool = myPool.has(p.index);
                  return (
                    <div
                      className={`poolRow ${inPool ? "poolRowMyPool" : ""}`}
                      key={`${p.index}-${p?.fixture?.fixtureId || ""}-${p?.comparisonKey || ""}`}
                    >
                      <div className="mono poolIdx">#{p.index}</div>
                      <div className="poolRowMain">
                        <div className="poolRowTitle">
                          {away} @ {home}
                        </div>
                        <div className="poolRowLine">
                          {p?.dkRow?.marketName || "—"} · {p?.dkRow?.outcome || "—"}
                        </div>
                        <div className="poolRowMeta mono">
                          {p?.sportLabel || "—"} · {p?.dkRow?.american || "—"}
                          {Number.isFinite(dec) ? ` (${dec.toFixed(3)} dec)` : ""}
                        </div>
                      </div>
                      <div className="poolRowActions">
                        <button
                          type="button"
                          className={`btnPoolToggle ${inPool ? "btnPoolToggleOn" : ""}`}
                          aria-pressed={inPool}
                          disabled={picking || researchBusy !== null || judging || poolLoading}
                          onClick={() => toggleMyPool(p.index)}
                        >
                          {inPool ? "In pool" : "+ Pool"}
                        </button>
                        <button
                          type="button"
                          className="btnUseLine"
                          disabled={picking || researchBusy !== null || judging}
                          onClick={() => runPick({ pickIndex: p.index })}
                        >
                          Use
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="pill pillBlock">
            <span className="muted" style={{ fontSize: 11, lineHeight: 1.35 }}>
              Allowed envelope: {fmtOdds(ODDS_CAP_MIN)} to {fmtOdds(ODDS_CAP_MAX)} (defaults -110 / +110).
            </span>
          </div>

          <div className="pill">
            <span>Leagues:</span>
            <span className="mono">{leaguesOk ? leagues.join(", ") : "—"}</span>
          </div>

          {err ? <div className="err">{err}</div> : null}
        </div>
      </section>

      <section className="card">
        <h2>Mahowny’s pick{pickBundle?.picks?.length > 1 ? "s" : ""}</h2>
        {!pickBundle?.picks?.length ? (
          <div className="muted">
            Generate one or more picks first (fast, one Odds fetch). Then use <strong>Generate research</strong> on each line when you want the slow AI pass (web search + narrative).
          </div>
        ) : (
          <>
            {pickBundle.pickBatchRequested > 1 ? (
              <div className="pill pillBlock">
                <span className="muted" style={{ fontSize: 12, lineHeight: 1.45 }}>
                  {pickBundle.pickBatchReturned < pickBundle.pickBatchRequested ? (
                    <>
                      Returning <strong>{pickBundle.pickBatchReturned}</strong> of {pickBundle.pickBatchRequested} requested — not enough unique eligible lines left in this draw pool.
                    </>
                  ) : (
                    <>
                      <strong>{pickBundle.pickBatchReturned}</strong> distinct lines (eligible pool{" "}
                      <span className="mono">{pickBundle.poolSize}</span>).
                    </>
                  )}{" "}
                  Use <strong>Generate research</strong> on each pick below when you want the slow AI pass (typically one to a few minutes each).
                </span>
              </div>
            ) : null}
            {!judgeGate && pickBundle?.picks?.length ? (
              <div className="pill pillBlock">
                <span className="muted" style={{ fontSize: 12, lineHeight: 1.45 }}>
                  <strong>Claude judge</strong>:{" "}
                  {pickBundle.picks.length >= 2 ? (
                    <>
                      run primary <strong>Generate research</strong> on each pick below. Optionally add{" "}
                      <strong>Generate counter dossier</strong> per pick so Claude can weigh pro vs con inside each ticket and across picks.
                    </>
                  ) : (
                    <>
                      after primary research completes, generate a <strong>counter dossier</strong> — both must exist before the judge can weigh this single ticket pro vs contra.
                    </>
                  )}
                </span>
              </div>
            ) : null}
            {judgeGate ? (
              <div className="judgeActionRow">
                <button
                  type="button"
                  className="btnSecondary"
                  disabled={picking || researchBusy !== null || judging}
                  onClick={() => runJudge(false)}
                >
                  {judging ? "Judging with Claude…" : judgeEligibleMulti ? "Judge picks (Claude)" : "Judge ticket vs counter (Claude)"}
                </button>
                <span className="muted judgeActionHint">
                  Claude reads only dossiers already on this screen (optional counter dossiers weigh against each ticket too). Comparative epistemics —
                  not a lock or game prediction.
                </span>
              </div>
            ) : null}
            <div className="pickPackStack">
              {pickBundle.picks.map((row, slotIdx) => {
                const { narrative: narrBody, sources: narrSources } = splitNarrativeAndSources(row.narrativeCombined || "");
                const {
                  narrative: counterNarrBody,
                  sources: counterSources,
                } = splitNarrativeAndSources(row.counterNarrativeCombined || "");
                const gameLabel = `${row?.fixture?.participant2Name ?? "Away"} @ ${row?.fixture?.participant1Name ?? "Home"}`;
                const busyPrimary = researchBusy?.slotIdx === slotIdx && !researchBusy.counter;
                const busyCounter = researchBusy?.slotIdx === slotIdx && researchBusy.counter;
                const multiChosen =
                  judgeVerdict?.judgeMode === "multi_pick" &&
                  typeof judgeVerdict?.chosenSlotIndex === "number" &&
                  judgeVerdict.chosenSlotIndex === slotIdx;
                const singleStance = judgeVerdict?.judgeMode === "single_pro_contra" && pickBundle.picks.length === 1 && slotIdx === 0 ? judgeVerdict.ticketStance : null;
                const articleClass =
                  multiChosen || singleStance === "take"
                    ? "pickBlock pickBlockChosen"
                    : singleStance === "pass"
                      ? "pickBlock pickBlockPassLean"
                      : singleStance === "split"
                        ? "pickBlock pickBlockSplitLean"
                        : "pickBlock";
                return (
                  <article
                    className={articleClass}
                    key={`${pickBundle.batchId}-${slotIdx}-${row?.pickIndex ?? slotIdx}-${row?.fixture?.fixtureId ?? ""}`}
                  >
                    <h3 className="pickBlockTitle">
                      Pick #{slotIdx + 1}
                      <span className="pickBlockTitleMuted mono"> · line #{typeof row.pickIndex === "number" ? row.pickIndex : "—"} · {gameLabel}</span>
                    </h3>
                    <div className="kvs pickBlockKvs">
                      <div className="k">League</div>
                      <div className="v mono">{row?.sportLabel || "—"}</div>
                      <div className="k">Start</div>
                      <div className="v mono">{row?.fixture?.startTime ? new Date(row.fixture.startTime).toLocaleString() : "—"}</div>
                      <div className="k">DraftKings</div>
                      <div className="v mono">{row?.dkRow?.outcome} · {row?.dkRow?.american || "—"} (dec {Number(row?.dkRow?.decimalOdds || 0).toFixed(3)})</div>
                      <div className="k">Polymarket</div>
                      <div className="v mono">{row?.polyRow ? `${row.polyRow.outcome} · ${row.polyRow.american || "—"} (dec ${Number(row.polyRow.decimalOdds).toFixed(3)})` : "—"}</div>
                      <div className="k">Full pool size</div>
                      <div className="v mono">{row?.poolSize ?? pickBundle.poolSize ?? "—"}</div>
                      <div className="k">Draw scope</div>
                      <div className="v mono">
                        {row?.userPoolRestricted ? `Your pool (${row?.userPoolSize ?? "—"} lines)` : "Full eligible pool"}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn"
                      disabled={picking || researchBusy !== null || judging}
                      onClick={() => runResearch(slotIdx)}
                      style={{ marginTop: 10 }}
                    >
                      {busyPrimary ? "Researching…" : row?.narrativeCombined ? "Regenerate research" : "Generate research"}
                    </button>
                    {busyPrimary ? (
                      <div className="researchProgressWrap" style={{ marginTop: 10 }}>
                        <div
                          className="researchProgress"
                          role="progressbar"
                          aria-busy="true"
                          aria-valuetext="Mahowny research in progress"
                        >
                          <div className="researchProgressIndeterminate" aria-hidden />
                        </div>
                        <p className="muted researchProgressHint">
                          Indeterminate progress — AI search plus narrative usually takes about one to a few minutes.
                        </p>
                      </div>
                    ) : null}
                    <div className="hr" />
                    <div className="pre">{row?.narrativeCombined ? (narrBody || "(No narrative returned.)") : "Run research above for this pick when you’re ready."}</div>
                    {narrSources ? (
                      <>
                        <div className="hr" />
                        <div className="muted" style={{ marginBottom: 6 }}>
                          Research sources (verify before relying on)
                        </div>
                        <div className="pre">{narrSources}</div>
                      </>
                    ) : null}
                    <div className="hr" />
                    <div className="muted" style={{ marginBottom: 8, fontWeight: 650, fontSize: 13 }}>
                      Counter dossier (vs this ticket)
                    </div>
                    <button
                      type="button"
                      className="btnSecondary"
                      disabled={
                        picking || researchBusy !== null || judging || !pickHasResearchForJudge(row)
                      }
                      onClick={() => runResearch(slotIdx, { counter: true })}
                      style={{ marginBottom: busyCounter ? 8 : 10 }}
                    >
                      {busyCounter
                        ? "Counter research…"
                        : row?.counterNarrativeCombined
                          ? "Regenerate counter dossier"
                          : "Generate counter dossier"}
                    </button>
                    {!pickHasResearchForJudge(row) ? (
                      <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                        Run Mahowny’s research first — the counter pass targets this same DK line skeptically.
                      </p>
                    ) : null}
                    {busyCounter ? (
                      <div className="researchProgressWrap" style={{ marginTop: 0 }}>
                        <div
                          className="researchProgress"
                          role="progressbar"
                          aria-busy="true"
                          aria-valuetext="Counter dossier research in progress"
                        >
                          <div className="researchProgressIndeterminate" aria-hidden />
                        </div>
                        <p className="muted researchProgressHint">Searching for contrarian / fade angles on the same matchup.</p>
                      </div>
                    ) : null}
                    <div className="pre">
                      {row?.counterNarrativeCombined ? (counterNarrBody || "(No counter prose returned.)") : "Generate a counter dossier to capture evidence against taking this priced side."}
                    </div>
                    {counterSources ? (
                      <>
                        <div className="hr" />
                        <div className="muted" style={{ marginBottom: 6 }}>
                          Counter sources (verify before relying on)
                        </div>
                        <div className="pre">{counterSources}</div>
                      </>
                    ) : null}
                  </article>
                );
              })}
            </div>
            {judging ? (
              <div className="researchProgressWrap" style={{ marginTop: 14 }}>
                <div
                  className="researchProgress"
                  role="progressbar"
                  aria-busy="true"
                  aria-valuetext="Judge comparing dossiers"
                >
                  <div className="researchProgressIndeterminate" aria-hidden />
                </div>
                <p className="muted researchProgressHint">Claude is comparing research dossiers — often well under two minutes.</p>
              </div>
            ) : null}
            {judgeVerdict ? (
              <div className="pickBlock judgeVerdictPanel">
                <h3 className="pickBlockTitle">
                  Claude judge · verdict
                  {judgeVerdict.userContextApplied ? (
                    <span className="judgeVerdictBadge" title="This pass included your notes below">
                      With your notes
                    </span>
                  ) : null}
                </h3>
                {judgeVerdict.judgeMode === "single_pro_contra" ? (
                  judgeVerdict.ticketStance ? (
                    <div className="pill pillBlock" style={{ marginBottom: 8 }}>
                      <span>Ticket stance (from dossiers)</span>
                      <span className="mono">
                        {judgeVerdict.ticketStance === "take"
                          ? "Lean toward playing this DK line"
                          : judgeVerdict.ticketStance === "pass"
                            ? "Lean toward passing / fading this DK line"
                            : "Evidence too balanced to tilt either way"}
                      </span>
                    </div>
                  ) : (
                    <div className="err" style={{ marginBottom: 10 }}>
                      Could not read RECOMMENDED_STANCE — review the prose below manually.
                    </div>
                  )
                ) : typeof judgeVerdict.chosenSlotIndex === "number" ? (
                  <div className="pill pillBlock" style={{ marginBottom: 8 }}>
                    <span>Recommended ticket</span>
                    <span className="mono">Pick #{judgeVerdict.chosenSlotIndex + 1}</span>
                  </div>
                ) : (
                  <div className="err" style={{ marginBottom: 10 }}>
                    The model reply did not include a valid RECOMMENDED_PICK_INDEX — read the prose below manually.
                  </div>
                )}
                {(judgeVerdict.confidence || judgeVerdict.model) ? (
                  <div className="kvs pickBlockKvs" style={{ marginTop: 4 }}>
                    {judgeVerdict.confidence ? (
                      <>
                        <div className="k">Judgment calibration</div>
                        <div className="v mono">{judgeVerdict.confidence} (quality of comparative review)</div>
                      </>
                    ) : null}
                    {judgeVerdict.model ? (
                      <>
                        <div className="k">Model</div>
                        <div className="v mono">{judgeVerdict.model}</div>
                      </>
                    ) : null}
                  </div>
                ) : null}
                {judgeVerdict.oneLineSummary ? <div className="pre judgeOneLine">{judgeVerdict.oneLineSummary}</div> : null}
                <div className="hr" />
                <div className="pre">{judgeVerdict.reasoning || judgeVerdict.rawText || "—"}</div>
                <p className="muted" style={{ marginTop: 12, fontSize: 11, lineHeight: 1.4 }}>
                  The judge weighs arguments already in Mahowny’s dossiers (and counter dossiers where present); it does not re-fetch the web or guarantee any wager wins or loses.
                </p>
                <div className="hr" />
                <label className="judgeContextLabel" htmlFor="judgeUserContextDraft">
                  More context for the judge
                </label>
                <p className="muted" style={{ marginTop: 4, marginBottom: 8, fontSize: 11, lineHeight: 1.45 }}>
                  Add preferences, stakes, corrections, lineup notes you trust, or facts not in the dossiers. Claude treats this as{" "}
                  <strong>bettor-supplied text</strong> — it may shift the verdict versus dossiers alone when you re-run below.
                </p>
                <textarea
                  id="judgeUserContextDraft"
                  className="judgeContextTextarea"
                  rows={5}
                  value={judgeUserContextDraft}
                  onChange={(e) => setJudgeUserContextDraft(e.target.value)}
                  disabled={picking || researchBusy !== null || judging}
                  placeholder="Example: Prefer lower juice; skeptical of injury chatter unless confirmed; leaning dog on this matchup for bankroll sizing…"
                  spellCheck
                />
                <div className="judgeContextActions">
                  <button
                    type="button"
                    className="btnSecondary"
                    disabled={
                      picking || researchBusy !== null || judging || !judgeUserContextDraft.trim()
                    }
                    onClick={() => runJudge(true)}
                  >
                    {judging ? "Judging…" : "Re-run judge with this context"}
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

