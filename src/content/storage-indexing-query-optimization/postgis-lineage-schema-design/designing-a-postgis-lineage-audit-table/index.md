# Designing a PostGIS Lineage Audit Table

An append-only table stops accidental overwrites, but on its own it cannot prove that no row was ever quietly rewritten by someone with elevated privileges. This how-to adds tamper evidence: an audit table where every row carries a SHA-256 hash of its own contents chained to the hash of the previous row, plus a `BEFORE UPDATE OR DELETE` trigger that rejects mutation outright. It extends the core [PostGIS Lineage Schema Design](https://www.provenance-tracking.com/storage-indexing-query-optimization/postgis-lineage-schema-design/) with a structure that lets an auditor detect a single altered byte anywhere in the history.

## Prerequisites

- PostgreSQL 15+ with PostGIS 3.4+ and the `pgcrypto` extension enabled.
- Python 3.10+ with `psycopg` 3.1+ for the verification client.
- A database role permitted to create tables, functions, and triggers.
- The `dataset` and `process_step` tables from the parent schema already present (the audit table references their identifiers).

## Implementation

The audit table stores one immutable event per row. Each row computes `row_hash` from its own payload columns concatenated with the `prev_hash` of the row before it, forming a hash chain: change any historical row and every subsequent `row_hash` fails to recompute. A `BEFORE INSERT` trigger fills in the chain server-side so clients cannot forge it, and a second trigger blocks `UPDATE` and `DELETE`.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE lineage_audit (
    seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_time timestamptz NOT NULL DEFAULT clock_timestamp(),
    actor      text        NOT NULL,
    operation  text        NOT NULL,          -- e.g. 'REPROJECT', 'CLIP'
    dataset_id uuid        NOT NULL,
    extent     geometry(Polygon, 4326),
    payload    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    prev_hash  char(64)    NOT NULL,
    row_hash   char(64)    NOT NULL
);

-- Compute the chained hash before the row is written.
CREATE OR REPLACE FUNCTION lineage_audit_chain() RETURNS trigger AS $$
DECLARE
    last_hash char(64);
    canonical text;
BEGIN
    SELECT row_hash INTO last_hash
    FROM lineage_audit
    ORDER BY seq DESC
    LIMIT 1;

    -- Genesis row chains from 64 zeroes.
    NEW.prev_hash := COALESCE(last_hash, repeat('0', 64));

    canonical := NEW.event_time::text || '|' || NEW.actor || '|'
              || NEW.operation || '|' || NEW.dataset_id::text || '|'
              || COALESCE(ST_AsText(NEW.extent), '') || '|'
              || NEW.payload::text || '|' || NEW.prev_hash;

    NEW.row_hash := encode(digest(canonical, 'sha256'), 'hex');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lineage_audit_chain_bi
    BEFORE INSERT ON lineage_audit
    FOR EACH ROW EXECUTE FUNCTION lineage_audit_chain();

-- Block any mutation of a written row.
CREATE OR REPLACE FUNCTION lineage_audit_freeze() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lineage_audit is append-only; % rejected', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lineage_audit_freeze_bud
    BEFORE UPDATE OR DELETE ON lineage_audit
    FOR EACH ROW EXECUTE FUNCTION lineage_audit_freeze();
```

Note the use of `clock_timestamp()` rather than `now()`: within a batch transaction, `now()` returns the same value for every row, which is fine for the chain but obscures true event ordering. `clock_timestamp()` advances per statement. The canonical string uses `ST_AsText` so the geometry contributes to the hash in a stable textual form; if you need bit-exact geometry hashing across PostGIS versions, substitute `ST_AsBinary` and hash the `bytea` directly.

The Python side simply inserts events; the server computes the chain, so the client never sets `prev_hash` or `row_hash`.

```python
from __future__ import annotations

import json

import psycopg


def append_audit_event(
    conn: psycopg.Connection,
    *,
    actor: str,
    operation: str,
    dataset_id: str,
    extent_wkt: str | None,
    payload: dict,
) -> int:
    """Append one tamper-evident audit event; returns its sequence number."""
    row = conn.execute(
        """
        INSERT INTO lineage_audit (actor, operation, dataset_id, extent, payload)
        VALUES (
            %s, %s, %s,
            CASE WHEN %s IS NULL THEN NULL ELSE ST_GeomFromText(%s, 4326) END,
            %s::jsonb
        )
        RETURNING seq
        """,
        (actor, operation, dataset_id, extent_wkt, extent_wkt, json.dumps(payload)),
    ).fetchone()
    conn.commit()
    return row[0]
```

## Verification

First, prove the table is truly append-only by attempting a mutation and observing the rejection:

```sql
-- Should fail with: lineage_audit is append-only; UPDATE rejected
UPDATE lineage_audit SET actor = 'tamperer' WHERE seq = 1;

-- Should fail with: lineage_audit is append-only; DELETE rejected
DELETE FROM lineage_audit WHERE seq = 1;
```

Second, recompute the whole chain and confirm that every stored `row_hash` matches. This query walks the rows in order, rebuilds each canonical string using the previous row's stored hash, and returns only rows where the recomputed hash disagrees — an empty result means the chain is intact:

```sql
WITH recomputed AS (
    SELECT
        seq,
        row_hash AS stored,
        encode(digest(
            event_time::text || '|' || actor || '|' || operation || '|'
            || dataset_id::text || '|' || COALESCE(ST_AsText(extent), '') || '|'
            || payload::text || '|'
            || LAG(row_hash, 1, repeat('0', 64)) OVER (ORDER BY seq),
            'sha256'), 'hex') AS rebuilt
    FROM lineage_audit
)
SELECT seq, stored, rebuilt
FROM recomputed
WHERE stored <> rebuilt;
```

If an attacker altered row 5, that row and every row after it would appear in the result set, because each subsequent `prev_hash` no longer matches. A weekly job that runs this query and alerts on any output gives you continuous tamper detection.

## Gotchas & edge cases

- **Geometry text stability.** `ST_AsText` output can vary in coordinate precision across PostGIS point releases. Pin the precision explicitly with `ST_AsText(extent, 8)` in both the trigger and the verification query, or hash `ST_AsEWKB` bytes, so an engine upgrade never invalidates an otherwise-untouched chain.
- **NULL extents.** Non-spatial audit events have a null extent. The `COALESCE(..., '')` in the canonical string keeps those rows hashable; if you forget it, `digest()` receives a NULL and the whole concatenation becomes NULL, producing an unverifiable row.
- **Concurrent inserts.** Two transactions inserting at once can both read the same "last" row and chain from it, forking the hash chain. Serialize appends with an advisory lock (`pg_advisory_xact_lock`) inside the trigger, or route all audit writes through a single queue, if strict linearity matters for your audit posture.
