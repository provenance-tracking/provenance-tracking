# GDPR for Geospatial Data Lineage

A coordinate is not automatically anonymous. A latitude and longitude that resolves to a residential parcel, a habitual commuting route, or a single visit to a medical facility is personal data under the General Data Protection Regulation, and once a dataset contains it, every activity that ingests, reprojects, joins, or publishes that data inherits obligations. The problem for geospatial teams is that these obligations are historical: when a data subject invokes their right of access or erasure, you must reconstruct what you did with their location, when, on what lawful basis, and where it flowed — sometimes years after the processing. Lineage is the only mechanism that answers those questions without heroic archaeology, which is why GDPR compliance for location data is fundamentally a provenance-tracking problem rather than a consent-banner problem.

This guide applies GDPR to spatial data lineage concretely: how to detect personal data hiding in coordinates, how to log lawful basis on every activity, how to reconstruct data-subject rights from lineage rows, how to produce Data Protection Impact Assessment evidence, and how to reconcile the right to erasure with an immutable audit trail. It sits within the broader [regulatory compliance and standards mapping](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/) section, whose control-to-field philosophy drives everything below, and it feeds two companion pages: a precise [mapping of GDPR controls to lineage fields](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/gdpr-for-geospatial-data/mapping-gdpr-controls-to-lineage-fields/) and a how-to on [anonymizing location data for GDPR](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/gdpr-for-geospatial-data/anonymizing-location-data-for-gdpr/).

<svg viewBox="0 0 620 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Data subject rights workflow reconstructed from lineage: a request enters, is resolved against the lineage store by subject key, and produces access, rectification, or erasure responses while preserving the audit trail">
<title>Reconstructing data-subject rights from the lineage store</title>
<rect width="620" height="260" fill="#fffdf8" rx="10"/>
<rect x="18" y="96" width="120" height="64" rx="8" fill="#b85c3b"/>
<text x="78" y="122" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="700" fill="#fffdf8">Subject</text>
<text x="78" y="138" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">request (DSAR</text>
<text x="78" y="151" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">Art. 15/16/17)</text>
<rect x="190" y="80" width="140" height="96" rx="8" fill="#3f5a30"/>
<text x="260" y="112" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="700" fill="#fffdf8">Lineage store</text>
<text x="260" y="130" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">append-only rows</text>
<text x="260" y="145" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">subject_key index</text>
<text x="260" y="160" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">lawful_basis + hash</text>
<rect x="392" y="20" width="128" height="52" rx="8" fill="#5e7b4a"/>
<text x="456" y="42" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">Access (Art. 15)</text>
<text x="456" y="58" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">assemble history</text>
<rect x="392" y="102" width="128" height="52" rx="8" fill="#c8a781"/>
<text x="456" y="124" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#2b1d12">Rectify (Art. 16)</text>
<text x="456" y="140" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#2b1d12">append correction</text>
<rect x="392" y="184" width="128" height="52" rx="8" fill="#a24a2c"/>
<text x="456" y="206" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">Erase (Art. 17)</text>
<text x="456" y="222" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">crypto-shred payload</text>
<rect x="544" y="102" width="60" height="52" rx="8" fill="#5a3c25"/>
<text x="574" y="124" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" font-weight="700" fill="#fffdf8">Audit</text>
<text x="574" y="139" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">trail kept</text>
<defs><marker id="ar" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#2b1d12"/></marker></defs>
<line x1="138" y1="128" x2="190" y2="128" stroke="#2b1d12" stroke-width="2" marker-end="url(#ar)"/>
<line x1="330" y1="110" x2="392" y2="50" stroke="#2b1d12" stroke-width="2" marker-end="url(#ar)"/>
<line x1="330" y1="128" x2="392" y2="128" stroke="#2b1d12" stroke-width="2" marker-end="url(#ar)"/>
<line x1="330" y1="146" x2="392" y2="206" stroke="#2b1d12" stroke-width="2" marker-end="url(#ar)"/>
<line x1="520" y1="210" x2="560" y2="154" stroke="#5a3c25" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#ar)"/>
</svg>

## Prerequisites

- [ ] Python 3.10+ with `geopandas` 0.14+, `pyproj` 3.6+, and `psycopg[binary]` 3.1+ installed in a virtual environment
- [ ] A PostgreSQL 15+ / PostGIS 3.4+ lineage store, or the schema patterns from the [structuring JSON/XML lineage documents](https://www.provenance-tracking.com/storage-indexing-query-optimization/structuring-jsonxml-lineage-documents/) guide
- [ ] An append-only lineage table with `subject_key`, `lawful_basis`, `purpose`, and `content_hash` columns (see the configuration reference below)
- [ ] A defined lawful basis per processing purpose, agreed with your data protection officer, before any personal location data is ingested
- [ ] A key-management service capable of per-subject encryption keys, if you intend to satisfy erasure by crypto-shredding
- [ ] Read access to the section overview's control-to-field philosophy in [regulatory compliance and standards mapping](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/)

## Step-by-step

### 1. Detect personal data in coordinates

Before you can log a lawful basis, you must know which columns are in scope. A coordinate becomes personal data when its precision and context allow it to single out a person. The purpose of this step is to flag processing that touches identifiable location so the pipeline can require a lawful basis downstream. Use resolution and linkage as the test: sub-metre points tied to a subject identifier are almost always personal; a coarse municipal centroid usually is not.

```python
from __future__ import annotations
import geopandas as gpd


def is_personal_location(gdf: gpd.GeoDataFrame, subject_col: str | None) -> bool:
    """Heuristic: identifiable if a subject key exists and points are high-resolution."""
    if subject_col and subject_col in gdf.columns:
        return True
    # Point geometries with sub-block precision are treated as identifiable.
    if (gdf.geometry.geom_type == "Point").all():
        # WGS84 degrees: ~5 decimal places ≈ 1 m; flag anything finer than a block.
        precise = gdf.geometry.apply(lambda p: round(p.x, 4) != round(p.x, 3))
        return bool(precise.any())
    return False
```

Anything this function flags must carry a lawful basis and, where feasible, be routed through the [anonymizing location data for GDPR](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/gdpr-for-geospatial-data/anonymizing-location-data-for-gdpr/) workflow before wider processing.

### 2. Log lawful basis on every activity

Article 6 requires that every processing activity rest on a lawful basis, and Article 5 requires purpose limitation. The purpose of this step is to make basis and purpose non-nullable at capture so no personal-location activity can be recorded without them. Write the basis into the same lineage event as the transformation itself.

```python
from __future__ import annotations
from datetime import datetime, timezone
import hashlib
import json
import psycopg


LAWFUL_BASES = {"consent", "contract", "legal_obligation",
                "vital_interests", "public_task", "legitimate_interests"}


def log_activity(conn: psycopg.Connection, *, dataset_id: str, subject_key: str,
                 activity: str, lawful_basis: str, purpose: str) -> str:
    if lawful_basis not in LAWFUL_BASES:
        raise ValueError(f"invalid Art. 6 basis: {lawful_basis}")
    ts = datetime.now(timezone.utc)
    body = json.dumps({"dataset_id": dataset_id, "subject_key": subject_key,
                       "activity": activity, "lawful_basis": lawful_basis,
                       "purpose": purpose, "ts": ts.isoformat()},
                      sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(body.encode()).hexdigest()
    conn.execute(
        """INSERT INTO lineage_event
           (dataset_id, subject_key, activity, lawful_basis, purpose,
            valid_from, content_hash)
           VALUES (%s, %s, %s, %s, %s, %s, %s)""",
        (dataset_id, subject_key, activity, lawful_basis, purpose, ts, digest),
    )
    return digest
```

### 3. Reconstruct data-subject rights from lineage

Articles 15 through 17 give subjects the rights of access, rectification, and erasure. The purpose of this step is to resolve any of those requests from the lineage store alone, keyed on `subject_key`. Because the store is append-only, an access request is a filtered read, and a rectification is a new corrective event rather than an in-place edit.

```sql
-- Article 15: assemble the full processing history for one data subject.
SELECT dataset_id, activity, lawful_basis, purpose, valid_from, content_hash
FROM lineage_event
WHERE subject_key = %(subject_key)s
ORDER BY valid_from ASC;
```

This single query is the backbone of every rights response; the [mapping of GDPR controls to lineage fields](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/gdpr-for-geospatial-data/mapping-gdpr-controls-to-lineage-fields/) guide turns its columns into a formal Article 30 record. The append-only design is what makes rectification tractable under Article 16: rather than overwrite a wrong geocode in place, which would destroy the audit trail and leave you unable to prove what the record said before, you append a corrective event that supersedes the earlier one. A point-in-time read reconstructs whichever version was authoritative on a given date by filtering on `valid_from`, so the store simultaneously honors the subject's correction and preserves the history a regulator may ask you to defend.

### 4. Produce DPIA evidence

Article 35 requires a Data Protection Impact Assessment for high-risk processing, and large-scale location tracking usually qualifies. The purpose of this step is to derive DPIA inputs — the categories of data, the purposes, and the actual processing performed — from lineage rather than from a self-reported questionnaire.

```sql
-- DPIA input: distinct purposes and bases actually exercised, with volume.
SELECT purpose, lawful_basis, COUNT(*) AS activities,
       MIN(valid_from) AS first_seen, MAX(valid_from) AS last_seen
FROM lineage_event
GROUP BY purpose, lawful_basis
ORDER BY activities DESC;
```

Grounding the DPIA in observed lineage means the assessment reflects what the system does, not what a form claims it does.

### 5. Reconcile erasure with an immutable trail

The right to erasure appears to conflict with an append-only audit log. The purpose of this step is to resolve that conflict with crypto-shredding: encrypt each subject's payload under a per-subject key, and satisfy erasure by destroying the key. The lineage row — its timestamps, activity name, lawful basis, and hash — survives for audit, but the personal payload becomes unrecoverable.

```python
from __future__ import annotations
import psycopg


def erase_subject(conn: psycopg.Connection, subject_key: str) -> int:
    """Crypto-shred: drop the key, retain the tamper-evident metadata."""
    conn.execute("DELETE FROM subject_key_vault WHERE subject_key = %s",
                 (subject_key,))
    # Metadata rows remain; payload ciphertext is now undecryptable.
    cur = conn.execute(
        """UPDATE lineage_event SET payload_erased = TRUE
           WHERE subject_key = %s RETURNING id""", (subject_key,))
    return len(cur.fetchall())
```

## Configuration reference

| Parameter | Type | Valid values | Default |
|-----------|------|--------------|---------|
| `subject_key` | text | opaque per-subject identifier (never raw PII) | required |
| `lawful_basis` | enum | `consent`, `contract`, `legal_obligation`, `vital_interests`, `public_task`, `legitimate_interests` | required |
| `purpose` | text | free text bound to a processing register entry | required |
| `retention_days` | integer | 1–3650 | 730 |
| `precision_flag` | enum | `identifiable`, `anonymized`, `pseudonymized` | `identifiable` |
| `payload_encryption` | enum | `per_subject_key`, `shared_key`, `none` | `per_subject_key` |
| `content_hash` | text | SHA-256 hex over the canonical event body | auto |

## Common failure modes & mitigations

| Failure mode | Symptom | Mitigation |
|--------------|---------|------------|
| Silent CRS drift on personal points | Coordinates shift meters during reprojection, breaking subject matching | Log input and output CRS on every transform; validate `subject_key` joins survive reprojection |
| Anonymization treated as erasure | Truncated geohashes still re-identify via linkage | Record anonymization as its own event; measure k-anonymity, do not assume it |
| Lawful basis backfilled | Activities logged without a basis, patched later | Enforce `NOT NULL` on `lawful_basis`; reject inserts at the pipeline boundary |
| Erasure breaks the hash chain | Deleting rows invalidates downstream content hashes | Crypto-shred the payload, never delete the metadata row |
| Subject key = raw PII | The lineage store itself becomes a breach surface | Store an opaque token; keep the token-to-identity map in a separate vault |

## Compliance & governance alignment

| GDPR article | Requirement | Lineage field or practice |
|--------------|-------------|---------------------------|
| Art. 5(1)(b) | Purpose limitation | `purpose` bound to a processing-register entry |
| Art. 5(1)(e) | Storage limitation | `retention_days`, enforced by scheduled expiry job |
| Art. 6 | Lawful basis for processing | non-nullable `lawful_basis` enum on every event |
| Art. 15 | Right of access | `subject_key`-indexed read of all events |
| Art. 17 | Right to erasure | crypto-shred via `subject_key_vault` key deletion |
| Art. 30 | Records of processing | aggregation over `purpose`, `lawful_basis`, recipients, transfers |
| Art. 35 | Data Protection Impact Assessment | derived from observed `purpose`/`lawful_basis` distribution |
| Art. 44 | Cross-border transfer records | `transfer_destination` and safeguard fields on export events |

These mappings connect directly to the field-level crosswalk in the [control-to-lineage-field mapping](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/gdpr-for-geospatial-data/mapping-gdpr-controls-to-lineage-fields/) guide and to the anonymization practice in the [anonymizing location data for GDPR](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/gdpr-for-geospatial-data/anonymizing-location-data-for-gdpr/) how-to. Treated together, they let a data protection officer answer any subject request or supervisory-authority query from the lineage store itself, which is the entire point of building compliance in at the field level rather than bolting it on at audit time.
