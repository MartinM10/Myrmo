// Theme for the Myrmo website: light / dark switch shared with the docs.
// Loaded synchronously in <head> so the right theme paints on the first frame.
// The docs (VitePress) keep the choice under the same localStorage key, so picking a theme on
// either side carries over to the other: "dark", "light", or nothing / "auto" for the system theme.
(function () {
"use strict";
var KEY = "vitepress-theme-appearance";
var root = document.documentElement;
var SOIL = { dark: "#13100c", light: "#ebe8e1" };

root.classList.add("js");

function stored() {
  try { return localStorage.getItem(KEY); } catch (e) { return null; }
}
function systemDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
function effective() {
  var s = stored();
  return s === "dark" || s === "light" ? s : (systemDark() ? "dark" : "light");
}
function apply() {
  var s = stored();
  if (s === "dark" || s === "light") root.setAttribute("data-theme", s);
  else root.removeAttribute("data-theme");
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", SOIL[effective()]);
  window.dispatchEvent(new CustomEvent("myrmo-theme", { detail: effective() }));
}
apply();

var SUN = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
var MOON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

function build() {
  var tools = document.querySelector(".nav-tools");
  if (!tools) return;
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "theme-toggle";
  btn.setAttribute("role", "switch");
  btn.setAttribute("aria-label", "Dark theme");
  btn.innerHTML = '<span class="knob"><span class="ico ico-sun">' + SUN + '</span><span class="ico ico-moon">' + MOON + "</span></span>";
  var sep = document.createElement("span");
  sep.className = "nav-sep";
  sep.setAttribute("aria-hidden", "true");
  tools.prepend(sep);
  tools.prepend(btn);

  function sync() { btn.setAttribute("aria-checked", String(effective() === "dark")); }
  sync();
  btn.addEventListener("click", function () {
    var next = effective() === "dark" ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch (e) { /* private mode: still switch for this page */ }
    root.setAttribute("data-theme", next);
    apply();
    sync();
  });
  window.addEventListener("myrmo-theme", sync);
  // Another tab (or the docs) changed it.
  window.addEventListener("storage", function (e) { if (e.key === KEY) { apply(); sync(); } });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
    if (!stored() || stored() === "auto") { apply(); sync(); }
  });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
else build();
})();
