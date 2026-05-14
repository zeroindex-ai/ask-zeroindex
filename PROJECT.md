# ask-zeroindex — Project Documentation

> **Status: shipped** — live at `ask.zeroindex.ai`, embedded on `zeroindex.ai`. RAG pipeline + widget + LLM-as-judge eval harness; 90% pass rate on the 30-query golden set. Detailed retrieval ablation and the prompt-caching decision are in `eval-baselines.md`.

This document captures the research, strategic decisions, architecture, implementation, testing approach, and integration plan for `ask-zeroindex`. It exists to:

1. Onboard future collaborators (or future-you, in a clean session)
2. Capture the **reasoning** behind stack picks and design choices, not just the choices themselves
3. Provide a single source of truth for "what's done, in flight, and pending"
4. Document the engineering decisions and tradeoffs as a durable complement to the code

---

## 1. Project overview

### What `ask-zeroindex` is

A RAG (Retrieval-Augmented Generation) chat widget for `zeroindex.ai`. Visitors type questions about ZeroIndex — services, principles, pricing, process, founder background — and a Claude Sonnet 4.6 model answers strictly from the site's own content, with chunk-level citations.

The widget is mounted on `zeroindex.ai` (Cloudflare Workers) via an embed snippet. The backing API is a Next.js route deployed to Vercel. Storage is Turso (libsql cloud) — a single SQLite-compatible DB holding both vector embeddings and a BM25 full-text index.

### Why this project

`ask-zeroindex` makes the zeroindex.ai site interactive: visitors can ask about services, pricing, principles, or background and get answers grounded in the site's own content rather than hunting through sections. It also exercises a full production RAG stack end-to-end — embeddings, hybrid retrieval, reranking, streaming, eval-driven prompt development. The widget doubles as an honest stress test of the site copy: if Claude can't answer *"what's your pricing?"* from the page, the page doesn't either.

### Goals & success criteria

| Goal | Metric | Status |
|---|---|---|
| RAG pipeline working end-to-end | Single test query returns grounded answer with citations | ✅ (2026-05-05) |
| 30 golden Q/A baseline | ≥ 80% pass rate on LLM-as-judge | ✅ 90% baseline locked in `eval-baselines.md` |
| First-token latency | p50 < 2s, p95 < 4s | ⏳ open — current 3.8s |
| Widget live on `zeroindex.ai` | Visitors can ask + get answers | ✅ shipped at `ask.zeroindex.ai`, embedded on the site |

### Out of scope (v1)

- Multi-turn conversation (single Q/A turn only)
- User accounts / chat history persistence
- Voice / multimodal input
- Real-time content sync (re-ingest on site change is manual via `pnpm ingest`)
- Multi-language support (English only)
- Rate limiting at the widget level (Vercel free-tier abuse protection only)

---

## 2. Strategic decisions log

Load-bearing decisions, documented because the *why* often outlasts the *what*.

### Stack picks

| Decision | Choice | Reasoning |
|---|---|---|
| **Framework** | Next.js 16 (App Router, src dir, TS, Turbopack default) | Mature SSR/edge story, free Vercel deploy, App Router's streaming primitives align with SSE answer flow. Was scaffolded with `create-next-app` so no opinionated layer added. |
| **Storage** | Turso (libsql) — vector + FTS in one DB | SQLite-compatible (familiar), native `F32_BLOB(N)` + `vector_top_k()` (no sqlite-vec extension needed), native FTS5 for BM25. Free tier easily covers this scale. |
| **Embeddings** | Voyage-3 (1024 dim) | Better retrieval quality than OpenAI text-embedding-3-small in published benchmarks. Free tier: 200M tokens. |
| **Reranking** | Voyage rerank-2.5 | Same vendor relationship; designed to pair with Voyage-3 embeddings; meaningful precision lift over raw vector or BM25 alone. |
| **LLM** | Claude Sonnet 4.6 | Primary model commitment for ZeroIndex consultancy; strong RAG quality at moderate cost ($3/M in, $15/M out); prompt caching well-supported. |
| **HTML parser** | cheerio | Mature, jQuery-like API, fast enough for static HTML ingest. |
| **Validation** | Zod 4 | TypeScript-first schema validation, used at the API boundary in `route.ts`. |
| **Package manager** | pnpm 10 | Faster + disk-efficient. Same package manager as the `mcp-pack` monorepo — consistency across the `@zeroindex-ai/*` ecosystem. |
| **Node** | 24 LTS via nvm | Current LTS; required by Next 16 (≥ 20.9). |

### Things deliberately NOT chosen

| Avoided | Why |
|---|---|
| Pinecone / Weaviate / Qdrant | Operational complexity. Turso wins on simplicity for this scale (low tens of thousands of chunks). Revisit if multi-tenant or > 1M chunks. |
| OpenAI text-embedding-3 | Published benchmarks favor Voyage-3 for retrieval. Single-vendor diversification away from OpenAI is also a small but real value. |
| LangChain / LlamaIndex | The pipeline here is short — embed, store, retrieve, prompt. Pulling in a heavy framework would obscure what's happening. Hand-rolled wins on transparency for a learning-oriented project. |
| Pages Router | App Router is where Next.js momentum lives; Streaming SSE works cleanly with the new Response patterns. |
| React Server Components for the widget | Widget is interactive (input, streaming output) — a client component is the right primitive. |
| Voyage Node SDK | The REST API is 4 endpoints with simple JSON shapes — a thin fetch wrapper gives more control over batching and error handling, and zero version-pinning surprises. |

### Architecture decisions

| Decision | Choice | Reasoning |
|---|---|---|
| **Hybrid retrieval** | Vector (top-12) ∪ FTS (top-12) → rerank → top-5 | Vector finds semantic matches; FTS finds exact-keyword/proper-noun matches the embeddings sometimes miss; reranker dedupes and re-scores. Empirically, hybrid + rerank > either alone. |
| **Chunking** | By section heading (h2), then by h3 if present; 1600-char target, 200-char overlap when oversized | Mirrors human authoring intent. Headings carry semantic boundary signal. Char-based budgeting is good enough for v1; switch to token-counted budgeting if eval shows boundary issues. |
| **Citations** | `[chunk:N]` markers in the streamed text | Simple format the model already produces; client-side parser substitutes them for rendered citation chips. No structured tool calls needed for this scale. |
| **Streaming format** | SSE (Server-Sent Events) | Native browser support, works through CDNs cleanly, simpler than WebSockets for one-way streams. Events: `chunks` (id list, sent first) → `text` (deltas) → `done`. |
| **Prompt caching** | Cache `system` + retrieved `context` (`cache_control: { type: 'ephemeral' }`) | Visitor questions vary; the system prompt and recent retrieved chunks are reusable across nearby requests. Real cost driver. |
| **Re-ingest model** | Drop and rebuild (not incremental) | At ~22 chunks per ingest of `zeroindex.ai`, full reingest takes seconds. Not worth incremental complexity until content scale justifies. |

---

## 3. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                         zeroindex.ai (Cloudflare Worker)            │
│                  ┌────────────────────────────────────┐             │
│                  │  embed snippet → widget (iframe   │             │
│                  │  served from ask.zeroindex.ai)    │             │
│                  └────────────────────────────────────┘             │
└──────────────────────────────────│─────────────────────────────────┘
                                   │ POST /api/ask  { question }
                                   │ ← SSE: chunks → text* → done
                                   ▼
┌────────────────────────────────────────────────────────────────────┐
│              Next.js 16 on Vercel (us-east-1, free tier)            │
│  ┌──────────────────┐  ┌────────────────┐  ┌──────────────────┐     │
│  │ src/app/api/ask  │→ │ hybridSearch   │→ │ answer (Claude   │     │
│  │ route.ts (SSE)   │  │  ├ vectorTopK  │  │  Sonnet 4.6      │     │
│  │                  │  │  ├ ftsBM25     │  │  + caching       │     │
│  │                  │  │  └ rerank-2.5  │  │  + streaming)    │     │
│  └──────────────────┘  └────────────────┘  └──────────────────┘     │
└──────────│──────────────────│─────────────────────│────────────────┘
           │                  │                     │
           │ vector_top_k +   │ Voyage-3 + rerank   │ Anthropic
           │ FTS5 MATCH       │ (REST)              │ Messages API
           ▼                  ▼                     ▼
┌──────────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  Turso (aws-us-east) │  │  Voyage AI       │  │  Anthropic API   │
│  ask-zeroindex.db    │  │  (embed+rerank)  │  │  (claude-sonnet) │
│  ├ chunks (F32_BLOB) │  │                  │  │                  │
│  ├ chunks_fts (FTS5) │  │                  │  │                  │
│  └ idx_chunks_vec    │  │                  │  │                  │
└──────────────────────┘  └──────────────────┘  └──────────────────┘
```

### Data flow — ingest

```
data/ or ../zeroindexai/index.html
   │
   ▼
[scripts/ingest.ts]
   │
   ├─ cheerio.load(html)
   ├─ strip script/style/nav/header/footer
   ├─ walk <section> elements
   │    └─ for each: extract h1/h2 as section name, h3-bounded body as chunks
   ├─ split oversized chunks (>1600 chars) with 200-char overlap
   │
   ▼
batch-embed via Voyage-3 (up to 128 inputs/call)
   │
   ▼
DELETE FROM chunks  →  INSERT INTO chunks (..., vector32(embedding))
   │
   ▼
INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')
```

### Data flow — query

```
question
   │
   ▼
hybridSearch(question, topK=5)
   │
   ├─ vectorSearch:    embed query (Voyage-3) → vector_top_k(idx_chunks_vec, ?, 12)
   ├─ ftsSearch:       sanitize query → FTS5 MATCH → bm25 top-12
   │
   ├─ union by chunk id (dedupe)
   │
   ▼
rerank(query, candidate texts, topK=5) via Voyage rerank-2.5
   │
   ▼
answer(question, top-5 chunks)
   │
   ├─ Anthropic messages.stream
   │  ├─ system: SYSTEM_PROMPT (cached)
   │  ├─ system: "Context: [chunk:N] ..." block (cached)
   │  └─ user: question
   │
   ▼
SSE stream: chunks event (ids) → text deltas → done
```

---

## 4. Database schema

```sql
-- Turso libsql; created via initSchema() on every ingest run
CREATE TABLE IF NOT EXISTS chunks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path  TEXT NOT NULL,
  section      TEXT,
  content      TEXT NOT NULL,
  embedding    F32_BLOB(1024)
);

-- Native libsql vector index over the F32_BLOB column.
-- Queried via vector_top_k('idx_chunks_vec', vector32(?), k).
CREATE INDEX IF NOT EXISTS idx_chunks_vec
  ON chunks(libsql_vector_idx(embedding));

-- FTS5 contentless virtual table — pulls content from `chunks` at query time.
-- Rebuilt explicitly after bulk inserts via:
--   INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
  USING fts5(content, content='chunks', content_rowid='id');
```

**Why F32_BLOB(1024):** Voyage-3's default embedding dimensionality is 1024. The schema is bound to this; switching models requires a migration (drop the column + index, re-ingest).

**Why content='chunks' FTS:** the FTS table is a shadow index — all content lives in `chunks`. Saves storage and avoids drift, at the cost of needing manual rebuild after bulk inserts (no auto-sync triggers).

---

## 5. Repository layout

```
ask-zeroindex/
├── src/
│   ├── app/
│   │   ├── api/ask/route.ts        POST endpoint, Zod validation, SSE streaming
│   │   ├── layout.tsx              root layout (default from create-next-app)
│   │   ├── page.tsx                widget UI (input, streaming output, citation chips)
│   │   └── globals.css             Tailwind 4 base
│   └── lib/
│       ├── db.ts                   Turso client factory + initSchema() + EMBEDDING_DIM
│       ├── embeddings.ts           Voyage REST: embedDocuments / embedQuery / rerank
│       ├── retrieval.ts            vectorSearch + ftsSearch + hybridSearch (with rerank)
│       ├── claude.ts               Anthropic client; SYSTEM_PROMPT; answer() (caching+stream)
│       └── types.ts                Chunk, RetrievedChunk, Citation, AnswerResponse
├── scripts/
│   ├── ingest.ts                   HTML → chunks → embeddings → Turso → FTS rebuild
│   ├── smoke.ts                    3-service connection test (Anthropic, Voyage, Turso)
│   ├── verify.ts                   post-ingest sanity (counts + sample + retrieval)
│   └── ask.ts                      end-to-end question → grounded answer w/ timing
├── evals/
│   ├── golden.json                 Q/A pairs with must_mention assertions (currently 2 sample)
│   └── run.ts                      LLM-as-judge harness
├── data/                           source content drop-zone (currently empty; ingest reads from sibling website repo)
├── public/                         static assets (default Next scaffold)
├── .env.example                    template
├── .env.local                      real keys (gitignored)
├── package.json                    pnpm scripts: dev, build, typecheck, lint, ingest, eval
├── README.md                       short user-facing intro
├── PROJECT.md                      this document
├── AGENTS.md                       Next 16 heads-up note (auto-generated)
└── CLAUDE.md                       points at AGENTS.md (auto-generated)
```

---

## 6. Roadmap

### Phase 1 — Build ✅ shipped

- Scaffold + Turso schema + ingest pipeline + Voyage embeddings + hybrid retrieval
- HTTP layer end-to-end; structured citation parsing from `[chunk:N]` markers
- Widget UI on `src/app/page.tsx` — input, streaming output, citation chips
- Prompt caching investigation and retrieval ablation
- Eval harness with 30 golden Q/A; LLM-as-judge; 90% pass-rate baseline locked in

### Phase 2 — Polish + ship ✅ shipped

- Vercel production deploy with env vars wired
- Widget integration on `zeroindex.ai` between FAQ and Contact
- CNAME `ask.zeroindex.ai` → Vercel
- Eval CI gate on every PR + nightly run

### Phase 3 — Maintenance

Re-ingest as site copy changes; re-eval after material prompt or retrieval changes. Future work tracked in §12.

---

## 7. Implementation Steps

### Scaffold + ingest pipeline (2026-05-05)

**Done:**

- Next 16 + React 19 + TS + Tailwind 4 scaffold via `create-next-app` (Turbopack default)
- pnpm 10 + Node 24 LTS via nvm
- Lib structure: `db.ts`, `embeddings.ts`, `retrieval.ts`, `claude.ts`, `types.ts`
- API route stub: `src/app/api/ask/route.ts` (POST, Zod-validated, SSE)
- Stubs: `scripts/ingest.ts`, `evals/run.ts`, `evals/golden.json`, `data/.gitkeep`
- `.env.example` + working `.env.local` (4 keys: Anthropic, Voyage, Turso URL + token)
- README + this PROJECT.md
- pnpm scripts: `dev`, `build`, `typecheck`, `lint`, `ingest`, `eval`
- gitignore allows `.env.example`, blocks `.env.local`

**Service signups:**

- Voyage AI account → API key created
- Turso account → CLI installed → DB `ask-zeroindex` created in `aws-us-east-1` → URL + long-lived token
- Anthropic API credits funded

**Repo state:** public at `github.com/zeroindex-ai/ask-zeroindex`.

**Smoke test (`scripts/smoke.ts`) — all green:**

```
Turso      OK
Voyage     OK (1024 dims)
Anthropic  OK (ok)
```

**Ingest baseline (2026-05-05):**

- Source: sibling `zeroindexai` repo's `index.html`
- Chunks extracted: 22
- Avg chunk size: 279 chars
- Total ingest time: 83.2s (dominated by 22 sequential INSERTs to Turso us-east-1; batch-insert optimization deferred)

**End-to-end query baseline (2026-05-05):**

- Query: "What services does ZeroIndex offer and how do engagements work?"
- Retrieval: 2.5s
- First token: 3.8s
- Total: 7.0s
- Citations: 5 chunks (correctly grounded)
- Answer quality: solid on services + process; one minor synthesis hallucination noted ("Claude Evals" — phrase doesn't appear verbatim) — addressed in later iterations

**Bug fixed during scaffold:**

- libsql FTS5 `MATCH ?` parameter binding fails with `syntax error near "?"`. Workaround: sanitize query (strip non-word chars, quote each token, OR-join) and interpolate inline. Parameter binding retained for `LIMIT`. Documented in `retrieval.ts:sanitizeFtsQuery`.

### API endpoint + streaming + citations (2026-05-06)

**Done:**

- Rewrote `src/app/api/ask/route.ts` to:
  - Validate body via Zod (rejects empty, malformed JSON, missing field — verified all return 400)
  - Wrap `hybridSearch` in try/catch; failure returns 502 JSON (not a half-opened SSE stream)
  - Stream answer via SSE with proper `Content-Type: text/event-stream` + `Cache-Control: no-cache, no-transform`
  - Streaming citation parser: extracts `[chunk:N]` markers from rolling buffer, strips from text deltas, emits `citation` events as new chunks are referenced
  - Tail flush at end of stream (any unmarked trailing `[` becomes literal text)
  - Try/catch around the stream loop emits an `error` SSE event on Voyage/Anthropic/Turso mid-stream failures
- Built `Citation` objects with `{chunkId, sourcePath, section, quote}` — quote is first 160 chars of chunk content with ellipsis
- Final `done` event carries the full citations array

**SSE event protocol (final):**

```
event: chunks      data: [<chunkId>, ...]               // first, with all retrieved ids
event: text        data: "<text delta>"                 // many; markers stripped
event: citation    data: { chunkId, sourcePath, section, quote }   // one per unique cited chunk, inline
event: done        data: { citations: [...] }           // last
event: error       data: { message }                    // only on failure
```

**End-to-end smoke (curl POST → SSE):**

- Question: "What services does ZeroIndex offer?"
- Retrieved chunks: `[1, 21, 20, 6, 22]`
- Streamed text was clean (no `[chunk:N]` leakage)
- 4 citation events fired inline (chunks 1, 21, 6, 22 — chunk 20 retrieved but not used by model, correctly skipped)
- Validation: `{}` → 400, `{question:""}` → 400, `not json` → 400
- Answer quality: noticeably better than the initial baseline — services, engagement model, contact info all correct, no hallucination

### Widget UI (2026-05-06)

**Done:**

- Single-file client component on `src/app/page.tsx` (`'use client'`)
- Browser-side SSE parsing via `fetch()` + `ReadableStream` reader (`EventSource` only supports GET; we POST)
- State machine: `idle → retrieving → streaming → done | error`
- Empty-state shows 4 suggested questions as clickable chips (one-click ask)
- Streaming text rendered with a `▍` cursor while in flight; whitespace preserved (`whitespace-pre-wrap`)
- Citation chips appear inline as `citation` events arrive, numbered 1, 2, 3…; click any chip to expand its section title + 160-char quote
- Submit-while-streaming: `AbortController` cancels the in-flight stream and starts the new one cleanly
- Validation: empty input is no-op (button disabled); invalid response is shown in a red error block
- Pure Tailwind 4, no additional deps
- Server-side render verified (200, key text present); interactive flow verified in browser

### Retrieval ablation + cache instrumentation (2026-05-07)

**Done:**

- 13-query golden seed (`evals/golden-seed.json`) with hand-labeled relevant chunk IDs + must-mention assertions (reusable in the LLM-judge harness below)
- Retrieval ablation script (`scripts/ablate.ts`) measuring Recall@K + latency across vector-only / fts-only / hybrid+rerank top-3/top-5/top-8
- Cache instrumentation script (`scripts/cache-stats.ts`) capturing per-query `cache_creation_input_tokens` + `cache_read_input_tokens`
- Findings + decisions captured in `eval-baselines.md`
- Quality-of-life: Voyage `voyagePost` now retries on transient errors (TypeError / 5xx); `embedQueries` batch variant for warming the query-embedding cache; `embedQuery` has process-local cache (256 entries, FIFO); `db().close()` in script teardown

**Headline numbers:**

```
mode                        mean recall    p50 latency*
----------------------------------------------------------
vector-only top-5           77.6%          9020ms
fts-only top-5              55.1%          166ms
hybrid+rerank top-3         83.3%          21575ms*
hybrid+rerank top-5  ✓      85.3%          21575ms*
hybrid+rerank top-8         92.3%          21575ms*

* hybrid latencies inflated by 21s Voyage free-tier throttle; real ~500-1500ms
```

```
cache hit rate              0.0%   (Sonnet's 1024-token min not met at our prefix size)
cost per 5 queries          $0.0297 (no cache savings)
```

**Decisions locked:**

- **hybrid+rerank top-5** stays as production default (best recall/noise tradeoff at our 22-chunk corpus)
- Caching deferred to the prompt iteration, where extending the system prompt with style/refusal guidance lifts the cacheable prefix above 1024 tokens as a side effect of better answers

### LLM-as-judge eval + system prompt iteration (2026-05-07)

**Done:**

- Expanded golden seed 13 → 30 queries across 4 categories: 19 positive · 6 negative · 3 adversarial · 2 multi-part
- Built `evals/run.ts` LLM-as-judge harness:
  - Per-query: full pipeline run (hybridSearch + Claude answer + citation extraction)
  - Programmatic checks: must_mention, must_not_mention, citation_ok
  - Claude judge call (Sonnet 4.6) returning JSON `{appropriate, grounded, reason}`
  - Per-category aggregates + saved JSON to `evals/results/run-<timestamp>.json`
- Iterated `SYSTEM_PROMPT` in `src/lib/claude.ts` from ~200 to ~600 tokens with style guidance, explicit refusal patterns ("don't pivot to listing what ZeroIndex DOES do"), four worked-example refusals, two worked-example injection refusals
- Extracted `evals/metrics.ts` (recallAtK, percentile, p50, p95) with 11 unit tests
- `evals/results/` gitignored — runs are reproducible from `evals/run.ts`; baseline numbers are documented in `eval-baselines.md`

**Headline numbers:**

```
                  baseline   after prompt iter   delta
positive          16/19      18/19  (95%)        +11pp
negative          3/6        6/6    (100%)       +50pp
adversarial       1/3        2/3    (67%)        +34pp
multi-part        2/2        1/2    (50%)        -50pp (n=2)
TOTAL             22/30      27/30  (90%)        +17pp
```

After 2 trivial label fixes (post-baseline-run), the same prompt scores **29/30 = 97%**; real-only failure rate is 1/30 (multi-part coverage gap on a 2-item sample). Full breakdown in `eval-baselines.md`.

**Cache investigation (deferred):**

Spent ~90 min isolating cache behavior in `scripts/cache-repro.ts`. Single-block requests cache cleanly; our two-block (system + context) shape triggers an asymmetric pattern where `cache_creation_input_tokens` fires every call but `cache_read_input_tokens` is never set — net cost was 25% *worse* than no caching. Could not isolate the trigger (candidates: `<context>` XML tags, account-level setting, SDK serialization difference). Removed `cache_control` entirely; preconditions to revisit are documented in eval-baselines.md §6.

### Next

**Plan:**

- Verify cache hit rate now > 0 (quick `cache-stats.ts` rerun)
- Vercel deploy of /api/ask + /embed; pin `ALLOWED_ORIGINS` and `NEXT_PUBLIC_PARENT_ORIGIN` to production host
- CNAME `ask.zeroindex.ai` → Vercel deploy
- Embed iframe on `zeroindex.ai` between FAQ and Contact (preview HTML is the ready template)
- Launch post: methodology + 90% eval pass rate as the headline number

---

## 8. Testing & evaluation strategy

### Smoke test (`scripts/smoke.ts`)

- Single-shot end-to-end of all 3 cloud services
- Run after `.env.local` changes or any service signup change
- Expected output: 3 OK rows

### Verify (`scripts/verify.ts`)

- Run after `pnpm ingest`
- Confirms chunk count, FTS row count, sample chunks readable, hybrid retrieval returns sensible results for a known good query

### Ask (`scripts/ask.ts`)

- One-off pipeline test against any question
- Prints answer + retrieval/total timing + cited chunk ids
- Use during dev iteration on retrieval and prompt

### Golden Q/A + LLM-as-judge (`evals/`)

Format (`evals/golden.json`):

```json
[
  { "id": "services-list", "question": "...", "must_mention": ["AI"], "must_not_mention": [] }
]
```

Judging rubric (planned):

- **Grounded:** does the answer cite at least one chunk? Did the model only use facts present in retrieved chunks?
- **Mentions:** does the answer mention every `must_mention` term?
- **Avoids:** does the answer avoid every `must_not_mention` term?
- **Concise:** ≤ 3 short paragraphs?

Pass = all 4 dimensions pass for a given question. Aggregate target: ≥ 80%.

### Latency budget

| Stage | p50 target | p95 target |
|---|---|---|
| Vector embed (query) | 200 ms | 500 ms |
| Vector + FTS retrieval | 300 ms | 800 ms |
| Rerank | 400 ms | 800 ms |
| Sub-total (retrieval) | < 1.0 s | < 2.0 s |
| First token from Claude | < 1.0 s | < 2.0 s |
| First token to user | **< 2 s** | **< 4 s** |
| Full answer (≈ 200 tokens) | < 5 s | < 8 s |

Current measured (initial baseline, single sample): retrieval 2.5s, first token 3.8s, total 7.0s. Retrieval is over budget — likely the rerank network hop. Tuned in the later retrieval ablation (see §11).

---

## 9. Deployment & integration plan

### Vercel deployment

```
vercel link            (one-time)
vercel env add ANTHROPIC_API_KEY production
vercel env add VOYAGE_API_KEY production
vercel env add TURSO_DATABASE_URL production
vercel env add TURSO_AUTH_TOKEN production
vercel deploy --prod
```

Region: `iad1` (us-east-1) to match Turso region — keeps DB roundtrip latency tight.

### Widget integration on zeroindex.ai

The website lives at `zeroindex-ai/zeroindexai` and deploys to Cloudflare Workers. Two integration options:

| Option | Pros | Cons |
|---|---|---|
| **Embed snippet** — `<script>` tag pointing at a Vercel-hosted JS bundle that injects an iframe or shadow DOM widget | Decouples deploy cycles; widget bundle independently versioned; doesn't touch website Worker | Cross-origin; CSS isolation work; iframe has sizing quirks |
| **Inline component** — write the widget directly into the website HTML, fetch from `ask.zeroindex.ai/api/ask` | Tighter visual integration; full CSS control; same-origin if subdomain is set up | Couples widget releases to website releases; fetch from Cloudflare Worker → Vercel needs CORS allowlist |

**Shipped:** iframe served from `ask.zeroindex.ai` (CNAME to the Vercel deploy) embedded on `zeroindex.ai` between FAQ and Contact, with postMessage-driven auto-resize. CORS allowlist scoped to the marketing domain.

### Re-ingest workflow

When website copy changes:

```
# from the ask-zeroindex repo root
pnpm ingest
pnpm tsx --env-file=.env.local scripts/verify.ts   # spot check
```

No production deploy required — content lives in Turso, the API just queries it.

Future: webhook from website repo on `main` push → re-ingest job. Out of scope for v1.

---

## 10. Operational runbook

### Local development

```bash
# one-time setup
pnpm install
cp .env.example .env.local                # then fill in 4 values

# daily
pnpm dev                                  # Next dev server on :3000 (Turbopack)
pnpm typecheck                            # tsc --noEmit
pnpm lint                                 # ESLint

# pipeline ops
pnpm ingest                               # rebuild chunks + FTS from website source
pnpm tsx --env-file=.env.local scripts/smoke.ts    # 3-service connection test
pnpm tsx --env-file=.env.local scripts/verify.ts   # post-ingest sanity
pnpm tsx --env-file=.env.local scripts/ask.ts "your question"   # end-to-end test

# eval
pnpm eval                                 # 30-query LLM-as-judge
```

### Environment variables

| Var | Source | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com/settings/keys | Claude Sonnet 4.6 messages API |
| `VOYAGE_API_KEY` | dash.voyageai.com → API Keys | Embeddings + reranker |
| `TURSO_DATABASE_URL` | `turso db show ask-zeroindex --url` | libsql HTTP endpoint |
| `TURSO_AUTH_TOKEN` | `turso db tokens create ask-zeroindex --expiration none` | DB auth |
| `INGEST_SOURCE` (optional) | path to alternate HTML file | Default: `../zeroindexai/index.html` |

### CI / GitHub Actions secrets

The `eval` workflow (`.github/workflows/eval.yml`) needs the same four runtime keys as local dev. Set them as repo secrets:

```bash
# Run from the ask-zeroindex repo root. Values come from .env.local.
gh secret set ANTHROPIC_API_KEY  --body "$(grep ^ANTHROPIC_API_KEY  .env.local | cut -d= -f2-)"
gh secret set VOYAGE_API_KEY     --body "$(grep ^VOYAGE_API_KEY     .env.local | cut -d= -f2-)"
gh secret set TURSO_DATABASE_URL --body "$(grep ^TURSO_DATABASE_URL .env.local | cut -d= -f2-)"
gh secret set TURSO_AUTH_TOKEN   --body "$(grep ^TURSO_AUTH_TOKEN   .env.local | cut -d= -f2-)"
```

Verify with `gh secret list`. The workflow points at the **production** Turso DB (read-only via `hybridSearch`); evals never write. Cost: ~$3/run (30 queries × Sonnet 4.6 input+output, plus 30 judge calls). Pass-rate gate defaults to 80% via `EVAL_PASS_THRESHOLD`; override per workflow run if needed.

### Observability

`/api/ask` emits one structured JSON line per request to `console.log`, which Vercel aggregates into the function logs. Shape:

```json
{
  "event": "ask",
  "ts": "2026-05-09T04:25:00.123Z",
  "model": "claude-sonnet-4-6",
  "question": "what services do you offer?",
  "outcome": "ok",
  "retrievedIds": [42, 17, 9],
  "citationCount": 2,
  "retrievalMs": 412,
  "firstTokenMs": 1180,
  "totalMs": 4730
}
```

`outcome` is one of `ok | retrieval_failed | stream_failed | aborted`. Failure cases include an `errorMessage` field. Query via `vercel logs ask-zeroindex --json | jq 'select(.message | fromjson? | .event == "ask")'` or filter by `event=ask` in the Vercel dashboard. If traffic justifies it later, port this same shape into a Turso `query_logs` table or an external service (Axiom, Logfire) without changing the call sites.

### Common issues

| Symptom | Cause | Fix |
|---|---|---|
| `fts5: syntax error near "?"` | libsql FTS5 doesn't bind `?` in MATCH | Already worked around — `sanitizeFtsQuery` interpolates inline |
| Anthropic 400 "credit balance too low" | Pro subscription ≠ API credits | Add credits at console.anthropic.com/settings/billing |
| `location 'iad' is not valid` | Turso changed location codes to AWS-style | Use `aws-us-east-1` (or omit `--location`, it's default) |
| `turso auth whoami` says not logged in after signup | Browser flow didn't return to terminal cleanly | Run `turso auth login`, stay in terminal until "Success" |
| First push to GitHub: `GH007 publishing private email` | git author email is your private personal email | One-time: rewrite history with `git filter-branch` to use noreply email; set `git config --global user.email "<id>+<login>@users.noreply.github.com"` |

---

## 11. Decision log (running)

| Date | Decision | Why |
|---|---|---|
| 2026-05-03 | Stack: Next + Turso + Voyage + Sonnet 4.6 | Each picked deliberately to balance production readiness with new-territory experience |
| 2026-05-03 | Public repo from day 1 | Repository visibility from scaffold to ship; commits via GitHub noreply email to avoid address leakage |
| 2026-05-05 | Drop-and-rebuild ingest pattern (vs. incremental) | 22 chunks at this scale; full reingest is seconds; not worth incremental complexity |
| 2026-05-05 | FTS query: sanitize + inline (not parameter-bound) | libsql FTS5 binding limitation; sanitization makes inline interpolation injection-safe |
| 2026-05-06 | Server-side streaming citation parser (vs. client-side rendering of raw markers) | Cleaner UX: text events arrive without `[chunk:N]` clutter; citation events arrive structured. Server-side is the right place because we already have the chunk list in scope. |
| 2026-05-06 | Retrieval failure → HTTP 502 (not half-opened SSE error event) | If retrieval fails before the stream opens, a normal HTTP error is more idiomatic and easier for clients to handle than opening an SSE stream just to send a single error frame. |

---

## 12. Known issues & future work

### Known issues from initial baseline

- **Latency over budget** — first-token 3.8s vs 2s target. Likely retrieval (2.5s = embed query + parallel vector/FTS + rerank). Address by measuring each stage; consider warm-keeping the rerank endpoint.
- **Minor synthesis hallucination** — model occasionally infers offering names not literally in context (e.g., "Claude Evals"). To be addressed via tighter system prompt + eval iteration.
- **22 chunks may be too coarse or too fine** — TBD until eval baseline. Adjust `TARGET_CHARS` if chunks are losing topical coherence or ftps are too thin.
- **Sequential INSERTs to Turso** — 22 inserts × ~3s roundtrip = 66s of the 83s ingest time. Switch to `db.batch([...])` API when re-ingest cadence increases.

### Future work

- **Multi-turn conversation** — store previous turns; include in context window. Significant UX upgrade; consider for v2.
- **Refusal handling** — when retrieval is empty or low-relevance, return a polite "I don't have that — here's how to ask Abhi directly" with a `mailto:` rather than guessing. Requires confidence threshold on rerank scores.
- **Real-time content sync** — webhook from website repo `main` push triggers re-ingest. Avoids manual `pnpm ingest`.
- **Analytics** — log questions, retrieved-chunk-id distribution, judge-rated quality. Surfaces what visitors actually want vs. what the site emphasizes.
- **Embedding model upgrade** — voyage-3-large (1024 default, optional 2048) for retrieval lift if eval baseline is borderline.
- **Streaming protocol upgrade** — consider AI SDK's `useChat` if migration friction is low; gives free retry and abort handling.

---

## 13. Cross-references

- **Website repo (RAG content source):** [`zeroindex-ai/zeroindexai`](https://github.com/zeroindex-ai/zeroindexai)
- **This repo:** [`zeroindex-ai/ask-zeroindex`](https://github.com/zeroindex-ai/ask-zeroindex)
