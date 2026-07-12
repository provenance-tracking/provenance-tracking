# Validating ISO 19115 Lineage with Python

Serializing an `LI_Lineage` structure to XML is only half the job; a record that parses cleanly can still be non-conformant because a mandatory `LI_ProcessStep.description` is blank or a source citation is missing. This how-to builds a focused `lxml` validator that checks an ISO 19139 lineage document against required-element and cardinality rules before it reaches a catalog, complementing the assembly workflow in [Implementing the ISO 19115-1 Lineage Model in a Spatial Pipeline](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/iso-19115-lineage-implementation/). Use it as a CI gate so malformed lineage never reaches production metadata stores.

## Prerequisites

- Python 3.10+ with `lxml` 5.x installed (`pip install "lxml>=5.0"`).
- An ISO 19139 metadata file using the `gmd`/`gco` namespaces (the legacy encoding most validators still accept). The same rule structure ports to the `mrl` namespace of ISO 19115-3.
- Familiarity with the element cardinalities in the [implementation overview](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/iso-19115-lineage-implementation/) — this validator enforces exactly those rules.
- Optional: the official ISO codelist catalogue if you extend the rules to check `codeListValue` membership.

## Implementation

The validator loads the document, registers namespaces, and applies a small declarative rule set. Each rule is an XPath plus a cardinality expectation; the checker reports the first violation per rule with a human-readable path, so failures point straight at the offending element.

```python
from __future__ import annotations
from dataclasses import dataclass
from lxml import etree

NS = {
    "gmd": "http://www.isotc211.org/2005/gmd",
    "gco": "http://www.isotc211.org/2005/gco",
}

@dataclass
class Rule:
    label: str
    xpath: str          # evaluated relative to each LI_ProcessStep or the root
    min_count: int
    scope: str = "root"  # "root" or "step"

# Rule set: mandatory LI_ProcessStep.description and at least one source citation.
RULES: list[Rule] = [
    Rule("LI_Lineage present", ".//gmd:LI_Lineage", 1, "root"),
    Rule("At least one processStep or statement",
         ".//gmd:LI_ProcessStep | .//gmd:statement", 1, "root"),
    Rule("ProcessStep.description mandatory [1]",
         "gmd:description/gco:CharacterString", 1, "step"),
    Rule("ProcessStep.description non-empty",
         "gmd:description/gco:CharacterString[normalize-space(text())]", 1, "step"),
    Rule("Source citation title present [1..*]",
         ".//gmd:LI_Source/gmd:sourceCitation//gmd:title/gco:CharacterString", 1, "root"),
]

def validate_lineage(xml_path: str) -> list[str]:
    tree = etree.parse(xml_path)
    root = tree.getroot()
    errors: list[str] = []

    for rule in RULES:
        if rule.scope == "root":
            hits = root.xpath(rule.xpath, namespaces=NS)
            if len(hits) < rule.min_count:
                errors.append(f"FAIL [{rule.label}]: found {len(hits)}, "
                              f"need >= {rule.min_count}")
        else:  # per-step evaluation catches an empty description on any one step
            steps = root.xpath(".//gmd:LI_ProcessStep", namespaces=NS)
            for i, step in enumerate(steps):
                hits = step.xpath(rule.xpath, namespaces=NS)
                if len(hits) < rule.min_count:
                    errors.append(f"FAIL [{rule.label}]: LI_ProcessStep[{i}] "
                                  f"found {len(hits)}, need >= {rule.min_count}")
    return errors

if __name__ == "__main__":
    import sys
    problems = validate_lineage(sys.argv[1])
    if problems:
        print(f"INVALID — {len(problems)} violation(s):")
        for p in problems:
            print("  " + p)
        sys.exit(1)
    print("VALID — all lineage rules satisfied")
    sys.exit(0)
```

The `scope="step"` rules are evaluated once per `LI_ProcessStep`, which is what catches the common case where one of several steps has an empty description while the others are fine — a document-level XPath count would miss it because the other steps satisfy the count.

## Verification

Run the validator against a well-formed record and against a deliberately broken one. A conformant document exits `0`:

```bash
$ python validate.py good_lineage.xml
VALID — all lineage rules satisfied
```

A record whose second process step has an empty `<gmd:description/>` and no source citation fails with precise pointers:

```text
$ python validate.py broken_lineage.xml
INVALID — 3 violation(s):
  FAIL [ProcessStep.description mandatory [1]]: LI_ProcessStep[1] found 0, need >= 1
  FAIL [ProcessStep.description non-empty]: LI_ProcessStep[1] found 0, need >= 1
  FAIL [Source citation title present [1..*]]: found 0, need >= 1
```

Wire the non-zero exit code into your pipeline's pre-publish stage so a failing record blocks the run, exactly as described for CI gating in the [implementation overview](https://www.provenance-tracking.com/regulatory-compliance-standards-mapping/iso-19115-lineage-implementation/). For raster pipelines, run this immediately after the checksum step covered in [generating SHA-256 hashes for GeoTIFFs in Python](https://www.provenance-tracking.com/python-automation-pipeline-integration/automated-hash-generation-for-rasters/generating-sha-256-hashes-for-geotiffs-in-python/) so both integrity and lineage conformance are gated together.

## Gotchas & edge cases

- **Namespace prefixes are not fixed by the standard.** A document may declare `gmd` as `md` or use a default namespace with no prefix at all. XPath matches on the namespace URI, not the prefix, so always pass the `namespaces=NS` mapping and never hard-code a literal prefix into an element test. If a document uses ISO 19115-3, swap the URIs for the `mrl`/`mcc` namespaces rather than editing every rule.
- **Codelist values look present but may be empty.** `CI_RoleCode` and `MD_ScopeCode` carry their value in the `codeListValue` attribute, not in element text. A rule that only checks for the element's existence will pass a role of `codeListValue=""`. If you extend the rule set to validate roles, assert `@codeListValue` is non-empty and, ideally, a member of the official codelist.
- **`normalize-space()` matters for whitespace-only descriptions.** A `<gco:CharacterString>   </gco:CharacterString>` is technically present but semantically empty; the `normalize-space(text())` predicate in the rule set is what rejects it. Without it, a step padded with spaces would pass and produce a meaningless audit record.
