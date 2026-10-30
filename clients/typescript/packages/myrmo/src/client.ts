// HTTP client for a Myrmo colony.
//
// Lookup order, cheapest first:
//   1. in-process cache (an agent stuck in a loop asks the same thing many times)
//   2. GET /v1/trails/by-fingerprint/{fp} (cacheable by any CDN; most traffic ends here)
//   3. POST /v1/search (embedding + vector search; only for errors the colony has not fingerprinted)

import { agentIdentity, fileColony, publishChoice } from "./config.js";
import { detectEnvironment, parsePackage } from "./environment.js";
import { fingerprint2, guessErrorType } from "./fingerprint.js";
import { namesConflict } from "./names.js";
import { possibleNames, redactText, redactValue, type RedactionPolicy, type RedactionReport } from "./redact.js";
import type { AgentInfo, Caveat, ColonyInfo, DraftResult, EffortRecord, DraftState, Environment, Hit, NoteStatus, Outcome, PublishMode, PublishResult, ReportResult, SearchQuery, SearchResult, Trail, Validation } from "./types.js";

/** The public colony. Override with MYRMO_URL or the `url` option. */
export const DEFAULT_URL = "https://myrmo.dev";
export const SDK_VERSION = "0.19.0"; // x-release-please-version

export interface ColonyOptions {
  url?: string;
  apiKey?: string;
  /**
   * Pseudonymous id, 8–64 chars of [A-Za-z0-9_-]. By default one is created on first use and kept in
   * `~/.myrmo/config.json`; `false` sends none (a server that forwards its callers' own header).
   */
  agentId?: string | false;
  /** The model this client runs for; sent as X-Myrmo-Model for aggregate counters. Default: MYRMO_AGENT_MODEL. */
  model?: string;
  publish?: PublishMode;
  timeoutMs?: number;
  /** Extra headers on every request, e.g. X-Forwarded-For from a trusted proxy. */
  headers?: Record<string, string>;
  /** How long lookups stay in the in-process cache. 0 disables it. */
  cacheTtlMs?: number;
  /**
   * How many times a read (a lookup or a search) is tried again when the colony answers 502, 503 or 504 or
   * refuses the connection, which is what a restart looks like from outside. Default 3, 0 disables. Publishing and
   * reporting are never repeated.
   */
  retries?: number;
  /** Pause before each retry, in milliseconds, with a little jitter. Default 500, 1500, 3000. */
  retryDelaysMs?: number[];
  /**
   * The colony is an organisation's own (not the public one): addresses and host names of its network are kept in
   * what is sent, and procedures and facts may be published. Ignored for the public colony.
   */
  private?: boolean;
}

/** What a colony that is restarting or overloaded answers with. */
const UNAVAILABLE = new Set([502, 503, 504]);
/** The longest Retry-After a request waits out by itself, in seconds: the per-minute window is at most 60. */
const RATE_WAIT_MAX_S = 60;
const DEFAULT_RETRY_DELAYS_MS = [500, 1500, 3000];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MyrmoError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** Seconds the colony asked to wait (the Retry-After header), when it said. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "MyrmoError";
  }
}

interface RawHit {
  trail_id: string;
  kind?: Hit["kind"];
  match: Hit["match"];
  strength: number;
  outcomes: Hit["outcomes"];
  risk: Hit["risk"];
  trail: Trail;
  caveats?: Caveat[];
  amends?: string;
  amended_by?: string[];
  last_confirmed_at?: string;
  review_due?: string;
}

const toHit = (h: RawHit): Hit => ({
  trailId: h.trail_id,
  kind: h.kind ?? h.trail?.kind ?? "fix",
  match: h.match,
  strength: h.strength,
  outcomes: h.outcomes,
  risk: h.risk,
  trail: h.trail,
  ...(h.caveats?.length ? { caveats: h.caveats } : {}),
  ...(h.amends ? { amends: h.amends } : {}),
  ...(h.amended_by?.length ? { amendedBy: h.amended_by } : {}),
  ...(h.last_confirmed_at ? { lastConfirmedAt: h.last_confirmed_at } : {}),
  ...(h.review_due ? { reviewDue: h.review_due } : {}),
});

/** `?amends=<id>`: the link travels beside the trail, never in it, so the trail stays valid for any colony. */
const amendsQuery = (amends?: string) => (amends ? `?amends=${encodeURIComponent(amends)}` : "");

const env = (key: string) => (typeof process !== "undefined" ? process.env[key] : undefined);

export class Colony {
  readonly url: string;
  readonly publishMode: PublishMode;
  /** Where the publish mode came from. `default` means nobody has chosen yet, so nothing is published. */
  readonly publishSource: "option" | "env" | "file" | "default";
  private readonly apiKey?: string;
  private readonly agentId?: string;
  private readonly model?: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly cacheTtlMs: number;
  private readonly retries: number;
  private readonly retryDelaysMs: number[];
  private readonly cache = new Map<string, { at: number; value: SearchResult | null }>();
  /** An organisation's own colony: see `ColonyOptions.private`. */
  readonly isPrivate: boolean;

  constructor(options: ColonyOptions = {}) {
    // An explicit URL or MYRMO_URL first, then the colony in the settings file; its key only goes to its own URL.
    const named = options.url ?? env("MYRMO_URL")?.trim() ?? undefined;
    const fromFile = fileColony(named || undefined);
    this.url = (named || fromFile?.url || DEFAULT_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? env("MYRMO_API_KEY") ?? fileColony(this.url)?.api_key;
    this.agentId = agentIdentity(options.agentId).id;
    const model = (options.model ?? env("MYRMO_AGENT_MODEL"))?.trim();
    this.model = model && model.toLowerCase() !== "unknown" ? model : undefined;
    const choice = publishChoice(options.publish, this.url);
    this.publishMode = choice.mode;
    this.publishSource = choice.source;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.headers = options.headers ?? {};
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.retries = Math.max(0, options.retries ?? 3);
    this.retryDelaysMs = options.retryDelaysMs?.length ? options.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
    this.isPrivate = (options.private ?? false) && !/^https?:\/\/(www\.)?myrmo\.dev(\/|$)/i.test(this.url);
  }

  /** What this colony removes before anything is sent. */
  private get policy(): RedactionPolicy {
    return { keepNetwork: this.isPrivate };
  }

  /**
   * What the organisation already knows about a task: procedures, facts and fixes whose "when it applies" is close to
   * the request ("deploy a new tenant in dev"), in any language. Needs a colony with a task index (a private one);
   * an empty result means nobody wrote anything down about it yet.
   */
  async searchTask(task: string, options: { limit?: number; model?: string } = {}): Promise<SearchResult> {
    const query = redactText(task, {}, this.policy).slice(0, 2000);
    const key = `task:${query}`;
    const cached = this.cached(key);
    if (cached) return cached;
    let data: { results: RawHit[]; notice: string };
    try {
      ({ data } = await this.request<{ results: RawHit[]; notice: string }>(
        "POST",
        "/v1/search",
        { query, mode: "task", limit: options.limit ?? 3 },
        options.model ? { "x-myrmo-model": options.model } : undefined,
        true,
      ));
    } catch (err) {
      // A colony without a task index (the public one, or an older server) knows nothing by task: no answer.
      if (err instanceof MyrmoError && (err.code === "no_task_index" || err.status === 400)) {
        return { fingerprint: "", hits: [], notice: "This colony cannot be searched by task.", source: "search" };
      }
      throw err;
    }
    const value: SearchResult = { fingerprint: "", hits: (data.results ?? []).map(toHit), notice: data.notice, source: "search" };
    this.remember(key, value);
    return value;
  }

  /**
   * One call to the colony. `idempotent` says it may be repeated without harm (a lookup, a search, a check): only
   * those are tried again when the colony is briefly unavailable.
   */
  private async request<T>(method: string, path: string, body?: unknown, extra?: Record<string, string>, idempotent = false): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": `myrmo-js/${SDK_VERSION}`, ...this.headers };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    // A header the caller passed (a hosted server forwarding its users' ids) wins over this client's own.
    if (this.agentId && !Object.keys(headers).some((k) => k.toLowerCase() === "x-myrmo-agent")) headers["x-myrmo-agent"] = this.agentId;
    if (this.model && !Object.keys(headers).some((k) => k.toLowerCase() === "x-myrmo-model")) headers["x-myrmo-model"] = this.model;
    Object.assign(headers, extra);
    const attempts = idempotent ? this.retries + 1 : 1;
    const pause = (attempt: number) => sleep(this.retryDelaysMs[Math.min(attempt, this.retryDelaysMs.length - 1)] * (1 + Math.random() * 0.25));
    let limited = false;
    for (let attempt = 0; ; attempt++) {
      const last = attempt + 1 >= attempts;
      let res: Response;
      try {
        res = await fetch(this.url + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // A refused or reset connection is what a restart looks like. A timeout is not retried: a colony that
        // hangs will not answer faster the second time, and the caller would wait several times as long.
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        if (!timedOut && !last) {
          await pause(attempt);
          continue;
        }
        throw err;
      }
      if (UNAVAILABLE.has(res.status) && !last) {
        await pause(attempt);
        continue;
      }
      const data = (await res.json().catch(() => null)) as T & { error?: { code: string; message: string; details?: unknown } };
      // Over the per-minute limit, the colony refused the request before doing anything, so it is safe to repeat
      // (a publish too) once the window it names has passed. Waited once and only for a short window.
      const wait = Number(res.headers.get("retry-after"));
      if (res.status === 429 && data?.error?.code === "rate_limited" && this.retries > 0 && !limited && Number.isFinite(wait) && wait > 0 && wait <= RATE_WAIT_MAX_S) {
        limited = true;
        await sleep(wait * 1000 + Math.random() * 500);
        continue;
      }
      if (UNAVAILABLE.has(res.status)) {
        throw new MyrmoError(res.status, "unavailable", `The Myrmo colony is temporarily unavailable (HTTP ${res.status}). It is probably restarting: try again in a few seconds.`);
      }
      if (!res.ok && res.status !== 404) {
        const err = data?.error;
        const retryAfter = Number(res.headers.get("retry-after"));
        throw new MyrmoError(res.status, err?.code ?? "http_error", err?.message ?? `HTTP ${res.status}`, err?.details, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
      }
      return { status: res.status, data };
    }
  }

  private cached(key: string): SearchResult | null | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.cacheTtlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value ? { ...entry.value, source: "cache" } : null;
  }

  private remember(key: string, value: SearchResult | null) {
    if (this.cacheTtlMs <= 0) return;
    if (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, { at: Date.now(), value });
  }

  /** Trails for a fingerprint, or `null` when the colony has none. */
  async lookup(fp: string, model?: string): Promise<SearchResult | null> {
    const hit = this.cached(fp);
    if (hit !== undefined) return hit;
    let found: { status: number; data: { fingerprint: string; results: RawHit[]; notice: string } } | null;
    try {
      found = await this.request<{ fingerprint: string; results: RawHit[]; notice: string }>(
        "GET",
        `/v1/trails/by-fingerprint/${encodeURIComponent(fp)}`,
        undefined,
        model ? { "x-myrmo-model": model } : undefined,
        true,
      );
    } catch (err) {
      // 400: a colony that predates fp2 does not know the key. Nothing exact to offer; the search that follows still finds the trail.
      if (err instanceof MyrmoError && err.status === 400) found = null;
      else throw err;
    }
    const value = found === null || found.status === 404 ? null : { fingerprint: found.data.fingerprint, hits: found.data.results.map(toHit), notice: found.data.notice, source: "fingerprint" as const };
    this.remember(fp, value);
    return value;
  }

  /** Find trails for an error: fingerprint first, semantic search when there is no exact match. */
  async search(query: SearchQuery): Promise<SearchResult> {
    const error = redactText(query.error, {}, this.policy);
    const errorType = query.errorType ?? guessErrorType(error);
    const fp = fingerprint2(error);

    // fp2 erases the module path, image or repository an error names: an exact hit about another one is no answer.
    const found = await this.lookup(fp, query.model);
    const kept = found?.hits.filter((hit) => !namesConflict(error, String(hit.trail?.problem?.error_message ?? ""))) ?? [];
    const exact = found && kept.length > 0 ? (kept.length === found.hits.length ? found : { ...found, hits: kept }) : null;
    if (exact) return exact;

    const environment: Environment = {
      ...detectEnvironment(),
      ...(query.os ? { os: query.os } : {}),
      ...(query.arch ? { arch: query.arch } : {}),
      ...(query.runtime ? { runtime: { name: query.runtime, ...(query.runtimeVersion ? { version: query.runtimeVersion } : {}) } } : {}),
      ...(query.packages ? { packages: query.packages.map(parsePackage) } : {}),
    };
    const key = `search:${fp}:${JSON.stringify(environment)}`;
    const cached = this.cached(key);
    if (cached) return cached;
    const { data } = await this.request<{ fingerprint: string; results: RawHit[]; notice: string }>("POST", "/v1/search", {
      query: error,
      ...(errorType ? { error_type: errorType } : {}),
      environment,
      limit: query.limit ?? 3,
      min_strength: query.minStrength ?? 0,
    }, query.model ? { "x-myrmo-model": query.model } : undefined, true);
    const value: SearchResult = { fingerprint: data.fingerprint, hits: data.results.map(toHit), notice: data.notice, source: "search" };
    this.remember(key, value);
    return value;
  }

  /** Tell the colony whether a trail worked. Failures matter as much as successes. */
  async report(
    trailId: string,
    outcome: Outcome,
    options: { notes?: string; agentInfo?: AgentInfo; environment?: Environment } = {},
  ): Promise<ReportResult> {
    const env = { ...detectEnvironment(), ...options.environment };
    // A note can be shown to the next agents with the trail, so it is redacted exactly as a trail is.
    const body = redactValue({
      protocol_version: "1.0",
      outcome,
      agent_info: options.agentInfo ?? { model: "unknown", framework: "myrmo-js", sdk_version: SDK_VERSION },
      // The protocol requires os and a versioned runtime for an environment; omit it otherwise.
      ...(env.os && env.runtime?.version ? { environment: { packages: [], ...env } } : {}),
      ...(options.notes ? { notes: options.notes.slice(0, 1000) } : {}),
    }, {}, this.policy);
    const { status, data } = await this.request<{ trail_id: string; counted: boolean; strength: number; note?: NoteStatus; note_reason?: string }>(
      "POST",
      `/v1/trails/${encodeURIComponent(trailId)}/outcomes`,
      body,
    );
    if (status === 404) throw new MyrmoError(404, "not_found", "No indexed trail with that id.");
    this.cache.clear();
    return {
      trailId: data.trail_id,
      counted: data.counted,
      strength: data.strength,
      ...(data.note ? { note: data.note } : {}),
      ...(data.note_reason ? { noteReason: data.note_reason } : {}),
    };
  }

  /**
   * The trail exactly as it would be sent, with every redaction counted. Sends nothing. `names` lists runs of
   * capitalised words that could be an organisation, customer, person or project: not redacted, to be checked by
   * whoever approves.
   */
  preview(trail: Trail): { trail: Trail; redactions: RedactionReport; names: string[] } {
    const redactions: RedactionReport = {};
    const redacted = redactValue(trail, redactions, this.policy);
    return { trail: redacted, redactions, names: possibleNames(redacted) };
  }

  /**
   * Ask the colony whether it would accept this trail, without publishing it: the schema check publishing
   * runs first. Nothing is stored and no publishing quota is used. A person who approves a preview should
   * be approving something the colony will take.
   */
  async validate(trail: Trail): Promise<Validation> {
    const { trail: redacted } = this.preview(trail);
    try {
      const { status, data } = await this.request<{ valid: boolean; fingerprint: string; redactions: Record<string, number> }>("POST", "/v1/validate", redacted, undefined, true);
      if (status === 404) return { valid: null, reason: "this colony does not offer validation" };
      return { valid: true, fingerprint: data.fingerprint, redactions: data.redactions ?? {} };
    } catch (err) {
      if (err instanceof MyrmoError && err.code === "invalid_trail") {
        const errors = Array.isArray(err.details) ? (err.details as { path?: string; message?: string }[]).map((d) => ({ path: String(d.path ?? ""), message: String(d.message ?? "") })) : [];
        return { valid: false, errors };
      }
      return { valid: null, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Take back a trail this client published (the colony recognises the author by the agent id or the access key it was
   * published with). It leaves search and lookups at once. To replace it with a correct one, publish that with
   * `amends` instead: the old one is then kept and linked, and no longer an answer.
   */
  async withdraw(trailId: string, reason = ""): Promise<{ trailId: string; status: string }> {
    const { status, data } = await this.request<{ trail_id: string; status: string; error?: { code: string; message: string } }>(
      "DELETE",
      `/v1/trails/${encodeURIComponent(trailId)}`,
      reason ? { reason: reason.slice(0, 200) } : undefined,
    );
    if (status === 404) throw new MyrmoError(404, "not_found", "No trail with that id.");
    this.cache.clear();
    return { trailId: data.trail_id, status: data.status };
  }

  /**
   * Publish a trail. Redacts locally first; the colony redacts again. `amends` names a trail this one succeeds (it was
   * outdated, or only worked in part): the colony links them and finds this one by the older trail's error too.
   */
  async publish(trail: Trail, options: { amends?: string } = {}): Promise<PublishResult> {
    const { trail: redacted, redactions } = this.preview(trail);
    const { data } = await this.request<{ trail_id: string; fingerprint: string; status: string; redactions: Record<string, number>; amends?: string }>(
      "POST",
      `/v1/trails${amendsQuery(options.amends)}`,
      redacted,
    );
    const merged = { ...redactions };
    for (const [k, v] of Object.entries(data.redactions ?? {})) merged[k] = (merged[k] ?? 0) + v;
    return { trailId: data.trail_id, fingerprint: data.fingerprint, status: data.status, redactions: merged, ...(data.amends ? { amends: data.amends } : {}) };
  }

  /**
   * Ask the colony to hold a trail until a person approves it in a browser. For clients that cannot
   * ask their user: nothing is published until the user opens `approveUrl` and chooses.
   */
  async createDraft(trail: Trail, options: { amends?: string } = {}): Promise<DraftResult> {
    const { trail: redacted, redactions } = this.preview(trail);
    const { data } = await this.request<{
      draft_id: string;
      approve_url: string;
      expires_in: number;
      fingerprint: string;
      redactions: Record<string, number>;
      risk: DraftResult["risk"];
      amends?: string;
    }>("POST", `/v1/drafts${amendsQuery(options.amends)}`, redacted);
    const merged = { ...redactions };
    for (const [k, v] of Object.entries(data.redactions ?? {})) merged[k] = (merged[k] ?? 0) + v;
    return { draftId: data.draft_id, approveUrl: data.approve_url, expiresIn: data.expires_in, fingerprint: data.fingerprint, redactions: merged, risk: data.risk, ...(data.amends ? { amends: data.amends } : {}) };
  }

  /** State of a draft, or `null` when it does not exist or expired. */
  async draft(draftId: string): Promise<DraftState | null> {
    const { status, data } = await this.request<{
      state: DraftState["state"];
      expires_in?: number;
      trail_id?: string;
      trail_status?: string;
      reasons?: string[];
      detail?: DraftState["detail"];
    }>("GET", `/v1/drafts/${encodeURIComponent(draftId)}`);
    if (status === 404) return null;
    return { draftId, state: data.state, expiresIn: data.expires_in, trailId: data.trail_id, trailStatus: data.trail_status, reasons: data.reasons, detail: data.detail };
  }

  /**
   * Publishing returns while the colony still checks the trail. Wait for its verdict: `indexed`,
   * `merged` or `rejected` (with `reasons`). Returns the last state seen after `timeoutMs`.
   */
  async waitForTrail(trailId: string, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<Record<string, unknown> | null> {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    for (;;) {
      const trail = await this.trail(trailId);
      if (!trail || trail.status !== "queued" || Date.now() >= deadline) return trail;
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1500));
    }
  }

  /**
   * What this colony is (protocol 1.7, `colony` in GET /v1/version): its profile (`organisation` or `public`), whether
   * it requires keys, takes procedures and facts, answers task requests and collects effort, and what it keeps about the
   * people it serves. `null` for a colony older than 1.7.
   */
  async colonyInfo(): Promise<ColonyInfo | null> {
    const { data } = await this.request<{ colony?: ColonyInfo }>("GET", "/v1/version", undefined, undefined, true);
    return data?.colony ?? null;
  }

  /**
   * Tell an organisation's colony what solving a problem cost, measured from your own usage records (never estimated):
   * `unaided` when no trail was used, `aided` with the trail that worked. Returns whether the colony stored it; a colony
   * that does not collect effort answers 404, which is returned as false.
   */
  async reportEffort(record: EffortRecord): Promise<boolean> {
    const body = { protocol_version: "1.7", ...record, error: redactText(record.error, {}, this.policy).slice(0, 2000) };
    try {
      const { status } = await this.request<{ stored?: boolean }>("POST", "/v1/effort", body);
      return status === 202;
    } catch {
      return false;
    }
  }

  /** Status and content of one trail. */
  async trail(trailId: string): Promise<Record<string, unknown> | null> {
    const { status, data } = await this.request<Record<string, unknown>>("GET", `/v1/trails/${encodeURIComponent(trailId)}`, undefined, undefined, true);
    return status === 404 ? null : data;
  }

  /** One page of the colony's trails, most recently active first: `{ items, next_cursor }` (`GET /v1/feed`). */
  async feed(options: { limit?: number; cursor?: string } = {}): Promise<{ items: Record<string, unknown>[]; next_cursor?: string | null }> {
    const query = new URLSearchParams({ limit: String(Math.min(50, Math.max(1, options.limit ?? 50))) });
    if (options.cursor) query.set("cursor", options.cursor);
    const { data } = await this.request<{ items?: Record<string, unknown>[]; next_cursor?: string | null }>("GET", `/v1/feed?${query}`, undefined, undefined, true);
    return { items: Array.isArray(data?.items) ? data.items : [], next_cursor: data?.next_cursor ?? null };
  }

  /** Every trail of the colony, page by page (an export or a backup of what the team learned). */
  async *allTrails(): AsyncGenerator<Record<string, unknown>> {
    let cursor: string | undefined;
    do {
      const page = await this.feed({ cursor });
      yield* page.items;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }
}
