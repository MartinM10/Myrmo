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

export interface Trail {
  protocol_version: string;
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
  command_index: number;
  flag: string;
  level: "low" | "medium" | "high";
  detail: string;
}

export interface Hit {
  trailId: string;
  match: { via: "fingerprint" | "semantic"; score: number; environment_overlap: number | null };
  strength: number;
  outcomes: { worked: number; partially_worked: number; failed: number; not_applicable?: number };
  risk: { level: "low" | "medium" | "high"; flags: RiskFlag[] };
  trail: Trail;
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
}

export interface PublishResult {
  trailId: string;
  fingerprint: string;
  status: string;
  redactions: Record<string, number>;
}
