# Prefect vs Airflow for Geospatial Provenance

Every geospatial ETL platform eventually faces the same instrumentation question: where do you attach the code that records what was read, what was written, and which coordinate reference system each dataset carried? The orchestrator you choose shapes that answer, because lineage capture is cheapest and most reliable when it rides on the framework's native lifecycle events rather than being bolted onto transformation code. The two orchestrators most GIS automation teams evaluate are Prefect, whose Pythonic task and flow hooks make callbacks feel like ordinary decorators, and Apache Airflow, whose task-instance listeners and first-party OpenLineage integration emit standardized provenance events with almost no bespoke code.

This guide compares the two specifically for embedding provenance hooks, not for orchestration in general. It weighs hook ergonomics, dynamic DAG support, backfill behavior, operational cost, and — decisively for compliance-driven shops — OpenLineage support, then shows the same lineage-capture logic written for both engines. For how hook-based capture fits the wider automation picture, begin with the [Python Automation & Pipeline Integration](https://www.provenance-tracking.com/python-automation-pipeline-integration/) overview, which frames orchestration alongside async logging and hashing concerns.

<svg viewBox="0 0 600 330" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decision tree for choosing Prefect or Airflow for geospatial provenance based on OpenLineage need, DAG dynamism, and operational scale">
<title>Prefect vs Airflow provenance decision tree</title>
<rect width="600" height="330" fill="#fffdf8" rx="10"/>
<defs><marker id="pa" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#2b1d12"/></marker></defs>
<rect x="205" y="14" width="190" height="46" rx="8" fill="#2b1d12"/>
<text x="300" y="34" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="700" fill="#fffdf8">Start: pick orchestrator</text>
<text x="300" y="50" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">for provenance hooks</text>
<rect x="190" y="92" width="220" height="46" rx="8" fill="#5a3c25"/>
<text x="300" y="112" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">Need standardized</text>
<text x="300" y="128" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">OpenLineage events?</text>
<line x1="300" y1="60" x2="300" y2="92" stroke="#2b1d12" stroke-width="2" marker-end="url(#pa)"/>
<rect x="40" y="178" width="190" height="46" rx="8" fill="#5e7b4a"/>
<text x="135" y="198" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">Highly dynamic DAGs,</text>
<text x="135" y="214" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">runtime fan-out?</text>
<rect x="380" y="178" width="190" height="46" rx="8" fill="#b85c3b"/>
<text x="475" y="200" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">Airflow</text>
<text x="475" y="215" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">native OpenLineage provider</text>
<line x1="245" y1="138" x2="150" y2="178" stroke="#2b1d12" stroke-width="2" marker-end="url(#pa)"/>
<text x="175" y="162" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" font-weight="700" fill="#2b1d12">No</text>
<line x1="355" y1="138" x2="455" y2="178" stroke="#2b1d12" stroke-width="2" marker-end="url(#pa)"/>
<text x="428" y="162" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" font-weight="700" fill="#2b1d12">Yes</text>
<rect x="40" y="262" width="190" height="52" rx="8" fill="#3f5a30"/>
<text x="135" y="284" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fffdf8">Prefect</text>
<text x="135" y="299" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#fffdf8">native task/flow hooks</text>
<line x1="135" y1="224" x2="135" y2="262" stroke="#2b1d12" stroke-width="2" marker-end="url(#pa)"/>
<rect x="260" y="262" width="200" height="52" rx="8" fill="#c8a781"/>
<text x="360" y="282" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#2b1d12">Prefect + OpenLineage</text>
<text x="360" y="297" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#2b1d12">emitter in hooks</text>
<line x1="230" y1="224" x2="320" y2="262" stroke="#5a3c25" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#pa)"/>
</svg>

## The comparison matrix

The dimensions below are the ones that separate the two engines for provenance work specifically. Orchestration features that do not touch lineage capture — the scheduler UI, sensor library — are deliberately out of scope.

| Dimension | Prefect 2.x | Airflow 2.7+ |
|-----------|-------------|--------------|
| **Hook mechanism** | `on_completion` / `on_failure` callbacks on tasks and flows | Task-instance listeners via plugin hooks; `on_success_callback` |
| **Hook ergonomics** | Plain Python functions receiving a `State`; minimal ceremony | Listener API is powerful but more boilerplate; callback signatures vary |
| **Dynamic DAGs** | First-class: tasks created at runtime, native fan-out via `.map()` | Dynamic Task Mapping (2.3+); topology historically more static |
| **OpenLineage support** | Community emitter; wire into hooks manually | First-party `apache-airflow-providers-openlineage`; near-automatic |
| **Backfills** | Re-runs are new flow runs; lineage records are naturally versioned | Mature backfill engine; listeners fire per task instance and run date |
| **Ops burden** | Lightweight; Prefect server or Cloud, worker processes | Heavier: scheduler, webserver, metadata DB, executor to operate |
| **Ecosystem maturity** | Younger, Pythonic, fast-moving API surface | Long-established, large operator/provider ecosystem |
| **CRS / spatial facets** | Hand-built payload in the hook | OpenLineage facets carry schema and custom CRS facet cleanly |

## Criterion 1: hook ergonomics

Prefect makes lineage capture feel like a decorator argument. A hook is an ordinary function that receives the final `State`, and you attach it with `on_completion=[...]` directly on the task or flow — the pattern developed in [Integrating Prefect Hooks for Lineage Tracking](https://www.provenance-tracking.com/python-automation-pipeline-integration/workflow-hooks-in-python-pipelines/integrating-prefect-hooks-for-lineage-tracking/). There is no plugin to register, no separate listener module, and the run context is one function call away. Airflow's equivalent, the listener API, is more capable but demands more scaffolding: you implement a listener class, expose it through a plugin, and reason about which lifecycle method (`on_task_instance_success`, `on_task_instance_failed`) fires when. For a small team wiring provenance into a handful of flows, Prefect's ergonomics win outright. For a platform team standardizing capture across hundreds of DAGs, Airflow's listener-plus-plugin structure enforces the consistency that ad-hoc callbacks erode. The general trade-offs of hook placement are surveyed in [Workflow Hooks in Python Pipelines](https://www.provenance-tracking.com/python-automation-pipeline-integration/workflow-hooks-in-python-pipelines/).

## Criterion 2: dynamic DAGs and backfills

Geospatial pipelines fan out naturally — one flow per satellite scene, one task per tile — so runtime topology matters. Prefect treats dynamic task creation as ordinary Python: you loop, you call tasks, you use `.map()`, and each dynamically spawned run carries its own context that a hook can capture without special handling. Airflow reached feature parity later through Dynamic Task Mapping, and while it now maps tasks over runtime-computed collections, the mental model remains more DAG-centric. Backfills expose a subtler difference. Airflow's backfill engine is a mature, first-class feature: re-processing a month of imagery fires listeners per task instance and logical date, so provenance records naturally carry the run date they belong to. Prefect re-runs are simply new flow runs, which also versions lineage cleanly but leans on your store's deduplication to distinguish a backfill from the original execution. If dense historical reprocessing with per-date provenance is central to your compliance story, Airflow's backfill semantics are the safer default.

## Criterion 3: OpenLineage support

This is the criterion that most often decides the matter for regulated organizations. OpenLineage is the emerging open standard for lineage events, and Airflow ships a first-party provider — `apache-airflow-providers-openlineage` — that emits standardized run events, including input and output dataset facets, with almost no code once configured. For a GIS shop that must produce audit-grade, tool-agnostic lineage, that near-automatic emission is a substantial advantage: you inherit a schema that downstream catalogs already understand, and you can attach spatial facets such as CRS without inventing a payload format. Prefect can also emit OpenLineage events, but you wire the emitter into your hooks yourself; the capability exists, the integration is manual. The concrete Airflow-plus-OpenLineage implementation, including how to attach a CRS facet to each dataset, is covered in the companion page [Airflow Lineage Hooks with OpenLineage](https://www.provenance-tracking.com/python-automation-pipeline-integration/prefect-vs-airflow-for-geospatial-provenance/airflow-lineage-hooks-with-openlineage/).

## The same lineage hook in both engines

Reading the identical capture logic in each engine makes the ergonomic gap concrete. First, Prefect — a completion hook that reads the run context and records input/output URIs and CRS:

```python
from datetime import datetime, timezone
from typing import Any
from prefect import flow, task, get_run_logger
from prefect.context import get_run_context
from prefect.states import State

def emit_lineage(state: State) -> None:
    """Prefect hook: capture geospatial lineage on completion."""
    ctx = get_run_context()
    params: dict[str, Any] = getattr(ctx, "parameters", {}) or {}
    record = {
        "run_id": str(getattr(getattr(ctx, "flow_run", None), "id", "unknown")),
        "inputs": params.get("input_uris", []),
        "output": params.get("output_uri", ""),
        "crs": params.get("crs", "UNDEFINED"),
        "state": state.type.value,
        "at": datetime.now(timezone.utc).isoformat(),
    }
    get_run_logger().info("lineage: %s", record)
    # push record to your provenance store here

@task(on_completion=[emit_lineage], on_failure=[emit_lineage])
def reproject(input_uris: list[str], output_uri: str, crs: str) -> str:
    # rasterio/pyproj reprojection happens here
    return output_uri
```

Now the Airflow equivalent — a task-instance listener registered through a plugin, reading the same fields from the task context:

```python
from airflow.listeners import hookimpl
from airflow.plugins_manager import AirflowPlugin
from datetime import datetime, timezone

class LineageListener:
    @hookimpl
    def on_task_instance_success(self, previous_state, task_instance, session) -> None:
        params = task_instance.task.op_kwargs  # supplied to the PythonOperator
        record = {
            "run_id": task_instance.run_id,
            "task_id": task_instance.task_id,
            "inputs": params.get("input_uris", []),
            "output": params.get("output_uri", ""),
            "crs": params.get("crs", "UNDEFINED"),
            "state": "success",
            "at": datetime.now(timezone.utc).isoformat(),
        }
        # push record to your provenance store here

class LineagePlugin(AirflowPlugin):
    name = "lineage_listener"
    listeners = [LineageListener()]
```

The Prefect version is self-contained: the hook and the task live together and the capture attaches inline. The Airflow version separates concerns — the listener is defined once, registered platform-wide through a plugin, and fires for every task instance without touching individual DAG code. That separation is boilerplate for one pipeline and governance for a hundred.

## Criterion 4: operational footprint

The two engines ask for very different operational commitments, and for a small GIS team that commitment often outweighs any feature advantage. Airflow is a multi-process system: a scheduler, a webserver, a metadata database, and an executor, each of which must be sized, secured, and monitored. That footprint buys a mature UI, a vast provider ecosystem, and battle-tested scheduling, but it is genuinely more to run. Prefect is lighter — a server or the hosted Cloud plus worker processes — and its state is easier to reason about for a team that is not staffing a dedicated platform group. For provenance specifically, the footprint matters because your lineage capture inherits the reliability of the orchestrator running it: a listener that never fires because the scheduler is wedged captures nothing. Match the operational weight to the team that will carry the pager, not to the feature checklist.

## Criterion 5: capturing spatial facets

Both engines can record input and output URIs, but geospatial provenance needs more than paths — it needs the CRS, and ideally the bounding box and resolution, of each dataset a step touched. OpenLineage's facet model gives Airflow a clean, standardized slot for that spatial detail: a custom CRS facet attaches to each dataset and travels with the event into any compliant catalog, which is exactly what the [Airflow Lineage Hooks with OpenLineage](https://www.provenance-tracking.com/python-automation-pipeline-integration/prefect-vs-airflow-for-geospatial-provenance/airflow-lineage-hooks-with-openlineage/) companion page demonstrates. In Prefect you build that payload by hand inside the hook — flexible, but a schema you own and must keep consistent yourself. If interoperability with external catalogs is a requirement, the standardized facet is worth real weight; if your provenance store is internal and you control both ends, the hand-built payload is perfectly adequate and often simpler.

## Reliability of capture under failure

Provenance is only as trustworthy as its behavior when things go wrong, and failure is exactly when lineage matters most — an incident review needs to know what a failed run touched, not just what succeeded. Both engines let you capture on failure: Prefect exposes `on_failure` alongside `on_completion`, and Airflow's listener implements `on_task_instance_failed` beside its success counterpart. The subtle risk in both is that an exception raised inside the capture code can mask the original task error, so lineage logic should wrap its own body defensively and log capture failures on a separate channel rather than letting them surface as the task's cause of death. Airflow's listener runs in the worker outside the task's own try/except scope, which isolates it somewhat; Prefect hooks run within the task lifecycle and demand the same discipline. Whichever engine you choose, treat the capture path as production code with its own error handling, not as a fire-and-forget afterthought.

## A note on ecosystem trajectory

Airflow is the older, more entrenched system, with a vast library of operators and a long institutional track record in government and enterprise data teams; that maturity is itself a compliance argument in risk-averse organizations, and its OpenLineage provider reflects a deliberate investment in standardized lineage. Prefect is younger and moves faster, with an API surface that has evolved quickly and a design that consciously optimizes for Python-native ergonomics over configuration. Neither trajectory is strictly better for provenance — the entrenched ecosystem lowers integration risk, while the faster-moving one lowers the friction of writing capture code — but the difference is worth naming when you are choosing a platform you will run for years. Weigh it alongside the concrete criteria above rather than in place of them.

## Recommendation by scenario

**Choose Prefect when** your team is Python-first, your pipelines are highly dynamic with heavy runtime fan-out, you want lineage capture that reads like ordinary code, and you prefer a light operational footprint. Prefect's hooks are the fastest path from zero to captured provenance, and its dynamic model fits per-scene, per-tile geospatial workloads naturally. Add an OpenLineage emitter inside your hooks if you later need the standard.

**Choose Airflow when** standardized, tool-agnostic OpenLineage events are a hard requirement, when dense historical backfills with per-date provenance are central to compliance, or when a platform team must enforce uniform capture across many pipelines. The first-party OpenLineage provider and mature backfill engine do the heavy lifting, and the listener-plus-plugin structure keeps capture consistent at scale.

**Choose Prefect with an OpenLineage emitter** when you want Prefect's ergonomics and dynamism but still need to feed a standards-based catalog — a pragmatic middle path that accepts a small amount of manual wiring in exchange for keeping the lighter orchestrator. Whichever you pick, the discipline of capturing input/output URIs and CRS on every state transition matters more than the engine; both the general hooks overview and the Prefect how-to above establish that pattern, and the OpenLineage companion page carries it into Airflow.
