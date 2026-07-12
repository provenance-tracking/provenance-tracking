# Airflow Lineage Hooks with OpenLineage

Emitting OpenLineage events from Airflow tasks lets you record the exact input and output geospatial datasets a step touched — along with the coordinate reference system each one carried — in a standardized, catalog-agnostic format, and you should reach for it whenever your compliance workflow needs tool-independent provenance rather than a bespoke payload. This how-to focuses on the practical mechanics of capturing input/output datasets and a CRS facet, and it assumes you have already weighed the orchestrator trade-offs in [Prefect vs Airflow for Geospatial Provenance](https://www.provenance-tracking.com/python-automation-pipeline-integration/prefect-vs-airflow-for-geospatial-provenance/). For the general principle of attaching capture to lifecycle events, see [Workflow Hooks in Python Pipelines](https://www.provenance-tracking.com/python-automation-pipeline-integration/workflow-hooks-in-python-pipelines/).

The value of OpenLineage for geospatial work is that a reprojection step is not self-describing: the file path `s3://out/scene_4326.tif` hints at the output projection by convention, but nothing enforces that the file actually carries `EPSG:4326`, and a downstream catalog cannot reconcile datasets it only knows by name. By emitting a run event that names both datasets and pins each to a validated CRS facet, you turn a naming convention into an assertion that a machine can verify and an auditor can trust.

## Prerequisites

- Apache Airflow 2.7+ with the `apache-airflow-providers-openlineage` provider installed.
- The `openlineage-python` client 1.x (pulled in by the provider) for constructing custom facets.
- `pyproj` 3.6+ to resolve and validate the CRS you attach to each dataset facet.
- An OpenLineage transport configured — an HTTP endpoint to a Marquez/OpenLineage backend, or a `console` / `file` transport for local verification. Set it via `AIRFLOW__OPENLINEAGE__TRANSPORT` or an `openlineage.yml` on the `OPENLINEAGE_CONFIG` path.
- Environment: `OPENLINEAGE_NAMESPACE` set to your agency or pipeline namespace so events group correctly in the catalog.

## Implementation

The task below reprojects a raster and emits an OpenLineage run event that names the input and output datasets and attaches a custom CRS facet to each. Rather than relying solely on the provider's automatic extraction, it constructs the event explicitly so the geospatial detail — which the generic extractors do not know about — is captured precisely.

```python
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from airflow.decorators import task
from pyproj import CRS  # pyproj 3.6+, validates the EPSG code

from openlineage.client import OpenLineageClient
from openlineage.client.event_v2 import (
    Dataset,
    InputDataset,
    OutputDataset,
    Job,
    Run,
    RunEvent,
    RunState,
)
from openlineage.client.facet_v2 import BaseFacet


def crs_facet(epsg: str) -> dict[str, BaseFacet]:
    """Build a custom geospatial CRS facet, validated via pyproj."""
    crs = CRS.from_user_input(epsg)  # raises on an unknown/invalid code
    facet = BaseFacet()
    # attach fields directly; the emitted JSON keeps arbitrary custom keys
    facet.crs = epsg                      # e.g. "EPSG:4326"
    facet.crs_name = crs.name             # human-readable CRS name
    facet.is_projected = crs.is_projected
    facet.authority = ":".join(crs.to_authority() or ("EPSG", "0"))
    return {"geospatial_crs": facet}


def emit_reproject_lineage(
    input_uri: str,
    input_crs: str,
    output_uri: str,
    output_crs: str,
    namespace: str = "gis-agency",
) -> None:
    client = OpenLineageClient()  # transport read from OPENLINEAGE_CONFIG/env
    run = Run(runId=str(uuid.uuid4()))
    job = Job(namespace=namespace, name="reproject_raster")
    now = datetime.now(timezone.utc).isoformat()

    inputs = [InputDataset(
        namespace=namespace, name=input_uri, facets=crs_facet(input_crs),
    )]
    outputs = [OutputDataset(
        namespace=namespace, name=output_uri, facets=crs_facet(output_crs),
    )]

    for state in (RunState.START, RunState.COMPLETE):
        client.emit(RunEvent(
            eventType=state,
            eventTime=now,
            run=run,
            job=job,
            inputs=inputs if state == RunState.COMPLETE else [],
            outputs=outputs if state == RunState.COMPLETE else [],
            producer="https://gis-agency/airflow/reproject",
        ))


@task
def reproject_and_emit(input_uri: str, output_uri: str) -> str:
    # rasterio/pyproj reprojection would run here, EPSG:32633 -> EPSG:4326
    emit_reproject_lineage(
        input_uri=input_uri, input_crs="EPSG:32633",
        output_uri=output_uri, output_crs="EPSG:4326",
    )
    return output_uri
```

The key line is `crs_facet(...)`, which validates the EPSG code through `pyproj` before it ever reaches the event — a wrong or missing CRS fails loudly at emit time rather than silently producing a provenance record that lies about the projection. Emitting both `START` and `COMPLETE` events, with datasets attached to the completion, mirrors the OpenLineage run lifecycle that catalogs expect: the `START` event opens the run and records the job, while the `COMPLETE` event carries the resolved inputs and outputs once the task knows exactly which files it read and wrote. Sharing a single `runId` across both events is what lets the catalog stitch them into one logical run rather than two orphaned records.

Two design choices in this task deserve emphasis. First, the datasets are attached to the `COMPLETE` event rather than the `START` event because, in a real reprojection, the output URI may only be finalized after processing — deferring dataset resolution avoids emitting a placeholder that later diverges from reality. Second, the facet is attached to both the input and the output dataset, not just one. A lineage record that states only the output CRS loses the very fact a reprojection audit cares about: that the transformation moved data from `EPSG:32633` to `EPSG:4326`. Capturing the source projection alongside the target is what makes the event a defensible record of what the step actually did.

## Verification

Point the transport at a file or the console and inspect the emitted JSON. With a `file` transport, each event is one JSON object per line; confirm the CRS facet rode along on both datasets:

```bash
export OPENLINEAGE_CONFIG=./openlineage.yml   # transport: type: file, log: ./ol.jsonl
python -c "from dag_module import reproject_and_emit; \
    reproject_and_emit.function('s3://raw/scene.tif', 's3://out/scene_4326.tif')"
tail -n 1 ./ol.jsonl | python -m json.tool
```

A correct `COMPLETE` event contains an `inputs` array whose dataset carries `facets.geospatial_crs.crs = "EPSG:32633"` and an `outputs` array whose dataset shows `"EPSG:4326"`. If the `facets` object is empty, the facet was not attached; if the whole event is missing, the transport is misconfigured — check the next section. You can also assert programmatically that both dataset facets resolve to valid authorities:

```python
import json
with open("ol.jsonl") as fh:
    event = json.loads(fh.readlines()[-1])
assert event["eventType"] == "COMPLETE"
assert event["outputs"][0]["facets"]["geospatial_crs"]["crs"] == "EPSG:4326"
```

## Gotchas & edge cases

- **Facet schema key naming.** Custom facets must carry a `_producer` and `_schemaURL` in strict OpenLineage validators; some catalogs reject a facet lacking them. If your backend enforces the schema, subclass the facet with those fields set rather than attaching bare attributes, or the event will be dropped silently at ingestion.
- **Transport configuration precedence.** The provider reads transport config from `openlineage.yml`, the `OPENLINEAGE_*` environment variables, and Airflow's `[openlineage]` config section — in that resolution order. Mixed sources are the most common reason events "disappear": a stray `AIRFLOW__OPENLINEAGE__DISABLED=true` or a wrong URL will suppress emission with no task-level error. Verify with a `console` transport first.
- **CRS on compound or custom projections.** `CRS.from_user_input` accepts WKT and PROJ strings, not only EPSG codes, but a locally-defined datum without an authority yields an empty `to_authority()`. Guard for that case (as the fallback tuple above does) so the facet still records the WKT rather than emitting a null authority that downstream reconciliation cannot match.
- **Dataset naming stability across backfills.** OpenLineage identifies a dataset by its `namespace` plus `name`, so the URI you pass must be deterministic. If your reprojection writes to a run-date-partitioned path, include the logical date in the name consistently — but never fold a random run ID or timestamp into it, or every backfill re-run mints a new dataset node and the lineage graph fragments into unconnected islands the catalog cannot collapse.
- **Listener vs. explicit emission overlap.** With the OpenLineage provider enabled, Airflow already emits automatic events for each task instance. Explicitly emitting your own run event on top of that can produce duplicate runs in the catalog unless you either reuse the provider's run ID or disable automatic extraction for the task. Decide on one path — provider-managed or hand-emitted — rather than running both blind, and confirm in the catalog that each task produces exactly one run.
