# Regulatory Compliance & Standards Mapping for Geospatial Data Lineage & Provenance Tracking Systems

Regulators rarely ask whether your pipeline is elegant. They ask whether you can prove who touched a dataset, under what authority, using which inputs, and whether the record you present today is the same one that existed at the moment of processing. For geospatial teams, that burden of proof is unusually sharp: a coordinate can be personal data, a reprojection can silently change what a boundary means, and a single satellite ingest can fan out into dozens of derived products that each inherit obligations from their source. Spatial data lineage is the mechanism that turns those obligations into evidence. When lineage is captured as immutable, field-level provenance rather than a loose changelog, a compliance officer can reconstruct the lawful basis, the transformation chain, and the chain of custody for any artifact without emailing three departments and hoping someone kept notes.

This overview frames how a provenance tracking system satisfies regulatory mandates across four regimes that dominate government and enterprise geospatial work: the EU General Data Protection Regulation, the US Federal Information Security Modernization Act, the EU INSPIRE directive, and the ISO 19115 metadata standard. Each is treated the same way throughout this section — as a set of controls that decompose into specific lineage fields your architecture must emit, index, and retain. The goal is not a compliance narrative bolted onto an existing pipeline, but a lineage schema whose columns were chosen because a control demanded them. The companion sections on [geospatial lineage fundamentals and architecture](https://www.provenance-tracking.com/geospatial-lineage-fundamentals-architecture/) and [Python automation and pipeline integration](https://www.provenance-tracking.com/python-automation-pipeline-integration/) supply the modeling and automation primitives this section maps onto regulation.

<svg viewBox="0 0 640 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Matrix mapping four regulatory regimes to the lineage artifacts each one requires: GDPR, FISMA, INSPIRE, and ISO 19115 across lawful basis, access log, spatial extent, transformation record, and retention fields">
<title>Regime-to-lineage-artifact mapping matrix</title>
<rect width="640" height="300" fill="#fffdf8" rx="10"/>
<text x="320" y="26" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="700" fill="#2b1d12">Regulatory regime to lineage artifact</text>
<rect x="20" y="44" width="120" height="34" rx="6" fill="#e7d6bf"/>
<text x="80" y="66" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#2b1d12">Regime</text>
<rect x="144" y="44" width="94" height="34" rx="6" fill="#e7d6bf"/>
<text x="191" y="60" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#2b1d12">Lawful basis</text>
<text x="191" y="72" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#2b1d12">/ authority</text>
<rect x="242" y="44" width="94" height="34" rx="6" fill="#e7d6bf"/>
<text x="289" y="60" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#2b1d12">Access &amp;</text>
<text x="289" y="72" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#2b1d12">actor log</text>
<rect x="340" y="44" width="94" height="34" rx="6" fill="#e7d6bf"/>
<text x="387" y="60" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#2b1d12">Transform</text>
<text x="387" y="72" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#2b1d12">record</text>
<rect x="438" y="44" width="94" height="34" rx="6" fill="#e7d6bf"/>
<text x="485" y="60" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#2b1d12">Spatial</text>
<text x="485" y="72" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#2b1d12">extent/CRS</text>
<rect x="536" y="44" width="84" height="34" rx="6" fill="#e7d6bf"/>
<text x="578" y="60" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#2b1d12">Retention</text>
<text x="578" y="72" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#2b1d12">rule</text>
<rect x="20" y="82" width="120" height="48" rx="6" fill="#b85c3b"/>
<text x="80" y="103" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="700" fill="#fffdf8">GDPR</text>
<text x="80" y="118" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">Personal location</text>
<text x="191" y="110" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="700" fill="#2b1d12">●</text>
<text x="289" y="110" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="700" fill="#2b1d12">●</text>
<text x="387" y="110" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="700" fill="#2b1d12">●</text>
<text x="485" y="110" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="#5a3c25">○</text>
<text x="578" y="110" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="700" fill="#2b1d12">●</text>
<rect x="20" y="134" width="120" height="48" rx="6" fill="#3f5a30"/>
<text x="80" y="155" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="700" fill="#fffdf8">FISMA</text>
<text x="80" y="170" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">Federal systems</text>
<text x="191" y="162" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="700" fill="#2b1d12">●</text>
<text x="289" y="162" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="700" fill="#2b1d12">●</text>
<text x="387" y="162" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="700" fill="#2b1d12">●</text>
<text x="485" y="162" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="#5a3c25">○</text>
<text x="578" y="162" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="700" fill="#2b1d12">●</text>
<rect x="20" y="186" width="120" height="48" rx="6" fill="#5e7b4a"/>
<text x="80" y="207" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="700" fill="#fffdf8">INSPIRE</text>
<text x="80" y="222" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">EU spatial data</text>
<text x="191" y="214" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="#5a3c25">○</text>
<text x="289" y="214" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="700" fill="#2b1d12">●</text>
<text x="387" y="214" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="700" fill="#2b1d12">●</text>
<text x="485" y="214" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="700" fill="#2b1d12">●</text>
<text x="578" y="214" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="#5a3c25">○</text>
<rect x="20" y="238" width="120" height="48" rx="6" fill="#5a3c25"/>
<text x="80" y="259" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="700" fill="#fffdf8">ISO 19115</text>
<text x="80" y="274" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">Metadata model</text>
<text x="191" y="266" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="#5a3c25">○</text>
<text x="289" y="266" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="700" fill="#2b1d12">●</text>
<text x="387" y="266" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="700" fill="#2b1d12">●</text>
<text x="485" y="266" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="700" fill="#2b1d12">●</text>
<text x="578" y="266" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="700" fill="#2b1d12">●</text>
<text x="150" y="298" text-anchor="start" font-family="system-ui,sans-serif" font-size="8" fill="#5a3c25">● required emphasis   ○ conditional / indirect</text>
</svg>

## How compliance differs from generic metadata

Most GIS teams already produce metadata. The difference between a metadata catalog and a compliance-grade lineage record is intent and rigor. Descriptive metadata answers *what a dataset is* — its title, extent, keywords, and contact. Compliance evidence answers *what happened to it and under what authority* — which lawful basis permitted the processing, which actor executed a transformation, which upstream artifacts contributed, and whether the record has been altered since. The provenance modeling patterns described in the [geospatial lineage fundamentals and architecture](https://www.provenance-tracking.com/geospatial-lineage-fundamentals-architecture/) section give you the entity-activity-agent vocabulary; regulation dictates which of those fields become mandatory, non-nullable, and tamper-evident.

Three properties separate compliance lineage from ordinary metadata. First, **immutability**: a record that can be quietly edited proves nothing, so compliance lineage is append-only and cryptographically anchored, typically with a content hash over the payload. Second, **completeness of authority**: every processing activity must carry the legal or policy basis that permitted it, not merely a timestamp. Third, **reconstructability**: an auditor must be able to rebuild the state of a dataset — and the obligations attached to it — as of any past date, which forces temporal validity fields (`valid_from`, `valid_to`) onto every row. A metadata record that lacks these is descriptive documentation; a lineage record that has them is admissible evidence.

There is a further distinction specific to spatial data: obligations propagate along the derivation chain. When a personal-location dataset is clipped, joined, and rasterized into a heat map, the derived product may still carry re-identification risk even though its coordinates look aggregated. Ordinary metadata treats each output as a standalone artifact with its own descriptive record. Compliance lineage instead links the output to its sources, so an obligation attached upstream — a consent basis, a retention deadline, a transfer restriction — is visible on everything derived from it. This inheritance is why the same provenance graph must serve every regime at once: a control applied to a source is meaningless if it cannot be traced to the products that inherit its risk.

## The four regimes and their architectural implications

Rather than treat regulation abstractly, this section details four regimes and pins each to a concrete design decision your storage and pipeline layers must implement.

**GDPR** governs any coordinate that can identify a person — a home address geocode, a phone's GPS trace, a delivery drop point. The regime's architectural implication is that lineage must record a *lawful basis* on every activity that touches personal location data, must be able to reconstruct a data subject's history for access and erasure requests, and must reconcile the right to erasure with an append-only audit trail. The [GDPR for geospatial data](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/gdpr-for-geospatial-data/) guide works through lawful-basis logging, data-subject-rights reconstruction, and the erasure-versus-immutability tension in detail.

**FISMA** governs US federal information systems and inherits the NIST SP 800-53 control catalog. Its architectural implication is that lineage becomes part of the system's audit-and-accountability (AU) and system-and-information-integrity (SI) control evidence: every access is logged with an authenticated actor, integrity is verified by hash, and lineage export feeds the audit evidence package an assessor reviews. The [FISMA compliance for spatial systems](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/fisma-compliance-for-spatial-systems/) guide maps the relevant control families onto pipeline instrumentation.

**INSPIRE** mandates that EU public bodies publish discoverable, interoperable spatial datasets with conformant metadata, including a lineage statement. Its architectural implication is that your lineage store must be able to emit standards-conformant metadata records automatically — not hand-authored XML, but generated documents whose lineage statement is derived from the same provenance graph that drives everything else. The [INSPIRE metadata mandate](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/inspire-metadata-mandate/) guide covers conformance classes and automated generation.

**ISO 19115** is the metadata backbone the other regimes lean on. Its `LI_Lineage`, `LI_Source`, and `LI_ProcessStep` classes provide a standardized shape for expressing exactly the provenance a compliance record needs. The architectural implication is that your internal lineage schema should map cleanly onto these classes so that a single provenance graph can serialize to ISO 19115, feed INSPIRE, and satisfy FISMA integrity checks without divergent data models. The [ISO 19115 lineage implementation](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/iso-19115-lineage-implementation/) guide details that mapping, and the fundamentals section's [compliance framework mapping](https://www.provenance-tracking.com/geospatial-lineage-fundamentals-architecture/compliance-framework-mapping/) overview shows how the standard threads through the wider architecture.

## A control-to-lineage-field philosophy

The organizing principle of this section is that a regulatory control is not satisfied by a policy document; it is satisfied by a field in a record that an auditor can query. This inverts the usual order of work. Instead of building a pipeline and later asking which regulations it happens to meet, you enumerate the controls that apply, decompose each into the smallest piece of evidence that would demonstrate it, and require your lineage schema to emit that piece on every relevant activity. GDPR Article 30's record-of-processing requirement, for example, decomposes into fields for purpose, lawful basis, data categories, recipients, transfer destinations, and retention period — each of which becomes a column your ingestion layer populates rather than a spreadsheet a data protection officer maintains by hand.

This philosophy has a practical payoff: audits stop being projects. When every control maps to a queryable field, generating an audit evidence package is a parameterized query against the lineage store, not a scramble across teams. It also makes gaps visible early — if a control decomposes into a field your schema does not have, you have found a compliance gap during design rather than during an assessment. The crosswalks throughout this section, such as the [GDPR control-to-lineage-field mapping](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/gdpr-for-geospatial-data/mapping-gdpr-controls-to-lineage-fields/), are the concrete expression of this idea: a table whose left column is a legal citation and whose right column is a column name.

## Python automation entry points

Because the same lineage graph must serve four regimes, the automation layer should treat compliance fields as first-class attributes emitted at capture time, not enrichment added later. The following scaffold shows a minimal, framework-agnostic provenance event that carries the compliance-relevant fields all four regimes draw on; it plugs into the workflow hooks and injection techniques described in the [Python automation and pipeline integration](https://www.provenance-tracking.com/python-automation-pipeline-integration/) section.

```python
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json


@dataclass(frozen=True)
class ComplianceLineageEvent:
    """A single append-only provenance event carrying multi-regime fields."""
    dataset_id: str
    activity: str                      # e.g. "reproject", "geocode", "clip"
    actor_id: str                      # authenticated principal (FISMA AU-2)
    lawful_basis: str                  # GDPR Art. 6 basis or agency authority
    purpose: str                       # processing purpose (GDPR Art. 5, Art. 30)
    source_ids: tuple[str, ...]        # upstream artifacts (ISO 19115 LI_Source)
    crs: str                           # coordinate reference system, e.g. EPSG:4326
    bbox: tuple[float, float, float, float]
    retention_until: datetime          # retention rule (GDPR Art. 5(1)(e))
    valid_from: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def content_hash(self) -> str:
        """Tamper-evidence anchor (FISMA SI-7 integrity verification)."""
        payload = json.dumps(
            {
                "dataset_id": self.dataset_id,
                "activity": self.activity,
                "actor_id": self.actor_id,
                "lawful_basis": self.lawful_basis,
                "purpose": self.purpose,
                "source_ids": list(self.source_ids),
                "crs": self.crs,
                "bbox": list(self.bbox),
                "valid_from": self.valid_from.isoformat(),
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()
```

Emitting this single structure at every processing step gives each downstream regime the fields it needs from one source of truth. Serialize it to ISO 19115 for cataloging, filter it by `lawful_basis` and `actor_id` for GDPR and FISMA evidence, and roll it up into the lineage statement INSPIRE requires.

## A phased roadmap for a compliance-ready lineage program

Standing up compliance-grade lineage is best sequenced so that each phase produces auditable value before the next begins.

- **Phase 1 — Baseline capture.** Instrument every pipeline to emit an immutable provenance event with actor, activity, source, CRS, and content hash. Success criterion: no dataset enters the catalog without a hashed lineage record and an authenticated actor.
- **Phase 2 — Authority and basis.** Add lawful-basis and purpose fields to every activity and enforce them as non-nullable. Success criterion: 100% of activities touching personal or restricted data carry a valid basis, verifiable by query.
- **Phase 3 — Standards conformance.** Map the internal schema onto ISO 19115 and generate INSPIRE-conformant metadata automatically. Success criterion: a validator passes on generated metadata for every published dataset without manual editing.
- **Phase 4 — Audit automation.** Turn each applicable control into a parameterized query and schedule evidence-package generation. Success criterion: a full audit evidence package for any regime is produced on demand in minutes, with zero manual reconciliation.

Progressing through these phases converts regulation from a recurring emergency into a property of the pipeline. Each regime detailed in the guides that follow slots into this roadmap: GDPR and FISMA sharpen phases 1 and 2, while INSPIRE and ISO 19115 dominate phase 3. Read on into the [GDPR for geospatial data](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/gdpr-for-geospatial-data/) guide for the regime most likely to reshape how you handle coordinates, then work outward to the federal, European, and metadata standards that share its field-level foundation.

## Operational best practices and spatial pitfalls

Two failure modes recur specifically in spatial compliance work. The first is **silent CRS drift breaking evidence**: if a reprojection is not logged with both input and output CRS, an auditor cannot verify that a boundary shown today means the same thing it meant at capture, and the lineage record becomes unfalsifiable. Always record `crs` on both sides of every transformation. The second is **treating anonymized coordinates as non-personal without proof**: truncating a geohash or jittering a point does not automatically remove personal-data obligations, and re-identification risk survives naive obfuscation. Record the anonymization transformation itself as a lineage event so the reduction in identifiability is documented and defensible. These pitfalls, and the field-level controls that prevent them, are the throughline of every guide in this section.
