# Capturing Lineage for AWS Location Service Operations

Geocoding an address, snapping a GPS trace to roads, or calculating a route through AWS Location Service each derives new spatial data from a managed provider, and when that output flows into a downstream dataset you need a record of which operation produced it and against which resource. This how-to wraps `boto3` Location Service calls so every place, route, and map request emits a JSON lineage document. It sits under [Structuring JSON/XML Lineage Documents](https://www.provenance-tracking.com/storage-indexing-query-optimization/structuring-jsonxml-lineage-documents/), and the emitted documents are designed to land in a write-once archive such as [Object Storage WORM Retention](https://www.provenance-tracking.com/storage-indexing-query-optimization/object-storage-worm-retention/).

## Prerequisites

- Python 3.10+ and `boto3` 1.34+.
- An IAM principal with `geo:SearchPlaceIndexForText`, `geo:CalculateRoute`, and related `geo:*` permissions for the resources you call.
- Existing AWS Location resources: a Place Index and/or a Route Calculator, created in the same region as your client.
- AWS credentials via `AWS_PROFILE`, environment variables, or an instance role. Set `AWS_REGION` to match your Location resources.

## Implementation

The wrapper records the operation name, the target Location resource, a hashed request payload (so the same query is deduplicated and no raw address is stored in the clear), a summary of the response geometry, and the AWS request id from the response metadata. That request id is the anchor that ties your lineage record back to CloudTrail.

```python
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import boto3


def geocode_with_lineage(
    place_index_name: str,
    text: str,
    lineage_dir: str | Path,
    max_results: int = 1,
) -> dict[str, Any]:
    """Geocode text via AWS Location and emit a JSON lineage document.

    Args:
        place_index_name: Name of the Location Service Place Index resource.
        text: The address or place text to geocode.
        lineage_dir: Directory that receives the .json lineage document.
        max_results: Maximum number of candidate results to request.

    Returns:
        The lineage document written to disk.
    """
    out_dir = Path(lineage_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    client = boto3.client("location")
    requested_at = datetime.now(timezone.utc)

    response = client.search_place_index_for_text(
        IndexName=place_index_name,
        Text=text,
        MaxResults=max_results,
    )

    # Never persist the raw query text; hash it so records stay privacy-safe.
    query_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()

    results = response.get("Results", [])
    positions: list[list[float]] = [
        r["Place"]["Geometry"]["Point"]
        for r in results
        if r.get("Place", {}).get("Geometry", {}).get("Point")
    ]

    summary = response.get("Summary", {})
    lineage: dict[str, Any] = {
        "event": "location_geocode",
        "operation": "SearchPlaceIndexForText",
        "resource": place_index_name,
        "data_source": summary.get("DataSource", "UNKNOWN"),
        "query_sha256": query_hash,
        "result_count": len(results),
        "positions": positions,  # [lon, lat] pairs, EPSG:4326
        "crs": "EPSG:4326",
        "aws_request_id": response["ResponseMetadata"]["RequestId"],
        "requested_at": requested_at.isoformat(),
    }

    record_name = f"{lineage['operation']}_{query_hash[:16]}.json"
    (out_dir / record_name).write_text(json.dumps(lineage, indent=2), encoding="utf-8")
    return lineage


if __name__ == "__main__":
    doc = geocode_with_lineage(
        place_index_name="agency-places",
        text="1600 Pennsylvania Ave NW, Washington, DC",
        lineage_dir="./lineage",
    )
    print("Captured", doc["operation"], "from", doc["data_source"])
```

The `data_source` field from the response `Summary` (for example `Esri` or `Here`) is essential provenance: AWS Location proxies third-party providers whose licensing and accuracy differ, so a record that omits the provider cannot support a downstream accuracy claim.

## Verification

Cross-reference the captured `aws_request_id` against CloudTrail to prove the call happened as recorded:

```python
import boto3

ct = boto3.client("cloudtrail")
events = ct.lookup_events(
    LookupAttributes=[
        {"AttributeKey": "EventName", "AttributeValue": "SearchPlaceIndexForText"}
    ],
    MaxResults=5,
)
for e in events["Events"]:
    print(e["EventTime"], e["EventId"])
```

The event time in CloudTrail should fall within seconds of the `requested_at` timestamp in your JSON document, and the operation name must match. A lineage record whose request id has no CloudTrail counterpart indicates the call was mocked or replayed and should not be trusted as evidence.

## Gotchas & edge cases

- **Coordinate order is `[longitude, latitude]`.** AWS Location returns and expects GeoJSON-style `[lon, lat]` positions, the reverse of the `lat, lon` order humans write. Store the order explicitly, as above, or a downstream consumer that assumes `[lat, lon]` will place every point in the wrong hemisphere.
- **Route geometry can be large and unstable.** `CalculateRoute` with `IncludeLegGeometry` returns a dense polyline that differs run-to-run as the provider updates its road graph. Hash a normalized summary (distance, duration, waypoint order) rather than the full geometry, or identical routing intents will appear as distinct lineage events.
- **Records must be immutable to count as evidence.** A lineage document that can be edited after the fact proves nothing. Write each document once and push it to a locked store as described in [Object Storage WORM Retention](https://www.provenance-tracking.com/storage-indexing-query-optimization/object-storage-worm-retention/), so the provider, request id, and geometry summary cannot be altered after capture. Keep the schema aligned with [Structuring JSON/XML Lineage Documents](https://www.provenance-tracking.com/storage-indexing-query-optimization/structuring-jsonxml-lineage-documents/) so Location events query the same way as every other source.
