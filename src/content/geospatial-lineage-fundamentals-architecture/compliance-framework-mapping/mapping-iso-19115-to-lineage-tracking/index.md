# Mapping ISO 19115 to Lineage Tracking: Architecture & Implementation

Mapping ISO 19115 to Lineage Tracking requires translating the standard's `LI_Lineage` metadata block into a directed acyclic graph (DAG) of data transformations, input sources, and responsible agents. The core mapping aligns `LI_Source` with input dataset nodes, `LI_ProcessStep` with transformation edges, and `LI_Lineage/statement` with high-level provenance context. Modern lineage systems consume this structure by extracting `processStepDescription`, `dateTime`, `processor`, and `source` references, then normalizing them into machine-readable records compatible with OpenLineage or [W3C PROV-O](https://www.w3.org/TR/prov-o/). For GIS data stewards and compliance officers, the objective is converting narrative-heavy ISO 19115 records into auditable, queryable provenance trails that satisfy regulatory retention and reproducibility mandates.

## Core Mapping Architecture

ISO 19115-1:2014 defines geospatial metadata lineage through a hierarchical XML structure that prioritizes human readability over machine traversal. When implementing [Geospatial Lineage Fundamentals & Architecture](https://www.provenance-tracking.com/geospatial-lineage-fundamentals-architecture/), engineering teams must account for the fact that ISO 19115 lineage often lacks strict referential integrity between processing steps. Successful [Compliance Framework Mapping](https://www.provenance-tracking.com/geospatial-lineage-fundamentals-architecture/compliance-framework-mapping/) requires normalizing free-text descriptions into structured process types, standardizing temporal formats, and linking `processor` roles to organizational identity systems.

The practical element-to-lineage mapping follows this schema:

| ISO 19115 Element | Lineage Graph Equivalent | Data Type / Format |
|-------------------|--------------------------|-------------------|
| `LI_Lineage/statement` | Lineage context/summary | String (metadata-level annotation) |
| `LI_Source/citation` | Source dataset node | Object (URI, title, version, spatial extent) |
| `LI_Source/scope` | Input data boundary constraints | String/Geometry reference |
| `LI_ProcessStep/description` | Transformation edge label | String (normalized to controlled vocabulary) |
| `LI_ProcessStep/dateTime` | Execution timestamp | ISO 8601 UTC (`YYYY-MM-DDTHH:MM:SSZ`) |
| `LI_ProcessStep/processor` | Actor/agent node | Object (organization, role, contact) |
| `LI_ProcessStep/source` | Input node reference | URI/UUID (creates graph edges) |
| `LI_ProcessStep/output` | Output node reference | URI/UUID (completes the DAG) |

## Handling Namespace Variants & XML Parsing

ISO 19115 lineage metadata spans multiple standard revisions. Legacy implementations use the `gmd` namespace (ISO 19115-1:2003), while modern deployments adopt `mrl` (ISO 19115-3:2016/2018). A robust parser must query both paths without throwing `NoneType` exceptions. The [Python Standard Library `xml.etree.ElementTree`](https://docs.python.org/3/library/xml.etree.elementtree.html) module provides sufficient XPath-like navigation for this task, though production systems often migrate to `lxml` for stricter schema validation and faster iteration over large metadata catalogs.

When extracting lineage, always:

1. Register all relevant namespaces upfront to avoid silent misses.
2. Use `.findall()` with fallback paths to capture both legacy and modern structures.
3. Strip whitespace and validate timestamps before serialization.
4. Decouple extraction from graph ingestion to enable idempotent retries.

## Python Extraction & Normalization

The following script parses ISO 19115 XML, handles namespace variations, and outputs a JSON structure ready for ingestion into lineage databases or graph stores.

```python
import xml.etree.ElementTree as ET
import json
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional

# ISO 19115 namespace mapping (covers 2003 and ISO 19115-3:2016 variants)
NAMESPACES = {
    "gmd": "http://www.isotc211.org/2005/gmd",
    "gco": "http://www.isotc211.org/2005/gco",
    "gmx": "http://www.isotc211.org/2005/gmx",
    "xlink": "http://www.w3.org/1999/xlink",
    "mrl": "http://standards.iso.org/iso/19115/-3/mrl/1.0",
    "cit": "http://standards.iso.org/iso/19115/-3/cit/2.0"
}

def _safe_text(element: Optional[ET.Element]) -> Optional[str]:
    """Safely extract and strip text content from an XML element."""
    if element is not None and element.text:
        return element.text.strip()
    return None

def _normalize_timestamp(raw_dt: Optional[str]) -> Optional[str]:
    """Convert ISO 19115 dateTime to strict ISO 8601 UTC."""
    if not raw_dt:
        return None
    try:
        dt_str = raw_dt.replace("Z", "+00:00")
        dt_obj = datetime.fromisoformat(dt_str)
        if dt_obj.tzinfo is None:
            dt_obj = dt_obj.replace(tzinfo=timezone.utc)
        return dt_obj.isoformat()
    except ValueError:
        return raw_dt  # Fallback to raw string if parsing fails

def parse_iso19115_lineage(xml_path: str) -> Dict[str, Any]:
    """Parse ISO 19115 XML and extract lineage into a normalized DAG structure."""
    tree = ET.parse(xml_path)
    root = tree.getroot()

    lineage: Dict[str, Any] = {
        "statement": "",
        "sources": [],
        "process_steps": []
    }

    # Extract high-level lineage statement (mrl namespace first, then legacy gmd)
    stmt_paths = [
        ".//mrl:LI_Lineage/mrl:statement/gco:CharacterString",
        ".//gmd:LI_Lineage/gmd:statement/gco:CharacterString"
    ]
    for path in stmt_paths:
        elem = root.find(path, NAMESPACES)
        if elem is not None:
            lineage["statement"] = _safe_text(elem)
            break

    # Extract sources — ISO 19115-3 uses mrl:LI_Source; legacy uses gmd:LI_Source
    src_paths = [".//mrl:LI_Source", ".//gmd:LI_Source"]
    for path in src_paths:
        for src_elem in root.findall(path, NAMESPACES):
            # Title lives under gco:CharacterString in both legacy and 19115-3 documents
            citation_title = src_elem.find(
                ".//gmd:CI_Citation/gmd:title/gco:CharacterString", NAMESPACES
            )
            scope = src_elem.find(".//gmd:scope/gco:CharacterString", NAMESPACES)
            identifier = src_elem.find(
                ".//gmd:identifier/gmd:MD_Identifier/gmd:code/gco:CharacterString",
                NAMESPACES
            )

            lineage["sources"].append({
                "title": _safe_text(citation_title),
                "scope": _safe_text(scope),
                "uri": _safe_text(identifier)
            })

    # Extract process steps
    step_paths = [".//mrl:LI_ProcessStep", ".//gmd:LI_ProcessStep"]
    for path in step_paths:
        for step_elem in root.findall(path, NAMESPACES):
            desc = step_elem.find(".//gmd:description/gco:CharacterString", NAMESPACES)
            dt = step_elem.find(".//gmd:dateTime/gco:DateTime", NAMESPACES)
            processor = step_elem.find(".//gmd:processor", NAMESPACES)

            role_elem = (
                processor.find(".//gmd:role/gmd:CI_RoleCode", NAMESPACES)
                if processor is not None else None
            )
            org_elem = (
                processor.find(".//gmd:organisationName/gco:CharacterString", NAMESPACES)
                if processor is not None else None
            )

            lineage["process_steps"].append({
                "description": _safe_text(desc),
                "timestamp_utc": _normalize_timestamp(_safe_text(dt)),
                "processor_role": _safe_text(role_elem),
                "processor_org": _safe_text(org_elem)
            })

    return lineage

if __name__ == "__main__":
    result = parse_iso19115_lineage("metadata.xml")
    print(json.dumps(result, indent=2))
```

## DAG Construction & Compliance Integration

Once parsed, the JSON output must be transformed into a graph model. Each `LI_Source` becomes a vertex with properties like `dataset_id`, `spatial_extent`, and `version`. Each `LI_ProcessStep` becomes a directed edge connecting an input vertex to an output vertex, annotated with `transformation_type`, `executed_at`, and `responsible_agent`. This structure enables downstream queries such as:

- *Trace upstream dependencies for a published raster layer*
- *Identify all datasets processed by a specific agency role in Q3*
- *Validate temporal ordering of transformation steps*

For compliance officers, the `LI_Lineage/statement` serves as an immutable provenance anchor. Regulatory frameworks often require explicit documentation of data origin, transformation logic, and custodian accountability. By mapping `processor` roles to enterprise IAM directories, organizations can automatically generate audit trails that satisfy frameworks like NIST SP 800-53 or ISO 27001. Additionally, enforcing controlled vocabularies for `description` fields prevents semantic drift across geospatial workflows, ensuring lineage remains machine-auditable over multi-year retention periods.

To maintain referential integrity, generate stable URIs for each `LI_Source` using persistent identifiers (e.g., DOIs, PIDs, or internal asset registry keys). Avoid relying on file paths or temporary database IDs, which break graph edges during system migrations. Finally, integrate automated schema validation into CI/CD pipelines to catch malformed XML or missing mandatory fields before they enter production lineage stores.

## Conclusion

Mapping ISO 19115 to Lineage Tracking bridges legacy geospatial metadata standards with modern data observability practices. By parsing `LI_Lineage` blocks into normalized DAGs, GIS teams unlock queryable provenance, automated compliance reporting, and reproducible spatial analytics pipelines. The combination of namespace-aware parsing, strict timestamp normalization, and graph-based ingestion transforms narrative metadata into an enterprise-grade audit asset.
