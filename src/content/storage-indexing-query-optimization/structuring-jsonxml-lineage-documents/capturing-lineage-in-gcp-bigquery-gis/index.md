# Capturing Transformation Lineage for BigQuery GIS Jobs

A BigQuery GIS query that runs `ST_Intersects` or `ST_Union` across billions of rows is a transformation whose inputs, outputs, and geometry operations should be recorded, yet the SQL itself leaves no lineage behind once the results land. This how-to reads `INFORMATION_SCHEMA.JOBS` and each job's `referenced_tables` to reconstruct what a spatial query touched, then writes a JSON lineage document. It sits under [Structuring JSON/XML Lineage Documents](https://www.provenance-tracking.com/storage-indexing-query-optimization/structuring-jsonxml-lineage-documents/) and feeds the wider [Storage, Indexing & Query Optimization](https://www.provenance-tracking.com/storage-indexing-query-optimization/) practice.

## Prerequisites

- Python 3.10+ and `google-cloud-bigquery` 3.14+.
- A service account with `roles/bigquery.jobUser` plus `roles/bigquery.resourceViewer` (needed to read `INFORMATION_SCHEMA.JOBS` beyond your own jobs).
- The `GOOGLE_APPLICATION_CREDENTIALS` environment variable pointing at the key file, or Application Default Credentials configured.
- Knowledge of the region your jobs run in: `INFORMATION_SCHEMA.JOBS` is region-qualified, so a job run in the EU is invisible to a US query.

## Implementation

The function runs a spatial query, then queries the region-scoped `INFORMATION_SCHEMA.JOBS` view for that job id to recover its referenced tables, bytes processed, and slot time. It extracts the `ST_*` function names from the SQL text and assembles a lineage document.

```python
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from google.cloud import bigquery

ST_PATTERN = re.compile(r"\b(ST_[A-Z_]+)\s*\(", re.IGNORECASE)


def run_and_capture_lineage(
    client: bigquery.Client,
    sql: str,
    region: str,
    lineage_dir: str | Path,
) -> dict[str, Any]:
    """Run a BigQuery GIS query and write a JSON lineage document for the job.

    Args:
        client: An authenticated BigQuery client.
        sql: The GIS SQL to execute (may contain ST_* functions).
        region: Region qualifier for INFORMATION_SCHEMA, e.g. "region-us".
        lineage_dir: Directory that receives the .json lineage document.

    Returns:
        The lineage document written to disk.
    """
    out_dir = Path(lineage_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    query_job = client.query(sql)
    query_job.result()  # block until the job completes
    job_id = query_job.job_id

    # Pull authoritative job metadata from the region-scoped JOBS view.
    meta_sql = f"""
        SELECT
          job_id,
          creation_time,
          total_bytes_processed,
          total_slot_ms,
          destination_table,
          referenced_tables
        FROM `{region}`.INFORMATION_SCHEMA.JOBS
        WHERE job_id = @job_id
    """
    cfg = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("job_id", "STRING", job_id)]
    )
    row = next(iter(client.query(meta_sql, job_config=cfg).result()))

    def _fqtn(t: Any) -> str:
        return f"{t['project_id']}.{t['dataset_id']}.{t['table_id']}"

    inputs = [_fqtn(t) for t in (row.referenced_tables or [])]
    dest = row.destination_table
    output = _fqtn(dest) if dest else None
    spatial_ops = sorted({m.group(1).upper() for m in ST_PATTERN.finditer(sql)})

    lineage: dict[str, Any] = {
        "event": "bigquery_gis_transform",
        "job_id": job_id,
        "inputs": inputs,
        "output": output,
        "spatial_operations": spatial_ops,
        "total_bytes_processed": int(row.total_bytes_processed or 0),
        "total_slot_ms": int(row.total_slot_ms or 0),
        "job_created_at": row.creation_time.isoformat(),
        "captured_at": datetime.now(timezone.utc).isoformat(),
    }

    (out_dir / f"{job_id.replace(':', '_')}.json").write_text(
        json.dumps(lineage, indent=2), encoding="utf-8"
    )
    return lineage


if __name__ == "__main__":
    bq = bigquery.Client()
    doc = run_and_capture_lineage(
        client=bq,
        sql="""
            CREATE OR REPLACE TABLE geo.flood_parcels AS
            SELECT p.parcel_id, p.geom
            FROM geo.parcels AS p, geo.flood_zones AS f
            WHERE ST_Intersects(p.geom, f.geom)
        """,
        region="region-us",
        lineage_dir="./lineage",
    )
    print("Captured", doc["spatial_operations"], "over", doc["inputs"])
```

The `referenced_tables` array is the trustworthy source of inputs — parsing table names out of the SQL string is fragile against aliases, CTEs, and wildcard tables, whereas BigQuery populates `referenced_tables` from the actual query plan.

## Verification

Confirm the document names the tables the job really read by comparing against the JOBS view directly:

```sql
SELECT job_id, referenced_tables, destination_table
FROM `region-us`.INFORMATION_SCHEMA.JOBS
WHERE job_id = 'your_project:US.bquxjob_1a2b3c4d_00'
```

The `referenced_tables` returned here must match the `inputs` array in the JSON document element-for-element. If your document lists fewer tables than the view, the job read a partitioned or wildcard source that resolved to more tables than the SQL text suggests — a strong reason to trust `referenced_tables` over string parsing.

## Gotchas & edge cases

- **CRS is implicit and unlogged.** BigQuery GIS `GEOGRAPHY` values are always WGS84 (`EPSG:4326`) with geodesic edges; there is no per-column CRS. If a source table stored planar coordinates that were force-cast to `GEOGRAPHY`, the geometry is silently wrong and no lineage field will flag it. Record the ingestion CRS assumption upstream, since the transform record cannot recover it.
- **Region scoping loses cross-region jobs.** A single logical pipeline that runs staging in `region-eu` and marts in `region-us` needs two `INFORMATION_SCHEMA.JOBS` queries. Iterate over every region your datasets live in, or lineage for half the pipeline silently goes missing.
- **Script and multi-statement jobs.** A `CREATE OR REPLACE TABLE ... AS SELECT` runs as a parent script job whose child statements carry their own job ids; `referenced_tables` on the parent can be empty. Query `JOBS` with `parent_job_id = @job_id` to gather child references. Route the finished documents into the schema conventions described in [Structuring JSON/XML Lineage Documents](https://www.provenance-tracking.com/storage-indexing-query-optimization/structuring-jsonxml-lineage-documents/) so BigQuery lineage is queryable alongside every other source.
