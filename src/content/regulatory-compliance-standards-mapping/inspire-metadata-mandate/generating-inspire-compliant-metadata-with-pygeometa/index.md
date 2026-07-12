# Generating INSPIRE-Compliant Metadata with pygeometa

Turning a structured lineage record into an ISO 19139 XML document that satisfies the INSPIRE metadata rules is fiddly to do by hand — the namespaces, the nested `gmd:LI_Lineage` element, and the mandatory multiplicities are easy to get subtly wrong. This how-to, a companion to the [INSPIRE metadata mandate](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/inspire-metadata-mandate/) overview, generates that XML from a metadata control file (MCF) dictionary using pygeometa, with a lineage statement wired in as a first-class element. The approach favors an in-memory MCF dictionary over an on-disk YAML file so the metadata is produced in the same process that ran the pipeline, keeping the lineage statement bound to the actual transformation record rather than to a document a human edited afterwards.

## Prerequisites

- Python 3.10+ with `pygeometa` 0.15+ installed (`pip install pygeometa`), which pulls in `lxml` and `jinja2`.
- A populated lineage object — the `DatasetLineage` and `ProcessStep` shapes from the overview page, or equivalent source/processing detail.
- The data set's spatial extent (bounding box in decimal degrees) and its coordinate reference system.
- A stable resource identifier and the GEMET INSPIRE theme keyword for the data set.

## Implementation

pygeometa consumes an MCF — a nested dictionary (or YAML file) describing the metadata — and renders it through an ISO 19139 schema. The key is to place the derived lineage statement under `identification.lineage.statement`, which pygeometa maps to `gmd:LI_Lineage/gmd:statement`, the element INSPIRE treats as mandatory.

```python
from __future__ import annotations
from datetime import date
from pygeometa.core import render_j2_template
from pygeometa.schemas.iso19139 import ISO19139OutputSchema

def build_lineage_statement(theme: str, resource_id: str, steps: list[dict]) -> str:
    """Deterministic free-text lineage from structured steps (mirrors the pipeline)."""
    if not steps:
        raise ValueError("INSPIRE mandates a non-empty lineage statement")
    parts = [f"Data set for INSPIRE theme '{theme}' (resource {resource_id})."]
    for i, s in enumerate(steps, start=1):
        crs_note = (
            f" reprojected {s['source_crs']} to {s['result_crs']}"
            if s["source_crs"] != s["result_crs"] else ""
        )
        parts.append(
            f"Step {i} ({s['step_date']}, {s['processor']}): "
            f"{s['description']}{crs_note}; source {s['source_id']}."
        )
    return " ".join(parts)

def build_mcf(theme: str, resource_id: str, title: str,
              bbox: tuple[float, float, float, float], crs: str,
              steps: list[dict]) -> dict:
    minx, miny, maxx, maxy = bbox
    statement = build_lineage_statement(theme, resource_id, steps)
    return {
        "mcf": {"version": "1.0"},
        "metadata": {
            "identifier": resource_id,
            "language": "eng",
            "charset": "utf8",
            "hierarchylevel": "dataset",
            "datestamp": date.today().isoformat(),
        },
        "spatial": {"datatype": "vector", "geomtype": "line"},
        "identification": {
            "title": title,
            "abstract": f"INSPIRE {theme} data set.",
            "dates": {"creation": date.today().isoformat()},
            "keywords": {
                "inspire_theme": {
                    "keywords": [theme],
                    "keywords_type": "theme",
                    # GEMET INSPIRE themes vocabulary (named, not linked, per site policy)
                    "vocabulary": {"name": "GEMET - INSPIRE themes"},
                }
            },
            "extents": {
                "spatial": [{"bbox": [minx, miny, maxx, maxy], "crs": crs.split(":")[-1]}]
            },
            # This is the mandatory INSPIRE lineage element:
            "lineage": {"statement": statement},
            "status": "completed",
        },
        "reference_system": {"code": crs.split(":")[-1], "codespace": "EPSG"},
        "contact": {
            "pointOfContact": {
                "organization": "National Mapping Authority",
                "email": "geodata@authority.example",
                "role": "pointOfContact",
            }
        },
        "distribution": {},
    }

def render_iso19139(mcf: dict) -> str:
    schema = ISO19139OutputSchema()
    return schema.write(mcf)

if __name__ == "__main__":
    steps = [{
        "description": "Extracted hydrography features and generalized to 1:25 000",
        "processor": "hydro-pipeline v4",
        "step_date": "2026-06-30",
        "source_id": "urn:agency:hydro:raw:2026",
        "source_crs": "EPSG:4258",
        "result_crs": "EPSG:3035",
    }]
    mcf = build_mcf(
        theme="Hydrography",
        resource_id="urn:agency:hydro:inspire:2026",
        title="National Hydrography Network 2026",
        bbox=(2.5, 42.3, 7.2, 51.1),
        crs="EPSG:3035",
        steps=steps,
    )
    xml = render_iso19139(mcf)
    with open("hydrography_inspire.xml", "w", encoding="utf-8") as fh:
        fh.write(xml)
    print("Wrote hydrography_inspire.xml")
```

The `lineage.statement` key is the load-bearing line: pygeometa renders it into `gmd:dataQualityInfo/gmd:DQ_DataQuality/gmd:lineage/gmd:LI_Lineage/gmd:statement`, and omitting it produces a record that parses but fails INSPIRE validation. Reusing the same `build_lineage_statement` logic the pipeline uses guarantees the XML statement and your internal lineage records are identical text.

Two other keys deserve attention because INSPIRE constrains them more tightly than base ISO 19139 does. The `keywords.inspire_theme` block carries a `keywords_type` of `theme` and names the GEMET INSPIRE themes vocabulary, which is what lets a national discovery service filter records by data theme; a free-text keyword with no vocabulary reference is technically valid ISO but invisible to INSPIRE theme searches. The `extents.spatial` block must be expressed in geographic coordinates even when the data set itself is delivered in a projected system such as ETRS89-LAEA, because the bounding box in the metadata is a discovery aid meant to be comparable across records, not a statement of the data's working projection. Keeping the working CRS in `reference_system` and the bounding box in decimal degrees resolves that apparent contradiction cleanly.

## Verification

Confirm three things after rendering: the document is well-formed XML, it declares the ISO 19139 namespace, and it actually contains a non-empty lineage statement. This is a structural check you can run offline, without contacting any external validator.

```python
from lxml import etree

NS = {"gmd": "http://www.isotc211.org/2005/gmd", "gco": "http://www.isotc211.org/2005/gco"}

def verify_inspire_xml(path: str) -> bool:
    tree = etree.parse(path)                       # raises on malformed XML
    root = tree.getroot()
    assert root.tag.endswith("MD_Metadata"), "root is not gmd:MD_Metadata"
    stmt = tree.xpath("//gmd:LI_Lineage/gmd:statement/gco:CharacterString/text()", namespaces=NS)
    assert stmt and stmt[0].strip(), "mandatory INSPIRE lineage statement missing or empty"
    theme = tree.xpath("//gmd:MD_Keywords/gmd:keyword/gco:CharacterString/text()", namespaces=NS)
    assert theme, "no theme keyword present"
    print(f"OK: lineage statement present ({len(stmt[0])} chars), theme={theme[0]!r}")
    return True
```

A successful run prints the statement length and the theme keyword; a missing or empty `LI_Lineage/statement` trips the assertion, which is exactly the condition a national geoportal would reject. Because the mandatory lineage element is the field most often dropped, asserting on it directly is the highest-value structural check you can automate. For the broader mapping of which INSPIRE elements are mandatory, return to the [INSPIRE metadata mandate](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/inspire-metadata-mandate/) overview.

## Gotchas & edge cases

- **Namespace handling in lxml queries.** ISO 19139 elements live in the `gmd` and `gco` namespaces, so an unqualified XPath like `//statement` returns nothing and can mislead you into thinking the element is missing. Always pass the `namespaces` mapping to `xpath`, and read values from the nested `gco:CharacterString`, not from the `gmd` element directly.
- **The lineage element is quietly optional to the encoder.** pygeometa will happily render a valid-looking record with no lineage block if you omit the key, because ISO 19139 itself does not force it — the mandate is an INSPIRE overlay. Guard it in code (as `build_lineage_statement` does by raising on empty steps) rather than trusting the schema writer to complain.
- **CRS codes versus URNs.** The `reference_system` code should be the bare EPSG number with `EPSG` as the codespace; passing the full `EPSG:3035` string into the code field produces a malformed authority reference. Split on the colon, as the example does, and keep the authority in `codespace`.
- **Encoding declaration and non-ASCII place names.** Write the file as UTF-8 and keep `charset` set to `utf8` in the MCF; hydrography and administrative-unit data sets routinely contain accented or non-Latin place names, and a mismatched declaration corrupts them in a way that only surfaces when a downstream catalogue re-parses the record. Opening the output with an explicit `encoding="utf-8"`, as the example does, avoids relying on the platform default.

Generate the metadata in the same run that produces the data so the lineage statement reflects the actual processing, and store the rendered XML alongside the data set under the same retention policy, so discovery metadata and data never drift out of sync.
