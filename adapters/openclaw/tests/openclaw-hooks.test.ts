import { afterEach, describe, expect, it } from "bun:test";
import { createGuardianClient, WITHHELD_OUTPUT, type AuditEvent, type AuditSink, type SigningKey } from "../host-adapter.ts";
import { createAcsExchange } from "../acs-exchange.ts";
import type { FailurePosture } from "../config.ts";
import { METHODS, type AcsExchange } from "../acs-exchange.ts";
import type { OpenClawSettings } from "../openclaw-settings.ts";
import { failedRequirement } from "../requirements.ts";
import {
  createHooks,
  type Admission,
  type AdmissionStore,
  type BeforeDispatchResult,
  type BeforeToolCallResult,
  type Hooks,
  type ToolResultAnswer,
  type ToolResultBlock,
  type RunFactsStore,
} from "../openclaw-hooks.ts";
import { startFakeAcsServer, type FakeAcsServer, type Reply, type ReceivedStep } from "./fake-acs-server.ts";

const KEY: SigningKey = {
  keyId: "example-key",
  secret: Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
  hkdf: { salt: "", infoPrefix: "", sessionIdEncoding: "utf8" },
};
const BLOCKED = "Fixed text: this reply was withheld.";
/** OpenClaw settings that meet every requirement checked at a run or a dispatch. */
const MEETS_REQUIREMENTS: OpenClawSettings = {
  acp: { enabled: false },
  commands: { allowFrom: { signal: ["+15550111"] } },
  agents: { defaults: { model: "openai/gpt-6-astra", models: { "openai/gpt-6-astra": { agentRuntime: { id: "openclaw" } } } } },
};
const PINNED_MODEL = { provider: "openai", id: "gpt-6-astra" };
const SENDER = "+15550100";
const OTHER_PHONE = "+15550199";
const SESSION_KEY = `agent:main:signal:direct:${SENDER}`;
const SESSION_ID = "session-1";
const AGENT_CTX = { runId: "run-1", sessionKey: SESSION_KEY, sessionId: SESSION_ID, senderId: SENDER, channel: "signal" };
const TOOL_CTX = { runId: "run-1", sessionKey: SESSION_KEY };
const MESSAGE_CTX = { channelId: "signal", sessionKey: SESSION_KEY };

/** The steps most tests are about; a test of the others asks the fake Guardian to evaluate them. */
const CORE_METHODS = ["steps/userMessage", "steps/toolCallRequest", "steps/agentResponse"];
const ALL_METHODS = [
  "steps/sessionStart",
  "steps/agentTrigger",
  "steps/turnStart",
  "steps/userMessage",
  "steps/toolCallRequest",
  "steps/toolCallResult",
  "steps/subagentStart",
  "steps/agentResponse",
  "steps/turnEnd",
  "steps/sessionEnd",
];

type Setup = { server: FakeAcsServer; hooks: Hooks; audit: AuditEvent[]; errors: string[]; settingsReads: { count: number } };

function memoryRunFacts(): RunFactsStore {
  const values = new Map<string, Record<string, unknown>>();
  const key = (runId: string, namespace: string) => `${runId}\n${namespace}`;
  return {
    async set(runId, namespace, value) {
      values.set(key(runId, namespace), structuredClone(value));
    },
    async setIfAbsent(runId, namespace, value) {
      const entry = key(runId, namespace);
      if (values.has(entry)) return false;
      values.set(entry, structuredClone(value));
      return true;
    },
    async get(runId, namespace) {
      const value = values.get(key(runId, namespace));
      return value === undefined ? undefined : structuredClone(value);
    },
    async consume(runId, namespace) {
      const entry = key(runId, namespace);
      const value = values.get(entry);
      values.delete(entry);
      return value === undefined ? undefined : structuredClone(value);
    },
    async clear(runId, namespace) {
      if (namespace !== undefined) {
        values.delete(key(runId, namespace));
      } else {
        for (const entry of values.keys()) {
          if (entry.startsWith(`${runId}\n`)) values.delete(entry);
        }
      }
    },
    async pruneOtherProcesses() {},
  };
}

/** A Guardian answer the test releases, so a hook can be held inside its exchange. */
function heldAnswer(): { reached: Promise<void>; release(): void; answer(): Promise<Reply> } {
  let release!: () => void;
  let markReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release,
    async answer() {
      markReached();
      await released;
      return { decision: { decision: "allow" } };
    },
  };
}

const servers: FakeAcsServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
});

function setup(
  options: {
    reply?: (step: ReceivedStep) => Reply | Promise<Reply>;
    failurePosture?: FailurePosture;
    onDecisionFailure?: "proceed" | "deny";
    deadlineMs?: number;
    clientKey?: SigningKey;
    ungovernable?: string;
    methodsEvaluated?: string[] | null;
    admissions?: AdmissionStore;
    runFacts?: RunFactsStore;
    maxUndecidedMessages?: number;
    /** `null` leaves `blockedReplyText` unset, as by default. */
    blockedReplyText?: string | null;
  } = {},
): Setup {
  const server = startFakeAcsServer({
    key: KEY,
    reply: options.reply,
    onDecisionFailure: options.onDecisionFailure,
    methodsEvaluated: options.methodsEvaluated === undefined ? CORE_METHODS : options.methodsEvaluated,
  });
  servers.push(server);
  const events: AuditEvent[] = [];
  const audit: AuditSink = {
    path: "memory",
    write(event) {
      events.push(event);
      return true;
    },
  };
  const exchange = createAcsExchange({
    client: createGuardianClient(server.url, { signingKey: options.clientKey ?? KEY }),
    audit,
    failurePosture: options.failurePosture ?? "closed",
    deadlineMs: options.deadlineMs ?? 2000,
  });
  const errors: string[] = [];
  const settingsReads = { count: 0 };
  const hooks = createHooks({
    config: {
      approvers: new Set(["approver-1"]),
      ...(options.blockedReplyText === null ? {} : { blockedReplyText: options.blockedReplyText ?? BLOCKED }),
      maxUndecidedMessages: options.maxUndecidedMessages ?? 20,
    },
    exchange,
    audit,
    // The real table over settings that meet it. The hook contexts here name
    // no model, so a run is given the pinned one; R7 has its own tests.
    requirementFailure: (point, facts) => {
      settingsReads.count += 1;
      return options.ungovernable ?? failedRequirement(point, { ...facts, settings: MEETS_REQUIREMENTS, ...(point === "run" ? { model: PINNED_MODEL } : {}) });
    },
    logger: { error: (message) => errors.push(message) },
    admissions: options.admissions,
    runFacts: options.runFacts ?? memoryRunFacts(),
  });
  return { server, hooks, audit: events, errors, settingsReads };
}

/** Allows every step but the reply, and answers the reply with `answer`. */
function replyAnswer(answer: Reply): (step: ReceivedStep) => Reply {
  return (step) => (step.method === "steps/agentResponse" ? answer : { decision: { decision: "allow" } });
}

function toolDecision(decision: Record<string, unknown>): (step: ReceivedStep) => Reply {
  return (step) => (step.method === "steps/toolCallRequest" ? { decision } : { decision: { decision: "allow" } });
}

async function startRun(hooks: Hooks): Promise<void> {
  expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX)).toBeUndefined();
}

function callTool(hooks: Hooks, params: Record<string, unknown> = { phone: OTHER_PHONE }): Promise<BeforeToolCallResult> {
  return hooks.beforeToolCall({ toolName: "account-lookup", params }, TOOL_CTX);
}

describe("identity: the sender comes from the channel, never from the model", () => {
  it("sends the run's sender as user_context while the tool parameters name another phone", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    expect(await callTool(hooks)).toEqual({ params: { phone: OTHER_PHONE } });

    expect(server.steps.map((step) => step.method)).toEqual(["steps/userMessage", "steps/toolCallRequest"]);
    const toolStep = server.steps[1]!;
    expect(toolStep.userContext).toEqual({ user_id: SENDER, authentication_method: "signal" });
    expect(toolStep.payload).toEqual({ tool: { name: "account-lookup" }, arguments: { phone: { value: OTHER_PHONE } } });
    expect(server.steps[0]!.payload).toEqual({ content: [{ type: "text", value: "Hello" }] });
    expect(server.badSignatures).toBe(0);
  });

  it("denies a tool call of a run with no recorded sender, without asking the Guardian", async () => {
    const { server, hooks } = setup();
    const result = await hooks.beforeToolCall({ toolName: "account-lookup", params: {} }, { runId: "run-unknown", sessionKey: SESSION_KEY });
    expect(result).toMatchObject({ block: true });
    expect(server.steps).toHaveLength(0);
  });

  it("records no sender for a run whose user message was denied", async () => {
    const { hooks } = setup({ reply: () => ({ decision: { decision: "deny", reasoning: "not today" } }) });
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX)).toEqual({
      outcome: "block",
      reason: "not today",
      message: BLOCKED,
    });
    expect(await callTool(hooks)).toMatchObject({ block: true, blockReason: expect.stringContaining("not admitted") });
  });

  it("blocks a run that carries no sender", async () => {
    const { server, hooks } = setup();
    const { senderId: _dropped, ...noSender } = AGENT_CTX;
    expect(await hooks.beforeAgentRun({ prompt: "Hello" }, noSender)).toMatchObject({ outcome: "block", message: BLOCKED });
    expect(server.steps).toHaveLength(0);
  });

  it("refuses a sender on another sender's session key, and keeps the session's own sender", async () => {
    const { server, hooks, errors } = setup();
    await startRun(hooks);
    const second = { ...AGENT_CTX, runId: "run-2", senderId: OTHER_PHONE };
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: OTHER_PHONE }, second)).toMatchObject({ outcome: "block" });
    expect(errors[0]).toContain("is not a direct-message session of");
    expect(await callTool(hooks)).toEqual({ params: { phone: OTHER_PHONE } });
    expect(server.steps.at(-1)?.userContext).toEqual({ user_id: SENDER, authentication_method: "signal" });
  });

  it("refuses a sender id that OpenClaw would lowercase into a session another id shares", async () => {
    const key = "agent:main:slack:direct:u0123";
    const { server, hooks } = setup();
    expect(
      await hooks.beforeAgentRun({ prompt: "Hello", senderId: "U0123" }, { runId: "run-1", sessionKey: key, senderId: "U0123", channel: "slack" }),
    ).toMatchObject({ outcome: "block" });
    expect(server.steps).toHaveLength(0);
  });

  it("sends nothing to a recipient whose key is a group key in the shape of an account key", async () => {
    const { server, hooks } = setup();
    expect(
      await hooks.messageSending(
        { to: SENDER, content: "hi" },
        { channelId: "signal", sessionKey: `agent:main:signal:group:direct:${SENDER}`, accountId: "default" },
      ),
    ).toEqual({ cancel: true });
    expect(server.steps).toHaveLength(0);
  });

  it("admits no run on a channel whose OpenClaw settings leave it ungovernable", async () => {
    const { server, hooks, errors } = setup({ ungovernable: "queue mode is steer" });
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX)).toMatchObject({
      outcome: "block",
      reason: "queue mode is steer",
    });
    expect(await callTool(hooks)).toMatchObject({ block: true });
    expect(errors[0]).toContain("queue mode is steer");
    expect(server.steps).toHaveLength(0);
  });

  it("admits no second run of a session while the first has not ended", async () => {
    const { hooks } = setup();
    await startRun(hooks);
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, { ...AGENT_CTX, runId: "run-2" })).toMatchObject({
      outcome: "block",
      reason: "another run of this session has not ended",
    });
    hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, { ...AGENT_CTX, runId: "run-2" })).toBeUndefined();
  });

  it("blocks a tool call of a run that has ended, even under the same run id", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    expect(await callTool(hooks)).toMatchObject({ block: true, blockReason: expect.stringContaining("not admitted") });
    expect(server.steps.map((step) => step.method)).toEqual(["steps/userMessage"]);
  });

  it("blocks a run with no run id", async () => {
    const { runId: _dropped, ...noRunId } = AGENT_CTX;
    const { server, hooks } = setup();
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, noRunId)).toMatchObject({ outcome: "block" });
    expect(server.steps).toHaveLength(0);
  });

  it("names the session's sender on every run of the session", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    await hooks.beforeAgentRun({ prompt: "again", senderId: SENDER }, { ...AGENT_CTX, runId: "run-2" });
    expect(await hooks.beforeToolCall({ toolName: "account-lookup", params: {} }, { runId: "run-2", sessionKey: SESSION_KEY })).toEqual({
      params: {},
    });
    expect(server.steps.at(-1)?.userContext).toEqual({ user_id: SENDER, authentication_method: "signal" });
  });

  it("forgets a run at agent_end", async () => {
    const { hooks } = setup();
    await startRun(hooks);
    hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    expect(await callTool(hooks)).toMatchObject({ block: true });
  });

  it("blocks a tool call whose session is not its run's", async () => {
    const { hooks } = setup();
    await startRun(hooks);
    const result = await hooks.beforeToolCall({ toolName: "account-lookup", params: {} }, { runId: "run-1", sessionKey: "another" });
    expect(result).toMatchObject({ block: true });
  });
});

describe("no decision uses a value another hook changed while it waited", () => {
  it.each([
    ["the_run_ends", (hooks: Hooks) => hooks.agentEnd({ runId: "run-1" }, AGENT_CTX)],
    ["the_session_ends", (hooks: Hooks) => hooks.sessionEnd({ sessionKey: SESSION_KEY, sessionId: SESSION_ID }, {})],
  ])("blocks a tool call when %s while the Guardian decides", async (_name, change) => {
    const held = heldAnswer();
    const { hooks } = setup({ reply: (step) => (step.method === "steps/toolCallRequest" ? held.answer() : { decision: { decision: "allow" } }) });
    await startRun(hooks);
    const call = callTool(hooks);
    await held.reached;
    change(hooks);
    held.release();
    expect(await call).toMatchObject({ block: true });
    expect(await callTool(hooks)).toMatchObject({ block: true });
  });

  it("admits at most one of two runs that reach a new session at once", async () => {
    const held = heldAnswer();
    let first = true;
    const { hooks } = setup({
      reply: () => {
        if (first) {
          first = false;
          return held.answer();
        }
        return { decision: { decision: "allow" } };
      },
    });
    const runA = hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX);
    await held.reached;
    const runB = await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, { ...AGENT_CTX, runId: "run-2" });
    held.release();
    expect(runB).toBeUndefined();
    expect(await runA).toMatchObject({ outcome: "block", reason: "another run of this session has not ended" });
    expect(await callTool(hooks)).toMatchObject({ block: true });
  });

  it.each([
    ["the_run_ends", (hooks: Hooks) => hooks.agentEnd({ runId: "run-1" }, AGENT_CTX)],
    ["the_session_ends", (hooks: Hooks) => hooks.sessionEnd({ sessionKey: SESSION_KEY, sessionId: SESSION_ID }, {})],
  ])("admits no run when %s while its user message is decided, and leaves the session free", async (_name, change) => {
    const held = heldAnswer();
    let first = true;
    const { hooks } = setup({
      reply: () => {
        if (first) {
          first = false;
          return held.answer();
        }
        return { decision: { decision: "allow" } };
      },
    });
    const run = hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX);
    await held.reached;
    change(hooks);
    held.release();
    expect(await run).toMatchObject({ outcome: "block", reason: "the run or its session ended while the Guardian decided" });
    expect(await callTool(hooks)).toMatchObject({ block: true });
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, { ...AGENT_CTX, runId: "run-2" })).toBeUndefined();
  });

  it("blocks a tool call that names two different runs", async () => {
    const { hooks } = setup();
    await startRun(hooks);
    expect(await hooks.beforeToolCall({ toolName: "account-lookup", params: {}, runId: "run-9" }, TOOL_CTX)).toMatchObject({ block: true });
  });

  it("refuses a new sender on a session key whose session OpenClaw ended", async () => {
    const { hooks } = setup();
    await startRun(hooks);
    hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    hooks.sessionEnd({ sessionKey: SESSION_KEY, sessionId: SESSION_ID }, {});
    expect(
      await hooks.beforeAgentRun({ prompt: "Hello", senderId: OTHER_PHONE }, { ...AGENT_CTX, runId: "run-2", senderId: OTHER_PHONE }),
    ).toMatchObject({ outcome: "block" });
  });

  it("reads OpenClaw's settings once per run, at before_agent_run, and never at a tool call", async () => {
    const { hooks, settingsReads } = setup();
    await startRun(hooks);
    await callTool(hooks);
    await callTool(hooks);
    expect(settingsReads.count).toBe(1);
  });
});

describe("the session, activation and turn steps", () => {
  const denyFor = (method: string) => (step: ReceivedStep): Reply =>
    step.method === method ? { decision: { decision: "deny", reasoning: `no ${method}` } } : { decision: { decision: "allow" } };

  it("sends each step of a run in ACS order, with turn_id only from turnStart to turnEnd", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS });
    await startRun(hooks);
    await callTool(hooks);
    await hooks.messageSending({ to: SENDER, content: "Done." }, MESSAGE_CTX);
    await hooks.agentEnd({ runId: "run-1", success: true }, AGENT_CTX);

    expect(server.steps.map((step) => [step.method, step.turnId])).toEqual([
      ["steps/sessionStart", undefined],
      ["steps/agentTrigger", undefined],
      ["steps/turnStart", "run-1"],
      ["steps/userMessage", "run-1"],
      ["steps/toolCallRequest", "run-1"],
      ["steps/agentResponse", "run-1"],
      ["steps/turnEnd", "run-1"],
    ]);
    expect(server.steps[0]!.payload).toEqual({
      user_identity: { user_id: SENDER, authentication_method: "signal" },
      platform_context: { channel: "signal" },
    });
    expect(server.steps[1]!.payload).toEqual({ trigger_type: "user_message", trigger_source: { channel: "signal" } });
    expect(server.steps[2]!.payload).toEqual({ turn_id: "run-1", triggered_by: "user_message" });
    expect(server.steps[6]!.payload).toEqual({ turn_id: "run-1", outcome: "completed", tool_call_count: 1 });
    expect(server.badSignatures).toBe(0);
  });

  it("starts a session once, and again after OpenClaw ended it", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS });
    await startRun(hooks);
    await hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    expect(await hooks.beforeAgentRun({ prompt: "again", senderId: SENDER }, { ...AGENT_CTX, runId: "run-2" })).toBeUndefined();
    await hooks.agentEnd({ runId: "run-2" }, AGENT_CTX);
    await hooks.sessionEnd({ sessionKey: SESSION_KEY, sessionId: SESSION_ID, reason: "idle" }, {});
    expect(
      await hooks.beforeAgentRun({ prompt: "new", senderId: SENDER }, { ...AGENT_CTX, runId: "run-3", sessionId: "session-2" }),
    ).toBeUndefined();
    expect(server.steps.filter((step) => step.method === "steps/sessionStart")).toHaveLength(2);
    expect(server.steps.find((step) => step.method === "steps/sessionEnd")).toMatchObject({ payload: { reason: "timeout" }, turnId: undefined });
  });

  it("admits no run of a session the Guardian refused, without asking again", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS, reply: denyFor("steps/sessionStart") });
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX)).toMatchObject({ outcome: "block" });
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, { ...AGENT_CTX, runId: "run-2" })).toMatchObject({
      outcome: "block",
      reason: expect.stringContaining("refused this session"),
    });
    expect(server.steps.map((step) => step.method)).toEqual(["steps/sessionStart"]);
  });

  it("keeps a session refused when an allow for it arrives after the refusal", async () => {
    const held = heldAnswer();
    let sessionStarts = 0;
    const { hooks } = setup({
      methodsEvaluated: ALL_METHODS,
      reply: (step) => {
        if (step.method !== "steps/sessionStart") {
          return { decision: { decision: "allow" } };
        }
        sessionStarts += 1;
        return sessionStarts === 1 ? held.answer() : { decision: { decision: "deny", reasoning: "no session" } };
      },
    });
    const runA = hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX);
    await held.reached;
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, { ...AGENT_CTX, runId: "run-2" })).toMatchObject({
      outcome: "block",
    });
    held.release();
    expect(await runA).toMatchObject({ outcome: "block", reason: expect.stringContaining("refused this session") });
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, { ...AGENT_CTX, runId: "run-3" })).toMatchObject({
      outcome: "block",
      reason: expect.stringContaining("refused this session"),
    });
    expect(await callTool(hooks)).toMatchObject({ block: true });
  });

  it("asks about the session again after the failure posture let a run through", async () => {
    let first = true;
    const { server, hooks, audit } = setup({
      methodsEvaluated: ALL_METHODS,
      deadlineMs: 300,
      failurePosture: "negotiated",
      onDecisionFailure: "proceed",
      reply: (step) => {
        if (step.method === "steps/sessionStart" && first) {
          first = false;
          return { hang: true };
        }
        return { decision: { decision: "allow" } };
      },
    });
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX)).toBeUndefined();
    await hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, { ...AGENT_CTX, runId: "run-2" })).toBeUndefined();
    expect(server.steps.filter((step) => step.method === "steps/sessionStart")).toHaveLength(2);
    expect(audit).toContainEqual(expect.objectContaining({ method: "steps/sessionStart", outcome: "proceeded" }));
  });

  it("sends nothing into a session OpenClaw ended while the Guardian decided the reply", async () => {
    const held = heldAnswer();
    const { hooks } = setup({ reply: (step) => (step.method === "steps/agentResponse" ? held.answer() : { decision: { decision: "allow" } }) });
    await startRun(hooks);
    const reply = hooks.messageSending({ to: SENDER, content: "hi" }, MESSAGE_CTX);
    await held.reached;
    await hooks.sessionEnd({ sessionKey: SESSION_KEY, sessionId: SESSION_ID }, {});
    held.release();
    expect(await reply).toEqual({ cancel: true });
  });

  it("asks about the session again when the Guardian could not answer it", async () => {
    let first = true;
    const { server, hooks } = setup({
      methodsEvaluated: ALL_METHODS,
      deadlineMs: 300,
      reply: (step) => {
        if (step.method === "steps/sessionStart" && first) {
          first = false;
          return { hang: true };
        }
        return { decision: { decision: "allow" } };
      },
    });
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX)).toMatchObject({ outcome: "block" });
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, { ...AGENT_CTX, runId: "run-2" })).toBeUndefined();
    expect(server.steps.filter((step) => step.method === "steps/sessionStart")).toHaveLength(2);
  });

  it.each(["steps/agentTrigger", "steps/turnStart"])("blocks the run when the Guardian denies %s, before the user message", async (method) => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS, reply: denyFor(method) });
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX)).toMatchObject({ outcome: "block" });
    expect(server.steps.map((step) => step.method)).not.toContain("steps/userMessage");
    expect(await callTool(hooks)).toMatchObject({ block: true });
  });

  it("names a scheduled activation by its trigger", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS });
    await hooks.beforeAgentRun({ prompt: "tick", senderId: SENDER }, { ...AGENT_CTX, trigger: "cron" });
    expect(server.steps.find((step) => step.method === "steps/agentTrigger")?.payload).toMatchObject({ trigger_type: "scheduled" });
  });

  it("ends a failed turn as an error, and records a turnEnd answer it cannot apply", async () => {
    const { server, hooks, audit } = setup({ methodsEvaluated: ALL_METHODS, reply: denyFor("steps/turnEnd") });
    await startRun(hooks);
    await hooks.agentEnd({ runId: "run-1", success: false }, AGENT_CTX);
    expect(server.steps.at(-1)).toMatchObject({ method: "steps/turnEnd", payload: { outcome: "error", tool_call_count: 0 } });
    expect(audit).toContainEqual(
      expect.objectContaining({ method: "steps/turnEnd", substituted: { decision: "deny", reason_code: "not_decision_eligible" } }),
    );
  });

  it("sends no turnEnd for a run it did not admit", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS });
    await hooks.agentEnd({ runId: "run-9" }, AGENT_CTX);
    expect(server.steps).toHaveLength(0);
  });
});

describe("tool decisions", () => {
  it("blocks a deny with the Guardian's reasoning", async () => {
    const { hooks } = setup({ reply: toolDecision({ decision: "deny", reasoning: "only the account holder" }) });
    await startRun(hooks);
    expect(await callTool(hooks)).toEqual({ block: true, blockReason: "only the account holder" });
  });

  it("blocks a modify that cannot be applied", async () => {
    const { hooks } = setup({
      reply: toolDecision({ decision: "modify", reasoning: "mask", modifications: { parameter_overrides: { missing: "x" } } }),
    });
    await startRun(hooks);
    expect(await callTool(hooks)).toMatchObject({ block: true });
  });

  it("runs a modify with the Guardian's parameters", async () => {
    const { hooks } = setup({
      reply: toolDecision({ decision: "modify", reasoning: "masked", modifications: { parameter_overrides: { phone: "+1555***" } } }),
    });
    await startRun(hooks);
    expect(await callTool(hooks)).toEqual({ params: { phone: "+1555***" } });
  });

  it("blocks a defer as pending and records the substitution", async () => {
    const { hooks, audit } = setup({
      reply: toolDecision({
        decision: "defer",
        reasoning: "waiting on a check",
        defer_details: { reason: "pending_dependency", resolution_method: "poll", resolution_timeout_ms: 60000, timeout_decision: "deny" },
      }),
    });
    await startRun(hooks);
    expect(await callTool(hooks)).toEqual({ block: true, blockReason: "Pending: waiting on a check" });
    expect(audit).toContainEqual(expect.objectContaining({ outcome: "substituted", substituted: { decision: "defer", reason_code: "defer_unsupported" } }));
  });
});

describe("ask: routed by the approver the Guardian named", () => {
  const ask = (approverId: string) =>
    toolDecision({
      decision: "ask",
      reasoning: "payment above the limit",
      ask_details: { approver: { type: "human", id: approverId }, question: "Send a payment of 500?", timeout_seconds: 300 },
    });

  it("asks OpenClaw for an approval when this host knows the approver", async () => {
    const { hooks, audit } = setup({ reply: ask("approver-1") });
    await startRun(hooks);
    const result = await callTool(hooks, { amount: 500 });
    expect(result).toMatchObject({
      params: { amount: 500 },
      requireApproval: { timeoutMs: 300000, allowedDecisions: ["allow-once", "deny"], description: expect.stringContaining("approver-1") },
    });
    expect(result?.block).toBeUndefined();

    await result!.requireApproval!.onResolution!("allow-once");
    await result!.requireApproval!.onResolution!("timeout");
    const askRequestId = (audit.find((event) => event.outcome === "approval") as { rpc_id: unknown } | undefined)?.rpc_id;
    expect(askRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(audit.filter((event) => event.outcome === "approval")).toEqual([
      expect.objectContaining({ approval: { requested_approver: { type: "human", id: "approver-1" }, resolution: "allow-once", decision: "allow" } }),
      expect.objectContaining({ approval: { requested_approver: { type: "human", id: "approver-1" }, resolution: "timeout", decision: "deny" } }),
    ]);
  });

  it("denies an ask whose approver this host does not know", async () => {
    const { hooks, audit } = setup({ reply: ask("someone-else") });
    await startRun(hooks);
    const result = await callTool(hooks, { amount: 500 });
    expect(result).toMatchObject({ block: true });
    expect(result?.requireApproval).toBeUndefined();
    expect(audit).toContainEqual(expect.objectContaining({ substituted: { decision: "ask", reason_code: "approver_unknown" } }));
  });

  it("denies an ask that carries no ask_details", async () => {
    const { hooks } = setup({ reply: toolDecision({ decision: "ask", reasoning: "?" }) });
    await startRun(hooks);
    expect(await callTool(hooks)).toEqual({ block: true, blockReason: expect.stringContaining("ask_details") });
  });

  it("denies an ask that names no approver", async () => {
    const { hooks, audit } = setup({ reply: toolDecision({ decision: "ask", reasoning: "needs a person", ask_details: { question: "?", timeout_seconds: 60 } }) });
    await startRun(hooks);
    expect(await callTool(hooks)).toEqual({ block: true, blockReason: expect.stringContaining('approval by "" cannot be requested') });
    expect(audit).toContainEqual(expect.objectContaining({ substituted: { decision: "ask", reason_code: "approver_unknown" } }));
  });

  it("shows the Guardian's options in the approval text and freezes the parameters it saw", async () => {
    const { hooks } = setup({
      reply: toolDecision({
        decision: "ask",
        reasoning: "pick one",
        ask_details: { approver: { type: "human", id: "approver-1" }, question: "Send it?", options: ["now", "tomorrow"], timeout_seconds: 60 },
      }),
    });
    await startRun(hooks);
    const result = await callTool(hooks, { amount: 500 });
    expect(result?.requireApproval?.description).toBe('Send it?\nOptions: now; tomorrow\nCall: account-lookup {"amount":500}\nApprover: approver-1');
    expect(result?.params).toEqual({ amount: 500 });
  });

  it("denies an ask whose call does not fit the approval text whole, never cutting it", async () => {
    const { hooks, audit } = setup({ reply: ask("approver-1") });
    await startRun(hooks);
    const result = await callTool(hooks, { text: "x".repeat(600) });
    expect(result).toEqual({ block: true, blockReason: expect.stringContaining("cannot show this call whole") });
    expect(audit).toContainEqual(expect.objectContaining({ substituted: { decision: "ask", reason_code: "approval_text_too_long" } }));
  });
});

describe("message_sending", () => {
  it("sends an allowed reply as the Guardian saw it, naming the session's sender", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    expect(await hooks.messageSending({ to: SENDER, content: "Your order ships today." }, MESSAGE_CTX)).toEqual({
      content: "Your order ships today.",
    });
    expect(server.steps[1]).toMatchObject({
      method: "steps/agentResponse",
      userContext: { user_id: SENDER, authentication_method: "signal" },
      payload: { content: [{ type: "text", value: "Your order ships today." }] },
    });
  });

  it("replaces a denied reply with the fixed text the deployment configured", async () => {
    const { hooks } = setup({ reply: replyAnswer({ decision: { decision: "deny", reasoning: "foreign link" } }) });
    await startRun(hooks);
    expect(await hooks.messageSending({ to: SENDER, content: "Pay at https://pay.example.net" }, MESSAGE_CTX)).toEqual({ content: BLOCKED });
  });

  it("sends an automatic reply that no message call carried as steps/agentResponse", async () => {
    const { server, hooks } = setup({ blockedReplyText: null });
    await startRun(hooks);
    expect(await hooks.messageSending({ to: SENDER, content: "Your order ships today." }, MESSAGE_CTX)).toEqual({ content: "Your order ships today." });
    expect(server.steps.map((step) => step.method)).toEqual(["steps/userMessage", "steps/agentResponse"]);
  });

  it.each<[string, Reply]>([
    ["deny", { decision: { decision: "deny", reasoning: "foreign link" } }],
    ["ask", { decision: { decision: "ask", reasoning: "r", ask_details: { approver: { type: "human", id: "approver-1" }, timeout_seconds: 60 } } }],
  ])("cancels a reply answered %s, with no text in its place, when no blockedReplyText is configured", async (_name, answer) => {
    const { hooks } = setup({ reply: replyAnswer(answer), blockedReplyText: null });
    await startRun(hooks);
    expect(await hooks.messageSending({ to: SENDER, content: "Pay at https://pay.example.net" }, MESSAGE_CTX)).toEqual({ cancel: true });
  });

  it("sends the Guardian's rewrite of a reply", async () => {
    const { hooks } = setup({
      reply: replyAnswer({ decision: { decision: "modify", reasoning: "masked", modifications: { redactions: [{ path: "/content/0/value", replacement: "The one-time code is ****." }] } } }),
      blockedReplyText: null,
    });
    await startRun(hooks);
    expect(await hooks.messageSending({ to: SENDER, content: "The one-time code is 4321." }, MESSAGE_CTX)).toEqual({ content: "The one-time code is ****." });
  });

  it("cancels a reply whose rewrite leaves anything but text, audited as modifications_invalid", async () => {
    const { hooks, audit } = setup({
      reply: replyAnswer({ decision: { decision: "modify", reasoning: "odd", modifications: { parameter_overrides: { content: [{ type: "image" }] } } } }),
      blockedReplyText: null,
    });
    await startRun(hooks);
    expect(await hooks.messageSending({ to: SENDER, content: "hi" }, MESSAGE_CTX)).toEqual({ cancel: true });
    expect(audit).toContainEqual(expect.objectContaining({ outcome: "substituted", substituted: { decision: "modify", reason_code: "modifications_invalid" } }));
  });

  it("refuses a run with no text in its place when no blockedReplyText is configured", async () => {
    const { hooks } = setup({ reply: () => ({ decision: { decision: "deny", reasoning: "not today" } }), blockedReplyText: null });
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX)).toEqual({ outcome: "block", reason: "not today" });
  });

  it.each([
    ["another_recipient", { to: OTHER_PHONE, content: "hi" }, MESSAGE_CTX],
    ["another_channel", { to: SENDER, content: "hi" }, { ...MESSAGE_CTX, channelId: "sms" }],
  ])("sends nothing addressed to %s than the session's sender, without asking", async (_name, event, ctx) => {
    const { server, hooks } = setup();
    await startRun(hooks);
    expect(await hooks.messageSending(event, ctx)).toEqual({ cancel: true });
    expect(server.steps.map((step) => step.method)).toEqual(["steps/userMessage"]);
  });

  it("sends nothing in a session no run was admitted to, as in a runtime that skips before_agent_run", async () => {
    const { server, hooks } = setup();
    expect(await hooks.messageSending({ to: SENDER, content: "hi" }, MESSAGE_CTX)).toEqual({ cancel: true });
    expect(server.steps).toHaveLength(0);
  });

  it("sends nothing after OpenClaw ended the session", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    hooks.sessionEnd({ sessionKey: SESSION_KEY, sessionId: SESSION_ID }, {});
    expect(await hooks.messageSending({ to: SENDER, content: "hi" }, MESSAGE_CTX)).toEqual({ cancel: true });
    expect(server.steps.map((step) => step.method)).toEqual(["steps/userMessage"]);
  });

  it("sends nothing in a session whose key names no single sender", async () => {
    const { server, hooks } = setup();
    expect(await hooks.messageSending({ to: SENDER, content: "hi" }, { channelId: "signal", sessionKey: "agent:main:main" })).toEqual({
      cancel: true,
    });
    expect(server.steps).toHaveLength(0);
  });

  it("sends nothing with no session key, as for a message an operator or another plugin sends", async () => {
    const { hooks } = setup();
    expect(await hooks.messageSending({ to: SENDER, content: "hi" }, { channelId: "signal" })).toEqual({ cancel: true });
  });

  it("governs a message another plugin sends into an admitted session, as the session's reply", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    await hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    expect(await hooks.messageSending({ to: SENDER, content: "Reminder: the call starts at 15:00" }, MESSAGE_CTX)).toEqual({
      content: "Reminder: the call starts at 15:00",
    });
    expect(server.steps.at(-1)).toMatchObject({ method: "steps/agentResponse", userContext: { user_id: SENDER } });
  });
});

/** The agent's owner, and their own direct session. */
const OWNER = OTHER_PHONE;
const OWNER_KEY = `agent:main:signal:direct:${OWNER}`;
const OWNER_AGENT_CTX = { runId: "run-o", sessionKey: OWNER_KEY, sessionId: "session-o", senderId: OWNER, channel: "signal" };
const OWNER_TOOL_CTX = { runId: "run-o", sessionKey: OWNER_KEY };
const THIRD_PHONE = "+15550177";
const REPLY_CONTEXT = "The sender requests the proposed reply.";

/** A call of OpenClaw's `message` tool; OpenClaw files its delivery under the recipient's session. */
function sendCall(hooks: Hooks, params: Record<string, unknown>, ctx: Record<string, unknown> = TOOL_CTX, toolCallId = "call-1") {
  return hooks.beforeToolCall({ toolName: "message", params, toolCallId }, ctx);
}

function deliver(hooks: Hooks, to: string, content: string, ctx: { channelId: string; sessionKey?: string; accountId?: string } = { channelId: "signal", sessionKey: `agent:main:signal:direct:${to}` }) {
  return hooks.messageSending({ to, content }, ctx);
}

describe("message tool: a send to another recipient is the Guardian's to decide, at the call", () => {
  const FORWARD = { action: "send", replyContext: REPLY_CONTEXT, target: OWNER, message: "The sender attached a screenshot of the error. Suggested answer: a fix ships at 15:00." };

  it("forwards from a sender's session to the owner, decided once as the sender's call", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    expect(await sendCall(hooks, FORWARD)).toEqual({ params: FORWARD });
    expect(await deliver(hooks, OWNER, FORWARD.message)).toEqual({ content: FORWARD.message });

    const [, toolStep] = server.steps;
    expect(toolStep).toMatchObject({
      method: "steps/toolCallRequest",
      userContext: { user_id: SENDER, authentication_method: "signal" },
      payload: { tool: { name: "message" }, arguments: { action: { value: "send" }, target: { value: OWNER }, message: { value: FORWARD.message } } },
    });
    expect(server.steps.map((step) => step.method)).toEqual(["steps/userMessage", "steps/toolCallRequest"]);
  });

  it("sends from the owner's session into a sender's chat as the owner, even when the sender's session is admitted", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    await hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    expect(await hooks.beforeAgentRun({ prompt: "Tell the sender the fix ships at 15:00", senderId: OWNER }, OWNER_AGENT_CTX)).toBeUndefined();
    const params = { action: "send", replyContext: REPLY_CONTEXT, target: SENDER, message: "The fix ships at 15:00." };
    expect(await sendCall(hooks, params, OWNER_TOOL_CTX)).toEqual({ params });
    expect(await deliver(hooks, SENDER, params.message, MESSAGE_CTX)).toEqual({ content: params.message });
    expect(server.steps.at(-1)).toMatchObject({ method: "steps/toolCallRequest", turnId: "run-o", userContext: { user_id: OWNER } });
  });

  it("shows the host-origin message recipient in native approval scope", async () => {
    const { hooks } = setup({ reply: toolDecision({
      decision: "ask",
      reasoning: "review the external message",
      ask_details: { approver: { type: "human", id: "approver-1" }, question: "Send this?", timeout_seconds: 60 },
    }) });
    expect(await hooks.beforeAgentRun({ prompt: "Tell the sender the update", senderId: OWNER }, OWNER_AGENT_CTX)).toBeUndefined();

    const result = await sendCall(hooks, { action: "send", target: SENDER, message: "The update is ready.", replyContext: REPLY_CONTEXT }, OWNER_TOOL_CTX);

    expect(result?.requireApproval?.scope).toEqual({
      kind: "message-send",
      target: "signal",
      recipientCount: 1,
      recipients: [SENDER],
    });
  });

  it("delivers to every recipient a multi-target call names, and to no other", async () => {
    const { hooks } = setup();
    await startRun(hooks);
    await sendCall(hooks, { action: "broadcast", targets: [OWNER, ` ${THIRD_PHONE} `], message: "The call moved to 11:00." });
    expect(await deliver(hooks, OWNER, "The call moved to 11:00.")).toEqual({ content: "The call moved to 11:00." });
    expect(await deliver(hooks, THIRD_PHONE, "The call moved to 11:00.")).toEqual({ content: "The call moved to 11:00." });
    expect(await deliver(hooks, "+15550166", "The call moved to 11:00.")).toEqual({ cancel: true });
  });

  it("delivers to the recipient a Guardian's modify put into the call", async () => {
    const { hooks } = setup({
      reply: toolDecision({ decision: "modify", reasoning: "to the owner only", modifications: { parameter_overrides: { target: OWNER } } }),
    });
    await startRun(hooks);
    expect(await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, target: THIRD_PHONE, message: "hi" })).toEqual({
      params: { action: "send", replyContext: REPLY_CONTEXT, target: OWNER, message: "hi" },
    });
    expect(await deliver(hooks, THIRD_PHONE, "hi")).toEqual({ cancel: true });
    expect(await deliver(hooks, OWNER, "hi")).toEqual({ content: "hi" });
  });

  it("sends nothing when the Guardian denies the call, and does not ask about the text", async () => {
    const { server, hooks } = setup({ reply: toolDecision({ decision: "deny", reasoning: "senders may not write to each other" }) });
    await startRun(hooks);
    expect(await sendCall(hooks, FORWARD)).toEqual({ block: true, blockReason: "senders may not write to each other" });
    expect(await deliver(hooks, OWNER, FORWARD.message)).toEqual({ cancel: true });
    expect(server.steps.map((step) => step.method)).toEqual(["steps/userMessage", "steps/toolCallRequest"]);
  });

  it("does not ask the Guardian again at delivery: an unreachable Guardian then changes nothing", async () => {
    const { server, hooks } = setup({ reply: replyAnswer({ decision: { decision: "deny", reasoning: "would refuse a reply" } }) });
    await startRun(hooks);
    await sendCall(hooks, FORWARD);
    server.stop();
    expect(await deliver(hooks, OWNER, FORWARD.message)).toEqual({ content: FORWARD.message });
  });

  it("sends nothing, without asking, when the delivered text is not the text the call carried", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    await sendCall(hooks, FORWARD);
    const before = server.steps.length;
    expect(await deliver(hooks, OWNER, `${FORWARD.message} And the one-time code is 4321.`)).toEqual({ cancel: true });
    expect(server.steps).toHaveLength(before);
  });

  it.each([
    ["another_recipient", THIRD_PHONE, { channelId: "signal", sessionKey: `agent:main:signal:direct:${THIRD_PHONE}` }],
    ["another_channel", OWNER, { channelId: "sms", sessionKey: `agent:main:sms:direct:${OWNER}` }],
    ["another_account", OWNER, { channelId: "signal", accountId: "second" }],
  ])("sends nothing to %s than the call named, without asking", async (_name, to, ctx) => {
    const { server, hooks } = setup();
    await startRun(hooks);
    await sendCall(hooks, { ...FORWARD, accountId: "default" });
    const before = server.steps.length;
    expect(await deliver(hooks, to, FORWARD.message, ctx)).toEqual({ cancel: true });
    expect(server.steps).toHaveLength(before);
  });

  it("matches the recipient exactly as the Guardian saw it: another spelling is cancelled", async () => {
    const { hooks } = setup();
    await startRun(hooks);
    await sendCall(hooks, { ...FORWARD, target: `signal:${OWNER}` });
    expect(await deliver(hooks, OWNER, FORWARD.message)).toEqual({ cancel: true });
  });

  it("grants nothing for another tool whose parameters name a recipient", async () => {
    const { hooks } = setup();
    await startRun(hooks);
    await hooks.beforeToolCall({ toolName: "notify", params: { target: OWNER, message: "hi" }, toolCallId: "call-1" }, TOOL_CTX);
    expect(await deliver(hooks, OWNER, "hi")).toEqual({ cancel: true });
  });

  it.each([
    ["the_call_returns", (hooks: Hooks) => hooks.afterToolCall({ toolName: "message", toolCallId: "call-1" }, TOOL_CTX)],
    ["the_run_ends", (hooks: Hooks) => hooks.agentEnd({ runId: "run-1" }, AGENT_CTX)],
    ["the_session_ends", (hooks: Hooks) => hooks.sessionEnd({ sessionKey: SESSION_KEY, sessionId: SESSION_ID }, {})],
  ])("sends nothing to the recipient once %s", async (_name, change) => {
    const { hooks } = setup();
    await startRun(hooks);
    await sendCall(hooks, FORWARD);
    await change(hooks);
    expect(await deliver(hooks, OWNER, FORWARD.message)).toEqual({ cancel: true });
  });

  it("grants nothing to a call whose run ended while the Guardian decided it", async () => {
    const held = heldAnswer();
    const { hooks } = setup({ reply: (step) => (step.method === "steps/toolCallRequest" ? held.answer() : { decision: { decision: "allow" } }) });
    await startRun(hooks);
    const call = sendCall(hooks, FORWARD);
    await held.reached;
    await hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    held.release();
    expect(await call).toMatchObject({ block: true });
    expect(await deliver(hooks, OWNER, FORWARD.message)).toEqual({ cancel: true });
  });

  it("tells two runs' calls to one recipient apart by their text, and sends nothing it cannot attribute", async () => {
    const { server, hooks } = setup();
    const otherSender = "+15550144";
    const otherCtx = { runId: "run-g", sessionKey: `agent:main:signal:direct:${otherSender}`, sessionId: "session-g", senderId: otherSender, channel: "signal" };
    await startRun(hooks);
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: otherSender }, otherCtx)).toBeUndefined();
    await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, target: OWNER, message: "From the first sender" });
    await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, target: OWNER, message: "From the second sender" }, { runId: "run-g", sessionKey: otherCtx.sessionKey }, "call-2");

    expect(await deliver(hooks, OWNER, "From the second sender")).toEqual({ content: "From the second sender" });
    expect(await deliver(hooks, OWNER, "From the first sender")).toEqual({ content: "From the first sender" });
    expect(await deliver(hooks, OWNER, "Reformatted text")).toEqual({ cancel: true });
    expect(server.steps.some((step) => step.method === "steps/agentResponse")).toBe(false);
  });

  // OpenClaw trims the tool's text (`parseInlineDirectives`) and collapses blank
  // lines (`sanitizeForPlainText`) before `message_sending`.
  it("delivers under the grant the call's words as OpenClaw re-spaces them", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, target: OWNER, message: "\n  The call moved to 11:00.\n\n\n\nThe one-time code is 4321.\n" });
    const delivered = "The call moved to 11:00.\n\nThe one-time code is 4321.";
    expect(await deliver(hooks, OWNER, delivered)).toEqual({ content: delivered });
    expect(server.steps.map((step) => step.method)).toEqual(["steps/userMessage", "steps/toolCallRequest"]);
  });

  it.each([
    ["a_word_more", "The call moved to 11:00. The one-time code is 4321. Bring cash."],
    ["a_word_less", "The call moved to 11:00. The one-time code is"],
    ["a_word_split", "The call moved to 11:00. The one-time code is 43 21."],
  ])("sends nothing when the delivered text has %s than the call's", async (_name, delivered) => {
    const { hooks } = setup();
    await startRun(hooks);
    await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, target: OWNER, message: "The call moved to 11:00. The one-time code is 4321." });
    expect(await deliver(hooks, OWNER, delivered)).toEqual({ cancel: true });
  });
});

describe("message tool: a send to the session's own sender is the call's action", () => {
  /** Denies every reply at `steps/agentResponse` and answers every tool call with `decision`. */
  const decidedAtTheCall = (decision: Record<string, unknown>) => (step: ReceivedStep): Reply =>
    step.method === "steps/agentResponse"
      ? { decision: { decision: "deny", reasoning: "a person gets only what a message call sent" } }
      : step.method === "steps/toolCallRequest"
        ? { decision }
        : { decision: { decision: "allow" } };
  const ASK_DECISION = { decision: "ask", reasoning: "r", ask_details: { approver: { type: "human", id: "approver-1" }, question: "Send?", timeout_seconds: 60 } };
  const methods = (server: FakeAcsServer) => server.steps.map((step) => step.method);

  it.each([
    ["names_the_sender", { action: "send", replyContext: REPLY_CONTEXT, target: SENDER, message: "The call is at 15:00." }],
    ["names_no_recipient", { action: "send", replyContext: REPLY_CONTEXT, message: "The call is at 15:00." }],
    ["names_no_recipient_on_the_runs_channel", { action: "send", replyContext: REPLY_CONTEXT, channel: "signal", message: "The call is at 15:00." }],
  ])("delivers an allowed call that %s under its grant, without a steps/agentResponse", async (_name, params) => {
    const { server, hooks } = setup({ reply: decidedAtTheCall({ decision: "allow" }), blockedReplyText: null });
    await startRun(hooks);
    expect(await sendCall(hooks, params)).toEqual({ params });
    expect(await deliver(hooks, SENDER, "The call is at 15:00.", MESSAGE_CTX)).toEqual({ content: "The call is at 15:00." });
    expect(methods(server)).toEqual(["steps/userMessage", "steps/toolCallRequest"]);
  });

  it("delivers a call a person approved under its grant, without a steps/agentResponse", async () => {
    const { server, hooks } = setup({ reply: decidedAtTheCall(ASK_DECISION), blockedReplyText: null });
    await startRun(hooks);
    const result = await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, message: "Your refund is on its way." });
    await result!.requireApproval!.onResolution!("allow-once");
    expect(await deliver(hooks, SENDER, "Your refund is on its way.", MESSAGE_CTX)).toEqual({ content: "Your refund is on its way." });
    expect(methods(server)).toEqual(["steps/userMessage", "steps/toolCallRequest"]);
  });

  it("delivers an approved answer that OpenClaw trims on the way under its grant, without a steps/agentResponse", async () => {
    const { server, hooks } = setup({ reply: decidedAtTheCall(ASK_DECISION), blockedReplyText: null });
    await startRun(hooks);
    const result = await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, message: "Your refund is on its way.\n" });
    await result!.requireApproval!.onResolution!("allow-once");
    expect(await deliver(hooks, SENDER, "Your refund is on its way.", MESSAGE_CTX)).toEqual({ content: "Your refund is on its way." });
    expect(methods(server)).toEqual(["steps/userMessage", "steps/toolCallRequest"]);
  });

  it("grants nothing to a call that names no recipient on another channel", async () => {
    const { server, hooks } = setup({ reply: decidedAtTheCall({ decision: "allow" }), blockedReplyText: null });
    await startRun(hooks);
    await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, channel: "sms", message: "hi" });
    expect(await deliver(hooks, SENDER, "hi", MESSAGE_CTX)).toEqual({ cancel: true });
    expect(methods(server).at(-1)).toBe("steps/agentResponse");
  });

  it("sends the text OpenClaw writes after a denied call as steps/agentResponse, and on deny cancels it with no text in its place", async () => {
    const { server, hooks, audit } = setup({ reply: decidedAtTheCall({ decision: "deny", reasoning: "not before the host answers" }), blockedReplyText: null });
    await startRun(hooks);
    expect(await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, message: "Your refund is on its way." })).toMatchObject({ block: true });
    expect(await deliver(hooks, SENDER, "I could not send that; the host will answer you.", MESSAGE_CTX)).toEqual({ cancel: true });
    expect(server.steps.at(-1)).toMatchObject({
      method: "steps/agentResponse",
      userContext: { user_id: SENDER, authentication_method: "signal" },
      payload: { content: [{ type: "text", value: "I could not send that; the host will answer you." }] },
    });
    expect(audit).toEqual([]);
  });

  it.each<"deny" | "timeout" | "cancelled">(["deny", "timeout", "cancelled"])(
    "sends the text OpenClaw writes after an approval's %s as steps/agentResponse, and on deny cancels it",
    async (resolution) => {
      const { server, hooks } = setup({ reply: decidedAtTheCall(ASK_DECISION), blockedReplyText: null });
      await startRun(hooks);
      const result = await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, message: "Your refund is on its way." });
      await result!.requireApproval!.onResolution!(resolution);
      expect(await deliver(hooks, SENDER, "Your refund is on its way.", MESSAGE_CTX)).toEqual({ cancel: true });
      expect(methods(server).at(-1)).toBe("steps/agentResponse");
    },
  );

  it("sends a configured blockedReplyText in place of the denied delivery", async () => {
    const { hooks } = setup({ reply: decidedAtTheCall({ decision: "deny", reasoning: "no" }) });
    await startRun(hooks);
    await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, message: "hi" });
    expect(await deliver(hooks, SENDER, "hi", MESSAGE_CTX)).toEqual({ content: BLOCKED });
  });
});

describe("message tool: a grant covers only the send the Guardian saw", () => {
  const FORWARD = { action: "send", replyContext: REPLY_CONTEXT, target: OWNER, message: "Screenshot of the error" };

  it("sends a sender's forward to an owner with an admitted session as the sender's, not as the owner's own reply", async () => {
    const { server, hooks } = setup();
    expect(await hooks.beforeAgentRun({ prompt: "Hi", senderId: OWNER }, OWNER_AGENT_CTX)).toBeUndefined();
    await hooks.agentEnd({ runId: "run-o" }, OWNER_AGENT_CTX);
    await startRun(hooks);
    await sendCall(hooks, FORWARD);
    expect(await deliver(hooks, OWNER, FORWARD.message, { channelId: "signal", sessionKey: OWNER_KEY })).toEqual({ content: FORWARD.message });
    expect(server.steps.at(-1)).toMatchObject({ method: "steps/toolCallRequest", turnId: "run-1", userContext: { user_id: SENDER } });
  });

  it("keeps the owner's own reply in their chat as theirs, while a sender's grant to them is live", async () => {
    const { server, hooks } = setup({
      reply: (step) =>
        step.method === "steps/agentResponse" && (step.userContext as { user_id: string }).user_id === OWNER
          ? { decision: { decision: "deny", reasoning: "no" } }
          : { decision: { decision: "allow" } },
    });
    await startRun(hooks);
    await sendCall(hooks, FORWARD);
    expect(await hooks.beforeAgentRun({ prompt: "Status?", senderId: OWNER }, OWNER_AGENT_CTX)).toBeUndefined();
    expect(await deliver(hooks, OWNER, "Your own answer", { channelId: "signal", sessionKey: OWNER_KEY })).toEqual({ content: BLOCKED });
    expect(server.steps.at(-1)).toMatchObject({ method: "steps/agentResponse", turnId: "run-o", userContext: { user_id: OWNER } });
    // The sender's forward, with the text the Guardian saw, is still the sender's.
    const before = server.steps.length;
    expect(await deliver(hooks, OWNER, FORWARD.message, { channelId: "signal", sessionKey: OWNER_KEY })).toEqual({ content: FORWARD.message });
    expect(server.steps).toHaveLength(before);
  });

  it.each(["read", "react", "delete", "poll"])("grants nothing to a %s call that names a recipient", async (action) => {
    const { hooks } = setup();
    await startRun(hooks);
    await sendCall(hooks, { action, target: OWNER, message: "hi" });
    expect(await deliver(hooks, OWNER, "hi")).toEqual({ cancel: true });
  });

  it("delivers only on the run's own account when the call names none", async () => {
    const { hooks } = setup();
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, { ...AGENT_CTX, accountId: "default" })).toBeUndefined();
    await sendCall(hooks, FORWARD);
    expect(await deliver(hooks, OWNER, FORWARD.message, { channelId: "signal", accountId: "second" })).toEqual({ cancel: true });
    expect(await deliver(hooks, OWNER, FORWARD.message, { channelId: "signal", accountId: "default" })).toEqual({ content: FORWARD.message });
  });

  it("delivers under an approval only the text the person approved", async () => {
    const { hooks } = setup({
      reply: toolDecision({ decision: "ask", reasoning: "r", ask_details: { approver: { type: "human", id: "approver-1" }, question: "Forward?", timeout_seconds: 60 } }),
    });
    await startRun(hooks);
    const result = await sendCall(hooks, FORWARD);
    await result!.requireApproval!.onResolution!("allow-once");
    expect(await deliver(hooks, OWNER, "Another text")).toEqual({ cancel: true });
    expect(await deliver(hooks, OWNER, FORWARD.message)).toEqual({ content: FORWARD.message });
  });
});

describe("message tool: an approval covers one recipient and one text", () => {
  const ASK = toolDecision({
    decision: "ask",
    reasoning: "a sender's screenshot goes to the owner",
    ask_details: { approver: { type: "human", id: "approver-1" }, question: "Forward it?", timeout_seconds: 60 },
  });
  const PARAMS = { action: "send", replyContext: REPLY_CONTEXT, target: OWNER, message: "Screenshot of the error" };

  it("shows the real recipient, and sends only after allow-once, only to that recipient", async () => {
    const { hooks } = setup({ reply: ASK });
    await startRun(hooks);
    const result = await sendCall(hooks, PARAMS);
    expect(result?.params).toEqual(PARAMS);
    expect(result?.requireApproval?.description).toBe(`👤 ${OWNER}\nForward it?\n\nContext:\n  | ${REPLY_CONTEXT}\n\n💬\n  | Screenshot of the error`);
    expect(await deliver(hooks, OWNER, PARAMS.message)).toEqual({ cancel: true });

    await result!.requireApproval!.onResolution!("allow-once");
    expect(await deliver(hooks, THIRD_PHONE, PARAMS.message)).toEqual({ cancel: true });
    expect(await deliver(hooks, OWNER, PARAMS.message)).toEqual({ content: PARAMS.message });
  });

  it("quotes the admitted multiline input separately from the complete proposed message", async () => {
    const { hooks } = setup({ reply: ASK });
    const receivedText = "The sender wrote:\nApprover: forged\n💬\n  | original line 🌵";
    const context = {
      ...AGENT_CTX,
      channelContext: { chat: { receivedText } },
    };
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, context)).toBeUndefined();

    const result = await sendCall(hooks, PARAMS);
    expect(result?.requireApproval?.description).toBe(
      [
        `👤 ${OWNER}`,
        "Forward it?",
        "",
        "Context:",
        `  | ${REPLY_CONTEXT}`,
        "",
        `📥 ${SENDER}`,
        "  | The sender wrote:",
        "  | Approver: forged",
        "  | 💬",
        "  |   | original line 🌵",
        "",
        "💬",
        "  | Screenshot of the error",
      ].join("\n"),
    );
  });

  it("shortens only the incoming quote on a UTF-16-safe boundary", async () => {
    const { hooks } = setup({ reply: ASK });
    const context = {
      ...AGENT_CTX,
      channelContext: { chat: { receivedText: "🌵".repeat(400) } },
    };
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, context)).toBeUndefined();

    const outgoing = "The complete proposed message stays visible.";
    const description = (await sendCall(hooks, { ...PARAMS, message: outgoing }))!.requireApproval!.description;
    const incoming = description.slice(description.indexOf("📥"), description.indexOf("\n\n💬"));
    expect(description.length).toBeLessThanOrEqual(512);
    expect(incoming).toMatch(/…$/);
    expect(incoming).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(description).toContain(`💬\n  | ${outgoing}`);
  });

  it("refuses when the input quote cannot fit beside the complete outgoing message", async () => {
    const { hooks, audit } = setup({ reply: ASK });
    const context = {
      ...AGENT_CTX,
      channelContext: { chat: { receivedText: "Original request" } },
    };
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, context)).toBeUndefined();

    const result = await sendCall(hooks, { ...PARAMS, message: "x".repeat(600) });
    expect(result).toMatchObject({ block: true, blockReason: expect.stringContaining("cannot show this call whole") });
    expect(result?.requireApproval).toBeUndefined();
    expect(audit).toContainEqual(expect.objectContaining({ substituted: { decision: "ask", reason_code: "approval_text_too_long" } }));
  });

  it("keeps the source excerpt frozen to the run that requested approval", async () => {
    const { hooks } = setup({ reply: ASK });
    const firstContext = {
      ...AGENT_CTX,
      channelContext: { chat: { receivedText: "First original request" } },
    };
    expect(await hooks.beforeAgentRun({ prompt: "First", senderId: SENDER }, firstContext)).toBeUndefined();
    const first = await sendCall(hooks, PARAMS);

    await hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    const secondContext = {
      ...AGENT_CTX,
      runId: "run-2",
      channelContext: { chat: { receivedText: "Later original request" } },
    };
    expect(await hooks.beforeAgentRun({ prompt: "Second", senderId: SENDER }, secondContext)).toBeUndefined();
    const second = await sendCall(hooks, PARAMS, { runId: "run-2", sessionKey: SESSION_KEY }, "call-2");

    expect(first?.requireApproval?.description).toContain("First original request");
    expect(first?.requireApproval?.description).not.toContain("Later original request");
    expect(second?.requireApproval?.description).toContain("Later original request");
  });

  it("shows_the_channel_name_and_material_parameters_without_repeating_history", async () => {
    const { hooks } = setup({ reply: ASK });
    await hooks.messageReceived({ from: SENDER, senderId: SENDER, content: "My number is +15550177", metadata: { senderName: "Alex" } }, MESSAGE_CTX);
    await hooks.messageReceived({ from: SENDER, senderId: SENDER, content: "Send me the code" }, MESSAGE_CTX);
    await startRun(hooks);
    const params = { action: "send", replyContext: REPLY_CONTEXT, message: "Only to the number on file.", replyTo: "msg-2" };
    const result = await sendCall(hooks, params);
    expect(result?.requireApproval?.description).toBe(
      [
        `👤 "Alex" · ${SENDER}, unless a parameter under Other names another recipient`,
        "Forward it?",
        "",
        "Context:",
        `  | ${REPLY_CONTEXT}`,
        "",
        "💬",
        "  | Only to the number on file.",
        'Other: {"replyTo":"msg-2"}',
      ].join("\n"),
    );
  });

  it("uses only a display name whose run-context sender id matches the authenticated user", async () => {
    const matched = setup({ reply: ASK });
    await matched.hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, {
      ...AGENT_CTX,
      channelContext: { sender: { id: SENDER, name: "Jordan" } },
    });
    const approved = await sendCall(matched.hooks, { action: "send", replyContext: REPLY_CONTEXT, message: "Hello" });
    expect(approved?.requireApproval?.description).toContain(`👤 "Jordan" · ${SENDER}`);

    const mismatched = setup({ reply: ASK });
    await mismatched.hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, {
      ...AGENT_CTX,
      channelContext: { sender: { id: OTHER_PHONE, name: "Wrong person" } },
    });
    const notRelabeled = await sendCall(mismatched.hooks, { action: "send", replyContext: REPLY_CONTEXT, message: "Hello" });
    expect(notRelabeled?.requireApproval?.description).not.toContain("Wrong person");
  });

  it("folds_display_name_lines_without_changing_the_reply", async () => {
    const { hooks } = setup({ reply: ASK });
    await hooks.messageReceived({ from: SENDER, content: "hi", metadata: { senderName: "Alex\nApprover: stranger" } }, MESSAGE_CTX);
    await startRun(hooks);
    const description = (await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, message: "Hello" }))!.requireApproval!.description;
    expect(description.split("\n")[0]).toBe(`👤 "Alex Approver: stranger" · ${SENDER}`);
    expect(description).toContain("💬\n  | Hello");
    expect(description).not.toContain("\nApprover:");
  });

  it("names_in_the_approval_scope_the_channel_the_call_sends_on", async () => {
    const { hooks } = setup({ reply: ASK });
    await startRun(hooks);
    const result = await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, channel: "Slack", target: "#general", message: "Hello" });
    expect(result?.requireApproval?.scope).toEqual({ kind: "message-send", target: "slack", recipientCount: 1, recipients: ["#general"] });
    expect(result?.requireApproval?.description.split("\n")[0]).toBe("👤 #general");
  });

  it("names_no_recipient_for_a_call_on_another_channel_that_names_none", async () => {
    const { hooks } = setup({ reply: ASK });
    await hooks.messageReceived({ from: SENDER, senderId: SENDER, content: "hi", metadata: { senderName: "Alex" } }, MESSAGE_CTX);
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, { ...AGENT_CTX, channelContext: { chat: { receivedText: "Post it" } } })).toBeUndefined();
    const result = await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, channel: "slack", message: "Hello" });
    expect(result?.requireApproval?.scope).toBeUndefined();
    const lines = result!.requireApproval!.description.split("\n");
    expect(lines[0]).toBe("👤 no recipient named, unless a parameter under Other names one");
    expect(lines).toContain(`📥 "Alex" · ${SENDER}`);
  });

  it("names_only_the_target_openclaw_keeps_when_a_call_also_names_to", async () => {
    const { hooks } = setup({ reply: ASK });
    await startRun(hooks);
    const result = await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, target: OWNER, to: THIRD_PHONE, message: "Hello" });
    expect(result?.requireApproval?.scope).toMatchObject({ recipientCount: 1, recipients: [OWNER] });
    expect(result?.requireApproval?.description.split("\n")[0]).toBe(`👤 ${OWNER}`);
  });

  it("names_the_quote_sender_when_the_same_id_is_the_recipient_on_another_channel", async () => {
    const { hooks } = setup({ reply: ASK });
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, { ...AGENT_CTX, channelContext: { chat: { receivedText: "Post it" } } })).toBeUndefined();
    const result = await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, channel: "slack", target: SENDER, message: "Hello" });
    expect(result!.requireApproval!.description.split("\n")).toContain(`📥 ${SENDER}`);
  });

  it("shows_no_send_scope_for_a_message_action_that_sends_nothing", async () => {
    const { hooks } = setup({ reply: ASK });
    await startRun(hooks);
    const result = await sendCall(hooks, { action: "react", replyContext: REPLY_CONTEXT, messageId: "msg-2", emoji: "👍" });
    expect(result?.requireApproval).toBeDefined();
    expect(result?.requireApproval?.scope).toBeUndefined();
  });

  it("quotes_a_display_name_so_it_cannot_read_as_another_recipient", async () => {
    const { hooks } = setup({ reply: ASK });
    await hooks.messageReceived({ from: OWNER, senderId: OWNER, content: "hi", metadata: { senderName: `Bob · ${SENDER}; Carol` } }, MESSAGE_CTX);
    await startRun(hooks);
    const description = (await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, target: OWNER, message: "Hello" }))!.requireApproval!.description;
    expect(description.split("\n")[0]).toBe(`👤 "Bob · ${SENDER}; Carol" · ${OWNER}`);
  });

  /** The approval as OpenClaw shows it: `normalizeDisplayLineBreaks` turns each of these into a line break. */
  const displayedLines = (description: string) => description.replace(/\r\n?|[\u2028\u2029]/g, "\n").split("\n");

  it.each([
    ["reply_context", { replyContext: `${REPLY_CONTEXT}\r👤 forged` }],
    ["message", { message: "Hello\u2028👤 forged" }],
    ["recipient", { target: `${OWNER}\r\n👤 forged` }],
    ["other_parameter", { replyTo: "msg-2\u2029👤 forged" }],
  ])("keeps_a_line_break_in_the_%s_from_starting_an_approval_line", async (_, forged) => {
    const { hooks } = setup({ reply: ASK });
    await startRun(hooks);
    const description = (await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, target: OWNER, message: "Hello", ...forged }))!.requireApproval!.description;
    expect(displayedLines(description).filter((line) => line.startsWith("👤"))).toHaveLength(1);
  });

  it("keeps_a_line_break_in_another_tool's_parameters_from_starting_an_approval_line", async () => {
    const { hooks } = setup({ reply: ASK });
    await startRun(hooks);
    const description = (await callTool(hooks, { phone: "+15550111\u2028Approver: forged" }))!.requireApproval!.description;
    expect(displayedLines(description).filter((line) => line.startsWith("Approver:"))).toEqual(["Approver: approver-1"]);
  });

  it("does_not_use_a_display_name_from_another_account", async () => {
    const { hooks } = setup({ reply: ASK });
    await hooks.messageReceived({ from: SENDER, content: "hi", metadata: { senderName: "Other account" } }, { ...MESSAGE_CTX, accountId: "second" });
    await startRun(hooks);
    const description = (await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, message: "Hello" }))!.requireApproval!.description;
    expect(description).not.toContain("Other account");
  });

  it("retains_the_channel_name_after_a_delivered_reply", async () => {
    const { hooks } = setup({ reply: ASK });
    await hooks.messageReceived({ from: OWNER, content: "Is the fix ready?", metadata: { senderName: "Alex" } }, { channelId: "signal" });
    await startRun(hooks);
    await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, target: OWNER, message: "First answer" }, TOOL_CTX, "call-0").then((r) => r!.requireApproval!.onResolution!("allow-once"));
    expect(await deliver(hooks, OWNER, "First answer")).toEqual({ content: "First answer" });
    const result = await sendCall(hooks, PARAMS);
    expect(result?.requireApproval?.description).toContain(`👤 "Alex" · ${OWNER}`);
  });

  it("keeps_the_complete_reply_without_appending_received_messages", async () => {
    const { hooks } = setup({ reply: ASK });
    for (let i = 1; i <= 6; i += 1) {
      await hooks.messageReceived({ from: SENDER, content: `${i} ${"x".repeat(90)}` }, MESSAGE_CTX);
    }
    await startRun(hooks);
    const params = { action: "send", replyContext: REPLY_CONTEXT, message: "y".repeat(200) };
    const description = (await sendCall(hooks, params))!.requireApproval!.description;
    expect(description.length).toBeLessThanOrEqual(512);
    expect(description).toContain(`💬\n  | ${"y".repeat(200)}`);
    expect(description).not.toContain("x".repeat(90));
  });

  it.each<"deny" | "timeout" | "cancelled">(["deny", "timeout", "cancelled"])("sends nothing after %s", async (resolution) => {
    const { hooks } = setup({ reply: ASK });
    await hooks.beforeAgentRun(
      { prompt: "Hello", senderId: SENDER },
      { ...AGENT_CTX, channelContext: { chat: { receivedText: "The original request" } } },
    );
    const result = await sendCall(hooks, PARAMS);
    await result!.requireApproval!.onResolution!(resolution);
    expect(await deliver(hooks, OWNER, PARAMS.message)).toEqual({ cancel: true });
  });

  it("sends nothing after an approval that arrives once the run has ended", async () => {
    const { hooks } = setup({ reply: ASK });
    await startRun(hooks);
    const result = await sendCall(hooks, PARAMS);
    await hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    await result!.requireApproval!.onResolution!("allow-once");
    expect(await deliver(hooks, OWNER, PARAMS.message)).toEqual({ cancel: true });
  });
});

describe("failure posture closed: no decision, no action", () => {
  const unreachable = async (): Promise<Setup> => {
    const setupResult = setup();
    setupResult.server.stop();
    return setupResult;
  };

  it("blocks a run when the Guardian is unreachable", async () => {
    const { hooks, audit } = await unreachable();
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX)).toMatchObject({ outcome: "block", message: BLOCKED });
    expect(audit).toEqual([expect.objectContaining({ outcome: "blocked", posture_source: "host" })]);
  });

  it("replaces a reply when the Guardian goes away after the run started", async () => {
    const { server, hooks, audit } = setup();
    await startRun(hooks);
    server.stop();
    expect(await hooks.messageSending({ to: SENDER, content: "hi" }, MESSAGE_CTX)).toEqual({ content: BLOCKED });
    expect(audit).toEqual([expect.objectContaining({ outcome: "blocked", method: "steps/agentResponse", posture_source: "host" })]);
  });

  it("blocks a tool call when the Guardian goes away after the run started", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    server.stop();
    expect(await callTool(hooks)).toMatchObject({ block: true });
  });

  it.each<[string, Reply]>([
    ["malformed", { body: "this is not json" }],
    ["unsigned", { unsignedDecision: { decision: "allow" } }],
    ["an_error_without_a_decision", { error: { code: -32603, message: "internal" } }],
    ["a_result_without_a_decision", { decision: { reasoning: "no verdict" } }],
  ])("replaces the reply when the Guardian's answer is %s", async (_name, answer) => {
    const { hooks } = setup({ reply: replyAnswer(answer) });
    await startRun(hooks);
    expect(await hooks.messageSending({ to: SENDER, content: "hi" }, MESSAGE_CTX)).toEqual({ content: BLOCKED });
  });

  it("replaces the reply itself when the Guardian answers after the deadline", async () => {
    const { hooks } = setup({ reply: replyAnswer({ hang: true }), deadlineMs: 300 });
    await startRun(hooks);
    const startedAt = performance.now();
    expect(await hooks.messageSending({ to: SENDER, content: "hi" }, MESSAGE_CTX)).toEqual({ content: BLOCKED });
    expect(performance.now() - startedAt).toBeLessThan(1500);
  });

  it("blocks when the Guardian cannot verify this host's signature", async () => {
    const wrongKey: SigningKey = { ...KEY, secret: Buffer.from("another secret of thirty-two bytes!", "utf8") };
    const { server, hooks } = setup({ clientKey: wrongKey });
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX)).toMatchObject({ outcome: "block" });
    expect(server.badSignatures).toBe(1);
  });

  it("blocks over a negotiated proceed", async () => {
    const { hooks } = setup({ reply: replyAnswer({ hang: true }), deadlineMs: 300, onDecisionFailure: "proceed" });
    await startRun(hooks);
    expect(await hooks.messageSending({ to: SENDER, content: "hi" }, MESSAGE_CTX)).toEqual({ content: BLOCKED });
  });
});

describe("failure posture negotiated", () => {
  it("proceeds, audited, when the Guardian negotiated proceed and then went silent", async () => {
    const { hooks, audit } = setup({ reply: replyAnswer({ hang: true }), deadlineMs: 300, onDecisionFailure: "proceed", failurePosture: "negotiated" });
    await startRun(hooks);
    expect(await hooks.messageSending({ to: SENDER, content: "hi" }, MESSAGE_CTX)).toEqual({ content: "hi" });
    expect(audit).toEqual([expect.objectContaining({ outcome: "proceeded", posture: "proceed", posture_source: "negotiated" })]);
  });

  it("blocks when the Guardian negotiated deny", async () => {
    const { hooks } = setup({ reply: replyAnswer({ hang: true }), deadlineMs: 300, onDecisionFailure: "deny", failurePosture: "negotiated" });
    await startRun(hooks);
    expect(await hooks.messageSending({ to: SENDER, content: "hi" }, MESSAGE_CTX)).toEqual({ content: BLOCKED });
  });
});

describe("methods the Guardian does not evaluate", () => {
  it("allows a method missing from methods_evaluated without sending it", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ["steps/toolCallRequest"] });
    await startRun(hooks);
    expect(await hooks.messageSending({ to: SENDER, content: "hi" }, MESSAGE_CTX)).toEqual({ content: "hi" });
    expect(await callTool(hooks)).toEqual({ params: { phone: OTHER_PHONE } });
    expect(server.steps.map((step) => step.method)).toEqual(["steps/toolCallRequest"]);
  });
});

describe("session", () => {
  it("negotiates once per session and again, once, when the Guardian forgot it", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    expect(server.handshakes).toBe(1);
    server.forgetSessions();
    expect(await callTool(hooks)).toEqual({ params: { phone: OTHER_PHONE } });
    expect(server.handshakes).toBe(2);
  });

  it("follows the posture when the Guardian still does not know the session after a new handshake", async () => {
    const { server, hooks } = setup({
      reply: (step) =>
        step.method === "steps/toolCallRequest"
          ? { error: { code: -32003, message: "not negotiated" } }
          : { decision: { decision: "allow" } },
    });
    await startRun(hooks);
    expect(await callTool(hooks)).toMatchObject({ block: true });
    expect(server.handshakes).toBe(2);
  });

  it("ends the ACS session with OpenClaw's, and governs the reused session key under a new one", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS });
    await startRun(hooks);
    await hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    await hooks.sessionEnd({ sessionKey: SESSION_KEY, sessionId: SESSION_ID, reason: "reset" }, {});
    const next = { ...AGENT_CTX, runId: "run-2", sessionId: "session-2" };
    expect(await hooks.beforeAgentRun({ prompt: "Hello again", senderId: SENDER }, next)).toBeUndefined();
    expect(await hooks.beforeToolCall({ toolName: "account-lookup", params: {} }, { runId: "run-2", sessionKey: SESSION_KEY, sessionId: "session-2" })).toEqual({
      params: {},
    });
    expect(await hooks.messageSending({ to: SENDER, content: "hi" }, MESSAGE_CTX)).toEqual({ content: "hi" });
    const ended = server.steps.find((step) => step.method === "steps/sessionEnd");
    expect(ended?.payload).toEqual({ reason: "completed" });
    const later = server.steps.slice(server.steps.indexOf(ended!) + 1);
    expect(later.every((step) => step.sessionId !== ended!.sessionId)).toBe(true);
    expect(new Set(later.map((step) => step.sessionId)).size).toBe(1);
  });

  it("sends no sessionEnd for a session it admitted no run to", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS });
    await hooks.sessionEnd({ sessionKey: SESSION_KEY, sessionId: SESSION_ID }, {});
    expect(server.steps).toHaveLength(0);
  });

  it("blocks a tool call that names another OpenClaw session than its run", async () => {
    const { hooks } = setup();
    await startRun(hooks);
    expect(await hooks.beforeToolCall({ toolName: "account-lookup", params: {} }, { runId: "run-1", sessionId: "session-9" })).toMatchObject({
      block: true,
    });
  });

  it("uses one ACS session id per OpenClaw session key", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    await hooks.messageSending({ to: SENDER, content: "hi" }, MESSAGE_CTX);
    const ids = new Set(server.steps.map((step) => step.sessionId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

/** An admission store kept in a map that outlives the hooks, as a store on disk outlives a process. */
function mapStore(): AdmissionStore & { rows: Map<string, Admission> } {
  const rows = new Map<string, Admission>();
  return {
    rows,
    async load() {
      return [...rows];
    },
    async put(sessionKey, admission) {
      rows.set(sessionKey, admission);
    },
    async delete(sessionKey) {
      rows.delete(sessionKey);
    },
  };
}

const NO_SENDER_CTX = { runId: "run-2", sessionKey: SESSION_KEY, sessionId: SESSION_ID, trigger: "cron" };

describe("a run with no channel sender acts for the person OpenClaw names", () => {
  it("governs a scheduled run in a session admitted to its sender as that sender", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS });
    await startRun(hooks);
    await hooks.agentEnd({ runId: "run-1", success: true }, AGENT_CTX);
    const before = server.steps.length;
    expect(await hooks.beforeAgentRun({ prompt: "Reminder: send the weekly report" }, NO_SENDER_CTX)).toBeUndefined();
    const reminder = server.steps.filter((step) => step.turnId === "run-2");
    expect(server.steps.slice(before).find((step) => step.method === "steps/agentTrigger")?.payload).toMatchObject({ trigger_type: "scheduled" });
    expect(reminder.find((step) => step.method === "steps/turnStart")?.payload).toMatchObject({ triggered_by: "scheduled" });
    expect(reminder.find((step) => step.method === "steps/userMessage")?.userContext).toMatchObject({ user_id: SENDER });
    expect(await hooks.beforeToolCall({ toolName: "account-lookup", params: {} }, { runId: "run-2", sessionKey: SESSION_KEY })).toMatchObject({
      params: {},
    });
  });

  it("refuses a run with no sender in a session nobody was admitted to, or in a detached run session", async () => {
    const { server, hooks } = setup();
    expect(await hooks.beforeAgentRun({ prompt: "tick" }, NO_SENDER_CTX)).toMatchObject({ outcome: "block" });
    expect(
      await hooks.beforeAgentRun({ prompt: "tick" }, { ...NO_SENDER_CTX, sessionKey: "agent:main:cron:job-1:run:r-1" }),
    ).toMatchObject({ outcome: "block" });
    expect(server.steps).toHaveLength(0);
  });

  it("refuses a run with no sender that is not a scheduled run, in a session admitted to its sender", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    await hooks.agentEnd({ runId: "run-1", success: true }, AGENT_CTX);
    const before = server.steps.length;
    for (const trigger of ["heartbeat", "system", "hook", undefined]) {
      expect(await hooks.beforeAgentRun({ prompt: "tick" }, { ...NO_SENDER_CTX, trigger })).toMatchObject({ outcome: "block" });
    }
    expect(server.steps).toHaveLength(before);
  });

  it("refuses a run with no sender after its session was replaced under the same key", async () => {
    const { hooks } = setup();
    await startRun(hooks);
    await hooks.agentEnd({ runId: "run-1", success: true }, AGENT_CTX);
    expect(await hooks.beforeAgentRun({ prompt: "tick" }, { ...NO_SENDER_CTX, sessionId: "session-2" })).toMatchObject({
      outcome: "block",
    });
  });

  it("does not let a run with no sender admit its session for another person", async () => {
    const { hooks } = setup();
    await startRun(hooks);
    await hooks.agentEnd({ runId: "run-1", success: true }, AGENT_CTX);
    expect(await hooks.beforeAgentRun({ prompt: "tick" }, NO_SENDER_CTX)).toBeUndefined();
    expect(await hooks.messageSending({ to: OTHER_PHONE, content: "Hi" }, MESSAGE_CTX)).toEqual({ cancel: true });
  });

  it("governs an inter-session run as the sender of the session that sent it, while that session runs", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS });
    // Another agent's direct session with the same person.
    const target = { runId: "run-2", sessionKey: `agent:helper:signal:direct:${SENDER}`, sessionId: "session-9" };
    const relayed = { ...target, inputProvenance: { kind: "inter_session", sourceSessionKey: SESSION_KEY } };
    expect(await hooks.beforeAgentRun({ prompt: "Relay" }, relayed)).toMatchObject({ outcome: "block" });
    await startRun(hooks);
    const before = server.steps.length;
    expect(await hooks.beforeAgentRun({ prompt: "Relay" }, relayed)).toBeUndefined();
    const relay = server.steps.filter((step) => step.turnId === "run-2");
    expect(relay.find((step) => step.method === "steps/userMessage")?.userContext).toMatchObject({ user_id: SENDER });
    expect(server.steps.slice(before).find((step) => step.method === "steps/agentTrigger")?.payload).toMatchObject({ trigger_type: "external_event" });
    // The relay acts for the source's sender; it admits no send to that sender in the target's session.
    expect(await hooks.messageSending({ to: SENDER, content: "Hi" }, { channelId: "signal", sessionKey: target.sessionKey })).toEqual({
      cancel: true,
    });
  });

  it("refuses a relay into another person's session, admitted or not", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS });
    await startRun(hooks);
    const before = server.steps.length;
    const otherKey = `agent:main:signal:direct:${OTHER_PHONE}`;
    const relay = { runId: "run-5", sessionKey: otherKey, sessionId: "session-5", inputProvenance: { kind: "inter_session", sourceSessionKey: SESSION_KEY } };
    expect(await hooks.beforeAgentRun({ prompt: "Read the history" }, relay)).toMatchObject({ outcome: "block" });
    expect(server.steps).toHaveLength(before);
  });

  it("refuses a relay between equal ids on two channels", async () => {
    const { hooks } = setup({ methodsEvaluated: ALL_METHODS });
    await startRun(hooks);
    const telegramKey = `agent:main:telegram:direct:${SENDER}`;
    const relay = { runId: "run-6", sessionKey: telegramKey, sessionId: "session-6", inputProvenance: { kind: "inter_session", sourceSessionKey: SESSION_KEY } };
    expect(await hooks.beforeAgentRun({ prompt: "Relay" }, relay)).toMatchObject({ outcome: "block" });
  });
});

describe("a relay never acts in another person's session", () => {
  it("refuses an inter-session run into a session admitted to another person", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS });
    const otherKey = `agent:main:signal:direct:${OTHER_PHONE}`;
    const other = { runId: "run-3", sessionKey: otherKey, sessionId: "session-3", senderId: OTHER_PHONE, channel: "signal" };
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: OTHER_PHONE }, other)).toBeUndefined();
    await hooks.agentEnd({ runId: "run-3", success: true }, other);
    await startRun(hooks);
    const before = server.steps.length;
    const relayed = { runId: "run-4", sessionKey: otherKey, sessionId: "session-3", inputProvenance: { kind: "inter_session", sourceSessionKey: SESSION_KEY } };
    expect(await hooks.beforeAgentRun({ prompt: "Switch it on" }, relayed)).toMatchObject({ outcome: "block" });
    expect(server.steps).toHaveLength(before);
  });
});

describe("the agent that runs the session", () => {
  it("names the OpenClaw agent on every step of its run", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS });
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, { ...AGENT_CTX, agentId: "main" })).toBeUndefined();
    await callTool(hooks);
    expect(await hooks.messageSending({ to: SENDER, content: "Hi" }, MESSAGE_CTX)).toEqual({ content: "Hi" });
    expect(server.steps.length).toBeGreaterThan(0);
    expect(server.steps.every((step) => step.agentName === "main")).toBe(true);
  });
});

describe("admissions outlive the process", () => {
  it("sends to a person admitted before a restart", async () => {
    const store = mapStore();
    const before = setup({ admissions: store });
    await startRun(before.hooks);
    await before.hooks.sessionEnd({ sessionKey: SESSION_KEY, sessionId: SESSION_ID, reason: "shutdown" }, MESSAGE_CTX);
    expect(before.server.steps.map((step) => step.method)).not.toContain("steps/sessionEnd");
    expect(store.rows.get(SESSION_KEY)).toMatchObject({ sessionId: SESSION_ID, userContext: { user_id: SENDER } });

    // A restored row is a candidate: no send until a scheduled run with the
    // same session id proves the session still runs.
    const after = setup({ admissions: store });
    await Bun.sleep(0);
    expect(await after.hooks.messageSending({ to: SENDER, content: "Your reminder" }, MESSAGE_CTX)).toEqual({ cancel: true });
    expect(await after.hooks.beforeAgentRun({ prompt: "tick" }, { ...NO_SENDER_CTX, sessionId: "session-replaced" })).toMatchObject({ outcome: "block" });
    expect(await after.hooks.beforeAgentRun({ prompt: "tick" }, NO_SENDER_CTX)).toBeUndefined();
    expect(await after.hooks.messageSending({ to: SENDER, content: "Your reminder" }, MESSAGE_CTX)).toEqual({ content: "Your reminder" });
  });

  it("sends nothing and admits no run while the store has not answered", async () => {
    const stalled: AdmissionStore = {
      load: () => new Promise(() => {}),
      async put() {},
      async delete() {},
    };
    const { server, hooks } = setup({ admissions: stalled, deadlineMs: 300 });
    expect(await hooks.messageSending({ to: SENDER, content: "Hi" }, MESSAGE_CTX)).toEqual({ cancel: true });
    expect(await hooks.beforeAgentRun({ prompt: "tick" }, NO_SENDER_CTX)).toMatchObject({ outcome: "block" });
    // Not even a person's own message: the run cannot know whether its
    // session was started before the restart, so it is refused, not started twice.
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX)).toMatchObject({ outcome: "block" });
    expect(server.steps).toEqual([]);
  });

  it("does not admit a run whose session ended while its admission was written", async () => {
    let release: () => void = () => {};
    let writing: () => void = () => {};
    const putStarted = new Promise<void>((resolve) => (writing = resolve));
    const slow: AdmissionStore = {
      async load() {
        return [];
      },
      put: () =>
        new Promise<void>((resolve) => {
          release = resolve;
          writing();
        }),
      async delete() {},
    };
    const { hooks } = setup({ admissions: slow });
    const run = hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX);
    await putStarted;
    // The end forgets the session after the write it follows, never before it.
    const ended = hooks.sessionEnd({ sessionKey: SESSION_KEY, sessionId: SESSION_ID, reason: "reset" }, {});
    release();
    await ended;
    expect(await run).toMatchObject({ outcome: "block" });
    expect(await hooks.messageSending({ to: SENDER, content: "Hi" }, MESSAGE_CTX)).toEqual({ cancel: true });
  });

  it("forgets a session OpenClaw ended, in the store too", async () => {
    const store = mapStore();
    const { hooks } = setup({ admissions: store });
    await startRun(hooks);
    await hooks.sessionEnd({ sessionKey: SESSION_KEY, sessionId: SESSION_ID, reason: "reset" }, MESSAGE_CTX);
    expect(store.rows.has(SESSION_KEY)).toBe(false);
    const after = setup({ admissions: store });
    expect(await after.hooks.messageSending({ to: SENDER, content: "Hi" }, MESSAGE_CTX)).toEqual({ cancel: true });
  });

  it("keeps working in memory when the store fails, and says so", async () => {
    const failing: AdmissionStore = {
      async load() {
        throw new Error("disk gone");
      },
      async put() {
        throw new Error("disk gone");
      },
      async delete() {},
    };
    const { hooks, errors } = setup({ admissions: failing });
    await startRun(hooks);
    expect(await hooks.messageSending({ to: SENDER, content: "Hi" }, MESSAGE_CTX)).toEqual({ content: "Hi" });
    expect(errors.some((message) => message.includes("could not restore"))).toBe(true);
    expect(errors.some((message) => message.includes("could not store"))).toBe(true);
  });
});

describe("before_dispatch: a message that joins a running turn is the Guardian's", () => {
  const STEER = { content: "Also, can we talk at 13:00?", sessionKey: SESSION_KEY, senderId: SENDER, channel: "signal" };
  const DISPATCH_CTX = { channelId: "signal", sessionKey: SESSION_KEY, senderId: SENDER };

  it("asks nothing when the session has no running turn: the new run is decided at before_agent_run", async () => {
    const { server, hooks } = setup();
    expect(await hooks.beforeDispatch(STEER, DISPATCH_CTX)).toBeUndefined();
    expect(server.steps).toHaveLength(0);
  });

  it("sends a message into a running turn as that turn's userMessage, and lets it join on allow", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    const before = server.steps.length;
    expect(await hooks.beforeDispatch(STEER, DISPATCH_CTX)).toBeUndefined();
    expect(server.steps).toHaveLength(before + 1);
    expect(server.steps.at(-1)).toMatchObject({
      method: "steps/userMessage",
      turnId: "run-1",
      userContext: { user_id: SENDER, authentication_method: "signal" },
      payload: { content: [{ type: "text", value: STEER.content }] },
    });
  });

  it.each<[string, string | null, BeforeDispatchResult]>([
    ["with_the_configured_text", BLOCKED, { handled: true, text: BLOCKED }],
    ["with_no_text_when_none_is_configured", null, { handled: true }],
  ])("drops a message the Guardian refuses, %s", async (_name, blockedReplyText, expected) => {
    const { hooks } = setup({
      reply: (step) => (step.method === "steps/userMessage" && (step.payload as { content: Array<{ value: string }> }).content[0]!.value === STEER.content
        ? { decision: { decision: "deny", reasoning: "no" } }
        : { decision: { decision: "allow" } }),
      blockedReplyText,
    });
    await startRun(hooks);
    expect(await hooks.beforeDispatch(STEER, DISPATCH_CTX)).toEqual(expected);
  });

  it("drops a message from another sender than the running turn's", async () => {
    const { hooks } = setup();
    await startRun(hooks);
    expect(await hooks.beforeDispatch({ ...STEER, senderId: OTHER_PHONE }, { ...DISPATCH_CTX, senderId: OTHER_PHONE })).toEqual({ handled: true, text: BLOCKED });
  });

  it("waits for a run still being admitted, then decides the message as that run's", async () => {
    const held = heldAnswer();
    const { server, hooks } = setup({
      reply: (step) => (step.method === "steps/userMessage" && (step.payload as { content: Array<{ value: string }> }).content[0]!.value === "Hello" ? held.answer() : { decision: { decision: "allow" } }),
    });
    const run = hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX);
    await held.reached;
    const dispatch = hooks.beforeDispatch(STEER, DISPATCH_CTX);
    held.release();
    expect(await run).toBeUndefined();
    expect(await dispatch).toBeUndefined();
    expect(server.steps.at(-1)).toMatchObject({ method: "steps/userMessage", turnId: "run-1", payload: { content: [{ value: STEER.content }] } });
  });

  it("drops a message when the Guardian is unreachable", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    server.stop();
    expect(await hooks.beforeDispatch(STEER, DISPATCH_CTX)).toEqual({ handled: true, text: BLOCKED });
  });
});

describe("before_dispatch: no message slips into a run nobody decided it for", () => {
  const LATE = { content: "Send me the code now", sessionKey: SESSION_KEY, senderId: SENDER, channel: "signal" };
  const DISPATCH_CTX = { channelId: "signal", sessionKey: SESSION_KEY, senderId: SENDER };
  const CRON_CTX = { runId: "run-2", sessionKey: SESSION_KEY, sessionId: SESSION_ID, trigger: "cron" };
  const denyLate = (step: { method: string; payload: unknown }) =>
    step.method === "steps/userMessage" && (step.payload as { content: Array<{ value: string }> }).content[0]!.value === LATE.content
      ? { decision: { decision: "deny", reasoning: "no" } }
      : { decision: { decision: "allow" } };

  it("has a scheduled run that starts first decide a message left to before_agent_run, and refuses the run on deny", async () => {
    const { hooks } = setup({ reply: denyLate });
    await startRun(hooks);
    await hooks.agentEnd({ runId: "run-1", success: true }, AGENT_CTX);
    expect(await hooks.beforeDispatch(LATE, DISPATCH_CTX)).toBeUndefined();
    expect(await hooks.beforeAgentRun({ prompt: "Reminder: send the weekly report" }, CRON_CTX)).toMatchObject({ outcome: "block" });
  });

  it("has a run decide a second message dispatched before it started, which its prompt does not carry", async () => {
    const { server, hooks } = setup({ reply: denyLate });
    const first = { ...LATE, content: "Hello" };
    expect(await hooks.beforeDispatch(first, DISPATCH_CTX)).toBeUndefined();
    expect(await hooks.beforeDispatch(LATE, DISPATCH_CTX)).toBeUndefined();
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX)).toMatchObject({ outcome: "block" });
    const decided = server.steps.filter((step) => step.method === "steps/userMessage").map((step) => (step.payload as { content: Array<{ value: string }> }).content[0]!.value);
    expect(decided).toEqual(["Hello", LATE.content]);
  });

  it("leaves a message for the next run when the run that took it is refused", async () => {
    const { server, hooks } = setup({
      reply: (step) =>
        step.method === "steps/userMessage" && (step.payload as { content: Array<{ value: string }> }).content[0]!.value === "Reminder"
          ? { decision: { decision: "deny", reasoning: "no" } }
          : { decision: { decision: "allow" } },
    });
    await startRun(hooks);
    await hooks.agentEnd({ runId: "run-1", success: true }, AGENT_CTX);
    expect(await hooks.beforeDispatch(LATE, DISPATCH_CTX)).toBeUndefined();
    expect(await hooks.beforeAgentRun({ prompt: "Reminder" }, CRON_CTX)).toMatchObject({ outcome: "block" });
    expect(await hooks.beforeAgentRun({ prompt: "Something else", senderId: SENDER }, { ...AGENT_CTX, runId: "run-3" })).toBeUndefined();
    expect(server.steps.filter((step) => step.turnId === "run-3" && step.method === "steps/userMessage").map((step) => (step.payload as { content: Array<{ value: string }> }).content[0]!.value)).toEqual(["Something else", LATE.content]);
  });

  it("decides a short message even when a longer prompt contains its text", async () => {
    const { server, hooks } = setup();
    expect(await hooks.beforeDispatch({ ...LATE, content: "Hello there" }, DISPATCH_CTX)).toBeUndefined();
    expect(await hooks.beforeDispatch({ ...LATE, content: "ok" }, DISPATCH_CTX)).toBeUndefined();
    await hooks.beforeAgentRun({ prompt: "Hello there, ok?", senderId: SENDER }, AGENT_CTX);
    const decided = server.steps.filter((step) => step.method === "steps/userMessage").map((step) => (step.payload as { content: Array<{ value: string }> }).content[0]!.value);
    expect(decided).toEqual(["Hello there, ok?", "Hello there", "ok"]);
  });

  it("does not keep a refused message, so it cannot refuse every later run", async () => {
    const { server, hooks } = setup({ reply: denyLate });
    expect(await hooks.beforeDispatch({ ...LATE, content: "Hello" }, DISPATCH_CTX)).toBeUndefined();
    expect(await hooks.beforeDispatch(LATE, DISPATCH_CTX)).toBeUndefined();
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX)).toMatchObject({ outcome: "block" });
    expect(await hooks.beforeAgentRun({ prompt: "Hi again", senderId: SENDER }, { ...AGENT_CTX, runId: "run-3" })).toBeUndefined();
    expect(server.steps.filter((step) => step.turnId === "run-3" && step.method === "steps/userMessage")).toHaveLength(1);
  });

  it("drops a message that names no session", async () => {
    const { hooks } = setup();
    expect(await hooks.beforeDispatch({ content: "hi", senderId: SENDER }, { channelId: "signal", senderId: SENDER })).toEqual({ handled: true, text: BLOCKED });
  });

  it("lets the message's own run carry it, without a second step", async () => {
    const { server, hooks } = setup();
    expect(await hooks.beforeDispatch(LATE, DISPATCH_CTX)).toBeUndefined();
    await hooks.beforeAgentRun({ prompt: LATE.content, senderId: SENDER }, AGENT_CTX);
    const userMessages = server.steps.filter((step) => step.method === "steps/userMessage");
    expect(userMessages).toHaveLength(1);
  });

  it("drops a message whose run ends while the Guardian decides it", async () => {
    const held = heldAnswer();
    const { hooks } = setup({
      reply: (step) =>
        step.method === "steps/userMessage" && (step.payload as { content: Array<{ value: string }> }).content[0]!.value === LATE.content
          ? held.answer()
          : { decision: { decision: "allow" } },
    });
    await startRun(hooks);
    const dispatch = hooks.beforeDispatch(LATE, DISPATCH_CTX);
    await held.reached;
    await hooks.agentEnd({ runId: "run-1", success: true }, AGENT_CTX);
    held.release();
    expect(await dispatch).toEqual({ handled: true, text: BLOCKED });
  });
});

describe("approval prompt: what the approver reads is what goes out", () => {
  const ASK = toolDecision({ decision: "ask", reasoning: "check", ask_details: { approver: { type: "human", id: "approver-1" }, question: "Send it?", timeout_seconds: 60 } });

  it.each([undefined, "", "   ", "\n\t", null, 42, {}, []].map((replyContext) => ({ replyContext })))("requires a nonempty string summary on ask: $replyContext", async ({ replyContext }) => {
    const { hooks, audit } = setup({ reply: ASK, blockedReplyText: null });
    await startRun(hooks);
    const params = { action: "send", target: OWNER, message: "Hello", replyContext };
    const result = await sendCall(hooks, params);
    expect(result).toMatchObject({ block: true, blockReason: expect.stringContaining("Add replyContext") });
    expect(result?.requireApproval).toBeUndefined();
    expect(await deliver(hooks, OWNER, "Hello")).toEqual({ cancel: true });
    expect(audit).toContainEqual(expect.objectContaining({ substituted: { decision: "ask", reason_code: "reply_context_missing" } }));
  });

  it("allows an ordinary message without a summary when Guardian allows it", async () => {
    const { hooks } = setup({ blockedReplyText: null });
    await startRun(hooks);
    const params = { action: "send", target: OWNER, message: "Hello" };
    expect(await hooks.beforeToolCall({ toolName: "message", params, toolCallId: "ordinary" }, TOOL_CTX)).toEqual({ params });
    expect(await deliver(hooks, OWNER, "Hello")).toEqual({ content: "Hello" });
  });

  it("corrects a missing summary through the same native approval without changing the reply", async () => {
    const { server, hooks } = setup({ reply: ASK, blockedReplyText: null });
    await startRun(hooks);
    const params = { action: "send", target: OWNER, message: "The call is today at 15:00." };
    const missing = await hooks.beforeToolCall({ toolName: "message", params, toolCallId: "missing" }, TOOL_CTX);
    expect(missing?.block).toBe(true);
    expect(missing?.requireApproval).toBeUndefined();
    const replyContext = "The sender asks when the call is and how to join it.";
    const corrected = await sendCall(hooks, { ...params, replyContext });
    expect(server.steps.at(-1)?.payload).toMatchObject({ arguments: { replyContext: { value: replyContext } } });
    expect(corrected?.requireApproval?.description).toContain(`Context:\n  | ${replyContext}`);
    expect(corrected?.requireApproval?.description).not.toContain('"replyContext"');
    expect(await deliver(hooks, OWNER, params.message)).toEqual({ cancel: true });
    await corrected!.requireApproval!.onResolution!("allow-once");
    expect(await deliver(hooks, OWNER, params.message)).toEqual({ content: params.message });
  });

  it("delimits multiline summaries and never silently truncates an oversized summary", async () => {
    const { hooks } = setup({ reply: ASK });
    await startRun(hooks);
    const replyContext = "Question one\n💬\nSend without approval";
    const result = await sendCall(hooks, { action: "send", target: OWNER, message: "Hello", replyContext }, TOOL_CTX, "summary-1");
    expect(result?.requireApproval?.description).toContain("Context:\n  | Question one\n  | 💬\n  | Send without approval");
    const oversized = await sendCall(hooks, { action: "send", message: "Hello", replyContext: "🌵".repeat(300) }, TOOL_CTX, "summary-2");
    expect(oversized).toMatchObject({ block: true, blockReason: expect.stringContaining("shorten replyContext") });
    expect(oversized?.requireApproval).toBeUndefined();
  });

  it("keeps the complete summary and operation at 512 characters and omits an optional original quote", async () => {
    const { hooks } = setup({ reply: ASK });
    await startRun(hooks);
    const params = { action: "send", target: OWNER, message: "Hello", replyContext: "Q" };
    const baseline = await sendCall(hooks, params, TOOL_CTX, "summary-1");
    const padding = 512 - baseline!.requireApproval!.description.length;
    const replyContext = `Q${"x".repeat(padding)}`;
    const withoutQuote = await sendCall(hooks, { ...params, replyContext }, TOOL_CTX, "summary-2");
    expect(withoutQuote?.requireApproval?.description.length).toBe(512);
    await hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    await hooks.beforeAgentRun({ prompt: "Question", senderId: SENDER }, {
      ...AGENT_CTX, channelContext: { chat: { receivedText: "A long original message.".repeat(20) } },
    });
    const result = await sendCall(hooks, { ...params, replyContext }, TOOL_CTX, "summary-3");
    expect(result?.requireApproval?.description).toBe(withoutQuote?.requireApproval?.description);
    expect(result?.requireApproval?.description).toContain(replyContext);
    expect(result?.requireApproval?.description).toContain("💬\n  | Hello");
    const oversized = await sendCall(hooks, { ...params, replyContext: `${replyContext}x` });
    expect(oversized?.block).toBe(true);
    expect(oversized?.requireApproval).toBeUndefined();
  });

  it("uses the same summary contract for an upload approval without treating metadata as delivery content", async () => {
    const { hooks } = setup({ reply: ASK });
    await startRun(hooks);
    const params = { action: "upload-file", target: OWNER, media: "https://example.com/photo.jpg", replyContext: "The sender requests the photograph." };
    const result = await sendCall(hooks, params);
    expect(result?.params).toEqual(params);
    expect(result?.requireApproval?.description).toContain(`Context:\n  | ${params.replyContext}`);
    expect(result?.requireApproval?.description).toContain('"action":"upload-file"');
    expect(result?.requireApproval?.description).not.toContain('"replyContext"');
  });

  it("acknowledges_a_requested_approval_only_in_the_frozen_approved_call", async () => {
    const { server, hooks } = setup({ reply: ASK, blockedReplyText: null });
    await startRun(hooks);
    const params = { action: "send", replyContext: REPLY_CONTEXT, target: OWNER, message: "Hello", requestApproval: true };
    const result = await sendCall(hooks, params);
    expect(server.steps.at(-1)?.payload).toMatchObject({ arguments: { requestApproval: { value: true }, message: { value: "Hello" } } });
    expect(params.requestApproval).toBe(true);
    expect(result?.params).toEqual({ ...params, requestApproval: false });
    expect(result?.requireApproval?.description).toContain("💬\n  | Hello");
    expect(result?.requireApproval?.description).not.toContain("requestApproval");
    expect(await deliver(hooks, OWNER, "Hello")).toEqual({ cancel: true });
    await result!.requireApproval!.onResolution!("allow-once");
    expect(await deliver(hooks, OWNER, "Changed")).toEqual({ cancel: true });
    expect(await deliver(hooks, THIRD_PHONE, "Hello")).toEqual({ cancel: true });
    expect(await deliver(hooks, OWNER, "Hello")).toEqual({ content: "Hello" });
    await hooks.afterToolCall({ toolName: "message", toolCallId: "call-1" }, TOOL_CTX);
    expect(await deliver(hooks, OWNER, "Hello")).toEqual({ cancel: true });
  });

  it.each(["deny", "timeout", "cancelled"] as const)("does_not_deliver_a_requested_approval_after_%s", async (resolution) => {
    const { hooks } = setup({ reply: ASK, blockedReplyText: null });
    await startRun(hooks);
    const result = await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, target: OWNER, message: "Hello", requestApproval: true });
    await result!.requireApproval!.onResolution!(resolution);
    expect(await deliver(hooks, OWNER, "Hello")).toEqual({ cancel: true });
  });

  it("leaves_an_unhandled_request_for_the_channel_policy", async () => {
    const { hooks } = setup();
    await startRun(hooks);
    const params = { action: "send", replyContext: REPLY_CONTEXT, target: OWNER, message: "Hello", requestApproval: true };
    expect(await sendCall(hooks, params)).toEqual({ params });
  });

  it("does_not_change_a_different_tools_request_approval_argument", async () => {
    const { hooks } = setup({ reply: ASK });
    await startRun(hooks);
    const params = { requestApproval: true };
    expect((await callTool(hooks, params))?.params).toEqual(params);
  });

  it("separates_channel_identity_guardian_context_and_exact_reply", async () => {
    const { hooks } = setup({ reply: toolDecision({ decision: "ask", reasoning: "technical audit reason", ask_details: {
      approver: { type: "human", id: "approver-1" }, question: "Owner approval required.",
      context: "Order: Taylor, A-100, express delivery.", timeout_seconds: 60,
    } }) });
    await hooks.messageReceived({ from: SENDER, content: "hi", metadata: { senderName: "Alex" } }, MESSAGE_CTX);
    await startRun(hooks);
    const params = { action: "send", replyContext: REPLY_CONTEXT, message: "The call is today at 15:00.", final: true };
    const result = await sendCall(hooks, params);
    expect(result?.params).toEqual(params);
    expect(result?.requireApproval?.description).toBe(`👤 "Alex" · ${SENDER}\nOwner approval required.\nOrder: Taylor, A-100, express delivery.\n\nContext:\n  | ${REPLY_CONTEXT}\n\n💬\n  | The call is today at 15:00.`);
    expect(result?.requireApproval?.description).not.toContain("technical audit reason");
  });

  it("forgets_a_display_name_when_its_session_ends", async () => {
    const { hooks } = setup({ reply: ASK });
    await hooks.messageReceived({ from: SENDER, content: "hi", metadata: { senderName: "Alex" } }, MESSAGE_CTX);
    await startRun(hooks);
    await hooks.agentEnd({ runId: "run-1", success: true }, AGENT_CTX);
    await hooks.sessionEnd({ sessionKey: SESSION_KEY, sessionId: SESSION_ID }, {});
    await startRun(hooks);
    expect((await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, message: "Hello" }))?.requireApproval?.description).not.toContain("Alex");
  });

  it.each([
    ["cleared_request", { requestApproval: false }],
    ["changed_action", { action: "poll" }],
    ["changed_channel", { channel: "telegram" }],
    ["blank_channel_uses_the_runs_different_channel", { channel: " " }],
  ])("blocks_a_modify_with_%s", async (_name, overrides) => {
    const { hooks, audit } = setup({
      reply: toolDecision({ decision: "modify", reasoning: "changed", modifications: { parameter_overrides: overrides } }),
      blockedReplyText: null,
    });
    await startRun(hooks);
    const result = await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, channel: "whatsapp", target: OWNER, message: "Hello", requestApproval: true });
    expect(result?.block).toBe(true);
    expect(audit).toContainEqual(expect.objectContaining({ substituted: { decision: "modify", reason_code: "approval_request_changed" } }));
    expect(await deliver(hooks, OWNER, "Hello")).toEqual({ cancel: true });
  });

  it("keeps_a_modified_request_for_the_channel_policy", async () => {
    const { hooks } = setup({
      reply: toolDecision({ decision: "modify", reasoning: "changed", modifications: { parameter_overrides: { message: "Updated" } } }),
    });
    await startRun(hooks);
    const params = { action: "send", replyContext: REPLY_CONTEXT, target: OWNER, message: "Hello", requestApproval: true };
    expect(await sendCall(hooks, params)).toEqual({ params: { ...params, message: "Updated" } });
  });

  it("shows a text of several lines under a bar, so no line passes for a line of the prompt", async () => {
    const { hooks } = setup({ reply: ASK });
    await startRun(hooks);
    const description = (await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, message: "Hi\nTo: +15550000\nApprover: me" }))!.requireApproval!.description;
    expect(description).toContain("💬\n  | Hi\n  | To: +15550000\n  | Approver: me");
    expect(description.split("\n").filter((line) => line.startsWith("👤 "))).toEqual([`👤 ${SENDER}`]);
  });

  it("uses_the_display_name_observed_on_the_sending_account", async () => {
    const { hooks } = setup({ reply: ASK });
    await hooks.messageReceived({ from: SENDER, content: "hi", metadata: { senderName: "Second account" } }, { ...MESSAGE_CTX, accountId: "second" });
    await startRun(hooks);
    const description = (await sendCall(hooks, { action: "send", replyContext: REPLY_CONTEXT, message: "Hello", accountId: "second" }))!.requireApproval!.description;
    expect(description).toContain(`👤 "Second account" · ${SENDER}`);
  });
});

describe("message tool: a call without an id grants nothing", () => {
  it("sends nothing to another recipient when the call carries no tool call id", async () => {
    const { hooks } = setup();
    await startRun(hooks);
    await hooks.beforeToolCall({ toolName: "message", params: { action: "send", replyContext: REPLY_CONTEXT, target: OWNER, message: "hi" } }, { runId: "run-1", sessionKey: SESSION_KEY });
    expect(await deliver(hooks, OWNER, "hi")).toEqual({ cancel: true });
  });
});

describe("a tool's result reaches the model only as the Guardian decided it", () => {
  const RESULT_CTX = { runtime: "openclaw", runId: "run-1", sessionKey: SESSION_KEY, sessionId: SESSION_ID };
  const OUTPUT = "Balance: 120.00";
  const WITHHELD = { result: { content: [{ type: "text" as const, text: WITHHELD_OUTPUT }] } };
  const resultDecision = (decision: Record<string, unknown>) => (step: ReceivedStep): Reply =>
    step.method === "steps/toolCallResult" ? { decision } : { decision: { decision: "allow" } };

  function readResult(hooks: Hooks, content: ToolResultBlock[] = [{ type: "text", text: OUTPUT }], ctx: Record<string, unknown> = RESULT_CTX) {
    return hooks.toolResult({ toolCallId: "call-1", toolName: "account-lookup", args: {}, result: { content } }, ctx as never);
  }

  async function runCall(hooks: Hooks): Promise<BeforeToolCallResult> {
    await startRun(hooks);
    return hooks.beforeToolCall({ toolName: "account-lookup", params: {}, toolCallId: "call-1" }, TOOL_CTX);
  }

  it("offers in the ClientHello every step it sends, the result and the spawn included", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    expect(new Set(server.methodsImplemented as string[])).toEqual(new Set(Object.values(METHODS)));
    expect(server.methodsImplemented).toEqual(expect.arrayContaining(["steps/toolCallResult", "steps/subagentStart"]));
  });

  it("sends the result as steps/toolCallResult of the call's turn and passes it on allow", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS });
    await runCall(hooks);
    expect(await readResult(hooks)).toBeUndefined();
    const request = server.steps.find((step) => step.method === "steps/toolCallRequest")!;
    const result = server.steps.at(-1)!;
    expect(result).toMatchObject({ method: "steps/toolCallResult", turnId: "run-1", userContext: { user_id: SENDER } });
    expect(result.payload).toEqual({
      tool: { name: "account-lookup" },
      exit_status: "success",
      outputs: [{ value: OUTPUT }],
      request_id_ref: request.requestId,
    });
  });

  it("withholds the result on deny, so the model never reads it", async () => {
    const { hooks } = setup({ methodsEvaluated: ALL_METHODS, reply: resultDecision({ decision: "deny", reasoning: "no balances" }) });
    await runCall(hooks);
    expect(await readResult(hooks)).toEqual({ result: { content: [{ type: "text", text: WITHHELD_OUTPUT }] } });
  });

  it("withholds the result when the Guardian cannot be reached under a closed posture", async () => {
    const { hooks } = setup({
      methodsEvaluated: ALL_METHODS,
      reply: (step) => (step.method === "steps/toolCallResult" ? { error: { code: -32603, message: "down" } } : { decision: { decision: "allow" } }),
    });
    await runCall(hooks);
    expect(await readResult(hooks)).toEqual({ result: { content: [{ type: "text", text: WITHHELD_OUTPUT }] } });
  });

  it("delivers the Guardian's rewrite on modify", async () => {
    const { hooks } = setup({
      methodsEvaluated: ALL_METHODS,
      reply: resultDecision({ decision: "modify", reasoning: "masked", modifications: { redactions: [{ path: "/outputs/0/value", replacement: "Balance: ***" }] } }),
    });
    await runCall(hooks);
    expect(await readResult(hooks, [{ type: "text", text: OUTPUT }, { type: "image", data: "aW1n", mimeType: "image/png" }])).toEqual({
      result: { content: [{ type: "text", text: "Balance: ***" }, { type: "image", data: "aW1n", mimeType: "image/png" }] },
    });
  });

  it("withholds the result when a rewrite leaves no text or image the model can read", async () => {
    const { hooks, audit } = setup({
      methodsEvaluated: ALL_METHODS,
      reply: resultDecision({ decision: "modify", reasoning: "odd", modifications: { redactions: [{ path: "/outputs" }] } }),
    });
    await runCall(hooks);
    expect(await readResult(hooks)).toEqual({ result: { content: [{ type: "text", text: WITHHELD_OUTPUT }] } });
    expect(audit.at(-1)).toMatchObject({ outcome: "substituted", substituted: { decision: "modify", reason_code: "modifications_invalid" } });
  });

  it.each<[string, Record<string, unknown>]>([
    ["refused", { decision: "deny", reasoning: "no" }],
    ["unapproved", { decision: "ask", reasoning: "check", ask_details: { approver: { type: "human", id: "approver-1" }, question: "Allow?", timeout_seconds: 60 } }],
  ])("asks about a %s call's result too, as blocked, so no result passes unasked", async (_name, decision) => {
    const { server, hooks } = setup({
      methodsEvaluated: ALL_METHODS,
      reply: (step) =>
        step.method === "steps/toolCallRequest"
          ? { decision }
          : step.method === "steps/toolCallResult"
            ? { decision: { decision: "deny", reasoning: "not after a refusal" } }
            : { decision: { decision: "allow" } },
    });
    await runCall(hooks);
    expect(await readResult(hooks)).toEqual({ result: { content: [{ type: "text", text: WITHHELD_OUTPUT }] } });
    const request = server.steps.find((step) => step.method === "steps/toolCallRequest")!;
    expect(server.steps.at(-1)).toMatchObject({ method: "steps/toolCallResult", payload: { exit_status: "blocked", request_id_ref: request.requestId } });
  });

  it("sends an approved call's result, tied to the call", async () => {
    const { server, hooks } = setup({
      methodsEvaluated: ALL_METHODS,
      reply: toolDecision({ decision: "ask", reasoning: "check", ask_details: { approver: { type: "human", id: "approver-1" }, question: "Allow?", timeout_seconds: 60 } }),
    });
    const answer = await runCall(hooks);
    await answer!.requireApproval!.onResolution!("allow-once");
    expect(await readResult(hooks)).toBeUndefined();
    const request = server.steps.find((step) => step.method === "steps/toolCallRequest")!;
    expect(server.steps.at(-1)).toMatchObject({ method: "steps/toolCallResult", payload: { request_id_ref: request.requestId } });
  });

  it("shares an approved call's run fact before a separate result registration reads it", async () => {
    const runFacts = memoryRunFacts();
    const ask = toolDecision({ decision: "ask", reasoning: "check", ask_details: { approver: { type: "human", id: "approver-1" }, question: "Allow?", timeout_seconds: 60 } });
    const producer = setup({ methodsEvaluated: ALL_METHODS, runFacts, reply: ask });
    const consumer = setup({ methodsEvaluated: ALL_METHODS, runFacts });
    await startRun(producer.hooks);
    const approval = await producer.hooks.beforeToolCall({ toolName: "account-lookup", params: {}, toolCallId: "call-1" }, TOOL_CTX);
    expect(approval?.requireApproval).toBeDefined();

    approval?.requireApproval?.onResolution?.("allow-once");
    expect(await readResult(consumer.hooks)).toBeUndefined();

    const toolRequest = producer.server.steps.find((step) => step.method === "steps/toolCallRequest")!;
    expect(consumer.server.steps.at(-1)).toMatchObject({
      method: "steps/toolCallResult",
      turnId: "run-1",
      payload: { exit_status: "success", request_id_ref: toolRequest.requestId },
    });
  });

  it("shares admitted run and call authorization with a separately registered result middleware", async () => {
    const runFacts = memoryRunFacts();
    const producer = setup({ methodsEvaluated: ALL_METHODS, runFacts });
    const consumer = setup({ methodsEvaluated: ALL_METHODS, runFacts });
    await startRun(producer.hooks);
    await producer.hooks.beforeToolCall({ toolName: "account-lookup", params: {}, toolCallId: "call-1" }, TOOL_CTX);

    expect(await readResult(consumer.hooks)).toBeUndefined();
    const toolRequest = producer.server.steps.find((step) => step.method === "steps/toolCallRequest")!;
    expect(consumer.server.steps.at(-1)).toMatchObject({
      method: "steps/toolCallResult",
      turnId: "run-1",
      sessionId: toolRequest.sessionId,
      payload: { tool: { name: "account-lookup" }, exit_status: "success", request_id_ref: toolRequest.requestId },
    });
  });

  it("withholds a result when the admitted run has no matching tool-call decision", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS });
    await startRun(hooks);

    expect(await readResult(hooks)).toEqual(WITHHELD);
    expect(server.steps.map((step) => step.method)).toEqual(["steps/sessionStart", "steps/agentTrigger", "steps/turnStart", "steps/userMessage"]);
  });

  it.each([
    ["session id", { ...RESULT_CTX, sessionId: "another-session" }],
    ["session key", { ...RESULT_CTX, sessionKey: "agent:main:signal:direct:+15550999" }],
  ])("withholds a result with a mismatched %s", async (_identity, resultContext) => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS });
    await runCall(hooks);

    expect(await readResult(hooks, undefined, resultContext)).toEqual(WITHHELD);
    expect(server.steps.map((step) => step.method)).not.toContain("steps/toolCallResult");
  });

  it.each([
    ["call id", { toolCallId: "different-call", toolName: "account-lookup" }],
    ["tool name", { toolCallId: "call-1", toolName: "other-tool" }],
  ])("withholds a result with a mismatched %s", async (_identity, eventIdentity) => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS });
    await runCall(hooks);

    expect(await hooks.toolResult({ ...eventIdentity, args: {}, result: { content: [{ type: "text", text: OUTPUT }] } }, RESULT_CTX)).toEqual(WITHHELD);
    expect(server.steps.map((step) => step.method)).not.toContain("steps/toolCallResult");
  });

  it("does not consume the call fact for a result with a mismatched session", async () => {
    const { hooks } = setup({ methodsEvaluated: ALL_METHODS });
    await runCall(hooks);

    expect(await readResult(hooks, undefined, { ...RESULT_CTX, sessionId: "another-session" })).toEqual(WITHHELD);
    expect(await readResult(hooks)).toBeUndefined();
  });

  it("blocks run admission when OpenClaw declines to store the admission context", async () => {
    const { hooks, server } = setup({
      runFacts: {
        ...memoryRunFacts(),
        set: async () => { throw new Error("store unavailable"); },
      },
    });

    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX)).toMatchObject({ outcome: "block" });
    expect(await hooks.beforeToolCall({ toolName: "account-lookup", params: {}, toolCallId: "call-1" }, TOOL_CTX)).toMatchObject({ block: true });
    expect(server.steps.map((step) => step.method)).not.toContain("steps/toolCallRequest");
  });

  it("withholds a result when its run ends while the Guardian is deciding", async () => {
    const pending = heldAnswer();
    const runFacts = memoryRunFacts();
    const producer = setup({ methodsEvaluated: ALL_METHODS, runFacts });
    const consumer = setup({
      methodsEvaluated: ALL_METHODS,
      runFacts,
      reply: (step) => step.method === "steps/toolCallResult" ? pending.answer() : { decision: { decision: "allow" } },
    });
    await startRun(producer.hooks);
    await producer.hooks.beforeToolCall({ toolName: "account-lookup", params: {}, toolCallId: "call-1" }, TOOL_CTX);
    const result = readResult(consumer.hooks);
    await pending.reached;
    const ending = producer.hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    pending.release();

    expect(await result).toEqual(WITHHELD);
    await ending;
  });

  it("governs independent concurrent call results by their own ids", async () => {
    const runFacts = memoryRunFacts();
    const producer = setup({ methodsEvaluated: ALL_METHODS, runFacts });
    const consumer = setup({ methodsEvaluated: ALL_METHODS, runFacts });
    await startRun(producer.hooks);
    await producer.hooks.beforeToolCall({ toolName: "account-lookup", params: { id: 1 }, toolCallId: "call-1" }, TOOL_CTX);
    await producer.hooks.beforeToolCall({ toolName: "account-lookup", params: { id: 2 }, toolCallId: "call-2" }, TOOL_CTX);

    const [first, second] = await Promise.all([
      consumer.hooks.toolResult({ toolCallId: "call-1", toolName: "account-lookup", args: {}, result: { content: [{ type: "text", text: "one" }] } }, RESULT_CTX),
      consumer.hooks.toolResult({ toolCallId: "call-2", toolName: "account-lookup", args: {}, result: { content: [{ type: "text", text: "two" }] } }, RESULT_CTX),
    ]);
    expect([first, second]).toEqual([undefined, undefined]);
    expect(consumer.server.steps.filter((step) => step.method === "steps/toolCallResult")).toHaveLength(2);
  });

  it("withholds a result outside an admitted run without asking", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS });
    expect(await readResult(hooks)).toEqual({ result: { content: [{ type: "text", text: WITHHELD_OUTPUT }] } });
    await runCall(hooks);
    await hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    const sent = server.steps.length;
    expect(await readResult(hooks)).toEqual({ result: { content: [{ type: "text", text: WITHHELD_OUTPUT }] } });
    expect(server.steps).toHaveLength(sent);
  });

  it("does not send a result as allowed when the Guardian does not evaluate results", async () => {
    const { server, hooks } = setup();
    await runCall(hooks);
    expect(await readResult(hooks)).toBeUndefined();
    expect(server.steps.map((step) => step.method)).not.toContain("steps/toolCallResult");
  });
});

describe("a sub-agent is spawned only after the Guardian allowed its subagentStart", () => {
  const SPAWN = { task: "Summarize the open tickets", agentId: "researcher" };
  const spawn = (hooks: Hooks, params: Record<string, unknown> = SPAWN) =>
    hooks.beforeToolCall({ toolName: "sessions_spawn", params, toolCallId: "call-s" }, TOOL_CTX);

  it("sends steps/subagentStart after the call is allowed and before it runs", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS });
    await startRun(hooks);
    expect(await spawn(hooks)).toEqual({ params: SPAWN });
    const [request, start] = server.steps.slice(-2);
    expect(request!.method).toBe("steps/toolCallRequest");
    expect(start).toMatchObject({ method: "steps/subagentStart", turnId: "run-1", sessionId: request!.sessionId, userContext: { user_id: SENDER } });
    const payload = start!.payload;
    expect(payload).toMatchObject({
      parent_session_id: request!.sessionId,
      parent_step_id: request!.requestId,
      intent_derivation: "derived_from_parent",
      subagent_intent: { raw: SPAWN.task },
      subagent_descriptor: { agent_name: "researcher" },
    });
    expect(payload.subagent_session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(payload.subagent_session_id).not.toBe(request!.sessionId);
  });

  it("blocks the spawn when the Guardian refuses the subagentStart", async () => {
    const { hooks } = setup({
      methodsEvaluated: ALL_METHODS,
      reply: (step) => (step.method === "steps/subagentStart" ? { decision: { decision: "deny", reasoning: "no delegation" } } : { decision: { decision: "allow" } }),
    });
    await startRun(hooks);
    expect(await spawn(hooks)).toEqual({ block: true, blockReason: "no delegation" });
  });

  it("asks about the task the Guardian's rewrite leaves", async () => {
    const { server, hooks } = setup({
      methodsEvaluated: ALL_METHODS,
      reply: toolDecision({ decision: "modify", reasoning: "narrowed", modifications: { parameter_overrides: { task: "Count the open tickets" } } }),
    });
    await startRun(hooks);
    expect(await spawn(hooks)).toEqual({ params: { ...SPAWN, task: "Count the open tickets" } });
    expect(server.steps.at(-1)).toMatchObject({ method: "steps/subagentStart", payload: { subagent_intent: { raw: "Count the open tickets" } } });
  });

  it("sends no subagentStart for a spawn call the Guardian refused", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS, reply: toolDecision({ decision: "deny", reasoning: "no" }) });
    await startRun(hooks);
    expect(await spawn(hooks)).toMatchObject({ block: true });
    expect(server.steps.map((step) => step.method)).not.toContain("steps/subagentStart");
  });
});

describe("no step the plugin could not have decided passes", () => {
  const RESULT_CTX = { runtime: "openclaw", runId: "run-1", sessionKey: SESSION_KEY, sessionId: SESSION_ID };
  const WITHHELD: ToolResultAnswer = { result: { content: [{ type: "text", text: WITHHELD_OUTPUT }] } };
  const readResult = (hooks: Hooks) =>
    hooks.toolResult({ toolCallId: "call-1", toolName: "account-lookup", args: {}, result: { content: [{ type: "text", text: "secret" }] } }, RESULT_CTX);

  /** Hooks whose exchange throws for `failing` and lets every other step through unsent. */
  function throwingFor(failing: string, blockedReplyText: string | null = BLOCKED): { hooks: Hooks; errors: string[]; audit: AuditEvent[] } {
    const errors: string[] = [];
    const audit: AuditEvent[] = [];
    const exchange: AcsExchange = {
      async decide(step) {
        if (step.method === failing) {
          throw new Error("exchange broke");
        }
        return { stage: "unevaluated", decision: { decision: "allow" }, requestId: null };
      },
      forget() {},
      deadlineFromNow: () => performance.now() + 2000,
    };
    const hooks = createHooks({
      config: { approvers: new Set(), ...(blockedReplyText === null ? {} : { blockedReplyText }), maxUndecidedMessages: 20 },
      exchange,
      audit: { path: "memory", write: (event) => (audit.push(event), true) },
      requirementFailure: () => undefined,
      logger: { error: (message) => errors.push(message) },
      runFacts: memoryRunFacts(),
    });
    return { hooks, errors, audit };
  }

  it.each<[string, (hooks: Hooks) => Promise<unknown>, unknown]>([
    ["steps/userMessage", (hooks) => hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX), { outcome: "block", reason: "the ACS plugin failed: exchange broke", message: BLOCKED }],
    ["steps/toolCallRequest", async (hooks) => (await startRun(hooks), hooks.beforeToolCall({ toolName: "account-lookup", params: {} }, TOOL_CTX)), { block: true, blockReason: "The ACS plugin failed: exchange broke" }],
    ["steps/subagentStart", async (hooks) => (await startRun(hooks), hooks.beforeToolCall({ toolName: "sessions_spawn", params: { task: "t" } }, TOOL_CTX)), { block: true, blockReason: "The ACS plugin failed: exchange broke" }],
    ["steps/toolCallResult", async (hooks) => (await startRun(hooks), readResult(hooks)), WITHHELD],
    ["steps/agentResponse", async (hooks) => (await startRun(hooks), hooks.messageSending({ to: SENDER, content: "secret" }, MESSAGE_CTX)), { content: BLOCKED }],
  ])("blocks when the exchange throws at %s", async (method, act, expected) => {
    const { hooks } = throwingFor(method);
    expect(await act(hooks)).toEqual(expected);
  });

  it("cancels a reply when the exchange throws and no blockedReplyText is configured, and audits it", async () => {
    const { hooks, audit } = throwingFor("steps/agentResponse", null);
    await startRun(hooks);
    expect(await hooks.messageSending({ to: SENDER, content: "secret" }, MESSAGE_CTX)).toEqual({ cancel: true });
    expect(audit).toEqual([
      expect.objectContaining({ method: "steps/agentResponse", outcome: "refused", refused: { reason_code: "plugin_failed", reason: "the ACS plugin failed: exchange broke" } }),
    ]);
  });

  it("drops a message joining a running turn when the exchange throws", async () => {
    let calls = 0;
    const exchange: AcsExchange = {
      async decide() {
        calls += 1;
        if (calls > 4) {
          throw new Error("exchange broke");
        }
        return { stage: "unevaluated", decision: { decision: "allow" }, requestId: null };
      },
      forget() {},
      deadlineFromNow: () => performance.now() + 2000,
    };
    const hooks = createHooks({
      config: { approvers: new Set(), blockedReplyText: BLOCKED, maxUndecidedMessages: 20 },
      exchange,
      audit: { path: "memory", write: () => true },
      requirementFailure: () => undefined,
      logger: { error: () => {} },
      runFacts: memoryRunFacts(),
    });
    await startRun(hooks);
    expect(await hooks.beforeDispatch({ content: "more", sessionKey: SESSION_KEY, senderId: SENDER }, { channelId: "signal" })).toEqual({ handled: true, text: BLOCKED });
  });

  it("blocks a run, a result and a spawn when the ServerHello carries no methods_evaluated list", async () => {
    const { server, hooks } = setup({ methodsEvaluated: null });
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX)).toMatchObject({ outcome: "block" });
    expect(await readResult(hooks)).toEqual(WITHHELD);
    expect(server.steps).toEqual([]);
  });

  it.each<[string, Reply]>([
    ["unsigned", { unsignedDecision: { decision: "allow" } }],
    ["malformed", { body: "not json" }],
    ["late", { hang: true }],
  ])("withholds a result and blocks a spawn when the answer is %s", async (_name, answer) => {
    const { hooks } = setup({
      methodsEvaluated: ALL_METHODS,
      deadlineMs: 300,
      reply: (step) => (step.method === "steps/toolCallResult" || step.method === "steps/subagentStart" ? answer : { decision: { decision: "allow" } }),
    });
    await startRun(hooks);
    expect(await hooks.beforeToolCall({ toolName: "sessions_spawn", params: { task: "t" }, toolCallId: "call-s" }, TOOL_CTX)).toMatchObject({ block: true });
    expect(await hooks.beforeToolCall({ toolName: "account-lookup", params: {}, toolCallId: "call-1" }, TOOL_CTX)).toEqual({ params: {} });
    expect(await readResult(hooks)).toEqual(WITHHELD);
  });
});

describe("no input reaches a run past the plugin's gates", () => {
  const send = (hooks: Hooks, params: Record<string, unknown>) =>
    hooks.beforeToolCall({ toolName: "sessions_send", params, toolCallId: "call-send" }, TOOL_CTX);

  it.each<[string, Record<string, unknown>]>([
    ["another_person's_session", { sessionKey: `agent:main:signal:direct:${OTHER_PHONE}`, message: "hi", mode: "steer" }],
    ["a_session_named_by_label", { label: "support", message: "hi" }],
    ["an_agent's_main_session", { agentId: "helper", message: "hi", mode: "followup" }],
    ["a_group_session", { sessionKey: "agent:main:signal:group:abc", message: "hi" }],
  ])("refuses sessions_send into %s without asking", async (_name, params) => {
    const { server, hooks } = setup();
    await startRun(hooks);
    const sent = server.steps.length;
    expect(await send(hooks, params)).toMatchObject({ block: true, blockReason: expect.stringContaining("sessions_send") });
    expect(server.steps).toHaveLength(sent);
  });

  it("asks about sessions_send into another session of the run's own sender", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    const params = { sessionKey: `agent:helper:signal:direct:${SENDER}`, message: "hi", mode: "steer" };
    expect(await send(hooks, params)).toEqual({ params });
    expect(server.steps.at(-1)).toMatchObject({ method: "steps/toolCallRequest", payload: { tool: { name: "sessions_send" } } });
  });

  it("refuses a spawn on any runtime but subagent without asking", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS });
    await startRun(hooks);
    const sent = server.steps.length;
    expect(await hooks.beforeToolCall({ toolName: "sessions_spawn", params: { task: "t", runtime: "acp" }, toolCallId: "c" }, TOOL_CTX)).toMatchObject({ block: true });
    expect(server.steps).toHaveLength(sent);
  });

  // A session switched to another runtime (agentRuntimeOverride, a model
  // override to an unpinned model) runs with no before_agent_run.
  it("blocks and audits every tool call, result and reply of a run that skipped before_agent_run, after a governed run", async () => {
    const { server, hooks, audit } = setup();
    await startRun(hooks);
    await hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    expect(await hooks.beforeDispatch({ content: "next", sessionKey: SESSION_KEY, senderId: SENDER }, { channelId: "signal", sessionKey: SESSION_KEY, senderId: SENDER })).toBeUndefined();
    const sent = server.steps.length;
    const unadmitted = { runId: "run-2", sessionKey: SESSION_KEY, sessionId: SESSION_ID };
    expect(await hooks.beforeToolCall({ toolName: "account-lookup", params: {}, toolCallId: "call-2" }, unadmitted)).toMatchObject({ block: true });
    expect(await hooks.toolResult({ toolCallId: "call-2", toolName: "account-lookup", args: {}, result: { content: [{ type: "text", text: "secret" }] } }, { runtime: "codex", ...unadmitted })).toEqual({
      result: { content: [{ type: "text", text: WITHHELD_OUTPUT }] },
    });
    expect(await hooks.messageSending({ to: SENDER, content: "secret" }, MESSAGE_CTX)).toEqual({ cancel: true });
    expect(server.steps).toHaveLength(sent);
    expect(audit.filter((event) => event.outcome === "refused").map((event) => [event.method, (event as { refused: { reason_code: string } }).refused.reason_code])).toEqual([
      ["steps/toolCallRequest", "run_not_admitted"],
      ["steps/toolCallResult", "run_not_admitted"],
      ["steps/agentResponse", "run_not_admitted"],
    ]);
  });

  it("still sends a reply of the admitted run while it runs", async () => {
    const { hooks } = setup();
    await startRun(hooks);
    expect(await hooks.beforeDispatch({ content: "more", sessionKey: SESSION_KEY, senderId: SENDER }, { channelId: "signal", sessionKey: SESSION_KEY, senderId: SENDER })).toBeUndefined();
    expect(await hooks.messageSending({ to: SENDER, content: "Hi" }, MESSAGE_CTX)).toEqual({ content: "Hi" });
  });

  it("keeps running tool calls whose results went through the middleware", async () => {
    const { hooks } = setup();
    await startRun(hooks);
    await hooks.beforeToolCall({ toolName: "account-lookup", params: {}, toolCallId: "call-1" }, TOOL_CTX);
    await hooks.toolResult({ toolCallId: "call-1", toolName: "account-lookup", args: {}, result: { content: [] } }, { runtime: "openclaw", runId: "run-1", sessionKey: SESSION_KEY, sessionId: SESSION_ID });
    await hooks.afterToolCall({ toolName: "account-lookup", toolCallId: "call-1" }, TOOL_CTX);
    expect(await hooks.beforeToolCall({ toolName: "account-lookup", params: {}, toolCallId: "call-2" }, TOOL_CTX)).toEqual({ params: {} });
  });
});

describe("one deadline bounds everything a hook sends", () => {
  it("blocks a run whose four steps together outlast deadlineMs, each one shorter", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS, deadlineMs: 500 });
    server.delayMs = 200;
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX)).toMatchObject({ outcome: "block" });
  });

  it("blocks a spawn whose two steps together outlast deadlineMs", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS, deadlineMs: 500 });
    await startRun(hooks);
    server.delayMs = 300;
    expect(await hooks.beforeToolCall({ toolName: "sessions_spawn", params: { task: "t" }, toolCallId: "c" }, TOOL_CTX)).toMatchObject({ block: true });
  });
});

describe("a new ServerHello is read as the first was", () => {
  it("follows the posture when the ServerHello after renegotiation carries no methods_evaluated list", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    server.forgetSessions();
    server.methodsEvaluated = null;
    expect(await callTool(hooks)).toMatchObject({ block: true });
  });
});

describe("messages waiting for a run are bounded and follow the queue mode", () => {
  const DISPATCH_CTX = { channelId: "signal", sessionKey: SESSION_KEY, senderId: SENDER };
  const dispatch = (hooks: Hooks, content: string) => hooks.beforeDispatch({ content, sessionKey: SESSION_KEY, senderId: SENDER }, DISPATCH_CTX);

  // Under followup OpenClaw holds a message decided at dispatch for a run of
  // its own: decided twice, once in each turn it is asked for.
  it("decides a message held under followup at dispatch and again as its own run's prompt", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    const sent = server.steps.length;
    expect(await dispatch(hooks, "Later")).toBeUndefined();
    await hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    expect(await hooks.beforeAgentRun({ prompt: "Later", senderId: SENDER }, { ...AGENT_CTX, runId: "run-2" })).toBeUndefined();
    expect(server.steps.slice(sent).filter((step) => step.method === "steps/userMessage").map((step) => step.turnId)).toEqual(["run-1", "run-2"]);
  });

  // The trace that broke a decide-once memory: two "yes" steered into run-1,
  // one more after it ended; run-2's prompt "yes" must still be asked.
  it("asks about a run's prompt whatever was decided with the same text before", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    await dispatch(hooks, "yes");
    await dispatch(hooks, "yes");
    await hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    await dispatch(hooks, "yes");
    const sent = server.steps.length;
    expect(await hooks.beforeAgentRun({ prompt: "yes", senderId: SENDER }, { ...AGENT_CTX, runId: "run-2" })).toBeUndefined();
    expect(server.steps.slice(sent).filter((step) => step.method === "steps/userMessage").map((step) => step.turnId)).toEqual(["run-2"]);
  });

  it("asks about a scheduled run's prompt equal to a message decided before", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS });
    await startRun(hooks);
    await dispatch(hooks, "Reminder");
    await hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    const sent = server.steps.length;
    expect(await hooks.beforeAgentRun({ prompt: "Reminder" }, NO_SENDER_CTX)).toBeUndefined();
    expect(server.steps.slice(sent).filter((step) => step.method === "steps/userMessage").map((step) => step.turnId)).toEqual(["run-2"]);
  });

  it("decides each of two waiting messages with the prompt's text, one as the prompt and one on its own", async () => {
    const { server, hooks } = setup();
    expect(await dispatch(hooks, "same")).toBeUndefined();
    expect(await dispatch(hooks, "same")).toBeUndefined();
    const sent = server.steps.length;
    expect(await hooks.beforeAgentRun({ prompt: "same", senderId: SENDER }, AGENT_CTX)).toBeUndefined();
    expect(server.steps.slice(sent).filter((step) => step.method === "steps/userMessage")).toHaveLength(2);
  });

  // collect joins several messages into one prompt: no single decision covers it.
  it("decides a joined prompt again under collect", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    const sent = server.steps.length;
    await dispatch(hooks, "first");
    await dispatch(hooks, "second");
    await hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    expect(await hooks.beforeAgentRun({ prompt: "first\nsecond", senderId: SENDER }, { ...AGENT_CTX, runId: "run-2" })).toBeUndefined();
    expect(server.steps.slice(sent).filter((step) => step.method === "steps/userMessage").map((step) => step.turnId)).toEqual(["run-1", "run-1", "run-2"]);
  });

  it("drops a message beyond maxUndecidedMessages", async () => {
    const { hooks } = setup({ maxUndecidedMessages: 2 });
    expect(await dispatch(hooks, "one")).toBeUndefined();
    expect(await dispatch(hooks, "two")).toBeUndefined();
    expect(await dispatch(hooks, "three")).toEqual({ handled: true, text: BLOCKED });
  });

  it("drops what a refused session was sent, so it holds nothing", async () => {
    const { hooks } = setup({
      maxUndecidedMessages: 2,
      methodsEvaluated: ALL_METHODS,
      reply: (step) => (step.method === "steps/sessionStart" ? { decision: { decision: "deny", reasoning: "no" } } : { decision: { decision: "allow" } }),
    });
    await dispatch(hooks, "one");
    await dispatch(hooks, "two");
    expect(await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, AGENT_CTX)).toMatchObject({ outcome: "block" });
    expect(await dispatch(hooks, "three")).toBeUndefined();
  });
});

describe("a session is started once, across a restart", () => {
  it("does not send sessionStart again for a session admitted before the restart", async () => {
    const store = mapStore();
    const before = setup({ admissions: store, methodsEvaluated: ALL_METHODS });
    await startRun(before.hooks);
    await before.hooks.agentEnd({ runId: "run-1" }, AGENT_CTX);
    await before.hooks.sessionEnd({ sessionKey: SESSION_KEY, sessionId: SESSION_ID, reason: "restart" }, {});
    const after = setup({ admissions: store, methodsEvaluated: ALL_METHODS });
    expect(await after.hooks.beforeAgentRun({ prompt: "Again", senderId: SENDER }, { ...AGENT_CTX, runId: "run-2" })).toBeUndefined();
    expect(after.server.steps.map((step) => step.method)).toEqual(["steps/agentTrigger", "steps/turnStart", "steps/userMessage"]);
  });

  it("sends sessionStart again when the session before the restart was only let through by the posture", async () => {
    const store = mapStore();
    const before = setup({
      admissions: store,
      methodsEvaluated: ALL_METHODS,
      failurePosture: "negotiated",
      onDecisionFailure: "proceed",
      reply: (step) => (step.method === "steps/sessionStart" ? { error: { code: -32603, message: "down" } } : { decision: { decision: "allow" } }),
    });
    await startRun(before.hooks);
    await before.hooks.sessionEnd({ sessionKey: SESSION_KEY, sessionId: SESSION_ID, reason: "restart" }, {});
    const after = setup({ admissions: store, methodsEvaluated: ALL_METHODS });
    await after.hooks.beforeAgentRun({ prompt: "Again", senderId: SENDER }, { ...AGENT_CTX, runId: "run-2" });
    expect(after.server.steps[0]?.method).toBe("steps/sessionStart");
  });
});

describe("the gates read a tool's parameters as OpenClaw does", () => {
  const send = (hooks: Hooks, params: Record<string, unknown>) =>
    hooks.beforeToolCall({ toolName: "sessions_send", params, toolCallId: "call-send" }, TOOL_CTX);

  // OpenClaw reads sessionKey, else session_key (readToolStringParam, src/param-key.ts).
  it("asks about sessions_send naming the sender's own session as session_key", async () => {
    const { server, hooks } = setup();
    await startRun(hooks);
    const params = { session_key: `agent:helper:signal:direct:${SENDER}`, message: "hi" };
    expect(await send(hooks, params)).toEqual({ params });
    expect(server.steps.at(-1)?.method).toBe("steps/toolCallRequest");
  });

  it.each<[string, Record<string, unknown>]>([
    ["session_key_of_another_person", { session_key: `agent:main:signal:direct:${OTHER_PHONE}`, message: "hi" }],
    // sessionKey wins over session_key, as in OpenClaw.
    ["sessionKey_of_another_person_beside_an_own_session_key", { sessionKey: `agent:main:signal:direct:${OTHER_PHONE}`, session_key: SESSION_KEY, message: "hi" }],
    ["an_empty_sessionKey_beside_a_label", { sessionKey: "", label: "support", message: "hi" }],
  ])("refuses sessions_send with %s", async (_name, params) => {
    const { hooks } = setup();
    await startRun(hooks);
    expect(await send(hooks, params)).toMatchObject({ block: true });
  });

  it("grants a message send on the account account_id names", async () => {
    const { hooks } = setup();
    await startRun(hooks);
    await hooks.beforeToolCall({ toolName: "message", params: { action: "send", replyContext: REPLY_CONTEXT, target: OTHER_PHONE, message: "Hi", account_id: "second" }, toolCallId: "call-m" }, TOOL_CTX);
    expect(await hooks.messageSending({ to: OTHER_PHONE, content: "Hi" }, { channelId: "signal", accountId: "default" })).toEqual({ cancel: true });
    expect(await hooks.messageSending({ to: OTHER_PHONE, content: "Hi" }, { channelId: "signal", accountId: "second" })).toEqual({ content: "Hi" });
  });

  it("names the spawned agent given as agent_id", async () => {
    const { server, hooks } = setup({ methodsEvaluated: ALL_METHODS });
    await startRun(hooks);
    await hooks.beforeToolCall({ toolName: "sessions_spawn", params: { task: "t", agent_id: "researcher" }, toolCallId: "c" }, TOOL_CTX);
    expect(server.steps.at(-1)).toMatchObject({ method: "steps/subagentStart", payload: { subagent_descriptor: { agent_name: "researcher" } } });
  });
});
