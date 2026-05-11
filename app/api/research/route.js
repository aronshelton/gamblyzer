import { generateCounterResearchNarrative, generateResearchNarrative } from "../../../lib/gamblyzer5-web";

export const runtime = "nodejs";

/** Vercel / Next: lets this route run long enough before the platform kills it (upgrade plan may still limit you). */
export const maxDuration = 300;

const RESEARCH_MS = Number(process.env.GAMBLYZER_RESEARCH_TIMEOUT_MS) || 240_000;

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`Research timed out after ${Math.round(ms / 1000)}s.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

export async function POST(req) {
  const reqId = Math.random().toString(16).slice(2);
  try {
    const body = await req.json().catch(() => ({}));
    const pick = body?.pick;
    const counter = Boolean(body?.counter);
    const includeCounter = !counter && body?.includeCounter === true;
    if (!pick) throw new Error("Missing pick");

    const userContext = typeof body?.userContext === "string" ? body.userContext : "";
    const gapClosure = typeof body?.gapClosure === "string" ? body.gapClosure : "";
    const counterUserContext = typeof body?.counterUserContext === "string" ? body.counterUserContext : "";
    const counterGapClosure = typeof body?.counterGapClosure === "string" ? body.counterGapClosure : "";
    const ucLen = userContext.trim().length;
    const gcLen = gapClosure.trim().length;
    const cucLen = counterUserContext.trim().length;
    const cgcLen = counterGapClosure.trim().length;
    console.log(
      `[gamblyzer] req=${reqId} research start counter=${counter ? "1" : "0"} includeCounter=${includeCounter ? "1" : "0"} user_ctx_chars=${ucLen} gap_chars=${gcLen} counter_ctx_chars=${cucLen} counter_gap_chars=${cgcLen}`
    );
    const opts = {};
    if (ucLen) opts.userContext = userContext;
    if (gcLen) opts.gapClosure = gapClosure;
    if (cucLen) opts.counterUserContext = counterUserContext;
    if (cgcLen) opts.counterGapClosure = counterGapClosure;
    if (includeCounter) opts.includeCounter = true;
    const runner = counter
      ? generateCounterResearchNarrative(pick, opts)
      : generateResearchNarrative(pick, opts);
    const result = await withTimeout(runner, RESEARCH_MS);
    console.log(`[gamblyzer] req=${reqId} research ok`);
    return Response.json(result, { status: 200 });
  } catch (e) {
    console.error(`[gamblyzer] req=${reqId} research error`, e);
    return Response.json({ error: e?.message || String(e) }, { status: 400 });
  }
}
