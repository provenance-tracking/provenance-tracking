# FISMA Compliance for Spatial Systems

Federal geospatial systems that store, process, or publish authoritative spatial data fall under the Federal Information Security Modernization Act (FISMA), which obliges agencies to implement the security and privacy controls catalogued in NIST Special Publication 800-53. For a GIS platform the practical problem is not choosing controls — the control baseline is dictated by the system's FIPS 199 impact level — but *demonstrating* that each control operates continuously across pipelines that reproject rasters, join parcel boundaries, and republish tiled services many times a day. Lineage data is the connective tissue that turns an abstract control statement into assessable evidence: every audit record, hash, and derivation edge you capture is a candidate artifact for a Security Assessment Report. This guide sits within the broader [Regulatory Compliance & Standards Mapping](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/) section and focuses on the four control families that lineage most directly satisfies.

The families that matter for provenance are Audit and Accountability (AU), Configuration Management (CM), System and Information Integrity (SI), and Access Control (AC). A steward who logs *who* ran *which* transformation, against *which* source version, producing *which* output hash, has generated the raw material for AU-2, AU-3, CM-3, SI-7, and AC-6 in a single structured event. The remainder of this page shows how to model those events, emit them from a Python pipeline, and organize them so an assessor can trace a control to concrete, tamper-evident evidence. Two companion pages go deeper: one on the [machine-readable control mapping](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/fisma-compliance-for-spatial-systems/fisma-control-mapping-for-gis-pipelines/) that binds controls to pipeline hooks, and one on [assembling the signed audit evidence package](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/fisma-compliance-for-spatial-systems/building-an-audit-evidence-package/) an assessor actually reviews.

<svg viewBox="0 0 620 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Workflow showing a geospatial pipeline emitting lineage events that map to four NIST 800-53 control families and roll up into an audit evidence package">
<title>Lineage-to-control evidence flow for FISMA</title>
<rect width="620" height="260" fill="#fffdf8" rx="10"/>
<defs><marker id="fa" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#2b1d12"/></marker></defs>
<rect x="20" y="100" width="120" height="60" rx="8" fill="#3f5a30"/>
<text x="80" y="126" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="700" fill="#fffdf8">GIS Pipeline</text>
<text x="80" y="143" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">reproject / join</text>
<rect x="190" y="100" width="130" height="60" rx="8" fill="#b85c3b"/>
<text x="255" y="126" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="700" fill="#fffdf8">Lineage Event</text>
<text x="255" y="143" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">actor+hash+params</text>
<line x1="140" y1="130" x2="185" y2="130" stroke="#2b1d12" stroke-width="2" marker-end="url(#fa)"/>
<rect x="380" y="12" width="118" height="42" rx="6" fill="#5e7b4a"/>
<text x="439" y="30" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">AU-2 / AU-3</text>
<text x="439" y="45" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">audit records</text>
<rect x="380" y="66" width="118" height="42" rx="6" fill="#5a3c25"/>
<text x="439" y="84" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">CM-3</text>
<text x="439" y="99" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">config change</text>
<rect x="380" y="120" width="118" height="42" rx="6" fill="#a24a2c"/>
<text x="439" y="138" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">SI-7</text>
<text x="439" y="153" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">hash integrity</text>
<rect x="380" y="174" width="118" height="42" rx="6" fill="#4a5c3f"/>
<text x="439" y="192" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">AC-6</text>
<text x="439" y="207" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">least privilege</text>
<line x1="320" y1="120" x2="376" y2="40" stroke="#2b1d12" stroke-width="1.5" marker-end="url(#fa)"/>
<line x1="320" y1="126" x2="376" y2="88" stroke="#2b1d12" stroke-width="1.5" marker-end="url(#fa)"/>
<line x1="320" y1="138" x2="376" y2="140" stroke="#2b1d12" stroke-width="1.5" marker-end="url(#fa)"/>
<line x1="320" y1="146" x2="376" y2="192" stroke="#2b1d12" stroke-width="1.5" marker-end="url(#fa)"/>
<rect x="540" y="88" width="66" height="84" rx="8" fill="#c8a781"/>
<text x="573" y="122" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#2b1d12">Evidence</text>
<text x="573" y="137" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#2b1d12">Package</text>
<line x1="498" y1="33" x2="538" y2="110" stroke="#5a3c25" stroke-width="1.5" marker-end="url(#fa)"/>
<line x1="498" y1="195" x2="538" y2="150" stroke="#5a3c25" stroke-width="1.5" marker-end="url(#fa)"/>
</svg>

## Foundational concepts

FISMA compliance rests on a **system boundary**: the authorization boundary within which all components inherit a common set of controls. For geospatial systems the boundary usually spans an ingestion tier, a processing tier running GDAL/rasterio jobs, a spatial database, and a publication tier serving OGC endpoints. Drawing that boundary well is a prerequisite for meaningful lineage, because a derivation edge that crosses the boundary silently is exactly the event an assessor scrutinizes. If you have not yet formalized where your system begins and ends, start with [establishing trust boundaries in GIS](https://www.provenance-tracking.com/geospatial-lineage-fundamentals-architecture/establishing-trust-boundaries-in-gis/), which defines the ingress and egress points that lineage events must annotate.

A **control** in 800-53 is a requirement statement (for example, AU-3 mandates that audit records contain specific content elements). A **control assessment** verifies the control is implemented and effective, and it consumes **evidence** — artifacts that a control produced. The insight that makes lineage tractable is that a well-formed provenance event is a superset of the AU-3 content requirement: it already carries a timestamp, an event type, an actor identity, an outcome, and the affected resource. Rather than building a separate audit subsystem, you enrich the provenance record you were already writing and let it serve double duty.

The four families this page targets decompose as follows. **AU** governs what you log, how records are structured (AU-3), and how they are protected from modification (AU-9). **CM** governs baseline configuration and the review of changes to it (CM-3), which for a pipeline means the transformation parameters and tool versions. **SI** governs integrity, and SI-7 specifically calls for integrity verification of software, firmware, and information — cryptographic hashes of raster and vector outputs answer directly to it. **AC** governs who may act; AC-6 (least privilege) is evidenced by recording the authenticated principal on every write.

## Standards & compliance alignment

800-53 does not stand alone. Its AU family aligns conceptually with the W3C PROV data model: an audit record's *actor* is a `prov:Agent`, its *transformation* is a `prov:Activity`, and its *output* is a `prov:Entity`. Capturing lineage in PROV terms therefore yields records that are simultaneously assessable under FISMA and interoperable with the metadata standards other agencies expect. Where your spatial metadata must also satisfy catalogue obligations, the same events feed an [ISO 19115 lineage implementation](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/iso-19115-lineage-implementation/), so a single event pipeline discharges both the security-control and the geospatial-metadata requirements. For a broader view of how frameworks map onto one another, the [compliance framework mapping](https://www.provenance-tracking.com/geospatial-lineage-fundamentals-architecture/compliance-framework-mapping/) overview places FISMA alongside INSPIRE and ISO obligations.

The architectural implication is that lineage events should be emitted as structured, append-only records with a stable schema, written to storage that supports write-once semantics (satisfying AU-9 protection of audit information). Ad-hoc log lines in a text file will not survive an assessment; a typed event with an integrity hash will.

## Step-by-step

### 1. Model the audit event to AU-2 and AU-3 content

AU-2 requires you to define which events are auditable; AU-3 requires each record to contain the type of event, when it occurred, where it occurred, the source, the outcome, and the identity of any associated individuals. Encode those elements explicitly as a dataclass so no field is forgotten. Purpose: produce one canonical record that satisfies both controls at emission time.

```python
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
import json
import hashlib

@dataclass(slots=True)
class LineageAuditEvent:
    event_type: str                 # AU-3: type of event, e.g. "raster.reproject"
    occurred_at: str                # AU-3: when (RFC 3339 UTC)
    component: str                  # AU-3: where, e.g. "processing-tier/worker-07"
    actor: str                      # AC-6 / AU-3: authenticated principal
    source_uri: str                 # AU-3: source of the event
    output_uri: str                 # affected resource
    outcome: str                    # AU-3: success | failure
    crs: str                        # spatial context, e.g. "EPSG:5070"
    parameters: dict[str, str] = field(default_factory=dict)  # CM-3 change detail
    output_sha256: str | None = None  # SI-7 integrity value

    def canonical_json(self) -> str:
        return json.dumps(asdict(self), sort_keys=True, separators=(",", ":"))

    def record_id(self) -> str:
        # Deterministic id derived from content; stable across re-emission.
        return hashlib.sha256(self.canonical_json().encode("utf-8")).hexdigest()[:32]
```

The `event_type` enumeration is your AU-2 auditable-events list; keep it in version control so additions are themselves change-managed. The machine-readable form of this mapping — control identifiers bound to the fields above — is developed in the [FISMA control mapping for GIS pipelines](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/fisma-compliance-for-spatial-systems/fisma-control-mapping-for-gis-pipelines/) companion.

### 2. Compute SI-7 integrity hashes for outputs

SI-7 is satisfied by attaching a cryptographic hash to every output artifact so that later modification is detectable. For rasters this must be computed over the file bytes after the pipeline finishes writing. Purpose: bind a tamper-evident integrity value to the event before it is sealed.

```python
from pathlib import Path

def sha256_file(path: Path, chunk_size: int = 1 << 20) -> str:
    """Stream a file through SHA-256; safe for multi-GB GeoTIFFs."""
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()

def finalize_output(event: LineageAuditEvent, output_path: Path) -> LineageAuditEvent:
    event.output_sha256 = sha256_file(output_path)
    return event
```

Streaming the hash in fixed chunks keeps memory flat regardless of raster size. The same hashing discipline, applied at the point of raster generation, is covered in depth by [automated hash generation for rasters](https://www.provenance-tracking.com/python-automation-pipeline-integration/automated-hash-generation-for-rasters/); reuse that module rather than reimplementing the digest logic so your CI checksums and your audit records agree byte-for-byte.

### 3. Emit the record to append-only storage (AU-9)

AU-9 requires audit information to be protected from unauthorized modification. Write each record as one JSON line to storage that enforces write-once semantics, and never rewrite a line in place. Purpose: guarantee the record's immutability so it survives assessment.

```python
def emit_event(event: LineageAuditEvent, sink: Path) -> str:
    """Append one immutable audit record; returns its content id."""
    if event.outcome not in {"success", "failure"}:
        raise ValueError(f"AU-3 outcome must be success|failure, got {event.outcome!r}")
    line = json.dumps(
        {"record_id": event.record_id(), **json.loads(event.canonical_json())},
        separators=(",", ":"),
    )
    with sink.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    return event.record_id()

# Emission at the end of a reprojection step:
evt = LineageAuditEvent(
    event_type="raster.reproject",
    occurred_at=datetime.now(timezone.utc).isoformat(),
    component="processing-tier/worker-07",
    actor="svc-reproject@agency.gov",
    source_uri="s3://raw/dem_2026.tif",
    output_uri="s3://derived/dem_2026_5070.tif",
    outcome="success",
    crs="EPSG:5070",
    parameters={"resampling": "bilinear", "gdal": "3.8.4"},
)
evt = finalize_output(evt, Path("/data/derived/dem_2026_5070.tif"))
record_id = emit_event(evt, Path("/var/lineage/audit.jsonl"))
```

Recording the `gdal` version in `parameters` gives CM-3 its change detail: an assessor can see exactly which tool build produced the output, and a diff between runs surfaces configuration drift.

## Configuration reference

| Parameter | Type | Valid values | Default |
|-----------|------|--------------|---------|
| `audit_sink` | path | writable append-only path or WORM bucket URI | `/var/lineage/audit.jsonl` |
| `hash_algorithm` | string | `sha256`, `sha512` | `sha256` |
| `chunk_size` | int | 65536 – 8388608 (bytes) | 1048576 |
| `impact_level` | string | `low`, `moderate`, `high` (FIPS 199) | `moderate` |
| `auditable_events` | list | version-controlled `event_type` enumeration | required |
| `retention_days` | int | ≥ 2557 (7-year federal minimum, verify per SSP) | 2557 |
| `clock_source` | string | `ntp`, `chrony` (must be synchronized for AU-8) | `chrony` |

## Common failure modes & mitigations

| Failure | Symptom | Mitigation |
|---------|---------|------------|
| **Silent CRS drift** | Output labelled `EPSG:4326` but pipeline reprojected to `EPSG:5070`; lineage `crs` disagrees with file metadata | Read the CRS back from the written file with `rasterio` and assert it equals `event.crs` before emitting |
| **Log truncation** | Audit file rotated with `w` mode or truncated by a full disk, breaching AU-9 | Use append-only sinks or WORM object storage; monitor free space and fail the run rather than drop records |
| **Hash computed pre-write** | SI-7 value hashes a buffer that differs from the flushed file (e.g. sidecar not included) | Compute the digest from the on-disk path after `close()`/`flush()`, never from the in-memory array |
| **Clock skew** | `occurred_at` timestamps non-monotonic across workers, undermining AU-8 ordering | Synchronize all nodes via NTP/chrony; record UTC only, never local time |
| **Missing actor** | Service account writes with a shared identity, defeating AC-6 attribution | Issue per-service credentials; reject events whose `actor` is empty at emission |

## Compliance & governance alignment

| NIST 800-53 control | Requirement in brief | Lineage practice that satisfies it |
|---------------------|----------------------|-------------------------------------|
| AU-2 | Define auditable events | Version-controlled `event_type` enumeration |
| AU-3 | Record content elements | `LineageAuditEvent` fields: type, time, component, actor, source, outcome |
| AU-8 | Time stamps | UTC `occurred_at` from an NTP-synchronized clock |
| AU-9 | Protection of audit information | Append-only / WORM sink; content-derived `record_id` |
| CM-3 | Configuration change control | `parameters` capturing tool versions and transform settings |
| SI-7 | Software & information integrity | `output_sha256` over the finalized artifact |
| AC-6 | Least privilege | Per-service `actor` attribution on every write |

## Phased rollout

Treat FISMA lineage as an incremental capability rather than a one-time project. A workable sequence is: first, define the auditable-events list and emit AU-3-complete records for the highest-impact pipeline; second, add SI-7 hashing and move the sink to WORM storage; third, extend CM-3 parameter capture across every transformation and wire in per-service AC-6 identities; finally, automate rollup into the [audit evidence package](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/fisma-compliance-for-spatial-systems/building-an-audit-evidence-package/) so an assessment request is answered by running a script rather than assembling a folder by hand. Success at each stage is measurable: a control is "implemented" only when you can produce, for a randomly chosen production run, the record that evidences it — and verify its integrity hash — in under a minute.

Handled this way, FISMA stops being an annual scramble and becomes a property of the pipeline. Every reprojection, join, and publication leaves behind an assessable, tamper-evident trace, and the assessor's questions map directly onto queries your lineage store can already answer.
