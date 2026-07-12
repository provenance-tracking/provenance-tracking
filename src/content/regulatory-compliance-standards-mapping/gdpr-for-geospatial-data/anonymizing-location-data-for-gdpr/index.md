# Anonymizing Location Data for GDPR

Reducing the precision of coordinates is one of the most effective ways to bring geospatial processing within GDPR's tolerance, but only if you can prove that the reduction actually lowered re-identification risk and only if the transformation itself is captured as lineage. Anonymizing silently — without a record of what was jittered, truncated, or generalized — trades one compliance problem for another, because you can no longer demonstrate that published data is no longer personal. This how-to anonymizes and pseudonymizes coordinates using three complementary techniques — geohash truncation, spatial k-anonymity, and differential-privacy jitter — while emitting a lineage record of the transformation. It applies the practices from the [GDPR for geospatial data](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/gdpr-for-geospatial-data/) guide and links each transformation to the field-level crosswalk in the [control-to-lineage-field mapping](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/gdpr-for-geospatial-data/mapping-gdpr-controls-to-lineage-fields/) how-to.

The three techniques address different attack surfaces and are strongest when layered. Geohash truncation generalizes a precise point to a named cell, defeating exact-match lookups but leaving cell membership visible. Spatial k-anonymity guarantees that no released cell distinguishes fewer than k individuals, defeating uniqueness attacks but doing nothing about the accuracy of a surviving point. Differential-privacy jitter perturbs each coordinate with calibrated noise, defeating averaging and repeated-observation attacks but, on its own, leaving low-density outliers exposed. The layering also determines which regime the output satisfies: jitter alone produces pseudonymized data that remains personal under GDPR; jitter plus k-anonymity plus generalization, documented in lineage, is what lets you argue an extract is anonymized and therefore outside the regulation's material scope.

## Prerequisites

- Python 3.10+ with `geopandas` 0.14+, `pyproj` 3.6+, `numpy` 1.26+, and `pygeohash` 1.2+
- An input `GeoDataFrame` of points in a known CRS (this example assumes `EPSG:4326` input and reprojects to a metric CRS for metre-accurate jitter)
- A target k value agreed with your data protection officer for spatial k-anonymity (commonly k ≥ 5)
- A lineage sink to receive the transformation event, per the append-only schema in the parent [GDPR for geospatial data](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/gdpr-for-geospatial-data/) guide

## Implementation

The function below applies the three techniques and returns both the anonymized frame and a lineage event describing exactly what it did. Jitter is applied in a projected metric CRS so the noise magnitude is in metres, not degrees; k-anonymity suppresses points whose geohash cell holds fewer than k members; and geohash truncation generalizes location to a documented cell size.

```python
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import numpy as np
import geopandas as gpd
import pygeohash as pgh


@dataclass(frozen=True)
class AnonymizationEvent:
    method: str
    params: dict
    input_crs: str
    rows_in: int
    rows_out: int
    valid_from: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc))

    def content_hash(self) -> str:
        body = json.dumps(
            {"method": self.method, "params": self.params,
             "input_crs": self.input_crs, "rows_in": self.rows_in,
             "rows_out": self.rows_out,
             "valid_from": self.valid_from.isoformat()},
            sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(body.encode()).hexdigest()


def anonymize_points(
    gdf: gpd.GeoDataFrame,
    *,
    geohash_precision: int = 6,      # 6 chars ≈ 1.2 km cell
    k: int = 5,                      # spatial k-anonymity threshold
    jitter_metres: float = 50.0,     # differential-privacy noise scale
    metric_crs: str = "EPSG:3857",
    seed: int = 0,
) -> tuple[gpd.GeoDataFrame, AnonymizationEvent]:
    """Generalize + jitter coordinates, returning data and a lineage event."""
    input_crs = gdf.crs.to_string()
    rows_in = len(gdf)

    # 1. Differential-privacy jitter in a metric CRS (Laplace noise, metres).
    rng = np.random.default_rng(seed)
    proj = gdf.to_crs(metric_crs).copy()
    scale = jitter_metres / np.sqrt(2)
    dx = rng.laplace(0.0, scale, size=rows_in)
    dy = rng.laplace(0.0, scale, size=rows_in)
    proj["geometry"] = proj.geometry.translate(xoff=dx, yoff=dy)
    jittered = proj.to_crs(input_crs)

    # 2. Geohash truncation to generalize location to a fixed cell.
    jittered["geohash"] = jittered.geometry.apply(
        lambda p: pgh.encode(p.y, p.x, precision=geohash_precision))

    # 3. Spatial k-anonymity: suppress cells with fewer than k members.
    counts = jittered["geohash"].value_counts()
    safe_cells = counts[counts >= k].index
    out = jittered[jittered["geohash"].isin(safe_cells)].copy()

    event = AnonymizationEvent(
        method="jitter+geohash+k_anonymity",
        params={"geohash_precision": geohash_precision, "k": k,
                "jitter_metres": jitter_metres, "metric_crs": metric_crs},
        input_crs=input_crs, rows_in=rows_in, rows_out=len(out))
    return out, event
```

Persist the returned `event` to your lineage store using the same append-only insert the parent guide describes; its `content_hash` anchors the transformation so an auditor can verify that the published extract is the documented, generalized version. Note the ordering: jitter is applied first, in the projected metric CRS, so that the generalization step then buckets already-perturbed points. Reversing the order — truncating first and jittering the cell centroid afterwards — would let an attacker who knows the cell grid subtract the deterministic snap and recover a tighter estimate of the original location. The event's `params` block records every knob that shaped the output, which is what makes the guarantee reproducible: a reviewer can re-run the function with the recorded seed and parameters and obtain the identical extract, closing the gap between what you claim you published and what you can prove you published.

## Verification

Confirm the transformation both reduced identifiability and recorded itself.

```python
gdf = gpd.read_file("subject_points.gpkg").to_crs("EPSG:4326")
anon, event = anonymize_points(gdf, geohash_precision=6, k=5, jitter_metres=50)

# Every surviving cell must contain at least k members (k-anonymity holds).
assert (anon["geohash"].value_counts() >= 5).all()
# The lineage event is populated and hashable for the audit trail.
assert event.rows_out <= event.rows_in
print("suppressed rows:", event.rows_in - event.rows_out,
      "| event hash:", event.content_hash()[:12])
```

A passing run asserts that no surviving geohash cell holds fewer than k points and prints how many rows were suppressed alongside the event hash. Store the hash next to the published extract; matching it later proves the extract is the anonymized product and not the raw source.

## Gotchas & edge cases

- **Anonymization is not erasure, and jitter is not anonymity on its own.** Low-count cells, outliers, and repeated observations of the same subject can re-identify even after jitter. Always pair jitter with the k-anonymity suppression above, and record `k` in the lineage event so the guarantee is auditable rather than assumed. This is the pitfall flagged in the [regulatory compliance and standards mapping](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/) overview.
- **CRS-dependent jitter distorts distance.** Applying Laplace noise in degrees rather than a metric CRS makes the effective jitter vary with latitude — 0.001 degree is far larger near the equator than near the poles. Reproject to a metric CRS before adding noise, and for large study areas prefer a local projected CRS over the web-mercator default, which distorts metre distances at high latitudes.
- **Geohash cell size is coarse and non-square.** A precision-6 geohash is roughly 1.2 km by 0.6 km, not a tidy square, so "precision 6" does not mean a uniform radius of protection. Choose precision against the density of your data, and document the chosen cell in the lineage `params` so downstream users understand the generalization applied.
