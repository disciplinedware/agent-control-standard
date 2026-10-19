/**
 * The plugin's configuration, read from `plugins.entries.acs-guardian-client.config`.
 * `openclaw.plugin.json` declares the same shape, and OpenClaw refuses a
 * config that fails it before the plugin loads; this module checks it again
 * because a plugin cannot rely on its host having validated what it reads,
 * and it is where the key is loaded.
 */
import { readFileSync } from "node:fs";
import { DEFAULT_TIMEOUT_MS, type HkdfParameters, type SigningKey } from "./host-adapter.ts";

export type FailurePosture = "closed" | "negotiated";

export type PluginConfig = {
  guardianUrl: string;
  signingKey: SigningKey;
  failurePosture: FailurePosture;
  /** Bounds everything one hook sends to the Guardian, handshakes included. */
  deadlineMs: number;
  /** The timeout this plugin asks OpenClaw to give each of its hooks; longer than `deadlineMs`. */
  hookTimeoutMs: number;
  /** The most messages of one session kept for a run not yet admitted; a message beyond it is dropped. */
  maxUndecidedMessages: number;
  /** The `ask_details.approver.id` values this host puts to a person. */
  approvers: ReadonlySet<string>;
  /** What the user is sent in place of a reply, a message or a run that was blocked; when absent, nothing is sent in its place. */
  blockedReplyText?: string;
  auditLog: string;
};

/**
 * RFC 2104 §3: an HMAC key shorter than the hash output weakens it. The Go
 * reference Guardian refuses one shorter than SHA-256's 32 bytes.
 */
export const MIN_KEY_BYTES = 32;

const DEFAULTS = {
  failurePosture: "closed",
  // OpenClaw's own default for its modifying hooks (src/plugins/hooks.ts).
  hookTimeoutMs: 15_000,
  maxUndecidedMessages: 20,
  approvers: [] as string[],
  auditLog: ".acs/audit.jsonl",
} as const;

const KNOWN_KEYS = new Set([
  "guardianUrl",
  "keyId",
  "keyFile",
  "keyEnv",
  "hkdf",
  "failurePosture",
  "deadlineMs",
  "hookTimeoutMs",
  "maxUndecidedMessages",
  "approvers",
  "blockedReplyText",
  "auditLog",
]);

/** Every check `parseConfig` failed, in one message. */
export class PluginConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`ACS plugin config is invalid: ${problems.join("; ")}`);
    this.name = "PluginConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// The key is written as the Go Guardian's security.hmac_secret_file is:
// standard base64, surrounding whitespace ignored, so one file serves both.
function readSecret(raw: Record<string, unknown>, env: NodeJS.ProcessEnv, problems: string[]): Uint8Array | undefined {
  const encoded = readSecretText(raw, env, problems);
  if (encoded === undefined) {
    return undefined;
  }
  const text = encoded.trim();
  const secret = Buffer.from(text, "base64");
  if (secret.toString("base64") !== text) {
    problems.push("the key is not standard base64");
    return undefined;
  }
  if (secret.length < MIN_KEY_BYTES) {
    problems.push(`the key decodes to ${secret.length} bytes; it must hold at least ${MIN_KEY_BYTES}`);
    return undefined;
  }
  return secret;
}

function readSecretText(raw: Record<string, unknown>, env: NodeJS.ProcessEnv, problems: string[]): string | undefined {
  const hasFile = raw.keyFile !== undefined;
  const hasEnv = raw.keyEnv !== undefined;
  if (hasFile === hasEnv) {
    problems.push('name the key with exactly one of "keyFile" or "keyEnv"');
    return undefined;
  }
  if (hasFile) {
    if (!nonEmptyString(raw.keyFile)) {
      problems.push('"keyFile" must be a non-empty path');
      return undefined;
    }
    try {
      return readFileSync(raw.keyFile, "utf8");
    } catch (error) {
      problems.push(`"keyFile" ${JSON.stringify(raw.keyFile)} cannot be read: ${(error as Error).message}`);
      return undefined;
    }
  }
  if (!nonEmptyString(raw.keyEnv)) {
    problems.push('"keyEnv" must name an environment variable');
    return undefined;
  }
  const value = env[raw.keyEnv];
  if (!nonEmptyString(value)) {
    problems.push(`environment variable ${raw.keyEnv} named by "keyEnv" is unset or empty`);
    return undefined;
  }
  return value;
}

function readHkdf(raw: unknown, problems: string[]): HkdfParameters | undefined {
  if (!isRecord(raw)) {
    problems.push('"hkdf" is required: { salt, infoPrefix, sessionIdEncoding }, as the Guardian derives its session keys');
    return undefined;
  }
  const { salt, infoPrefix, sessionIdEncoding } = raw;
  const extra = Object.keys(raw).filter((key) => !["salt", "infoPrefix", "sessionIdEncoding"].includes(key));
  if (extra.length > 0) {
    problems.push(`"hkdf" has unknown keys ${extra.join(", ")}`);
  }
  if (typeof salt !== "string" || typeof infoPrefix !== "string") {
    problems.push('"hkdf.salt" and "hkdf.infoPrefix" must be strings; use "" for none');
  }
  if (sessionIdEncoding !== "utf8" && sessionIdEncoding !== "uuid-bytes") {
    problems.push('"hkdf.sessionIdEncoding" must be "utf8" or "uuid-bytes"');
  }
  if (problems.length > 0) {
    return undefined;
  }
  return { salt: salt as string, infoPrefix: infoPrefix as string, sessionIdEncoding: sessionIdEncoding as HkdfParameters["sessionIdEncoding"] };
}

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): PluginConfig {
  const problems: string[] = [];
  if (!isRecord(raw)) {
    throw new PluginConfigError(["the config is not an object"]);
  }
  const unknown = Object.keys(raw).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0) {
    problems.push(`unknown keys ${unknown.join(", ")}`);
  }

  if (!nonEmptyString(raw.guardianUrl) || !URL.canParse(raw.guardianUrl)) {
    problems.push('"guardianUrl" must be the Guardian\'s ACS endpoint URL');
  }
  if (!nonEmptyString(raw.keyId)) {
    problems.push('"keyId" is required: the key_id the Guardian knows this key by');
  }
  const secret = readSecret(raw, env, problems);
  const hkdfProblems: string[] = [];
  const hkdf = readHkdf(raw.hkdf, hkdfProblems);
  problems.push(...hkdfProblems);

  const failurePosture = raw.failurePosture ?? DEFAULTS.failurePosture;
  if (failurePosture !== "closed" && failurePosture !== "negotiated") {
    problems.push('"failurePosture" must be "closed" or "negotiated"');
  }
  const deadlineMs = raw.deadlineMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof deadlineMs !== "number" || !Number.isInteger(deadlineMs) || deadlineMs < 1) {
    problems.push('"deadlineMs" must be a positive integer');
  }
  const hookTimeoutMs = raw.hookTimeoutMs ?? DEFAULTS.hookTimeoutMs;
  if (typeof hookTimeoutMs !== "number" || !Number.isInteger(hookTimeoutMs) || hookTimeoutMs < 1) {
    problems.push('"hookTimeoutMs" must be a positive integer');
  } else if (typeof deadlineMs === "number" && deadlineMs >= hookTimeoutMs) {
    problems.push(`"deadlineMs" (${deadlineMs}) must be shorter than "hookTimeoutMs" (${hookTimeoutMs}), or OpenClaw ends a hook before the plugin answers`);
  }
  const maxUndecidedMessages = raw.maxUndecidedMessages ?? DEFAULTS.maxUndecidedMessages;
  if (typeof maxUndecidedMessages !== "number" || !Number.isInteger(maxUndecidedMessages) || maxUndecidedMessages < 1) {
    problems.push('"maxUndecidedMessages" must be a positive integer');
  }
  const approvers = raw.approvers ?? DEFAULTS.approvers;
  if (!Array.isArray(approvers) || !approvers.every(nonEmptyString)) {
    problems.push('"approvers" must be a list of approver ids');
  }
  const { blockedReplyText } = raw;
  if (blockedReplyText !== undefined && !nonEmptyString(blockedReplyText)) {
    problems.push('"blockedReplyText" must be a non-empty string when set');
  }
  const auditLog = raw.auditLog ?? DEFAULTS.auditLog;
  if (!nonEmptyString(auditLog)) {
    problems.push('"auditLog" must be a non-empty path');
  }

  if (problems.length > 0 || secret === undefined || hkdf === undefined) {
    throw new PluginConfigError(problems);
  }
  return {
    guardianUrl: raw.guardianUrl as string,
    signingKey: { keyId: raw.keyId as string, secret, hkdf },
    failurePosture: failurePosture as FailurePosture,
    deadlineMs: deadlineMs as number,
    hookTimeoutMs: hookTimeoutMs as number,
    maxUndecidedMessages: maxUndecidedMessages as number,
    approvers: new Set(approvers as string[]),
    ...(blockedReplyText === undefined ? {} : { blockedReplyText: blockedReplyText as string }),
    auditLog: auditLog as string,
  };
}
