# Tuning GiST and BRIN Indexes for Lineage

Spatial-temporal audit queries filter a lineage table by both footprint and time, and the cheapest plan usually pairs a GiST geometry index with a BRIN timestamp index — but you only know the pairing works, and which `fillfactor` and `pages_per_range` to pick, by measuring it with `EXPLAIN ANALYZE`. This how-to builds both indexes on a lineage table, compares plans before and after, and tunes the parameters, extending the [spatial index tuning for provenance queries](https://www.provenance-tracking.com/storage-indexing-query-optimization/spatial-index-tuning-for-provenance-queries/) overview into a concrete measurement exercise.

## Prerequisites

- PostgreSQL 15+ with PostGIS 3.4+ and the `postgis` extension enabled.
- A `lineage_audit` table with `geom geometry(Geometry, 4326)`, `valid_from timestamptz`, and enough rows (hundreds of thousands or more) for index choice to matter — the column layout from [PostGIS lineage schema design](https://www.provenance-tracking.com/storage-indexing-query-optimization/postgis-lineage-schema-design/) works directly.
- Rows inserted in `valid_from` order, or the ability to run `CLUSTER`, since BRIN depends on physical ordering.
- Permission to run `CREATE INDEX`, `CLUSTER`, `ANALYZE`, and `EXPLAIN ANALYZE`.

## Implementation

Run the target query once to capture the baseline plan, build the two indexes with tuned parameters, refresh statistics, and re-check. The block below does all of it in sequence; execute it statement by statement so you can read each plan.

```sql
-- 1. Baseline: expect a Seq Scan with high actual rows and buffer reads.
EXPLAIN (ANALYZE, BUFFERS)
SELECT event_id, dataset_uuid, valid_from
FROM lineage_audit
WHERE geom && ST_MakeEnvelope(-71.2, 42.2, -70.9, 42.5, 4326)
  AND valid_from >= '2026-01-01' AND valid_from < '2026-04-01';

-- 2. Check the physical correlation of valid_from BEFORE trusting BRIN.
--    Values near 1.0 (or -1.0) mean rows are physically ordered by time.
SELECT correlation
FROM pg_stats
WHERE tablename = 'lineage_audit' AND attname = 'valid_from';

-- 3. If correlation is weak, force physical order once via a B-tree + CLUSTER.
CREATE INDEX IF NOT EXISTS idx_lineage_ts_btree
    ON lineage_audit (valid_from);
CLUSTER lineage_audit USING idx_lineage_ts_btree;

-- 4. Build the GiST spatial index. fillfactor 90 leaves room on leaf pages;
--    for an append-only, rarely-updated audit table you can pack tighter.
CREATE INDEX idx_lineage_geom_gist
    ON lineage_audit USING gist (geom) WITH (fillfactor = 95);

-- 5. Build the BRIN temporal index. Smaller pages_per_range = tighter pruning
--    at the cost of a marginally larger index. 32 suits selective date ranges.
CREATE INDEX idx_lineage_ts_brin
    ON lineage_audit USING brin (valid_from) WITH (pages_per_range = 32);

-- 6. Refresh statistics so the planner will cost the new indexes correctly.
ANALYZE lineage_audit;

-- 7. Re-run the exact baseline query and compare the plan.
EXPLAIN (ANALYZE, BUFFERS)
SELECT event_id, dataset_uuid, valid_from
FROM lineage_audit
WHERE geom && ST_MakeEnvelope(-71.2, 42.2, -70.9, 42.5, 4326)
  AND valid_from >= '2026-01-01' AND valid_from < '2026-04-01';
```

Two parameter choices drive the outcome. `fillfactor = 95` on the GiST index packs leaf pages more densely because an immutable audit table sees few in-place updates, so reserving free space would only waste it. `pages_per_range = 32` on the BRIN index makes each summarized block range narrower, which tightens min/max pruning for selective quarter-long date filters; widen it toward 128 if your ranges span years and you want the smallest possible index.

## Verification

The proof is in the plan diff. A correctly tuned pair replaces the baseline `Seq Scan` with a `BitmapAnd` that combines both indexes:

```text
Bitmap Heap Scan on lineage_audit
  Recheck Cond: ((geom && ...) AND (valid_from >= ... AND valid_from < ...))
  ->  BitmapAnd
        ->  Bitmap Index Scan on idx_lineage_geom_gist
              Index Cond: (geom && ...)
        ->  Bitmap Index Scan on idx_lineage_ts_brin
              Index Cond: (valid_from >= ... AND valid_from < ...)
```

Compare the `actual time` and `Buffers: shared read` figures between the two `EXPLAIN ANALYZE` runs. A successful tune shows a large drop in both — the spatial and temporal prefilters together discard most of the table before any heap page is touched. If only one index appears in the plan, the other filter is either non-selective for this query or its statistics are stale; re-run `ANALYZE` and confirm the query uses `&&` and a range predicate the indexes support.

## Gotchas & edge cases

- **BRIN needs physical ordering.** BRIN summarizes each block's min/max, so if rows are scattered by time across the heap, every range overlaps your filter and the index reads the whole table. Check `pg_stats.correlation` first; if it is far from ±1, `CLUSTER` on a timestamp B-tree once to reorder the heap, as shown in step 3. Note that `CLUSTER` takes an exclusive lock and does not maintain order for future inserts — append-only ingestion in time order preserves it naturally.
- **GiST fillfactor cuts both ways.** Packing to 95 shrinks the index and speeds scans on a static table, but if you ever backfill or update geometries heavily, dense pages cause splits and bloat. Keep the default 90 for tables that still receive corrections.
- **BRIN summaries go stale on new blocks.** Rows inserted after the index is built land in unsummarized ranges until autovacuum or a manual `brin_summarize_new_values('idx_lineage_ts_brin')` runs, so a freshly loaded partition may temporarily fall back to scanning. Schedule summarization after bulk loads.
