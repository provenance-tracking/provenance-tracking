# PostGIS Lineage Schema Design

Relational databases remain the default system of record for most geospatial agencies, and PostGIS is the natural home for spatial provenance when the derivation history must live alongside the data it describes. The challenge is that lineage is a graph problem wearing a table-shaped costume: datasets are derived from other datasets through process steps, each step consumes sources and emits products, and the whole structure forms a directed acyclic graph (DAG) that a naive schema will flatten into unqueryable join soup. A deliberate schema — with dedicated tables for datasets, process steps, and sources, geometry columns for spatial extents, `jsonb` for process parameters, and foreign keys that encode the DAG edges — turns that costume into a genuine, auditable model.

This guide sits under the [Storage, Indexing & Query Optimization](https://www.provenance-tracking.com/storage-indexing-query-optimization/) overview and fills a specific gap: how to lay out the physical PostGIS schema so that provenance is immutable, spatially indexed, and compliant by construction. It complements the graph-native approach covered in [Graph Databases for Lineage Graphs](https://www.provenance-tracking.com/storage-indexing-query-optimization/graph-databases-for-lineage-graphs/); if you have not yet decided which engine fits your workload, the trade-offs are weighed in [PostGIS vs Neo4j for Spatial Lineage](https://www.provenance-tracking.com/storage-indexing-query-optimization/postgis-vs-neo4j-for-spatial-lineage/). Here we assume PostGIS has won and focus entirely on getting the tables, indexes, and triggers right.

<svg viewBox="0 0 640 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="PostGIS lineage schema: sources and datasets tables linked through a process_steps table forming a derivation DAG, with geometry extents, JSONB parameters, and GiST plus BRIN indexes">
<title>PostGIS lineage schema entity model and index placement</title>
<rect width="640" height="300" fill="#fffdf8" rx="10"/>
<rect x="24" y="40" width="150" height="120" rx="8" fill="#3f5a30"/>
<text x="99" y="64" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" font-weight="700" fill="#fffdf8">source</text>
<text x="99" y="86" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">source_id (PK)</text>
<text x="99" y="102" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">origin_uri</text>
<text x="99" y="118" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">extent geometry</text>
<text x="99" y="134" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">srid, sha256</text>
<rect x="245" y="40" width="150" height="120" rx="8" fill="#b55b3b"/>
<text x="320" y="64" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" font-weight="700" fill="#fffdf8">process_step</text>
<text x="320" y="86" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">step_id (PK)</text>
<text x="320" y="102" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">algorithm, version</text>
<text x="320" y="118" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">parameters jsonb</text>
<text x="320" y="134" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">run_at</text>
<rect x="466" y="40" width="150" height="120" rx="8" fill="#5e7b4a"/>
<text x="541" y="64" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" font-weight="700" fill="#fffdf8">dataset</text>
<text x="541" y="86" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">dataset_id (PK)</text>
<text x="541" y="102" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">produced_by (FK)</text>
<text x="541" y="118" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">extent geometry</text>
<text x="541" y="134" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">srid, sha256</text>
<rect x="245" y="210" width="150" height="60" rx="8" fill="#c8a781"/>
<text x="320" y="234" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="700" fill="#2b1d12">step_input</text>
<text x="320" y="252" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#2b1d12">edge: step ← source/dataset</text>
<defs><marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#2b1d12"/></marker></defs>
<line x1="174" y1="100" x2="245" y2="100" stroke="#2b1d12" stroke-width="2" marker-end="url(#ar)"/>
<line x1="395" y1="100" x2="466" y2="100" stroke="#2b1d12" stroke-width="2" marker-end="url(#ar)"/>
<line x1="320" y1="210" x2="320" y2="160" stroke="#5a3c25" stroke-width="1.5" marker-end="url(#ar)"/>
<line x1="245" y1="230" x2="120" y2="160" stroke="#5a3c25" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#ar)"/>
<text x="205" y="30" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" font-weight="700" fill="#2b1d12">consumes</text>
<text x="430" y="30" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" font-weight="700" fill="#2b1d12">produces</text>
<rect x="24" y="210" width="150" height="60" rx="8" fill="#d9b78f"/>
<text x="99" y="234" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#2b1d12">GiST on extent</text>
<text x="99" y="252" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#2b1d12">BRIN on run_at</text>
</svg>

## Prerequisites

- [ ] PostgreSQL 15+ with the PostGIS 3.4+ extension available (`CREATE EXTENSION postgis;`).
- [ ] The `pgcrypto` extension for server-side `digest()` hashing, or client-side hashing in Python.
- [ ] Python 3.10+ with `psycopg` 3.1+ installed for the ingestion client shown below.
- [ ] A decided project-wide storage CRS (this guide standardizes on `EPSG:4326` for extents; reproject on the way in).
- [ ] A `DBA` or migration role with rights to create tables, indexes, and triggers in the target schema.
- [ ] Agreement on which fields are immutable provenance facts versus mutable annotations, following the separation described in [Structuring JSON/XML Lineage Documents](https://www.provenance-tracking.com/storage-indexing-query-optimization/structuring-jsonxml-lineage-documents/).

## Step-by-step

### 1. Create the core tables

The schema has three entity tables. `source` records external inputs the agency does not itself produce, `process_step` records a single transformation with its parameters, and `dataset` records a product. Every product points at the step that produced it, and every step points at the inputs it consumed through an association table — together these foreign keys are the edges of the derivation DAG. Spatial extents are stored as native `geometry(Polygon, 4326)` columns rather than raw coordinates so the planner can use spatial operators such as `ST_Intersects`.

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE source (
    source_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    origin_uri   text NOT NULL,
    media_type   text NOT NULL,
    extent       geometry(Polygon, 4326),
    sha256       char(64) NOT NULL,
    ingested_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE process_step (
    step_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    algorithm    text NOT NULL,
    version      text NOT NULL,
    parameters   jsonb NOT NULL DEFAULT '{}'::jsonb,
    actor        text NOT NULL,
    run_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dataset (
    dataset_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    label        text NOT NULL,
    produced_by  uuid REFERENCES process_step(step_id),
    extent       geometry(Polygon, 4326),
    srid         integer NOT NULL,
    sha256       char(64) NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- Association table: the edges consumed by each step (source OR dataset).
CREATE TABLE step_input (
    step_id       uuid NOT NULL REFERENCES process_step(step_id),
    source_id     uuid REFERENCES source(source_id),
    input_dataset uuid REFERENCES dataset(dataset_id),
    role          text NOT NULL,
    CONSTRAINT one_input_kind CHECK (
        (source_id IS NOT NULL) <> (input_dataset IS NOT NULL)
    ),
    PRIMARY KEY (step_id, source_id, input_dataset)
);
```

The `CHECK` constraint enforces that each edge references exactly one kind of input, preventing ambiguous rows where both columns are populated or both are null.

### 2. Add spatial and temporal indexes

Two access patterns dominate lineage queries: "what touched this region" and "what ran in this time window". Serve the first with a GiST index on every geometry column, and the second with a BRIN index on the naturally-ordered timestamp columns. BRIN is the right tool for append-only ingestion timestamps because the physical row order correlates with time, giving you a tiny index that still prunes effectively. A partial GiST index skips rows with no extent, which is common for non-spatial reference sources.

```sql
CREATE INDEX dataset_extent_gix ON dataset USING gist (extent)
    WHERE extent IS NOT NULL;
CREATE INDEX source_extent_gix  ON source  USING gist (extent)
    WHERE extent IS NOT NULL;

CREATE INDEX step_run_at_brin   ON process_step USING brin (run_at)
    WITH (pages_per_range = 32);
CREATE INDEX dataset_created_brin ON dataset USING brin (created_at);

-- Accelerate parameter lookups on the JSONB column.
CREATE INDEX step_params_gin ON process_step USING gin (parameters jsonb_path_ops);

-- The DAG-walk join columns.
CREATE INDEX dataset_produced_by_idx ON dataset (produced_by);
CREATE INDEX step_input_step_idx     ON step_input (step_id);
```

Index selection and maintenance for these access paths is treated in depth in the companion guide on [tuning GiST and BRIN indexes for lineage](https://www.provenance-tracking.com/storage-indexing-query-optimization/spatial-index-tuning-for-provenance-queries/tuning-gist-and-brin-indexes-for-lineage/).

### 3. Enforce immutability with a trigger

Provenance facts must not change after they are written. Rather than trusting application code, enforce append-only semantics in the database itself with a `BEFORE UPDATE OR DELETE` trigger that raises an exception. Attach it to the entity tables so that any attempt to rewrite history — accidental or malicious — fails loudly and leaves a Postgres error in the log.

```sql
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Table % is append-only; % rejected on %',
        TG_TABLE_NAME, TG_OP, now()
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER dataset_immutable
    BEFORE UPDATE OR DELETE ON dataset
    FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER process_step_immutable
    BEFORE UPDATE OR DELETE ON process_step
    FOR EACH ROW EXECUTE FUNCTION reject_mutation();
```

If a dataset genuinely supersedes another, write a new row and link it — never mutate the old one. The full append-only pattern, extended with a tamper-evident hash chain, is built step by step in [designing a PostGIS lineage audit table](https://www.provenance-tracking.com/storage-indexing-query-optimization/postgis-lineage-schema-design/designing-a-postgis-lineage-audit-table/).

### 4. Ingest records from Python

The ingestion client hashes the payload, reprojects the extent to the storage CRS, and writes the source, step, product, and edges inside a single transaction so a partial failure never leaves an orphaned product. Using `psycopg` 3 with a parameterized query keeps the geometry as well-known text (WKT) that PostGIS parses with `ST_GeomFromText`.

```python
from __future__ import annotations

import hashlib
import json
from typing import Any

import psycopg


def ingest_derivation(
    conn: psycopg.Connection,
    *,
    label: str,
    algorithm: str,
    version: str,
    parameters: dict[str, Any],
    actor: str,
    extent_wkt: str,
    payload: bytes,
    source_ids: list[str],
) -> str:
    """Insert one process step and its product atomically; return the dataset UUID."""
    digest = hashlib.sha256(payload).hexdigest()
    with conn.transaction():
        step_id = conn.execute(
            """
            INSERT INTO process_step (algorithm, version, parameters, actor)
            VALUES (%s, %s, %s::jsonb, %s)
            RETURNING step_id
            """,
            (algorithm, version, json.dumps(parameters), actor),
        ).fetchone()[0]

        for src in source_ids:
            conn.execute(
                """
                INSERT INTO step_input (step_id, source_id, role)
                VALUES (%s, %s, 'primary')
                """,
                (step_id, src),
            )

        dataset_id = conn.execute(
            """
            INSERT INTO dataset (label, produced_by, extent, srid, sha256)
            VALUES (%s, %s, ST_GeomFromText(%s, 4326), 4326, %s)
            RETURNING dataset_id
            """,
            (label, step_id, extent_wkt, digest),
        ).fetchone()[0]
    return str(dataset_id)
```

Because the immutability trigger blocks `UPDATE`, the client must get each row right on the first insert — validate against the document schema in [Structuring JSON/XML Lineage Documents](https://www.provenance-tracking.com/storage-indexing-query-optimization/structuring-jsonxml-lineage-documents/) before calling `ingest_derivation`.

## Configuration reference

| Parameter | Type | Valid values | Default |
|-----------|------|--------------|---------|
| `extent` SRID | integer | any registered EPSG code; project standard is `4326` | `4326` |
| `parameters` | `jsonb` | any valid JSON object | `'{}'::jsonb` |
| `sha256` | `char(64)` | 64 lowercase hex characters | none (required) |
| `pages_per_range` (BRIN) | integer | `1`–`128`; lower = finer pruning, larger index | `128` |
| GiST `fillfactor` | integer | `10`–`100` | `90` |
| `role` (step_input) | text | `primary`, `auxiliary`, `reference` | `primary` |
| immutability trigger | boolean | enabled / disabled per table | enabled |

## Common failure modes & mitigations

| Failure mode | Symptom | Mitigation |
|--------------|---------|------------|
| **Silent CRS drift** | Extents stored in mixed SRIDs; `ST_Intersects` returns empty or wrong results | Type geometry columns as `geometry(Polygon, 4326)` and reproject with `ST_Transform` at ingestion; reject rows whose `ST_SRID` differs |
| **Orphaned rows** | Products with a `produced_by` step that has no `step_input` edges | Wrap step, edges, and product in one transaction; add a deferred constraint or nightly check that flags stepless products |
| **Index bloat** | GiST index grows far beyond table size; scans slow after bulk loads | Run `REINDEX CONCURRENTLY` in maintenance windows; monitor with `pg_stat_user_indexes`; lower `fillfactor` for write-heavy tables |
| **Trigger bypass** | Rows edited via `TRUNCATE` or superuser session | Restrict `TRUNCATE` grants; keep the audit hash chain so tampering is detectable even if a trigger is disabled |
| **JSONB schema rot** | Parameters keys drift between pipeline versions | Validate `parameters` against a versioned JSON Schema before insert; index only stable keys |

## Compliance & governance alignment

| Control / framework | Requirement | Schema element that satisfies it |
|---------------------|-------------|----------------------------------|
| ISO 19115 lineage (`LI_Lineage`) | Record process step, source, and description | `process_step.algorithm` / `version`, `source`, `step_input` edges |
| W3C PROV-O | Entities, activities, agents with derivation edges | `dataset` (Entity), `process_step` (Activity), `actor` (Agent), `produced_by` / `step_input` (wasDerivedFrom) |
| FISMA AU-9 (protection of audit info) | Audit records protected from modification | `BEFORE UPDATE OR DELETE` immutability trigger + hash column |
| INSPIRE metadata | Traceable spatial extent and quality | `geometry(Polygon, 4326)` extents, GiST-indexed for discovery |
| GDPR Article 30 (records of processing) | Who processed what, when | `process_step.actor`, `run_at`, parameterized transformation record |

For the full mapping of these regimes to lineage fields, see the regulatory overview at [Regulatory Compliance Standards Mapping](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/) and the [ISO 19115 lineage implementation](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/iso-19115-lineage-implementation/) guide.

## Where to go next

With the core schema in place, three follow-on tasks harden it for production: a tamper-evident [audit table with a hash chain](https://www.provenance-tracking.com/storage-indexing-query-optimization/postgis-lineage-schema-design/designing-a-postgis-lineage-audit-table/), [spatial partitioning of high-volume lineage tables](https://www.provenance-tracking.com/storage-indexing-query-optimization/postgis-lineage-schema-design/spatial-partitioning-for-lineage-tables/) by ingestion month, and [bitemporal versioning of lineage rows](https://www.provenance-tracking.com/storage-indexing-query-optimization/postgis-lineage-schema-design/versioning-lineage-rows-with-temporal-tables/) so historical states remain queryable. Each builds directly on the tables defined here. If you later find that recursive DAG walks dominate your workload, revisit the engine choice in [PostGIS vs Neo4j for Spatial Lineage](https://www.provenance-tracking.com/storage-indexing-query-optimization/postgis-vs-neo4j-for-spatial-lineage/) and the graph-native patterns in [Graph Databases for Lineage Graphs](https://www.provenance-tracking.com/storage-indexing-query-optimization/graph-databases-for-lineage-graphs/).
