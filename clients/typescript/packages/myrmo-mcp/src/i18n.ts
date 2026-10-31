// The language of what the commands print for a person (init, join, doctor, config, export): Spanish when MYRMO_LANG
// says so or the system's language is Spanish, English otherwise. What the server tells the agent stays English.

export type Lang = "en" | "es";

export function language(env: NodeJS.ProcessEnv = process.env): Lang {
  const explicit = env.MYRMO_LANG?.trim().toLowerCase();
  if (explicit === "es" || explicit === "en") return explicit;
  // The first locale variable that names a language decides; C and POSIX name none.
  for (const value of [env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    if (!value || /^(C|POSIX)([._@]|$)/i.test(value)) continue;
    return /^es([_.\-@]|$)/i.test(value) ? "es" : "en";
  }
  try {
    return /^es\b/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? "es" : "en";
  } catch {
    return "en";
  }
}

let current: Lang = language();

/** The text in the person's language. */
export function t(en: string, es: string): string {
  return current === "es" ? es : en;
}

/** For tests and for `--lang`: print in this language from now on. */
export function setLanguage(lang: Lang): void {
  current = lang;
}
