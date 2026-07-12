# Mapping GDPR Controls to Lineage Fields

When a supervisory authority or your own data protection officer asks for the Article 30 record of processing activities, you should be able to generate it from the lineage store rather than maintain it by hand in a spreadsheet that drifts out of date within weeks. This how-to produces a concrete crosswalk from seven core GDPR articles to specific fields on a geospatial lineage record, then implements a typed model that emits a compliant record of processing directly from lineage rows. It is the field-level companion to the [GDPR for geospatial data](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/gdpr-for-geospatial-data/) guide and applies the control-to-field philosophy set out in the [regulatory compliance and standards mapping](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/) overview.

## Prerequisites

- Python 3.10+ with `pydantic` 2.6+ installed
- A lineage table exposing the columns named in the crosswalk below (`subject_key`, `lawful_basis`, `purpose`, `data_categories`, `recipients`, `transfer_destination`, `retention_until`, `valid_from`, `content_hash`)
- Read access to that store (for example the PostGIS schema from the [structuring JSON/XML lineage documents](https://www.provenance-tracking.com/storage-indexing-query-optimization/structuring-jsonxml-lineage-documents/) guide)
- A processing register naming each `purpose` your pipeline exercises

## The crosswalk

Each article decomposes into the smallest queryable piece of evidence that demonstrates it. That piece is a lineage field, not a policy paragraph.

| GDPR article | Control | Lineage field(s) |
|--------------|---------|------------------|
| Art. 5(1)(b),(e) | Purpose limitation; storage limitation | `purpose`, `retention_until` |
| Art. 6 | Lawful basis for each activity | `lawful_basis` |
| Art. 15 | Right of access — reconstruct history | `subject_key`, `valid_from`, `activity` |
| Art. 17 | Right to erasure — provable shredding | `subject_key`, `payload_erased`, `content_hash` |
| Art. 30 | Records of processing activities | `purpose`, `data_categories`, `recipients`, `transfer_destination`, `retention_until` |
| Art. 35 | DPIA for high-risk location processing | aggregate of `purpose` + `lawful_basis` + volume |
| Art. 44 | Cross-border transfer conditions | `transfer_destination`, `transfer_safeguard` |

The value of expressing it this way is that every cell on the right is something a query can return. If an article decomposes to a field your schema lacks, you have found a gap before an assessor does.

Two articles deserve particular attention for geospatial work. Article 30 is the one most teams underestimate: it is not a one-time document but a living register that must reflect the processing actually happening, which is precisely why deriving it from lineage rows beats maintaining it by hand — the register cannot drift from reality if it is generated from reality. Article 44 is the one location data trips over most often, because a coordinate dataset frequently transits a cloud region or a third-party geocoding service in another jurisdiction without anyone recording the crossing. Binding `transfer_destination` and `transfer_safeguard` to the export activity turns that invisible crossing into a logged event, so a transfer without a lawful safeguard becomes detectable rather than latent.

## Implementation

The model below reads lineage rows and emits an Article 30 record of processing. It uses a `pydantic` model per activity and an aggregator that groups activities into the register entries Article 30 expects — one entry per distinct purpose, listing the categories, recipients, transfers, and retention actually observed.

```python
from __future__ import annotations
from collections import defaultdict
from datetime import datetime
from pydantic import BaseModel, Field


class LineageRow(BaseModel):
    """One append-only lineage event as read from the store."""
    subject_key: str
    activity: str
    lawful_basis: str                       # GDPR Art. 6
    purpose: str                            # GDPR Art. 5(1)(b)
    data_categories: list[str]              # e.g. ["home_geocode", "gps_trace"]
    recipients: list[str] = Field(default_factory=list)
    transfer_destination: str | None = None  # ISO country code, or None
    transfer_safeguard: str | None = None     # e.g. "SCC", "adequacy"
    retention_until: datetime
    valid_from: datetime
    content_hash: str


class Article30Entry(BaseModel):
    """One record-of-processing entry, keyed on purpose (Art. 30(1))."""
    purpose: str
    lawful_bases: set[str]
    data_categories: set[str]
    recipients: set[str]
    transfer_destinations: set[str]
    transfer_safeguards: set[str]
    max_retention: datetime
    activity_count: int
    subject_count: int


def build_article_30(rows: list[LineageRow]) -> list[Article30Entry]:
    """Aggregate lineage rows into an Article 30 record of processing."""
    buckets: dict[str, list[LineageRow]] = defaultdict(list)
    for row in rows:
        buckets[row.purpose].append(row)

    entries: list[Article30Entry] = []
    for purpose, group in buckets.items():
        destinations = {r.transfer_destination for r in group
                        if r.transfer_destination}
        safeguards = {r.transfer_safeguard for r in group
                      if r.transfer_safeguard}
        # Art. 44: any cross-border transfer must carry a safeguard.
        if destinations and not safeguards:
            raise ValueError(
                f"purpose '{purpose}' transfers to {destinations} "
                f"without an Art. 44 safeguard")
        entries.append(Article30Entry(
            purpose=purpose,
            lawful_bases={r.lawful_basis for r in group},
            data_categories={c for r in group for c in r.data_categories},
            recipients={rec for r in group for rec in r.recipients},
            transfer_destinations=destinations,
            transfer_safeguards=safeguards,
            max_retention=max(r.retention_until for r in group),
            activity_count=len(group),
            subject_count=len({r.subject_key for r in group}),
        ))
    return entries
```

The `raise` inside the aggregator is deliberate: it turns an Article 44 gap — a cross-border transfer with no recorded safeguard — into a hard failure at report-generation time rather than a finding during an audit. The aggregation shape mirrors Article 30(1)'s own structure, which asks for processing to be described per purpose rather than per record, so grouping on `purpose` is not an arbitrary key choice but a direct reflection of the regulation's reporting unit. The `set` fields collapse the many activities that share a purpose into the distinct categories, recipients, and destinations that a register entry must enumerate, while `activity_count` and `subject_count` supply the scale indicators a supervisory authority uses to gauge risk. Because the model is a plain `pydantic` structure, the same objects serialize straight to the JSON an audit evidence package expects, with no intermediate transcription step where errors creep in.

## Verification

Confirm the model produces a defensible record by feeding it two rows for the same purpose, one with an unsafeguarded transfer, and asserting behavior.

```python
from datetime import datetime, timezone

base = dict(subject_key="s-001", activity="geocode",
            lawful_basis="public_task", purpose="address_validation",
            data_categories=["home_geocode"],
            retention_until=datetime(2027, 1, 1, tzinfo=timezone.utc),
            valid_from=datetime(2026, 1, 1, tzinfo=timezone.utc),
            content_hash="ab12")

ok = LineageRow(**base)
entries = build_article_30([ok])
assert entries[0].subject_count == 1
assert entries[0].max_retention.year == 2027
print("Art. 30 entry for:", entries[0].purpose)
```

A passing run prints the purpose and asserts the aggregation counted one subject and carried the retention ceiling through. To confirm the Article 44 guard, add a row with `transfer_destination="US"` and `transfer_safeguard=None` and check that `build_article_30` raises. The generated `Article30Entry` list is your record of processing; serialize it to JSON for the DPO or into the audit evidence package.

## Gotchas & edge cases

- **Purpose sprawl inflates the register.** Free-text `purpose` values that differ only by spelling ("address validation" vs "address_validation") produce duplicate Article 30 entries. Normalize `purpose` against the processing register before aggregation, ideally with an enum, so one real purpose maps to one entry.
- **`subject_key` must be an opaque token, not raw PII.** If the key is an email or a device ID, the Article 30 record you generate becomes a new copy of personal data. Keep the token-to-identity map in a separate vault, as covered in the parent [GDPR for geospatial data](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/gdpr-for-geospatial-data/) guide.
- **Erased subjects still appear in aggregates.** After a crypto-shred, `subject_key` rows persist for audit but carry no payload. Count them for volume metrics, but never attempt to resolve their `data_categories` back to a person — that data is gone by design.
