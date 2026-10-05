// A session wraps one task: it searches the colony on every new error, records failed
// approaches, and drafts a trail when the task finally succeeds after enough failures.

import type { Colony } from "./client.js";
import { minFailedAttempts } from "./config.js";
import { detectEnvironment, parsePackage } from "./environment.js";
import { formatResult } from "./format.js";
import { fingerprint, guessErrorType } from "./fingerprint.js";
import { redactText } from "./redact.js";
import type { CodePatch, Package, PublishResult, SearchResult, ShellCommand, Trail, Verification } from "./types.js";

export interface SessionOptions {
  task: string;
  runtime: string;
  runtimeVersion: string;
  packages?: (string | Package)[];
  agent?: { model: string; framework: string };
  /** Failed attempts before a fix is worth publishing. Default: MYRMO_MIN_FAILED_ATTEMPTS, the settings file, or 1. */
  minFailedAttempts?: number;
}

export interface Success {
  rootCause: string;
  steps: string[];
  verification: Verification;
  summary?: string;
  commands?: ShellCommand[];
  patches?: CodePatch[];
  tags?: string[];
  tokensSpent?: number;
}

export interface Hints {
  result: SearchResult;
  /** Ready to append to the model's context. */
  asPrompt(): string;
}

export class Session {
  private readonly started = Date.now();
  private readonly failures: { approach: string; why: string; errorType: string; message: string; logs: string }[] = [];
  private matchedExisting = false;
  /** Trails the agent followed that did not (fully) work: the fix that follows may be a better alternative. */
  private readonly triedFailed: { id: string; outcome: string; notes: string }[] = [];
  private solvedByTrail = false;

  constructor(
    private readonly colony: Colony,
    private readonly options: SessionOptions,
  ) {}

  get failedAttempts(): number {
    return this.failures.length;
  }

  /** Record a failed attempt and search the colony for the error. */
  async failed(error: unknown, approach = "previous attempt"): Promise<Hints> {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const errorLine = message.split("\n").find((l) => l.trim()) ?? message;
    const errorType = error instanceof Error ? error.name : guessErrorType(errorLine) || "Error";
    const logs = error instanceof Error && error.stack ? error.stack : message;
    this.failures.push({ approach, why: errorLine.slice(0, 500), errorType, message: errorLine, logs });
    const result = await this.colony.search({
      error: errorLine,
      errorType,
      runtime: this.options.runtime,
      runtimeVersion: this.options.runtimeVersion,
      packages: this.options.packages,
    });
    if (result.hits.length > 0) this.matchedExisting = true;
    return { result, asPrompt: () => formatResult(result) };
  }

  /**
   * Report what happened when the agent followed a trail. A trail that failed or only partly
   * worked is what makes a different fix worth publishing as an alternative, even though the
   * colony already had an answer for this error. A trail that worked means there is nothing new
   * to publish.
   */
  async tried(trailId: string, outcome: "worked" | "partially_worked" | "failed" | "not_applicable", notes = "") {
    const result = await this.colony.report(trailId, outcome, { notes, agentInfo: this.options.agent });
    if (outcome === "worked") this.solvedByTrail = true;
    if (outcome === "failed" || outcome === "partially_worked") this.triedFailed.push({ id: trailId, outcome, notes });
    return result;
  }

  /**
   * The task succeeded. Returns the drafted trail when it is worth publishing, and publishes
   * it when the colony's publish mode is `auto`. In `ask` mode the caller shows the draft
   * (see `colony.preview`) and calls `colony.publish` after approval.
   */
  async succeeded(success: Success): Promise<{ draft: Trail | null; published?: PublishResult }> {
    const min = minFailedAttempts(this.options.minFailedAttempts).value;
    const last = this.failures.at(-1);
    // Nothing new when an existing trail already solved it, or when one matched and was never tried.
    const covered = this.solvedByTrail || (this.matchedExisting && this.triedFailed.length === 0);
    if (!last || this.failures.length < min || covered || success.verification.type === "none") {
      return { draft: null };
    }
    const env = detectEnvironment();
    const draft: Trail = {
      protocol_version: "1.0",
      agent_info: this.options.agent ?? { model: "unknown", framework: "myrmo-js" },
      environment: {
        os: env.os ?? "other",
        arch: env.arch,
        container: env.container,
        runtime: { name: this.options.runtime, version: this.options.runtimeVersion },
        packages: (this.options.packages ?? []).map(parsePackage),
      },
      problem: {
        error_type: last.errorType.slice(0, 128),
        error_message: last.message.slice(0, 1000),
        summary: (success.summary ?? `${this.options.task}: ${last.message}`).slice(0, 1000).padEnd(20, "."),
        task_context: this.options.task.slice(0, 1000),
        raw_logs: last.logs.slice(0, 16_000),
        failed_approaches: [
          ...this.failures.slice(0, -1).map((f) => ({ approach: f.approach.slice(0, 500), why_it_failed: f.why.slice(0, 500) })),
          ...this.triedFailed.map((t) => ({
            approach: `Followed Myrmo trail ${t.id}`,
            why_it_failed: (t.notes || (t.outcome === "failed" ? "it did not work in this environment" : "it only partly worked")).slice(0, 500),
          })),
        ],
      },
      solution: {
        root_cause: success.rootCause,
        steps: success.steps,
        shell_commands_executed: success.commands ?? [],
        code_patches: success.patches ?? [],
        verification_method: success.verification,
      },
      effort: {
        failed_attempts: this.failures.length,
        wall_time_seconds: Math.round((Date.now() - this.started) / 1000),
        ...(success.tokensSpent ? { tokens_spent: success.tokensSpent } : {}),
      },
      ...(success.tags ? { tags: success.tags } : {}),
    };
    if (this.colony.publishMode === "auto") {
      return { draft, published: await this.colony.publish(draft) };
    }
    return { draft };
  }

  /**
   * Fingerprint of the most recent failure, if any. Computed over the redacted message, like the
   * one the colony computes for a published trail: an IP, an e-mail or a token in the message
   * would otherwise give a different fingerprint on the agent's side.
   */
  get lastFingerprint(): string | null {
    const last = this.failures.at(-1);
    return last ? fingerprint(this.options.runtime, last.errorType, redactText(last.message)) : null;
  }
}
