# INSPIRE Metadata Mandate

The EU INSPIRE Directive (2007/2 EC) requires public authorities in member states to document their spatial data sets and services with harmonized metadata so that data across national borders can be discovered, evaluated, and used. For a data steward the obligation is concrete: every data set covering one of the INSPIRE spatial data themes — from administrative units to hydrography to protected sites — must carry metadata that conforms to the INSPIRE Implementing Rules for metadata, and a central element of that metadata is a **lineage statement** describing the history and processing that produced the data. This guide, part of the [Regulatory Compliance & Standards Mapping](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/) section, explains which INSPIRE metadata elements are mandatory, what the lineage obligation actually demands, and how to generate conformant lineage statements from a Python pipeline.

INSPIRE does not invent a metadata format from scratch. Its Implementing Rules are built on the ISO 19115 content model and encoded with ISO 19139 XML, so an INSPIRE-conformant record is an ISO metadata record with additional constraints and multiplicity rules layered on top. That layering has a practical consequence: if your provenance capture already targets ISO lineage, you are most of the way to INSPIRE conformance, and the same processing events can populate both. The remainder of this page maps the INSPIRE requirements onto lineage fields your pipeline can emit, and the [companion how-to on generating conformant metadata with pygeometa](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/inspire-metadata-mandate/generating-inspire-compliant-metadata-with-pygeometa/) shows the XML generation end to end.

<svg viewBox="0 0 620 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="INSPIRE metadata stack: spatial data theme feeds a lineage statement and metadata elements, encoded as ISO 19139 XML and validated against implementing rules">
<title>INSPIRE metadata and lineage conformity flow</title>
<rect width="620" height="250" fill="#fffdf8" rx="10"/>
<defs><marker id="ia" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#2b1d12"/></marker></defs>
<rect x="20" y="95" width="120" height="60" rx="8" fill="#3f5a30"/>
<text x="80" y="120" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="700" fill="#fffdf8">Spatial Data</text>
<text x="80" y="137" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">theme + pipeline</text>
<rect x="185" y="30" width="140" height="56" rx="8" fill="#5e7b4a"/>
<text x="255" y="53" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">Lineage Statement</text>
<text x="255" y="70" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">source + process</text>
<rect x="185" y="164" width="140" height="56" rx="8" fill="#b85c3b"/>
<text x="255" y="187" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">Metadata Elements</text>
<text x="255" y="204" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">id / extent / CRS</text>
<line x1="140" y1="115" x2="182" y2="70" stroke="#2b1d12" stroke-width="2" marker-end="url(#ia)"/>
<line x1="140" y1="135" x2="182" y2="185" stroke="#2b1d12" stroke-width="2" marker-end="url(#ia)"/>
<rect x="370" y="95" width="120" height="60" rx="8" fill="#5a3c25"/>
<text x="430" y="120" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">ISO 19139</text>
<text x="430" y="137" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">XML encoding</text>
<line x1="325" y1="62" x2="368" y2="110" stroke="#2b1d12" stroke-width="1.5" marker-end="url(#ia)"/>
<line x1="325" y1="190" x2="368" y2="142" stroke="#2b1d12" stroke-width="1.5" marker-end="url(#ia)"/>
<rect x="524" y="95" width="76" height="60" rx="8" fill="#c8a781"/>
<text x="562" y="120" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#2b1d12">Conformity</text>
<text x="562" y="137" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#2b1d12">impl. rules</text>
<line x1="490" y1="125" x2="522" y2="125" stroke="#2b1d12" stroke-width="2" marker-end="url(#ia)"/>
</svg>

## Foundational concepts

INSPIRE metadata answers three questions about a data set: *what it is* (identification), *whether you may use it* (constraints and quality), and *how it came to be* (lineage). The identification block carries a resource title, a unique resource identifier, the spatial data theme keyword drawn from the GEMET INSPIRE themes vocabulary, a geographic bounding box, and the coordinate reference system. The quality-and-lineage block is where provenance lives: INSPIRE requires a **lineage statement** — free-text describing the source data and the processing steps — as a mandatory element for data sets.

The lineage statement is not merely a courtesy note. Under the Implementing Rules it is the element that lets a downstream user judge fitness for purpose: a hydrography layer reprojected from a national grid to `EPSG:3035` (the INSPIRE-recommended ETRS89-LAEA) and generalized to a target scale must say so, because those transformations change what the data can legitimately support. A steward who already captures transformation events for security or catalogue purposes has the raw material for this statement; the task is to render it in the ISO structure INSPIRE expects. Where your organization also draws formal system boundaries, aligning the lineage scope with the ingress and egress points defined when [establishing trust boundaries in GIS](https://www.provenance-tracking.com/geospatial-lineage-fundamentals-architecture/establishing-trust-boundaries-in-gis/) keeps the statement honest about what processing occurred inside your authority.

**Conformity** is its own element. An INSPIRE record must declare whether it conforms to the Commission Regulation on interoperability of spatial data sets and services, citing the specification and a pass/fail/not-evaluated degree. Asserting conformity you cannot evidence is a finding waiting to happen, which is why the lineage statement and the conformity declaration should be produced from the same pipeline metadata.

## Standards & compliance alignment

Because INSPIRE reuses ISO 19115 for content and ISO 19139 for encoding, the mapping from your provenance model to the record is direct: a source data set becomes an ISO `LI_Source`, a processing step becomes an `LI_ProcessStep`, and the human-readable summary becomes the `LI_Lineage.statement`. Building your provenance capture against the ISO model therefore satisfies INSPIRE and the ISO mandate at once — the detail of that model lives in the [ISO 19115 lineage implementation](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/iso-19115-lineage-implementation/) topic. For a wider view of how INSPIRE sits beside FISMA, GDPR, and the ISO family, the [compliance framework mapping](https://www.provenance-tracking.com/geospatial-lineage-fundamentals-architecture/compliance-framework-mapping/) overview shows where the obligations overlap and where they diverge.

The architectural implication is that lineage should be captured as structured, per-step records — source identifier, processing description, processor, and date — rather than as an after-the-fact prose paragraph. Structured steps can be rendered into the ISO XML automatically and can also be summarized into the free-text statement; prose written by hand can be neither validated nor reused.

## Step-by-step

### 1. Capture lineage as structured process steps

Model each transformation as a step with the fields ISO 19139 will need. Purpose: hold provenance in a form that renders to both the per-step XML and the summary statement.

```python
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import date

@dataclass(slots=True)
class ProcessStep:
    description: str          # -> LI_ProcessStep.description
    processor: str           # -> responsible party
    step_date: date          # -> LI_ProcessStep.dateTime
    source_id: str           # -> LI_Source.sourceCitation identifier
    source_crs: str          # e.g. "EPSG:4258" (ETRS89)
    result_crs: str          # e.g. "EPSG:3035" (ETRS89-LAEA)

@dataclass(slots=True)
class DatasetLineage:
    theme: str               # GEMET INSPIRE theme keyword, e.g. "Hydrography"
    resource_id: str         # unique resource identifier (a stable URN or code)
    steps: list[ProcessStep] = field(default_factory=list)
```

Recording both `source_crs` and `result_crs` per step means the statement can report projection changes explicitly, the transformation that most often surprises INSPIRE data users.

### 2. Render a conformant free-text lineage statement

INSPIRE requires the statement even when per-step metadata is present. Purpose: derive a deterministic, human-readable summary from the structured steps so the two never disagree.

```python
def build_lineage_statement(lineage: DatasetLineage) -> str:
    if not lineage.steps:
        raise ValueError("INSPIRE lineage statement is mandatory: at least one step required")
    parts: list[str] = [
        f"Data set for INSPIRE theme '{lineage.theme}' (resource {lineage.resource_id})."
    ]
    for i, step in enumerate(lineage.steps, start=1):
        crs_note = (
            f" reprojected {step.source_crs} to {step.result_crs}"
            if step.source_crs != step.result_crs else ""
        )
        parts.append(
            f"Step {i} ({step.step_date.isoformat()}, {step.processor}): "
            f"{step.description}{crs_note}; source {step.source_id}."
        )
    return " ".join(parts)
```

Guarding against an empty step list enforces the mandatory-element rule at generation time rather than at validation time. Feeding these fields into an ISO 19139 document is the subject of the [pygeometa how-to](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/inspire-metadata-mandate/generating-inspire-compliant-metadata-with-pygeometa/), which turns the `DatasetLineage` object into schema-valid XML.

### 3. Assert conformity from evidenced steps

Purpose: declare conformity to the Implementing Rules only when the record actually carries the mandatory elements.

```python
def conformity_degree(lineage: DatasetLineage, has_extent: bool, has_crs: bool) -> str:
    mandatory_present = (
        bool(lineage.steps)          # lineage statement derivable
        and bool(lineage.theme)      # spatial data theme classified
        and bool(lineage.resource_id)
        and has_extent               # geographic bounding box present
        and has_crs                  # reference system present
    )
    return "conformant" if mandatory_present else "not evaluated"
```

Deriving the conformity degree from present elements prevents the common failure of a record that claims conformance while missing a mandatory field.

## Configuration reference

| Parameter | Type | Valid values | Default |
|-----------|------|--------------|---------|
| `theme` | string | a GEMET INSPIRE theme keyword | required |
| `resource_id` | string | stable URN or agency code, globally unique | required |
| `default_crs` | string | `EPSG:3035`, `EPSG:4258`, `EPSG:4326` | `EPSG:3035` |
| `metadata_language` | string | ISO 639-2 three-letter code (e.g. `eng`, `deu`) | `eng` |
| `conformity_spec` | string | citation of the interoperability Implementing Rule | required |
| `lineage_max_chars` | int | 1 – 4000 (keep statement within catalogue limits) | 4000 |
| `charset` | string | `utf8` | `utf8` |

## Common failure modes & mitigations

| Failure | Symptom | Mitigation |
|---------|---------|------------|
| **Missing lineage element** | Validator flags mandatory `LI_Lineage` absent; record rejected by the national geoportal | Enforce a non-empty step list at generation time, as `build_lineage_statement` does |
| **Silent CRS drift** | Statement claims `EPSG:3035` but the delivered file is still in the source grid | Read the CRS back from the output file and compare to `result_crs` before writing metadata |
| **Wrong theme keyword** | Free-text theme that is not from the GEMET INSPIRE vocabulary; discovery filters miss the record | Constrain `theme` to the controlled vocabulary; reject values outside it |
| **Unstable resource identifier** | Republished data set gets a new id each run, breaking downstream links | Derive `resource_id` from a stable code, never from a timestamp or run id |
| **Overstated conformity** | Record declares conformant but lacks extent or CRS | Compute the conformity degree from present elements rather than hardcoding it |

## Compliance & governance alignment

| INSPIRE requirement | Obligation in brief | Lineage field / practice that satisfies it |
|---------------------|---------------------|---------------------------------------------|
| Lineage (mandatory) | Statement of source and processing history | `DatasetLineage.steps` rendered by `build_lineage_statement` |
| Spatial data theme | Classify against INSPIRE themes | `theme` from the GEMET controlled vocabulary |
| Unique resource identifier | Persistent, unique id for the resource | Stable `resource_id` URN |
| Geographic bounding box | Spatial extent of the data set | Computed extent passed to `conformity_degree` |
| Coordinate reference system | Declared reference system | `result_crs`, defaulting to ETRS89-LAEA `EPSG:3035` |
| Conformity | Degree of conformity to Implementing Rules | `conformity_degree` derived from present elements |
| Encoding | ISO 19139 XML | Rendered per the pygeometa how-to |

## Phased rollout

A pragmatic path to INSPIRE conformance starts with classification and identity: pin every data set to a GEMET theme and a stable resource identifier, since a record cannot be discovered without them. Next, wire the structured `ProcessStep` capture into the pipelines that produce your themed data sets, so lineage accrues automatically rather than being reconstructed. Then generate the ISO 19139 XML and validate its structure, and finally derive the conformity declaration from the evidenced elements and publish to your national geoportal. Each stage has a clear success test: a record is INSPIRE-ready only when it carries a theme, a unique identifier, an extent, a CRS, and a lineage statement that truthfully names every reprojection and generalization applied — and when re-running the pipeline over unchanged inputs regenerates a byte-identical statement.

Approached this way, the INSPIRE metadata mandate becomes an output of the pipeline rather than a documentation chore bolted on before a deadline, and the same structured lineage feeds your ISO catalogue and your national reporting obligations without duplicate effort.
