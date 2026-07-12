module.exports = {
  layout: "layouts/content.njk",
  tags: ["page"],
  templateEngineOverride: "md",
  eleventyComputed: {
    permalink: (data) => {
      // Strip the leading "content/" segment so URLs match in-content links.
      const fp = data.page.filePathStem || "";
      const stripped = fp.replace(/^\/content\//, "/").replace(/\/index$/, "/");
      return stripped.endsWith("/") ? stripped : stripped + "/";
    },
    title: (data) => {
      // Use first H1 in raw markdown if no front-matter title; fall back to URL slug.
      if (data.title) return data.title;
      const raw = data.page && data.page.rawInput ? data.page.rawInput : "";
      const m = raw.match(/^\s*#\s+(.+)$/m);
      if (m) return m[1].trim();
      const segs = (data.page.url || "").replace(/^\/+|\/+$/g, "").split("/");
      const slug = segs[segs.length - 1] || "Page";
      return slug
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
    },
    section: (data) => {
      const url = data.page.url || "";
      return url.replace(/^\/+/, "").split("/")[0];
    },
    description: (data) => {
      if (data.description) return data.description;
      const raw = data.page && data.page.rawInput ? data.page.rawInput : "";
      // Strip the first H1 and find the first prose paragraph
      const lines = raw.split(/\r?\n/);
      const buf = [];
      let started = false;
      for (const line of lines) {
        if (/^\s*#/.test(line)) { if (started) break; continue; }
        if (/^\s*```/.test(line) || /^\s*\|/.test(line) || /^\s*[-*]\s/.test(line)) { if (started) break; continue; }
        if (line.trim() === "") { if (started) break; continue; }
        started = true;
        buf.push(line.trim());
      }
      let text = buf.join(" ")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[*_`]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (text.length > 158) text = text.slice(0, 155).trimEnd() + "…";
      return text || "Geospatial data lineage and provenance tracking for production GIS pipelines.";
    }
  }
};
