# ask-zeroindex

RAG chat widget for zeroindex.ai. Answers visitor questions about ZeroIndex's services, principles, and process — grounded in the site's own content with citations.

## Stack

- **Next.js 16** (App Router, src dir, TypeScript, Tailwind 4, Turbopack default)
- **Claude Sonnet 4.6** for answer generation (prompt caching was evaluated and removed — it was net-negative at this corpus scale; see eval-baselines.md §6)
- **Voyage-3** for embeddings, **rerank-2.5** for reranking
- **Turso** (libsql) — native vector (`F32_BLOB`) + FTS5 hybrid retrieval
- **Zod** for request validation

## Architecture

```
ingest (scripts/ingest.ts)
  data/*.md|html  →  chunk by section
                  →  embed (Voyage-3, batched)
                  →  upsert chunks (Turso) + rebuild chunks_fts

ask (src/app/api/ask/route.ts)
  question  →  hybridSearch  ─ vector_top_k  ──┐
                              └─ FTS bm25 ──┴─ → rerank-2.5 top-5
            →  answer (Claude Sonnet 4.6, streaming SSE)
            →  events: chunks → text* → done
```

## Layout

```
src/
  app/
    (site)/            chromed routes (header/footer via (site)/layout.tsx)
      layout.tsx       canonical ZeroIndex subdomain chrome
      page.tsx         standalone widget page (ask.zeroindex.ai)
    embed/page.tsx     chromeless iframe route (embedded on zeroindex.ai)
    api/ask/route.ts   POST endpoint, Zod validation, SSE streaming
    layout.tsx         root layout (metadata, globals.css)
    globals.css        Tailwind 4 base + design tokens
  components/
    AskWidget.tsx      client widget (input, streaming output, citations)
    AskIntro.tsx       shared section copy (standalone + embed)
  lib/
    db.ts              lazy Turso client singleton + initSchema()
    embeddings.ts      Voyage embed + rerank (REST)
    retrieval.ts       vector + FTS + hybrid + rerank
    claude.ts          Anthropic client, system prompt, streaming answer
    citationParser.ts  [chunk:N] marker extraction
    sse.ts             SSE event encoding helpers
    rateLimit.ts       Turso-backed atomic token bucket
    logAsk.ts          structured logging + optional trace-pack dual-write
    env.ts             validated env-var access
    errors.ts          typed error helpers
    models.ts          model id constants
    sourcePath.ts      source-path normalization
    types.ts           Chunk, RetrievedChunk, Citation, AnswerResponse
scripts/
  ingest.ts            content → chunks → embeddings → DB (+ smoke, verify, ask, ablate, …)
evals/
  golden-seed.json     Q/A pairs with must_mention assertions (30 hand-labeled items)
  run.ts               LLM-as-judge harness
data/                  source content drop-zone (.gitkeep; ingest reads sibling site repo)
```

## Setup

```bash
pnpm install
cp .env.example .env.local   # fill in keys
pnpm ingest                  # one-time / on content change
pnpm dev
```

## Scripts

| Command          | Purpose                                     |
| ---------------- | ------------------------------------------- |
| `pnpm dev`       | Next.js dev server (Turbopack)              |
| `pnpm build`     | Production build                            |
| `pnpm typecheck` | `tsc --noEmit`                              |
| `pnpm lint`      | ESLint                                      |
| `pnpm ingest`    | Run content ingest pipeline                 |
| `pnpm eval`      | Run golden Q/A through pipeline + LLM judge |

## Deploy

Vercel (free tier). Env vars via `vercel env add`. Widget mounts on zeroindex.ai via embed script (or rebuilt directly into the site repo).
