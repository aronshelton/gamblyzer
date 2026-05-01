import { listEligibleLines } from "../../../lib/gamblyzer5-web";

export const runtime = "nodejs";

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
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
    const limit = body?.limit;

    const leaguesLog = Array.isArray(leagues) && leagues.length ? leagues.join("+") : String(league || "NBA");
    console.log(`[gamblyzer] req=${reqId} pool start leagues=${leaguesLog} min=${min} max=${max}`);
    const result = await withTimeout(listEligibleLines({ league, leagues, min, max, limit }), 30000);
    console.log(`[gamblyzer] req=${reqId} pool ok size=${result?.poolSize ?? "?"} truncated=${result?.previewsTruncated ?? "?"}`);
    return Response.json(result, { status: 200 });
  } catch (e) {
    console.error(`[gamblyzer] req=${reqId} pool error`, e);
    return Response.json({ error: e?.message || String(e) }, { status: 400 });
  }
}
