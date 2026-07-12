# FISMA Control Mapping for GIS Pipelines

When an assessor asks "show me that AU-3 operates on your reprojection service," you do not want to answer from memory — you want a machine-readable map that binds each NIST 800-53 control to the exact lineage hook that produces its evidence, plus a validator that fails the build when a run skipped one. This how-to, a companion to the [FISMA compliance for spatial systems](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/fisma-compliance-for-spatial-systems/) overview, builds that map as a YAML file and a Python checker you can run in CI against a pipeline run's emitted events.

## Prerequisites

- Python 3.10+ with `PyYAML` 6.x installed (`pip install pyyaml`).
- A pipeline that already emits structured lineage events as JSON lines — the `LineageAuditEvent` shape from the overview page (fields: `event_type`, `occurred_at`, `component`, `actor`, `outcome`, `output_sha256`, `parameters`).
- Read access to the run's `audit.jsonl` output and write access to a repo path for the mapping file.
- Agreement on your auditable-events list, so the mapping's `applies_to` event types are stable.

## Implementation

The mapping declares, per control, which lineage fields must be present and non-empty, and which `event_type` values the control applies to. Keeping it in YAML means auditors can read it and change control lets you review edits to it.

```yaml
# controls_to_hooks.yaml — NIST 800-53 control -> lineage evidence binding
version: 1
controls:
  AU-3:
    title: Content of audit records
    applies_to: ["*"]                 # every auditable event must be AU-3 complete
    require_fields: [event_type, occurred_at, component, actor, source_uri, outcome]
  AU-8:
    title: Time stamps
    applies_to: ["*"]
    require_fields: [occurred_at]
    require_utc: [occurred_at]         # must end in +00:00 or Z
  CM-3:
    title: Configuration change control
    applies_to: ["raster.reproject", "vector.transform", "service.publish"]
    require_fields: [parameters]
    require_nonempty: [parameters]     # tool version / settings must be captured
  SI-7:
    title: Software and information integrity
    applies_to: ["raster.reproject", "raster.generate", "vector.transform"]
    require_fields: [output_sha256]
    require_hash: output_sha256        # 64 lowercase hex chars
  AC-6:
    title: Least privilege
    applies_to: ["*"]
    require_fields: [actor]
    forbid_values:
      actor: ["", "root", "shared", "anonymous"]
```

The validator loads this mapping, streams the run's events, and checks every applicable control against every event. It returns a non-zero exit code so a CI job blocks a non-compliant pipeline run.

```python
from __future__ import annotations
import json
import re
import sys
from pathlib import Path
import yaml

HEX64 = re.compile(r"^[0-9a-f]{64}$")

def _applies(rule: dict, event_type: str) -> bool:
    targets = rule.get("applies_to", [])
    return "*" in targets or event_type in targets

def _check_event(control: str, rule: dict, evt: dict) -> list[str]:
    """Return a list of human-readable findings for one control/event pair."""
    findings: list[str] = []
    for field_name in rule.get("require_fields", []):
        if not evt.get(field_name):
            findings.append(f"{control}: missing required field '{field_name}'")
    for field_name in rule.get("require_nonempty", []):
        value = evt.get(field_name)
        if not value or (isinstance(value, (dict, list)) and len(value) == 0):
            findings.append(f"{control}: field '{field_name}' must be non-empty")
    for field_name in rule.get("require_utc", []):
        value = str(evt.get(field_name, ""))
        if not (value.endswith("+00:00") or value.endswith("Z")):
            findings.append(f"{control}: '{field_name}' is not UTC ({value!r})")
    hash_field = rule.get("require_hash")
    if hash_field and not HEX64.match(str(evt.get(hash_field, ""))):
        findings.append(f"{control}: '{hash_field}' is not a 64-char SHA-256 hex digest")
    for field_name, bad_values in rule.get("forbid_values", {}).items():
        if str(evt.get(field_name, "")) in bad_values:
            findings.append(f"{control}: '{field_name}'={evt.get(field_name)!r} is forbidden")
    return findings

def validate_run(mapping_path: Path, events_path: Path) -> list[str]:
    mapping = yaml.safe_load(mapping_path.read_text(encoding="utf-8"))
    controls: dict[str, dict] = mapping["controls"]
    all_findings: list[str] = []
    covered: dict[str, int] = {c: 0 for c in controls}

    with events_path.open(encoding="utf-8") as fh:
        for line_no, raw in enumerate(fh, start=1):
            raw = raw.strip()
            if not raw:
                continue
            evt = json.loads(raw)
            etype = evt.get("event_type", "")
            for control, rule in controls.items():
                if not _applies(rule, etype):
                    continue
                covered[control] += 1
                for finding in _check_event(control, rule, evt):
                    all_findings.append(f"line {line_no} [{etype}]: {finding}")

    # A control that never matched any event is itself a coverage gap.
    for control, hits in covered.items():
        if hits == 0:
            all_findings.append(f"{control}: no events in run exercised this control")
    return all_findings

if __name__ == "__main__":
    findings = validate_run(Path("controls_to_hooks.yaml"), Path("audit.jsonl"))
    if findings:
        print(f"FISMA control mapping: {len(findings)} finding(s)")
        for f in findings:
            print("  -", f)
        sys.exit(1)
    print("FISMA control mapping: all applicable controls evidenced")
```

The two-layer design matters: `_check_event` proves each *present* event satisfies its controls, while the `covered` tally catches the opposite failure — a control that no event ever exercised, which usually means a pipeline stage silently stopped emitting. Both are findings an assessor would raise, so both fail the build.

The rule vocabulary is deliberately small — `require_fields`, `require_nonempty`, `require_utc`, `require_hash`, and `forbid_values` — because a mapping an auditor cannot read is a mapping no one trusts. Each predicate corresponds to something an assessor checks by eye: that the field exists, that it carries real content, that timestamps are in UTC for AU-8 ordering, that an integrity value is a genuine digest rather than a placeholder, and that the acting principal is not a shared or superuser identity. Resisting the urge to add a general-purpose expression language keeps the YAML declarative and the review of a control change trivial. When a control genuinely needs richer logic — say, that a `service.publish` event references an output whose hash appeared in an earlier `raster.reproject` event — implement it as a named cross-event check in Python rather than smuggling procedural logic into the data file, so the mapping remains something a compliance officer can approve without reading code.

## Verification

Run the validator against a known-good run and confirm a clean exit, then deliberately corrupt an event to prove the checks bite.

```bash
$ python validate_controls.py
FISMA control mapping: all applicable controls evidenced
$ echo $?
0
```

Now blank out an `output_sha256` on one `raster.reproject` line and rerun:

```text
FISMA control mapping: 1 finding(s)
  - line 42 [raster.reproject]: SI-7: 'output_sha256' is not a 64-char SHA-256 hex digest
```

A non-zero exit code confirms CI would block the merge. For a positive control, remove every `service.publish` event and you should see the CM-3 and coverage findings fire, proving the `covered` tally detects a stage that stopped emitting.

## Gotchas & edge cases

- **`applies_to` wildcards hide gaps.** A control mapped to `["*"]` is exercised by any event, so its coverage tally is almost always non-zero even if the pipeline is broken. Reserve `"*"` for genuinely universal controls (AU-3, AU-8, AC-6) and pin integrity controls to the specific spatial event types that produce artifacts, so a missing `raster.reproject` surfaces as a real gap.
- **Timezone strings that look UTC but aren't.** `datetime.now().isoformat()` without `timezone.utc` yields a naive string with no offset, which passes a naive `endswith` check only if you are not careful — the `require_utc` rule rejects anything not ending in `+00:00` or `Z`, so always construct timestamps with `datetime.now(timezone.utc)`.
- **Empty `parameters` on reprojection.** A CM-3 finding on `raster.reproject` almost always means the pipeline emitted the event before capturing the GDAL version and resampling method. Populate `parameters` at the same call site that runs the transform, not in a later enrichment pass that a failed run may never reach.

Keep the YAML mapping under the same change control as the pipeline code; when you add a control to the baseline in your System Security Plan, add it here in the same pull request so the validator and the assessment stay in lockstep.
