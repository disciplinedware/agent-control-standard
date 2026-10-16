/**
 * The adapter against a running Go reference Guardian with its stock AGT
 * policy. Run by `make example-check` in reference-implementations/agt-go,
 * which starts the Guardian and sets ACS_GUARDIAN_URL and
 * ACS_HMAC_SECRET_FILE; outside it this file fails rather than skips.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createAcsExchange } from "../acs-exchange.ts";
import { createGuardianClient, type AuditEvent, type SigningKey } from "../host-adapter.ts";
import { createHooks } from "../openclaw-hooks.ts";

const url = process.env.ACS_GUARDIAN_URL;
const secretFile = process.env.ACS_HMAC_SECRET_FILE;
const keyId = process.env.ACS_HMAC_KEY_ID;
if (url === undefined || secretFile === undefined || keyId === undefined) {
  throw new Error("set ACS_GUARDIAN_URL, ACS_HMAC_SECRET_FILE and ACS_HMAC_KEY_ID, as make example-check in reference-implementations/agt-go does");
}
const KEY: SigningKey = { keyId, secret: Buffer.from(readFileSync(secretFile, "utf8").trim(), "base64"), hkdf: { salt: "", infoPrefix: "", sessionIdEncoding: "utf8" } };
const SENDER = "+15550100";
const SESSION_KEY = `agent:main:signal:direct:${SENDER}`;

function governed(sessionId: string, guardianUrl: string = url!) {
  const audit: AuditEvent[] = [];
  const sink = { path: "memory", write: (event: AuditEvent) => (audit.push(event), true) };
  const hooks = createHooks({
    config: { approvers: new Set(), blockedReplyText: "withheld", maxUndecidedMessages: 20 },
    exchange: createAcsExchange({ client: createGuardianClient(guardianUrl, { signingKey: KEY }), audit: sink, failurePosture: "closed", deadlineMs: 5000 }),
    audit: sink,
    requirementFailure: () => undefined,
    logger: { error: () => {} },
  });
  const run = { runId: `run-${sessionId}`, sessionKey: SESSION_KEY, sessionId, senderId: SENDER, channel: "signal" };
  const tool = { runId: run.runId, sessionKey: SESSION_KEY };
  const result = (toolCallId: string, text: string) =>
    hooks.toolResult({ toolCallId, toolName: "Bash", args: {}, result: { content: [{ type: "text", text }] } }, { runtime: "openclaw", runId: run.runId, sessionKey: SESSION_KEY, sessionId });
  return { hooks, run, tool, result, audit };
}

describe("the OpenClaw adapter on the Go Guardian", () => {
  it("admits a run through sessionStart, agentTrigger, turnStart and userMessage", async () => {
    const { hooks, run } = governed(crypto.randomUUID());
    expect(await hooks.beforeAgentRun({ prompt: "List the files", senderId: SENDER }, run)).toBeUndefined();
  });

  it("runs a benign command and passes its clean result", async () => {
    const { hooks, run, tool, result } = governed(crypto.randomUUID());
    await hooks.beforeAgentRun({ prompt: "List the files", senderId: SENDER }, run);
    expect(await hooks.beforeToolCall({ toolName: "Bash", params: { command: "ls" }, toolCallId: "call-1" }, tool)).toEqual({ params: { command: "ls" } });
    expect(await result("call-1", "total 0")).toBeUndefined();
  });

  it("gives the model the Guardian's redaction of a secret in a result", async () => {
    const { hooks, run, tool, result } = governed(crypto.randomUUID());
    await hooks.beforeAgentRun({ prompt: "Show the token", senderId: SENDER }, run);
    await hooks.beforeToolCall({ toolName: "Bash", params: { command: "cat .env" }, toolCallId: "call-2" }, tool);
    expect(await result("call-2", "TOKEN=ghp_ABCDEF123456")).toEqual({ result: { content: [{ type: "text", text: "TOKEN=[REDACTED]" }] } });
  });

  it("blocks a destructive command with the Guardian's reasoning", async () => {
    const { hooks, run, tool } = governed(crypto.randomUUID());
    await hooks.beforeAgentRun({ prompt: "Clean up", senderId: SENDER }, run);
    expect(await hooks.beforeToolCall({ toolName: "Bash", params: { command: "rm -rf /" }, toolCallId: "call-3" }, tool)).toMatchObject({
      block: true,
      blockReason: expect.stringMatching(/destructive/i),
    });
  });

  it("spawns a sub-agent the Guardian allowed, through its subagentStart", async () => {
    // A second Go Guardian that evaluates only subagentStart: the stock
    // policy refuses sessions_spawn as an unregistered tool, so this one
    // leaves toolCallRequest unevaluated, as its ServerHello says, and
    // decides the spawn itself. It validates the payload against
    // subagent-start.json.
    const guardian = await startGuardian({ ACS__PROTOCOL__METHODS_EVALUATED: "steps/subagentStart" });
    try {
      const { hooks, run, tool, audit } = governed(crypto.randomUUID(), guardian.url);
      expect(await hooks.beforeAgentRun({ prompt: "Delegate", senderId: SENDER }, run)).toBeUndefined();
      const params = { task: "Summarize the open tickets", agentId: "researcher" };
      expect(await hooks.beforeToolCall({ toolName: "sessions_spawn", params, toolCallId: "call-4" }, tool)).toEqual({ params });
      expect(audit).toEqual([]);
      expect(guardian.methods()).toEqual(["handshake/hello", "steps/subagentStart"]);
    } finally {
      guardian.stop();
    }
  });

  it("ends the turn and the session", async () => {
    const sessionId = crypto.randomUUID();
    const { hooks, run, audit } = governed(sessionId);
    await hooks.beforeAgentRun({ prompt: "Hello", senderId: SENDER }, run);
    await hooks.agentEnd({ runId: run.runId, success: true }, run);
    await hooks.sessionEnd({ sessionKey: SESSION_KEY, sessionId, reason: "idle" }, {});
    expect(audit.filter((event) => event.outcome !== "approval")).toEqual([]);
  });
});

/** Starts the Go Guardian of ACS_GUARDIAN_BIN on a free port, its stock config plus `env`, and reads what it was sent. */
async function startGuardian(env: Record<string, string>): Promise<{ url: string; methods(): string[]; stop(): void }> {
  const bin = process.env.ACS_GUARDIAN_BIN;
  if (bin === undefined) {
    throw new Error("set ACS_GUARDIAN_BIN, as make example-check does");
  }
  const dir = new URL("../../../reference-implementations/agt-go/", import.meta.url).pathname;
  const scratch = mkdtempSync(`${tmpdir()}/acs-openclaw-e2e-`);
  const envelopes = `${scratch}/envelopes.jsonl`;
  const child = spawn(bin, ["--config", "guardian.yaml"], {
    cwd: dir,
    env: { ...process.env, ACS__SERVER__PORT: "0", ACS__AUDIT__ENVELOPE_LOG: envelopes, ACS__AUDIT__EVENT_LOG: `${scratch}/events.jsonl`, ...env },
  });
  let output = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the Guardian did not start: ${output}`)), 30_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /Guardian listening at (http:\/\/\S+\/acs)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("exit", () => reject(new Error(`the Guardian exited: ${output}`)));
  });
  return {
    url,
    methods: () =>
      readFileSync(envelopes, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => (JSON.parse(line) as { method?: string }).method ?? "")
        .filter((method, i, all) => method !== "" && all.indexOf(method) === i),
    stop: () => {
      child.kill();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
