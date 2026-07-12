# Implementing the ISO 19115-1 Lineage Model in a Spatial Pipeline

ISO 19115-1:2014 defines lineage as a structured object graph — not a free-text paragraph — yet most agencies still emit a single narrative `statement` and stop there. The standard's `LI_Lineage` class actually composes three collaborating types: `LI_Source` describes the inputs, `LI_ProcessStep` describes each transformation applied to those inputs, and `DQ_Element` (from ISO 19157) attaches measurable quality results to the steps that produced them. Populating these classes correctly, with the right cardinalities, is what separates a metadata record that merely *mentions* processing from one that a downstream system can traverse, validate, and hold up as audit evidence. This guide sits under the [Regulatory Compliance & Standards Mapping](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/) section and takes a build-oriented view: how to assemble these objects in Python inside a running pipeline and serialize them to conformant XML.

Where the existing overview on [mapping ISO 19115 to lineage tracking](https://www.provenance-tracking.com/geospatial-lineage-fundamentals-architecture/compliance-framework-mapping/mapping-iso-19115-to-lineage-tracking/) crosswalks the standard's elements onto a generic lineage graph, this page goes one level deeper into the object model itself — the exact nesting of `LI_ProcessStep` inside `LI_Lineage`, the imagery-specific extensions added by ISO 19115-2, the mandatory-versus-optional cardinality rules, and the two serialization dialects (ISO 19139 and the newer ISO 19115-3 / `mdb` encoding) you must choose between. Read the overview first for the conceptual crosswalk; return here to implement it.

<svg viewBox="0 0 600 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="LI_Lineage object model showing statement, LI_Source inputs, LI_ProcessStep transformations, and DQ_Element quality results and their cardinalities">
<title>ISO 19115-1 LI_Lineage object model and cardinalities</title>
<rect width="600" height="300" fill="#fffdf8" rx="10"/>
<rect x="220" y="20" width="160" height="52" rx="8" fill="#2b1d12"/>
<text x="300" y="42" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" font-weight="700" fill="#fffdf8">LI_Lineage</text>
<text x="300" y="59" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">+ statement [0..1]</text>
<rect x="30" y="140" width="150" height="70" rx="8" fill="#3f5a30"/>
<text x="105" y="163" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="700" fill="#fffdf8">LI_Source</text>
<text x="105" y="180" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">+ description</text>
<text x="105" y="194" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">+ sourceCitation</text>
<rect x="225" y="140" width="150" height="70" rx="8" fill="#b85c3b"/>
<text x="300" y="163" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="700" fill="#fffdf8">LI_ProcessStep</text>
<text x="300" y="180" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">+ description [1]</text>
<text x="300" y="194" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">+ dateTime, processor</text>
<rect x="420" y="140" width="150" height="70" rx="8" fill="#5e7b4a"/>
<text x="495" y="163" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="700" fill="#fffdf8">DQ_Element</text>
<text x="495" y="180" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">+ nameOfMeasure</text>
<text x="495" y="194" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">+ result</text>
<rect x="225" y="248" width="150" height="40" rx="8" fill="#c8a781"/>
<text x="300" y="266" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#2b1d12">LE_ProcessStep</text>
<text x="300" y="280" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#2b1d12">19115-2 imagery ext.</text>
<defs><marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#2b1d12"/></marker></defs>
<line x1="270" y1="72" x2="140" y2="140" stroke="#2b1d12" stroke-width="1.5" marker-end="url(#ar)"/>
<text x="150" y="112" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" font-weight="700" fill="#2b1d12">source 0..*</text>
<line x1="300" y1="72" x2="300" y2="140" stroke="#2b1d12" stroke-width="1.5" marker-end="url(#ar)"/>
<text x="355" y="112" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" font-weight="700" fill="#2b1d12">processStep 0..*</text>
<line x1="375" y1="178" x2="420" y2="178" stroke="#5a3c25" stroke-width="1.5" marker-end="url(#ar)"/>
<text x="398" y="132" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" font-weight="700" fill="#2b1d12">report</text>
<line x1="180" y1="185" x2="225" y2="180" stroke="#5a3c25" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#ar)"/>
<line x1="300" y1="210" x2="300" y2="248" stroke="#5a3c25" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#ar)"/>
</svg>

The diagram captures the containment you will reproduce in code: a single `LI_Lineage` holds zero-or-more `LI_Source` and zero-or-more `LI_ProcessStep` children, each step may reference the sources it consumed, and each step may carry `DQ_Element` quality reports. The imagery profile of ISO 19115-2 subclasses these into `LE_Source` and `LE_ProcessStep`, adding processing-parameter and algorithm detail relevant to raster derivatives.

## Prerequisites

- [ ] Python 3.10+ with `lxml` 5.x for namespace-aware XML serialization (the standard library `xml.etree` cannot emit prefixed elements cleanly enough for schema validation).
- [ ] A pipeline that already normalizes transformation events into structured records — see [Structuring JSON/XML Lineage Documents](https://www.provenance-tracking.com/storage-indexing-query-optimization/structuring-jsonxml-lineage-documents/) for the intermediate shape this code consumes.
- [ ] Local copies of the ISO 19139 and ISO 19115-3 (`mdb`/`mrl`/`mcc`) XML schemas for offline validation, plus the ISO codelist catalogue for `CI_RoleCode` and `MD_ProgressCode`.
- [ ] Agreement with your metadata authority on which encoding is authoritative: legacy ISO 19139 (`gmd` namespace) or ISO 19115-3:2016 (`mrl` namespace). Emitting both from one source model is supported below but doubles your validation surface.
- [ ] A persistent identifier scheme for sources (asset registry keys, DOIs, or UUIDs) so `LI_Source` citations survive migration.

## Step-by-step

### 1. Model the lineage objects as typed dataclasses

Before touching XML, capture the standard's structure as Python types. Making cardinality explicit here — `Optional` for `[0..1]`, a required field for `[1]`, a `list` for `[0..*]` — means the serializer never has to guess. This mirrors the `LI_Source` / `LI_ProcessStep` split described in the [ISO 19115 lineage mapping overview](https://www.provenance-tracking.com/geospatial-lineage-fundamentals-architecture/compliance-framework-mapping/mapping-iso-19115-to-lineage-tracking/).

```python
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime, timezone

@dataclass
class Source:
    """Maps to LI_Source. description is [0..1], sourceCitation is [0..1]."""
    description: str
    citation_title: str
    identifier: str                      # persistent URI/UUID for graph edges
    scope_level: str = "dataset"         # MD_ScopeCode value

@dataclass
class ProcessStep:
    """Maps to LI_ProcessStep. description is MANDATORY [1]."""
    description: str                     # required — validation fails if empty
    date_time: datetime
    processor_org: str
    processor_role: str = "processor"    # CI_RoleCode value
    rationale: str | None = None         # [0..1]
    source_ids: list[str] = field(default_factory=list)

@dataclass
class Lineage:
    """Maps to LI_Lineage."""
    statement: str | None = None         # [0..1] high-level summary
    sources: list[Source] = field(default_factory=list)
    steps: list[ProcessStep] = field(default_factory=list)

    def validate(self) -> list[str]:
        errors: list[str] = []
        if not self.statement and not self.steps and not self.sources:
            errors.append("LI_Lineage requires statement, source, or processStep")
        for i, step in enumerate(self.steps):
            if not step.description.strip():
                errors.append(f"processStep[{i}]: description is mandatory")
        return errors
```

### 2. Populate the model from pipeline events

Inside your ETL run, append a `ProcessStep` at each transformation boundary — reprojection, resampling, mosaicking, attribute enrichment. Bind each step to the `Source` identifiers it consumed so the emitted XML preserves the input-to-output edges. This is the same event capture that feeds [transformation logging standards](https://www.provenance-tracking.com/geospatial-lineage-fundamentals-architecture/transformation-logging-standards/), reused here to build compliant metadata rather than an internal log.

```python
lineage = Lineage(statement="Orthorectified mosaic derived from three Sentinel-2 tiles.")

lineage.sources.append(Source(
    description="Sentinel-2 L1C tile T31UDQ",
    citation_title="Sentinel-2 MSI Level-1C",
    identifier="urn:asset:s2:T31UDQ:20260601",
))

lineage.steps.append(ProcessStep(
    description="Reprojected tiles from EPSG:32631 to EPSG:3035 using cubic resampling.",
    date_time=datetime(2026, 6, 2, 9, 15, tzinfo=timezone.utc),
    processor_org="National Mapping Agency",
    source_ids=["urn:asset:s2:T31UDQ:20260601"],
))

problems = lineage.validate()
assert not problems, problems
```

### 3. Serialize to ISO 19115-3 XML with lxml

The serializer walks the model and emits properly prefixed elements. ISO 19115-3 places lineage under the `mrl` namespace and character strings under `gco`; every codelist value (role, scope) is an element with `codeList` and `codeListValue` attributes, not text — a rule the [validation companion page](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/iso-19115-lineage-implementation/validating-iso-19115-lineage-with-python/) checks explicitly.

```python
from lxml import etree

NS = {
    "mrl": "http://standards.iso.org/iso/19115/-3/mrl/2.0",
    "mcc": "http://standards.iso.org/iso/19115/-3/mcc/1.0",
    "cit": "http://standards.iso.org/iso/19115/-3/cit/2.0",
    "gco": "http://standards.iso.org/iso/19115/-3/gco/1.0",
}
CODELIST = "http://standards.iso.org/iso/19115/resources/Codelists/cat/codelists.xml"

def q(prefix: str, tag: str) -> str:
    return f"{{{NS[prefix]}}}{tag}"

def _char(parent: etree._Element, prefix: str, tag: str, text: str) -> None:
    el = etree.SubElement(parent, q(prefix, tag))
    cs = etree.SubElement(el, q("gco", "CharacterString"))
    cs.text = text

def serialize(lin: Lineage) -> bytes:
    root = etree.Element(q("mrl", "LI_Lineage"), nsmap=NS)
    if lin.statement:
        _char(root, "mrl", "statement", lin.statement)
    for src in lin.sources:
        se = etree.SubElement(root, q("mrl", "source"))
        li = etree.SubElement(se, q("mrl", "LI_Source"))
        _char(li, "mrl", "description", src.description)
    for step in lin.steps:
        pe = etree.SubElement(root, q("mrl", "processStep"))
        ps = etree.SubElement(pe, q("mrl", "LI_ProcessStep"))
        _char(ps, "mrl", "description", step.description)
        dt = etree.SubElement(ps, q("mrl", "stepDateTime"))
        gdt = etree.SubElement(dt, q("gco", "DateTime"))
        gdt.text = step.date_time.isoformat()
    return etree.tostring(root, pretty_print=True, xml_declaration=True, encoding="UTF-8")

print(serialize(lineage).decode())
```

### 4. Emit a legacy ISO 19139 variant when required

Older catalogues and many INSPIRE validators still expect the `gmd` encoding of ISO 19139. Keep one source model and switch the namespace map and element names at serialization time; do not maintain two hand-edited XML trees. The [INSPIRE metadata mandate](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/inspire-metadata-mandate/) section covers where the 19139 dialect is still authoritative.

```python
GMD = "http://www.isotc211.org/2005/gmd"
GCO = "http://www.isotc211.org/2005/gco"

def serialize_19139(lin: Lineage) -> bytes:
    nsmap = {"gmd": GMD, "gco": GCO}
    root = etree.Element(f"{{{GMD}}}LI_Lineage", nsmap=nsmap)
    if lin.statement:
        stmt = etree.SubElement(root, f"{{{GMD}}}statement")
        cs = etree.SubElement(stmt, f"{{{GCO}}}CharacterString")
        cs.text = lin.statement
    for step in lin.steps:
        pe = etree.SubElement(root, f"{{{GMD}}}processStep")
        ps = etree.SubElement(pe, f"{{{GMD}}}LI_ProcessStep")
        d = etree.SubElement(ps, f"{{{GMD}}}description")
        etree.SubElement(d, f"{{{GCO}}}CharacterString").text = step.description
    return etree.tostring(root, pretty_print=True, encoding="UTF-8")
```

### 5. Publish the record to a discovery catalog

Once the XML is validated, the same source model can be projected into an [OGC API - Records](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/iso-19115-lineage-implementation/mapping-ogc-api-records-to-lineage/) GeoJSON record so lineage becomes discoverable through a modern catalog API rather than only as a downloadable metadata file.

## Configuration reference — element cardinalities

| Element | Type | Valid values | Default / cardinality |
|---------|------|--------------|-----------------------|
| `LI_Lineage.statement` | CharacterString | Free text summary | none — `[0..1]` |
| `LI_Lineage.source` | LI_Source | Nested object | none — `[0..*]` |
| `LI_Lineage.processStep` | LI_ProcessStep | Nested object | none — `[0..*]` |
| `LI_ProcessStep.description` | CharacterString | Non-empty text | required — `[1]` |
| `LI_ProcessStep.stepDateTime` | DateTime / TM_Primitive | ISO 8601 | none — `[0..1]` |
| `LI_ProcessStep.processor` | CI_Responsibility | Party + role | none — `[0..*]` |
| `LI_Source.description` | CharacterString | Free text | none — `[0..1]` |
| `LI_Source.sourceCitation` | CI_Citation | Title, identifier | none — `[0..1]` |
| `processor.role` | CI_RoleCode | `processor`, `originator`, `custodian` | codelist value |
| `LI_Source.scope.level` | MD_ScopeCode | `dataset`, `series`, `feature` | codelist value |

A record is only conformant when at least one of `statement`, `source`, or `processStep` is present; an `LI_Lineage` with all three absent is invalid.

## Common failure modes & mitigations

| Failure | Symptom | Mitigation |
|---------|---------|------------|
| **Empty processStep description** | Schematron rejects `LI_ProcessStep`; catalog ingest silently drops the step | Enforce the mandatory `[1]` description in the dataclass and in `validate()` before serializing |
| **Codelist as text, not attribute** | `CI_RoleCode` renders as `<gco:CharacterString>` and fails ISO validation | Emit codelists as empty elements carrying `codeList` + `codeListValue` attributes |
| **Namespace prefix drift** | `19115-3` `mrl` elements placed under legacy `gmd` URI; validators report unknown element | Centralize the namespace map and never string-concatenate prefixes |
| **Silent CRS loss in source citation** | Reprojection recorded in prose but source extent still tagged old EPSG | Store the CRS on each `Source` and assert it changes across reprojection steps |
| **Non-UTC timestamps** | `stepDateTime` compared incorrectly during audit ordering | Require timezone-aware `datetime` and serialize with explicit offset |

## Compliance & governance alignment

| Control / framework | Requirement | ISO 19115 lineage field |
|---------------------|-------------|-------------------------|
| INSPIRE Metadata Regulation | Lineage statement mandatory for datasets | `LI_Lineage.statement` |
| ISO 19157 (data quality) | Report measurable quality results | `DQ_Element` linked from `LI_ProcessStep` |
| ISO 19115-2 (imagery) | Record processing algorithm & parameters | `LE_ProcessStep.processingInformation` |
| FISMA / NIST SP 800-53 (AU family) | Attributable, timestamped processing record | `LI_ProcessStep.processor` + `stepDateTime` |
| Reproducibility mandates | Traceable inputs to every output | `LI_ProcessStep.source` → `LI_Source.sourceCitation` |

For the FISMA audit-evidence angle in depth, see [FISMA compliance for spatial systems](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/fisma-compliance-for-spatial-systems/); for how these same fields map onto privacy controls, see [GDPR for geospatial data](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/gdpr-for-geospatial-data/). Populate the model once, validate it with the [Python validation how-to](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/iso-19115-lineage-implementation/validating-iso-19115-lineage-with-python/), and every framework above reads from the same authoritative structure.
