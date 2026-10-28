import { describe, expect, it } from "bun:test";
import plugin from "../acs-plugin.ts";
import type { ToolResultAnswer } from "../openclaw-hooks.ts";
import { REQUIREMENTS, VERIFIED_OPENCLAW_VERSION } from "../requirements.ts";
import { memoryPluginState } from "./memory-plugin-state.ts";

const SENDER = "+15550100";
const OTHER = "+15550199";
const KEY = "0123456789abcdef0123456789abcdef";
const DEADLINE_MS = 300;
const AUDIT_LOG = `${(await import("node:os")).tmpdir()}/acs-openclaw-requirements-test.jsonl`;
const example = await Bun.file(new URL("../openclaw.json.example", import.meta.url)).json();

/**
 * One OpenClaw deployment: its config, release and plugin API, the session the
 * steps come from, and that session's entry. `session.runtime` is the runtime
 * OpenClaw picks for the session's next run; a session entry's override
 * (`agentRuntimeOverride`, `src/config/sessions/types.ts:506`) can make it
 * `codex` whatever the config says, and the plugin cannot read it.
 */
type Deployment = { settings: Record<string, unknown>; version: string; registrar: boolean; runStateStore: boolean; sessionKey: string; session: { runtime: "openclaw" | "codex" } };

/** A deployment that meets every row: the example config, the verified release, a middleware registrar, the sender's own session. */
function meetsAll(): Deployment {
  return {
    settings: structuredClone(example),
    version: VERIFIED_OPENCLAW_VERSION,
    registrar: true,
    runStateStore: true,
    sessionKey: `agent:main:signal:direct:${SENDER}`,
    session: { runtime: "openclaw" },
  };
}

const entry = (d: Deployment) => (d.settings.plugins as { entries: Record<string, Record<string, unknown>> }).entries["acs-guardian-client"]!;

/** How each row is made to fail; every row has one. */
const FLIPS: Record<string, (d: Deployment) => void> = {
  R0: (d) => (d.version = "2026.10.3"),
  R1: (d) => (d.registrar = false),
  R2: (d) => delete entry(d).enabled,
  R3: (d) => ((entry(d).hooks as Record<string, unknown>).allowConversationAccess = false),
  R4: (d) => ((entry(d).hooks as Record<string, unknown>).timeoutMs = DEADLINE_MS),
  R5: (d) => (d.settings.acp = { enabled: true }),
  R6: (d) => (d.settings.commands = { allowFrom: { signal: [SENDER] } }),
  R7: (d) => (((d.settings.agents as any).defaults.models["openai/gpt-6-astra"] as Record<string, unknown>).agentRuntime = { id: "codex" }),
  R8: (d) => (d.sessionKey = `agent:main:signal:direct:${OTHER}`),
  R9: (d) => (d.runStateStore = false),
};

/**
 * Registers the plugin into `d` and drives one of each step through it, as
 * OpenClaw would: a governed run of the session first, then a message and the
 * run that answers it. OpenClaw calls `before_agent_run` for that run only on
 * its own runtime (the Codex runtime has no caller,
 * `runBeforeAgentRunGate` is called only from `cli-runner.ts`,
 * `attempt-before-agent-run.ts` and `worker-turn-user-message.ts`).
 */
async function drive(d: Deployment) {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const middleware: Array<(...args: unknown[]) => unknown> = [];
  const errors: string[] = [];
  process.env.ACS_REQUIREMENTS_TEST_KEY = Buffer.from(KEY).toString("base64");
  plugin.register({
    // No Guardian answers; the negotiated posture with no ServerHello proceeds
    // (the ACS default), so a step the requirements let through is not
    // blocked by the posture instead.
    pluginConfig: {
      ...(entry(d).config as Record<string, unknown>),
      keyEnv: "ACS_REQUIREMENTS_TEST_KEY",
      guardianUrl: "http://127.0.0.1:1/acs",
      deadlineMs: DEADLINE_MS,
      auditLog: AUDIT_LOG,
      failurePosture: "negotiated",
    },
    runtime: { version: d.version, config: { current: () => d.settings }, ...(d.runStateStore ? { state: memoryPluginState() } : {}) } as never,
    logger: { error: (message: string) => errors.push(message) },
    on: (name: string, handler: (...args: never[]) => unknown) => hooks.set(name, handler as (...args: unknown[]) => unknown),
    ...(d.registrar ? { registerAgentToolResultMiddleware: (handler: (...args: never[]) => unknown) => middleware.push(handler as (...args: unknown[]) => unknown) } : {}),
  });
  const runCtx = (runId: string) => ({
    runId,
    sessionKey: d.sessionKey,
    sessionId: "session-1",
    senderId: SENDER,
    channel: "signal",
    agentId: "main",
    modelProviderId: "openai",
    modelId: "gpt-6-astra",
  });
  const dispatchCtx = { channelId: "signal", sessionKey: d.sessionKey, senderId: SENDER };
  // The session's earlier run, on OpenClaw's own runtime.
  const earlier = await hooks.get("before_agent_run")!({ prompt: "hello", senderId: SENDER }, runCtx("run-0"));
  await hooks.get("agent_end")!({ runId: "run-0" }, runCtx("run-0"));
  const dispatch = await hooks.get("before_dispatch")!({ content: "hi", sessionKey: d.sessionKey, senderId: SENDER }, dispatchCtx);
  const run = d.session.runtime === "openclaw" ? await hooks.get("before_agent_run")!({ prompt: "hi", senderId: SENDER }, runCtx("run-1")) : undefined;
  return {
    errors,
    earlier,
    dispatch,
    run,
    tool: await hooks.get("before_tool_call")!({ toolName: "account-lookup", params: {}, toolCallId: "call-1" }, { runId: "run-1", sessionKey: d.sessionKey, sessionId: "session-1" }),
    reply: await hooks.get("message_sending")!({ to: SENDER, content: "secret" }, { channelId: "signal", sessionKey: d.sessionKey }),
    result: middleware[0] === undefined
      ? undefined
      : ((await middleware[0](
          { toolCallId: "call-1", toolName: "account-lookup", args: {}, result: { content: [{ type: "text", text: "secret" }] } },
          { runtime: d.session.runtime, runId: "run-1", sessionId: "session-1" },
        )) as ToolResultAnswer),
  };
}

describe("the requirements table", () => {
  it("has a way to fail every row, and no other", () => {
    expect(Object.keys(FLIPS).sort()).toEqual(REQUIREMENTS.map(({ id }) => id).sort());
  });

  it("lets a deployment that meets every row through, naming none", async () => {
    const steps = await drive(meetsAll());
    expect(steps.earlier).toBeUndefined();
    expect(steps.dispatch).toBeUndefined();
    expect(steps.run).toBeUndefined();
    expect(steps.tool).toEqual({ params: {} });
    expect(steps.errors.filter((error) => /\bR\d:/.test(error))).toEqual([]);
  });

  // The session entry is not readable by a plugin, so R7 cannot refuse it at
  // dispatch; the run never passes before_agent_run, so none of its outputs is.
  it("blocks every output of a session switched to the Codex runtime, after a governed run", async () => {
    const deployment = meetsAll();
    deployment.session.runtime = "codex";
    const steps = await drive(deployment);
    expect(steps.earlier).toBeUndefined();
    expect(steps.tool).toMatchObject({ block: true });
    expect(steps.reply).toEqual({ cancel: true });
    expect(steps.result?.result.content).toEqual([{ type: "text", text: "[OUTPUT WITHHELD BY POLICY]" }]);
    const refused = (await Bun.file(AUDIT_LOG).text()).trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.outcome === "refused");
    expect(refused.slice(-3).map((entry) => [entry.method, entry.refused.reason_code])).toEqual([
      ["steps/toolCallRequest", "run_not_admitted"],
      ["steps/agentResponse", "run_not_admitted"],
      ["steps/toolCallResult", "run_not_admitted"],
    ]);
  });

  it.each(REQUIREMENTS.map(({ id }) => [id]))("blocks every step when %s fails, and names it", async (id) => {
    const deployment = meetsAll();
    FLIPS[id]!(deployment);
    const steps = await drive(deployment);
    expect(steps.dispatch).toMatchObject({ handled: true });
    expect(steps.run).toMatchObject({ outcome: "block" });
    expect(steps.tool).toMatchObject({ block: true });
    expect(steps.reply).not.toEqual({ content: "secret" });
    expect(steps.result?.result.content).not.toEqual([{ type: "text", text: "secret" }]);
    expect(steps.errors.join("\n")).toContain(`${id}:`);
    const refused = (await Bun.file(AUDIT_LOG).text()).trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.outcome === "refused");
    expect(refused.some((entry) => entry.refused.reason_code === `requirement:${id}`)).toBe(true);
  });

  it("is the README's requirements section, row for row", async () => {
    const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();
    const section = readme.slice(readme.indexOf("## Requirements"), readme.indexOf("\n## ", readme.indexOf("## Requirements") + 1));
    const rows = section
      .split("\n")
      .filter((line) => /^\| R\d /.test(line))
      .map((line) => line.split("|").map((cell) => cell.trim()))
      .map((cells) => ({ id: cells[1], setting: cells[2]!.replace(/`/g, ""), checkedAt: cells[4] }));
    expect(rows).toEqual(REQUIREMENTS.map(({ id, setting, checkedAt }) => ({ id, setting, checkedAt: checkedAt.join(", ") })));
  });
});
