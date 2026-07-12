# Versioning Lineage Rows with Temporal Tables

Auditors ask two different questions about a dataset's history: "what did the record say at 3pm on the day of the incident" (system time) and "which processing rule was legally in force when the dataset was published" (valid time). Answering both requires bitemporal versioning — two independent time axes on every lineage row — rather than a single `updated_at` column that conflates them. This how-to models lineage rows with `tstzrange` valid-time and system-time columns, enforces non-overlap with an exclusion constraint, and runs a point-in-time as-of query. It builds on the [PostGIS Lineage Schema Design](https://www.provenance-tracking.com/storage-indexing-query-optimization/postgis-lineage-schema-design/) and pairs naturally with the append-only [lineage audit table](https://www.provenance-tracking.com/storage-indexing-query-optimization/postgis-lineage-schema-design/designing-a-postgis-lineage-audit-table/).

## Prerequisites

- PostgreSQL 15+ with PostGIS 3.4+ and the `btree_gist` extension (required to combine a scalar key with a range in one exclusion constraint).
- Comfort with the `tstzrange` type and its operators, especially `&&` (overlaps) and `@>` (contains).
- All timestamps generated in UTC to avoid the timezone pitfalls described below.

## Implementation

Each logical lineage fact — say, the projection parameters for a given `dataset_id` — becomes a series of rows, each valid over a half-open `tstzrange`. `system_time` records when the row was physically known to the database; `valid_time` records when the fact was true in the real world. An exclusion constraint using `btree_gist` guarantees that no two currently-known rows for the same dataset have overlapping valid periods, which is what keeps an as-of query unambiguous.

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE lineage_version (
    version_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dataset_id   uuid        NOT NULL,
    operation    text        NOT NULL,
    parameters   jsonb       NOT NULL DEFAULT '{}'::jsonb,
    extent       geometry(Polygon, 4326),
    -- Real-world validity of the fact.
    valid_time   tstzrange   NOT NULL,
    -- Database knowledge time; upper bound 'infinity' means "current".
    system_time  tstzrange   NOT NULL DEFAULT tstzrange(now(), 'infinity'),

    -- No two live versions of the same dataset may cover the same valid instant.
    CONSTRAINT no_valid_overlap EXCLUDE USING gist (
        dataset_id WITH =,
        valid_time WITH &&
    ) WHERE (upper(system_time) = 'infinity'),

    CONSTRAINT valid_time_nonempty CHECK (NOT isempty(valid_time))
);

CREATE INDEX lineage_version_valid_gix  ON lineage_version USING gist (valid_time);
CREATE INDEX lineage_version_extent_gix ON lineage_version USING gist (extent);
```

Superseding a fact is a two-step, append-friendly operation: close the old row on the system-time axis (set its upper bound to `now()`) and insert the replacement. The old row is never physically deleted, so system-time history stays intact. A helper function keeps the two steps in one transaction.

```sql
CREATE OR REPLACE FUNCTION supersede_lineage(
    p_dataset_id uuid,
    p_operation  text,
    p_parameters jsonb,
    p_extent_wkt text,
    p_valid_from timestamptz
) RETURNS bigint AS $$
DECLARE
    new_id bigint;
BEGIN
    -- Close the currently-live row for this dataset on the system axis.
    UPDATE lineage_version
    SET system_time = tstzrange(lower(system_time), now())
    WHERE dataset_id = p_dataset_id
      AND upper(system_time) = 'infinity';

    INSERT INTO lineage_version (dataset_id, operation, parameters, extent, valid_time)
    VALUES (
        p_dataset_id, p_operation, p_parameters,
        ST_GeomFromText(p_extent_wkt, 4326),
        tstzrange(p_valid_from, 'infinity')
    )
    RETURNING version_id INTO new_id;

    RETURN new_id;
END;
$$ LANGUAGE plpgsql;
```

## Verification

Run an as-of query that answers "what was known to be true about this dataset at a specific past instant". It filters both axes: `valid_time @> asof` selects the row that was real-world-valid then, and `system_time @> asof` selects the row the database actually knew at that moment — together they reconstruct the exact bitemporal state.

```sql
-- Bitemporal point-in-time read: state as known and as valid at one instant.
SELECT version_id, operation, parameters, lower(valid_time) AS effective_from
FROM lineage_version
WHERE dataset_id = '7c9e...'::uuid
  AND valid_time  @> TIMESTAMPTZ '2026-05-01 12:00:00+00'
  AND system_time @> TIMESTAMPTZ '2026-05-01 12:00:00+00';
```

To confirm the exclusion constraint works, insert two overlapping valid periods for the same dataset — the second insert must fail:

```sql
INSERT INTO lineage_version (dataset_id, operation, valid_time)
VALUES ('7c9e...'::uuid, 'reproject', tstzrange('2026-01-01', '2026-06-01'));

-- Overlaps the first row's valid_time; raises: conflicting key value violates
-- exclusion constraint "no_valid_overlap"
INSERT INTO lineage_version (dataset_id, operation, valid_time)
VALUES ('7c9e...'::uuid, 'reproject', tstzrange('2026-03-01', '2026-09-01'));
```

A successful rejection proves that current valid-time versions cannot overlap, which is precisely what makes the as-of query return exactly one row.

## Gotchas & edge cases

- **`tstzrange` bound inclusivity.** Ranges default to `[lower, upper)` — inclusive lower, exclusive upper. Two ranges that meet at an endpoint, such as `[..., '2026-06-01')` and `['2026-06-01', ...)`, do not overlap and both satisfy the constraint, which is the behavior you want. If you accidentally build inclusive-upper ranges, adjacent versions will collide at the shared instant and the exclusion constraint will reject legitimate inserts.
- **Timezone drift.** `tstzrange` stores instants in UTC but renders them in the session `TimeZone`. If ingestion workers run in local time and construct ranges from naive timestamps, two workers in different zones can produce ranges that look adjacent but actually overlap by the offset. Always build ranges from `timestamptz` values normalized to UTC (`now()` at UTC, or explicit `AT TIME ZONE 'UTC'`) so the exclusion constraint reasons over a single clock.
- **Empty and infinite ranges.** An accidentally empty range (`tstzrange('2026-06-01','2026-06-01')` is empty) slips past the overlap check because empty ranges overlap nothing, silently creating an invalid version — the `valid_time_nonempty` CHECK guards against it. Likewise, leaving `valid_time` unbounded with `'infinity'` on more than one live row for the same dataset is impossible only because the exclusion constraint catches it; never disable that constraint during bulk loads without re-validating afterward.
