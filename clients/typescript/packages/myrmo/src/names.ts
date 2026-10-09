// Names that fp2 erases, and whether two messages name different things.
//
// The fingerprint replaces paths, URLs and numbers by placeholders, so every `no required module provides package <module>`
// is one key whatever the module. An exact lookup can therefore answer with a trail about another package. The names tell
// them apart: a Go module path, the repository of a git URL, a registry package, a container image. Absolute paths, files and
// numbers are the machine's and are not names.
//
// A port of `placeholder_names` in server/src/relevance.rs; protocol/placeholder_names.v1.vectors.json is normative and the
// server and both SDKs must reproduce it exactly.

const FILE_EXTENSIONS = new Set(
  ("py js mjs cjs ts tsx jsx rs go java kt c h cc cpp hpp cs rb php json yaml yml toml lock xml csv txt md ini cfg conf sh log " +
    "html css sql whl gz zip tar so dll exe pem crt key").split(" "),
);
const SPLIT = /[\s'"`()[\]<>,;=]+/;
const PUNCTUATION = /[:./]+$/;

function nameOf(raw: string): string | null {
  let token = raw.toLowerCase();
  const scheme = token.indexOf("://");
  if (scheme !== -1) token = token.slice(scheme + 3);
  const cut = token.search(/[?#]/);
  if (cut !== -1) token = token.slice(0, cut);
  // user:password@host/path: the credentials are not part of the name.
  let at = token.indexOf("@");
  if (at !== -1) {
    const head = token.slice(0, at);
    const tail = token.slice(at + 1);
    if (head && !head.includes("/") && tail.includes("/")) token = tail;
  }
  // name@1.2.3: the version is not part of the name.
  at = token.lastIndexOf("@");
  if (at !== -1) {
    const head = token.slice(0, at);
    const tail = token.slice(at + 1);
    if (head.includes("/") && !tail.includes("/")) token = head;
  }
  token = token.replace(PUNCTUATION, "");
  if (token.endsWith(".git")) token = token.slice(0, -4).replace(PUNCTUATION, "");
  // An image tag, or a line and column (`main.rs:5:3`): a colon after the last slash ends the name.
  const slash = token.lastIndexOf("/");
  if (slash !== -1) {
    const colon = token.indexOf(":", slash);
    if (colon !== -1) token = token.slice(0, colon);
  }
  if (!token.includes("/") || !/^[a-z0-9]/.test(token)) return null;
  const segments = token.split("/");
  if (segments.length > 8 || segments.some((segment) => segment === "")) return null;
  const last = segments[segments.length - 1];
  if (last.includes(".") && FILE_EXTENSIONS.has(last.slice(last.lastIndexOf(".") + 1))) return null;
  const host = segments[0].split(":")[0];
  const tld = host.includes(".") ? host.slice(host.lastIndexOf(".") + 1) : "";
  const hostLike = host === "localhost" || (tld.length >= 2 && /^[a-z]+$/.test(tld));
  const pair = segments.length === 2 && !segments[0].includes(".");
  return (hostLike || pair) && /[a-z]/.test(token) ? token : null;
}

export function placeholderNames(text: string): Set<string> {
  const found = new Set<string>();
  for (const raw of text.split(SPLIT)) {
    if (!raw) continue;
    const name = nameOf(raw);
    if (name) found.add(name);
  }
  return found;
}

function shareAName(a: Set<string>, b: Set<string>): boolean {
  const lastOf = (s: string) => s.slice(s.lastIndexOf("/") + 1);
  for (const x of a) for (const y of b) if (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`) || lastOf(x) === lastOf(y)) return true;
  return false;
}

/** True when the query and the message both spell such names and share none: another package, so another error. */
export function namesConflict(query: string, message: string): boolean {
  const asked = placeholderNames(query);
  if (asked.size === 0) return false;
  const have = placeholderNames(message);
  return have.size > 0 && !shareAName(asked, have);
}
