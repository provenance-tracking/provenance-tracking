# PostGIS vs Neo4j for Spatial Lineage

Choosing a storage engine for spatial lineage is a decision you make once and live with for years, because the choice dictates how you model derivation chains, how you export audit evidence, and how much your team must learn before the first production query runs. The two credible options for most GIS organizations are PostGIS — a relational engine with mature spatial types and recursive common table expressions — and Neo4j, a native graph database whose storage layout treats derivation edges as first-class, index-free adjacencies. Both can answer the core provenance question, "which raw scenes produced this published raster," but they answer it with very different performance curves, operational demands, and compliance ergonomics.

This guide frames the decision rather than declaring a universal winner. It maps each engine against the dimensions that actually drive the outcome — traversal depth, spatial operation richness, team skills, licensing cost, and audit export — then shows the same lineage traversal written in both `WITH RECURSIVE` SQL and Cypher so you can weigh the query ergonomics for yourself. For the broader context of how storage choices fit the overall pipeline, start from the [Storage, Indexing & Query Optimization](https://www.provenance-tracking.com/storage-indexing-query-optimization/) overview, which situates this comparison alongside indexing and document-structuring concerns.

<svg viewBox="0 0 600 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decision tree for choosing PostGIS or Neo4j for spatial lineage based on traversal depth, spatial operations, and team skills">
<title>PostGIS vs Neo4j decision tree</title>
<rect width="600" height="340" fill="#fffdf8" rx="10"/>
<defs><marker id="dt" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#2b1d12"/></marker></defs>
<rect x="210" y="14" width="180" height="46" rx="8" fill="#2b1d12"/>
<text x="300" y="34" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="700" fill="#fffdf8">Start: pick lineage store</text>
<text x="300" y="50" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">geospatial provenance graph</text>
<rect x="200" y="94" width="200" height="46" rx="8" fill="#5a3c25"/>
<text x="300" y="114" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">Traversal depth &gt; 6 hops,</text>
<text x="300" y="130" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">variable, branch-heavy?</text>
<line x1="300" y1="60" x2="300" y2="94" stroke="#2b1d12" stroke-width="2" marker-end="url(#dt)"/>
<rect x="30" y="180" width="180" height="46" rx="8" fill="#3f5a30"/>
<text x="120" y="200" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">Heavy spatial ops</text>
<text x="120" y="216" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">ST_Intersects, buffers?</text>
<rect x="390" y="180" width="180" height="46" rx="8" fill="#b85c3b"/>
<text x="480" y="203" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">Neo4j</text>
<text x="480" y="218" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">native graph traversal</text>
<line x1="240" y1="140" x2="140" y2="180" stroke="#2b1d12" stroke-width="2" marker-end="url(#dt)"/>
<text x="168" y="164" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" font-weight="700" fill="#2b1d12">No</text>
<line x1="360" y1="140" x2="460" y2="180" stroke="#2b1d12" stroke-width="2" marker-end="url(#dt)"/>
<text x="432" y="164" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" font-weight="700" fill="#2b1d12">Yes</text>
<rect x="30" y="266" width="180" height="52" rx="8" fill="#5e7b4a"/>
<text x="120" y="288" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">PostGIS</text>
<text x="120" y="303" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">recursive CTE + geometry</text>
<line x1="120" y1="226" x2="120" y2="266" stroke="#2b1d12" stroke-width="2" marker-end="url(#dt)"/>
<rect x="250" y="266" width="200" height="52" rx="8" fill="#c8a781"/>
<text x="350" y="286" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#2b1d12">Hybrid: PostGIS of record,</text>
<text x="350" y="301" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#2b1d12">Neo4j read replica for graph</text>
<line x1="200" y1="226" x2="300" y2="266" stroke="#5a3c25" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#dt)"/>
</svg>

## The comparison matrix

The table below distills the trade-offs across the dimensions that most affect a spatial lineage deployment. Treat it as a scoring sheet: no single column wins every row, and your weighting depends on whether deep traversal or spatial computation dominates your workload.

| Dimension | PostGIS 3.4+ | Neo4j 5.x |
|-----------|--------------|-----------|
| **Data model** | Relational tables; lineage as self-referential foreign keys or edge table | Native property graph; derivation edges are first-class records |
| **Deep traversal (>6 hops)** | Works via `WITH RECURSIVE`, but cost grows with intermediate row materialization | Index-free adjacency; near-constant cost per hop regardless of depth |
| **Spatial operations** | Full OGC suite: `ST_Intersects`, `ST_Buffer`, `ST_Transform`, GiST indexes | Point/distance via spatial functions and plugins; no true geometry algebra |
| **Query language** | SQL, widely known; recursive CTEs are verbose but portable | Cypher; expressive for paths, a new language for most teams |
| **Write throughput** | High for tabular inserts; edge-table writes are cheap | High with batched `MERGE`; constraint checks add overhead |
| **Ops burden** | One engine your DBAs already run; backups, replication mature | A second datastore to patch, back up, and monitor |
| **Licensing / cost** | Open source (PostgreSQL license); no per-core fees | Community edition limited; Enterprise clustering is commercially licensed |
| **Audit / compliance export** | SQL result sets, temporal tables, `COPY` to CSV/JSON | Cypher exports to JSON/CSV; graph shape maps cleanly to PROV-O |
| **Existing skills** | Ubiquitous in GIS shops; ties into ArcGIS/QGIS stacks | Rarer; requires graph modeling investment |

## Criterion 1: traversal depth and branching

The sharpest technical divide is how each engine scales as lineage chains deepen. In PostGIS a recursive lineage query re-materializes intermediate result rows at every level; a ten-hop chain that fans out across dozens of upstream scenes forces the planner to accumulate and de-duplicate a growing working set. For the shallow, mostly-linear derivation chains typical of a single agency's raster pipeline — three to six transformation steps — this cost is negligible and the recursive CTE returns in milliseconds. Neo4j's advantage only becomes decisive when chains are deep, highly branched, or when you routinely ask open-ended questions like "everything downstream of this scene, at any depth." Its index-free adjacency means each hop is a pointer dereference rather than a join, so a fifteen-hop impact-analysis query stays predictable where the SQL equivalent degrades.

If your workload is dominated by deep, variable-depth reachability queries, that pushes you toward the native graph model described in [Graph Databases for Lineage Graphs](https://www.provenance-tracking.com/storage-indexing-query-optimization/graph-databases-for-lineage-graphs/). If it is dominated by shallow lookups joined against attributes, PostGIS handles it without a second system.

## Criterion 2: spatial operations

Provenance for geospatial data is not purely topological — you frequently need to answer questions that mix lineage with geometry. "Which source tiles overlapped this administrative boundary and fed the published mosaic?" requires both an edge traversal and an `ST_Intersects` test. Here PostGIS is unambiguously stronger. It carries the full OGC Simple Features suite, GiST and BRIN spatial indexes, `ST_Transform` for on-the-fly reprojection, and datum-shift support through PROJ. Neo4j offers point geometry and distance functions but has no true geometry algebra: no polygon intersection, no buffer, no reprojection. Teams that need graph traversal *and* rich spatial predicates typically keep geometry in PostGIS and either replicate a lightweight edge structure into Neo4j or accept richer traversal cost in SQL. The schema patterns for keeping geometry and lineage coherent in the relational model are covered in [PostGIS Lineage Schema Design](https://www.provenance-tracking.com/storage-indexing-query-optimization/postgis-lineage-schema-design/).

## Criterion 3, 4 and 5: skills, cost, and audit export

Three practical criteria often decide the matter regardless of raw performance. **Team skills:** SQL is universal in GIS organizations and integrates directly with ArcGIS, QGIS, and existing ETL tooling; Cypher is a genuine learning investment that pays off only if the graph workload justifies it. **Cost and operations:** PostGIS adds no engine your team is not already running, while Neo4j is a second datastore to secure, patch, back up, and monitor — and its clustering and hot-backup capabilities sit behind the commercial Enterprise license. **Compliance and audit export:** both can produce the immutable, timestamped chain of custody that FISMA and ISO 19115 lineage sections demand, but they export differently. PostGIS leans on temporal tables and SQL result sets that auditors and analysts already read; Neo4j's graph shape maps almost directly onto the PROV-O `Entity`–`Activity`–`Agent` triple, so exporting a JSON-LD provenance document is a shorter transformation. The concrete Neo4j modeling approach for that mapping is detailed in [Using Neo4j to Map Geospatial Lineage](https://www.provenance-tracking.com/storage-indexing-query-optimization/graph-databases-for-lineage-graphs/using-neo4j-to-map-geospatial-lineage/).

## The same traversal in both engines

Nothing clarifies the ergonomic difference like reading the identical query — "return the full upstream chain that produced a target dataset" — in each language. First, PostGIS with a recursive CTE over a self-referential edge table:

```sql
WITH RECURSIVE lineage AS (
    -- anchor: the dataset we are auditing
    SELECT d.dataset_id,
           d.dataset_uri,
           d.crs,
           e.parent_id,
           1 AS depth
    FROM   dataset d
    JOIN   derivation_edge e ON e.child_id = d.dataset_id
    WHERE  d.dataset_id = :target_id

    UNION ALL

    -- recursive step: walk one hop upstream per iteration
    SELECT p.dataset_id,
           p.dataset_uri,
           p.crs,
           e.parent_id,
           l.depth + 1
    FROM   lineage l
    JOIN   dataset p          ON p.dataset_id = l.parent_id
    JOIN   derivation_edge e  ON e.child_id   = p.dataset_id
    WHERE  l.depth < 10   -- guard against runaway recursion
)
SELECT dataset_id, dataset_uri, crs, depth
FROM   lineage
ORDER  BY depth;
```

The `depth < 10` predicate is not optional decoration — without an explicit ceiling a cyclic edge (which malformed ingestion can introduce) turns the CTE into an unbounded loop. Now the same traversal in Cypher against a property graph:

```cypher
MATCH path = (target:Dataset {dataset_id: $target_id})
             -[:DERIVED_FROM*1..10]->(source:Dataset)
RETURN [n IN nodes(path) | {
           dataset_id: n.dataset_id,
           dataset_uri: n.dataset_uri,
           crs: n.crs
       }] AS chain,
       length(path) AS depth
ORDER BY depth;
```

The Cypher version is shorter because the graph model makes "walk the `DERIVED_FROM` relationship one-to-ten hops" a single pattern, with no anchor/recursive-step split and no manually reconstructed working set. The SQL version, however, runs inside a database that also holds the geometry, so a `WHERE ST_Intersects(p.geom, :aoi)` clause drops straight into the recursive step — something the Cypher query cannot express natively. This is the trade in miniature: Cypher wins on traversal clarity, SQL wins on integrated spatial predicates.

A minimal Python harness lets you benchmark both against your own chain depths before committing:

```python
from neo4j import GraphDatabase  # neo4j driver 5.x
import psycopg  # psycopg 3.x

def postgis_lineage(dsn: str, target_id: int) -> list[dict]:
    sql = open("lineage_recursive.sql").read()
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(sql, {"target_id": target_id})
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]

def neo4j_lineage(uri: str, auth: tuple[str, str], target_id: int) -> list[dict]:
    cypher = (
        "MATCH path = (t:Dataset {dataset_id: $tid})"
        "-[:DERIVED_FROM*1..10]->(s:Dataset) "
        "RETURN length(path) AS depth"
    )
    with GraphDatabase.driver(uri, auth=auth) as driver:
        with driver.session() as session:
            return [r.data() for r in session.run(cypher, tid=target_id)]
```

## Write path and operational reality

Lineage stores are write-heavy during processing windows and read-heavy during audits, and the two engines behave differently under that asymmetry. PostGIS absorbs high-volume tabular inserts trivially — an edge row is three integers and a timestamp — and its write path is the same one your DBAs already tune, back up, and replicate. Point-in-time recovery, streaming replication, and connection pooling are solved problems with a decade of operational muscle memory behind them. Neo4j sustains high write throughput too, but only with disciplined batching: single-node `MERGE` calls in a loop will bottleneck on constraint checks, so ingestion must group nodes into transactions of a few thousand, exactly as covered in the graph modeling guide. Its backup and clustering story is capable but newer to most GIS teams, and the hot-backup and causal-clustering features that regulated deployments lean on are gated behind the Enterprise license.

The read path inverts the comparison. A three-hop audit query costs both engines almost nothing, but the open-ended "show me everything downstream, at any depth" question — the one compliance officers ask during an incident — is where Neo4j's index-free adjacency pulls ahead and where a PostGIS recursive CTE begins materializing large intermediate sets. If your audit pattern is dominated by targeted, shallow lookups, this advantage rarely materializes; if it is dominated by open-ended impact analysis, it can be the difference between a sub-second answer and a query you cancel.

## Migration and lock-in considerations

The decision is easier to reverse in one direction than the other. Exporting lineage from PostGIS into a graph is mechanical: the edge table already encodes `parent → child` relationships, so a one-time `COPY` plus a `LOAD CSV` Cypher import reconstructs the graph faithfully. Going the other way — flattening a rich property graph back into normalized relational tables — is more work, because graph models tolerate heterogeneous edge properties that a fixed relational schema must anticipate. Teams uncertain about long-term traversal needs therefore often start in PostGIS, where the data lives beside the geometry and the export path stays open, and promote to a graph replica only once deep-traversal demand is proven. This staged approach also de-risks the skills investment: you validate that Cypher and graph modeling pay off on real queries before committing a second production system to your on-call rotation.

## Recommendation by scenario

**Choose PostGIS when** your derivation chains are shallow to moderate (under roughly six hops), your provenance queries frequently combine lineage with spatial predicates, your team already runs PostgreSQL, and you want a single engine of record with no additional licensing. This covers the large majority of municipal and single-agency GIS pipelines. Model lineage as a self-referential edge table and lean on temporal tables for the audit trail.

**Choose Neo4j when** deep, variable-depth, branch-heavy traversal is the dominant access pattern — cross-agency data-sharing lattices, multi-decade archives with dozens of transformation generations, or impact-analysis over highly reused source scenes — and when your compliance workflow benefits from a graph shape that maps directly to PROV-O. Accept that geometry-rich predicates will live elsewhere or be approximated.

**Choose a hybrid** when you need both: keep PostGIS as the authoritative store with full geometry and temporal history, then project a lightweight edge-only graph into Neo4j as a read replica for the deep-traversal and impact-analysis queries. This costs a second system and a synchronization job, but it lets each engine do what it does best. Whichever path you take, the modeling discipline — constrained node types, explicit edge semantics, CRS validation on ingest — matters more than the engine, and both the relational and graph guides above cover it in depth. Revisit the [Storage, Indexing & Query Optimization](https://www.provenance-tracking.com/storage-indexing-query-optimization/) overview to align the choice with your indexing and document-structuring decisions.
