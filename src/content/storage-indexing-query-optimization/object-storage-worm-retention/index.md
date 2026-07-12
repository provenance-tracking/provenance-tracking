# Object Storage WORM Retention for Immutable Lineage Archives

Lineage records only carry evidentiary weight if they cannot be silently altered after the fact. A provenance graph that traces a classified raster back to its source scenes proves nothing to an auditor if any operator with write credentials could have rewritten the derivation history last night. Write-once-read-many (WORM) retention on object storage closes that gap: once a lineage archive is committed, the storage layer itself refuses to overwrite or delete the object until a defined retention period elapses, regardless of the caller's IAM permissions. For GIS data stewards and compliance officers, this shifts immutability from a policy promise into a physically enforced property of the archive tier.

This guide sits within the broader [Storage, Indexing & Query Optimization](https://www.provenance-tracking.com/storage-indexing-query-optimization/) section and focuses on the retention layer beneath your queryable stores. It covers Amazon S3 Object Lock in both compliance and governance modes, retention-period and legal-hold mechanics, lifecycle tiering of aged archives, and how object-level immutability underwrites a defensible chain of custody. The queryable lineage documents you serve to analysts still live in PostGIS or a graph store; the immutable archives described here are the notarized originals those systems are reconciled against during an audit.

<svg viewBox="0 0 620 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Lifecycle of an immutable lineage archive: ingest, Object Lock retention window with legal hold, lifecycle tiering to cold storage, and expiry after retention ends">
<title>WORM retention and lifecycle timeline for lineage archives</title>
<rect width="620" height="260" fill="#fffdf8" rx="10"/>
<text x="310" y="26" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="700" fill="#2b1d12">Immutable Lineage Archive Lifecycle</text>
<rect x="24" y="60" width="120" height="60" rx="8" fill="#3f5a30"/>
<text x="84" y="85" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">Ingest</text>
<text x="84" y="101" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">PUT + SHA-256</text>
<rect x="180" y="60" width="150" height="60" rx="8" fill="#b85c3b"/>
<text x="255" y="82" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">Object Lock</text>
<text x="255" y="98" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">COMPLIANCE mode</text>
<text x="255" y="110" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">retain-until 7 yr</text>
<rect x="366" y="60" width="140" height="60" rx="8" fill="#5a3c25"/>
<text x="436" y="85" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">Lifecycle Tier</text>
<text x="436" y="101" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">Glacier Deep</text>
<rect x="540" y="60" width="60" height="60" rx="8" fill="#c8a781"/>
<text x="570" y="85" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#2b1d12">Expire</text>
<text x="570" y="101" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#2b1d12">post-hold</text>
<rect x="180" y="160" width="150" height="46" rx="8" fill="#d68361"/>
<text x="255" y="180" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" font-weight="700" fill="#2b1d12">Legal Hold</text>
<text x="255" y="195" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#2b1d12">indefinite, ON/OFF</text>
<rect x="366" y="160" width="234" height="46" rx="8" fill="#4a5c3f"/>
<text x="483" y="180" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" font-weight="700" fill="#fffdf8">Chain of custody preserved</text>
<text x="483" y="195" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#fffdf8">no overwrite, no delete before retain-until</text>
<defs><marker id="aw" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#2b1d12"/></marker></defs>
<line x1="144" y1="90" x2="180" y2="90" stroke="#2b1d12" stroke-width="2" marker-end="url(#aw)"/>
<line x1="330" y1="90" x2="366" y2="90" stroke="#2b1d12" stroke-width="2" marker-end="url(#aw)"/>
<line x1="506" y1="90" x2="540" y2="90" stroke="#2b1d12" stroke-width="2" marker-end="url(#aw)"/>
<line x1="255" y1="120" x2="255" y2="160" stroke="#5a3c25" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#aw)"/>
<line x1="436" y1="120" x2="436" y2="160" stroke="#5a3c25" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#aw)"/>
<text x="84" y="150" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#2b1d12">t = 0</text>
<text x="570" y="150" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#2b1d12">t = retain-until</text>
</svg>

## Why immutability underwrites chain of custody

A chain of custody is a continuous, tamper-evident record of who touched an artifact and when. In a geospatial provenance system, the artifacts are the serialized lineage documents themselves: PROV-JSON exports, transformation manifests, QA sign-offs, and the SHA-256 digests that bind a lineage record to the raster or vector it describes. If those documents live only in a mutable database, the custody claim is only as strong as the weakest set of database credentials. WORM storage severs that dependency by making the archive tier append-only at the infrastructure level.

Three properties make object-storage WORM a good fit for lineage archives. First, immutability is enforced by the storage service, not by application logic, so a compromised pipeline account cannot rewrite history. Second, each object version is independently retained, which pairs naturally with the append-only, event-sourced lineage models discussed in the [structuring JSON/XML lineage documents](https://www.provenance-tracking.com/storage-indexing-query-optimization/structuring-jsonxml-lineage-documents/) guide — every new derivation event becomes a new immutable object rather than a mutation of an existing one. Third, retention metadata travels with the object, so an auditor inspecting a single archive can read its `retain-until` date and legal-hold status without consulting an external policy registry.

## S3 Object Lock: modes, retention, and legal hold

Object Lock is the S3 mechanism that implements WORM. It operates at the level of individual object versions and requires versioning to be enabled on the bucket. There are two retention modes and one independent legal-hold flag; understanding the difference is essential because the choice is effectively irreversible for compliance mode.

- **Governance mode** applies a `retain-until` date but permits users holding the `s3:BypassGovernanceRetention` permission to shorten retention or delete the object early. Use governance mode for internal archives where you want strong default protection but need a break-glass path for administrators correcting genuine ingestion errors.
- **Compliance mode** applies a `retain-until` date that no principal — not the root account, not AWS support — can shorten or bypass until the date passes. The object version cannot be deleted or overwritten during the window. This is the mode that satisfies records-retention schedules and regulator expectations of true WORM. Reserve it for finalized, validated lineage archives.
- **Legal hold** is a separate boolean placed on an object version that prevents deletion or overwrite for as long as the hold is `ON`, with no expiry date. It is orthogonal to retention mode: an object can have both a compliance retention date and a legal hold. Holds model litigation or investigation scenarios where records must be frozen indefinitely regardless of their scheduled disposition.

Retention periods can be expressed as a fixed `retain-until` timestamp per object or derived from a default retention rule on the bucket (a duration in days or years applied at PUT time). The companion how-to on [configuring S3 Object Lock for lineage archives](https://www.provenance-tracking.com/storage-indexing-query-optimization/object-storage-worm-retention/configuring-s3-object-lock-for-lineage-archives/) walks through enabling the feature and writing a retained object end to end.

## Prerequisites

- [ ] Python 3.10+ with `boto3` 1.34+ and `botocore` installed in a virtual environment.
- [ ] An AWS account with permissions for `s3:CreateBucket`, `s3:PutBucketVersioning`, `s3:PutObjectRetention`, `s3:PutObjectLegalHold`, and `s3:GetObjectRetention`.
- [ ] A destination bucket created **with Object Lock enabled at creation time** — the feature cannot be turned on for an existing bucket.
- [ ] Server-side clock discipline: pipeline hosts synchronized to NTP so `retain-until` dates you compute locally match the service's clock.
- [ ] A canonical serialization of each lineage archive (deterministic JSON) plus its SHA-256 digest, so the stored bytes are reproducible and verifiable.

## Step-by-step

### 1. Create a versioned, Object-Lock-enabled bucket

Object Lock depends on versioning, and it can only be activated when the bucket is created. Passing `ObjectLockEnabledForBucket=True` at creation both enables the feature and turns on versioning implicitly, but making versioning explicit keeps the intent obvious to anyone auditing the infrastructure code.

```python
import boto3

s3 = boto3.client("s3", region_name="us-east-1")

def create_worm_bucket(bucket: str) -> None:
    s3.create_bucket(
        Bucket=bucket,
        ObjectLockEnabledForBucket=True,
    )
    s3.put_bucket_versioning(
        Bucket=bucket,
        VersioningConfiguration={"Status": "Enabled"},
    )
```

### 2. Set a default retention rule (optional but recommended)

A bucket-level default guarantees that every archive lands under retention even if a pipeline forgets to specify one. Here we default new objects to seven years of compliance-mode retention, a common records schedule for government spatial data.

```python
def set_default_retention(bucket: str, years: int = 7) -> None:
    s3.put_object_lock_configuration(
        Bucket=bucket,
        ObjectLockConfiguration={
            "ObjectLockEnabled": "Enabled",
            "Rule": {"DefaultRetention": {"Mode": "COMPLIANCE", "Years": years}},
        },
    )
```

### 3. Write a retained lineage archive

When writing the object, attach an explicit `retain-until` date and the digest. Computing the date from a UTC-aware `datetime` avoids the timezone ambiguity that causes clock-skew failures.

```python
import hashlib
import json
from datetime import datetime, timedelta, timezone

def put_retained_archive(bucket: str, key: str, lineage: dict, years: int = 7) -> str:
    body = json.dumps(lineage, sort_keys=True, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(body).hexdigest()
    retain_until = datetime.now(timezone.utc) + timedelta(days=365 * years)
    resp = s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=body,
        ObjectLockMode="COMPLIANCE",
        ObjectLockRetainUntilDate=retain_until,
        ObjectLockLegalHoldStatus="OFF",
        Metadata={"sha256": digest},
    )
    return resp["VersionId"]
```

### 4. Apply a legal hold when records must be frozen

Legal holds are applied per object version and can be toggled without touching the retention date. This lets an investigation freeze an archive that would otherwise expire.

```python
def apply_legal_hold(bucket: str, key: str, version_id: str, on: bool = True) -> None:
    s3.put_object_legal_hold(
        Bucket=bucket,
        Key=key,
        VersionId=version_id,
        LegalHold={"Status": "ON" if on else "OFF"},
    )
```

### 5. Tier aged archives with a lifecycle rule

Immutability and cost control are compatible: lifecycle transitions move object bytes to colder storage classes while retention continues to block deletion. Transition to Glacier Deep Archive after 90 days but never add an expiration action shorter than your retention window, or the rule will be silently ignored for locked objects.

```python
def set_lifecycle_tiering(bucket: str) -> None:
    s3.put_bucket_lifecycle_configuration(
        Bucket=bucket,
        LifecycleConfiguration={
            "Rules": [{
                "ID": "lineage-cold-tiering",
                "Filter": {"Prefix": "lineage/"},
                "Status": "Enabled",
                "Transitions": [{"Days": 90, "StorageClass": "DEEP_ARCHIVE"}],
            }],
        },
    )
```

## Configuration reference

| Parameter | Type | Valid values | Default |
|-----------|------|--------------|---------|
| `ObjectLockEnabledForBucket` | bool | `True`, `False` (set only at bucket creation) | `False` |
| `ObjectLockMode` | string | `GOVERNANCE`, `COMPLIANCE` | none (unretained) |
| `ObjectLockRetainUntilDate` | UTC datetime | any future timestamp | none |
| `DefaultRetention.Years` / `.Days` | int | ≥ 1 (mutually exclusive) | none |
| `ObjectLockLegalHoldStatus` | string | `ON`, `OFF` | `OFF` |
| `VersioningConfiguration.Status` | string | `Enabled`, `Suspended` | required `Enabled` |
| Lifecycle `Transitions.StorageClass` | string | `STANDARD_IA`, `GLACIER`, `DEEP_ARCHIVE` | none |

## Common failure modes & mitigations

| Failure mode | Symptom | Mitigation |
|--------------|---------|------------|
| **Retention misconfiguration** | `put_object` succeeds but objects are deletable; auditors reject the archive | Verify mode is `COMPLIANCE`, not `GOVERNANCE`, for finalized records; confirm a bucket default rule exists as a backstop |
| **Object Lock not enabled at creation** | `InvalidBucketState` when calling `put_object_lock_configuration` | Recreate the bucket with `ObjectLockEnabledForBucket=True`; the feature cannot be retrofitted onto an existing bucket |
| **Clock skew** | `retain-until` computed locally lands in the past; PUT fails or under-retains | Use `datetime.now(timezone.utc)`; keep pipeline hosts on NTP; never build dates from naive local time |
| **Delete-marker confusion** | Object appears deleted but bytes remain billable and locked | Remember versioned deletes only add a delete marker; the retained version persists and cannot be permanently removed until `retain-until` passes |
| **Lifecycle expiration shorter than retention** | Expiration rule silently ignored, storage costs grow | Set expiration actions only for durations that exceed the maximum `retain-until`; use transitions, not expirations, for cost control during the window |
| **Missing versioning** | Object Lock parameters rejected on PUT | Ensure `VersioningConfiguration.Status` is `Enabled`; Object Lock requires it |

## Compliance & governance alignment

WORM archives map cleanly onto records-retention and audit-log controls. The immutable object becomes the physical evidence a control references, and its `retain-until` date operationalizes the schedule that control mandates. Because FISMA is central to federal spatial systems, coordinate these settings with the [FISMA compliance for spatial systems](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/fisma-compliance-for-spatial-systems/) guidance so retention windows match your system's categorization.

| Control / framework | Requirement | WORM implementation |
|---------------------|-------------|---------------------|
| NIST 800-53 AU-11 (Audit Record Retention) | Retain audit records for a defined period | `ObjectLockMode=COMPLIANCE` with `retain-until` matching the mandated period |
| NIST 800-53 AU-9 (Protection of Audit Information) | Prevent unauthorized modification/deletion of logs | Compliance mode blocks overwrite/delete for all principals during the window |
| Agency records schedule (e.g. NARA GRS) | Disposition after fixed retention | Bucket default retention duration set to the scheduled period; expiration after the window |
| Litigation hold obligations | Freeze records under investigation | `ObjectLockLegalHoldStatus=ON`, independent of scheduled disposition |
| ISO 19115 lineage integrity | Preserve authoritative lineage metadata | SHA-256 digest in object metadata plus immutable storage of the serialized lineage record |

Treat compliance mode as a one-way door: once an object is written under a compliance `retain-until` date, that commitment cannot be undone, so validate archives thoroughly before they leave your staging tier. Governance mode, a legal-hold policy, and lifecycle tiering give you the operational flexibility to correct mistakes and manage cost without weakening the immutability guarantee that makes the archive credible in the first place.
