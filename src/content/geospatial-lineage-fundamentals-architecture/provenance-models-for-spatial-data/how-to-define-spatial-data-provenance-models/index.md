# How to Define Spatial Data Provenance Models

To define spatial data provenance models, construct a directed acyclic graph (DAG) that explicitly links geospatial entities, transformation activities, and responsible agents while capturing spatial-specific metadata such as coordinate reference systems (CRS), geometry types, spatial resolution, and topology constraints. The process requires aligning your lineage schema with the [W3C PROV-O standard](https://www.w3.org/TR/prov-o/) and extending it with ISO 19115 spatial attributes, then instrumenting your ETL or GIS processing pipelines to emit machine-readable provenance records at every transformation step. This architecture ensures full auditability, supports regulatory compliance, and enables reproducible spatial analytics across government and enterprise environments.

For teams establishing baseline data governance, reviewing [Geospatial Lineage Fundamentals & Architecture](https://www.provenance-tracking.com/geospatial-lineage-fundamentals-architecture/) before implementation will clarify how spatial lineage integrates with broader enterprise metadata catalogs.

## Core Components of a Spatial Provenance Model

A functional spatial provenance model tracks four interconnected dimensions that differentiate it from generic tabular data lineage:

1. **Entities:** Source and derived datasets, raster tiles, vector layers, spatial indexes, and cached map services. Each entity requires persistent identifiers (URIs or UUIDs) and mandatory spatial descriptors: CRS, bounding box, feature count, geometry type, and spatial resolution.
2. **Activities:** Geoprocessing operations such as projection transformations, spatial joins, clipping, buffering, raster resampling, or topology validation. Activities must record input/output entities, execution timestamps, algorithm parameters, and spatial tolerance thresholds.
3. **Agents:** Human analysts, automated Python scripts, GIS desktop applications (QGIS, ArcGIS Pro), or cloud processing services (AWS Location, Google Earth Engine). Agents are linked to activities via `prov:wasAssociatedWith` or `prov:actedOnBehalfOf` relationships.
4. **Spatial Context:** Unlike tabular data, spatial models must explicitly capture CRS transformations, datum shifts, coordinate precision loss, and topology rule violations. These attributes directly impact analytical validity, cartographic accuracy, and compliance reporting.

When mapping these relationships, align your taxonomy with established patterns in [Provenance Models for Spatial Data](https://www.provenance-tracking.com/geospatial-lineage-fundamentals-architecture/provenance-models-for-spatial-data/) to prevent schema fragmentation and ensure cross-system interoperability.

## Step-by-Step Definition Process

### 1. Inventory Spatial Assets

Catalog all input datasets, intermediate outputs, and final deliverables. Extract embedded metadata from `.prj`, `.cpg`, ISO 19115 XML, or GeoPackage metadata tables using command-line utilities like `ogrinfo` or `gdalsrsinfo`. Automate extraction with Python's `osgeo` or `geopandas` to capture bounding boxes, CRS EPSG codes, and layer geometry types at ingestion.

### 2. Select a Serialization Format

PROV-JSON is recommended for Python automation due to native library support (`prov` package) and straightforward schema validation. Use JSON-LD if you require semantic web integration, linked data publishing, or RDF triplestore storage. Avoid proprietary formats that break cross-platform lineage queries.

### 3. Define Spatial Extensions

Extend PROV-O with a custom namespace (e.g., `spatial:`) to attach geospatial attributes. Common extensions include:

- `spatial:crs` (URI or EPSG code)
- `spatial:geometry_type` (Point, LineString, Polygon, etc.)
- `spatial:resolution` (pixel size or vertex precision)
- `spatial:tolerance` (snap distance, buffer radius, or topology threshold)
- `spatial:datum_shift` (boolean or transformation parameters)

### 4. Instrument Processing Pipelines

Embed provenance capture directly into your ETL/GIS workflows. Wrap geoprocessing functions with decorators or context managers that automatically log input entities, activity parameters, and output entities. Ensure every spatial operation emits a `prov:wasGeneratedBy` and `prov:used` relationship.

### 5. Validate & Store Lineage Records

Run emitted records through a PROV validator to check DAG acyclicity, required property presence, and namespace consistency. Store validated records in a graph database (Neo4j, Amazon Neptune) or a PROV-compliant metadata catalog. Index by CRS, project ID, and agent to accelerate compliance audits.

## Implementation & Validation Example

Below is a minimal PROV-JSON structure demonstrating how to attach spatial metadata to a raster resampling activity:

```json
{
  "entity": {
    "ex:input_dem": {
      "prov:type": "ex:RasterDataset",
      "spatial:crs": "EPSG:4326",
      "spatial:resolution": "30m",
      "spatial:geometry_type": "Grid"
    },
    "ex:output_dem_resampled": {
      "prov:type": "ex:RasterDataset",
      "spatial:crs": "EPSG:32610",
      "spatial:resolution": "10m",
      "spatial:geometry_type": "Grid"
    }
  },
  "activity": {
    "ex:resample_activity": {
      "prov:type": "ex:RasterResampling",
      "ex:algorithm": "bilinear",
      "ex:tolerance": "0.001",
      "prov:startTime": "2024-05-12T14:30:00Z",
      "prov:endTime": "2024-05-12T14:31:15Z"
    }
  },
  "wasGeneratedBy": {
    "ex:output_dem_resampled": { "activity": "ex:resample_activity" }
  },
  "used": {
    "ex:resample_activity": { "entity": "ex:input_dem" }
  }
}
```

In Python, use the `prov` library to generate this programmatically:

```python
from prov.model import ProvDocument

doc = ProvDocument()
doc.add_namespace("spatial", "http://example.org/spatial/")
doc.add_namespace("ex", "http://example.org/provenance/")

input_dem = doc.entity("ex:input_dem", {
    "prov:type": "ex:RasterDataset",
    "spatial:crs": "EPSG:4326",
    "spatial:resolution": "30m"
})

resample_act = doc.activity(
    "ex:resample_activity",
    "2024-05-12T14:30:00Z",
    "2024-05-12T14:31:15Z",
    {"ex:algorithm": "bilinear", "spatial:tolerance": "0.001"}
)

output_dem = doc.entity("ex:output_dem_resampled", {
    "prov:type": "ex:RasterDataset",
    "spatial:crs": "EPSG:32610",
    "spatial:resolution": "10m"
})

doc.wasGeneratedBy(output_dem, resample_act)
doc.used(resample_act, input_dem)

print(doc.serialize(format="json"))
```

Validate output against the official PROV schema using `prov.model.ProvDocument.is_valid()` or the W3C PROV-JSON validator before committing to production storage.

## Compliance & Operational Considerations

Government and enterprise GIS teams must ensure provenance records survive data migrations, format conversions, and cloud deployments. Implement the following controls:

- **CRS Chain Tracking:** Record every projection change. Unlogged datum shifts are a primary cause of spatial misalignment in multi-agency data sharing.
- **Precision Auditing:** Log coordinate precision loss during vector generalization or raster downscaling. Attach `spatial:precision_loss` metrics to activities that modify geometry fidelity.
- **Agent Attribution:** Map automated scripts to organizational roles using `prov:wasAttributedTo`. This satisfies audit requirements for regulated environments (e.g., FEMA flood mapping, EPA watershed modeling).
- **Immutable Storage:** Write provenance records to append-only logs or write-once object storage when regulatory frameworks require tamper-evident lineage trails.

By standardizing spatial extensions, automating pipeline instrumentation, and enforcing PROV-O compliance, organizations transform opaque geoprocessing workflows into transparent, queryable lineage graphs. This foundation enables rapid impact analysis, reproducible spatial modeling, and defensible compliance reporting across complex geospatial ecosystems.
