# Using Neo4j to Map Geospatial Lineage

Using Neo4j to map geospatial lineage requires modeling spatial datasets, coordinate transformations, and provenance events as a directed acyclic graph (DAG). Nodes represent immutable data artifacts and spatial extents, while directed edges capture derivation, aggregation, and projection shifts. Neo4j's native graph engine and spatial indexing allow GIS stewards and compliance teams to trace coordinate provenance, validate transformation chains, and generate audit-ready lineage reports without fragmented relational joins or manual metadata spreadsheets.

## Graph Schema & Spatial Modeling

Geospatial lineage differs from tabular lineage because spatial topology (containment, adjacency, projection shifts) is a first-class relationship alongside operational metadata. A production schema typically uses three core node types:

- **`Dataset`**: Holds immutable identifiers, source systems, coordinate reference systems (CRS), and ingestion timestamps.
- **`Transformation`**: Records processing steps (reprojection, clipping, tiling, buffering) with operator, parameters, and execution time.
- **`SpatialExtent`**: Stores bounding boxes using Neo4j's native `point` type (srid 4326 for WGS84 coordinates).

Edges like `DERIVED_FROM`, `APPLIED_TO`, and `COVERS` form the provenance chain. This topology aligns with W3C PROV-DM standards while preserving spatial relationships that relational models flatten into join tables. Teams designing these architectures should review how [Graph Databases for Lineage Graphs](https://www.provenance-tracking.com/storage-indexing-query-optimization/graph-databases-for-lineage-graphs/) handle recursive traversal and spatial joins before locking a production schema.

### Temporal Versioning for Government & Agency Data

Public sector datasets frequently undergo incremental boundary updates. Attach `valid_from` and `valid_to` datetime properties to both `Dataset` and `Transformation` nodes. Reconstruct historical lineage using Cypher temporal predicates:

```cypher
MATCH (ds:Dataset)-[t:APPLIED_TO]->(tx:Transformation)
WHERE t.applied_at >= ds.valid_from AND t.applied_at < ds.valid_to
RETURN ds.id, tx.transform_type, t.applied_at
```

This prevents compliance officers from misattributing coordinate shifts to incorrect processing steps and ensures point-in-time audit accuracy.

## Production Ingestion & Query Code

The following Python snippet uses the official `neo4j` driver (v5.x) to ingest a geospatial lineage record and query upstream dependencies. It assumes Neo4j 5.10+ with spatial functions enabled.

```python
from neo4j import GraphDatabase

URI = "bolt://localhost:7687"
AUTH = ("neo4j", "secure_password")

def ingest_geospatial_lineage(
    driver,
    dataset_id: str,
    crs: str,
    bbox: dict,
    parent_id: str,
    transform_type: str
) -> str:
    """Ingest a new dataset node, its spatial extent, and link to upstream parent."""
    cypher = """
    CREATE (ds:Dataset {
        id: $ds_id,
        crs: $crs,
        ingested_at: datetime(),
        valid_from: datetime()
    })
    CREATE (ext:SpatialExtent {
        bbox_min: point({x: $minx, y: $miny, srid: 4326}),
        bbox_max: point({x: $maxx, y: $maxy, srid: 4326})
    })
    CREATE (ds)-[:HAS_EXTENT]->(ext)
    WITH ds
    OPTIONAL MATCH (parent:Dataset {id: $parent_id})
    FOREACH (_ IN CASE WHEN parent IS NOT NULL THEN [1] ELSE [] END |
        CREATE (ds)-[:DERIVED_FROM {applied_at: datetime(), transform_type: $transform_type}]->(parent)
    )
    RETURN ds.id AS created_dataset
    """
    with driver.session() as session:
        result = session.run(
            cypher,
            ds_id=dataset_id,
            crs=crs,
            minx=bbox["minx"], miny=bbox["miny"],
            maxx=bbox["maxx"], maxy=bbox["maxy"],
            parent_id=parent_id,
            transform_type=transform_type
        )
        record = result.single()
        return record["created_dataset"] if record else dataset_id

def query_upstream_lineage(driver, dataset_id: str, max_depth: int = 5) -> list:
    """Recursively trace upstream datasets and their transformation metadata."""
    cypher = """
    MATCH path = (start:Dataset {id: $ds_id})-[:DERIVED_FROM*1..$depth]->(upstream:Dataset)
    UNWIND relationships(path) AS t
    RETURN upstream.id AS dataset_id,
           upstream.crs AS coordinate_system,
           t.transform_type AS operation,
           t.applied_at AS processed_at
    ORDER BY processed_at DESC
    """
    with driver.session() as session:
        return session.run(cypher, ds_id=dataset_id, depth=max_depth).data()
```

**Usage Notes:**

- Wrap ingestion in explicit transactions for high-throughput pipelines.
- Validate SRID consistency (`4326` for WGS84) before indexing to avoid spatial join mismatches.
- Use `datetime()` for automatic UTC normalization across distributed ingestion workers.

## Traversal Patterns & Query Optimization

Recursive lineage queries scale linearly with depth but require indexes to avoid full-graph scans. Create composite and spatial indexes early:

```cypher
CREATE INDEX dataset_id_idx FOR (d:Dataset) ON (d.id);
CREATE INDEX spatial_extent_min_idx FOR (e:SpatialExtent) ON (e.bbox_min);
```

For bounding-box proximity checks during lineage validation, leverage Neo4j's spatial distance function. The `point.distance()` function returns meters for geographic coordinates (srid 4326):

```cypher
MATCH (ds:Dataset)-[:HAS_EXTENT]->(ext:SpatialExtent)
WHERE point.distance(ext.bbox_min, point({x: $query_lon, y: $query_lat, srid: 4326})) < 1000
RETURN ds.id, ds.crs
```

When lineage graphs exceed 10M nodes, partition traversal by `valid_from` windows and cache intermediate paths using Neo4j's `apoc.path.subgraphNodes` procedure (from the [APOC library](https://neo4j.com/labs/apoc/)). Understanding how [Storage, Indexing & Query Optimization](https://www.provenance-tracking.com/storage-indexing-query-optimization/) impacts recursive graph scans ensures sub-second response times for compliance dashboards and automated validation pipelines.

## Compliance & Audit Integration

Regulatory frameworks (e.g., NOAA spatial data standards, EU INSPIRE directives) require immutable provenance trails. Neo4j's append-only edge model naturally satisfies this requirement. To formalize audit outputs, map graph nodes to PROV-DM entities:

- `Dataset` → `prov:Entity`
- `Transformation` → `prov:Activity`
- `DERIVED_FROM` → `prov:wasDerivedFrom`

Export lineage snapshots as PROV-JSON using the `neo4j` driver and a custom serializer, or use Cypher's `apoc.export.json.query` procedure to stream results directly. The W3C PROV Data Model specification outlines the exact semantic mappings required for cross-agency interoperability: [W3C PROV-DM Standard](https://www.w3.org/TR/prov-dm/).

**Audit Checklist for GIS Teams:**

- [ ] All coordinate transformations logged with input/output CRS
- [ ] Spatial extents versioned alongside dataset boundaries
- [ ] Transformation parameters stored as edge properties
- [ ] Point-in-time lineage queries validated against `valid_from`/`valid_to` windows
- [ ] Exported lineage reports signed and archived per retention policy

By anchoring spatial metadata in a graph structure, agencies eliminate spreadsheet drift, automate coordinate validation, and deliver regulator-ready lineage documentation on demand.
