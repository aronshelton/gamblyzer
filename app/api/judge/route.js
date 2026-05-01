import { judgeResearchedPicks } from "../../../lib/gamblyzer5-web";

export const runtime = "nodejs";

export const maxDuration = 300;

const JUDGE_MS = Number(process.env.GAMBLYZER_JUDGE_TIMEOUT_MS) || 180_000;

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`Judge timed out after ${Math.round(ms / 1000)}s.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

export async function POST(req) {
  const reqId = Math.random().toString(16).slice(2);
  try {
    const body = await req.json().catch(() => ({}));
    const picks = body?.picks;
    if (!Array.isArray(picks) || picks.length < 1) {
      return Response.json({ error: "Send picks: a non-empty array of pick payloads." }, { status: 400 });
    }

    const userContextRaw = body?.userContext;
    const userContext = typeof userContextRaw === "string" ? userContextRaw : "";
    const ucLen = userContext.trim().length;
    console.log(`[gamblyzer] req=${reqId} judge start n=${picks.length} user_context_chars=${ucLen}`);
    const result = await withTimeout(judgeResearchedPicks(picks, { userContext }), JUDGE_MS);
    console.log(`[gamblyzer] req=${reqId} judge ok slot=${result?.chosenSlotIndex ?? "?"}`);
    return Response.json(result, { status: 200 });
  } catch (e) {
    console.error(`[gamblyzer] req=${reqId} judge error`, e);
    return Response.json({ error: e?.message || String(e) }, { status: 400 });
  }
}
