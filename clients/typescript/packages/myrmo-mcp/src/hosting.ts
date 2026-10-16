// What the hosted server (`myrmo-mcp --http`) trusts. It answers whoever can reach its port, so it takes nothing from
// the machine it runs on that would let a caller act as someone else: no access key from the environment or the
// settings file (only the caller's own `Authorization: Bearer`), and no colony from the settings file. It listens on
// loopback unless told otherwise, and answers /mcp only for the Host names it is meant to serve, so that a web page
// cannot reach it through DNS rebinding.

/** The public colony, where the hosted server goes when MYRMO_URL names no other. */
const PUBLIC_COLONY = "https://myrmo.dev";

/** Where the hosted server listens without --host: this machine only. A container passes --host 0.0.0.0. */
export const DEFAULT_HTTP_HOST = "127.0.0.1";

/** The colony the hosted server talks to: MYRMO_URL, else the public one. Never the one saved in the settings file. */
export function hostedColonyUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.MYRMO_URL?.trim() || PUBLIC_COLONY;
}

/**
 * The access key for one request: the caller's Bearer token, or none. Never MYRMO_API_KEY nor a saved key, which belong
 * to whoever runs the server, not to whoever calls it. An empty string tells the SDK not to look for one elsewhere.
 */
export function callerKey(authorization: string | undefined): string {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  return m ? m[1] : "";
}

/**
 * The Host headers /mcp answers (DNS rebinding protection), or null for no check. MYRMO_MCP_ALLOWED_HOSTS is a
 * comma-separated list (`myrmo.dev`, `mcp.example.internal:8443`); `*` turns the check off, for a proxy that checks the
 * host itself. Unset: this machine's loopback names on the port it listens on.
 */
export function allowedHosts(port: number, value = process.env.MYRMO_MCP_ALLOWED_HOSTS): string[] | null {
  const listed = (value ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (listed.includes("*")) return null;
  if (listed.length) return listed;
  return ["localhost", "127.0.0.1", "[::1]"].flatMap((h) => [`${h}:${port}`, h]);
}
