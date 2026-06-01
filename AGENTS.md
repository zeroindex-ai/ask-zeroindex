# ask-zeroindex — agent guide

RAG chat widget for `zeroindex.ai`. Answers visitor questions about ZeroIndex's
services, principles, and process — grounded in the site's own content with
citations. Next 16 app on Vercel, Turso (libsql) for vector + FTS retrieval.

The *why* and the architecture live in `PROJECT.md`. This file is how to work here.

## Guardrails (do not violate)

- **Never commit secrets.** `.env.local` and real Turso/Anthropic/Voyage/etc. keys
  stay out of git (`.gitignore` covers them — double-check before `git add -A`).
- **Public repo → sanitize docs.** No machine paths, vault names, private-memory
  refs, or sprint/portfolio framing in any committed `.md`. The `md-review-gate`
  hook enforces this at commit time.
- **Branch before the first commit.** Run `git branch` and confirm — repos are
  sometimes left on an in-flight feature branch. Don't assume `main`.
- **Visual changes: preview before commit.** Run the dev server and get a human
  eyeball/approval BEFORE committing UI changes. Non-visual changes follow normal flow.
- **Scope UI edits to the named element.** "Make X taller" changes only X. Decouple
  shared tokens first; don't grow siblings.
- **The `/embed` route is chromeless by design.** It's the iframe surface embedded on
  `zeroindex.ai` — no header/footer. Don't add the standard subdomain chrome to it;
  the standalone `(site)/` route is the chromed one.
- **Public endpoints need rate limiting + SSRF guards** (P0). A dedupe hash is not a
  rate limit. `/api/ask` is gated by the Turso-backed atomic token bucket in
  `src/lib/rateLimit.ts` — keep it before any paid-API work.

## Commands

```bash
pnpm dev          # Next.js dev server (Turbopack, localhost:3000)
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint
pnpm build        # next build (also the CI gate)
pnpm ingest       # content → chunks → embeddings → Turso (one-time / on content change)
pnpm eval         # run golden Q/A through pipeline + LLM-as-judge
```

## Conventions & gotchas

- **Lazy `db()` singleton.** The libsql client + strict `env()` init are deferred to
  first request, NOT module load — a top-level `env()` makes `next build` require
  runtime secrets and preview deploys fail. Keep DB access behind the lazy proxy
  (`src/lib/db.ts`, with `initSchema()`).
- **libsql here does NOT need the undici fetch workaround.** Vercel's fetch
  instrumentation corrupts libsql only during a Server Component *render*; ask queries
  the DB exclusively inside the `/api/ask` route handler (never at render time), so the
  plain `@libsql/client` in `src/lib/db.ts` is correct as-is. (Other ZeroIndex apps that
  read libsql during SSR do need that workaround — this one doesn't.)
- **Eval before changing retrieval/prompts/models.** `pnpm eval` is the quality
  contract — re-run it and record the headline metric before/after any change.
- **Stale CSS after a `globals.css` edit** = Next 16 + Turbopack caching. `rm -rf
  .next` + restart dev (hard-refresh/incognito won't fix it).
- **Favicon lives in `src/app/favicon.ico`**, not `public/` (the app router intercepts
  it). The other favicon assets (PNGs, SVG, OG image) stay in `public/`.
- **SSR everything** — no client-side data fetches for first paint; render on the server.

## Where to look

- `PROJECT.md` — why it exists, decisions, architecture, the public contract.
- `eval-baselines.md` — the retrieval ablation table + the prompt-caching decision.
- Chrome/layout: the `zeroindex-app-layout` skill (canonical header/footer/spacing).
  The standalone `(site)/` route uses it; `/embed` is deliberately chromeless.
- Design tokens: `STYLE_GUIDE.md` in the `zeroindex-site` repo (mirrored in
  `app/globals.css`). Don't invent colors.
- Deploy: the `deploy-zeroindex-vercel-app` skill (Turso → Vercel env → domain).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

## AI pipeline

- **Eval harness is the contract for quality.** `pnpm eval` runs the golden set
  (`evals/golden-seed.json`, LLM-as-judge in `evals/run.ts`) via
  `@zeroindex-ai/eval-pack`; don't change retrieval/prompts/models without re-running
  it. Record the headline metric (pass-rate; current baseline 90% on the 30-query set)
  in `PROJECT.md` / `eval-baselines.md`.
- **Model picks are deliberate and documented** — Claude Sonnet 4.6 for generation,
  Voyage-3 for embeddings, rerank-2.5 for reranking; pick by eval, not vibe. Prompt
  caching was evaluated and removed (net-negative at this corpus scale; see
  `eval-baselines.md` §6).
- **Cited output must be escaped** — HTML-escape any model text rendered to the page
  (five-entity coverage). Citations (`[chunk:N]` markers) resolve to real sources
  before display.
