// Motion for the Myrmo website. No dependencies, classic script so file:// works.
// Everything degrades to the plain page: with reduced motion, or if this file never runs,
// content is simply visible. Pairs with the "second layer" in motion.css.
(function () {
"use strict";

var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
var $ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

/* ---------- Scroll progress and nav state ---------- */
(function progress() {
  var nav = document.querySelector(".nav");
  if (!nav) return;
  var bar = document.createElement("div");
  bar.className = "scroll-progress";
  bar.setAttribute("aria-hidden", "true");
  nav.appendChild(bar);
  var ticking = false;
  function update() {
    var max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.setProperty("--p", max > 0 ? Math.min(1, window.scrollY / max).toFixed(4) : 0);
    nav.classList.toggle("scrolled", window.scrollY > 8);
    ticking = false;
  }
  window.addEventListener("scroll", function () {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true });
  window.addEventListener("resize", update);
  update();
})();

/* ---------- Pointer spotlight on cards ---------- */
document.addEventListener("pointermove", function (e) {
  var card = e.target.closest && e.target.closest(".node, .plan, .chart-box, .calc, .trail-card");
  if (!card) return;
  var r = card.getBoundingClientRect();
  card.style.setProperty("--mx", (e.clientX - r.left) + "px");
  card.style.setProperty("--my", (e.clientY - r.top) + "px");
}, { passive: true });

/* ---------- Hero headline: split into words so they can rise one by one ---------- */
(function splitHeadline() {
  var h1 = document.querySelector(".hero h1");
  if (!h1) return;
  if (reduce) { h1.classList.add("split"); return; }
  var n = 0;
  (function walk(node) {
    Array.prototype.slice.call(node.childNodes).forEach(function (child) {
      if (child.nodeType === 3) {
        var frag = document.createDocumentFragment();
        child.textContent.split(/(\s+)/).forEach(function (part) {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(" ")); return; }
          var w = document.createElement("span");
          w.className = "w";
          var inner = document.createElement("span");
          inner.style.setProperty("--i", n++);
          inner.textContent = part;
          w.appendChild(inner);
          frag.appendChild(w);
        });
        node.replaceChild(frag, child);
      } else if (child.nodeType === 1 && child.tagName !== "BR") {
        walk(child);
      }
    });
  })(h1);
  h1.classList.add("split");
})();

/* ---------- Reveal on scroll ---------- */
var hasScrollTimeline = window.CSS && CSS.supports && CSS.supports("animation-timeline: view()");

// Elements that should be revealed when they enter view. Where the browser can scrub the reveal
// with the scroll position (motion.css), those selectors are skipped here; the rest are handled
// by an observer in every browser.
var REVEAL_ALWAYS = [".safeguards li", ".load-table tbody tr", ".ecosystem span"];
var REVEAL_FALLBACK = [".section-head", ".lifecycle li", ".agent-view > div", ".trust > *", ".scale-notes > div", ".plan", ".closing > *", ".bench-block"];
// Containers whose children are staggered by a CSS variable, flagged `.in` when seen.
var WATCH = [".section-head", ".lifecycle li", ".safeguards", ".flow", ".compare", ".closing"];

function stagger(sel) {
  $(sel).forEach(function (el, i) {
    var siblings = el.parentElement ? Array.prototype.indexOf.call(el.parentElement.children, el) : i;
    el.style.setProperty("--i", siblings);
  });
}

function observe(els, opts, cb) {
  if (!("IntersectionObserver" in window) || reduce) { els.forEach(function (el) { cb(el); }); return; }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      io.unobserve(entry.target);
      cb(entry.target);
    });
  }, opts);
  els.forEach(function (el) { io.observe(el); });
}

(function reveals() {
  var sels = REVEAL_ALWAYS.concat(hasScrollTimeline ? [] : REVEAL_FALLBACK);
  sels.forEach(function (sel) { stagger(sel); });
  var els = [];
  sels.forEach(function (sel) { els = els.concat($(sel)); });
  if (!reduce) els.forEach(function (el) { el.classList.add("rv"); });
  observe(els, { threshold: 0.15, rootMargin: "0px 0px -6% 0px" }, function (el) { el.classList.add("in"); });

  var watched = [];
  WATCH.forEach(function (sel) { watched = watched.concat($(sel)); });
  stagger(".ecosystem span");
  observe(watched, { threshold: 0.25 }, function (el) { el.classList.add("in"); });
})();

/* ---------- Typed-out streams: terminal transcript, then the JSON the agent receives ---------- */
(function streams() {
  var term = document.querySelector(".term pre");
  var json = document.getElementById("json-sample");
  if (!term || reduce || !("IntersectionObserver" in window)) return;

  // Wrap each line in a span (newlines stay in the text, so copying still works).
  function wrap(pre, stepMs, startMs, cap) {
    // Every span in these blocks opens and closes on one line, so splitting the HTML is safe.
    var html = pre.innerHTML.split("\n");
    pre.innerHTML = html.map(function (line, i) {
      var d = startMs + Math.min(i, cap) * stepMs;
      var last = i === html.length - 1 ? " last" : "";
      return '<span class="ln' + last + '" style="--d:' + d + '">' + line + "</span>";
    }).join("\n");
    pre.classList.add("stream", "armed");
    return startMs + Math.min(html.length, cap) * stepMs;
  }
  var termEnd = wrap(term, 230, 250, 60);
  if (json) wrap(json, 45, termEnd - 200, 60);

  var io = new IntersectionObserver(function (entries) {
    if (!entries[0].isIntersecting) return;
    io.disconnect();
    [term, json].forEach(function (pre) {
      if (!pre) return;
      pre.classList.remove("armed");
      pre.classList.add("play");
    });
  }, { threshold: 0.4 });
  io.observe(term);
})();

/* ---------- Request flow: a packet travels each lane ---------- */
(function flow() {
  var lanes = $(".flow .lane");
  if (!lanes.length) return;
  lanes.forEach(function (lane, r) {
    $(".node", lane).forEach(function (node, c) {
      node.style.setProperty("--c", c);
      node.style.setProperty("--r", r);
    });
    lane.style.setProperty("--r", r);
    var pkt = document.createElement("i");
    pkt.className = "pkt";
    pkt.setAttribute("aria-hidden", "true");
    lane.appendChild(pkt);
  });
  function measure() {
    lanes.forEach(function (lane) {
      var nodes = $(".node:not(.empty)", lane);
      if (nodes.length < 2) return;
      var base = lane.getBoundingClientRect().left;
      var a = nodes[0].getBoundingClientRect();
      var b = nodes[nodes.length - 1].getBoundingClientRect();
      var pkt = lane.querySelector(".pkt");
      pkt.style.setProperty("--x0", (a.left - base + a.width / 2) + "px");
      pkt.style.setProperty("--x1", (b.left - base + b.width / 2) + "px");
    });
  }
  measure();
  window.addEventListener("resize", measure);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
})();

/* ---------- Count-up numbers ---------- */
(function counters() {
  var els = $("[data-count]");
  if (!els.length || reduce) return;
  function run(el) {
    var target = parseFloat(el.dataset.count);
    var start = performance.now(), dur = 1400;
    (function frame(now) {
      var t = Math.min(1, (now - start) / dur);
      var eased = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(target * eased).toLocaleString("en-US");
      if (t < 1) requestAnimationFrame(frame);
    })(start);
  }
  observe(els, { threshold: 0.6 }, run);
})();
})();
