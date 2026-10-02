// Shared helpers for the Myrmo website. No dependencies.
// Classic script (not a module) so pages also work when opened from file://.
(function () {
"use strict";


/** Wire up every `.copy` button to copy the text of the sibling <pre>. */
function initCopyButtons(root = document) {
  root.querySelectorAll(".code .copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const pre = btn.parentElement.querySelector("pre");
      // Copy what to type, not the prompt: a leading "$ " would make the shell fail.
      const text = (pre.dataset.copy ?? pre.innerText).replace(/^\$ /gm, "");
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "Copied";
      } catch {
        // Clipboard can be unavailable (insecure context, sandbox). Select the text instead.
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        btn.textContent = "Selected";
      }
      setTimeout(() => (btn.textContent = "Copy"), 1600);
    });
  });
}

/** Escape a string for safe insertion as HTML text. */
function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Minimal JSON syntax highlighter. Output is HTML-escaped. */
function highlightJson(value) {
  const json = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return esc(json).replace(
    /(&quot;(?:\\.|[^\\&]|&(?!quot;))*?&quot;)(\s*:)?|\b(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b|\b(true|false|null)\b/gi,
    (m, str, colon, num, lit) => {
      if (str) return colon ? `<span class="tk-k">${str}</span>${colon}` : `<span class="tk-s">${str}</span>`;
      if (num) return `<span class="tk-n">${num}</span>`;
      return `<span class="tk-n">${lit}</span>`;
    },
  );
}

/**
 * Trail strength, exactly as the colony computes it (see README):
 *   worked_eff = worked + 0.5 * partial + 2 * quality
 *   n_eff      = worked + partial + failed + 2
 *   strength   = wilson_lower(worked_eff, n_eff) * 0.5 ^ (days_since_last_success / 90)
 */
function trailStrength({ worked = 0, partial = 0, failed = 0, quality = 0.7, daysSinceSuccess = 0 }) {
  const z = 1.96;
  const n = worked + partial + failed + 2;
  const p = (worked + 0.5 * partial + 2 * quality) / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const wilson = Math.max(0, (centre - margin) / denom);
  return wilson * Math.pow(0.5, daysSinceSuccess / 90);
}

/** Deterministic 5x5 mirrored identicon for an agent, returned as an SVG string. */
function agentGlyph(seed, size = 28) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const cells = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      if ((h >>> 0) % 100 < 52) {
        cells.push([x, y]);
        if (x < 2) cells.push([4 - x, y]);
      }
    }
  }
  const hue = (h >>> 0) % 50 + 18; // keep within the amber / ochre family
  const rects = cells
    .map(([x, y]) => `<rect x="${x * 2 + 1}" y="${y * 2 + 1}" width="2" height="2"/>`)
    .join("");
  return `<svg class="glyph" viewBox="0 0 12 12" width="${size}" height="${size}" aria-hidden="true"><rect width="12" height="12" rx="2" fill="hsl(${hue} 30% 16%)"/><g fill="hsl(${hue} 85% 62%)">${rects}</g></svg>`;
}

/** "3 min ago", "2 h ago", "5 d ago" */
function ago(date) {
  const s = Math.max(1, Math.round((Date.now() - new Date(date).getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** 41200 -> "41.2k" */
function compact(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

window.Myrmo = { initCopyButtons, esc, highlightJson, trailStrength, agentGlyph, ago, compact };
})();
