# Configuring S3 Object Lock for Lineage Archives

When a lineage archive must be provably tamper-proof for its entire retention period, you enable S3 Object Lock and write the object under a compliance-mode retention date plus a legal hold; use this whenever a finalized provenance record needs infrastructure-enforced immutability rather than a policy promise. This how-to is the hands-on companion to the [object storage WORM retention](https://www.provenance-tracking.com/storage-indexing-query-optimization/object-storage-worm-retention/) overview and shows the exact boto3 calls end to end.

## Prerequisites

- Python 3.10+ with `boto3` 1.34+ and `botocore` in an active virtual environment.
- AWS credentials granting `s3:CreateBucket`, `s3:PutBucketVersioning`, `s3:PutObject`, `s3:PutObjectRetention`, `s3:PutObjectLegalHold`, and `s3:GetObjectRetention`.
- A region selected via `AWS_DEFAULT_REGION` or an explicit `region_name`.
- A canonical serialization of the lineage document to archive (deterministic JSON is ideal). The append-only record shape from [structuring JSON/XML lineage documents](https://www.provenance-tracking.com/storage-indexing-query-optimization/structuring-jsonxml-lineage-documents/) works well here.

## Implementation

The script below creates a fresh Object-Lock-enabled bucket, writes a lineage archive under a five-year COMPLIANCE retention with a legal hold switched on, and returns the version ID. Object Lock can only be enabled at bucket creation, so the workflow starts from a new bucket rather than mutating an existing one.

```python
import hashlib
import json
from datetime import datetime, timedelta, timezone

import boto3

REGION = "us-east-1"
BUCKET = "agency-lineage-worm-archive"
KEY = "lineage/2026/scene-8842-provenance.json"

s3 = boto3.client("s3", region_name=REGION)


def ensure_locked_bucket(bucket: str) -> None:
    # ObjectLockEnabledForBucket implicitly enables versioning; we set it
    # explicitly so the intent is auditable in infrastructure code.
    s3.create_bucket(Bucket=bucket, ObjectLockEnabledForBucket=True)
    s3.put_bucket_versioning(
        Bucket=bucket,
        VersioningConfiguration={"Status": "Enabled"},
    )


def put_locked_archive(bucket: str, key: str, lineage: dict, years: int = 5) -> str:
    # Deterministic bytes => reproducible SHA-256 for chain-of-custody proof.
    body = json.dumps(lineage, sort_keys=True, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(body).hexdigest()

    # UTC-aware arithmetic prevents clock-skew rejection of the retain-until date.
    retain_until = datetime.now(timezone.utc) + timedelta(days=365 * years)

    resp = s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=body,
        ObjectLockMode="COMPLIANCE",              # irreversible WORM for the window
        ObjectLockRetainUntilDate=retain_until,   # no principal can shorten this
        ObjectLockLegalHoldStatus="ON",           # independent, indefinite freeze
        Metadata={"sha256": digest},
    )
    return resp["VersionId"]


if __name__ == "__main__":
    lineage_doc = {
        "dataset_id": "scene-8842",
        "crs": "EPSG:4326",
        "derived_from": ["scene-8840", "scene-8841"],
        "process": "mosaic+radiometric_correction",
        "actor": "svc-etl-prod",
        "committed_at": datetime.now(timezone.utc).isoformat(),
    }
    ensure_locked_bucket(BUCKET)
    version_id = put_locked_archive(BUCKET, KEY, lineage_doc)
    print(f"archived version: {version_id}")
```

The three `ObjectLock*` parameters on `put_object` do the work. `ObjectLockMode="COMPLIANCE"` means the `retain-until` date cannot be shortened or bypassed by any principal, including the root account. `ObjectLockLegalHoldStatus="ON"` layers an independent, open-ended freeze on top, so the object stays immutable even if you later decide to reduce or expire scheduled retention. The SHA-256 digest stored in user metadata binds the archived bytes to a verifiable fingerprint you can re-derive at audit time.

## Verification

Confirm the retention actually took hold by reading it back. `get_object_retention` returns the mode and `retain-until` date; `get_object_legal_hold` returns the hold status.

```python
def verify_lock(bucket: str, key: str, version_id: str) -> None:
    ret = s3.get_object_retention(Bucket=bucket, Key=key, VersionId=version_id)
    hold = s3.get_object_legal_hold(Bucket=bucket, Key=key, VersionId=version_id)
    print("mode:", ret["Retention"]["Mode"])
    print("retain_until:", ret["Retention"]["RetainUntilDate"].isoformat())
    print("legal_hold:", hold["LegalHold"]["Status"])
```

A correct run prints `mode: COMPLIANCE`, a `retain_until` roughly five years out, and `legal_hold: ON`. As a negative check, attempt a delete of that version and confirm S3 rejects it: `s3.delete_object(Bucket=BUCKET, Key=KEY, VersionId=version_id)` raises an `AccessDenied` error while the retention is active, which is exactly the immutability guarantee you want to demonstrate to an auditor.

## Gotchas & edge cases

- **Object Lock is creation-time only.** You cannot enable it on an existing bucket — `put_object_lock_configuration` returns `InvalidBucketState`. If you inherited an unlocked bucket, create a new locked bucket and copy the archives across, then verify digests match before decommissioning the old one.
- **Versioning is mandatory.** Object Lock retention parameters are rejected unless bucket versioning is `Enabled`. Enabling Object Lock at creation turns versioning on for you, but never suspend it afterward or new PUTs lose their lock semantics.
- **Compliance mode is a one-way commitment.** Once written, a compliance `retain-until` date cannot be reduced, and the object cannot be deleted until it passes. Validate the lineage document — especially its CRS and derivation edges — before you commit it, because a mistaken archive will occupy locked, billable storage for the full window. Use governance mode in staging if you need a break-glass path during testing.
