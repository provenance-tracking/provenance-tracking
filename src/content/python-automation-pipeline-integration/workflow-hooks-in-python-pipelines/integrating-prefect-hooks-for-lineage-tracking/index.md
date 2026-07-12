# Integrating Prefect Hooks for Lineage Tracking

Integrating Prefect hooks for lineage tracking requires attaching state-change callbacks to tasks and flows that capture input/output URIs, spatial reference identifiers, transformation parameters, and execution timestamps before persisting them to a structured provenance store. In geospatial pipelines, this means intercepting `on_completion`, `on_failure`, and `on_running` events to emit immutable audit records without modifying core data transformation logic. By decoupling metadata capture from business operations, GIS data stewards and compliance officers can satisfy ISO 19115 metadata requirements, agency data governance mandates, and W3C PROV-O provenance standards while maintaining pipeline performance. For broader architectural context, see how [Workflow Hooks in Python Pipelines](https://www.provenance-tracking.com/python-automation-pipeline-integration/workflow-hooks-in-python-pipelines/) enable decoupled observability across distributed ETL systems.

## How State-Change Callbacks Capture Provenance

Prefect 2.x exposes hook registration at both the task and flow level. Hooks execute synchronously within the worker process immediately after a state transition, granting direct access to the run context, input parameters, and the final `State` object. This design eliminates the need for intrusive `try/except` blocks or manual logging calls scattered throughout spatial transformation code. When building [Python Automation & Pipeline Integration](https://www.provenance-tracking.com/python-automation-pipeline-integration/) strategies for raster/vector ETL, hook-based lineage capture ensures that every coordinate transformation, clip operation, or format conversion automatically generates a machine-readable audit trail.

**Key advantages of hook-driven capture:**

- **Zero-touch instrumentation:** Business logic remains pure; metadata extraction happens externally.
- **State-aware execution:** Hooks receive the exact `State` object, enabling conditional routing for success, failure, or cancellation.
- **Context-rich payloads:** `get_run_context()` provides flow/task IDs, parameters, and upstream dependencies without global state pollution.
- **Framework-native reliability:** Hooks are managed by the Prefect engine, guaranteeing execution even when tasks raise unhandled exceptions.

## Core Implementation Pattern

The following implementation demonstrates how to capture geospatial lineage metadata using execution context, parameter inspection, and state introspection. Prefect 2.x requires hooks to accept a single `State` argument and run synchronously within the task/flow lifecycle.

```python
import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List
from prefect import flow, task, get_run_logger
from prefect.context import get_run_context
from prefect.states import State

# Replace with your agency's lineage API or metadata catalog
LINEAGE_REGISTRY: List[Dict[str, Any]] = []

def capture_geospatial_lineage(state: State) -> None:
    """Prefect hook that extracts execution context and writes lineage records."""
    ctx = get_run_context()
    logger = get_run_logger()

    # Safely extract parameters — available on flow_run context; guard with getattr
    params = getattr(ctx, "parameters", {}) or {}

    lineage_entry = {
        "execution_id": str(getattr(getattr(ctx, "flow_run", None), "id", "unknown")),
        "component_name": getattr(
            getattr(ctx, "task_run", None), "name",
            getattr(getattr(ctx, "flow", None), "name", "unknown")
        ),
        "state": state.type.value,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "input_sources": params.get("input_uris", []),
        "output_destination": params.get("output_uri", ""),
        "spatial_reference": params.get("crs", "UNDEFINED"),
        "operation_type": params.get("operation", "unknown"),
        "compliance_framework": os.getenv("AGENCY_LINEAGE_TAG", "ISO_19115_CORE")
    }

    LINEAGE_REGISTRY.append(lineage_entry)
    logger.info(
        "Lineage captured for %s [%s]",
        lineage_entry["component_name"], state.type.value
    )

@task(
    on_completion=[capture_geospatial_lineage],
    on_failure=[capture_geospatial_lineage]
)
def clip_raster(input_uris: List[str], output_uri: str, crs: str, operation: str) -> str:
    logger = get_run_logger()
    logger.info("Clipping %d raster(s) to %s (%s)", len(input_uris), output_uri, crs)
    # Production: integrate rasterio/gdal processing here
    return output_uri

@flow(
    name="agency_spatial_lineage_flow",
    on_completion=[capture_geospatial_lineage],
    on_failure=[capture_geospatial_lineage]
)
def run_geospatial_etl(raw_uris: List[str], processed_uri: str, target_crs: str) -> None:
    clip_raster(
        input_uris=raw_uris,
        output_uri=processed_uri,
        crs=target_crs,
        operation="raster_clip"
    )

if __name__ == "__main__":
    run_geospatial_etl(
        raw_uris=["s3://bucket/raw/aoi.tif"],
        processed_uri="s3://bucket/processed/aoi_clipped.tif",
        target_crs="EPSG:4326"
    )
```

## Configuration & Performance Constraints

When deploying this pattern at scale, consider the following architectural constraints:

- **Hook Execution Order:** Prefect runs hooks synchronously in registration order. If you attach multiple callbacks, ensure they are idempotent and avoid blocking network I/O. For high-throughput pipelines, batch lineage writes or push payloads to an async message queue.
- **Context Availability:** `get_run_context()` behaves differently at the flow vs. task level. Flow-level hooks receive `flow_run` context, while task-level hooks include `task_run` metadata. Always guard attribute access with `getattr()` to prevent `AttributeError` during dry runs or state retries.
- **State Filtering:** Not all state transitions warrant lineage records. Filter out `CANCELED` or `RETRYING` states if your compliance framework only requires final outcomes. Use `state.is_completed()` or `state.is_failed()` for precise control.
- **Parameter Serialization:** Prefect automatically serializes parameters, but complex objects (e.g., `geopandas.GeoDataFrame`) may fail JSON encoding. Pass URIs, CRS strings, and primitive types to hooks, and resolve heavy objects inside the task body. Refer to the official [Prefect Task Hooks documentation](https://docs.prefect.io/latest/concepts/tasks/#task-hooks) for lifecycle guarantees.

## Standards Compliance Mapping

Geospatial agencies must align automated lineage capture with established metadata standards. The hook payload above maps directly to:

- **ISO 19115-1:2014:** `input_sources` and `output_destination` populate the lineage section (`LI_Lineage`), while `recorded_at` satisfies process step timestamps.
- **W3C PROV-O:** `execution_id` acts as the `prov:Activity` identifier, and `component_name` links to `prov:Entity` derivatives. For formal validation, export the registry to PROV-N or JSON-LD. Consult the [W3C PROV-O specification](https://www.w3.org/TR/prov-o/) for exact property mappings and ontology alignment.
- **Agency Governance:** Tag records with environment variables (e.g., `AGENCY_LINEAGE_TAG`) to route metadata to FedRAMP-compliant catalogs or internal data dictionaries.

## Troubleshooting & Edge Cases

- **Missing Parameters in Hooks:** If `ctx.parameters` returns empty, verify that arguments are explicitly passed as keyword arguments. Prefect's parameter extraction relies on the function signature matching the invocation.
- **Hook Exceptions Silencing Failures:** Unhandled exceptions inside a hook can mask the original task error. Wrap lineage logic in `try/except` and log failures separately to preserve pipeline observability.
- **Duplicate Records on Retries:** Prefect retries tasks by creating new runs. If your lineage store lacks deduplication, you will see multiple entries for the same logical operation. Include `state.name` and the task run's `run_count` (available via `ctx.task_run.run_count`) in the payload to track retry lineage accurately.
- **Cross-Flow Dependencies:** Task-level hooks only see the immediate task context. To capture upstream/downstream flow relationships, attach a flow-level hook that aggregates child run IDs or use Prefect's artifact system to link execution graphs.

## Next Steps

Integrating Prefect hooks for lineage tracking transforms opaque spatial ETL processes into auditable, standards-compliant workflows. By intercepting state transitions at the framework level, teams can enforce ISO 19115 and PROV-O compliance without sacrificing pipeline velocity. Start with synchronous callbacks for validation, then graduate to batched metadata ingestion as execution volumes grow. Validate your output against a PROV-O validator before routing records to production catalogs.
