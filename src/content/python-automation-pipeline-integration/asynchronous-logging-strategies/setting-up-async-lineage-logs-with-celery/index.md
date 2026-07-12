# Setting Up Async Lineage Logs with Celery

Setting up async lineage logs with Celery requires decoupling provenance capture from your primary geospatial processing pipeline, routing metadata writes through a message broker, and implementing idempotent worker tasks that persist transformation records without blocking I/O. The core pattern emits a lightweight JSON payload containing dataset UUIDs, operation signatures, timestamps, and processor identities, then delegates persistence to a dedicated Celery worker. This architecture guarantees strict chain-of-custody tracking while keeping raster tiling, vector topology validation, and coordinate transformations running at peak throughput.

## Why Asynchronous Provenance Capture Matters for GIS

Heavy spatial operations routinely exhaust database connection pools and saturate network I/O when audit writes execute synchronously. A single `INSERT` into a lineage table during a 50 GB raster reprojection can stall the entire ETL thread. Adopting [Asynchronous Logging Strategies](https://www.provenance-tracking.com/python-automation-pipeline-integration/asynchronous-logging-strategies/) shifts audit persistence to background workers, isolating compliance overhead from compute-heavy steps.

Celery's distributed queue automatically handles:

- **Retry backoff** for transient database or broker outages
- **Dead-letter routing** for malformed payloads that exceed retry limits
- **Rate limiting** to prevent write storms during batch processing peaks
- **Late acknowledgment** (`task_acks_late=True`) to improve delivery reliability on worker crashes

For agency tech teams, this aligns directly with federal data governance mandates requiring immutable, tamper-evident audit trails. By queuing lineage events, you maintain predictable processing SLAs while preserving PROV-compliant metadata.

## Broker Architecture & Compliance Hardening

Broker selection dictates delivery guarantees and operational complexity:

- **Redis 7+**: Optimal for low-latency spatial ETL. Use `redis.conf` persistence (`appendonly yes`) and TLS to meet state-level data sovereignty requirements.
- **RabbitMQ 4.0+**: Preferred for compliance-heavy workflows. Provides publisher confirms, message TTL, and dead-letter exchanges out of the box.

Configure broker persistence, enforce TLS encryption, and tune visibility timeouts to prevent premature message redelivery during long-running geospatial jobs. Production hardening should follow the official [Celery Configuration Guide](https://docs.celeryq.dev/en/stable/userguide/configuration.html), specifically enabling `broker_use_ssl`, `task_acks_late=True`, and `task_reject_on_worker_lost=True`. These settings integrate cleanly into broader [Python Automation & Pipeline Integration](https://www.provenance-tracking.com/python-automation-pipeline-integration/) architectures where multiple microservices share audit infrastructure.

## Production Implementation

The following implementation demonstrates a production-ready Celery task for geospatial lineage capture. It uses deterministic SHA-256 hashing for idempotency, exponential backoff for transient failures, and PostgreSQL `ON CONFLICT DO NOTHING` to prevent duplicate audit entries during network partitions.

```python
# lineage_tasks.py
import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Dict, Any

from celery import Celery
from celery.utils.log import get_task_logger
from sqlalchemy import create_engine, text

app = Celery(
    "geospatial_lineage",
    broker="redis://localhost:6379/1",
    backend="redis://localhost:6379/2",
    include=["lineage_tasks"]
)

app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    broker_transport_options={"visibility_timeout": 3600},
)

logger = get_task_logger(__name__)

@app.task(
    bind=True,
    max_retries=3,
    default_retry_delay=60,
    acks_late=True
)
def record_lineage_event(self, payload: Dict[str, Any], db_uri: str) -> str:
    """
    Persist geospatial lineage metadata with idempotency guarantees.
    Uses PostgreSQL ON CONFLICT DO NOTHING to handle duplicate deliveries safely.
    """
    # 1. Generate deterministic idempotency key from sorted payload JSON
    payload_bytes = json.dumps(payload, sort_keys=True).encode("utf-8")
    event_id = hashlib.sha256(payload_bytes).hexdigest()

    # 2. Prepare SQL with ON CONFLICT DO NOTHING
    upsert_sql = text("""
        INSERT INTO lineage_events (
            event_id, dataset_uuid, operation, crs_from, crs_to,
            processor_id, timestamp, payload_json
        ) VALUES (
            :event_id, :dataset_uuid, :operation, :crs_from, :crs_to,
            :processor_id, :timestamp, :payload_json
        )
        ON CONFLICT (event_id) DO NOTHING;
    """)

    params = {
        "event_id": event_id,
        "dataset_uuid": payload.get("dataset_uuid"),
        "operation": payload.get("operation"),
        "crs_from": payload.get("crs_from"),
        "crs_to": payload.get("crs_to"),
        "processor_id": payload.get("processor_id"),
        "timestamp": datetime.now(timezone.utc),
        "payload_json": json.dumps(payload)
    }

    try:
        engine = create_engine(db_uri, pool_pre_ping=True, pool_size=5)
        with engine.connect() as conn:
            conn.execute(upsert_sql, params)
            conn.commit()
        logger.info("Lineage event persisted: %s", event_id)
        return f"SUCCESS:{event_id}"
    except Exception as exc:
        logger.warning("Lineage write failed, retrying: %s", exc)
        raise self.retry(exc=exc, countdown=2 ** self.request.retries * 60)
```

### Key Implementation Details

- **Idempotency**: The `event_id` is derived from a sorted JSON hash. Identical payloads produce identical keys, making `ON CONFLICT DO NOTHING` safe for at-least-once delivery systems.
- **Retry Strategy**: Exponential backoff (`2^retries * 60s`) prevents database thrashing during partial outages. `task_acks_late=True` ensures the broker requeues the task if the worker crashes mid-write.
- **Connection Safety**: `pool_pre_ping=True` validates connections before execution, avoiding stale pool errors common in long-running GIS workers.
- **Schema Requirements**: The target table requires a unique constraint on `event_id` for the `ON CONFLICT` clause to function. Refer to PostgreSQL's official [INSERT documentation](https://www.postgresql.org/docs/current/sql-insert.html) for constraint syntax.

## Operationalizing the Pipeline

Deploy workers with concurrency tuned to your database connection limits. For PostgreSQL, `max_connections` minus reserved overhead dictates safe worker counts. Use `celery -A lineage_tasks worker --concurrency=4 --loglevel=info` for baseline deployments, scaling horizontally via Docker or Kubernetes when batch volumes exceed 10k events/hour.

Monitor dead-letter queues and retry rates using Celery Flower or Prometheus exporters. High retry counts typically indicate broker TLS misconfigurations or database connection pool exhaustion. For compliance audits, export lineage tables to W3C PROV-JSON format using the [PROV Data Model](https://www.w3.org/TR/prov-dm/) specification, ensuring interoperability with federal metadata catalogs.

By isolating audit persistence from spatial compute, you eliminate I/O contention, guarantee immutable provenance records, and maintain predictable pipeline throughput across government and enterprise GIS environments.
