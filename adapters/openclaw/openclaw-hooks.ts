/**
 * OpenClaw's hooks, governed: each one becomes a signed ACS step, and the
 * Guardian's decision becomes the hook's answer.
 *
 * `mapping.md` maps each hook to the ACS steps it sends and what each answer
 * does.
 *
 * A message outside a session a run of its recipient was admitted to is not
 * sent at all: nobody in that conversation asked for it, so neither it nor the
 * fixed text goes out. The one exception is a send of OpenClaw's own `message`
 * tool to another recipient: the Guardian decided that recipient and that text
 * at `before_tool_call`, so the send goes out under the run that made the
 * call, only to a recipient the call named, only with the text the call
 * carried, and only until the call returns. It is not a response to the
 * session's user, so it is not sent to the Guardian again as
 * `steps/agentResponse`.
 *
 * A run with no channel sender is governed as the person it acts for, when
 * OpenClaw names that person: a scheduled run (`trigger: "cron"`) in a session
 * whose key names one direct sender admitted there acts for that sender; an
 * inter-session run (OpenClaw's own `inputProvenance`, never the model's
 * words) acts for the admitted sender of the session that sent it, while that
 * session has a live run, and only into a session admitted to nobody else.
 * Any other run without a sender is refused: a heartbeat, a system event, a
 * hook.
 *
 * A message that arrives while its session's run is active joins that run
 * (OpenClaw's `steer`, its default queue mode) without `before_agent_run`, so
 * it is decided at `before_dispatch`, which OpenClaw awaits before it steers,
 * queues or starts anything, one message of a session at a time: as
 * `steps/userMessage` of the active run, or dropped with the fixed text. A
 * message of a session with no active run starts a run, decided at
 * `before_agent_run`.
 *
 * Every step carries the OpenClaw agent that runs it as `metadata.agent_name`.
 *
 * At `before_tool_call`, `modify` replaces the parameters, `ask` becomes an
 * OpenClaw approval when the approver is one this host knows, and `defer`
 * blocks the call as pending. A call of OpenClaw's spawn tool that may run is
 * then sent as `steps/subagentStart`, before the spawn, and runs only on
 * `allow`. A tool's result reaches the model only after the Guardian answered
 * its `steps/toolCallResult` (OpenClaw's tool-result middleware): `modify`
 * replaces it, and any answer but `allow` withholds it.
 *
 * The types below are the parts of OpenClaw 2026.10.2's plugin hook types
 * (`dist/channel-core-*.d.ts`) and tool-result middleware types this module
 * reads and writes.
 */
import { toSessionUuid, WITHHELD_OUTPUT, type AcsDecision, type AuditSink } from "./host-adapter.ts";
import { randomUUID } from "node:crypto";
import type { AcsExchange, Step, StepOutcome, UserContext } from "./acs-exchange.ts";
import { METHODS } from "./acs-exchange.ts";
import type { PluginConfig } from "./config.ts";
import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import { notOneSenderSessionBecause } from "./openclaw-settings.ts";
import type { Facts } from "./requirements.ts";

export type AgentContext = {
  runId?: string;
  /** The OpenClaw agent that runs the session. */
  agentId?: string;
  sessionKey?: string;
  /** OpenClaw's id of the session, new for each session that reuses the key. */
  sessionId?: string;
  senderId?: string;
  channel?: string;
  accountId?: string;
  /** What started the run: `user`, `cron`, `heartbeat`, ... */
  trigger?: string;
  /** Where a run's input came from, when not from its channel sender. */
  inputProvenance?: InputProvenance;
  /** The model the run uses. */
  modelProviderId?: string;
  modelId?: string;
};
/** OpenClaw's `inputProvenance`: an inter-session run names the session that sent it. */
export type InputProvenance = { kind?: string; sourceSessionKey?: string };
export type BeforeAgentRunEvent = { prompt: string; senderId?: string };
export type BeforeAgentRunResult = { outcome: "block"; reason: string; message?: string } | undefined;
export type BeforeDispatchEvent = { content: string; body?: string; sessionKey?: string; senderId?: string; channel?: string };
export type BeforeDispatchContext = { channelId?: string; accountId?: string; sessionKey?: string; senderId?: string };
export type BeforeDispatchResult = { handled: true; text?: string } | undefined;

export type ToolContext = { runId?: string; sessionKey?: string; sessionId?: string; toolCallId?: string };
export type BeforeToolCallEvent = { toolName: string; params: Record<string, unknown>; runId?: string; toolCallId?: string };
export type AfterToolCallEvent = { toolName: string; runId?: string; toolCallId?: string };
export type ApprovalResolution = "allow-once" | "allow-always" | "deny" | "timeout" | "cancelled";
export type RequireApproval = {
  title: string;
  description: string;
  severity?: "info" | "warning" | "critical";
  timeoutMs?: number;
  timeoutReason?: string;
  allowedDecisions?: Array<"allow-once" | "allow-always" | "deny">;
  onResolution?: (resolution: ApprovalResolution) => Promise<void> | void;
};
export type BeforeToolCallResult =
  | { params?: Record<string, unknown>; block?: boolean; blockReason?: string; requireApproval?: RequireApproval }
  | undefined;

export type MessageContext = { channelId: string; sessionKey?: string; accountId?: string };
export type MessageReceivedEvent = { from: string; content: string; senderId?: string };
export type MessageSendingEvent = { to: string; content: string };
export type MessageSendingResult = { content: string } | { cancel: true };

/** A tool result as OpenClaw's middleware hands it over and takes it back: text and image blocks. */
export type ToolResultBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResult = { content: ToolResultBlock[]; details?: unknown };
export type ToolResultEvent = { toolCallId: string; toolName: string; args: Record<string, unknown>; isError?: boolean; result: ToolResult };
export type ToolResultContext = { runtime: string; sessionId?: string; sessionKey?: string; runId?: string };
export type ToolResultAnswer = { result: ToolResult } | undefined;

export type AgentEndEvent = { runId?: string; success?: boolean };
export type SessionEndEvent = { sessionKey?: string; sessionId?: string; reason?: string };
export type SessionContext = { sessionKey?: string; sessionId?: string };

export type Hooks = {
  beforeAgentRun(event: BeforeAgentRunEvent, ctx: AgentContext): Promise<BeforeAgentRunResult>;
  beforeDispatch(event: BeforeDispatchEvent, ctx: BeforeDispatchContext): Promise<BeforeDispatchResult>;
  beforeToolCall(event: BeforeToolCallEvent, ctx: ToolContext): Promise<BeforeToolCallResult>;
  afterToolCall(event: AfterToolCallEvent, ctx: ToolContext): Promise<void>;
  toolResult(event: ToolResultEvent, ctx: ToolResultContext): Promise<ToolResultAnswer>;
  messageSending(event: MessageSendingEvent, ctx: MessageContext): Promise<MessageSendingResult>;
  messageReceived(event: MessageReceivedEvent, ctx: MessageContext): Promise<void>;
  agentEnd(event: AgentEndEvent, ctx: AgentContext): Promise<void>;
  sessionEnd(event: SessionEndEvent, ctx: SessionContext): Promise<void>;
  /** OpenClaw's `gateway_start`: the active registration starts restoring admissions. */
  gatewayStart(): Promise<void>;
};

/** OpenClaw's bounds on approval prompt text (docs/plugins/plugin-permission-requests.md). */
const APPROVAL_TITLE_MAX = 80;
const APPROVAL_DESCRIPTION_MAX = 512;

/**
 * A session a run was admitted to, and the sender its runs act for.
 * `sessionStarted` says the Guardian allowed the session's `sessionStart`, or
 * does not evaluate it, so it is not sent again after a restart.
 */
export type Admission = { sessionId: string; userContext: UserContext; agentName?: string; sessionStarted?: boolean };

/**
 * An admission in this process's map. One restored from the store is a
 * candidate: OpenClaw's send hook names no session id, so a restored row
 * cannot prove the session it was granted in still runs. It admits a scheduled
 * run whose own session id matches, which confirms it; until then it admits no
 * send.
 */
type HeldAdmission = Admission & { confirmed: boolean };

/**
 * Keeps admissions across restarts of the process, so a message to a person
 * admitted before a restart is still governed and sent. Writes are awaited
 * before the admission is used.
 */
export type AdmissionStore = {
  load(): Promise<Array<[string, Admission]>>;
  put(sessionKey: string, admission: Admission): Promise<void>;
  delete(sessionKey: string): Promise<void>;
};

/** A store that keeps nothing: admissions last as long as the process. */
export const memoryOnlyAdmissions: AdmissionStore = {
  async load() {
    return [];
  },
  async put() {},
  async delete() {},
};

/** OpenClaw's `session_end` reasons that end the process, not the session. */
const PROCESS_END_REASONS = new Set(["shutdown", "restart"]);

/** A run whose user message was allowed, and the sender it was allowed for. */
type AdmittedRun = {
  sessionKey: string;
  sessionId: string;
  userContext: UserContext;
  agentName?: string;
  /** The channel account the run came in on, when OpenClaw names one. */
  accountId?: string;
  toolCallCount: number;
};

/**
 * OpenClaw's built-in tool that sends a message to a target the model names,
 * and the parameters that name the target (OpenClaw's message tool schema and
 * `message-action-runner`): `target`, its aliases `to` and `channelId`, and
 * the list `targets`. `channel` and `accountId` name the route; `message` is
 * the text. Only an action that delivers content grants a send: OpenClaw's
 * own send actions (`MESSAGE_TOOL_SEND_ACTIONS` in its embedded-agent
 * messaging) and `broadcast`, its send to several targets.
 */
const MESSAGE_TOOL = "message";
const MESSAGE_TARGET_PARAMS = ["target", "to", "channelId"] as const;
const MESSAGE_SEND_ACTIONS: ReadonlySet<unknown> = new Set(["send", "thread-reply", "sendWithEffect", "sendAttachment", "upload-file", "broadcast"]);

/** OpenClaw's built-in tool that spawns a sub-agent: `task` is what the parent asks of it, `agentId` the agent that runs it. */
const SPAWN_TOOL = "sessions_spawn";
/** OpenClaw's built-in tool that sends a message into another session, `sessionKey` naming it. */
const SESSIONS_SEND_TOOL = "sessions_send";

/** Records a step refused before any envelope was built. */
function writeRefused(audit: AuditSink, sessionId: string | undefined, method: string, reasonCode: string, reason: string): void {
  audit.write({ session_id: sessionId ?? "", method, rpc_id: null, outcome: "refused", refused: { reason_code: reasonCode, reason } });
}

/** The audit `reason_code` of a step from a run that never passed `before_agent_run`. */
const RUN_NOT_ADMITTED = "run_not_admitted";

/** The audit `reason_code` of a failed requirement, from its `"<id>: <why>"`. */
export function requirementCode(failure: string): string {
  return `requirement:${failure.slice(0, failure.indexOf(":"))}`;
}

/** What the model reads in place of a result the Guardian did not allow. */
const WITHHELD_RESULT: ToolResultAnswer = { result: { content: [{ type: "text", text: WITHHELD_OUTPUT }] } };

/**
 * A tool call this plugin decided, until its result is read: the step its
 * result refers to, and whether it may run.
 */
type DecidedCall = { run: AdmittedRun; requestId: string | null; ran: boolean };

/** `steps/toolCallResult` outputs: one per content block, a text block as its text. */
function outputsOf(content: readonly ToolResultBlock[]): Array<{ value: unknown }> {
  return content.map((block) => ({ value: block.type === "text" ? block.text : block }));
}

/** The content blocks a modified result's outputs describe, or `undefined` when one is neither text nor an image. */
function contentOf(outputs: unknown): ToolResultBlock[] | undefined {
  if (!Array.isArray(outputs)) {
    return undefined;
  }
  const content: ToolResultBlock[] = [];
  for (const output of outputs) {
    const value = (output as { value?: unknown } | null)?.value;
    if (typeof value === "string") {
      content.push({ type: "text", text: value });
      continue;
    }
    const image = value as { type?: unknown; data?: unknown; mimeType?: unknown } | null;
    if (image?.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string") {
      return undefined;
    }
    content.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  return content;
}

function deleteWhere<K, V>(map: Map<K, V>, isGone: (value: V) => boolean): void {
  for (const [key, value] of map) {
    if (isGone(value)) {
      map.delete(key);
    }
  }
}

/**
 * A `message` call the Guardian allowed, or a person approved, to recipients
 * other than its run's sender: delivery to one of them goes out under that
 * run until the call returns, the run ends or its session ends.
 */
type SendGrant = {
  /** OpenClaw's id of the call, the grant's key. */
  callId: string;
  runId: string;
  run: AdmittedRun;
  channel: string;
  /** The account the call named, else its run's; `undefined` when neither is known. */
  accountId?: string;
  recipients: ReadonlySet<string>;
  /** The text the call sends; a delivery under the grant carries exactly this text. */
  text?: string;
};

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The grant a `message` call's parameters make for its run, or `undefined`
 * when they name no recipient but the run's own sender. A recipient is the
 * string the Guardian saw, trimmed: OpenClaw gives a plugin no channel's
 * target normalizer, so a recipient written in another form than the one
 * OpenClaw delivers to matches nothing, and its send is cancelled.
 */
function sendGrantOf(callId: string, runId: string, run: AdmittedRun, params: Record<string, unknown>): SendGrant | undefined {
  if (!MESSAGE_SEND_ACTIONS.has(params.action)) {
    return undefined;
  }
  const channel = trimmedString(params.channel)?.toLowerCase() ?? run.userContext.authentication_method;
  const recipients = new Set(
    messageRecipients(params).filter((recipient) => recipient !== run.userContext.user_id || channel !== run.userContext.authentication_method),
  );
  if (recipients.size === 0) {
    return undefined;
  }
  return {
    callId,
    runId,
    run,
    channel,
    accountId: readStringParam(params, "accountId") ?? run.accountId,
    recipients,
    text: typeof params.message === "string" ? params.message : undefined,
  };
}

/**
 * A run waiting for its user message's decision, whether OpenClaw ended it, or
 * its session, meanwhile, and when that decision is in.
 */
type PendingAdmission = { sessionKey: string; ended: boolean; settled: Promise<void> };

type AskDetails = {
  approver?: { type?: unknown; id?: unknown };
  question?: unknown;
  context?: unknown;
  options?: unknown;
  timeout_seconds: number;
};

/** One person: the same id on the same channel. */
function samePrincipal(a: UserContext, b: UserContext): boolean {
  return a.user_id === b.user_id && a.authentication_method === b.authentication_method;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function reasoningOf(decision: AcsDecision): string {
  return typeof decision.reasoning === "string" && decision.reasoning.length > 0
    ? decision.reasoning
    : `the Guardian answered ${decision.decision}`;
}

/** ACS `sessionEnd.reason` for OpenClaw's `session_end` reason. */
function sessionEndReasonOf(reason: string | undefined): string {
  switch (reason) {
    case "new":
    case "reset":
    case "deleted":
    case "compaction":
      return "completed";
    case "idle":
    case "daily":
      return "timeout";
    default:
      return "abandoned";
  }
}

/** ACS `agentTrigger.trigger_type` for OpenClaw's run trigger; a run with a channel sender and no trigger is a user's. */
function triggerTypeOf(trigger: string | undefined): string {
  switch (trigger) {
    case undefined:
    case "user":
      return "user_message";
    case "cron":
      return "scheduled";
    default:
      return "system";
  }
}

function textContent(value: string): Record<string, unknown> {
  return { content: [{ type: "text", value }] };
}

function wrapArguments(params: Record<string, unknown>): Record<string, { value: unknown }> {
  return Object.fromEntries(Object.entries(params).map(([name, value]) => [name, { value }]));
}

/** The parameters a `message` call's approval shows on their own lines. */
const MESSAGE_CALL_SHOWN_PARAMS: ReadonlySet<string> = new Set([...MESSAGE_TARGET_PARAMS, "targets", "message"]);

/** The recipients a `message` call names, trimmed, in the order it names them. */
function messageRecipients(params: Record<string, unknown>): string[] {
  const named = [...MESSAGE_TARGET_PARAMS.map((name) => params[name]), ...(Array.isArray(params.targets) ? params.targets : [])];
  return [...new Set(named.map(trimmedString).filter((recipient): recipient is string => recipient !== undefined))];
}

/**
 * A `message` call as a person reads it: the recipients, the text whole, and
 * every other parameter as JSON, so nothing that changes the send is hidden.
 * A call that names no recipient goes to the current conversation, the
 * session's sender, unless a channel's own target parameter names another
 * (`resolveActionDeliveryTargetAlias`, `src/infra/outbound/message-action-spec.ts`),
 * which the plugin cannot read; the line says so rather than name the sender.
 */
function messageCallLines(params: Record<string, unknown>, sender: string): string[] {
  const recipients = messageRecipients(params);
  const others = Object.keys(params).some((name) => !MESSAGE_CALL_SHOWN_PARAMS.has(name) && name !== "action");
  const lines = [
    recipients.length > 0
      ? `To: ${recipients.join(", ")}`
      : `To: ${sender}${others ? ", unless a parameter under Other names another recipient" : ""}`,
  ];
  if (typeof params.message === "string") {
    // A text of several lines is shown under a bar, so none of its lines can
    // pass for a line of the prompt.
    lines.push(...(params.message.includes("\n") ? ["Text:", ...params.message.split("\n").map((line) => `  | ${line}`)] : [`Text: ${params.message}`]));
  }
  const shown = new Set<string>([...MESSAGE_CALL_SHOWN_PARAMS, ...(params.action === "send" ? ["action"] : [])]);
  const rest = Object.fromEntries(Object.entries(params).filter(([name]) => !shown.has(name)));
  if (Object.keys(rest).length > 0) {
    lines.push(`Other: ${JSON.stringify(rest)}`);
  }
  return lines;
}

/**
 * What the approver reads: the Guardian's question, then the call exactly as
 * it will run, so the person approves the parameters, not a summary of them.
 * A `message` call is shown in plain words, followed by what its recipients
 * wrote since the agent last wrote to them, each message on one quoted line
 * so a recipient's words cannot pass for a line of the call: the oldest is
 * cut first, and the call never. `undefined` when the call does not fit
 * OpenClaw's bound whole: a cut call would be approved as if it were whole.
 */
function approvalText(
  details: AskDetails,
  decision: AcsDecision,
  approverId: string,
  toolName: string,
  params: Record<string, unknown>,
  sender: string,
  written: (person: string) => readonly string[],
): string | undefined {
  const head = [typeof details.question === "string" ? details.question : reasoningOf(decision)];
  if (typeof details.context === "string") {
    head.push(details.context);
  }
  if (Array.isArray(details.options) && details.options.length > 0) {
    head.push(`Options: ${details.options.map(String).join("; ")}`);
  }
  const call = toolName === MESSAGE_TOOL ? messageCallLines(params, sender) : [`Call: ${toolName} ${JSON.stringify(params)}`];
  call.push(`Approver: ${approverId}`);
  const whole = (wrote: string[]) => [...head, ...call, ...wrote].join("\n");
  if (whole([]).length > APPROVAL_DESCRIPTION_MAX) {
    return undefined;
  }
  if (toolName !== MESSAGE_TOOL) {
    return whole([]);
  }
  const recipients = messageRecipients(params);
  let wrote: string[] = [];
  for (const person of recipients.length > 0 ? recipients : [sender]) {
    const messages = written(person);
    if (messages.length === 0) {
      continue;
    }
    // Newest first, so the oldest is what does not fit.
    const kept: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const quoted = `  > ${messages[i]!.replace(/\s+/g, " ")}`;
      const room = APPROVAL_DESCRIPTION_MAX - whole([...wrote, `Before this, ${person} wrote:`, ...kept]).length - 1;
      if (room <= 4) {
        break;
      }
      kept.unshift(quoted.length <= room ? quoted : truncate(quoted, room));
      if (quoted.length > room) {
        break;
      }
    }
    if (kept.length > 0) {
      wrote = [...wrote, `Before this, ${person} wrote:`, ...kept];
    }
  }
  return whole(wrote);
}

export type CreateHooksOptions = {
  config: Pick<PluginConfig, "approvers" | "blockedReplyText" | "maxUndecidedMessages">;
  exchange: AcsExchange;
  audit: AuditSink;
  /** The first requirement (`requirements.ts`) checked at `point` that the config OpenClaw runs with now fails for `facts`, or `undefined`. */
  requirementFailure(point: "run" | "dispatch", facts: Facts): string | undefined;
  logger: { error(message: string): void };
  /** Where admissions outlive the process; in memory only when absent. */
  admissions?: AdmissionStore;
};

/** Who a run acts for, and how it was triggered. */
type Origin = {
  userContext: UserContext;
  channel: string;
  triggerType: string;
  turnTrigger: string;
  /** Whether admitting the run admits its session for sends to this sender. */
  admitsSession: boolean;
};

export function createHooks({
  config,
  exchange,
  audit,
  requirementFailure,
  logger,
  admissions: store = memoryOnlyAdmissions,
}: CreateHooksOptions): Hooks {
  /**
   * The sender of every session that has had an admitted run, until OpenClaw
   * ends the session, so the map is as large as OpenClaw's own set of live
   * sessions. A message is sent only in a session listed here: a runtime that
   * skips `before_agent_run` admits no run, and its messages are cancelled.
   */
  const admittedSessions = new Map<string, HeldAdmission>();
  /**
   * Keys this process admitted or forgot since it started: a stored row for one
   * of them is older than what the map holds, so restoring skips it.
   */
  const touchedSinceStart = new Set<string>();
  /**
   * The stored admissions coming back into the map, started by the first hook:
   * a run waits for it, within its deadline, so a restored session is not
   * started again and a scheduled run finds its sender; a send does not.
   */
  let restoring: Promise<void> | undefined;
  let restoreDone = false;
  function restored(): Promise<void> {
    restoring ??= (async () => {
      try {
        for (const [sessionKey, admission] of await store.load()) {
          if (!touchedSinceStart.has(sessionKey)) {
            admittedSessions.set(sessionKey, { ...admission, confirmed: false });
            if (admission.sessionStarted === true && startedSessions.get(admission.sessionId) === undefined) {
              startedSessions.set(admission.sessionId, true);
            }
          }
        }
      } catch (error) {
        logger.error(`ACS plugin could not restore admitted sessions: ${(error as Error).message}`);
      } finally {
        restoreDone = true;
        touchedSinceStart.clear();
      }
    })();
    return restoring;
  }

  /** Resolves when `promise` does, or at `deadlineAt`, whichever is first. */
  async function until(promise: Promise<void>, deadlineAt: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(0, deadlineAt - performance.now()))));
    await Promise.race([promise, late]).finally(() => clearTimeout(timer));
  }

  /** Writes of one key, in order, so a delete never lands before the put it follows. */
  const storeWrites = new Map<string, Promise<void>>();
  function persist(sessionKey: string, write: () => Promise<void>, failure: string): Promise<void> {
    const next = (storeWrites.get(sessionKey) ?? Promise.resolve()).then(write).catch((error: unknown) => {
      logger.error(`ACS plugin could not ${failure}: ${(error as Error).message}`);
    });
    storeWrites.set(sessionKey, next);
    void next.then(() => {
      if (storeWrites.get(sessionKey) === next) {
        storeWrites.delete(sessionKey);
      }
    });
    return next;
  }

  async function admit(sessionKey: string, admission: Admission): Promise<void> {
    touchedSinceStart.add(sessionKey);
    admittedSessions.set(sessionKey, { ...admission, confirmed: true });
    await persist(sessionKey, () => store.put(sessionKey, admission), "store an admitted session");
  }

  async function forgetAdmission(sessionKey: string): Promise<void> {
    touchedSinceStart.add(sessionKey);
    admittedSessions.delete(sessionKey);
    await persist(sessionKey, () => store.delete(sessionKey), "delete an admitted session");
  }
  /** Every admitted run that has not ended, by run id. */
  const runs = new Map<string, AdmittedRun>();
  /** The one admitted run of each session that has not ended. */
  const liveRunOfSession = new Map<string, string>();
  /**
   * Messages `before_dispatch` left to `before_agent_run` because their
   * session had no run, by session key, until a run of the session is
   * admitted. The run admitted next could take any of them in by steering, so
   * it sends each one its own prompt does not carry as its own `userMessage`,
   * and is refused when one is; a refused run leaves them for the next.
   */
  const undecidedInbound = new Map<string, string[]>();
  /** Runs waiting for their user message's decision. */
  const pendingAdmissions = new Map<string, PendingAdmission>();
  /**
   * Sessions, by OpenClaw session id, whose `steps/sessionStart` this process
   * has sent, until OpenClaw ends them: `true` when allowed, otherwise why the
   * Guardian refused the session, which then admits no run.
   */
  const startedSessions = new Map<string, true | string>();
  /**
   * What each person wrote since the agent's last message to them, oldest
   * first, by channel and person: an approval prompt shows it. Only as much as
   * a prompt can hold is kept.
   */
  const unanswered = new Map<string, string[]>();
  /** One person on one channel account: an approver of one account never sees what was written to another. */
  const personKey = (channel: string, accountId: string | undefined, person: string) => `${channel}\n${accountId ?? ""}\n${person}`;
  /** Grants of `message` calls that have not returned, by OpenClaw's tool call id. */
  const sendGrants = new Map<string, SendGrant>();
  /** Calls this plugin decided whose result has not been read, by OpenClaw's tool call id. */
  const decidedCalls = new Map<string, DecidedCall>();

  /**
   * The live grant a send to `to` goes out under, or `undefined`. A delivery
   * names no run of its own, so it is a grant's only with the grant's exact
   * text: the Guardian, or the person who approved, decided that text, and
   * any other delivery to the recipient, such as their own session's reply,
   * takes the session's path. Two runs' grants to one recipient with one text
   * leave no single run, and the delivery is not sent.
   */
  function grantFor(to: string, ctx: MessageContext, content: string): SendGrant | undefined {
    const matching = [...sendGrants.values()].filter(
      (grant) =>
        runs.get(grant.runId) === grant.run &&
        grant.channel === ctx.channelId &&
        (grant.accountId === undefined || grant.accountId === ctx.accountId) &&
        grant.recipients.has(to) &&
        (grant.text ?? "") === content,
    );
    return matching.length > 0 && matching.every((grant) => grant.run === matching[0]!.run) ? matching[0] : undefined;
  }

  const refuse = (sessionId: string | undefined, method: string, reasonCode: string, reason: string) =>
    writeRefused(audit, sessionId, method, reasonCode, reason);

  /** §6.5's record of a decision this gate carried out as a block. */
  function auditSubstitution(
    sessionId: string,
    method: string,
    requestId: string | null,
    decision: string,
    reasonCode: string,
  ): void {
    audit.write({
      session_id: sessionId,
      method,
      rpc_id: requestId,
      outcome: "substituted",
      substituted: { decision, reason_code: reasonCode },
    });
  }

  /** `allow` passes; any other decision blocks, and one this gate could not express is audited as such. */
  function isAllowed(outcome: StepOutcome, sessionId: string, method: string): boolean {
    const { decision } = outcome;
    if (decision.decision === "allow") {
      return true;
    }
    if (outcome.stage === "honoured" && decision.decision !== "deny") {
      auditSubstitution(sessionId, method, outcome.requestId, decision.decision, `${decision.decision}_unsupported`);
    }
    return false;
  }

  function approvalFor(
    toolName: string,
    params: Record<string, unknown>,
    decision: AcsDecision,
    run: AdmittedRun,
    requestId: string | null,
    onApproved: () => void,
  ): BeforeToolCallResult {
    const { sessionId } = run;
    const channel = run.userContext.authentication_method;
    // The account the send goes out on, as its grant reads it.
    const accountId = readStringParam(params, "accountId") ?? run.accountId;
    const details = decision.ask_details as AskDetails;
    const approverId = typeof details.approver?.id === "string" ? details.approver.id : "";
    const approverType = typeof details.approver?.type === "string" ? details.approver.type : "";
    if (!config.approvers.has(approverId)) {
      auditSubstitution(sessionId, METHODS.toolCallRequest, requestId, "ask", "approver_unknown");
      return {
        block: true,
        blockReason: `${reasoningOf(decision)} (approval by ${JSON.stringify(approverId)} cannot be requested from this host)`,
      };
    }
    const description = approvalText(details, decision, approverId, toolName, params, run.userContext.user_id, (person) =>
      unanswered.get(personKey(channel, accountId, person)) ?? [],
    );
    if (description === undefined) {
      auditSubstitution(sessionId, METHODS.toolCallRequest, requestId, "ask", "approval_text_too_long");
      return {
        block: true,
        blockReason: `${reasoningOf(decision)} (the approval cannot show this call whole within ${APPROVAL_DESCRIPTION_MAX} characters; make it shorter)`,
      };
    }
    return {
      // The parameters the Guardian saw: OpenClaw freezes the parameters an
      // approval covers when the approval is requested.
      params,
      requireApproval: {
        title: truncate(`Approve ${toolName}?`, APPROVAL_TITLE_MAX),
        description,
        severity: "warning",
        timeoutMs: details.timeout_seconds * 1000,
        timeoutReason: `No approval within ${details.timeout_seconds} seconds; the call was not run.`,
        allowedDecisions: ["allow-once", "deny"],
        // OpenClaw calls this before it runs an approved call.
        onResolution(resolution: ApprovalResolution): void {
          if (resolution === "allow-once" || resolution === "allow-always") {
            onApproved();
          }
          audit.write({
            session_id: sessionId,
            method: METHODS.toolCallRequest,
            rpc_id: requestId,
            outcome: "approval",
            approval: {
              requested_approver: { type: approverType, id: approverId },
              resolution,
              decision: resolution === "allow-once" || resolution === "allow-always" ? "allow" : "deny",
            },
          });
        },
      },
    };
  }

  /**
   * Records the Guardian's answer to a session's `sessionStart`. A refusal
   * outranks every allow, including one that arrives after it from a run
   * that asked at the same time. Only the Guardian's own answer is recorded,
   * or a Guardian that does not evaluate the step: a run the failure posture
   * let through leaves the session to be asked again.
   */
  function recordSessionStart(sessionId: string, outcome: StepOutcome, allowed: boolean): void {
    if (outcome.stage === "delivery") {
      return;
    }
    if (!allowed) {
      startedSessions.set(sessionId, `the Guardian refused this session: ${reasoningOf(outcome.decision)}`);
    } else if (startedSessions.get(sessionId) === undefined) {
      startedSessions.set(sessionId, true);
    }
  }

  /** Why this run may not be admitted to its session now, or `undefined`. */
  function admissionRefusal(sessionKey: string, runId: string): string | undefined {
    const liveRun = liveRunOfSession.get(sessionKey);
    return liveRun !== undefined && liveRun !== runId ? "another run of this session has not ended" : undefined;
  }

  /** Why the requirements checked at a run fail for this run acting for `senderId` on `channel`, logged; or `undefined`. */
  function runRequirementFailure(ctx: AgentContext, sessionKey: string, senderId: string, channel: string): string | undefined {
    const failed = requirementFailure("run", {
      senderId,
      channel,
      accountId: ctx.accountId,
      sessionKey,
      agentId: ctx.agentId,
      model: { provider: ctx.modelProviderId, id: ctx.modelId },
    });
    if (failed !== undefined) {
      logger.error(`ACS plugin admits no run: ${failed}`);
      refuse(ctx.sessionId ?? sessionKey, METHODS.userMessage, requirementCode(failed), failed);
    }
    return failed;
  }

  /** Who this run acts for, or why nobody can be named. */
  function originOf(event: BeforeAgentRunEvent, ctx: AgentContext, sessionKey: string, sessionId: string): Origin | string {
    const senderId = event.senderId ?? ctx.senderId;
    if (senderId !== undefined) {
      if (ctx.channel === undefined) {
        return "the run carries no channel";
      }
      const failed = runRequirementFailure(ctx, sessionKey, senderId, ctx.channel);
      if (failed !== undefined) {
        return failed;
      }
      return {
        userContext: { user_id: senderId, authentication_method: ctx.channel },
        channel: ctx.channel,
        triggerType: triggerTypeOf(ctx.trigger),
        turnTrigger: "user_message",
        admitsSession: true,
      };
    }
    const provenance = ctx.inputProvenance;
    if (provenance?.kind === "inter_session") {
      const source = provenance.sourceSessionKey === undefined ? undefined : admittedSessions.get(provenance.sourceSessionKey);
      if (source === undefined || !liveRunOfSession.has(provenance.sourceSessionKey!)) {
        return "the run's source session has no admitted live run";
      }
      // Only into a direct session of the same person on the same channel,
      // whether or not it was admitted yet: never into another peer's session.
      const { user_id: sourceUser, authentication_method: sourceChannel } = source.userContext;
      if (notOneSenderSessionBecause(sessionKey, sourceChannel, sourceUser, ctx.accountId) !== undefined) {
        return "the run's source session belongs to another person than its own session";
      }
      const target = admittedSessions.get(sessionKey);
      if (target !== undefined && (!samePrincipal(target.userContext, source.userContext) || target.sessionId !== sessionId)) {
        return "the run's session is admitted to another person or another session";
      }
      const failed = runRequirementFailure(ctx, sessionKey, sourceUser, sourceChannel);
      if (failed !== undefined) {
        return failed;
      }
      return {
        userContext: source.userContext,
        channel: source.userContext.authentication_method,
        triggerType: "external_event",
        turnTrigger: "external_event",
        admitsSession: false,
      };
    }
    if (ctx.trigger !== "cron") {
      return "the run carries no channel sender and is not a scheduled run";
    }
    if (!restoreDone) {
      return "the plugin has not restored its admitted sessions yet";
    }
    const admitted = admittedSessions.get(sessionKey);
    if (admitted === undefined || admitted.sessionId !== sessionId) {
      return "the run carries no channel sender, and its session has no admitted sender";
    }
    const { user_id: userId, authentication_method: channel } = admitted.userContext;
    const failed = runRequirementFailure(ctx, sessionKey, userId, channel);
    if (failed !== undefined) {
      return failed;
    }
    return {
      userContext: admitted.userContext,
      channel,
      triggerType: "scheduled",
      turnTrigger: "scheduled",
      // A matching session id proves the restored candidate's session runs.
      admitsSession: !admitted.confirmed,
    };
  }

  /** `undefined` when the run may start; otherwise why it may not. */
  async function governRun(event: BeforeAgentRunEvent, ctx: AgentContext): Promise<string | undefined> {
    const deadlineAt = exchange.deadlineFromNow();
    await until(restored(), deadlineAt);
    const { sessionKey, sessionId, runId } = ctx;
    if (sessionKey === undefined || sessionId === undefined || runId === undefined) {
      return "the run carries no session or run id";
    }
    const origin = originOf(event, ctx, sessionKey, sessionId);
    if (typeof origin === "string") {
      return origin;
    }
    const { userContext, channel } = origin;
    const agentName = ctx.agentId;
    const refusedBefore = admissionRefusal(sessionKey, runId);
    if (refusedBefore !== undefined) {
      return refusedBefore;
    }
    const started = startedSessions.get(sessionId);
    if (typeof started === "string") {
      // A refused session admits no run until OpenClaw ends it, so nothing
      // it was sent can be taken in.
      undecidedInbound.delete(sessionKey);
      return started;
    }
    let settle!: () => void;
    const pending: PendingAdmission = { sessionKey, ended: false, settled: new Promise<void>((resolve) => (settle = resolve)) };
    pendingAdmissions.set(runId, pending);
    // Taken with the pending entry in one synchronous step: a message
    // dispatched after it waits for this admission instead.
    // The first undecided message that is the prompt itself, compared whole,
    // is the prompt's step: a shorter one found inside a longer prompt is
    // another message, and a second message with the same text is another
    // message too. Deciding a message twice costs a step; leaving one
    // undecided would not be safe.
    const waiting = undecidedInbound.get(sessionKey) ?? [];
    const promptAt = waiting.findIndex((text) => text.trim() === event.prompt.trim());
    const undecided = waiting.filter((_, i) => i !== promptAt);
    undecidedInbound.delete(sessionKey);
    /** How many of `undecided` the Guardian has answered, allow or not. */
    let decidedCount = 0;
    /**
     * Puts the messages the Guardian has not answered back for the session's
     * next run, ahead of any that arrived meanwhile. An answered one is not
     * put back: a refused message would refuse every later run.
     */
    const leaveUndecided = () => {
      const left = undecided.slice(decidedCount);
      if (left.length > 0) {
        undecidedInbound.set(sessionKey, [...left, ...(undecidedInbound.get(sessionKey) ?? [])]);
      }
    };
    // In ACS order: the session once, then this run's activation, its turn and
    // its user message. Each is a gate; the first refusal blocks the run. The
    // session and activation steps are outside the turn, so they carry no
    // `turn_id` (request-envelope.json, `metadata.turn_id`).
    const runSteps: Array<Pick<Step, "method" | "payload" | "turnId"> & { undecided?: boolean }> = [
      ...(started === undefined
        ? [{ method: METHODS.sessionStart, payload: { user_identity: userContext, platform_context: { channel } } }]
        : []),
      { method: METHODS.agentTrigger, payload: { trigger_type: origin.triggerType, trigger_source: { channel } } },
      { method: METHODS.turnStart, payload: { turn_id: runId, triggered_by: origin.turnTrigger }, turnId: runId },
      { method: METHODS.userMessage, payload: textContent(event.prompt), turnId: runId },
      ...undecided.map((text) => ({ method: METHODS.userMessage, payload: textContent(text), turnId: runId, undecided: true })),
    ];
    try {
      for (const { undecided: isUndecided, ...runStep } of runSteps) {
        const outcome = await exchange.decide({ ...runStep, sessionId, userContext, agentName, modificationDocument: {} }, deadlineAt);
        if (isUndecided) {
          decidedCount += 1;
        }
        const allowed = isAllowed(outcome, sessionId, runStep.method);
        if (runStep.method === METHODS.sessionStart) {
          recordSessionStart(sessionId, outcome, allowed);
        }
        if (!allowed) {
          if (typeof startedSessions.get(sessionId) === "string") {
            undecidedInbound.delete(sessionKey);
          } else {
            leaveUndecided();
          }
          return reasoningOf(outcome.decision);
        }
      }
    } catch (error) {
      leaveUndecided();
      throw error;
    } finally {
      if (pendingAdmissions.get(runId) === pending) {
        pendingAdmissions.delete(runId);
      }
      settle();
    }
    // Asked again, because while the Guardian decided OpenClaw may have ended
    // this run or its session, or admitted another run of the session; the
    // checks and the binding below are one synchronous step.
    if (pending.ended) {
      leaveUndecided();
      return "the run or its session ended while the Guardian decided";
    }
    const refusedAfter = admissionRefusal(sessionKey, runId);
    if (refusedAfter !== undefined) {
      leaveUndecided();
      return refusedAfter;
    }
    const startedAfter = startedSessions.get(sessionId);
    if (typeof startedAfter === "string") {
      leaveUndecided();
      return startedAfter;
    }
    const run: AdmittedRun = { sessionKey, sessionId, userContext, agentName, accountId: ctx.accountId, toolCallCount: 0 };
    runs.set(runId, run);
    liveRunOfSession.set(sessionKey, runId);
    const held = admittedSessions.get(sessionKey);
    const sessionStarted = startedSessions.get(sessionId) === true;
    if (origin.admitsSession && (held?.sessionId !== sessionId || !held.confirmed || held.sessionStarted !== sessionStarted)) {
      await admit(sessionKey, { sessionId, userContext, agentName, sessionStarted });
      // OpenClaw may have ended the run or its session while the admission
      // was written: then it is not admitted, and the session's end forgets it.
      if (runs.get(runId) !== run) {
        return "the run or its session ended while it was admitted";
      }
    }
    return undefined;
  }

  /**
   * `undefined` when a message may join its session's active run, or start a
   * run, or why it may not. A session whose run is still being admitted is
   * waited for, so a message cannot slip into a run admitted after it was
   * looked at; a message left to `before_agent_run` is kept as undecided for
   * whichever run of the session is admitted next.
   */
  async function governSteer(event: BeforeDispatchEvent, ctx: BeforeDispatchContext): Promise<string | undefined> {
    const deadlineAt = exchange.deadlineFromNow();
    const sessionKey = event.sessionKey ?? ctx.sessionKey;
    if (sessionKey === undefined) {
      return "the message names no session, so the run it would join cannot be known";
    }
    const failed = requirementFailure("dispatch", {
      senderId: event.senderId ?? ctx.senderId,
      channel: ctx.channelId ?? event.channel,
      accountId: ctx.accountId,
      sessionKey,
    });
    if (failed !== undefined) {
      refuse(sessionKey, METHODS.userMessage, requirementCode(failed), failed);
      return failed;
    }
    const text = event.body ?? event.content;
    for (;;) {
      const pending = [...pendingAdmissions.values()].find((entry) => entry.sessionKey === sessionKey);
      if (pending === undefined) {
        break;
      }
      await pending.settled;
    }
    const runId = liveRunOfSession.get(sessionKey);
    const run = runId === undefined ? undefined : runs.get(runId);
    if (runId === undefined || run === undefined) {
      const waiting = undecidedInbound.get(sessionKey) ?? [];
      if (waiting.length >= config.maxUndecidedMessages) {
        return `the session already holds ${waiting.length} messages no run has taken in`;
      }
      undecidedInbound.set(sessionKey, [...waiting, text]);
      return undefined;
    }
    const senderId = event.senderId ?? ctx.senderId;
    if (senderId !== run.userContext.user_id) {
      return "the message's sender is not the sender of the run it would join";
    }
    const outcome = await exchange.decide({
      method: METHODS.userMessage,
      sessionId: run.sessionId,
      userContext: run.userContext,
      agentName: run.agentName,
      turnId: runId,
      payload: textContent(text),
      modificationDocument: {},
    }, deadlineAt);
    if (!isAllowed(outcome, run.sessionId, METHODS.userMessage)) {
      return reasoningOf(outcome.decision);
    }
    // The decision is for this run: one that ended meanwhile takes nothing in,
    // and the message would start a run, or join one, nobody decided it for.
    // Under a queue mode that does not steer, OpenClaw holds the message for a
    // run of its own; that run asks about it again, as its prompt, in its turn.
    return runs.get(runId) === run && liveRunOfSession.get(sessionKey) === runId
      ? undefined
      : "the run the message would join ended while the Guardian decided";
  }

  /**
   * Why a call would hand input to a run no gate of this plugin sees, or
   * `undefined`:
   * - `sessions_send` queues its message straight into the target session's
   *   running turn, without `before_dispatch` or `before_agent_run`
   *   (`trySessionsSendActiveRunDelivery`, `src/agents/tools/sessions-send-tool.delivery.ts`).
   *   Only a session of the run's own sender, named by its key, is a target;
   * - `sessions_spawn` with any runtime but `subagent` starts an ACP run,
   *   which passes no `before_agent_run`.
   */
  function ungovernedCallBecause(toolName: string, params: Record<string, unknown>, run: AdmittedRun): string | undefined {
    if (toolName === SESSIONS_SEND_TOOL) {
      const target = readStringParam(params, "sessionKey");
      const { user_id: sender, authentication_method: channel } = run.userContext;
      if (target === undefined || notOneSenderSessionBecause(target, channel, sender, run.accountId) !== undefined) {
        return "sessions_send may only name, by its sessionKey, a direct session of this run's own sender.";
      }
    }
    if (toolName === SPAWN_TOOL && params.runtime !== undefined && params.runtime !== "subagent") {
      return `A ${String(params.runtime)} run passes no gate of this plugin; spawn with runtime "subagent".`;
    }
    return undefined;
  }

  async function governToolCall(event: BeforeToolCallEvent, ctx: ToolContext): Promise<BeforeToolCallResult> {
    const deadlineAt = exchange.deadlineFromNow();
    if (ctx.runId !== undefined && event.runId !== undefined && ctx.runId !== event.runId) {
      return { block: true, blockReason: "This call names two different runs." };
    }
    const runId = ctx.runId ?? event.runId;
    const run = runId === undefined ? undefined : runs.get(runId);
    if (runId === undefined || run === undefined) {
      refuse(ctx.sessionId ?? ctx.sessionKey, METHODS.toolCallRequest, RUN_NOT_ADMITTED, "the call's run never passed before_agent_run, or was refused there");
      return { block: true, blockReason: "This call's run was not admitted, so this call cannot be authorized." };
    }
    const { sessionKey, sessionId, userContext, agentName } = run;
    if ((ctx.sessionKey !== undefined && ctx.sessionKey !== sessionKey) || (ctx.sessionId !== undefined && ctx.sessionId !== sessionId)) {
      return { block: true, blockReason: "This call's session is not the session its run started in." };
    }
    const ungoverned = ungovernedCallBecause(event.toolName, event.params, run);
    if (ungoverned !== undefined) {
      return { block: true, blockReason: ungoverned };
    }
    run.toolCallCount += 1;
    const outcome = await exchange.decide({
      method: METHODS.toolCallRequest,
      sessionId,
      userContext,
      agentName,
      turnId: runId,
      payload: { tool: { name: event.toolName }, arguments: wrapArguments(event.params) },
      modificationDocument: { ...event.params },
    }, deadlineAt);
    // The run may have ended, or its session, while the Guardian decided; the
    // decision is for this run only.
    if (runs.get(runId) !== run) {
      return { block: true, blockReason: "This call's run or session changed while the Guardian decided." };
    }
    const { decision } = outcome;
    // A grant lives until its call returns, which `after_tool_call` names by
    // this id: a call without one grants nothing.
    const callId = event.toolCallId ?? ctx.toolCallId;
    const decided: DecidedCall = { run, requestId: outcome.requestId, ran: false };
    if (callId !== undefined) {
      decidedCalls.set(callId, decided);
    }
    /** Marks the call as run with `params`, and lets a `message` call deliver to the recipients they name. */
    const runWith = (params: Record<string, unknown>): void => {
      decided.ran = true;
      if (callId === undefined || event.toolName !== MESSAGE_TOOL || runs.get(runId) !== run) {
        return;
      }
      const grant = sendGrantOf(callId, runId, run, params);
      if (grant !== undefined) {
        sendGrants.set(callId, grant);
      }
    };
    const applied = decision.decision === "modify" ? (decision.applied_input as Record<string, unknown> | undefined) : undefined;
    if (decision.decision === "modify" && applied === undefined) {
      return { block: true, blockReason: "The Guardian's modification could not be applied." };
    }
    const mayRunWith = decision.decision === "allow" || decision.decision === "ask" ? event.params : applied;
    if (event.toolName === SPAWN_TOOL && mayRunWith !== undefined) {
      // The step that triggered the spawn is this call's; OpenClaw's own id
      // names it when the Guardian was not sent the call.
      const refused = await governSpawn(run, runId, mayRunWith, outcome.requestId ?? callId ?? runId, deadlineAt);
      if (refused !== undefined) {
        return { block: true, blockReason: refused };
      }
    }
    switch (decision.decision) {
      case "allow":
        runWith(event.params);
        // OpenClaw keeps the last `params` a handler returns, and this handler
        // runs last: the call runs with exactly what the Guardian saw.
        return { params: event.params };
      case "modify":
        runWith(applied!);
        return { params: applied! };
      case "ask":
        return approvalFor(event.toolName, event.params, decision, run, outcome.requestId, () => runWith(event.params));
      case "defer":
        auditSubstitution(sessionId, METHODS.toolCallRequest, outcome.requestId, "defer", "defer_unsupported");
        return { block: true, blockReason: `Pending: ${reasoningOf(decision)}` };
      default:
        return { block: true, blockReason: reasoningOf(decision) };
    }
  }

  /**
   * `undefined` when the Guardian allows the sub-agent a spawn call with
   * `params` would start, otherwise why not. The sub-agent's ACS session is
   * new; ACS's `intent_derivation` is `derived_from_parent`, because the
   * parent's model writes the sub-agent's task.
   */
  async function governSpawn(
    run: AdmittedRun,
    runId: string,
    params: Record<string, unknown>,
    parentStepId: string,
    deadlineAt: number,
  ): Promise<string | undefined> {
    const task = typeof params.task === "string" ? params.task : undefined;
    const agentId = readStringParam(params, "agentId");
    const outcome = await exchange.decide({
      method: METHODS.subagentStart,
      sessionId: run.sessionId,
      userContext: run.userContext,
      agentName: run.agentName,
      turnId: runId,
      payload: {
        subagent_session_id: randomUUID(),
        parent_session_id: toSessionUuid(run.sessionId),
        parent_step_id: parentStepId,
        intent_derivation: "derived_from_parent",
        ...(task === undefined ? {} : { subagent_intent: { raw: task } }),
        ...(agentId === undefined ? {} : { subagent_descriptor: { agent_name: agentId } }),
      },
      modificationDocument: {},
    }, deadlineAt);
    if (runs.get(runId) !== run) {
      return "This call's run or session changed while the Guardian decided.";
    }
    return isAllowed(outcome, run.sessionId, METHODS.subagentStart) ? undefined : reasoningOf(outcome.decision);
  }

  /**
   * The result the model reads: unchanged on `allow`, rewritten on `modify`,
   * withheld otherwise. A result of a call this plugin did not let run is
   * sent as `blocked`, so no result reaches the model unasked whatever ran.
   * A result outside an admitted run has nobody the Guardian could be asked
   * for, and is withheld.
   */
  async function governToolResult(event: ToolResultEvent, ctx: ToolResultContext): Promise<ToolResultAnswer> {
    const deadlineAt = exchange.deadlineFromNow();
    const decided = decidedCalls.get(event.toolCallId);
    decidedCalls.delete(event.toolCallId);
    const runId = ctx.runId;
    const run = runId === undefined ? undefined : runs.get(runId);
    if (runId === undefined || run === undefined || (ctx.sessionId !== undefined && ctx.sessionId !== run.sessionId) || (decided !== undefined && decided.run !== run)) {
      refuse(ctx.sessionId ?? ctx.sessionKey, METHODS.toolCallResult, RUN_NOT_ADMITTED, "the result's run never passed before_agent_run, or is not the run of its call");
      return WITHHELD_RESULT;
    }
    const payload: Record<string, unknown> = {
      tool: { name: event.toolName },
      exit_status: decided !== undefined && !decided.ran ? "blocked" : event.isError === true ? "failure" : "success",
      outputs: outputsOf(event.result.content),
      ...(decided?.requestId == null ? {} : { request_id_ref: decided.requestId }),
    };
    const outcome = await exchange.decide({
      method: METHODS.toolCallResult,
      sessionId: run.sessionId,
      userContext: run.userContext,
      agentName: run.agentName,
      turnId: runId,
      payload,
      modificationDocument: { ...payload },
    }, deadlineAt);
    if (runs.get(runId) !== run) {
      return WITHHELD_RESULT;
    }
    const { decision } = outcome;
    if (decision.decision === "modify") {
      const content = contentOf((decision.applied_input as { outputs?: unknown } | undefined)?.outputs);
      if (content === undefined) {
        auditSubstitution(run.sessionId, METHODS.toolCallResult, outcome.requestId, "modify", "modifications_invalid");
        return WITHHELD_RESULT;
      }
      return { result: { content } };
    }
    return isAllowed(outcome, run.sessionId, METHODS.toolCallResult) ? undefined : WITHHELD_RESULT;
  }

  /** Asks the Guardian about a message's text as `steps/agentResponse`; `isCurrent` is asked again after the wait. */
  async function responseAllowed(
    step: { sessionId: string; userContext: UserContext; agentName?: string; turnId?: string },
    content: string,
    isCurrent: () => boolean,
  ): Promise<boolean | "stale"> {
    const outcome = await exchange.decide({ ...step, method: METHODS.agentResponse, payload: textContent(content), modificationDocument: {} });
    return isCurrent() ? isAllowed(outcome, step.sessionId, METHODS.agentResponse) : "stale";
  }

  return {
    async beforeAgentRun(event, ctx) {
      let blockedBecause: string | undefined;
      try {
        blockedBecause = await governRun(event, ctx);
      } catch (error) {
        blockedBecause = `the ACS plugin failed: ${(error as Error).message}`;
      }
      if (blockedBecause === undefined) {
        return undefined;
      }
      // A refused sender gets no reply an approver would weigh: what they
      // wrote is not kept.
      const senderId = event.senderId ?? ctx.senderId;
      if (senderId !== undefined && ctx.channel !== undefined) {
        unanswered.delete(personKey(ctx.channel, ctx.accountId, senderId));
      }
      return { outcome: "block", reason: blockedBecause, message: config.blockedReplyText };
    },

    async beforeDispatch(event, ctx) {
      let refusedBecause: string | undefined;
      try {
        refusedBecause = await governSteer(event, ctx);
      } catch (error) {
        refusedBecause = `the ACS plugin failed: ${(error as Error).message}`;
      }
      if (refusedBecause === undefined) {
        return undefined;
      }
      logger.error(`ACS plugin dropped a message that would join a running turn: ${refusedBecause}`);
      return { handled: true, text: config.blockedReplyText };
    },

    async beforeToolCall(event, ctx) {
      try {
        return await governToolCall(event, ctx);
      } catch (error) {
        return { block: true, blockReason: `The ACS plugin failed: ${(error as Error).message}` };
      }
    },

    async gatewayStart() {
      await restored();
    },

    async toolResult(event, ctx) {
      try {
        return await governToolResult(event, ctx);
      } catch (error) {
        logger.error(`ACS plugin withheld a tool result: ${(error as Error).message}`);
        return WITHHELD_RESULT;
      }
    },

    // A `message` call has delivered by the time it returns.
    async afterToolCall(event, ctx) {
      const callId = event.toolCallId ?? ctx.toolCallId;
      if (callId === undefined) {
        return;
      }
      sendGrants.delete(callId);
    },

    // OpenClaw sends the original reply when this hook throws or runs past its
    // budget, so every path returns, and every path of a reply to the
    // session's own sender but an allow returns the fixed text.
    async messageSending(event, ctx) {
      const withheld = { content: config.blockedReplyText };
      // A send of a `message` call to another recipient goes out under the
      // run that made the call, whatever session OpenClaw files it under (the
      // recipient's, for a send to another peer), as the Guardian decided it
      // at the call.
      try {
        const grant = typeof event.to === "string" ? grantFor(event.to.trim(), ctx, event.content) : undefined;
        if (grant !== undefined) {
          unanswered.delete(personKey(ctx.channelId, ctx.accountId, event.to.trim()));
          return { content: event.content };
        }
      } catch {
        return { cancel: true };
      }
      try {
        // The message goes to the one sender the session key names, in a
        // session a run of that sender was admitted to in this process, or
        // nothing is sent. A restored candidate admits no send.
        const admitted = ctx.sessionKey === undefined ? undefined : admittedSessions.get(ctx.sessionKey);
        if (
          ctx.sessionKey === undefined ||
          admitted === undefined ||
          !admitted.confirmed ||
          admitted.userContext.user_id !== event.to ||
          notOneSenderSessionBecause(ctx.sessionKey, ctx.channelId, event.to, ctx.accountId) !== undefined
        ) {
          return { cancel: true };
        }
        // A message reached the session and no admitted run took it in: a run
        // that skipped before_agent_run (another runtime, a session override)
        // is answering it, and its reply is not this session's to send.
        if (!liveRunOfSession.has(ctx.sessionKey) && (undecidedInbound.get(ctx.sessionKey)?.length ?? 0) > 0) {
          refuse(admitted.sessionId, METHODS.agentResponse, RUN_NOT_ADMITTED, "the session holds messages no admitted run took in, and has no admitted run");
          return { cancel: true };
        }
        const sessionKey = ctx.sessionKey;
        // The session may end, or another begin under the key, while the
        // Guardian decides: nothing is sent into it.
        const allowed = await responseAllowed(
          {
            sessionId: admitted.sessionId,
            userContext: { user_id: event.to, authentication_method: ctx.channelId },
            agentName: admitted.agentName,
            turnId: liveRunOfSession.get(sessionKey),
          },
          event.content,
          () => admittedSessions.get(sessionKey) === admitted,
        );
        if (allowed === "stale") {
          return { cancel: true };
        }
        if (!allowed) {
          return withheld;
        }
        unanswered.delete(personKey(ctx.channelId, ctx.accountId, event.to));
        return { content: event.content };
      } catch {
        return withheld;
      }
    },

    // Kept for the approval prompt only; no step is sent: the run that reads
    // the message sends it as steps/userMessage.
    async messageReceived(event, ctx) {
      const person = trimmedString(event.senderId) ?? trimmedString(event.from);
      if (person === undefined || typeof event.content !== "string" || event.content.trim().length === 0) {
        return;
      }
      const key = personKey(ctx.channelId, ctx.accountId, person);
      const messages = [...(unanswered.get(key) ?? []), truncate(event.content.trim(), APPROVAL_DESCRIPTION_MAX)];
      while (messages.length > 1 && messages.reduce((total, message) => total + message.length, 0) > APPROVAL_DESCRIPTION_MAX) {
        messages.shift();
      }
      unanswered.set(key, messages);
    },

    async agentEnd(event, ctx) {
      const runId = event.runId ?? ctx.runId;
      const pending = runId === undefined ? undefined : pendingAdmissions.get(runId);
      if (pending !== undefined) {
        pending.ended = true;
      }
      const run = runId === undefined ? undefined : runs.get(runId);
      if (runId === undefined || run === undefined) {
        return;
      }
      runs.delete(runId);
      deleteWhere(sendGrants, (grant) => grant.run === run);
      deleteWhere(decidedCalls, (call) => call.run === run);
      if (liveRunOfSession.get(run.sessionKey) === runId) {
        liveRunOfSession.delete(run.sessionKey);
      }
      // Audit only (hooks.md, turnEnd): the turn has happened, so an answer
      // other than allow changes nothing and is recorded.
      try {
        const outcome = await exchange.decide({
          method: METHODS.turnEnd,
          sessionId: run.sessionId,
          userContext: run.userContext,
          agentName: run.agentName,
          payload: { turn_id: runId, outcome: event.success === false ? "error" : "completed", tool_call_count: run.toolCallCount },
          modificationDocument: {},
          turnId: runId,
        });
        if (outcome.stage === "honoured" && outcome.decision.decision !== "allow") {
          auditSubstitution(run.sessionId, METHODS.turnEnd, outcome.requestId, outcome.decision.decision, "not_decision_eligible");
        }
      } catch (error) {
        logger.error(`ACS plugin could not send steps/turnEnd: ${(error as Error).message}`);
      }
    },

    async sessionEnd(event, ctx) {
      const sessionKey = event.sessionKey ?? ctx.sessionKey;
      const sessionId = event.sessionId ?? ctx.sessionId;
      // The process ends, the session does not: its runs end with the process,
      // and its admission and ACS session continue after the restart.
      const processEnds = event.reason !== undefined && PROCESS_END_REASONS.has(event.reason);
      if (sessionKey !== undefined) {
        for (const [runId, run] of runs) {
          if (run.sessionKey === sessionKey) {
            runs.delete(runId);
          }
        }
        deleteWhere(sendGrants, (grant) => grant.run.sessionKey === sessionKey);
        deleteWhere(decidedCalls, (call) => call.run.sessionKey === sessionKey);
        for (const pending of pendingAdmissions.values()) {
          if (pending.sessionKey === sessionKey) {
            pending.ended = true;
          }
        }
        liveRunOfSession.delete(sessionKey);
        undecidedInbound.delete(sessionKey);
      }
      if (processEnds) {
        return;
      }
      const admitted = sessionKey === undefined ? undefined : admittedSessions.get(sessionKey);
      if (sessionKey !== undefined && (sessionId === undefined || admitted?.sessionId === sessionId)) {
        await forgetAdmission(sessionKey);
      }
      if (admitted !== undefined) {
        const { user_id: person, authentication_method: channel } = admitted.userContext;
        for (const key of unanswered.keys()) {
          if (key.startsWith(`${channel}\n`) && key.endsWith(`\n${person}`)) {
            unanswered.delete(key);
          }
        }
      }
      if (sessionId === undefined) {
        return;
      }
      startedSessions.delete(sessionId);
      // Audit only (hooks.md, sessionEnd). Sent for a session this process
      // admitted a run to; OpenClaw's next session under the key has a new id
      // and so a new ACS session.
      if (admitted?.sessionId === sessionId) {
        try {
          const outcome = await exchange.decide({
            method: METHODS.sessionEnd,
            sessionId,
            userContext: admitted.userContext,
            agentName: admitted.agentName,
            payload: { reason: sessionEndReasonOf(event.reason) },
            modificationDocument: {},
          });
          if (outcome.stage === "honoured" && outcome.decision.decision !== "allow") {
            auditSubstitution(sessionId, METHODS.sessionEnd, outcome.requestId, outcome.decision.decision, "not_decision_eligible");
          }
        } catch (error) {
          logger.error(`ACS plugin could not send steps/sessionEnd: ${(error as Error).message}`);
        }
      }
      exchange.forget(sessionId);
    },
  };
}

/**
 * Hooks that block every step, for a plugin whose configuration could not be
 * used or whose deployment fails a requirement. With an audit sink, every
 * step they block is recorded as refused with `reasonCode`.
 */
export function createBlockingHooks(reason: string, blockedReplyText: string, audit?: AuditSink, reasonCode = "plugin_unconfigured"): Hooks {
  const refuse = (sessionId: string | undefined, method: string) => {
    if (audit !== undefined) {
      writeRefused(audit, sessionId, method, reasonCode, reason);
    }
  };
  return {
    async beforeAgentRun(_event, ctx) {
      refuse(ctx.sessionId ?? ctx.sessionKey, METHODS.userMessage);
      return { outcome: "block", reason, message: blockedReplyText };
    },
    async beforeDispatch(event, ctx) {
      refuse(event.sessionKey ?? ctx.sessionKey, METHODS.userMessage);
      return { handled: true, text: blockedReplyText };
    },
    async beforeToolCall(_event, ctx) {
      refuse(ctx.sessionId ?? ctx.sessionKey, METHODS.toolCallRequest);
      return { block: true, blockReason: reason };
    },
    async afterToolCall() {},
    async gatewayStart() {},
    async toolResult(_event, ctx) {
      refuse(ctx.sessionId ?? ctx.sessionKey, METHODS.toolCallResult);
      return WITHHELD_RESULT;
    },
    async messageSending(_event, ctx) {
      refuse(ctx.sessionKey, METHODS.agentResponse);
      return { content: blockedReplyText };
    },
    async messageReceived() {},
    async agentEnd() {},
    async sessionEnd() {},
  };
}
