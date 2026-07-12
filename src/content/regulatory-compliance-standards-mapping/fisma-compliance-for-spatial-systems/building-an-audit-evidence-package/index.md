# Building an Audit Evidence Package

An assessor does not want access to your production database — they want a single, self-contained, tamper-evident bundle they can verify offline: a manifest of what is inside, a hash for each file, and the lineage export that ties your controls to real pipeline runs. This how-to, a companion to the [FISMA compliance for spatial systems](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/fisma-compliance-for-spatial-systems/) overview, produces exactly that — a timestamped tarball containing a SHA-256 manifest and a PROV-JSON lineage export — and shows how the assessor re-verifies it.

## Prerequisites

- Python 3.10+ (standard library only: `tarfile`, `hashlib`, `json`, `datetime`; no external packages required).
- A directory of collected evidence artifacts: your `audit.jsonl` records, any SI-7 hash sidecars, and control-implementation notes.
- The lineage events for the assessment window, readable as JSON lines.
- A synchronized system clock (NTP/chrony) so the package timestamp is defensible under AU-8.
- Optional: an internal signing key if your agency requires a detached signature over the manifest.

## Implementation

The package is built in three moves: serialize the lineage as PROV-JSON, hash every file that will go into the bundle to build the manifest, then write both plus the source artifacts into a single timestamped tarball. The manifest is hashed last and its own digest recorded, so the assessor has one root value to check.

```python
from __future__ import annotations
import hashlib
import json
import tarfile
from datetime import datetime, timezone
from pathlib import Path

def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    d = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            d.update(block)
    return d.hexdigest()

def lineage_to_prov_json(events_path: Path, out_path: Path) -> None:
    """Convert JSON-line lineage events into a minimal PROV-JSON document."""
    entities: dict[str, dict] = {}
    activities: dict[str, dict] = {}
    agents: dict[str, dict] = {}
    used: list[dict] = []
    generation: list[dict] = []

    with events_path.open(encoding="utf-8") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            e = json.loads(raw)
            act_id = f"act:{e['record_id']}"
            out_id = f"ent:{e['output_uri']}"
            src_id = f"ent:{e['source_uri']}"
            ag_id = f"agent:{e['actor']}"
            activities[act_id] = {
                "prov:type": e["event_type"],
                "prov:startTime": e["occurred_at"],
                "gis:crs": e.get("crs"),
                "gis:parameters": e.get("parameters", {}),
            }
            entities[out_id] = {"gis:sha256": e.get("output_sha256")}
            entities[src_id] = {}
            agents[ag_id] = {"prov:type": "prov:SoftwareAgent"}
            used.append({"prov:activity": act_id, "prov:entity": src_id})
            generation.append({"prov:activity": act_id, "prov:entity": out_id})

    prov = {
        "prefix": {"gis": "urn:gis:lineage#", "prov": "http://www.w3.org/ns/prov#"},
        "entity": entities,
        "activity": activities,
        "agent": agents,
        "used": {f"u{i}": u for i, u in enumerate(used)},
        "wasGeneratedBy": {f"g{i}": g for i, g in enumerate(generation)},
    }
    out_path.write_text(json.dumps(prov, indent=2, sort_keys=True), encoding="utf-8")

def build_manifest(files: list[Path], base: Path) -> dict:
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "algorithm": "sha256",
        "files": {
            str(p.relative_to(base)): {"sha256": sha256_file(p), "bytes": p.stat().st_size}
            for p in sorted(files)
        },
    }

def build_package(evidence_dir: Path, events_path: Path, out_tar: Path) -> str:
    staging = evidence_dir / "_package"
    staging.mkdir(exist_ok=True)

    # 1. Lineage export in PROV-JSON.
    prov_path = staging / "lineage.prov.json"
    lineage_to_prov_json(events_path, prov_path)

    # 2. Manifest over every artifact + the PROV export.
    artifacts = [p for p in evidence_dir.rglob("*") if p.is_file() and staging not in p.parents]
    artifacts.append(prov_path)
    manifest = build_manifest(artifacts, evidence_dir)
    manifest_path = staging / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")

    # 3. Root hash over the manifest itself — the single value an assessor checks first.
    root = sha256_file(manifest_path)
    (staging / "manifest.sha256").write_text(f"{root}  manifest.json\n", encoding="utf-8")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    final_tar = out_tar.with_name(f"{out_tar.stem}-{stamp}.tar.gz")
    with tarfile.open(final_tar, "w:gz") as tar:
        for p in artifacts:
            tar.add(p, arcname=str(p.relative_to(evidence_dir)))
        tar.add(manifest_path, arcname="manifest.json")
        tar.add(staging / "manifest.sha256", arcname="manifest.sha256")
    return root

if __name__ == "__main__":
    root_hash = build_package(
        Path("/data/assessment/evidence"),
        Path("/var/lineage/audit.jsonl"),
        Path("/data/assessment/fisma-evidence"),
    )
    print(f"Package root (manifest sha256): {root_hash}")
```

The PROV-JSON export is what makes the bundle assessable rather than just archival: each pipeline event becomes an `activity` linking a source `entity` to a generated `entity` via a software `agent`, with the SI-7 hash carried as `gis:sha256`. That is the same PROV shape an [ISO 19115 lineage implementation](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/iso-19115-lineage-implementation/) consumes, so one export serves both the security assessor and the metadata catalogue.

The ordering of the three steps is not incidental. The manifest must be built *after* the PROV export exists, because the export is itself an artifact whose hash belongs in the manifest; and the root hash must be taken *after* the manifest is finalized, because it seals the manifest against edits. This produces a short verification chain with a single entry point: check the root hash against the manifest, then trust the manifest to vouch for every other file. An assessor never has to reason about the order in which artifacts were collected — they follow the chain from one root value outward. Because the manifest records each file's byte size alongside its digest, a truncated or partially transferred artifact is caught even in the rare case of a hash collision, and the size field doubles as a quick sanity check when an assessor scans the manifest by eye before running the verifier.

## Verification

The assessor verifies in two steps without any of your infrastructure. First, confirm the manifest itself is intact by recomputing its hash and comparing to `manifest.sha256`; then confirm every listed file matches its recorded digest.

```python
import hashlib, json, tarfile
from pathlib import Path

def verify_package(tar_path: Path, workdir: Path) -> bool:
    with tarfile.open(tar_path, "r:gz") as tar:
        tar.extractall(workdir)
    recorded = (workdir / "manifest.sha256").read_text().split()[0]
    actual = hashlib.sha256((workdir / "manifest.json").read_bytes()).hexdigest()
    if recorded != actual:
        print("FAIL: manifest hash mismatch — package altered")
        return False
    manifest = json.loads((workdir / "manifest.json").read_text())
    for rel, meta in manifest["files"].items():
        digest = hashlib.sha256((workdir / rel).read_bytes()).hexdigest()
        if digest != meta["sha256"]:
            print(f"FAIL: {rel} does not match manifest")
            return False
    print(f"OK: {len(manifest['files'])} files verified against manifest")
    return True
```

A clean run prints the file count and returns `True`; any single altered byte in any artifact — or in the manifest — flips it to `False`. This is the tamper-evidence property AU-9 asks for, delivered in a form the assessor can run offline. The integrity hashes themselves should have been produced at generation time using the same discipline described in [automated hash generation for rasters](https://www.provenance-tracking.com/python-automation-pipeline-integration/automated-hash-generation-for-rasters/), so the manifest values and the pipeline's SI-7 records agree.

## Gotchas & edge cases

- **Clock skew undermines the timestamp.** The package name and `generated_at` are only defensible if the host clock is NTP-synchronized. A worker whose clock drifted produces a package that appears to predate the events it contains — verify chrony/NTP status before building, and record UTC exclusively.
- **Missing controls masquerade as a complete package.** A bundle that verifies cleanly still fails an assessment if the underlying run never emitted, say, any SI-7 hash. Run the control-mapping validator from the [FISMA control mapping for GIS pipelines](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/fisma-compliance-for-spatial-systems/fisma-control-mapping-for-gis-pipelines/) how-to *before* packaging, and refuse to build the tarball if it reports findings.
- **Non-deterministic manifests.** If you hash files in filesystem-iteration order the manifest changes between runs over identical evidence, which looks like tampering. Always sort the file list (as `build_manifest` does) so a rebuild over unchanged evidence yields an identical root hash.
- **Staging directory recursion.** Writing the manifest inside the evidence tree and then globbing that same tree can pull the half-written manifest into itself. The code excludes the `_package` staging path from the artifact scan for exactly this reason; keep that guard if you refactor.

Store each generated package in write-once object storage and record its root hash in your lineage log, so the evidence bundle is itself an auditable artifact under the same retention policy as the records it contains.
