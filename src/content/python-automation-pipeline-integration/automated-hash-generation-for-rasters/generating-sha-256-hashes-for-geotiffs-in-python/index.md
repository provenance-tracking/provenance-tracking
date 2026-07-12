# Generating SHA-256 Hashes for GeoTIFFs in Python

To generate a SHA-256 hash for a GeoTIFF in Python, read the file's raw binary stream in fixed-size chunks using `hashlib.sha256()` for exact byte verification, or normalize pixel arrays and geospatial metadata via `rasterio` for stable, content-aware identifiers. The correct approach depends entirely on your compliance requirements: strict chain-of-custody audits demand file-level hashing, while geospatial data lineage tracking requires content-level normalization to ignore harmless metadata edits.

## Choosing the Right Hashing Strategy

GeoTIFFs are complex containers. A single raster may embed XML metadata, internal overviews, compression dictionaries, and tile structures that change without altering the underlying geographic data. Selecting the wrong hashing strategy causes false-positive mismatches in production pipelines or, conversely, masks unauthorized byte-level tampering.

- **File-Level Hashing** computes a digest over every byte on disk. It captures compression artifacts, embedded sidecar tags, and internal overviews. Use this when regulatory frameworks or strict chain-of-custody protocols require proof that the exact distributed file has not been modified.
- **Content-Level Hashing** extracts pixel arrays, coordinate reference systems (CRS), and geotransform matrices, then normalizes them into a deterministic byte stream. This approach prevents false mismatches when agencies update acquisition dates, processing tags, or switch from DEFLATE to ZSTD compression. For teams building [Automated Hash Generation for Rasters](https://www.provenance-tracking.com/python-automation-pipeline-integration/automated-hash-generation-for-rasters/), content hashing is typically the default because it aligns with how GIS analysts actually use the data.

## Production-Ready Implementation

The following script implements both strategies. It uses chunked I/O to prevent memory exhaustion on multi-gigabyte orthomosaics or DEMs, and enforces little-endian byte ordering for cross-platform consistency.

```python
import hashlib
import rasterio
import numpy as np
from pathlib import Path
from typing import Union

def hash_geotiff_file(filepath: Union[str, Path], chunk_size: int = 1_048_576) -> str:
    """
    Generate SHA-256 hash of the raw GeoTIFF file bytes.
    Suitable for strict compliance audits where any byte change must trigger a mismatch.
    """
    sha256 = hashlib.sha256()
    path = Path(filepath).resolve()
    if not path.is_file():
        raise FileNotFoundError(f"GeoTIFF not found: {path}")

    with open(path, "rb") as f:
        while chunk := f.read(chunk_size):
            sha256.update(chunk)
    return sha256.hexdigest()

def hash_geotiff_content(filepath: Union[str, Path]) -> str:
    """
    Generate SHA-256 hash of normalized pixel data and core geospatial metadata.
    Ignores non-essential tags, overviews, and compression differences.
    """
    sha256 = hashlib.sha256()
    path = Path(filepath).resolve()
    if not path.is_file():
        raise FileNotFoundError(f"GeoTIFF not found: {path}")

    with rasterio.open(path) as src:
        # Deterministic metadata digest: driver, band count, dtype, CRS, and transform
        crs_str = src.crs.to_string() if src.crs else "NONE"
        meta_str = f"{src.driver}|{src.count}|{src.dtypes[0]}|{crs_str}|{src.transform.to_gdal()}"
        sha256.update(meta_str.encode("utf-8"))

        # Hash band data sequentially to manage memory footprint
        for i in range(1, src.count + 1):
            band = src.read(i)

            # Handle nodata values consistently before hashing
            if src.nodata is not None:
                band = np.where(band == src.nodata, np.nan, band.astype(float))

            # Force little-endian byte order for cross-platform determinism
            if band.dtype.itemsize > 1:
                band = band.astype(band.dtype.newbyteorder('<'))

            sha256.update(np.ascontiguousarray(band).tobytes())

    return sha256.hexdigest()
```

## Ensuring Cross-Platform Determinism

Hashing geospatial rasters across different operating systems and hardware architectures introduces subtle pitfalls. The Python `hashlib` module provides a stable, FIPS-compliant implementation, but raster I/O libraries can return data in machine-native byte orders. See the official [Python hashlib documentation](https://docs.python.org/3/library/hashlib.html) for cryptographic guarantees and algorithm constants.

To guarantee identical digests on ARM, x86_64, and cloud VMs, apply these rules:

1. **Normalize Endianness:** Multi-byte dtypes (`float32`, `int16`, `uint16`) must be explicitly cast to little-endian before serialization. Big-endian systems will otherwise produce divergent hashes.
2. **Standardize Transform Representation:** Rasterio's `Affine` object string representation can vary slightly across versions. Using `.to_gdal()` returns a fixed 6-tuple of floats, eliminating formatting drift.
3. **Handle `nodata` Explicitly:** Raw binary dumps of masked arrays include platform-dependent padding. Replacing `nodata` values with `np.nan` (or a fixed sentinel) before byte conversion ensures identical digests regardless of how the source file stores missing data.
4. **Avoid Floating-Point Drift:** If your pipeline performs on-the-fly resampling or reprojection, hash the output *after* writing to disk. In-memory floating-point operations can introduce sub-epsilon differences that invalidate hashes. Consult the [Rasterio documentation](https://rasterio.readthedocs.io/en/latest/) for windowed reading patterns that preserve tile alignment during large-scale processing.

## Scaling in Automated Workflows

Enterprise GIS teams rarely hash files interactively. Production systems integrate hashing into ingestion queues, validation gates, and provenance ledgers. When designing these systems, prioritize idempotency and auditability:

- **Chunk Size Tuning:** The default `1_048_576` (1 MB) chunk size balances I/O throughput and memory pressure. For NVMe-backed cloud storage, increase to `8_388_608` (8 MB) to saturate bandwidth. For network-mounted drives, reduce to `262_144` (256 KB) to avoid socket timeouts.
- **Parallel Execution:** File-level hashing is I/O-bound and scales linearly with disk throughput. Use `concurrent.futures.ThreadPoolExecutor` to hash multiple files concurrently. Content-level hashing is CPU-bound due to NumPy operations; use `ProcessPoolExecutor` to bypass the GIL.
- **Metadata Logging:** Store both the hex digest and the hashing strategy (`"file"` vs `"content"`) in your asset catalog. This prevents downstream consumers from comparing incompatible digests.
- **Pipeline Integration:** Embed hashing as a pre-processing validation step. If a hash mismatch occurs during staging, quarantine the file, trigger a re-download, and log the delta. For teams standardizing [Python Automation & Pipeline Integration](https://www.provenance-tracking.com/python-automation-pipeline-integration/), wrapping these functions in a retry-aware context manager with structured JSON logging reduces operational overhead and simplifies compliance reporting.

By separating byte-exact verification from content-aware normalization, GIS data stewards can enforce strict custody requirements without breaking automated workflows when metadata tags or compression schemes are legitimately updated.
