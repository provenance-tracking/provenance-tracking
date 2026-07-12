// provenance-tracking.com — client behaviors
(function () {
  "use strict";

  // --- Mobile nav toggle ---------------------------------------------
  const toggle = document.querySelector(".nav-toggle");
  const nav = document.getElementById("primary-nav");
  if (toggle && nav) {
    toggle.addEventListener("click", () => {
      const open = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    nav.addEventListener("click", (e) => {
      if (e.target.tagName === "A") {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  // --- Copy-to-clipboard buttons on codeblocks -----------------------
  document.querySelectorAll(".codeblock .copy-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const pre = btn.parentElement.querySelector("pre code");
      if (!pre) return;
      const text = pre.innerText;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "Copied";
        btn.setAttribute("data-copied", "true");
      } catch (_) {
        // Fallback: select range
        const r = document.createRange();
        r.selectNodeContents(pre);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        document.execCommand && document.execCommand("copy");
        sel.removeAllRanges();
        btn.textContent = "Copied";
        btn.setAttribute("data-copied", "true");
      }
      setTimeout(() => {
        btn.textContent = "Copy";
        btn.removeAttribute("data-copied");
      }, 1800);
    });
  });

  // --- Make task-list checkboxes interactive -------------------------
  // markdown-it-task-lists emits disabled checkboxes; re-enable them and
  // toggle the strike-through state of the surrounding label/list item.
  document.querySelectorAll(".article .task-list-item input[type=checkbox]").forEach((cb) => {
    cb.removeAttribute("disabled");
    const li = cb.closest("li");
    const sync = () => {
      if (li) li.classList.toggle("is-done", cb.checked);
    };
    sync();
    cb.addEventListener("change", sync);
  });

  // --- Mermaid lazy init --------------------------------------------
  const mermaidBlocks = document.querySelectorAll("pre.mermaid");
  if (mermaidBlocks.length) {
    // Lazy-load mermaid from a vendored copy if present; otherwise leave
    // the raw flowchart text visible as a graceful fallback.
    const script = document.createElement("script");
    script.src = "/assets/js/mermaid.min.js";
    script.onload = () => {
      if (window.mermaid && typeof window.mermaid.initialize === "function") {
        window.mermaid.initialize({
          startOnLoad: false,
          theme: "base",
          themeVariables: {
            background: "#fffdf8",
            primaryColor: "#f6efe2",
            primaryTextColor: "#2b1d12",
            primaryBorderColor: "#5a3c25",
            lineColor: "#5a3c25",
            secondaryColor: "#b6c79f",
            tertiaryColor: "#d68361",
            fontFamily: "JetBrains Mono, monospace"
          }
        });
        try {
          window.mermaid.run({ querySelector: "pre.mermaid" });
        } catch (e) {
          /* swallow */
        }
      }
    };
    script.onerror = () => {
      // No mermaid available; render blocks as styled code instead.
      mermaidBlocks.forEach((b) => b.classList.add("mermaid--fallback"));
    };
    document.head.appendChild(script);
  }

  // --- Service worker registration ----------------------------------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => { /* ignore */ });
    });
  }
})();
