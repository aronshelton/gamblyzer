## Gamblyzer web app (Vercel / Next.js)

This repo contains your existing CLI scripts (including `gamblyzer5.js`) **unchanged**, plus a new Next.js web app that reuses the same idea (Odds API → DraftKings + Polymarket → AI research + short narrative) while keeping API keys server-side.

### What you get

- **Web UI**: choose one or more leagues (NBA / MLB / NHL), set American odds range, generate a fast pick; optionally generate research + narrative
- **Server API**:
  - `POST /api/pick` — fast pick (`leagues: ["NBA","MLB"]` or legacy `league: "NBA" | "ALL"`)
  - `POST /api/research` — optional AI research + narrative for a chosen pick payload
  - `POST /api/generate` — pick + narrative in one call (still supported); same `leagues` / `league` inputs

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
   - optional: `GEMINI_API_KEY`, `ODDS_API_REGIONS`, `CLAUDE_MODEL`
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

- **Research timeouts**: `/api/research` defaults to **240s** (`GAMBLYZER_RESEARCH_TIMEOUT_MS`). The browser waits **~305s** so the server usually finishes first. If you raise the server timeout, bump `RESEARCH_FETCH_TIMEOUT_MS` in `app/page.js` to stay above it.

- Keys are read from environment variables only. The existing `config.json` used by the CLI is not used by the web app.
- Vercel serverless functions run in a server timezone (often UTC). “Today” filtering is based on that server-local calendar day.

