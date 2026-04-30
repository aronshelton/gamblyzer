"use client";

import { useMemo, useState } from "react";

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

const ALL_LEAGUES = ["NBA", "MLB", "NHL"];
const ODDS_CAP_MIN = -200;
const ODDS_CAP_MAX = 300;

/**
 * Must stay slightly above `/api/research` server timeout (`GAMBLYZER_RESEARCH_TIMEOUT_MS`,
 * default 240s); raise both if slow models keep timing out.
 */
const RESEARCH_FETCH_TIMEOUT_MS = 240_000 + 65_000;

export default function Page() {
  const [leagues, setLeagues] = useState(["NBA"]);
  const [minOdds, setMinOdds] = useState(-110);
  const [maxOdds, setMaxOdds] = useState(110);
  const [picking, setPicking] = useState(false);
  const [researching, setResearching] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState(null);

  const rangesOk = useMemo(() => {
    const a = Number(minOdds);
    const b = Number(maxOdds);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (a >= b) return false;
    if (a < ODDS_CAP_MIN || a > ODDS_CAP_MAX || b < ODDS_CAP_MIN || b > ODDS_CAP_MAX) return false;
    return true;
  }, [minOdds, maxOdds]);

  const leaguesOk = Array.isArray(leagues) && leagues.length > 0;

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

  async function onGeneratePick() {
    setErr("");
    setResult(null);
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
    setPicking(true);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      const res = await fetch("/api/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leagues, min: Number(minOdds), max: Number(maxOdds) }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || res.statusText);
      setResult(data);
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

  async function onGenerateResearch() {
    if (!result) return;
    setErr("");
    setResearching(true);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), RESEARCH_FETCH_TIMEOUT_MS);
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pick: result }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || res.statusText);
      setResult((prev) => ({ ...(prev || {}), ...data }));
    } catch (e) {
      const msg =
        e?.name === "AbortError"
          ? `Timed out waiting for /api/research (${Math.round(RESEARCH_FETCH_TIMEOUT_MS / 1000)}s). The AI step may need a higher GAMBLYZER_RESEARCH_TIMEOUT_MS on the server.`
          : (e?.message || String(e));
      setErr(msg);
    } finally {
      setResearching(false);
    }
  }

  const narrative = useMemo(() => {
    if (!result?.narrativeCombined) return { narrative: "", sources: "" };
    return splitNarrativeAndSources(result.narrativeCombined);
  }, [result]);

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
                disabled={picking || researching || allLeaguesSelected}
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
                    disabled={picking || researching}
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
              <input value={minOdds} onChange={(e) => setMinOdds(e.target.value)} inputMode="numeric" />
            </div>
            <div>
              <label>Max American odds</label>
              <input value={maxOdds} onChange={(e) => setMaxOdds(e.target.value)} inputMode="numeric" />
            </div>
          </div>

          <button className="btn" disabled={picking || researching || !rangesOk || !leaguesOk} onClick={onGeneratePick}>
            {picking ? "Picking…" : "Generate Mahowny’s Pick"}
          </button>

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
        <h2>Mahowny’s Pick</h2>
        {!result ? (
          <div className="muted">
            Generate a pick first (fast). Then optionally run research + narrative (slow; uses AI web search).
          </div>
        ) : (
          <>
            <div className="pill">
              <span>Game:</span>
              <span className="mono">{result?.fixture?.participant2Name} @ {result?.fixture?.participant1Name}</span>
            </div>
            <div className="kvs">
              <div className="k">League</div>
              <div className="v mono">{result?.sportLabel || "—"}</div>
              <div className="k">Start</div>
              <div className="v mono">{result?.fixture?.startTime ? new Date(result.fixture.startTime).toLocaleString() : "—"}</div>
              <div className="k">DraftKings</div>
              <div className="v mono">{result?.dkRow?.outcome} · {result?.dkRow?.american || "—"} (dec {Number(result?.dkRow?.decimalOdds || 0).toFixed(3)})</div>
              <div className="k">Polymarket</div>
              <div className="v mono">{result?.polyRow ? `${result.polyRow.outcome} · ${result.polyRow.american || "—"} (dec ${Number(result.polyRow.decimalOdds).toFixed(3)})` : "—"}</div>
              <div className="k">Pool size</div>
              <div className="v mono">{result?.poolSize ?? "—"}</div>
            </div>

            <button className="btn" disabled={picking || researching} onClick={onGenerateResearch} style={{ marginTop: 12 }}>
              {researching ? "Researching…" : "Generate Research"}
            </button>

            {researching ? (
              <div className="researchProgressWrap">
                <div
                  className="researchProgress"
                  role="progressbar"
                  aria-busy="true"
                  aria-valuetext="Research in progress; time varies"
                >
                  <div className="researchProgressIndeterminate" aria-hidden />
                </div>
                <p className="muted researchProgressHint">
                  Indeterminate progress — AI search plus narrative usually takes about one to a few minutes.
                </p>
              </div>
            ) : null}

            <div className="hr" />

            <div className="pre">
              {result?.narrativeCombined ? (narrative.narrative || "(No narrative returned.)") : "Research may take a few minutes to generate."}
            </div>

            {narrative.sources ? (
              <>
                <div className="hr" />
                <div className="muted" style={{ marginBottom: 6 }}>
                  Research sources (verify before relying on)
                </div>
                <div className="pre">{narrative.sources}</div>
              </>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

