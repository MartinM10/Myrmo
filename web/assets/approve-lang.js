// An agent hands out /approve.html#<draft>: a browser set to Spanish opens the same draft on the Spanish page, unless the
// person chose a language on this site.
(function () {
  try {
    var chosen = localStorage.getItem("myrmo.lang");
    if (document.documentElement.lang === "en" && (chosen === "es" || (!chosen && /^es\b/i.test(navigator.language || "")))) {
      location.replace("/es/approve.html" + location.hash);
    }
  } catch (e) { /* storage blocked: stay on this page */ }
})();
