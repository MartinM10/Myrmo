import { test } from "node:test";
import assert from "node:assert/strict";
import { language, setLanguage, t } from "../dist/i18n.js";
import { render } from "../dist/doctor.js";
import { parseInvitation } from "../dist/join.js";

test("the language comes from MYRMO_LANG, then the locale variables, and is English by default", () => {
  assert.equal(language({ MYRMO_LANG: "es", LANG: "en_US.UTF-8" }), "es");
  assert.equal(language({ MYRMO_LANG: "EN", LANG: "es_ES.UTF-8" }), "en");
  assert.equal(language({ LANG: "es_ES.UTF-8" }), "es");
  assert.equal(language({ LC_ALL: "es_AR", LANG: "en_US" }), "es");
  assert.equal(language({ LC_ALL: "C.UTF-8", LANG: "es_MX.UTF-8" }), "es");
  assert.equal(language({ LANG: "en_GB.UTF-8" }), "en");
  assert.equal(language({ LANG: "eu_ES.UTF-8" }), "en", "Basque is not Spanish");
});

test("what a person reads is in Spanish when the language is Spanish, and back in English after", () => {
  try {
    setLanguage("es");
    assert.equal(t("Copy", "Copiar"), "Copiar");
    const out = render([{ level: "fail", name: "Agents", detail: "x", fix: "y" }]);
    assert.match(out, /^\[MAL \] Agents: x/);
    assert.match(out, /1 problema que arreglar/);
    assert.match(String(parseInvitation("not a link")), /no es un enlace de invitación/);
  } finally {
    setLanguage("en");
  }
  assert.match(render([]), /Everything is in place/);
});
