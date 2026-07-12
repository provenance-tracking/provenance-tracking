# Verifying GeoTIFF SHA-256 Checksums in CI

A raster that passed review last week can be silently corrupted or swapped before it ships, so the surest guard is a continuous integration job that recomputes every GeoTIFF's SHA-256 against a committed manifest and fails the build on any drift. This how-to implements that gate as a `pytest` suite plus a short CI snippet, building directly on [Automated Hash Generation for Rasters](https://www.provenance-tracking.com/python-automation-pipeline-integration/automated-hash-generation-for-rasters/) and the digest function from [Generating SHA-256 Hashes for GeoTIFFs in Python](https://www.provenance-tracking.com/python-automation-pipeline-integration/automated-hash-generation-for-rasters/generating-sha-256-hashes-for-geotiffs-in-python/).

## Prerequisites

- Python 3.10+ with `pytest` 8.0+ installed in the CI environment.
- A committed manifest — here `checksums.json` — mapping each raster's repository-relative path to its expected file-level SHA-256, generated once when the rasters were approved.
- The GeoTIFFs available at test time, either committed (Git LFS for large files) or fetched into a known directory before the test runs.
- A CI runner (GitHub Actions is shown, but the assertion is runner-agnostic).

## Implementation

The suite loads the manifest, recomputes each digest with chunked I/O, and parametrizes one test per raster so the CI report names exactly which file drifted. Missing files and unmanifested extras are treated as failures, not silent passes.

```python
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = REPO_ROOT / "checksums.json"


def sha256_file(path: Path, chunk_size: int = 1_048_576) -> str:
    """Compute the file-level SHA-256 of a raster using chunked reads."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest() -> dict[str, str]:
    """Return the committed {relative_path: expected_sha256} mapping."""
    if not MANIFEST_PATH.is_file():
        raise FileNotFoundError(f"Checksum manifest missing: {MANIFEST_PATH}")
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


MANIFEST: dict[str, str] = load_manifest()


@pytest.mark.parametrize("rel_path, expected", sorted(MANIFEST.items()))
def test_raster_checksum_matches(rel_path: str, expected: str) -> None:
    """Each manifested GeoTIFF must hash to its recorded SHA-256."""
    target = REPO_ROOT / rel_path
    assert target.is_file(), f"Manifested raster is missing from the tree: {rel_path}"

    actual = sha256_file(target)
    assert actual == expected, (
        f"Checksum drift for {rel_path}\n"
        f"  expected: {expected}\n"
        f"  actual:   {actual}"
    )


def test_no_unmanifested_rasters() -> None:
    """Every .tif under data/ must appear in the manifest (no silent additions)."""
    data_dir = REPO_ROOT / "data"
    on_disk = {
        str(p.relative_to(REPO_ROOT)).replace("\\", "/")
        for p in data_dir.rglob("*.tif")
    }
    unmanifested = sorted(on_disk - set(MANIFEST))
    assert not unmanifested, f"Rasters absent from checksums.json: {unmanifested}"
```

The `test_no_unmanifested_rasters` case is what makes the gate trustworthy: without it, an attacker or a careless commit could add a new raster that no assertion covers. Comparing the on-disk set against the manifest keys closes that gap.

The CI job installs dependencies and runs the suite; a non-zero `pytest` exit code fails the pipeline:

```yaml
name: raster-checksums
on: [push, pull_request]

jobs:
  verify-checksums:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          lfs: true  # pull Git LFS-tracked GeoTIFFs
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: pip install pytest
      - run: pytest tests/test_checksums.py -v
```

## Verification

Run the suite locally before pushing; a clean tree reports one pass per raster:

```bash
$ pytest tests/test_checksums.py -v
tests/test_checksums.py::test_raster_checksum_matches[data/dem_2026.tif-9f3a...] PASSED
tests/test_checksums.py::test_no_unmanifested_rasters PASSED
```

To confirm the gate actually bites, corrupt one byte of a raster and re-run — the parametrized case for that file must turn red with the expected-versus-actual diff, while every other case stays green. A gate that never fails on injected drift is not a gate.

## Gotchas & edge cases

- **File-level hashing flags harmless GeoTIFF rewrites.** Re-tiling, adding internal overviews, or switching from `DEFLATE` to `ZSTD` changes the bytes without touching a single pixel, so a file-level manifest will fail even though the geographic data is identical. If your workflow legitimately re-encodes rasters, pin the manifest to a content-level digest of the pixel arrays and CRS instead, as covered in [Generating SHA-256 Hashes for GeoTIFFs in Python](https://www.provenance-tracking.com/python-automation-pipeline-integration/automated-hash-generation-for-rasters/generating-sha-256-hashes-for-geotiffs-in-python/).
- **Line-ending and LFS smudge surprises.** Never let Git treat `.tif` as text — a missing `*.tif filter=lfs -text` in `.gitattributes` lets CRLF normalization mangle binary rasters on Windows runners, producing a checksum that drifts only on one platform. Add an explicit binary attribute for raster extensions.
- **Manifest and rasters drifting apart.** Regenerating rasters without regenerating `checksums.json` (or vice versa) turns the gate into noise. Make manifest regeneration a deliberate, reviewed step in your [automated hash generation for rasters](https://www.provenance-tracking.com/python-automation-pipeline-integration/automated-hash-generation-for-rasters/) workflow, and require the manifest diff to be part of the same pull request as the raster change.
