# Spatial Index Tuning for Provenance Queries

Provenance queries have a characteristic shape that generic indexing advice ignores. A compliance officer asking "which lineage events touched this parcel between two dates" issues a query that filters on both a geometry and a time range, then walks derivation edges. If the planner cannot cheaply prune the audit table by bounding box and timestamp first, that query degrades into a sequential scan over millions of immutable lineage rows — acceptable for an ad-hoc report, fatal for an interactive audit dashboard bound by a service-level agreement. Tuning the spatial and temporal indexes behind these access patterns is what keeps evidence retrieval fast enough to be usable under scrutiny.

This guide, part of the [Storage, Indexing & Query Optimization](https://www.provenance-tracking.com/storage-indexing-query-optimization/) section, focuses on PostGIS index selection and tuning for lineage workloads. It assumes you have already laid out an audit table following the [PostGIS lineage schema design](https://www.provenance-tracking.com/storage-indexing-query-optimization/postgis-lineage-schema-design/) guidance and now need those tables to answer spatial-temporal provenance queries within a bounded latency budget. We cover when to reach for GiST, SP-GiST, or BRIN, how composite and covering indexes collapse multi-column filters, how to read `EXPLAIN ANALYZE` output, and how planner statistics decide whether your carefully built index is ever used at all.

<svg viewBox="0 0 600 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decision tree for choosing a PostGIS index type for provenance queries based on column type, access pattern, and physical row ordering">
<title>Index-type decision tree for provenance queries</title>
<rect width="600" height="300" fill="#fffdf8" rx="10"/>
<text x="300" y="26" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="700" fill="#2b1d12">Choosing an Index for Lineage Access Patterns</text>
<rect x="220" y="44" width="160" height="46" rx="8" fill="#2b1d12"/>
<text x="300" y="64" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">What are you filtering?</text>
<text x="300" y="80" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">geometry / point / time</text>
<rect x="20" y="130" width="150" height="60" rx="8" fill="#3f5a30"/>
<text x="95" y="153" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">Polygon / bbox</text>
<text x="95" y="169" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">overlap with &amp;&amp;</text>
<text x="95" y="181" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" font-weight="700" fill="#fffdf8">→ GiST</text>
<rect x="185" y="130" width="150" height="60" rx="8" fill="#5e7b4a"/>
<text x="260" y="153" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">Points, clustered</text>
<text x="260" y="169" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">non-overlapping</text>
<text x="260" y="181" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" font-weight="700" fill="#fffdf8">→ SP-GiST</text>
<rect x="350" y="130" width="150" height="60" rx="8" fill="#a24a2c"/>
<text x="425" y="153" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">Append-only time</text>
<text x="425" y="169" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">physically ordered</text>
<text x="425" y="181" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" font-weight="700" fill="#fffdf8">→ BRIN</text>
<rect x="200" y="230" width="200" height="52" rx="8" fill="#5a3c25"/>
<text x="300" y="252" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" font-weight="700" fill="#fffdf8">Both geom + time filters?</text>
<text x="300" y="268" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">GiST(geom) + BRIN(ts), verify with EXPLAIN</text>
<defs><marker id="ai" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#2b1d12"/></marker></defs>
<line x1="270" y1="90" x2="120" y2="130" stroke="#2b1d12" stroke-width="1.5" marker-end="url(#ai)"/>
<line x1="300" y1="90" x2="270" y2="130" stroke="#2b1d12" stroke-width="1.5" marker-end="url(#ai)"/>
<line x1="330" y1="90" x2="410" y2="130" stroke="#2b1d12" stroke-width="1.5" marker-end="url(#ai)"/>
<line x1="95" y1="190" x2="240" y2="230" stroke="#5a3c25" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#ai)"/>
<line x1="425" y1="190" x2="360" y2="230" stroke="#5a3c25" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#ai)"/>
</svg>

## The provenance access patterns worth indexing

Before creating any index, characterize the queries that carry an SLA. In a lineage audit table, four patterns dominate. The first is a spatial containment or overlap filter — "events whose footprint intersects this jurisdiction" — expressed with the `&&` bounding-box operator and refined by `ST_Intersects`. The second is a temporal range — "events between two `valid_from` timestamps" — which on an append-only table correlates strongly with physical row order. The third is the combination of both, which is the hard case and the one that most benefits from deliberate index design. The fourth is exact-key lookup by dataset UUID, served by an ordinary B-tree.

Indexing is a trade, not a free win. Every index you add slows the high-frequency writes that lineage ingestion generates and consumes storage that must itself be retained. The goal is the minimal index set that turns your SLA-bound read patterns into index scans while leaving write throughput acceptable. That balance is why index *type* matters: a BRIN index costs a fraction of a GiST index to maintain and store, and on the right column it answers range queries almost as well.

## GiST, SP-GiST, and BRIN for spatial and temporal columns

PostGIS ships three access methods relevant here, each suited to a different data distribution.

- **GiST** is the default and correct choice for the `geometry` column. It builds a balanced tree of bounding boxes, so overlap queries with `&&` prune the table efficiently regardless of how rows are physically ordered. Use it for polygon footprints and any geometry where extents overlap.
- **SP-GiST** partitions space rather than bounding it, which makes it strong for large collections of non-overlapping points — think sample locations or sensor coordinates — where a quadtree-style partition is tighter than GiST's overlapping boxes. It is a targeted optimization, not a default.
- **BRIN** (Block Range INdex) stores only the min/max value per block range. It is tiny and cheap to maintain, and it shines on columns whose values track physical storage order — precisely the case for a `valid_from` timestamp in an append-only, immutable lineage table where new rows arrive in time order. On a well-ordered column BRIN answers range queries at a small fraction of a B-tree's size; on a randomly ordered column it is useless.

The pairing that serves most spatial-temporal provenance queries is a GiST index on the geometry and a BRIN index on the timestamp. The planner combines them with a bitmap AND, prefiltering by bounding box and time block range before the expensive exact predicates run.

## Prerequisites

- [ ] PostGIS 3.4+ on PostgreSQL 15+ with the `postgis` extension installed.
- [ ] A lineage audit table with a `geom geometry(Geometry, 4326)` column and a `valid_from timestamptz` column, populated with a representative row volume.
- [ ] `ANALYZE` run at least once so the planner has statistics, and permission to run `EXPLAIN ANALYZE`.
- [ ] Ability to run `CLUSTER` or control insertion order if you intend to rely on BRIN.
- [ ] A short list of the SLA-bound queries you are tuning for, captured as parameterized SQL.

## Step-by-step

### 1. Baseline the query before indexing

Never tune blind. Capture the current plan and timing so you can prove an index helped. `EXPLAIN (ANALYZE, BUFFERS)` shows the chosen scan, estimated versus actual rows, and heap buffer reads.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT event_id, dataset_uuid, valid_from
FROM lineage_audit
WHERE geom && ST_MakeEnvelope(-71.2, 42.2, -70.9, 42.5, 4326)
  AND valid_from >= '2026-01-01' AND valid_from < '2026-04-01';
```

A `Seq Scan` node with a large actual-rows count and high buffer reads is your evidence that an index is warranted.

### 2. Build the spatial GiST index

Create a GiST index on the geometry column. The `&&` operator in the query is what makes this index eligible; it performs the bounding-box prefilter that cheaply discards non-overlapping rows before `ST_Intersects` runs the exact test.

```sql
CREATE INDEX idx_lineage_geom_gist
    ON lineage_audit USING gist (geom);
```

### 3. Build the temporal BRIN index

Add a BRIN index on `valid_from`. Because the audit table is append-only, rows already arrive in timestamp order, so each block range has a tight min/max and the index prunes date ranges effectively. The `pages_per_range` parameter controls granularity — smaller ranges mean tighter pruning at the cost of a slightly larger index.

```sql
CREATE INDEX idx_lineage_ts_brin
    ON lineage_audit USING brin (valid_from) WITH (pages_per_range = 64);
```

### 4. Consider a composite or covering index for hot lookups

For the exact-key pattern, a covering B-tree lets the query return from the index alone via an index-only scan, avoiding heap reads. `INCLUDE` carries the payload columns without making them part of the search key.

```sql
CREATE INDEX idx_lineage_uuid_cover
    ON lineage_audit (dataset_uuid) INCLUDE (valid_from, event_id);
```

### 5. Refresh statistics, then re-check the plan

Indexes are only used if the planner's cost estimates favor them, and those estimates come from table statistics. Run `ANALYZE`, then re-run the `EXPLAIN ANALYZE` from step 1 and confirm the plan now shows a `Bitmap Index Scan` on your GiST and BRIN indexes combined under a `BitmapAnd`.

```sql
ANALYZE lineage_audit;
```

The [tuning GiST and BRIN indexes for lineage](https://www.provenance-tracking.com/storage-indexing-query-optimization/spatial-index-tuning-for-provenance-queries/tuning-gist-and-brin-indexes-for-lineage/) how-to works a full before/after measurement of exactly this pair, including how to pick `fillfactor` and `pages_per_range`.

## Configuration reference

| Index type | Best for | Trade-off | Default |
|------------|----------|-----------|---------|
| `gist` (geometry) | Polygon/overlap filters via `&&`, `ST_Intersects` | Larger, slower to build/maintain than BRIN | Default for `geometry` |
| `spgist` | Large sets of non-overlapping points | Narrow applicability; not for overlapping extents | Not default |
| `brin` (timestamptz) | Range scans on physically ordered append-only columns | Useless if rows are not ordered by the column | `pages_per_range = 128` |
| B-tree `INCLUDE` (covering) | Exact-key lookups returning a few payload columns | Extra write cost; only helps index-only scans | n/a |
| `fillfactor` (GiST/B-tree) | Reserving page space for updates | Lower value inflates index size | `90` (GiST) |

## Common failure modes & mitigations

| Failure mode | Symptom | Mitigation |
|--------------|---------|------------|
| **Unused index** | `EXPLAIN` still shows `Seq Scan` after `CREATE INDEX` | Run `ANALYZE`; confirm the query uses `&&`/range operators the index supports; check the filter isn't wrapped in a non-indexable function |
| **Stale statistics** | Planner mis-estimates rows, picks a worse plan | Run `ANALYZE` after bulk loads; raise `default_statistics_target` for skewed columns |
| **Index bloat** | Index size grows, scans slow after many updates/deletes | `REINDEX` periodically; tune `fillfactor`; remember immutable lineage tables bloat mostly from vacuum lag |
| **BRIN with unordered rows** | BRIN index built but scans read the whole table | Ensure append-only insertion order or `CLUSTER` on the timestamp; verify correlation with `pg_stats.correlation` |
| **Over-indexing** | Ingestion throughput drops | Drop indexes that no SLA query uses; measure write cost before adding covering indexes |

## Compliance & governance alignment

Fast, predictable retrieval is itself a control objective: an audit is only defensible if the evidence can be produced within the response time regulators or contracts require. Index tuning is how you meet the availability and timeliness expectations that sit alongside the retention rules described in the [object storage WORM retention](https://www.provenance-tracking.com/storage-indexing-query-optimization/object-storage-worm-retention/) guide.

| Control / practice | Requirement | Index tuning contribution |
|--------------------|-------------|---------------------------|
| Audit response SLA | Produce lineage evidence within a bounded time | GiST + BRIN prefilter keeps spatial-temporal audit queries within latency budget |
| NIST 800-53 AU-7 (Audit Reduction & Reporting) | On-demand reporting without altering records | Read-only index scans over immutable rows serve reports without mutation |
| Data availability objectives | Meet recovery/response time targets | Covering indexes reduce heap I/O, stabilizing query latency under load |
| ISO 19115 lineage retrieval | Locate authoritative lineage for a feature | Bounding-box prefilter maps a feature's extent to its lineage rows efficiently |

Treat index design as an ongoing discipline rather than a one-time setup. As lineage volumes grow and query patterns shift, re-baseline with `EXPLAIN ANALYZE`, prune indexes that no SLA query exercises, and keep statistics fresh so the planner's choices continue to match the access patterns your audits actually depend on.
