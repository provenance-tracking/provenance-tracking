# Mapping ISO 19115 Lineage to an OGC API - Records Record

An ISO 19139 metadata file locks lineage inside a verbose XML tree that catalog clients cannot filter or search efficiently; publishing the same lineage as an OGC API - Records record makes it a queryable GeoJSON resource that a modern catalog can index and return over HTTP. This how-to projects the `LI_Lineage` structure assembled in [Implementing the ISO 19115-1 Lineage Model in a Spatial Pipeline](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/iso-19115-lineage-implementation/) into a Records-conformant GeoJSON record with a dedicated lineage property, so provenance travels with the discovery metadata rather than in a separate download.

## Prerequisites

- Python 3.10+ (standard library `json` is sufficient; no external dependency required).
- The `Lineage`, `Source`, and `ProcessStep` model from the [implementation overview](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/iso-19115-lineage-implementation/), or any equivalent structured lineage object.
- A catalog that serves the OGC API - Records "Record" core — each record is a GeoJSON Feature with `id`, `type`, `geometry`, `properties`, `links`, and `conformsTo`.
- A stable dataset identifier and bounding geometry (GeoJSON, `EPSG:4326` / CRS84 as the Records default).

## Implementation

The projection builds a GeoJSON Feature whose `properties` block carries the required Records fields (`type`, `title`, `created`) plus a nested `lineage` object derived directly from the ISO model. Each process step becomes an entry with its description, timestamp, and the source identifiers it consumed, and each source is echoed into the `links` array so clients can resolve inputs.

```python
from __future__ import annotations
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone

@dataclass
class Source:
    description: str
    citation_title: str
    identifier: str          # persistent URI — becomes a link href

@dataclass
class ProcessStep:
    description: str
    date_time: datetime
    processor_org: str
    source_ids: list[str] = field(default_factory=list)

@dataclass
class Lineage:
    statement: str | None = None
    sources: list[Source] = field(default_factory=list)
    steps: list[ProcessStep] = field(default_factory=list)

def to_records_record(lin: Lineage, *, record_id: str, title: str,
                      bbox_geometry: dict, created: datetime) -> dict:
    """Project an ISO 19115 lineage model into an OGC API - Records GeoJSON record."""
    source_links = [
        {
            "rel": "related",
            "href": src.identifier,
            "title": src.citation_title,
            "type": "application/json",
        }
        for src in lin.sources
    ]

    lineage_property = {
        "statement": lin.statement,
        "sources": [
            {"identifier": s.identifier, "title": s.citation_title,
             "description": s.description}
            for s in lin.sources
        ],
        "processSteps": [
            {
                "description": step.description,      # maps to LI_ProcessStep.description
                "stepDateTime": step.date_time.astimezone(timezone.utc).isoformat(),
                "processor": step.processor_org,
                "sources": step.source_ids,            # edges back to input identifiers
            }
            for step in lin.steps
        ],
    }

    return {
        "id": record_id,
        "conformsTo": [
            "http://www.opengis.net/spec/ogcapi-records-1/1.0/req/record-core"
        ],
        "type": "Feature",
        "geometry": bbox_geometry,
        "properties": {
            "type": "dataset",                         # resource type, not the GeoJSON type
            "title": title,
            "created": created.astimezone(timezone.utc).isoformat(),
            "lineage": lineage_property,               # ISO lineage lives here
        },
        "links": source_links,
    }

if __name__ == "__main__":
    lin = Lineage(
        statement="Orthorectified mosaic derived from three Sentinel-2 tiles.",
        sources=[Source("Sentinel-2 L1C tile T31UDQ", "Sentinel-2 MSI Level-1C",
                        "urn:asset:s2:T31UDQ:20260601")],
        steps=[ProcessStep(
            "Reprojected from EPSG:32631 to EPSG:3035 with cubic resampling.",
            datetime(2026, 6, 2, 9, 15, tzinfo=timezone.utc),
            "National Mapping Agency",
            ["urn:asset:s2:T31UDQ:20260601"],
        )],
    )
    record = to_records_record(
        lin,
        record_id="rec-mosaic-3035-20260602",
        title="Sentinel-2 orthomosaic (ETRS89-LAEA)",
        bbox_geometry={"type": "Polygon", "coordinates": [[
            [4.0, 51.0], [5.0, 51.0], [5.0, 52.0], [4.0, 52.0], [4.0, 51.0]]]},
        created=datetime(2026, 6, 2, 10, 0, tzinfo=timezone.utc),
    )
    print(json.dumps(record, indent=2))
```

The `properties.type` field is the resource type (`dataset`), distinct from the GeoJSON `type` of `Feature` at the top level — conflating the two is the most frequent mapping error. Lineage lives under `properties.lineage`; because Records treats `properties` as an open object, this custom key is valid while remaining invisible to clients that only read the core fields.

## Verification

Confirm the output is a valid GeoJSON Feature and that the lineage round-trips. A quick structural assertion catches the common omissions:

```python
import json
rec = json.loads(open("record.json").read())
assert rec["type"] == "Feature"
assert rec["properties"]["type"] == "dataset"
assert rec["properties"]["lineage"]["processSteps"][0]["description"]
assert rec["links"][0]["href"].startswith("urn:asset:")
print("OK — Records record carries resolvable lineage")
```

If your catalog exposes CQL2 filtering, you can then query records by lineage content — for example, retrieving every dataset whose processing referenced a given source identifier. This is the discovery payoff that the XML-only encoding cannot deliver, and it complements the graph-based traversal described in [graph databases for lineage graphs](https://www.provenance-tracking.com/storage-indexing-query-optimization/graph-databases-for-lineage-graphs/): the catalog answers "which published datasets exist", the graph answers "how deep does this chain go".

## Gotchas & edge cases

- **Property naming is not standardized for lineage.** The Records core defines `type`, `title`, `created`, `updated`, and `keywords`, but not a lineage field. Namespacing your key as `lineage` under `properties` is safe, yet consumers must know to read it; document the extension and keep the key stable so downstream CQL2 filters do not break. Avoid overloading the reserved `description` property with process-step text.
- **The links array is the only reliable place for resolvable inputs.** Embedding source identifiers solely inside the nested `lineage` object hides them from generic catalog clients, which walk `links` to discover related resources. Echo each `LI_Source` identifier into `links` with `rel: "related"` (or `rel: "derivedFrom"` if your profile defines it) so both machine crawlers and the lineage property stay consistent.
- **Geometry CRS defaults to CRS84, not EPSG:4326 axis order.** OGC API - Records expects coordinates in longitude, latitude order (CRS84). If your bounding box came from an `EPSG:4326` source that used latitude, longitude, swap the axes before writing the record or the footprint will be transposed. Reproject any projected extent (such as the ETRS89-LAEA output above) back to CRS84 for the record geometry while keeping the projected CRS documented in the lineage statement.
