const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const markdownIt = require("markdown-it");
const markdownItAnchor = require("markdown-it-anchor");
const markdownItAttrs = require("markdown-it-attrs");
const markdownItTaskLists = require("markdown-it-task-lists");
const slugify = require("slugify");
const Prism = require("prismjs");
const loadLanguages = require("prismjs/components/");
loadLanguages(["python", "bash", "json", "yaml", "xml", "sql", "docker", "cypher"]);

const ASCII_DIAGRAM_CHARS = /[┌┐└┘├┤┬┴┼─│▶►◀◁▲▼]/;

function highlight(code, lang) {
  const language = (lang || "").trim().toLowerCase();
  if (language && Prism.languages[language]) {
    try {
      return Prism.highlight(code, Prism.languages[language], language);
    } catch (_) {
      // fall through to escape
    }
  }
  return escapeHtml(code);
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


function buildMarkdown() {
  const md = markdownIt({
    html: true,
    linkify: false,
    typographer: true
  });

  md.use(markdownItAnchor, {
    permalink: markdownItAnchor.permalink.headerLink({ safariReaderFix: true }),
    slugify: (s) => slugify(s, { lower: true, strict: true })
  });
  md.use(markdownItAttrs);
  md.use(markdownItTaskLists, { enabled: false, label: true, labelAfter: false });

  // Wrap tables for horizontal scroll
  const defaultTableOpen = md.renderer.rules.table_open || function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.table_open = function (tokens, idx, options, env, self) {
    return `<div class="table-scroll">` + defaultTableOpen(tokens, idx, options, env, self);
  };
  const defaultTableClose = md.renderer.rules.table_close || function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.table_close = function (tokens, idx, options, env, self) {
    return defaultTableClose(tokens, idx, options, env, self) + `</div>`;
  };

  // Intercept ALL fenced code blocks to emit the codeblock div directly,
  // avoiding the outer <pre><code> wrapper that markdown-it would add when
  // the highlight function return value does not begin with "<pre".
  md.renderer.rules.fence = function (tokens, idx) {
    const token = tokens[idx];
    const info = (token.info || "").trim();
    const code = token.content;

    // Mermaid language tag — must not be used; diagrams should be hand-authored inline SVG
    if (info === "mermaid") {
      return `<pre class="mermaid" tabindex="0">${escapeHtml(code)}</pre>\n`;
    }

    // All other fenced blocks: emit codeblock div directly (no outer <pre><code>)
    const langClass = info ? ` language-${info}` : "";
    const highlighted = highlight(code, info);
    return `<div class="codeblock" data-lang="${info || "text"}"><button type="button" class="copy-btn" aria-label="Copy code">Copy</button><pre class="code${langClass}" tabindex="0"><code class="${langClass.trim()}">${highlighted}</code></pre></div>\n`;
  };

  return md;
}

// Promote consecutive H3 + body groups that follow an H2 named "FAQ" /
// "Frequently Asked Questions" into <details> accordions. Operates on the
// rendered HTML to avoid wrestling with markdown-it's token streams.
function transformFaqAccordions(html) {
  return html.replace(
    /<h2([^>]*)>(\s*(?:<a[^>]*>)?\s*(?:FAQ|Frequently Asked Questions)[\s\S]*?)<\/h2>([\s\S]*?)(?=<h2|$)/gi,
    (match, h2Attrs, h2Inner, body) => {
      const items = [];
      const re = /<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3|$)/gi;
      let m;
      while ((m = re.exec(body)) !== null) {
        items.push(
          `<details class="faq-item"><summary>${m[1].trim()}</summary><div class="faq-body">${m[2].trim()}</div></details>`
        );
      }
      if (!items.length) return match;
      return `<h2${h2Attrs}>${h2Inner}</h2><div class="faq">${items.join("")}</div>`;
    }
  );
}

module.exports = function (eleventyConfig) {
  const md = buildMarkdown();
  eleventyConfig.setLibrary("md", md);

  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });
  eleventyConfig.addPassthroughCopy({ "src/manifest.json": "manifest.json" });
  eleventyConfig.addPassthroughCopy({ "src/sw.js": "sw.js" });
  eleventyConfig.addPassthroughCopy({ "src/assets/icons/favicon.ico": "favicon.ico" });
  eleventyConfig.addPassthroughCopy({ "src/_headers": "_headers" });
  // IndexNow key file served at root
  eleventyConfig.addPassthroughCopy({ "src/95c06c7c4a7e2f2fe87dd14335edb9cc.txt": "95c06c7c4a7e2f2fe87dd14335edb9cc.txt" });
  // Vendor mermaid from node_modules so the site has no external CDN deps.
  eleventyConfig.addPassthroughCopy({ "node_modules/mermaid/dist/mermaid.min.js": "assets/js/mermaid.min.js" });

  eleventyConfig.addFilter("assetHash", (url) => {
    try {
      const relPath = url.replace(/^\//, "").split("?")[0];
      // Assets are served from /assets/* but live in src/assets/*
      const filePath = path.join(__dirname, "src", relPath);
      const hash = crypto.createHash("md5").update(fs.readFileSync(filePath)).digest("hex").slice(0, 8);
      return `${url}?v=${hash}`;
    } catch {
      return url;
    }
  });

  eleventyConfig.addFilter("absolutize", (url) => {
    if (!url) return "/";
    return url.startsWith("/") ? url : `/${url}`;
  });

  eleventyConfig.addFilter("titleCase", (s) =>
    String(s || "")
      .split(/[-_/]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")
  );

  eleventyConfig.addFilter("breadcrumbs", (url) => {
    if (!url || url === "/") return [];
    const parts = url.replace(/^\/+|\/+$/g, "").split("/");
    const crumbs = [];
    let acc = "";
    for (const part of parts) {
      acc += `/${part}`;
      crumbs.push({ url: `${acc}/`, label: part });
    }
    return crumbs;
  });

  eleventyConfig.addFilter("section", (url) => {
    if (!url) return "";
    const parts = url.replace(/^\/+|\/+$/g, "").split("/");
    return parts[0] || "";
  });

  eleventyConfig.addFilter("excerpt", (content) => {
    if (!content) return "";
    const text = String(content)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > 220 ? text.slice(0, 217).trimEnd() + "…" : text;
  });

  eleventyConfig.addFilter("firstParagraph", (raw) => {
    if (!raw) return "";
    const lines = String(raw).split(/\r?\n/);
    let started = false;
    const out = [];
    for (const line of lines) {
      if (line.startsWith("#")) continue;
      if (line.trim() === "") {
        if (started) break;
        continue;
      }
      started = true;
      out.push(line.trim());
    }
    return out.join(" ");
  });

  // Group pages by section for sidebars / related links
  const isContentPage = (item) => {
    if (!item.url || item.url === "/") return false;
    const tags = item.data.tags || [];
    return Array.isArray(tags) ? tags.includes("page") : tags === "page";
  };

  eleventyConfig.addCollection("pages", (api) => api.getAll().filter(isContentPage));

  eleventyConfig.addCollection("bySection", (api) => {
    const grouped = {};
    for (const item of api.getAll()) {
      if (!isContentPage(item)) continue;
      const section = item.url.replace(/^\/+/, "").split("/")[0];
      if (!grouped[section]) grouped[section] = [];
      grouped[section].push(item);
    }
    for (const s of Object.keys(grouped)) {
      grouped[s].sort((a, b) => a.url.localeCompare(b.url));
    }
    return grouped;
  });

  // Apply FAQ accordion transform after markdown rendering on rendered HTML
  eleventyConfig.addTransform("faqAccordions", function (content) {
    if (this.page && this.page.outputPath && this.page.outputPath.endsWith(".html")) {
      return transformFaqAccordions(content);
    }
    return content;
  });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "_data"
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    templateFormats: ["njk", "md", "11ty.js"]
  };
};
