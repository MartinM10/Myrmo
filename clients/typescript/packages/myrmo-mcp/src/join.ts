// `myrmo-mcp join <invitation link>`: join a colony with an invitation and set this machine's agents up for it, in one
// step. The colony gives the person their own access key in exchange for the invitation (POST /v1/join); the rest is
// `init --url <colony> --key <key>`.
//
// An invitation link is `<colony address>/join#myi_...`: the invitation travels after `#`, so a browser that opens the
// link never sends it to any server, and it stays out of proxies' logs.

const INVITE = /^myi_[0-9a-f]{64}$/;
const HANDLE = /^[a-z0-9._-]{2,32}$/;

export interface Invitation {
  url: string; // the colony's address, without a trailing slash
  invite: string;
}

/** The colony and the invitation of a link, or why it is not one. Also takes the address and the invitation apart. */
export function parseInvitation(link: string, invite?: string): Invitation | string {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return `${JSON.stringify(link)} is not an invitation link (it looks like https://cloud.myrmo.dev/c/<colony>/join#myi_...)`;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "an invitation link starts with https:// (or http:// inside a team's network)";
  const code = (invite ?? decodeURIComponent(u.hash.replace(/^#/, ""))).trim();
  if (!INVITE.test(code)) return "the link has no invitation after '#': copy the whole link you were sent";
  const path = u.pathname.replace(/\/+$/, "").replace(/\/join$/, "");
  return { url: `${u.origin}${path}`, invite: code };
}

/** A handle the colony accepts, from the name of this machine's user (`Ana García` -> `ana-garcia`), or null. */
export function handleFrom(name: string | undefined): string | null {
  const handle = (name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 32);
  return HANDLE.test(handle) ? handle : null;
}

export interface Joined {
  key: string;
  name: string;
}

/** Exchanges the invitation for this person's access key. The error is a sentence for the person. */
export async function exchange(inv: Invitation, name: string, fetcher: typeof fetch = fetch): Promise<Joined | string> {
  if (!HANDLE.test(name)) return "the name must be 2 to 32 lowercase letters, digits, '.', '-' or '_' (a handle, not an e-mail address)";
  let res: Response;
  try {
    res = await fetcher(`${inv.url}/v1/join`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ invite: inv.invite, name }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return `no answer from ${inv.url} (wrong address, or not reachable from this network)`;
  }
  const body = (await res.json().catch(() => null)) as { key?: string; error?: { code?: string; message?: string } } | null;
  if (res.status === 201 && body?.key?.startsWith("myk_")) return { key: body.key, name };
  if (res.status === 409) return `someone in this colony already uses the name "${name}": run it again with --name <another>`;
  if (res.status === 401) return "this invitation is not valid any more (expired, used up or revoked): ask for a new one";
  if (res.status === 429) return "too many attempts from this network: try again in an hour";
  if (res.status === 403) return body?.error?.message ?? "this network is not allowed to reach the colony";
  return body?.error?.message ?? `the colony answered ${res.status}`;
}

export const JOIN_USAGE = `myrmo-mcp join <invitation link> [options]: join a colony and set this machine's agents up for it.

  <invitation link>        the link you were sent (https://.../join#myi_...); "-" reads it from standard input,
                           which keeps it out of the shell's history
  --name <handle>          how the colony knows you (default: your user name, if it makes a valid handle)
  --client <id>[,<id>]     only these agent clients (as in init)
  --publish auto|ask|off   how your agents publish to the colony (default: auto)
  --dry-run                say what would happen, join nothing and change nothing

Your key is created once and saved on this machine; nobody else sees it.`;
