## Gamblyzer web app (Vercel / Next.js)

This repo contains your existing CLI scripts (including `gamblyzer5.js`) **unchanged**, plus a new Next.js web app that reuses the same idea (Odds API → DraftKings + Polymarket → AI research + short narrative) while keeping API keys server-side.

### What you get

- **Web UI**: generate **one or multiple** picks in one Odds fetch; run AI research **per pick**; with two or more fully researched picks, **Claude judge** compares dossiers (evidence/support, not outcome prediction) and recommends one with reasoning
- **Server API**:
  - `POST /api/pool` — list eligible DraftKings lines matching your odds range / leagues (`leagues`, `min`, `max`; optional `limit` up to 400)
  - `POST /api/pick` — fast pick(s) in **one Odds fetch** (same filters; optional `count` 1–12 for that many distinct random lines). Optional `pickIndex` pins one line (always `"count"` 1). Optional `restrictPoolIndices` restricts random picks to those indices (same numbering as `/api/pool`; up to 400). Response shape: **`{ picks, pickBatchReturned, pickBatchRequested, poolSize, batchTruncated }`**
  - `POST /api/research` — AI research + narrative for one pick (`{ pick }`). Send `{ pick, counter: true }` for a **counter dossier** (contrarian / fade-angle search + skeptic narrative on the **same DK line**).
  - `POST /api/judge` — Claude-only: body `{ picks: [...] }`. Optional **`userContext`** (string): bettor-supplied notes the judge folds in as unverified context (preferences, stakes, corrections) alongside dossiers. Empty string behaves like omission. **`GAMBLYZER_JUDGE_USER_CONTEXT_MAX_CHARS`** trims very long payloads (defaults with a sane cap). **Multi:** ≥2 picks, each needs primary `narrativeCombined`; optional `counterNarrativeCombined` per pick is weighed vs the supporting dossier before comparing tickets. **Single:** exactly one pick requires **both** primary and counter dossiers for a ticket-level pro-vs-con verdict (`RECOMMENDED_STANCE`). **`ANTHROPIC_API_KEY`** required.
  - `POST /api/generate` — pick + narrative in **one call** (**`count`** must stay **1**); optional `pickIndex` / `restrictPoolIndices`. For multiple picks without combined AI, use `/api/pick` with `count` then `/api/research` per line.

### Local setup

#### Node version

Use **Node 22 LTS** (Node 24 can hang on `next dev` with this Next.js version).

If you use `nvm`:

```bash
nvm install 22
nvm use
```

1) Install deps:

```bash
npm install
```

2) Create `.env.local` from the template:

```bash
cp .env.local.example .env.local
```

3) Put your real keys into `.env.local`:

- `ODDS_API_KEY` (The Odds API v4)
- `ANTHROPIC_API_KEY` (Claude Messages API)
- optional `GEMINI_API_KEY` (fallback)

4) Run:

```bash
npm run dev
```

Open `http://localhost:3000`.

### Deploy on Vercel (Option A)

1) Push this repo to GitHub.
2) In Vercel: **New Project** → import the repo.
3) In Vercel Project Settings → **Environment Variables**, add:
   - `ODDS_API_KEY`
   - `ANTHROPIC_API_KEY` (recommended even if you also use Gemini)
   - optional: `GEMINI_API_KEY`, `ODDS_API_REGIONS`, `CLAUDE_MODEL`, `CLAUDE_JUDGE_MODEL`, `GAMBLYZER_JUDGE_TIMEOUT_MS`
4) Deploy.

### Attach your domain

In Vercel Project → **Settings → Domains**:

- Add either:
  - **Subdomain**: `app.yourdomain.com` (recommended), or
  - **Apex**: `yourdomain.com`

Then follow Vercel’s exact DNS instructions (they vary slightly by registrar).

Typical DNS records:

- **Subdomain (`app`)**: create a `CNAME` record
  - **Name/Host**: `app`
  - **Value/Target**: `cname.vercel-dns.com` (or whatever Vercel shows)

- **Apex (`@`)**: Vercel may ask for `A` records (or may suggest moving DNS to Vercel nameservers)

Once DNS is correct, Vercel will automatically provision HTTPS (SSL).

### Notes

- **Research timeouts**: `/api/research` defaults to **240s** (`GAMBLYZER_RESEARCH_TIMEOUT_MS`). The browser waits **~305s** (`RESEARCH_FETCH_TIMEOUT_MS` in `app/page.js`) so the server usually finishes first. If you raise one, raise the other slightly above it.

- **Research efficiency (why it’s slow + what you can do)**:
  - Dominant cost is usually **Claude + web search**, not your prompt length — one research run is **two LLM calls** (search pass, then narrative). Counter dossiers double that again.
  - **Prompts now target 2–3 deduplicated FACT lines** (hard cap 4) and tell the model to **stop after enough distinct claims** — fewer tokens and less redundant multi-source repetition.
  - **Give it more wall time** if needed: `GAMBLYZER_RESEARCH_TIMEOUT_MS` (server) and `RESEARCH_FETCH_TIMEOUT_MS` (client) in `app/page.js`.
  - **Cap model output** (smaller = faster, but can truncate if set too low): `GAMBLYZER_RESEARCH_MAX_TOKENS` (default **640**, research bullet pass), `GAMBLYZER_NARRATIVE_MAX_TOKENS` (default **768**, write-up pass), `GAMBLYZER_RESEARCH_PASTE_CHARS` (how much of the bullets is pasted into the narrative step, default **6500**).
  - **Try a faster Claude model** via `CLAUDE_MODEL` if Anthropic offers a faster tier for your account (quality may change).
  - **Duplicate claims**: the research prompt now forbids **same claim, two URLs**. If you still see overlap, lower `GAMBLYZER_RESEARCH_MAX_TOKENS` or tighten `CLAUDE_MODEL` / retry; a post-process deduper is possible later if needed.

- **Judge timeouts**: `/api/judge` defaults to **180s** (`GAMBLYZER_JUDGE_TIMEOUT_MS`). The UI uses `JUDGE_FETCH_TIMEOUT_MS` in `app/page.js`; keep it slightly higher than the server value. **`CLAUDE_JUDGE_MODEL`** overrides the Claude model for judging (defaults match `CLAUDE_MODEL`).

- Keys are read from environment variables only. The existing `config.json` used by the CLI is not used by the web app.
- Vercel serverless functions run in a server timezone (often UTC). “Today” filtering is based on that server-local calendar day.

