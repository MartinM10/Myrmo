// HTTP client for a Myrmo colony.
//
// Lookup order, cheapest first:
//   1. in-process cache (an agent stuck in a loop asks the same thing many times)
//   2. GET /v1/trails/by-fingerprint/{fp} (cacheable by any CDN; most traffic ends here)
//   3. POST /v1/search (embedding + vector search; only for errors the colony has not fingerprinted)

import { agentIdentity, publishChoice } from "./config.js";
import { detectEnvironment, parsePackage } from "./environment.js";
import { fingerprint, guessErrorType } from "./fingerprint.js";
import { redactText, redactValue, type RedactionReport } from "./redact.js";
import type { AgentInfo, DraftResult, DraftState, Environment, Hit, Outcome, PublishMode, PublishResult, SearchQuery, SearchResult, Trail } from "./types.js";

/** The public colony. Override with MYRMO_URL or the `url` option. */
export const DEFAULT_URL = "https://myrmo.dev";
export const SDK_VERSION = "0.3.0"; // x-release-please-version

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
}

export class MyrmoError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "MyrmoError";
  }
}

interface RawHit {
  trail_id: string;
  match: Hit["match"];
  strength: number;
  outcomes: Hit["outcomes"];
  risk: Hit["risk"];
  trail: Trail;
}

const toHit = (h: RawHit): Hit => ({
  trailId: h.trail_id,
  match: h.match,
  strength: h.strength,
  outcomes: h.outcomes,
  risk: h.risk,
  trail: h.trail,
});

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
  private readonly cache = new Map<string, { at: number; value: SearchResult | null }>();

  constructor(options: ColonyOptions = {}) {
    this.url = (options.url ?? env("MYRMO_URL") ?? DEFAULT_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? env("MYRMO_API_KEY");
    this.agentId = agentIdentity(options.agentId).id;
    const model = (options.model ?? env("MYRMO_AGENT_MODEL"))?.trim();
    this.model = model && model.toLowerCase() !== "unknown" ? model : undefined;
    const choice = publishChoice(options.publish);
    this.publishMode = choice.mode;
    this.publishSource = choice.source;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.headers = options.headers ?? {};
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
  }

  private async request<T>(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": `myrmo-js/${SDK_VERSION}`, ...this.headers };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    // A header the caller passed (a hosted server forwarding its users' ids) wins over this client's own.
    if (this.agentId && !Object.keys(headers).some((k) => k.toLowerCase() === "x-myrmo-agent")) headers["x-myrmo-agent"] = this.agentId;
    if (this.model && !Object.keys(headers).some((k) => k.toLowerCase() === "x-myrmo-model")) headers["x-myrmo-model"] = this.model;
    Object.assign(headers, extra);
    const res = await fetch(this.url + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = (await res.json().catch(() => null)) as T & { error?: { code: string; message: string; details?: unknown } };
    if (!res.ok && res.status !== 404) {
      const err = data?.error;
      throw new MyrmoError(res.status, err?.code ?? "http_error", err?.message ?? `HTTP ${res.status}`, err?.details);
    }
    return { status: res.status, data };
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
    const { status, data } = await this.request<{ fingerprint: string; results: RawHit[]; notice: string }>(
      "GET",
      `/v1/trails/by-fingerprint/${encodeURIComponent(fp)}`,
      undefined,
      model ? { "x-myrmo-model": model } : undefined,
    );
    const value = status === 404 ? null : { fingerprint: data.fingerprint, hits: data.results.map(toHit), notice: data.notice, source: "fingerprint" as const };
    this.remember(fp, value);
    return value;
  }

  /** Find trails for an error: fingerprint first, semantic search when there is no exact match. */
  async search(query: SearchQuery): Promise<SearchResult> {
    const error = redactText(query.error);
    const errorType = query.errorType ?? guessErrorType(error);
    const fp = fingerprint(query.runtime ?? "", errorType, error);

    const exact = await this.lookup(fp, query.model);
    if (exact && exact.hits.length > 0) return exact;

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
    }, query.model ? { "x-myrmo-model": query.model } : undefined);
    const value: SearchResult = { fingerprint: data.fingerprint, hits: data.results.map(toHit), notice: data.notice, source: "search" };
    this.remember(key, value);
    return value;
  }

  /** Tell the colony whether a trail worked. Failures matter as much as successes. */
  async report(
    trailId: string,
    outcome: Outcome,
    options: { notes?: string; agentInfo?: AgentInfo; environment?: Environment } = {},
  ): Promise<{ trailId: string; counted: boolean; strength: number }> {
    const env = { ...detectEnvironment(), ...options.environment };
    const body = redactValue({
      protocol_version: "1.0",
      outcome,
      agent_info: options.agentInfo ?? { model: "unknown", framework: "myrmo-js", sdk_version: SDK_VERSION },
      // The protocol requires os and a versioned runtime for an environment; omit it otherwise.
      ...(env.os && env.runtime?.version ? { environment: { packages: [], ...env } } : {}),
      ...(options.notes ? { notes: options.notes.slice(0, 1000) } : {}),
    });
    const { status, data } = await this.request<{ trail_id: string; counted: boolean; strength: number }>(
      "POST",
      `/v1/trails/${encodeURIComponent(trailId)}/outcomes`,
      body,
    );
    if (status === 404) throw new MyrmoError(404, "not_found", "No indexed trail with that id.");
    this.cache.clear();
    return { trailId: data.trail_id, counted: data.counted, strength: data.strength };
  }

  /** The trail exactly as it would be sent, with every redaction counted. Sends nothing. */
  preview(trail: Trail): { trail: Trail; redactions: RedactionReport } {
    const redactions: RedactionReport = {};
    return { trail: redactValue(trail, redactions), redactions };
  }

  /** Publish a trail. Redacts locally first; the colony redacts again. */
  async publish(trail: Trail): Promise<PublishResult> {
    const { trail: redacted, redactions } = this.preview(trail);
    const { data } = await this.request<{ trail_id: string; fingerprint: string; status: string; redactions: Record<string, number> }>(
      "POST",
      "/v1/trails",
      redacted,
    );
    const merged = { ...redactions };
    for (const [k, v] of Object.entries(data.redactions ?? {})) merged[k] = (merged[k] ?? 0) + v;
    return { trailId: data.trail_id, fingerprint: data.fingerprint, status: data.status, redactions: merged };
  }

  /**
   * Ask the colony to hold a trail until a person approves it in a browser. For clients that cannot
   * ask their user: nothing is published until the user opens `approveUrl` and chooses.
   */
  async createDraft(trail: Trail): Promise<DraftResult> {
    const { trail: redacted, redactions } = this.preview(trail);
    const { data } = await this.request<{
      draft_id: string;
      approve_url: string;
      expires_in: number;
      fingerprint: string;
      redactions: Record<string, number>;
      risk: DraftResult["risk"];
    }>("POST", "/v1/drafts", redacted);
    const merged = { ...redactions };
    for (const [k, v] of Object.entries(data.redactions ?? {})) merged[k] = (merged[k] ?? 0) + v;
    return { draftId: data.draft_id, approveUrl: data.approve_url, expiresIn: data.expires_in, fingerprint: data.fingerprint, redactions: merged, risk: data.risk };
  }

  /** State of a draft, or `null` when it does not exist or expired. */
  async draft(draftId: string): Promise<DraftState | null> {
    const { status, data } = await this.request<{
      state: DraftState["state"];
      expires_in?: number;
      trail_id?: string;
      trail_status?: string;
      reasons?: string[];
    }>("GET", `/v1/drafts/${encodeURIComponent(draftId)}`);
    if (status === 404) return null;
    return { draftId, state: data.state, expiresIn: data.expires_in, trailId: data.trail_id, trailStatus: data.trail_status, reasons: data.reasons };
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

  /** Status and content of one trail. */
  async trail(trailId: string): Promise<Record<string, unknown> | null> {
    const { status, data } = await this.request<Record<string, unknown>>("GET", `/v1/trails/${encodeURIComponent(trailId)}`);
    return status === 404 ? null : data;
  }
}
