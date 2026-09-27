# WEDJAT BRAIN — Zero-Cost Architecture

> **$0.00/month. No billing ever. No Docker. No laptop. No server to maintain.**
>
> The Brain trains and expands its knowledge automatically, every day, using
> only free-tier services and open-source software.

## Architecture Overview

```
                    ┌─────────────────────────────────┐
                    │       GitHub Actions (Free)       │
                    │   Daily "Brain Training" cron      │
                    │   2000 min/month free              │
                    └───────────────┬─────────────────────┘
                                    │
                    ┌───────────────▼─────────────────────┐
                    │       Vercel (Free Hobby Tier)       │
                    │   wedjatbrain-ai.vercel.app          │
                    │   Next.js serverless functions      │
                    │   100 GB bandwidth, 1000 builds      │
                    └───────┬───────────────┬─────────────┘
                            │               │
              ┌─────────────▼──┐    ┌───────▼──────────────┐
              │  Neon (Free)   │    │  Turso (Free)        │
              │  Canonical DB  │    │  Edge read replica   │
              │  0.5 GB,       │    │  9 GB, 1B reads/mo   │
              │  always-on     │    │  500 databases       │
              └────────────────┘    └──────────────────────┘
                            │
              ┌─────────────▼──────────────────────────────┐
              │  Inngest (Free Tier)                        │
              │  Background job execution                   │
              │  2500 function runs/month                   │
              │  Polls /api/inngest on Vercel               │
              └─────────────────────────────────────────────┘
```

## How It Works (The Creative Part)

### 1. GitHub Actions = The "Training Server" (Free)
Instead of running a server 24/7, we use **GitHub Actions** as a serverless
cron job. Every day at 03:00 UTC, a workflow runs that:

- **Consolidates memory** — promotes good learning candidates, rejects bad ones
- **Refreshes knowledge** — re-validates stale items
- **Runs the evaluation suite** — measures Brain quality
- **Ingests trending topics** — fetches Wikipedia's most-viewed articles and creates learning candidates for topics the Brain doesn't know about yet
- **Exports a knowledge snapshot** — saves the knowledge base as JSON files and commits them to the repo (versioned backup)

**Cost: $0.00** — GitHub Actions gives 2000 minutes/month free. The training
job takes ~5 minutes. That's ~150 minutes/month, well within the free tier.

### 2. Vercel = The App Host (Free Hobby Tier)
The Next.js app + all API routes deploy to Vercel's free hobby tier:
- Serverless functions (auto-scaling, no cold-start management)
- 100 GB bandwidth/month
- 1000 deployments/month
- Custom domain support

**Cost: $0.00** — Vercel hobby tier is free for personal projects.

### 3. Neon = Canonical Brain DB (Free Tier)
Neon's free tier hosts the primary PostgreSQL database:
- 0.5 GB storage
- Always-on (no cold starts)
- Branching for dev/preview
- Full SQL support

**Cost: $0.00** — Neon free tier is permanent (no trial expiration).

### 4. Turso = Edge Read Replica (Free Tier)
Turso syncs knowledge from Neon for fast edge/local reads:
- 9 GB total storage
- 500 databases
- 1 billion row reads/month
- SQLite-compatible (libsql)

**Cost: $0.00** — Turso's free tier is the most generous in the industry.

### 5. Inngest = Background Job Engine (Free Tier)
Inngest runs the 5 brain functions (memory consolidation, knowledge refresh,
evaluation, event pipeline, human approval waits):
- 2500 function runs/month
- Cron schedules
- Event-driven triggers
- Retries + durable execution

**Cost: $0.00** — Inngest's free tier covers the Brain's background needs.

### 6. Git = Knowledge Versioning (Free)
The knowledge base is exported as JSON files and committed to the repo:
- `data/knowledge-snapshot/knowledge.json` — all knowledge items
- `data/knowledge-snapshot/memory.json` — durable memories
- `data/knowledge-snapshot/tools.json` — tool registry
- `data/knowledge-snapshot/platforms.json` — platform registry
- `data/knowledge-snapshot/summary.json` — counts + timestamps

This means:
- **Knowledge is versioned** — every day's training is a git commit
- **Knowledge is backed up** — the repo IS the backup
- **Knowledge is diff-able** — `git diff` shows what the Brain learned
- **Knowledge is portable** — clone the repo, run `bun run db:push`, import

## The Auto-Training Loop

```
Every day at 03:00 UTC:
  1. GitHub Actions triggers
  2. Memory consolidation runs (promote/reject candidates)
  3. Knowledge refresh runs (re-validate stale items)
  4. Golden evaluation runs (measure quality)
  5. Trending topics fetched from Wikipedia (free API, no key)
  6. New topics → learning candidates (Brain will research them)
  7. Knowledge exported as JSON → committed to repo
  8. Git push → Vercel auto-deploys (if code changed)
  9. Inngest picks up events → runs background functions
```

The Brain gets smarter every day. Automatically. For free.

## Free Tier Limits (All Generous Enough)

| Service | Free Tier | Brain Usage | Headroom |
|---------|-----------|-------------|----------|
| GitHub Actions | 2000 min/month | ~150 min/month | 92% spare |
| Vercel Hobby | 100 GB bandwidth | <1 GB/month | 99% spare |
| Neon Free | 0.5 GB storage | ~50 MB | 90% spare |
| Turso Free | 9 GB + 1B reads | ~10 MB | 99% spare |
| Inngest Free | 2500 runs/month | ~100 runs/month | 96% spare |
| z-ai SDK | Free (GLM models) | API calls | Unlimited |

**Total monthly cost: $0.00**
**Billing ever needed: No**
**Docker required: No**
**Laptop required: No**
**Server to maintain: None**

## Setup Instructions

1. **Fork the repo** on GitHub
2. **Set GitHub Secrets** (Settings → Secrets and Actions):
   - `DATABASE_URL` — Neon connection string
   - `TURSO_DATABASE_URL` — Turso libsql URL
   - `TURSO_AUTH_TOKEN` — Turso auth token
   - `BRAIN_API_URL` — your Vercel URL (optional, for remote calls)
3. **Import to Vercel** (vercel.com → New Project → import from GitHub)
4. **Set Vercel Environment Variables** (same as GitHub Secrets)
5. **Connect Inngest** (console.inngest.com → connect your Vercel app)
6. **Enable the GitHub Action** (Actions tab → enable workflow)

The Brain will start training automatically at 03:00 UTC daily.

## Manual Training

You can also trigger a training run manually from GitHub:
- Go to the repo → Actions tab → "Brain Training Loop" → Run workflow

Or locally:
```bash
DATABASE_URL=... bun run scripts/train-brain.ts --job=all
```

## Turso Sync (Optional Edge Cache)

To sync knowledge from Neon to Turso for fast edge reads:
```bash
DATABASE_URL=... TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... \
  bun run scripts/sync-turso.ts
```

This can be added as a GitHub Actions step or run on demand.

## No Docker, No Laptop, No Server

- **No Docker** — everything runs on serverless platforms (Vercel, GitHub Actions, Inngest cloud)
- **No laptop** — the Brain runs entirely in the cloud; you only need a browser
- **No server** — no VMs, no containers, no process managers. GitHub Actions is the "cron", Vercel is the "app server", Inngest is the "background worker"

## Open Source

All code is open source (MIT license). The knowledge base, tools, adapters,
and training scripts are all in the repo. Anyone can fork, deploy, and train
their own Brain for free.
