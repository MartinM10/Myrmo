// Protocol and API shapes. Trail fields keep the protocol's snake_case so payloads can be
// sent as-is; SDK-level fields are camelCase.

export type Outcome = "worked" | "partially_worked" | "failed" | "not_applicable";
export type PublishMode = "off" | "ask" | "auto";

export interface AgentInfo {
  model: string;
  framework: string;
  framework_version?: string;
  agent_id?: string;
  sdk_version?: string;
}

export interface Package {
  name: string;
  version?: string;
  ecosystem?: string;
}

export interface Environment {
  os?: string;
  os_version?: string;
  arch?: string;
  container?: string;
  runtime?: { name: string; version?: string };
  packages?: Package[];
}

export interface ShellCommand {
  command: string;
  purpose: string;
  shell?: string;
  requires_elevation?: boolean;
  exit_code?: number;
}

export interface CodePatch {
  file_path: string;
  diff: string;
  language?: string;
  description?: string;
}

export interface Verification {
  type: "test_suite" | "command_exit_zero" | "rerun_task" | "http_check" | "build_success" | "manual_inspection" | "none";
  description: string;
  command?: string;
  evidence?: string;
}

/** Where knowledge came from, when an agent did not find it out itself. */
export interface Source {
  type: "agent" | "handover" | "document" | "person";
  ref?: string;
  revision?: string;
}

/**
 * A trail. Its `kind` says what it holds: a `fix` (the default; every field below is filled), a `procedure` or a
 * `fact` (private colonies only), which carry only `problem.summary` (what it is about), `problem.task_context` (when it
 * applies) and `solution.steps`, and whose other fields may be missing.
 */
export interface Trail {
  protocol_version: string;
  kind?: "fix" | "procedure" | "fact";
  source?: Source;
  /** `YYYY-MM-DD`: from this day a colony shows the entry as due for review. For knowledge about a state of a system. */
  review_after?: string;
  agent_info: AgentInfo;
  environment: Environment & { os: string; runtime: { name: string; version: string }; packages: Package[] };
  problem: {
    error_type: string;
    summary: string;
    raw_logs: string;
    error_message?: string;
    task_context?: string;
    category?: string;
    failed_approaches?: { approach: string; why_it_failed: string }[];
  };
  solution: {
    root_cause: string;
    steps: string[];
    shell_commands_executed: ShellCommand[];
    code_patches: CodePatch[];
    verification_method: Verification;
  };
  effort: { failed_attempts: number; tokens_spent?: number; wall_time_seconds?: number };
  tags?: string[];
}

export interface RiskFlag {
  /** Index in shell_commands_executed; -1 for a command written elsewhere (a step, the root cause, a patch...). */
  command_index: number;
  /** Protocol path where the command was found, such as `solution.steps[0]` (colonies from this version on). */
  field?: string;
  flag: string;
  level: "low" | "medium" | "high";
  detail: string;
}

/**
 * What an agent that followed a trail noted about its environment ("worked, but macOS needed --no-default-features").
 * The colony shows a note only from a report that counted, after redacting it and checking it as it checks a trail.
 */
export interface Caveat {
  outcome: "worked" | "partially_worked" | "failed";
  /** The reporter's environment, e.g. "macos 15.1 · arm64 · rust 1.82". */
  environment: string;
  note: string;
  at: string;
  /** Set when the note mentions a command of medium risk: ask the user before running it. */
  risk?: string;
}

export interface Hit {
  trailId: string;
  /** What the trail holds; older colonies do not say, which means a fix. */
  kind: "fix" | "procedure" | "fact";
  match: { via: "fingerprint" | "semantic" | "task"; score: number; environment_overlap: number | null };
  strength: number;
  /** `confirmed`: times a person confirmed in the panel that it still holds. */
  outcomes: { worked: number; partially_worked: number; failed: number; not_applicable?: number; confirmed?: number };
  risk: { level: "low" | "medium" | "high"; flags: RiskFlag[] };
  trail: Trail;
  /** When it last proved itself (a success or a confirmation), or when it was published. Older colonies send none. */
  lastConfirmedAt?: string;
  /** The day the entry's author asked for it to be re-checked (`review_after`), once that day has come. */
  reviewDue?: string;
  /** Newest first; older colonies send none. */
  caveats?: Caveat[];
  /** The trail this one was published to amend. */
  amends?: string;
  /** Trails published to amend this one. */
  amendedBy?: string[];
}

export interface SearchResult {
  fingerprint: string;
  hits: Hit[];
  notice: string;
  /** Where the answer came from: the local cache, the cacheable fingerprint endpoint, or semantic search. */
  source: "cache" | "fingerprint" | "search";
}

export interface SearchQuery {
  /** The error line, as printed. */
  error: string;
  errorType?: string;
  runtime?: string;
  runtimeVersion?: string;
  os?: string;
  arch?: string;
  /** `name@version` strings or package objects. */
  packages?: (string | Package)[];
  limit?: number;
  minStrength?: number;
  /** The model asking, for aggregate counters. Overrides the client's own `model` for this search. */
  model?: string;
}

/** A trail held by the colony until a person approves it in a browser. */
export interface DraftResult {
  draftId: string;
  /** Give this link to the user: they read the exact payload and publish or discard it. */
  approveUrl: string;
  expiresIn: number;
  fingerprint: string;
  redactions: Record<string, number>;
  risk: { level: "low" | "medium" | "high"; flags: RiskFlag[] };
  amends?: string;
}

export interface DraftState {
  draftId: string;
  state: "pending" | "published" | "discarded";
  /** Seconds left while pending. */
  expiresIn?: number;
  /** Once published: the trail, and what the colony decided about it. */
  trailId?: string;
  trailStatus?: string;
  reasons?: string[];
  /** For a rejected trail: what to fix, by reason (see `RejectionDetail`). */
  detail?: RejectionDetail;
}

/** What the colony tells a publisher about a rejection besides its reasons. Never carries the text that was flagged. */
export interface RejectionDetail {
  /** Where the colony found private data: protocol paths such as `problem.summary`. Can be empty. */
  sensitive_content?: { fields: string[]; hint: string };
  low_quality?: { hint: string };
}

export interface PublishResult {
  trailId: string;
  fingerprint: string;
  status: string;
  redactions: Record<string, number>;
  /** The trail this one amends, when the colony linked them (an older colony ignores the request and says nothing). */
  amends?: string;
}

/** What became of a report's note: shown to the next agents with the trail, withheld by the colony's checks, or not kept because the report did not count. */
export type NoteStatus = "shown_with_trail" | "withheld" | "not_counted";

export interface ReportResult {
  trailId: string;
  counted: boolean;
  strength: number;
  /** Absent when there was no note, or the colony is older than notes shown with trails. */
  note?: NoteStatus;
  /** Why a note was withheld: prompt_injection or high_risk_command. */
  noteReason?: string;
}

/** What the colony says about a trail it has not been asked to publish. */
export type Validation =
  | { valid: true; fingerprint: string; redactions: Record<string, number> }
  | { valid: false; errors: { path: string; message: string }[] }
  /** The colony could not say: unreachable, or an older one without the endpoint. Publishing then reports. */
  | { valid: null; reason: string };

/** What a colony is: `colony` in GET /v1/version (protocol 1.7). */
export interface ColonyInfo {
  profile: "public" | "organisation";
  keys_required?: boolean;
  kinds?: ("fix" | "procedure" | "fact")[];
  task_search?: boolean;
  effort?: boolean;
  people_detail?: "aggregate" | "named" | null;
  holdout_percent?: number;
}

/** What solving one problem cost, for POST /v1/effort (protocol 1.7). */
export interface EffortRecord {
  role: "unaided" | "aided";
  /** The error line the problem started with. */
  error: string;
  /** Required for aided: the trail that worked. */
  trail_id?: string;
  effort: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    turns?: number;
    wall_time_seconds?: number;
  };
  agent_info?: { model: string; framework: string };
}
