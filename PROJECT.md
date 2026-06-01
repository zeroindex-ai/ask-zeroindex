# ask-zeroindex — Project Documentation

> **Phase:** Production
> **Live:** https://ask.zeroindex.ai (embedded on zeroindex.ai) · **Repo:** github.com/zeroindex-ai/ask-zeroindex

A RAG (Retrieval-Augmented Generation) chat widget for `zeroindex.ai`. Visitors type
questions about ZeroIndex — services, principles, pricing, process, founder background —
and Claude Sonnet 4.6 answers strictly from the site's own content, with chunk-level
citations. Backing API is a Next.js 16 route on Vercel; storage is Turso (libsql) — one
SQLite-compatible DB holding both vector embeddings and a BM25 full-text index. Shipped:
90% pass rate on the 30-query golden set; the retrieval ablation and prompt-caching
decision live in `eval-baselines.md`.

> **Section convention:** every numbered section below is expected. If one genuinely
> doesn't apply, the heading is kept with `— n/a: [reason]` so a reader knows it was
> considered, not forgotten. Family-specific sections (eval-baselines) come after §8.

---

## 1. Why this exists

`ask-zeroindex` makes the zeroindex.ai site interactive: visitors can ask about services,
pricing, principles, or background and get answers grounded in the site's own content
rather than hunting through sections. It also exercises a full production RAG stack
end-to-end — embeddings, hybrid retrieval, reranking, streaming, eval-driven prompt
development. The widget doubles as an honest stress test of the site copy: if Claude
can't answer _"what's your pricing?"_ from the page, the page doesn't either.

### Goals & success criteria

| Goal | How I'll know it's met | Status |
| --- | --- | --- |
| RAG pipeline working end-to-end | Single test query returns grounded answer with citations | ✅ (2026-05-05) |
| 30 golden Q/A baseline | ≥ 80% pass rate on LLM-as-judge | ✅ 90% baseline locked in `eval-baselines.md` |
| First-token latency | p50 < 2s, p95 < 4s | ⏳ open — initial baseline 3.8s |
| Widget live on `zeroindex.ai` | Visitors can ask + get answers | ✅ shipped at `ask.zeroindex.ai`, embedded on the site |
| Abuse protection on the public endpoint | Per-IP rate limiting before any paid-API work | ✅ Turso-backed token bucket in `src/lib/rateLimit.ts` |

**Out of scope (v1):**

- Multi-turn conversation (single Q/A turn only)
- User accounts / chat history persistence
- Voice / multimodal input
- Real-time content sync (re-ingest on site change is manual via `pnpm ingest`)
- Multi-language support (English only)

## 2. Strategic decisions

### Tech stack

| Choice | Why this | Alternative rejected |
| --- | --- | --- |
| Next.js 16 (App Router, src dir, TS, Turbopack) | Mature SSR/edge story, free Vercel deploy; App Router streaming primitives align with the SSE answer flow. Scaffolded with `create-next-app` — no opinionated layer added. | **Pages Router** — App Router is where Next momentum lives; SSE works cleanly with the new Response patterns. |
| Turso (libsql) — vector + FTS in one DB | SQLite-compatible (familiar); native `F32_BLOB(N)` + `vector_top_k()` (no sqlite-vec extension), native FTS5 for BM25. Free tier easily covers this scale. | **Pinecone / Weaviate / Qdrant** — operational complexity; Turso wins on simplicity for low tens of thousands of chunks. Revisit if multi-tenant or > 1M chunks. |
| Voyage-3 embeddings (1024 dim) | Better retrieval quality than OpenAI `text-embedding-3-small` in published benchmarks. Free tier: 200M tokens. | **OpenAI text-embedding-3** — benchmarks favor Voyage; single-vendor diversification away from OpenAI is a small but real value. |
| Voyage rerank-2.5 | Same vendor relationship; designed to pair with Voyage-3; meaningful precision lift over raw vector or BM25 alone. | — |
| Claude Sonnet 4.6 (Anthropic SDK) | Primary model commitment for the ZeroIndex consultancy; strong RAG quality at moderate cost ($3/M in, $15/M out). | — |
| cheerio (HTML parse) | Mature, jQuery-like API, fast enough for static HTML ingest. | — |
| Zod 4 (validation) | TS-first schema validation at the API boundary in `route.ts`. | — |
| vitest · pnpm 10 · Vercel · Node 24 LTS | House defaults; pnpm matches the `mcp-pack` monorepo; Node 24 required by Next 16 (≥ 20.9). | — |

### Key decisions

Non-obvious choices + the alternatives rejected, each with its "why" so it can be
re-litigated later.

- **Hand-rolled pipeline, no LangChain / LlamaIndex** — the pipeline is short (embed,
  store, retrieve, prompt). A heavy framework would obscure what's happening; hand-rolled
  wins on transparency for a learning-oriented project.
- **Thin fetch wrapper, not the Voyage Node SDK** — the REST API is 4 endpoints with
  simple JSON shapes; a thin wrapper gives more control over batching and error handling,
  with zero version-pinning surprises.
- **Hybrid retrieval — vector (top-12) ∪ FTS (top-12) → rerank → top-5.** Vector finds
  semantic matches; FTS finds exact-keyword/proper-noun matches the embeddings sometimes
  miss; the reranker dedupes and re-scores. Empirically hybrid + rerank > either alone.
- **Chunking by section heading (h2, then h3 if present); 1600-char target, 200-char
  overlap when oversized.** Mirrors human authoring intent — headings carry semantic
  boundary signal. Char-based budgeting is good enough for v1; switch to token-counted
  budgeting if eval shows boundary issues.
- **Citations as `[chunk:N]` markers in the streamed text** — a simple format the model
  already produces; a client-side parser substitutes them for rendered citation chips. No
  structured tool calls needed at this scale.
- **SSE (Server-Sent Events), not WebSockets** — native browser support, works through
  CDNs cleanly, simpler for a one-way stream.
- **No prompt caching** — `cache_control` was tried and removed. At this corpus scale the
  two-block (system + context) shape produced an asymmetric pattern (`cache_creation`
  written every call, `cache_read` never set) — a net 1.25× cost _penalty_. Preconditions
  to revisit are in `eval-baselines.md` §6.
- **Drop-and-rebuild re-ingest (not incremental)** — at ~22 chunks per ingest of
  zeroindex.ai a full reingest takes seconds; not worth incremental complexity until
  content scale justifies it.
- **Deliberately NOT chosen:** React Server Components for the widget (it's interactive —
  input + streaming output — so a client component is the right primitive); no auth
  framework (this is a public read endpoint, no `/admin`).

## 3. Architecture

```
zeroindex.ai (Astro on Vercel)
  └─ embed snippet → iframe widget (served from ask.zeroindex.ai/embed)
        │  POST /api/ask { question }
        │  ← SSE: chunks → text* → citation* → done
        ▼
Next.js 16 on Vercel (region iad1, free tier)
  src/app/api/ask/route.ts (SSE)
        ├─ hybridSearch ─ vector_top_k + FTS5 MATCH → rerank-2.5
        └─ answer ─────── Claude Sonnet 4.6 (streaming)
        │                 │                    │
        ▼                 ▼                    ▼
  Turso aws-us-east-1   Voyage AI            Anthropic API
  ask-zeroindex.db      (embed + rerank)     (Messages API)
   ├ chunks (F32_BLOB)
   ├ chunks_fts (FTS5)
   └ idx_chunks_vec
```

**Topology.** A static Astro marketing site embeds a chromeless iframe served from this
app's `/embed` route. The iframe POSTs questions to `/api/ask` and renders the SSE stream.
The route is the only stateful surface: it gates on origin + a Turso-backed rate limiter,
runs hybrid retrieval, then streams a Claude answer. Three external services sit behind
it — Turso (the only persistent store), Voyage (embeddings + rerank, stateless REST), and
Anthropic (generation). Vercel function region `iad1` colocates with Turso's
`aws-us-east-1` (same geography, different vendor naming) so DB roundtrips stay tight.

**Query flow.** `hybridSearch(question, topK=5)` embeds the query (Voyage-3), runs
`vector_top_k(idx_chunks_vec, ?, 12)` and an FTS5 `MATCH` (bm25 top-12) in parallel, unions
by chunk id (dedupe), then `rerank(query, candidates, topK=5)` via Voyage rerank-2.5.
`answer()` streams from Anthropic with a system prompt + a `Context: [chunk:N] …` block
(neither carries `cache_control` — see `eval-baselines.md` §6) + the user question. The
route frames the stream as SSE: a `chunks` event (all retrieved ids) first, then `text`
deltas (markers stripped), `citation` events as new chunks are referenced, and a final
`done` carrying the full citations array.

**Ingest flow** (`scripts/ingest.ts`, run on content change): load
`../zeroindex-site/dist/index.html` (or `$INGEST_SOURCE`) → `cheerio.load` → strip
script/style/nav/header/footer → walk `<section>` elements (h1/h2 = section name,
h3-bounded body = chunks) → split oversized chunks (>1600 chars, 200-char overlap) →
batch-embed via Voyage-3 (up to 128 inputs/call) → `DELETE FROM chunks` then `INSERT …
vector32(embedding)` inside one atomic write transaction → `INSERT INTO
chunks_fts(chunks_fts) VALUES('rebuild')`.

## 4. Public contract

The stable surface the embed widget (and any future consumer) depends on.

### `POST /api/ask`

- **Request body** (Zod, `route.ts:Body`): `{ question: string }` — `min(1).max(500)`.
  Hard byte cap of 4096 (`MAX_BODY_BYTES`) checked before parse.
- **Auth / origin:** origin-allowlisted via `ALLOWED_ORIGINS` (empty = allow all, dev
  default; production pins to the embed host). Disallowed origin → `403 forbidden_origin`.
  In production an empty allowlist is a startup error.
- **Rate limit:** per-client Turso token bucket (`rateLimit.ts`) — capacity 10, refill
  10/60 per sec (≈ 10 req/min). Key = first `x-forwarded-for` IP + a sha256(UA+lang) digest.
  Over limit → `429`.
- **Errors:** `413 payload_too_large` · `400 invalid_json` · `400` (Zod validation) ·
  `502` (retrieval failed before the stream opens — a normal HTTP error, not a half-opened
  SSE stream).
- **Success:** `200`, `Content-Type: text/event-stream`,
  `Cache-Control: no-cache, no-transform`, body = the SSE protocol below.
- **`OPTIONS /api/ask`** — CORS preflight; `204` with allow headers, or `403` on
  disallowed origin.

### SSE event protocol

```
event: chunks      data: [<chunkId>, ...]              // first; all retrieved ids
event: text        data: "<text delta>"                // many; [chunk:N] markers stripped
event: citation    data: { chunkId, section, quote }   // one per unique cited chunk, inline
event: done        data: { citations: [...] }          // last; full citations array
event: error       data: { message }                   // only on a mid-stream failure
```

- A `Citation` is `{ chunkId, section, quote }` — `quote` is the first 160 chars of the
  chunk content with an ellipsis. `sourcePath` is **deliberately excluded** from the client
  payload (it leaked the local ingest path); the internal `RetrievedChunk` keeps it
  server-side only (see `src/lib/types.ts`).
- The citation parser extracts `[chunk:N]` markers from a rolling buffer, strips them from
  `text` deltas, and tail-flushes at end of stream (an unmarked trailing `[` becomes literal
  text). A try/catch around the stream loop emits an `error` event on
  Voyage/Anthropic/Turso mid-stream failures.

## 5. Data model

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

(A separate rate-limit table is provisioned by `scripts/migrate-rate-limit.ts` for the
token bucket in `src/lib/rateLimit.ts`.)

**Why `F32_BLOB(1024)`:** Voyage-3's default embedding dimensionality is 1024. The schema
is bound to this; switching models requires a migration (drop the column + index, re-ingest).

**Why `content='chunks'` FTS:** the FTS table is a shadow index — all content lives in
`chunks`. Saves storage and avoids drift, at the cost of a manual rebuild after bulk inserts
(no auto-sync triggers).

## 6. Project structure

```
ask-zeroindex/
├── src/
│   ├── app/
│   │   ├── (site)/                 chromed route group (header/footer)
│   │   │   ├── layout.tsx          canonical ZeroIndex subdomain chrome
│   │   │   └── page.tsx            standalone widget page (ask.zeroindex.ai)
│   │   ├── embed/page.tsx          chromeless iframe route, postMessage auto-resize
│   │   ├── api/ask/route.ts        POST endpoint, Zod validation, SSE streaming
│   │   ├── layout.tsx              root layout (metadata, globals.css import)
│   │   ├── globals.css             Tailwind 4 base + design tokens
│   │   └── favicon.ico             app-router favicon (Next 16 serves from app/)
│   ├── components/
│   │   ├── AskWidget.tsx           client widget (input, streaming output, citation chips)
│   │   └── AskIntro.tsx            shared Ask section copy (standalone + embed surfaces)
│   └── lib/
│       ├── db.ts                   lazy Turso client singleton + initSchema() + EMBEDDING_DIM
│       ├── embeddings.ts           Voyage REST: embedDocuments / embedQuery / rerank
│       ├── retrieval.ts            vectorSearch + ftsSearch + hybridSearch (with rerank)
│       ├── claude.ts               Anthropic client; SYSTEM_PROMPT; answer() (streaming, no cache)
│       ├── citationParser.ts       streaming [chunk:N] marker extraction / stripping
│       ├── sse.ts                  SSE event framing helpers
│       ├── rateLimit.ts            Turso-backed atomic token-bucket per-IP limiter
│       ├── logAsk.ts               structured JSON log + optional trace-pack dual-write
│       ├── env.ts                  validated env-var access
│       ├── errors.ts               typed error helpers
│       ├── models.ts               model id constants (answer/embeddings/rerank)
│       ├── sourcePath.ts           source-path normalization for citations
│       └── types.ts                Chunk, RetrievedChunk, Citation, AnswerResponse
├── scripts/                        operational + research tsx scripts
│   ├── ingest.ts                   HTML → chunks → embeddings → Turso → FTS rebuild
│   ├── smoke.ts                    3-service connection test (Anthropic, Voyage, Turso)
│   ├── verify.ts                   post-ingest sanity (counts + sample + retrieval)
│   ├── ask.ts                      end-to-end question → grounded answer w/ timing
│   ├── list-chunks.ts              dump stored chunks for inspection
│   ├── ablate.ts                   retrieval ablation (recall@K + latency by mode)
│   ├── cache-stats.ts              per-query prompt-cache token instrumentation
│   ├── cache-repro.ts              minimal repro of the cache-asymmetry investigation
│   ├── migrate-rate-limit.ts       one-off rate-limit table migration
│   └── _run.ts                     shared script bootstrap (env load + db teardown)
├── evals/
│   ├── golden-seed.json            30 hand-labeled Q/A pairs with must_mention assertions
│   └── run.ts                      LLM-as-judge harness (via @zeroindex-ai/eval-pack)
├── preview/embed-preview.html      local iframe-embed preview template
├── data/                           source content drop-zone (.gitkeep; reads sibling site repo)
├── public/                         static assets (favicons, og-image)
├── .env.example                    template
├── eval-baselines.md               retrieval ablation + prompt-caching decision record
├── AGENTS.md / CLAUDE.md           agent operating guide
└── PROJECT.md                      this document
```

## 7. Distribution

Ships as `ask.zeroindex.ai` on Vercel (CNAME → the Vercel deploy; DNS-only at Cloudflare),
backed by the production Turso DB, via the `deploy-zeroindex-vercel-app` skill. The widget
is an iframe served from `/embed`, embedded on `zeroindex.ai` (the `zeroindex-site` Astro
repo) between FAQ and Contact, with postMessage-driven auto-resize and a CORS allowlist
scoped to the marketing domain. Optional dual-write to **trace-pack**
(`github.com/zeroindex-ai/trace-pack`) for observability — see the config table.

**Re-ingest** (no prod deploy needed — content lives in Turso, the API just queries it):

```bash
pnpm ingest                                          # rebuild chunks + FTS
pnpm tsx --env-file=.env.local scripts/verify.ts     # spot check
```

Milestone history: built + shipped over 2026-05-05 → 2026-05-09 (scaffold → ingest
pipeline → SSE API + streaming citation parser → widget UI → retrieval ablation + cache
instrumentation → LLM-as-judge eval + system-prompt iteration → Vercel deploy + embed +
CNAME + eval CI gate). The detailed build diary lived here previously and is now in git
history; the durable findings are in `eval-baselines.md` and §2 above.

### Configuration

| Env var | Required? | Purpose / default |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Claude Sonnet 4.6 Messages API. `console.anthropic.com/settings/keys`. |
| `VOYAGE_API_KEY` | yes | Voyage-3 embeddings + rerank-2.5. `dash.voyageai.com`. |
| `TURSO_DATABASE_URL` | yes | libsql HTTP endpoint. `turso db show ask-zeroindex --url`. |
| `TURSO_AUTH_TOKEN` | yes | DB auth. `turso db tokens create ask-zeroindex --expiration none`. |
| `ALLOWED_ORIGINS` | prod | Comma-separated origins allowed to POST `/api/ask`. Empty = allow all (dev); empty in prod is a startup error. Include `null` for `file://` previews. |
| `NEXT_PUBLIC_PARENT_ORIGIN` | prod | Target origin for the `/embed` iframe's postMessage. Empty = `*` (dev); pin to the host in prod. |
| `INGEST_SOURCE` | no | Alternate HTML file for ingest. Default: `../zeroindex-site/dist/index.html`. |
| `TRACE_PACK_URL` · `TRACE_PACK_TOKEN` | no | Enable dual-write to trace-pack; each `/api/ask` emission also POSTs to `{URL}/api/ingest` (fire-and-forget). |
| `TRACE_PACK_SOURCE` | no | Override the `source` field on the emitted payload (default `ask-zeroindex`). |

> No `ADMIN_PASSWORD` / `/admin` — this app has no admin surface (read-only public endpoint).

CI: the `eval` workflow (`.github/workflows/eval.yml`) needs the same four runtime keys
as repo secrets; it points at the **production** Turso DB read-only (evals never write).
Cost ~$3/run (30 queries × Sonnet input+output + 30 judge calls). Pass-rate gate defaults
to 80% via `EVAL_PASS_THRESHOLD`.

## 8. Testing & evaluation

**Operational scripts** (run via `pnpm tsx --env-file=.env.local scripts/<name>.ts`):

- `smoke.ts` — single-shot end-to-end of all 3 cloud services; expect 3 OK rows. Run
  after `.env.local` or service-signup changes.
- `verify.ts` — run after `pnpm ingest`; confirms chunk count, FTS row count, sample
  chunks readable, hybrid retrieval sensible for a known-good query.
- `ask.ts "<question>"` — one-off pipeline test; prints answer + retrieval/total timing +
  cited chunk ids. Use during retrieval/prompt iteration.

**Unit tests** (`pnpm test`, vitest) cover `logAsk` (the trace-pack dual-write contract),
the rate limiter, and the citation parser. `pnpm build` is the CI gate.

**Golden Q/A + LLM-as-judge** (`evals/`, `pnpm eval`) — the quality contract. Format
(`evals/golden-seed.json`): `[{ "id", "question", "must_mention": [...], "must_not_mention": [...] }]`.
30 hand-labeled items across 4 categories (19 positive · 6 negative · 3 adversarial · 2
multi-part). `evals/run.ts` runs the full pipeline per query, applies programmatic checks
(must_mention / must_not_mention / citation_ok), then a Claude Sonnet 4.6 judge returning
`{ appropriate, grounded, reason }`. A query passes when grounded + mentions + avoids +
concise all hold; aggregate target ≥ 80%.

**Headline metric:** **90%** (27/30) on the 30-query set; **97%** (29/30) after 2 trivial
post-baseline label fixes; real-only failure rate 1/30 (a multi-part coverage gap on a
2-item sample). The retrieval ablation (recall/latency by mode) and the full eval
breakdown live in `eval-baselines.md`. Metrics (recallAtK, percentile, p50, p95) graduated
into the published `@zeroindex-ai/eval-pack`, which this repo now consumes.

**Latency budget** (targets):

| Stage | p50 | p95 |
| --- | --- | --- |
| Vector embed (query) | 200 ms | 500 ms |
| Vector + FTS retrieval | 300 ms | 800 ms |
| Rerank | 400 ms | 800 ms |
| Sub-total (retrieval) | < 1.0 s | < 2.0 s |
| First token from Claude | < 1.0 s | < 2.0 s |
| **First token to user** | **< 2 s** | **< 4 s** |
| Full answer (≈ 200 tokens) | < 5 s | < 8 s |

Initial baseline (single sample): retrieval 2.5s, first token 3.8s, total 7.0s — retrieval
over budget (likely the rerank network hop). See `eval-baselines.md` for the tuned numbers.

---

## Ordered work list

Ordered, not calendared. Build + ship are complete; remaining items below.

- [x] Scaffold + Turso schema + ingest pipeline + Voyage embeddings + hybrid retrieval
- [x] SSE API + streaming citation parser; widget UI (input, streaming, citation chips)
- [x] Retrieval ablation + prompt-caching investigation
- [x] 30-query golden set + LLM-as-judge; 90% pass-rate baseline
- [x] Vercel deploy, CNAME, embed on zeroindex.ai, eval CI gate (per-PR + nightly)
- [ ] Close the first-token latency budget (measure each stage; warm-keep rerank)
- [ ] Refusal handling on empty/low-relevance retrieval (rerank-score confidence threshold)
- [ ] Real-time content sync (webhook from website `main` push → re-ingest)

## Decision log (running)

Newest first. Every entry dated.

- **2026-05-06** — Retrieval failure → HTTP 502, not a half-opened SSE error event. A
  normal HTTP error before the stream opens is more idiomatic and easier for clients.
- **2026-05-06** — Server-side streaming citation parser (vs. client-side rendering of raw
  markers). Cleaner UX: `text` events arrive without `[chunk:N]` clutter, citations arrive
  structured; server-side is the right place since the chunk list is already in scope.
- **2026-05-05** — FTS query: sanitize + inline, not parameter-bound. libsql FTS5 won't
  bind `?` in `MATCH`; sanitization (strip non-word chars, quote each token, OR-join) makes
  inline interpolation injection-safe. `LIMIT` stays parameter-bound.
- **2026-05-05** — Drop-and-rebuild ingest (vs. incremental). 22 chunks; full reingest is
  seconds; not worth incremental complexity.
- **2026-05-03** — Public repo from day 1. Commits via GitHub noreply email to avoid
  address leakage.
- **2026-05-03** — Stack: Next + Turso + Voyage + Sonnet 4.6. Each picked to balance
  production readiness with new-territory experience (see §2).

## Known constraints & future work

- **First-token latency over budget** — initial baseline 3.8s vs 2s target; likely the
  retrieval path (embed query + parallel vector/FTS + rerank). Fix: measure each stage,
  consider warm-keeping the rerank endpoint.
- **Minor synthesis hallucination** — the model occasionally infers offering names not
  literally in context (e.g. "Claude Evals"). Addressed via tighter system prompt + eval
  iteration; track via the golden set.
- **Sequential INSERTs to Turso** — ~22 inserts × ~3s roundtrip dominate ingest wall-clock.
  They now run inside one atomic write transaction (`ingest.ts`), so a mid-pipeline failure
  can't leave the table partial; only per-insert latency remains. Could batch via
  `db.batch([...])` if re-ingest cadence increases.
- **Chunk granularity** — 22 chunks may be too coarse or fine; adjust the 1600-char target
  if chunks lose topical coherence or get too thin.
- **Deferred (v2 candidates):** multi-turn conversation (store + include prior turns);
  refusal handling on low-relevance retrieval; real-time content sync via webhook;
  analytics (question + retrieved-chunk distribution + judge-rated quality);
  voyage-3-large embedding upgrade for a retrieval lift; AI-SDK `useChat` streaming
  protocol (free retry/abort) if migration friction is low.

## User personas

- **zeroindex.ai visitor / prospect** — wants a fast, grounded answer to "what do you do /
  what does it cost / who's behind this" without scrolling the page. Values an honest
  refusal over a confident guess; the widget must cite its sources and decline when the
  content doesn't cover the question.

## Cross-references

- **Website (RAG content source):** [zeroindex.ai](https://zeroindex.ai) — Astro site,
  source in the private `zeroindex-site` repo (also home of `STYLE_GUIDE.md` design tokens).
- **Observability sink:** [trace-pack](https://github.com/zeroindex-ai/trace-pack) — optional
  `/api/ingest` dual-write target (live at `traces.zeroindex.ai`).
- **Eval library:** `@zeroindex-ai/eval-pack` — the metrics harness this repo consumes.
- **Eval detail:** `eval-baselines.md` — retrieval ablation + the prompt-caching decision.
- **This repo:** [`zeroindex-ai/ask-zeroindex`](https://github.com/zeroindex-ai/ask-zeroindex).
