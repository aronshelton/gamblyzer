import { generatePick } from "../../../lib/gamblyzer5-web";

export const runtime = "nodejs";

export const maxDuration = 300;

const FULL_GENERATE_MS = Number(process.env.GAMBLYZER_FULL_GENERATE_TIMEOUT_MS) ||
  (Number(process.env.GAMBLYZER_RESEARCH_TIMEOUT_MS) || 240_000) + 45_000;

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`Request timed out after ${Math.round(ms / 1000)}s.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

export async function POST(req) {
  const reqId = Math.random().toString(16).slice(2);
  try {
    const body = await req.json().catch(() => ({}));
    const league = body?.league;
    const leagues = body?.leagues;
    const min = body?.min;
    const max = body?.max;

    const leaguesLog = Array.isArray(leagues) && leagues.length ? leagues.join("+") : String(league || "NBA");
    console.log(`[gamblyzer] req=${reqId} start leagues=${leaguesLog} min=${min} max=${max}`);
    const result = await withTimeout(generatePick({ league, leagues, min, max }), FULL_GENERATE_MS);
    console.log(`[gamblyzer] req=${reqId} ok pool=${result?.poolSize ?? "?"}`);
    return Response.json(result, { status: 200 });
  } catch (e) {
    console.error(`[gamblyzer] req=${reqId} error`, e);
    return Response.json(
      { error: e?.message || String(e) },
      { status: 400 }
    );
  }
}

