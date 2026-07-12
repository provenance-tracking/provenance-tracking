<p align="center">
  <a href="https://www.provenance-tracking.com">
    <img src="https://www.provenance-tracking.com/assets/icons/og-image.png" alt="Geospatial Data Lineage & Provenance Tracking — trace every coordinate, raster, and transform from acquisition to audit" width="100%">
  </a>
</p>

<h1 align="center">Geospatial Data Lineage &amp; Provenance Tracking</h1>

<p align="center">
  <strong>A practical, engineering-first guide to tracing spatial data — from acquisition to audit.</strong><br>
  Origin tracking, transformation audit trails, compliance mapping, and Python pipeline integration for production GIS.
</p>

<p align="center">
  <a href="https://www.provenance-tracking.com"><b>🌐 Read the guide →</b></a>
</p>

---

## What this is

**[provenance-tracking.com](https://www.provenance-tracking.com)** is an open reference library for
building provenance and lineage into geospatial data systems. Every coordinate reference system
change, raster resampling, vector merge, and multi-agency handoff leaves a trail — this site shows
you how to capture that trail so it holds up under a compliance audit, a reproducibility check, or a
freedom-of-information request.

The material is written for people who actually build and operate spatial pipelines. It favours
runnable Python, real PostGIS and Cypher, concrete failure modes, and control-to-field mapping
tables over abstract theory. Diagrams are hand-authored, accessible SVGs; code blocks are complete
and copy-pasteable.

## Who it's for

- **GIS data stewards** who need every dataset to carry a defensible history.
- **Python automation engineers** wiring provenance into spatial ETL/ELT.
- **Compliance officers** mapping GDPR, FISMA, INSPIRE, and ISO 19115 obligations to real data fields.
- **Government and agency teams** who have to produce audit-ready lineage on demand.

## What's inside

The guide is organised into four tracks, each with an overview and a set of step-by-step how-tos:

### 🧭 Geospatial Lineage Fundamentals & Architecture
The vocabulary and the shape of a lineage system — provenance models, transformation logging
standards, trust boundaries, data stewardship, scoping rules for agencies, and how to map
regulatory frameworks to capture points.

### ⚙️ Python Automation & Pipeline Integration
Embedding provenance directly in code — workflow hooks, asynchronous logging, tamper-evident
raster hashing, and metadata injection, plus a Prefect-versus-Airflow decision guide for
orchestrating lineage capture.

### 🗄️ Storage, Indexing & Query Optimization
Where lineage lives and how it stays fast — PostGIS schema design, graph databases for derivation
chains, write-once-read-many retention on object storage, spatial and temporal index tuning, and a
PostGIS-versus-Neo4j comparison for spatial lineage graphs.

### 🛡️ Regulatory Compliance & Standards Mapping
Turning lineage records into audit evidence — dedicated playbooks for GDPR on location data, FISMA
control families, the INSPIRE metadata mandate, and a full ISO 19115 lineage implementation, each
with control-to-field tables and Python validation.

## Highlights

- **50+ in-depth articles** spanning fundamentals, automation, storage, and compliance.
- **Runnable code** in Python 3.10+, SQL/PostGIS, and Cypher — with realistic version pins.
- **Standards-grounded**: ISO 19115, W3C PROV-O, OGC API — Records, INSPIRE, FISMA/NIST 800-53, GDPR.
- **Accessible by design**: hand-authored SVG diagrams, WCAG-checked contrast, semantic structure.
- **Fast and dependency-light**: a static site with no third-party trackers or CDN dependencies.

## How it's built

A static site generated with [Eleventy](https://www.11ty.dev/), authored in Markdown, and deployed
to [Cloudflare Pages](https://pages.cloudflare.com/). Structured data (Article and BreadcrumbList
JSON-LD), the sitemap, navigation, and cross-links are generated from the content tree at build time.

```bash
npm install      # install build dependencies
npm run build    # generate the static site into _site/
npm run serve    # local dev server with live reload
npm run deploy    # build and publish to Cloudflare Pages
```

### Project layout

```
src/
  content/            Markdown articles, organised by section
  _includes/          Nunjucks layouts and partials
  _data/site.json     Site metadata and section definitions
  assets/             CSS, icons, and client JavaScript
.eleventy.js          Build configuration (Markdown, code highlighting, tables)
```

## Contributing & reuse

Issues and suggestions that improve technical accuracy are welcome. The content is provided as a
learning and reference resource; if you build on it, a link back to
[provenance-tracking.com](https://www.provenance-tracking.com) is appreciated.

---

<p align="center">
  <a href="https://www.provenance-tracking.com"><b>provenance-tracking.com</b></a> — trace every coordinate, raster, and transform.
</p>
