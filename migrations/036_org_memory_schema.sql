-- =============================================================================
-- Migration:      036_org_memory_schema.sql
-- Date:           2026-05-28
-- Task:           org-memory Phase-3 PR-1' (analyst Walter, task_1779931361228)
--
-- Purpose:
--   Lay the schema floor for per-tenant + per-subtenant organizational memory:
--   a relational-graph (entities + relationships) co-located with a pgvector
--   facts table, all scoped + RLS-isolated to (org_id, subtenant_id) on the
--   request path. This is the evolution of `entity_mappings` (migration 017)
--   into a maintained knowledge graph: entities already had cross-vendor
--   IDENTITY; this migration adds the EDGES + temporal/vector FACTS the
--   existing table lacks. The accretion worker (PR-2) writes; the unified-
--   router consult hook (PR-3) reads. Memory is ADDITIVE, never gates a call.
--
-- This is the RELATIONAL-GRAPH form (Phase-3 PR-1', the version that
-- shipped). The AGE-graph form (PR #281, branch feat/org-memory-schema)
-- is parked as a future-state asset for the day Azure FS PG opens
-- runtime library access for the `age` extension. Empirical evidence
-- from forge's staging-run on mcpgw-staging-pg:
--   azure.extensions=AGE                ✓
--   shared_preload_libraries=age        ✓ (restart confirmed)
--   CREATE EXTENSION age                ✓ (ag_catalog populated, 345 fns)
--   LOAD 'age' / create_graph()         ✗ ERROR: access to library "age" is not allowed
-- A third undocumented Azure-FS gating layer beyond the documented
-- allowlist + SPL pair blocks AGE function execution. Azure support
-- ticket is in flight; in the meantime Phase-3 proceeds on the
-- swappable-relational-graph fallback designed for exactly this branch.
--
-- Architecture references:
--   - deliverables/conduit-org-memory-architecture-proposal-2026-05-28.md
--     (Phase-1, Aaron-approved — §10 flagged AGE×Azure as the load-bearing
--      unknown; §8 specced robust-either-way)
--   - deliverables/conduit-org-memory-prototype-design-2026-05-28.md
--     §5 (swappable-store-behind-TS-interfaces — the seam that makes
--      this flip zero-rework for PR-2/PR-3) + §6 (the relational-graph
--      schema specced exactly so this contingency was ready)
--   - PR #281 (AGE-form migration parked DO-NOT-MERGE)
--
-- Architectural-equivalence with the AGE form (so the swap is genuinely
-- zero-rework for PR-2 + PR-3, only the store impl behind §5 changes):
--   - entities: AGE Entity vlabel        → orgmem_entities (plain table)
--   - edges:    AGE RELATED_TO elabel    → orgmem_edges    (FK-linked table)
--   - facts:    orgmem_facts + pgvector  → UNCHANGED (was always relational)
--   - RLS:      ENABLE+FORCE + conduit_request + (app.org_id, app.subtenant_id)
--               GUC pattern — IDENTICAL shape, STRICTLY SIMPLER clauses
--               (column-form `org_id = current_setting(...)` instead of
--                agtype-quoted-key `properties->>'"org_id"' = ...`)
--   - Index-Scan: standard B-tree on (org_id, lower(canonical_name))
--                 instead of functional-on-agtype — same target, simpler shape
--   - UPSERT:   INSERT ... ON CONFLICT DO UPDATE keyed on the canonical-key
--               unique index — the canonical key is part of the MATCH
--               (defence-by-construction: missing-key cannot reach the
--                upsert path by structural impossibility; same shape as
--                the AGE-form MERGE-on-keys-in-match-pattern)
--
-- =============================================================================
-- RLS model (mirrors the existing per-tenant/subtenant tenancy)
-- =============================================================================
--
-- All org-memory rows are scoped by (org_id, subtenant_id) where
-- subtenant_id may be NULL for org-level (no subtenant scope). The runtime
-- sets two session GUCs at the start of each request:
--
--     SET app.org_id       = '<org_id>';
--     SET app.subtenant_id = '<subtenant_id-or-empty>';
--
-- Existing Conduit runtime already sets `app.org_id` for the request path
-- (proven by the vendor-registry RLS work). `app.subtenant_id` is the
-- on-prem-decided subtenant scope available in unified-router at the
-- pre-fetch point (`onpremDecision.subtenantId`).
--
-- The policies USE current_setting('app.org_id', true) and
-- current_setting('app.subtenant_id', true) with `missing_ok=true` so an
-- unset GUC returns NULL — which then never matches a row (deny-by-
-- default for the request path). System-path code that needs to read
-- across orgs runs as a BYPASSRLS role (e.g. the migration owner /
-- gatewayadmin); the request-path role `conduit_request` is NOBYPASSRLS.
--
-- The COALESCE(NULL,'') = COALESCE(NULL,'') idiom on subtenant_id matches
-- "row has no subtenant (NULL) AND GUC unset/empty" (org-level rows) —
-- strict isolation: org-level entities are visible only in the org-level
-- request context, never bleeding to a subtenant context and vice versa.
--
-- =============================================================================
-- Three-line silent-failure defence (data-dependent RLS discipline)
-- =============================================================================
--
-- Whenever an RLS USING/WITH CHECK clause reads the tenant key FROM THE
-- ROW ITSELF (as here), a missing-or-wrong tenant key = row invisible to
-- its own owner = worst silent-failure mode. This migration provides
-- LINE 2 (schema backstop) and LINE 3 (positive-visibility regression
-- via the canonical-key unique index that the UPSERT keys on):
--
--   LINE 1 (writer-guard):    enforced in PR-2's accretion worker
--                             (pre-MERGE guard rejects missing-key jobs)
--   LINE 2 (schema-WITH CHECK): the policies below — even a bypassed
--                             writer cannot land an orphan row
--   LINE 3 (canonical-key uniq): the unique index that the UPSERT
--                             ON CONFLICT clause matches against — the
--                             canonical key is part of the MATCH so a
--                             missing-key upsert is structurally
--                             unreachable (construction>discipline)
--
-- PR-2's tests assert each line independently (the regression triple
-- in the PR-2 design doc §8).
--
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Extensions
-- ---------------------------------------------------------------------------

-- pgvector (semantic-fact embeddings on orgmem_facts). Required by both
-- this PR-1' (relational) and PR #281 (AGE-form, parked); a pre-merge
-- forge-verification confirmed `CREATE EXTENSION vector` succeeds on
-- Azure FS PG v16 with `azure.extensions=VECTOR`. The AGE extension
-- (parked PR #281) is intentionally not created here.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- 2. orgmem_entities — the entity vertex table (relational form)
-- ---------------------------------------------------------------------------
--
-- Replaces the AGE `Entity` vlabel from the parked PR #281. Same shape,
-- just stored as plain columns. The cross-vendor identity that
-- `entity_mappings` (migration 017) provides is preserved + extended:
-- `vendor_ids` carries the same {vendor_slug: vendor_entity_id} map,
-- and the canonical-name uniqueness is enforced across vendors so the
-- same MSP customer in Autotask + Halo + Datto coalesces into one row
-- with three vendor_ids keys.

CREATE TABLE IF NOT EXISTS orgmem_entities (
  id                TEXT        PRIMARY KEY,
  org_id            TEXT        NOT NULL,
  subtenant_id      TEXT,                                       -- NULL = org-level
  entity_type       TEXT        NOT NULL,
  canonical_name    TEXT        NOT NULL,
  vendor_ids        JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- {vendor_slug: vendor_entity_id}
  attributes        JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- accreted scalar attrs (non-fact metadata)
  embedding         vector(1536),                               -- text-embedding-3-small sized
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Canonical-key uniqueness — THIS is the UPSERT match index that PR-2's
-- accretion worker ON CONFLICT clause keys on. Putting the canonical
-- key (org_id, subtenant_id, entity_type, lower(canonical_name)) in
-- the UNIQUE INDEX makes the upsert MATCH PATTERN itself; a job that
-- omits any of these can never reach a successful upsert — structurally
-- unreachable, not a thing humans have to remember. The COALESCE on
-- subtenant_id normalizes NULL=org-level into the uniqueness check so
-- two org-level entities with the same name+type don't both insert.

CREATE UNIQUE INDEX IF NOT EXISTS orgmem_entities_canonical_uniq
  ON orgmem_entities (
    org_id,
    COALESCE(subtenant_id, ''),
    entity_type,
    lower(canonical_name)
  );

-- Index-Scan target for the consult path (the pre-call read at
-- unified-router's pre-fetch hook). Standard B-tree on (org_id,
-- lower(canonical_name)) — the planner will pick this for the consult
-- query shape `WHERE org_id = $1 AND lower(canonical_name) = $2`.

CREATE INDEX IF NOT EXISTS orgmem_entities_org_name_idx
  ON orgmem_entities (org_id, lower(canonical_name));

CREATE INDEX IF NOT EXISTS orgmem_entities_org_type_name_idx
  ON orgmem_entities (org_id, entity_type, lower(canonical_name));

-- Vector ANN over entities (entity-level semantic recall — distinct
-- from fact-level semantic recall on orgmem_facts). Partial index
-- skips entities without an embedding yet (accretion writes embeddings
-- lazily for entities that warrant the cost).

CREATE INDEX IF NOT EXISTS orgmem_entities_embedding_idx
  ON orgmem_entities USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100)
  WHERE embedding IS NOT NULL;

ALTER TABLE orgmem_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgmem_entities FORCE  ROW LEVEL SECURITY;

-- Policy create is guarded for idempotency (CREATE POLICY has no
-- IF NOT EXISTS form pre-PG18; partial-fail re-runs would otherwise
-- error). Mirrors the construction-pattern shape used elsewhere in
-- the migrations directory.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'orgmem_entities'
      AND policyname = 'orgmem_entities_tenant'
  ) THEN
    CREATE POLICY orgmem_entities_tenant ON orgmem_entities
      USING (
            org_id = current_setting('app.org_id', true)
        AND COALESCE(subtenant_id, '')
              = COALESCE(current_setting('app.subtenant_id', true), '')
      )
      WITH CHECK (
            org_id = current_setting('app.org_id', true)
        AND COALESCE(subtenant_id, '')
              = COALESCE(current_setting('app.subtenant_id', true), '')
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. orgmem_edges — the relationship table (relational form)
-- ---------------------------------------------------------------------------
--
-- Replaces the AGE `RELATED_TO` elabel from the parked PR #281. FK to
-- orgmem_entities for both endpoints with ON DELETE CASCADE so an
-- entity removal (rare; accretion is invalidate-not-delete) takes its
-- edges with it. `edge_type` carries the relationship semantic
-- (e.g. 'belongs_to', 'assigned_to', 'parent_of') — accretion adds new
-- types without schema change.
--
-- Bi-temporal columns for invalidate-not-delete: a superseded edge sets
-- valid_to; new state inserts with valid_from=now(), valid_to=NULL. The
-- partial UNIQUE INDEX on (source, target, edge_type) WHERE valid_to IS
-- NULL guarantees only one current-state edge per (source, target,
-- type) triple per org/subtenant — superseded edges land cleanly with
-- the partial index excluding them.

CREATE TABLE IF NOT EXISTS orgmem_edges (
  id                TEXT        PRIMARY KEY,
  org_id            TEXT        NOT NULL,
  subtenant_id      TEXT,
  source_entity_id  TEXT        NOT NULL REFERENCES orgmem_entities(id) ON DELETE CASCADE,
  target_entity_id  TEXT        NOT NULL REFERENCES orgmem_entities(id) ON DELETE CASCADE,
  edge_type         TEXT        NOT NULL,
  attributes        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  source_vendor     TEXT,                                       -- vendor whose response surfaced this edge
  source_request_id TEXT,                                       -- request_log row id (audit chain)
  event_time        TIMESTAMPTZ,
  valid_from        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to          TIMESTAMPTZ,
  ingested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Canonical-key uniqueness on CURRENT edges (the UPSERT match index)
CREATE UNIQUE INDEX IF NOT EXISTS orgmem_edges_current_uniq
  ON orgmem_edges (
    org_id,
    COALESCE(subtenant_id, ''),
    source_entity_id,
    target_entity_id,
    edge_type
  )
  WHERE valid_to IS NULL;

-- Traversal indexes (outgoing / incoming from a resolved entity)
CREATE INDEX IF NOT EXISTS orgmem_edges_source_idx
  ON orgmem_edges (org_id, source_entity_id) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS orgmem_edges_target_idx
  ON orgmem_edges (org_id, target_entity_id) WHERE valid_to IS NULL;

-- Audit chain
CREATE INDEX IF NOT EXISTS orgmem_edges_source_request_idx
  ON orgmem_edges (source_request_id)
  WHERE source_request_id IS NOT NULL;

ALTER TABLE orgmem_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgmem_edges FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'orgmem_edges'
      AND policyname = 'orgmem_edges_tenant'
  ) THEN
    CREATE POLICY orgmem_edges_tenant ON orgmem_edges
      USING (
            org_id = current_setting('app.org_id', true)
        AND COALESCE(subtenant_id, '')
              = COALESCE(current_setting('app.subtenant_id', true), '')
      )
      WITH CHECK (
            org_id = current_setting('app.org_id', true)
        AND COALESCE(subtenant_id, '')
              = COALESCE(current_setting('app.subtenant_id', true), '')
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. orgmem_facts — bi-temporal, vector-embedded facts (UNCHANGED from
--    PR #281; this table was always relational + pgvector-backed)
-- ---------------------------------------------------------------------------
--
-- Each fact attaches to an entity by canonical (org_id, subtenant_id,
-- entity_type, canonical_name) key. Bi-temporal columns follow the
-- Graphiti pattern (steal-not-adopt): event_time = when the fact became
-- true in the real world; valid_from = when we learned it; valid_to =
-- when invalidated (NULL = current); ingested_at = audit. Invalidate-
-- not-delete: on conflict, the prior row's valid_to is set + a new row
-- inserts.

CREATE TABLE IF NOT EXISTS orgmem_facts (
  id                TEXT        PRIMARY KEY,
  org_id            TEXT        NOT NULL,
  subtenant_id      TEXT,
  entity_type       TEXT        NOT NULL,
  canonical_name    TEXT        NOT NULL,
  predicate         TEXT        NOT NULL,                       -- e.g. 'status', 'owner', 'has_open_ticket'
  object            JSONB       NOT NULL,                       -- structured fact value
  confidence        REAL        NOT NULL DEFAULT 1.0,           -- 0..1
  source_vendor     TEXT,                                       -- the vendor whose response this came from
  source_request_id TEXT,                                       -- request_log row id (audit chain)
  event_time        TIMESTAMPTZ,                                -- real-world time the fact holds
  valid_from        TIMESTAMPTZ NOT NULL DEFAULT NOW(),         -- knowledge-time begin
  valid_to          TIMESTAMPTZ,                                -- NULL = currently valid
  ingested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  embedding         vector(1536)
);

ALTER TABLE orgmem_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgmem_facts FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'orgmem_facts'
      AND policyname = 'orgmem_facts_tenant'
  ) THEN
    CREATE POLICY orgmem_facts_tenant ON orgmem_facts
      USING (
            org_id = current_setting('app.org_id', true)
        AND COALESCE(subtenant_id, '')
              = COALESCE(current_setting('app.subtenant_id', true), '')
      )
      WITH CHECK (
            org_id = current_setting('app.org_id', true)
        AND COALESCE(subtenant_id, '')
              = COALESCE(current_setting('app.subtenant_id', true), '')
      );
  END IF;
END $$;

-- Entity-anchored consult lookup: "give me current facts about this entity"
CREATE INDEX IF NOT EXISTS orgmem_facts_entity_current_idx
  ON orgmem_facts (org_id, entity_type, lower(canonical_name), valid_to);

-- request_log audit chain (debugging an injected fact back to its source)
CREATE INDEX IF NOT EXISTS orgmem_facts_source_request_idx
  ON orgmem_facts (source_request_id)
  WHERE source_request_id IS NOT NULL;

-- Vector ANN over CURRENT facts only (partial — superseded facts naturally
-- drop out of semantic recall without query-time filtering)
CREATE INDEX IF NOT EXISTS orgmem_facts_embedding_idx
  ON orgmem_facts USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100)
  WHERE valid_to IS NULL AND embedding IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. (ANALYZE intentionally omitted)
-- ---------------------------------------------------------------------------
--
-- Tables created here are empty; planner-stats from a bare ANALYZE would
-- be no-op information. Postgres's autovacuum daemon collects stats
-- after rows accrete, and the worker's first-real-load will trigger
-- stats refresh well before the index-scan-vs-seq-scan choice becomes
-- load-bearing for query latency.
--
-- The CI's schema-vs-harness drift gate locks `ANALYZE <table>` into a
-- deliberately-not-modelled set (src/scim/__tests__/migration-harness-
-- drift.test.ts, the "fail-loud contract" suite line 180-192). Omitting
-- the maintenance op here keeps the migration cleanly within the
-- modelled-shape set — the smallest construction-fix, vs extending the
-- classifier (would push against the locked-in fail-loud contract) or
-- allowlisting 035 in SCIM's ALLOWED_SKIPS (would mis-signal that
-- 035 is SCIM-irrelevant when it's actually a schema floor for a
-- new subsystem).

-- ---------------------------------------------------------------------------
-- 6. Grants for the request-path role (guarded — matches migration 029)
-- ---------------------------------------------------------------------------
--
-- `conduit_request` is the NOBYPASSRLS role used by the unified-router
-- request path (established by migration 029). Per 029's documented
-- convention, the role is **created externally** (by infra / bootstrap),
-- NOT by the migrations themselves — so any migration touching it must
-- guard the GRANT statements against the role's absence (otherwise dev
-- + CI environments where the role doesn't exist fail at GRANT time
-- even though the schema is correct).
--
-- This DO-block mirrors migration 029's pattern verbatim — granted-or-
-- skipped with explicit RAISE NOTICE on both branches so the operator
-- sees the disposition in the migration log. In environments where
-- `conduit_request` is present (prod + properly-bootstrapped staging),
-- the grants apply. In environments where it is absent (dev / CI /
-- ad-hoc staging without the bootstrap step), the migration succeeds
-- with a notice — RLS-noop posture, same as mig 029.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'conduit_request') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON orgmem_entities TO conduit_request;
    GRANT SELECT, INSERT, UPDATE, DELETE ON orgmem_edges    TO conduit_request;
    GRANT SELECT, INSERT, UPDATE, DELETE ON orgmem_facts    TO conduit_request;
    RAISE NOTICE 'mig 035: granted org-memory privileges to conduit_request';
  ELSE
    RAISE NOTICE 'mig 035: role conduit_request absent — skipping grants (dev/CI RLS-noop posture)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Notes for PR-2 (accretion) + PR-3 (consult), at the schema site
-- ---------------------------------------------------------------------------
--
-- ACCRETION WORKER (PR-2) writes in this shape (run inside the
-- per-request transaction with the org/subtenant GUCs SET LOCAL):
--
--   INSERT INTO orgmem_entities
--     (id, org_id, subtenant_id, entity_type, canonical_name,
--      vendor_ids, attributes, updated_at, confirmed_at)
--   VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
--   ON CONFLICT (org_id, COALESCE(subtenant_id, ''), entity_type,
--                lower(canonical_name))
--   DO UPDATE SET
--     vendor_ids   = orgmem_entities.vendor_ids || EXCLUDED.vendor_ids,
--     attributes   = orgmem_entities.attributes || EXCLUDED.attributes,
--     updated_at   = NOW(),
--     confirmed_at = NOW()
--   RETURNING id;
--
-- The canonical-key tuple in the ON CONFLICT clause IS the MATCH —
-- defence-by-construction: a missing org_id/canonical_name cannot
-- reach a successful upsert because there is no path to it from the
-- query shape. Combined with PR-2's writer-guard (line 1) and the
-- WITH CHECK clause above (line 2), the three-line silent-failure
-- defence is complete.
--
-- CONSULT HOOK (PR-3) reads in this shape (the Index-Scan path on
-- orgmem_entities_org_name_idx):
--
--   SELECT id, vendor_ids, attributes
--   FROM orgmem_entities
--   WHERE org_id = $1
--     AND lower(canonical_name) = lower($2);
--
-- with the hard latency budget (~30-50ms p95) + degrade-open. The
-- hook never throws on a miss/timeout — the downstream MCP call
-- always proceeds. Memory is ADDITIVE, never gates the call.
--
-- =============================================================================
