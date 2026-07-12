# Automating ArcGIS Pro Metadata Export to ISO 19139

When an ArcGIS Pro item is edited by an analyst, its item-level metadata is the authoritative description of what the dataset is and how it was produced, yet that record rarely leaves the geodatabase in a form an external catalog or audit trail can consume. This how-to shows how to export ArcGIS Pro item metadata to ISO 19139 XML with `arcpy` and capture a matching lineage record in the same run, so every export is traceable. It sits under [Metadata Injection Techniques](https://www.provenance-tracking.com/python-automation-pipeline-integration/metadata-injection-techniques/) and pairs naturally with [Setting Up Transformation Logs for ArcGIS](https://www.provenance-tracking.com/geospatial-lineage-fundamentals-architecture/transformation-logging-standards/setting-up-transformation-logs-for-arcgis/).

## Prerequisites

- ArcGIS Pro 3.1+ with an available Standard or Advanced license, since `arcpy` and the `arcpy.metadata` module ship only with Pro.
- The script must run inside ArcGIS Pro's bundled Python (the `arcgispro-py3` conda environment). `arcpy` is not `pip`-installable; launch from the Pro **Python Command Prompt** or point your IDE interpreter at `C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe`.
- Read access to the source feature class or raster, and write access to an output directory for the XML and the lineage sidecar.
- Familiarity with the `ExportMetadata` translator names; ISO 19139 export uses the `ISO19139_GML32` translation style.

## Implementation

The `arcpy.metadata.Metadata` class reads the item's synchronized metadata; its `exportMetadata()` method writes standards-compliant XML. The function below exports one item, hashes the resulting XML for integrity, and writes a JSON lineage record capturing the source, translator, operator, and a UTC timestamp.

```python
from __future__ import annotations

import getpass
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import arcpy  # available only inside ArcGIS Pro's arcgispro-py3 environment
from arcpy import metadata as md


def export_iso19139_with_lineage(
    source_item: str,
    output_dir: str | Path,
    translator: str = "ISO19139_GML32",
) -> dict[str, str]:
    """Export an ArcGIS Pro item's metadata to ISO 19139 XML and emit a lineage record.

    Args:
        source_item: Catalog path to a feature class, raster, or table.
        output_dir: Directory that will hold the .xml export and .lineage.json sidecar.
        translator: arcpy metadata export translation style name.

    Returns:
        The lineage record that was written to disk.
    """
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not arcpy.Exists(source_item):
        raise FileNotFoundError(f"ArcGIS item does not exist: {source_item}")

    item_name = Path(source_item).name
    xml_path = out_dir / f"{item_name}.iso19139.xml"

    # Read the item's stored metadata and export it to ISO 19139.
    item_md = md.Metadata(source_item)
    if item_md.isReadOnly:
        raise PermissionError(f"Metadata for {source_item} is read-only")
    item_md.exportMetadata(str(xml_path), translator)

    # Hash the exported XML so drift in the record is detectable later.
    xml_bytes = xml_path.read_bytes()
    xml_sha256 = hashlib.sha256(xml_bytes).hexdigest()

    describe = arcpy.Describe(source_item)
    lineage: dict[str, str] = {
        "event": "metadata_export",
        "source_item": str(source_item),
        "source_catalog_path": describe.catalogPath,
        "dataset_type": describe.dataType,
        "spatial_reference": getattr(describe, "spatialReference", None).name
        if getattr(describe, "spatialReference", None)
        else "UNKNOWN",
        "output_xml": str(xml_path),
        "translator": translator,
        "xml_sha256": xml_sha256,
        "xml_byte_length": str(len(xml_bytes)),
        "operator": getpass.getuser(),
        "exported_at": datetime.now(timezone.utc).isoformat(),
    }

    lineage_path = out_dir / f"{item_name}.lineage.json"
    lineage_path.write_text(json.dumps(lineage, indent=2), encoding="utf-8")
    return lineage


if __name__ == "__main__":
    record = export_iso19139_with_lineage(
        source_item=r"C:\gis\parcels.gdb\parcels_2026",
        output_dir=r"C:\gis\exports\lineage",
    )
    print(f"Exported {record['output_xml']} (sha256={record['xml_sha256'][:12]}...)")
```

The critical detail is that `exportMetadata()` runs the translator against the *stored* metadata. If an analyst edited the item's description in the Catalog pane but never saved, the export reflects the last committed state — which is exactly what you want for an audit record, but it means unsaved edits are silently excluded.

## Verification

Confirm the export produced valid ISO 19139 and that the lineage record matches the file on disk:

```python
import hashlib
from pathlib import Path
from xml.etree import ElementTree as ET

xml_path = Path(r"C:\gis\exports\lineage\parcels_2026.iso19139.xml")

# 1. The XML must parse and carry the ISO 19139 root namespace (gmd/gco).
root = ET.parse(xml_path).getroot()
assert "isotc211" in root.tag, f"Unexpected root element: {root.tag}"

# 2. The recomputed hash must equal the one stored in the lineage sidecar.
import json
lineage = json.loads(Path(str(xml_path).replace(".iso19139.xml", ".lineage.json")).read_text())
recomputed = hashlib.sha256(xml_path.read_bytes()).hexdigest()
assert recomputed == lineage["xml_sha256"], "Lineage hash drift detected"
print("Export verified:", lineage["exported_at"])
```

A parsed root tag containing the `isotc211` namespace confirms the translator emitted ISO 19139 rather than the internal ArcGIS format. The hash assertion proves the record on disk is the one you logged.

## Gotchas & edge cases

- **Translator name mismatch.** Passing `"ISO19139"` instead of `"ISO19139_GML32"` on Pro 3.x raises an obscure `arcpy.ExecuteError`. The GML 3.2 variant is the one that carries geometry-bearing extent elements; use it whenever downstream consumers validate against the full INSPIRE-aligned schema.
- **Spatial reference reported as `Unknown`.** Items whose CRS was never defined export an empty `MD_ReferenceSystem` block, which many catalogs reject. Guard against silent CRS loss by asserting `describe.spatialReference.factoryCode` is non-zero before export, and treat a zero code as a hard failure rather than exporting an unusable record.
- **Feature datasets versus feature classes.** Running the export against a feature dataset container captures only the container's metadata, not the child feature classes. Enumerate children with `arcpy.da.Walk` and export each one, or your lineage will claim coverage it does not have. Feed these records into your broader [transformation logging for ArcGIS](https://www.provenance-tracking.com/geospatial-lineage-fundamentals-architecture/transformation-logging-standards/setting-up-transformation-logs-for-arcgis/) so the export event is chained to the edits that preceded it.
