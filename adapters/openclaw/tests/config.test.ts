import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../acs-plugin.ts";
import { parseConfig, PluginConfigError } from "../config.ts";
import { VERIFIED_OPENCLAW_VERSION } from "../requirements.ts";
import { memoryPluginState } from "./memory-plugin-state.ts";

const HKDF = { salt: "", infoPrefix: "", sessionIdEncoding: "utf8" } as const;
const KEY = Buffer.from("0123456789abcdef0123456789abcdef");
const ENV = { ACS_KEY: KEY.toString("base64") };
const VALID = { guardianUrl: "http://127.0.0.1:8787/acs", keyId: "example-key", keyEnv: "ACS_KEY", hkdf: HKDF };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    for (const entry of readdirSync(dir)) {
      unlinkSync(join(dir, entry));
    }
    rmdirSync(dir);
  }
});

function problemsOf(raw: unknown, env: NodeJS.ProcessEnv = ENV): string[] {
  try {
    parseConfig(raw, env);
  } catch (error) {
    if (error instanceof PluginConfigError) {
      return error.problems;
    }
    throw error;
  }
  return [];
}

describe("parseConfig", () => {
  it("fills the defaults", () => {
    const config = parseConfig(VALID, ENV);
    expect(config).toMatchObject({
      guardianUrl: VALID.guardianUrl,
      failurePosture: "closed",
      deadlineMs: 5000,
      auditLog: ".acs/audit.jsonl",
    });
    expect(config).not.toHaveProperty("blockedReplyText");
    expect([...config.approvers]).toEqual([]);
    expect(config.signingKey).toEqual({ keyId: "example-key", secret: KEY, hkdf: HKDF });
  });

  it("decodes a key file as the Go Guardian does: base64, a trailing newline ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-openclaw-"));
    dirs.push(dir);
    const keyFile = join(dir, "hmac-secret");
    writeFileSync(keyFile, `${KEY.toString("base64")}\n`);
    const { keyEnv: _unused, ...withoutEnv } = VALID;
    const config = parseConfig({ ...withoutEnv, keyFile }, {});
    expect(Buffer.from(config.signingKey.secret)).toEqual(KEY);
  });

  it.each<[string, Record<string, unknown>, NodeJS.ProcessEnv, string]>([
    ["no_key_id", { ...VALID, keyId: undefined }, ENV, '"keyId" is required'],
    ["both_key_sources", { ...VALID, keyFile: "/tmp/key" }, ENV, "exactly one"],
    ["no_key_source", { ...VALID, keyEnv: undefined }, ENV, "exactly one"],
    ["an_unset_key_env", VALID, {}, "unset or empty"],
    ["an_unreadable_key_file", { ...VALID, keyEnv: undefined, keyFile: "/nonexistent/acs-key" }, ENV, "cannot be read"],
    ["no_hkdf", { ...VALID, hkdf: undefined }, ENV, '"hkdf" is required'],
    ["an_unknown_encoding", { ...VALID, hkdf: { ...HKDF, sessionIdEncoding: "hex" } }, ENV, "sessionIdEncoding"],
    ["an_unknown_key", { ...VALID, roles: ["owner"] }, ENV, "unknown keys roles"],
    ["an_unknown_posture", { ...VALID, failurePosture: "open" }, ENV, "failurePosture"],
    ["a_bad_url", { ...VALID, guardianUrl: "not a url" }, ENV, "guardianUrl"],
    ["a_zero_deadline", { ...VALID, deadlineMs: 0 }, ENV, "deadlineMs"],
    ["a_deadline_as_long_as_the_hook_timeout", { ...VALID, deadlineMs: 15_000 }, ENV, "shorter than"],
    ["a_deadline_longer_than_a_set_hook_timeout", { ...VALID, deadlineMs: 6000, hookTimeoutMs: 5000 }, ENV, "shorter than"],
    ["a_zero_undecided_cap", { ...VALID, maxUndecidedMessages: 0 }, ENV, "maxUndecidedMessages"],
    ["an_empty_blocked_reply_text", { ...VALID, blockedReplyText: "" }, ENV, "blockedReplyText"],
    // The Go Guardian refuses a key shorter than SHA-256's 32 bytes (RFC 2104 §3).
    ["a_key_shorter_than_32_bytes", VALID, { ACS_KEY: KEY.subarray(1).toString("base64") }, "at least 32"],
    ["a_key_not_in_base64", VALID, { ACS_KEY: "0123456789abcdef0123456789abcdef!" }, "not standard base64"],
  ])("refuses %s", (_name, raw, env, problem) => {
    expect(problemsOf(raw, env).join("; ")).toContain(problem);
  });
});

describe("the plugin entry", () => {
  type Registered = { name: string; handler: (...args: unknown[]) => unknown; priority?: number; timeoutMs?: number };

  /** OpenClaw's retained plugin state, kept in a map. */
  const STATE = memoryPluginState();

  /** An OpenClaw config that meets every requirement checked at registration. */
  const ENABLED = {
    current: () => ({
      plugins: { entries: { "acs-guardian-client": { enabled: true, hooks: { allowConversationAccess: true } } } },
      acp: { enabled: false },
      agents: { defaults: { model: "openai/gpt-6-astra", models: { "openai/gpt-6-astra": { agentRuntime: { id: "openclaw" } } } } },
    }),
  };

  function register(
    pluginConfig: Record<string, unknown>,
    runtime: Record<string, unknown> = { state: STATE, config: ENABLED, version: VERIFIED_OPENCLAW_VERSION },
    hasMiddleware = true,
    hasRunStateStore = true,
  ): { registered: Registered[]; middleware: Array<{ runtimes: string[] }>; errors: string[] } {
    const registered: Registered[] = [];
    const middleware: Array<{ runtimes: string[] }> = [];
    const errors: string[] = [];
    const hostRuntime = { ...runtime };
    if (!hasRunStateStore) delete hostRuntime.state;
    plugin.register({
      pluginConfig,
      runtime: hostRuntime as never,
      logger: { error: (message: string) => errors.push(message) },
      on: (name: string, handler: (...args: never[]) => unknown, options?: { priority?: number; timeoutMs?: number }) => {
        registered.push({ name, handler: handler as (...args: unknown[]) => unknown, priority: options?.priority, timeoutMs: options?.timeoutMs });
      },
      ...(hasMiddleware ? { registerAgentToolResultMiddleware: (_handler: unknown, options: { runtimes: string[] }) => middleware.push(options) } : {}),
    });
    return { registered, middleware, errors };
  }

  it("registers its hooks to run last", () => {
    process.env.ACS_OPENCLAW_TEST_KEY = ENV.ACS_KEY;
    const { registered, middleware, errors } = register({ ...VALID, keyEnv: "ACS_OPENCLAW_TEST_KEY" });
    expect(errors).toEqual([]);
    expect(middleware).toEqual([{ runtimes: ["openclaw"] }]);
    expect(registered.map(({ name }) => name)).toEqual([
      "before_agent_run",
      "before_dispatch",
      "before_tool_call",
      "after_tool_call",
      "message_sending",
      "message_received",
      "agent_end",
      "session_end",
      "gateway_start",
    ]);
    expect(registered.every(({ priority }) => priority === Number.MIN_SAFE_INTEGER)).toBe(true);
    // Every hook that waits for the Guardian asks OpenClaw for a timeout longer than deadlineMs.
    expect(Object.fromEntries(registered.filter(({ timeoutMs }) => timeoutMs !== undefined).map(({ name, timeoutMs }) => [name, timeoutMs]))).toEqual({
      before_agent_run: 15_000,
      before_dispatch: 15_000,
      before_tool_call: 15_000,
      message_sending: 15_000,
    });
  });

  it("blocks every step when its configuration cannot be used", async () => {
    const { registered, errors } = register({ guardianUrl: "http://127.0.0.1:1/acs" });
    expect(errors[0]).toContain('"keyId" is required');
    const hook = (name: string) => registered.find((entry) => entry.name === name)!.handler;
    expect(await hook("before_tool_call")({ toolName: "x", params: {} }, {})).toMatchObject({ block: true });
    expect(await hook("message_sending")({ to: "x", content: "secret" }, { channelId: "c" })).toEqual({ cancel: true });
    expect(await hook("before_agent_run")({ prompt: "hi" }, {})).toEqual({ outcome: "block", reason: expect.any(String) });
    expect(await hook("before_dispatch")({ content: "hi" }, {})).toEqual({ handled: true });
  });

  it("blocks every step of a deployment that fails a requirement with the text it configured", async () => {
    process.env.ACS_OPENCLAW_TEST_KEY = ENV.ACS_KEY;
    const dir = mkdtempSync(join(tmpdir(), "acs-openclaw-"));
    dirs.push(dir);
    const config = { ...VALID, keyEnv: "ACS_OPENCLAW_TEST_KEY", blockedReplyText: "Not now.", auditLog: join(dir, "audit.jsonl") };
    const { registered } = register(config, undefined, false);
    const hook = (name: string) => registered.find((entry) => entry.name === name)!.handler;
    expect(await hook("message_sending")({ to: "x", content: "secret" }, { channelId: "c" })).toEqual({ content: "Not now." });
    expect(await hook("before_dispatch")({ content: "hi" }, {})).toEqual({ handled: true, text: "Not now." });
  });

  it("blocks every step when OpenClaw does not provide plugin-scoped state", async () => {
    const { registered, errors } = register({ ...VALID, keyEnv: "ACS_OPENCLAW_TEST_KEY" }, undefined, true, false);
    expect(errors[0]).toContain("R9: this OpenClaw offers no plugin-scoped state store");
    const hook = (name: string) => registered.find((entry) => entry.name === name)!.handler;
    expect(await hook("before_tool_call")({ toolName: "x", params: {} }, {})).toMatchObject({ block: true });
  });

  it("declares the tool-result middleware contract OpenClaw checks at registration", async () => {
    const manifest = await Bun.file(new URL("../openclaw.plugin.json", import.meta.url)).json();
    expect(manifest.contracts).toEqual({ agentToolResultMiddleware: ["openclaw"] });
  });

  it("opens the plugin state store only when a hook runs, never at registration", async () => {
    process.env.ACS_OPENCLAW_TEST_KEY = ENV.ACS_KEY;
    let opened = 0;
    const state = { openKeyedStore: (...args: unknown[]) => ((opened += 1), (STATE.openKeyedStore as (...a: unknown[]) => unknown)(...args)) };
    const { registered, errors } = register({ ...VALID, keyEnv: "ACS_OPENCLAW_TEST_KEY" }, { state, config: ENABLED, version: VERIFIED_OPENCLAW_VERSION });
    expect(errors).toEqual([]);
    await Promise.resolve();
    expect(opened).toBe(0);
    await registered.find((entry) => entry.name === "gateway_start")!.handler({}, {});
    expect(opened).toBe(2);
  });
});
