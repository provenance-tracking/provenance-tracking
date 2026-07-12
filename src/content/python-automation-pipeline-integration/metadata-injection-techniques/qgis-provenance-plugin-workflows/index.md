# Capturing Processing Provenance in QGIS with PyQGIS

Every run of a QGIS Processing algorithm — a buffer, a clip, a reprojection — is a transformation that should leave a provenance trail, but the graphical Processing Toolbox discards its parameters the moment the dialog closes. This how-to shows how to wrap `processing.run()` in PyQGIS so each execution writes a structured lineage record, and how to reconcile those records against QGIS's own processing history. It belongs under [Metadata Injection Techniques](https://www.provenance-tracking.com/python-automation-pipeline-integration/metadata-injection-techniques/) and complements the reusable patterns in [Workflow Hooks in Python Pipelines](https://www.provenance-tracking.com/python-automation-pipeline-integration/workflow-hooks-in-python-pipelines/).

## Prerequisites

- QGIS 3.34 LTR or newer, run either from the built-in Python Console or as a standalone PyQGIS script with the QGIS environment initialized.
- The `processing` framework must be available. Inside QGIS it is imported directly; standalone scripts call `QgsApplication.initQgis()` and register `Processing.initialize()` first.
- Write access to a directory for the JSON lineage records.
- Input layers with a defined CRS; algorithms that silently assume a project CRS are the main source of untracked reprojection.

## Implementation

The wrapper below captures the algorithm id, the fully resolved parameter dictionary, the input layer sources and their CRS, and the output paths, then hashes the parameter set so identical re-runs are detectable. It writes one JSON record per execution.

```python
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import processing
from qgis.core import QgsProcessingContext, QgsVectorLayer


def run_with_lineage(
    algorithm_id: str,
    params: dict[str, Any],
    lineage_dir: str | Path,
) -> dict[str, Any]:
    """Run a QGIS Processing algorithm and write a lineage record for the run.

    Args:
        algorithm_id: Provider-qualified id, e.g. "native:buffer".
        params: Parameter dictionary passed straight to processing.run().
        lineage_dir: Directory that receives the .json lineage record.

    Returns:
        The lineage record, including the algorithm's output dictionary.
    """
    out_dir = Path(lineage_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    started = datetime.now(timezone.utc)

    # Describe every input layer so CRS and source path are captured, not just the id.
    inputs: list[dict[str, str]] = []
    for key, value in params.items():
        if isinstance(value, QgsVectorLayer) and value.isValid():
            inputs.append(
                {
                    "param": key,
                    "source": value.source(),
                    "crs": value.crs().authid() or "UNKNOWN",
                    "feature_count": str(value.featureCount()),
                }
            )
        elif isinstance(value, str) and Path(value).exists():
            inputs.append({"param": key, "source": value, "crs": "UNRESOLVED"})

    context = QgsProcessingContext()
    result = processing.run(algorithm_id, params, context=context)

    finished = datetime.now(timezone.utc)

    # Hash the string-normalized parameters so re-runs with identical inputs collide.
    param_repr = json.dumps({k: str(v) for k, v in params.items()}, sort_keys=True)
    param_hash = hashlib.sha256(param_repr.encode("utf-8")).hexdigest()

    record: dict[str, Any] = {
        "event": "processing_run",
        "algorithm": algorithm_id,
        "parameter_hash": param_hash,
        "inputs": inputs,
        "outputs": {k: str(v) for k, v in result.items()},
        "started_at": started.isoformat(),
        "finished_at": finished.isoformat(),
        "duration_s": round((finished - started).total_seconds(), 3),
    }

    record_path = out_dir / f"{param_hash[:16]}.json"
    record_path.write_text(json.dumps(record, indent=2), encoding="utf-8")
    return record


if __name__ == "__main__":
    layer = QgsVectorLayer("/data/wells.gpkg|layername=wells", "wells", "ogr")
    out = run_with_lineage(
        "native:buffer",
        {
            "INPUT": layer,
            "DISTANCE": 500,
            "SEGMENTS": 8,
            "OUTPUT": "/data/out/wells_buffer.gpkg",
        },
        lineage_dir="/data/lineage",
    )
    print("Wrote lineage for", out["algorithm"], out["parameter_hash"][:12])
```

The single most useful line is the `param_repr` normalization: Processing parameters mix layer objects, numbers, and enums, so stringifying under `sort_keys=True` yields a stable hash that is comparable across sessions and machines.

## Verification

QGIS records every Processing run in its own history log. Cross-check that your captured records line up with QGIS's internal history:

```python
from processing.core.ProcessingLog import ProcessingLog

# QGIS stores its processing history as newest-first log entries.
history = ProcessingLog.getLogEntries()
for entry in history[:5]:
    print(entry.date, entry.text)  # text includes the algorithm id and params
```

Each captured JSON record should have a corresponding QGIS history line with the same algorithm id and timestamp within the run window. If a record exists with no history entry, the algorithm was invoked outside your wrapper and its provenance is incomplete.

## Gotchas & edge cases

- **On-the-fly reprojection hides CRS changes.** When `INPUT` and `OUTPUT` layers differ in CRS, `native:buffer` and many geometry algorithms reproject silently using the project's transform. Record `crs().authid()` for every input as shown, and add the output CRS after the run, or your lineage will not reveal that a datum shift occurred.
- **Memory-layer outputs vanish.** Passing `"OUTPUT": "memory:"` returns a `QgsVectorLayer` that is never written to disk, so the `source` in your record points to a transient id that dies with the session. For durable provenance, always resolve outputs to a file path such as a GeoPackage before logging.
- **Non-native providers may not be initialized.** Algorithms from GRASS, GDAL, or SAGA providers raise `QgsProcessingException` if their provider was not registered in a standalone script. Register providers before the first `processing.run()` call, and route the resulting records through your shared [workflow hooks](https://www.provenance-tracking.com/python-automation-pipeline-integration/workflow-hooks-in-python-pipelines/) so QGIS runs are logged with the same schema as the rest of the pipeline.
