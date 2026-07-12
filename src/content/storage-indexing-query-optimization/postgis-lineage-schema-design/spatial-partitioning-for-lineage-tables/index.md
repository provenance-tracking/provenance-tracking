# Spatial Partitioning for Lineage Tables

A lineage table that captures every reprojection, clip, and QA pass across a national imagery program grows by millions of rows a month, and once it crosses a few hundred million rows even well-indexed queries start scanning more than they should. Declarative range partitioning by ingestion month keeps each child table small enough for fast GiST scans while letting the planner prune away months the query never asked for. This how-to partitions a high-volume lineage table by month and proves that partition pruning works, extending the base [PostGIS Lineage Schema Design](https://www.provenance-tracking.com/storage-indexing-query-optimization/postgis-lineage-schema-design/).

## Prerequisites

- PostgreSQL 15+ (for the improved runtime-pruning and `MERGE`/default-partition handling) with PostGIS 3.4+.
- A partition key column that is set at insert and never updated — `ingested_at timestamptz` is ideal.
- Rights to create partitioned tables and indexes.
- A scheduler (cron, `pg_cron`, or an Airflow/Prefect job) to create next month's partition ahead of time.

## Implementation

Declare the parent as `PARTITION BY RANGE (ingested_at)`, then attach one child per month. Each child gets its own GiST index on the geometry column and its own BRIN index on the timestamp, so indexes stay small and can be reindexed one partition at a time. Crucially, the partition key must be part of the primary key in a partitioned table, so the key becomes `(lineage_id, ingested_at)`.

```sql
CREATE TABLE lineage_event (
    lineage_id  uuid        NOT NULL DEFAULT gen_random_uuid(),
    dataset_id  uuid        NOT NULL,
    operation   text        NOT NULL,
    extent      geometry(Polygon, 4326),
    payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    ingested_at timestamptz NOT NULL,
    PRIMARY KEY (lineage_id, ingested_at)
) PARTITION BY RANGE (ingested_at);

-- One partition per ingestion month. Bounds are [lower, upper).
CREATE TABLE lineage_event_2026_06 PARTITION OF lineage_event
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE lineage_event_2026_07 PARTITION OF lineage_event
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- A default partition catches out-of-range rows instead of failing the insert.
CREATE TABLE lineage_event_default PARTITION OF lineage_event DEFAULT;

-- Per-partition spatial and temporal indexes.
CREATE INDEX lineage_2026_06_gix  ON lineage_event_2026_06 USING gist (extent);
CREATE INDEX lineage_2026_06_brin ON lineage_event_2026_06 USING brin (ingested_at);
CREATE INDEX lineage_2026_07_gix  ON lineage_event_2026_07 USING gist (extent);
CREATE INDEX lineage_2026_07_brin ON lineage_event_2026_07 USING brin (ingested_at);
```

Provisioning next month's partition should be automated. A small monthly job keeps the runway ahead of ingestion so writes never land in the default partition:

```sql
-- Run on the 25th of each month to create the following month.
DO $$
DECLARE
    start_date date := date_trunc('month', now() + interval '1 month');
    end_date   date := start_date + interval '1 month';
    part_name  text := 'lineage_event_' || to_char(start_date, 'YYYY_MM');
BEGIN
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF lineage_event
             FOR VALUES FROM (%L) TO (%L)',
        part_name, start_date, end_date);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I USING gist (extent)',
        part_name || '_gix', part_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I USING brin (ingested_at)',
        part_name || '_brin', part_name);
END $$;
```

## Verification

Confirm that a time-bounded query touches only the relevant partitions. With a `WHERE` clause on `ingested_at`, `EXPLAIN` should list only the matching child tables and mark the rest as pruned:

```sql
EXPLAIN (COSTS OFF)
SELECT lineage_id, operation
FROM lineage_event
WHERE ingested_at >= '2026-07-01' AND ingested_at < '2026-07-15'
  AND ST_Intersects(extent, ST_MakeEnvelope(-124, 32, -114, 42, 4326));
```

A pruned plan reads roughly as follows — note that only the July partition appears and the June partition is absent entirely:

```text
 Append
   ->  Bitmap Heap Scan on lineage_event_2026_07
         Recheck Cond: ...
         ->  Bitmap Index Scan on lineage_2026_07_gix
               Index Cond: (extent && '...'::geometry)
```

To see the contrast, drop the `ingested_at` predicate and rerun `EXPLAIN`: every partition, including `lineage_event_default`, now appears in the `Append` node, because without a bound on the partition key the planner cannot exclude any child. That difference is the whole payoff of partitioning.

## Gotchas & edge cases

- **Constraint exclusion needs the key in the predicate.** Pruning only happens when the query filters on `ingested_at` directly. A predicate on a derived expression such as `date_trunc('month', ingested_at) = ...` defeats pruning because the planner cannot map it to partition bounds. Always filter on the raw column with plain range comparisons, and keep `enable_partition_pruning` at its default `on`.
- **The default partition is a trap, not a safety net.** Rows with a NULL or out-of-range `ingested_at` silently collect in `lineage_event_default`, which has no useful bounds and cannot be pruned — every partition-key query then scans it. Monitor its row count and treat any growth as an ingestion bug; you also cannot add a new partition whose range overlaps rows already sitting in the default without first moving them out.
- **Cross-partition uniqueness.** A unique constraint on a partitioned table must include the partition key, so you cannot enforce global uniqueness of `lineage_id` alone. If a truly global unique identifier matters for foreign keys from other tables, generate UUIDs (collision probability is negligible) rather than relying on a database-enforced unique index across partitions.
