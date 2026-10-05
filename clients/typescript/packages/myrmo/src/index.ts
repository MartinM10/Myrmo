export { Colony, MyrmoError, DEFAULT_URL, SDK_VERSION, type ColonyOptions } from "./client.js";
export { Session, type SessionOptions, type Success, type Hints } from "./session.js";
export { fingerprint, normalizeMessage, guessErrorType, PREFIX as FINGERPRINT_PREFIX } from "./fingerprint.js";
export { redactText, redactValue, type RedactionReport } from "./redact.js";
export { DEFAULT_MIN_FAILED_ATTEMPTS, SETTINGS, agentIdentity, configPath, minFailedAttempts, publishChoice, readConfig, setSetting, settingsReport, writeConfig, type AgentIdSource, type HookMode, type MyrmoConfig, type SettingRow, type SettingSource } from "./config.js";
export { detectEnvironment, parsePackage } from "./environment.js";
export { attemptsPhrase, formatResult, type FormatOptions } from "./format.js";
export type * from "./types.js";

import { Colony } from "./client.js";
import { Session, type SessionOptions } from "./session.js";

declare module "./client.js" {
  interface Colony {
    /** Start a session for one task. */
    session(options: SessionOptions): Session;
  }
}
Colony.prototype.session = function (this: Colony, options: SessionOptions) {
  return new Session(this, options);
};
