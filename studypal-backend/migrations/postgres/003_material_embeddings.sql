-- StudyPal material embeddings — PostgreSQL + pgvector.
--
-- The third migration of the PostgreSQL era (SP-V2-004). Turns the chunks that
-- 002 persists into something searchable: one embedding vector per chunk, stored
-- in the same row, plus the indexing lifecycle that says whether a material's
-- vectors are actually there.
--
-- Applied by `npm run migrate` (scripts/migrate.mjs), inside a transaction, once.
-- Forward-only: there is no down migration. See docs/database-architecture.md.
--
-- 002 predicted this would be "a pure ADD COLUMN plus an index". It is the ADD
-- COLUMN; the index is deliberately NOT here, and the reasoning is in the index
-- section at the bottom.
--
-- REQUIRES pgvector. compose.yaml pulls pgvector/pgvector:pg16 for exactly this
-- reason — the official `postgres` image does not ship the extension, and this
-- migration is where that stops being optional. On a managed provider, pgvector
-- has to be available (Neon, Supabase and RDS all offer it) or this fails at
-- CREATE EXTENSION with `could not open extension control file`, which is the
-- correct place to fail: loudly, at deploy time, before any code expects a
-- vector column to exist.

-- ── the extension ────────────────────────────────────────────────────────────
--
-- IF NOT EXISTS because a managed database may already have it enabled, or an
-- operator may have run it by hand; this migration must be applicable either
-- way. No schema is specified, so it lands in the search path's first schema
-- (`public` here) — matching how everything else in this database is addressed.
--
-- This is DDL inside the migration runner's transaction, which is fine:
-- CREATE EXTENSION is transactional in PostgreSQL, so a later failure in this
-- file rolls the extension back with everything else. (That is not true of
-- ALTER TYPE ... ADD VALUE, which is one of the reasons 001 chose CHECK
-- constraints over ENUMs — see the status column in 002.)
CREATE EXTENSION IF NOT EXISTS vector;

-- ── material_chunks.embedding ────────────────────────────────────────────────
--
-- The chunk's embedding, or NULL when it has not been generated yet. NULL is a
-- real and expected state, not a defect: chunks exist the moment 002's pipeline
-- persists them, and embedding happens afterwards over the network. A NOT NULL
-- column would force the two to share a transaction, which §41 explicitly
-- forbids — no database transaction may be held open across a Gemini call.
--
-- DIMENSION: 1536, and it must match the embedding model exactly. The model is
-- `gemini-embedding-001` requested with outputDimensionality: 1536, configured
-- in src/config/env.js (STUDYPAL_EMBEDDING_MODEL / STUDYPAL_EMBEDDING_DIM) and
-- asserted against this column by tests/materials/embeddings.test.js. Three
-- things pinned it:
--
--   1. The model's native size is 3072, and it is Matryoshka-trained, so 1536 is
--      a supported truncation rather than a lossy hack — MTEB moves 68.2 → 68.17.
--   2. pgvector's ANN indexes (HNSW, IVFFlat) refuse a `vector` wider than 2000
--      dimensions. Storing 3072 here would permanently foreclose indexing this
--      column without re-embedding every chunk in the corpus. 1536 keeps that
--      door open at negligible cost, which is the whole argument.
--   3. Half the storage and half the distance arithmetic of 3072, for a corpus
--      where recall is dominated by chunking, not by embedding width.
--
-- Truncated gemini-embedding-001 output is NOT unit-length — Google's own
-- documentation says normalization is the caller's job below 3072 — so
-- src/ai/embedding.service.js L2-normalizes before anything reaches this column.
-- That matters here because cosine distance on a non-normalized vector is still
-- computed correctly by pgvector, but `<#>` (inner product) and any future
-- switch to it would silently reward long vectors. Normalizing once, on write,
-- makes the stored representation independent of which operator queries it.
--
-- IF THE MODEL EVER CHANGES: vectors from two different models are not
-- comparable, and neither are two different dimensionalities of the same model.
-- Changing either means a new migration that clears this column and a re-index
-- of every chunk — not a config edit. docs/rag-architecture.md says so too.
ALTER TABLE material_chunks
  ADD COLUMN embedding vector(1536);

-- ── materials.indexing_status ────────────────────────────────────────────────
--
-- A SECOND lifecycle column, deliberately, rather than new values in `status`.
--
-- 002's `status` means "the document was successfully parsed, chunked and
-- persisted", and `ready` is the word the API already gives clients for that.
-- Embedding is a distinct operation with a distinct failure mode: it needs a
-- Gemini API key, network access and quota, none of which extraction needs. A
-- material can therefore be perfectly readable and not yet searchable, and there
-- is no honest single word for that.
--
-- The alternative — adding `embedding`/`indexed` to `status` — was rejected
-- because it silently redefines `ready` to mean less than it currently does
-- (SP-V2-004 §7 warns about exactly this). Every existing test, the CHECK
-- constraint above it, and every client that reads `status === 'ready'` would
-- keep working while quietly meaning something different. Two orthogonal
-- columns cannot lie that way: `ready` still means parsed, `indexed` means
-- searchable, and a failed embedding leaves a material `ready` + `failed`
-- rather than destroying the evidence that extraction succeeded.
--
--   pending   chunks exist, no embeddings generated yet — NOT searchable
--   indexing  embedding is in flight
--   indexed   every chunk of this material has an embedding — searchable
--   failed    embedding gave up; indexing_error says why, safely
--
-- DEFAULT 'pending' rather than NOT NULL DEFAULT with a backfill: every existing
-- material row genuinely is un-indexed at the moment this migration runs, so
-- 'pending' is the true value for all of them, and the default makes the ALTER a
-- metadata-only operation on PostgreSQL 11+.
ALTER TABLE materials
  ADD COLUMN indexing_status TEXT NOT NULL DEFAULT 'pending';

-- Why indexing failed, in the sanitised form the API is willing to show a
-- client. Kept separate from `error_message` so an extraction failure and an
-- embedding failure cannot overwrite each other, and so the CHECK below can be
-- stated without entangling the two lifecycles.
--
-- Provider errors NEVER land here verbatim (§32): src/materials/ writes a fixed
-- safe message and logs the real cause server-side. A Gemini error body can
-- contain the request, the model name and quota details; some of that is
-- diagnostic, none of it is the client's business.
ALTER TABLE materials
  ADD COLUMN indexing_error TEXT;

ALTER TABLE materials
  ADD CONSTRAINT materials_indexing_status_valid
    CHECK (indexing_status IN ('pending', 'indexing', 'indexed', 'failed'));

-- The same invariant materials_error_message_matches_status enforces for
-- extraction, for the same reason: a failure must carry a reason and a success
-- must not carry a stale one. Without this, a material that failed embedding,
-- was re-indexed successfully, and had its status updated but not its error
-- would report `indexed` with an error message attached.
ALTER TABLE materials
  ADD CONSTRAINT materials_indexing_error_matches_status CHECK (
    (indexing_status = 'failed' AND indexing_error IS NOT NULL)
    OR (indexing_status <> 'failed' AND indexing_error IS NULL)
  );

-- Bounded for the same reason materials_original_filename_bounded exists: the
-- application writes one of a handful of fixed strings, so a 4 KB value here
-- would mean a code path that skipped the sanitiser.
ALTER TABLE materials
  ADD CONSTRAINT materials_indexing_error_bounded
    CHECK (indexing_error IS NULL OR char_length(indexing_error) <= 500);

-- ── indexes ──────────────────────────────────────────────────────────────────
--
-- NO VECTOR INDEX. This is a decision, not an omission, and SP-V2-004 §12 asks
-- for it to be documented rather than defaulted.
--
-- pgvector offers two approximate-nearest-neighbour index types, HNSW and
-- IVFFlat. Both trade recall for speed: they return *probably* the nearest
-- neighbours. Without either, pgvector does an exact scan — every candidate row,
-- perfect recall, always the true top-K.
--
-- Exact is the right default here, on three counts:
--
--   1. RECALL IS THE PRODUCT. This endpoint answers a student's question from
--      their own uploaded notes. A missed chunk is a wrong answer, or a
--      "your materials do not cover this" for material that does cover it. An
--      ANN index would trade the one property the feature is built on for
--      latency the feature does not yet need.
--   2. THE FILTER DOES THE WORK, NOT THE INDEX. Every retrieval query is
--      constrained to one user, and often to one material (§15) — see
--      src/materials/retrieval.repository.js. That leaves tens to low thousands
--      of candidate rows, which is a fast scan. An ANN index, by contrast, is
--      built over the *whole* table and searched before the user filter is
--      applied, so at this scale it can return fewer than K rows for the user
--      after filtering while also being less accurate. Filtered ANN is a known
--      hard problem; exact search simply does not have it.
--   3. AN INDEX HAS TO EARN ITS COST. 001 and 002 both set the rule that an
--      index exists to serve a query in the code today, and
--      tests/materials/schema.test.js asserts the exact index list on these
--      tables — so this file adding one would fail a test and demand a
--      justification. There is no justification yet.
--
-- WHEN TO REVISIT: when a single user's chunk count reaches the tens of
-- thousands, or when EXPLAIN ANALYZE on the retrieval query shows the vector
-- scan dominating a request. The migration at that point is:
--
--   CREATE INDEX idx_material_chunks_embedding
--     ON material_chunks USING hnsw (embedding vector_cosine_ops);
--
-- `vector_cosine_ops` and not `vector_l2_ops` or `vector_ip_ops`: the opclass
-- must match the operator the query uses, or the index is ignored. Retrieval
-- uses `<=>` (cosine distance) — see retrieval.repository.js — so the cosine
-- opclass is the only one that would apply. Note also that 1536 dimensions is
-- what makes that statement legal at all; see the embedding column above.
--
-- Also NOT added: an index on materials.indexing_status. The only query that
-- filters on it is scoped to a single material by primary key, so a
-- single-column index on a four-value column would never be chosen.

-- ── comments ─────────────────────────────────────────────────────────────────
--
-- Kept in the database so `\d+ material_chunks` in psql explains the vector
-- column without anyone having to find this file. Note that 002's comment on
-- material_chunks ends with "Embeddings are deferred to SP-V2-004" — replaced
-- here, because a comment that describes the previous migration's state of the
-- world is worse than no comment.
COMMENT ON TABLE material_chunks IS
  'Retrieval-ready text extracted from a material, with its embedding. Deterministic: same bytes plus same config produce the same chunks.';
COMMENT ON COLUMN material_chunks.embedding IS
  'gemini-embedding-001 at 1536 dimensions, L2-normalized, cosine distance. NULL until indexed. Changing model or dimension requires re-embedding every chunk.';
COMMENT ON COLUMN materials.indexing_status IS
  'pending → indexing → indexed, or → failed. Separate from `status`: `ready` means parsed, `indexed` means searchable. A material can be one without the other.';
COMMENT ON COLUMN materials.indexing_error IS
  'Why embedding failed, sanitised for a client. Provider error text is logged server-side and never stored here.';
