/**
 * OpenClaw's hooks, governed: each one becomes a signed ACS step, and the
 * Guardian's decision becomes the hook's answer.
 *
 * `mapping.md` maps each hook to the ACS steps it sends and what each answer
 * does.
 *
 * A delivery is classified by the step it belongs to. A send of an executed
 * call of OpenClaw's own `message` tool is that call's action: the Guardian,
 * or the person who approved, decided its recipient and its text at
 * `steps/toolCallRequest`, so it goes out under the run that made the call,
 * only to a recipient the call named (the run's own sender included), only
 * with the text the call carried, and only until the call returns, and is not
 * sent to the Guardian again. Every other delivery to the session's sender is
 * `steps/agentResponse`, and its decision is applied as §6.4 says: `allow`
 * sends it, `modify` sends the Guardian's text, any other answer blocks it.
 * A blocked delivery is cancelled, or replaced by the fixed text when the
 * deployment configures one. A message outside a session a run of its
 * recipient was admitted to is not sent at all: nobody in that conversation
 * asked for it, so neither it nor the fixed text goes out.
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
 * `steps/userMessage` of the active run, or dropped. A message of a session
 * with no active run starts a run, decided at `before_agent_run`.
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
 * The types below are the parts of OpenClaw 2026.10.8's plugin hook types
 * (`dist/channel-core-*.d.ts`) and tool-result middleware types this module
 * reads and writes.
 */
import { toSessionUuid, WITHHELD_OUTPUT, type AcsDecision, type AuditSink } from "./host-adapter.ts";
import { createHash, randomUUID } from "node:crypto";
import type { AcsExchange, Step, StepOutcome, UserContext } from "./acs-exchange.ts";
import { METHODS } from "./acs-exchange.ts";
import type { PluginConfig } from "./config.ts";
import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/string-coerce-runtime";
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
  channelContext?: { chat?: { receivedText?: string }; sender?: { id?: string; name?: string } };
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
export type ApprovalScope = {
  kind: "message-send";
  target: string;
  recipientCount: number;
  recipients?: string[];
};
export type RequireApproval = {
  title: string;
  description: string;
  scope?: ApprovalScope;
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
export type MessageReceivedEvent = { from: string; content: string; senderId?: string; metadata?: Record<string, unknown> };
export type MessageSendingEvent = { to: string; content: string };
export type MessageSendingResult = { content: string } | { cancel: true };

/** A tool result as OpenClaw's middleware hands it over and takes it back: text and image blocks. */
export type ToolResultBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResult = { content: ToolResultBlock[]; details?: unknown };
export type ToolResultEvent = { toolCallId: string; toolName: string; args: Record<string, unknown>; isError?: boolean; result: ToolResult };
export type ToolResultContext = { runtime: string; sessionId?: string; sessionKey?: string; runId?: string };
export type ToolResultAnswer = { result: ToolResult } | undefined;

/** OpenClaw-owned run facts shared by separate registrations of this plugin. */
export type RunFactsStore = {
  set(runId: string, namespace: string, value: Record<string, unknown>): Promise<void>;
  setIfAbsent(runId: string, namespace: string, value: Record<string, unknown>): Promise<boolean>;
  get(runId: string, namespace: string): Promise<unknown>;
  consume(runId: string, namespace: string): Promise<unknown>;
  clear(runId: string, namespace?: string): Promise<void>;
  pruneOtherProcesses(): Promise<void>;
};

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
  receivedText?: string;
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

function isMessageApprovalRequest(toolName: string, params: Record<string, unknown>): boolean {
  return toolName === MESSAGE_TOOL && params.action === "send" && params.requestApproval === true;
}

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

/** The audit `reason_code` of a delivery cancelled because the plugin failed while governing it. */
const PLUGIN_FAILED = "plugin_failed";

// §6.4: DENY blocks the action. A text in its place would be a message no one
// decided, so the plugin sends one only when the deployment configures
// `blockedReplyText`.

function blockedRun(reason: string, blockedReplyText: string | undefined): BeforeAgentRunResult {
  return { outcome: "block", reason, ...(blockedReplyText === undefined ? {} : { message: blockedReplyText }) };
}

function droppedMessage(blockedReplyText: string | undefined): BeforeDispatchResult {
  return blockedReplyText === undefined ? { handled: true } : { handled: true, text: blockedReplyText };
}

function blockedDelivery(blockedReplyText: string | undefined): MessageSendingResult {
  return blockedReplyText === undefined ? { cancel: true } : { content: blockedReplyText };
}

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

function callNamespace(toolCallId: string): string {
  return `tool-call-${createHash("sha256").update(toolCallId).digest("hex")}`;
}

function toolCallFact(params: {
  runId: string;
  sessionKey: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  requestId: string | null;
  ran: boolean;
}): Record<string, unknown> {
  return { kind: "tool-call", ...params, processing: false };
}

function isAdmittedRunContext(value: unknown, runId: string, ctx: ToolResultContext): value is Record<string, unknown> & {
  runId: string;
  sessionKey: string;
  sessionId: string;
  userContext: UserContext;
} {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return candidate.runId === runId &&
    typeof candidate.sessionKey === "string" && candidate.sessionKey === ctx.sessionKey &&
    typeof candidate.sessionId === "string" && candidate.sessionId === ctx.sessionId &&
    candidate.terminal !== true &&
    candidate.userContext !== null && typeof candidate.userContext === "object" &&
    typeof (candidate.userContext as Record<string, unknown>).user_id === "string" &&
    typeof (candidate.userContext as Record<string, unknown>).authentication_method === "string";
}

function isToolCallContext(value: unknown, event: ToolResultEvent, runId: string, ctx: ToolResultContext, processing?: boolean): value is Record<string, unknown> & {
  requestId: string | null;
  ran: boolean;
  processing: boolean;
} {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return candidate.kind === "tool-call" && candidate.runId === runId &&
    candidate.sessionKey === ctx.sessionKey && candidate.sessionId === ctx.sessionId &&
    candidate.toolCallId === event.toolCallId && candidate.toolName === event.toolName &&
    (candidate.requestId === null || typeof candidate.requestId === "string") &&
    typeof candidate.ran === "boolean" && candidate.processing === (processing ?? false);
}

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

/** The text a modified reply's `content` describes, one line per item, or `undefined` when an item is not text. */
function textOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const lines: string[] = [];
  for (const item of content) {
    const text = item as { type?: unknown; value?: unknown } | null;
    if (text?.type !== "text" || typeof text.value !== "string") {
      return undefined;
    }
    lines.push(text.value);
  }
  return lines.join("\n");
}

function deleteWhere<K, V>(map: Map<K, V>, isGone: (value: V) => boolean): void {
  for (const [key, value] of map) {
    if (isGone(value)) {
      map.delete(key);
    }
  }
}

/**
 * A `message` call the Guardian allowed, or a person approved: delivery to a
 * recipient it names, the run's own sender included, goes out as that call's
 * action until the call returns, the run ends or its session ends.
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
  /** The words of the text the call sends; a delivery under the grant carries exactly these words. */
  words: string;
};

/**
 * A text's words in order, one space between each. OpenClaw trims and re-spaces
 * a `message` call's text before `message_sending` (`parseInlineDirectives`,
 * the channel's `sanitizeText`), so the words are what a delivery shares with
 * the call. Any other change, such as a word added, removed, split or joined,
 * makes another text.
 */
function wordsOf(text: string): string {
  return text.split(/\s+/u).filter((word) => word.length > 0).join(" ");
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Where a `message` call acts, as `messageTargetOf` reads its parameters. */
type MessageTarget = {
  channel: string;
  /** The account the call names, else its run's; `undefined` when neither is known. */
  accountId?: string;
  named: boolean;
  recipients: string[];
  /** The recipients a delivery grant covers, and OpenClaw's "Send to" scope names: `recipients` for an action in `MESSAGE_SEND_ACTIONS`, else none. */
  granted: string[];
};

/**
 * Where a `message` call acts: the channel and account it names, else its
 * run's, and the recipients it names. A call that names none on the run's own
 * channel acts in the current conversation (OpenClaw's
 * `message-action-normalization`), whose person is the run's sender; one that
 * names none on another channel has no recipient the plugin knows. A recipient
 * is the string the Guardian saw, trimmed: OpenClaw gives a plugin no
 * channel's target normalizer, so a recipient written in another form than
 * the one OpenClaw delivers to matches nothing, and its delivery takes the
 * session's path.
 */
function messageTargetOf(run: AdmittedRun, params: Record<string, unknown>): MessageTarget {
  const channel = trimmedString(params.channel)?.toLowerCase() ?? run.userContext.authentication_method;
  const named = messageRecipients(params);
  const recipients = named.length > 0 ? named : channel === run.userContext.authentication_method ? [run.userContext.user_id] : [];
  return {
    channel,
    accountId: readStringParam(params, "accountId") ?? run.accountId,
    named: named.length > 0,
    recipients,
    granted: MESSAGE_SEND_ACTIONS.has(params.action) ? recipients : [],
  };
}

/** The grant a `message` call's parameters make for its run, or `undefined` when it grants no recipient. */
function sendGrantOf(callId: string, runId: string, run: AdmittedRun, params: Record<string, unknown>): SendGrant | undefined {
  const target = messageTargetOf(run, params);
  if (target.granted.length === 0) {
    return undefined;
  }
  return {
    callId,
    runId,
    run,
    channel: target.channel,
    accountId: target.accountId,
    recipients: new Set(target.granted),
    words: typeof params.message === "string" ? wordsOf(params.message) : "",
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
  return text.length <= max ? text : `${truncateUtf16Safe(text, max - 1)}…`;
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

/**
 * The recipients a `message` call names, trimmed: the first of `target`, `to`
 * and `channelId` it names, as OpenClaw drops the others
 * (`normalizeMessageActionInput`, `src/infra/outbound/message-action-normalization.ts`),
 * then each of `targets`.
 */
function messageRecipients(params: Record<string, unknown>): string[] {
  const target = MESSAGE_TARGET_PARAMS.map((name) => trimmedString(params[name])).find((recipient) => recipient !== undefined);
  const named = [target, ...(Array.isArray(params.targets) ? params.targets.map(trimmedString) : [])];
  return [...new Set(named.filter((recipient): recipient is string => recipient !== undefined))];
}

/**
 * A `message` call as a person reads it: the recipients, the text whole, and
 * every other parameter as JSON, so nothing that changes the send is hidden.
 * A call that names no recipient acts where `messageTargetOf` says, unless a
 * channel's own target parameter names another recipient
 * (`resolveActionDeliveryTargetAlias`, `src/infra/outbound/message-action-spec.ts`),
 * which the plugin cannot read; the line says so after the recipient it names.
 */
function messageCallLines(params: Record<string, unknown>, { named, recipients }: MessageTarget, displayName: (person: string) => string | undefined): string[] {
  const hidden = new Set(["replyContext", ...(params.action === "send" ? ["requestApproval", ...(typeof params.final === "boolean" ? ["final"] : [])] : [])]);
  const others = Object.keys(params).some((name) => !MESSAGE_CALL_SHOWN_PARAMS.has(name) && !hidden.has(name) && name !== "action");
  const people = recipients.map((person) => personLabel(person, displayName(person))).join("; ");
  const lines = [
    named
      ? `👤 ${people}`
      : recipients.length > 0
        ? `👤 ${people}${others ? ", unless a parameter under Other names another recipient" : ""}`
        : `👤 no recipient named${others ? ", unless a parameter under Other names one" : ""}`,
  ];
  if (typeof params.message === "string") {
    lines.push(...quotedTextLines("💬", params.message));
  }
  const shown = new Set<string>([...MESSAGE_CALL_SHOWN_PARAMS, ...(params.action === "send" ? ["action"] : [])]);
  const rest = Object.fromEntries(Object.entries(params).filter(([name]) => !shown.has(name) && !hidden.has(name)));
  if (Object.keys(rest).length > 0) {
    lines.push(`Other: ${oneLine(JSON.stringify(rest))}`);
  }
  return lines;
}

/** A person as an approval names them: the display name the person chose, quoted so none of it reads as an id or a separator, then the id. */
function personLabel(person: string, name: string | undefined): string {
  return name === undefined ? oneLine(person) : `${JSON.stringify(name)} · ${oneLine(person)}`;
}

/** Every line break OpenClaw's approval display renders as one (`normalizeDisplayLineBreaks`, `src/infra/exec-approval-text-sanitize.ts`). */
const DISPLAY_LINE_BREAK = /\r\n?|[\n\u2028\u2029]/gu;

/** Text that stays on its line of an approval: each line break is written as its `\u` escape, so no part of the text reads as a line of its own. */
function oneLine(text: string): string {
  return text.replace(DISPLAY_LINE_BREAK, (lineBreak) => [...lineBreak].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
}

function quotedTextLines(label: string, text: string): string[] {
  return [label, ...text.split(DISPLAY_LINE_BREAK).map((line) => `  | ${line}`)];
}

/** Never truncate an approved call: a partial preview would authorize unseen text. */
function approvalDescription(
  details: AskDetails,
  decision: AcsDecision,
  approverId: string,
  toolName: string,
  params: Record<string, unknown>,
  target: MessageTarget,
  sender: { id: string; channel: string; name?: string },
  receivedText: string | undefined,
  displayName: (person: string) => string | undefined,
): string | undefined {
  const head = [typeof details.question === "string" ? details.question : reasoningOf(decision)];
  if (typeof details.context === "string") {
    head.push(details.context);
  }
  if (toolName === MESSAGE_TOOL) {
    head.push("", ...quotedTextLines("Context:", (params.replyContext as string).trim()));
  }
  if (Array.isArray(details.options) && details.options.length > 0) {
    head.push(`Options: ${details.options.map(String).join("; ")}`);
  }
  const call = toolName === MESSAGE_TOOL ? messageCallLines(params, target, displayName) : [`Call: ${toolName} ${oneLine(JSON.stringify(params))}`];
  const incomingLabel = target.channel !== sender.channel || target.recipients.length !== 1 || target.recipients[0] !== sender.id
    ? `📥 ${personLabel(sender.id, sender.name)}`
    : "📥";
  const render = (incomingText?: string) => {
    if (toolName !== MESSAGE_TOOL) {
      return [...head, ...call, `Approver: ${approverId}`].join("\n");
    }
    return [
      call[0],
      ...head,
      ...(incomingText === undefined ? [] : ["", ...quotedTextLines(incomingLabel, incomingText)]),
      "",
      ...call.slice(1),
    ].join("\n");
  };
  const description = render();
  if (toolName !== MESSAGE_TOOL || receivedText === undefined) {
    return description.length <= APPROVAL_DESCRIPTION_MAX ? description : undefined;
  }

  const completeDescription = render(receivedText);
  if (completeDescription.length <= APPROVAL_DESCRIPTION_MAX) {
    return completeDescription;
  }

  const firstReadableText = receivedText.trimStart();
  const firstCodePoint = Array.from(firstReadableText)[0];
  if (!firstCodePoint) {
    return description.length <= APPROVAL_DESCRIPTION_MAX ? description : undefined;
  }
  const minimumPrefixLength = receivedText.length - firstReadableText.length + firstCodePoint.length;
  let low = minimumPrefixLength;
  let high = receivedText.length - 1;
  let shortenedDescription = description.length <= APPROVAL_DESCRIPTION_MAX ? description : undefined;
  while (low <= high) {
    const prefixLength = Math.floor((low + high) / 2);
    const excerpt = `${truncateUtf16Safe(receivedText, prefixLength)}…`;
    const candidate = render(excerpt);
    if (candidate.length <= APPROVAL_DESCRIPTION_MAX) {
      shortenedDescription = candidate;
      low = prefixLength + 1;
    } else {
      high = prefixLength - 1;
    }
  }
  return shortenedDescription;
}

export type CreateHooksOptions = {
  config: Pick<PluginConfig, "approvers" | "blockedReplyText" | "maxUndecidedMessages">;
  exchange: AcsExchange;
  audit: AuditSink;
  /** The first requirement (`requirements.ts`) checked at `point` that the config OpenClaw runs with now fails for `facts`, or `undefined`. */
  requirementFailure(point: "run" | "dispatch", facts: Facts): string | undefined;
  logger: { error(message: string): void };
  /** In-memory admission store for direct hook tests; production requires the OpenClaw store. */
  admissions?: AdmissionStore;
  /** OpenClaw's plugin-scoped state store is the only bridge between registrations. */
  runFacts: RunFactsStore;
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
  runFacts,
}: CreateHooksOptions): Hooks {
  async function revokeRunFacts(runId: string): Promise<void> {
    try {
      const admission = await runFacts.get(runId, "admission");
      if (admission !== undefined && typeof admission === "object" && admission !== null) {
        await runFacts.set(runId, "admission", { ...(admission as Record<string, unknown>), terminal: true });
      }
    } catch (error) {
      logger.error(`ACS plugin could not mark run facts terminal: ${(error as Error).message}`);
    }
    try {
      await runFacts.clear(runId);
    } catch (error) {
      logger.error(`ACS plugin could not clear run facts: ${(error as Error).message}`);
    }
  }

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
   * Channel-observed display names are presentation only, scoped to one account and person.
   */
  const senderNames = new Map<string, string>();
  /** One person on one channel account: an approver of one account never sees what was written to another. */
  const personKey = (channel: string, accountId: string | undefined, person: string) => `${channel}\n${accountId ?? ""}\n${person}`;
  /** Grants of `message` calls that have not returned, by OpenClaw's tool call id. */
  const sendGrants = new Map<string, SendGrant>();
  /** Calls this plugin decided whose result has not been read, by OpenClaw's tool call id. */
  const decidedCalls = new Map<string, DecidedCall>();

  /**
   * The live grant a send to `to` goes out under, or `undefined`. A delivery
   * names no run or tool call of its own, so it is a grant's only with the
   * grant's words: the Guardian, or the person who approved, decided those
   * words, and any other delivery to the recipient, such as their own
   * session's reply, takes the session's path. Two runs' grants to one
   * recipient with one text leave no single run, and the delivery is not sent.
   */
  function grantFor(to: string, ctx: MessageContext, content: string): SendGrant | undefined {
    const words = wordsOf(content);
    const matching = [...sendGrants.values()].filter(
      (grant) =>
        runs.get(grant.runId) === grant.run &&
        grant.channel === ctx.channelId &&
        (grant.accountId === undefined || grant.accountId === ctx.accountId) &&
        grant.recipients.has(to) &&
        grant.words === words,
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
    onApproved: (params: Record<string, unknown>) => Promise<void> | void,
  ): BeforeToolCallResult {
    const { sessionId } = run;
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
    if (toolName === MESSAGE_TOOL && !trimmedString(params.replyContext)) {
      auditSubstitution(sessionId, METHODS.toolCallRequest, requestId, "ask", "reply_context_missing");
      return {
        block: true,
        blockReason: "Human approval requires replyContext: a nonempty string summarizing the relevant request and unresolved questions. Add replyContext and repeat the same proposed message operation. Nothing was sent and no approval was created.",
      };
    }
    const executionParams = isMessageApprovalRequest(toolName, params)
      ? { ...params, requestApproval: false }
      : params;
    const target = messageTargetOf(run, executionParams);
    const sender = run.userContext;
    const description = approvalDescription(
      details,
      decision,
      approverId,
      toolName,
      executionParams,
      target,
      { id: sender.user_id, channel: sender.authentication_method, name: senderNames.get(personKey(sender.authentication_method, run.accountId, sender.user_id)) },
      run.receivedText,
      (person) => senderNames.get(personKey(target.channel, target.accountId, person)),
    );
    if (description === undefined) {
      auditSubstitution(sessionId, METHODS.toolCallRequest, requestId, "ask", "approval_text_too_long");
      return {
        block: true,
        blockReason: `${reasoningOf(decision)} (the approval cannot show this call whole within ${APPROVAL_DESCRIPTION_MAX} characters; ${toolName === MESSAGE_TOOL ? "shorten replyContext or the proposed message and repeat the call" : "make the proposed call shorter"}; nothing was sent and no approval was created)`,
      };
    }
    return {
      // Clearing the request is part of the frozen call, which OpenClaw runs only after approval.
      params: executionParams,
      requireApproval: {
        title: truncate(`Approve ${toolName}?`, APPROVAL_TITLE_MAX),
        description,
        ...(toolName === MESSAGE_TOOL && target.granted.length > 0 ? {
          scope: {
            kind: "message-send" as const,
            target: target.channel,
            recipientCount: target.granted.length,
            recipients: target.granted.slice(0, 5),
          },
        } : {}),
        severity: "warning",
        timeoutMs: details.timeout_seconds * 1000,
        timeoutReason: `No approval within ${details.timeout_seconds} seconds; the call was not run.`,
        allowedDecisions: ["allow-once", "deny"],
        // OpenClaw calls this before it runs an approved call.
        onResolution(resolution: ApprovalResolution): void {
          if (resolution === "allow-once" || resolution === "allow-always") {
            void Promise.resolve(onApproved(executionParams)).catch((error: unknown) => {
              logger.error(`ACS plugin could not record approved tool-call authorization: ${(error as Error).message}`);
            });
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
    const receivedText = ctx.channelContext?.chat?.receivedText;
    const admittedReceivedText = typeof receivedText === "string" ? receivedText : undefined;
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
    const run: AdmittedRun = {
      sessionKey,
      sessionId,
      userContext,
      agentName,
      accountId: ctx.accountId,
      ...(admittedReceivedText !== undefined ? { receivedText: admittedReceivedText } : {}),
      toolCallCount: 0,
    };
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
    try {
      await runFacts.set(runId, "admission", {
      runId,
      sessionKey,
      sessionId,
      userContext,
      agentName: agentName ?? null,
      accountId: ctx.accountId ?? null,
      });
    } catch {
      runs.delete(runId);
      if (liveRunOfSession.get(sessionKey) === runId) {
        liveRunOfSession.delete(sessionKey);
      }
      return "OpenClaw did not retain this run's admission context";
    }
    const senderName = trimmedString(ctx.channelContext?.sender?.name);
    if (ctx.channelContext?.sender?.id === userContext.user_id && senderName !== undefined) {
      senderNames.set(personKey(channel, ctx.accountId, userContext.user_id), truncate(senderName.replace(/\s+/g, " "), APPROVAL_DESCRIPTION_MAX));
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
      if (!(await runFacts.setIfAbsent(runId, callNamespace(callId), toolCallFact({
        runId,
        sessionKey,
        sessionId,
        toolCallId: callId,
        toolName: event.toolName,
        requestId: outcome.requestId,
        ran: false,
      })))) {
        decidedCalls.delete(callId);
        return { block: true, blockReason: "OpenClaw did not retain this call's authorization context." };
      }
    }
    /** Marks the call as run with `params`, and lets a `message` call deliver to the recipients they name. */
    const runWith = async (params: Record<string, unknown>): Promise<void> => {
      if (callId === undefined || runs.get(runId) !== run) {
        return;
      }
      decided.ran = true;
      if (event.toolName === MESSAGE_TOOL) {
        const grant = sendGrantOf(callId, runId, run, params);
        if (grant !== undefined) {
          sendGrants.set(callId, grant);
        }
      }
      try {
        await runFacts.set(runId, callNamespace(callId), toolCallFact({
          runId, sessionKey, sessionId, toolCallId: callId,
          toolName: event.toolName, requestId: outcome.requestId, ran: true,
        }));
      } catch (error) {
        decided.ran = false;
        sendGrants.delete(callId);
        throw error;
      }
      if (runs.get(runId) !== run) {
        decided.ran = false;
        sendGrants.delete(callId);
        await runFacts.clear(runId, callNamespace(callId));
      }
    };
    const applied = decision.decision === "modify" ? (decision.applied_input as Record<string, unknown> | undefined) : undefined;
    if (decision.decision === "modify" && applied === undefined) {
      return { block: true, blockReason: "The Guardian's modification could not be applied." };
    }
    if (applied !== undefined && isMessageApprovalRequest(event.toolName, event.params)) {
      const channel = readStringParam(event.params, "channel") ?? userContext.authentication_method;
      const modifiedChannel = readStringParam(applied, "channel") ?? userContext.authentication_method;
      if (!isMessageApprovalRequest(event.toolName, applied) || modifiedChannel !== channel) {
        auditSubstitution(sessionId, METHODS.toolCallRequest, outcome.requestId, "modify", "approval_request_changed");
        return { block: true, blockReason: "The Guardian's modification cannot clear an unresolved approval request or change its action or channel." };
      }
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
        await runWith(event.params);
        // OpenClaw keeps the last `params` a handler returns, and this handler
        // runs last: the call runs with exactly what the Guardian saw.
        return { params: event.params };
      case "modify":
        await runWith(applied!);
        return { params: applied! };
      case "ask":
        return approvalFor(event.toolName, event.params, decision, run, outcome.requestId, runWith);
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
    const runId = ctx.runId;
    const admitted = runId === undefined ? undefined : await runFacts.get(runId, "admission");
    if (runId === undefined || ctx.runtime !== "openclaw" || ctx.sessionKey === undefined || ctx.sessionId === undefined ||
      !isAdmittedRunContext(admitted, runId, ctx)) {
      refuse(ctx.sessionId ?? ctx.sessionKey, METHODS.toolCallResult, RUN_NOT_ADMITTED, "the result has no matching admitted run context");
      return WITHHELD_RESULT;
    }
    const namespace = callNamespace(event.toolCallId);
    const availableCall = await runFacts.get(runId, namespace);
    if (!isToolCallContext(availableCall, event, runId, ctx)) {
      refuse(ctx.sessionId, METHODS.toolCallResult, RUN_NOT_ADMITTED, "the result has no matching tool-call authorization context");
      return WITHHELD_RESULT;
    }
    const call = await runFacts.consume(runId, namespace);
    if (!isToolCallContext(call, event, runId, ctx)) {
      refuse(ctx.sessionId, METHODS.toolCallResult, RUN_NOT_ADMITTED, "the result's tool-call authorization context was already consumed or ended");
      return WITHHELD_RESULT;
    }
    decidedCalls.delete(event.toolCallId);
    const localRun = runs.get(runId);
    const sessionKey = ctx.sessionKey;
    const sessionId = ctx.sessionId;
    const userContext = admitted.userContext;
    const agentName = typeof admitted.agentName === "string" ? admitted.agentName : undefined;
    const payload: Record<string, unknown> = {
      tool: { name: event.toolName },
      exit_status: !call.ran ? "blocked" : event.isError === true ? "failure" : "success",
      outputs: outputsOf(event.result.content),
      ...(call.requestId == null ? {} : { request_id_ref: call.requestId }),
    };
    const outcome = await exchange.decide({
      method: METHODS.toolCallResult,
      sessionId,
      userContext,
      agentName,
      turnId: runId,
      payload,
      modificationDocument: { ...payload },
    }, deadlineAt);
    const currentAdmission = await runFacts.get(runId, "admission");
    if (!isAdmittedRunContext(currentAdmission, runId, ctx) ||
      (localRun !== undefined && runs.get(runId) !== localRun)) {
      return WITHHELD_RESULT;
    }
    const { decision } = outcome;
    if (decision.decision === "modify") {
      const content = contentOf((decision.applied_input as { outputs?: unknown } | undefined)?.outputs);
      if (content === undefined) {
        auditSubstitution(sessionId, METHODS.toolCallResult, outcome.requestId, "modify", "modifications_invalid");
        return WITHHELD_RESULT;
      }
      return { result: { content } };
    }
    return isAllowed(outcome, sessionId, METHODS.toolCallResult) ? undefined : WITHHELD_RESULT;
  }

  /**
   * Asks the Guardian about a message's text as `steps/agentResponse`: the
   * text to send, `undefined` when it is blocked, or `"stale"` when
   * `isCurrent`, asked again after the wait, fails.
   */
  async function decideResponse(
    step: { sessionId: string; userContext: UserContext; agentName?: string; turnId?: string },
    content: string,
    isCurrent: () => boolean,
  ): Promise<string | undefined | "stale"> {
    const payload = textContent(content);
    const outcome = await exchange.decide({ ...step, method: METHODS.agentResponse, payload, modificationDocument: { ...payload } });
    if (!isCurrent()) {
      return "stale";
    }
    if (outcome.decision.decision === "modify") {
      const text = textOf((outcome.decision.applied_input as { content?: unknown } | undefined)?.content);
      if (text === undefined) {
        auditSubstitution(step.sessionId, METHODS.agentResponse, outcome.requestId, "modify", "modifications_invalid");
      }
      return text;
    }
    return isAllowed(outcome, step.sessionId, METHODS.agentResponse) ? content : undefined;
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
      // Refused senders do not contribute display identities to approval prompts.
      const senderId = event.senderId ?? ctx.senderId;
      if (senderId !== undefined && ctx.channel !== undefined) {
        senderNames.delete(personKey(ctx.channel, ctx.accountId, senderId));
      }
      return blockedRun(blockedBecause, config.blockedReplyText);
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
      return droppedMessage(config.blockedReplyText);
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
      await runFacts.pruneOtherProcesses();
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
      const decided = decidedCalls.get(callId);
      const runId = ctx.runId ?? event.runId;
      if (decided !== undefined && runId !== undefined) {
        try {
          await runFacts.set(runId, callNamespace(callId), toolCallFact({
            runId,
            sessionKey: decided.run.sessionKey,
            sessionId: decided.run.sessionId,
            toolCallId: callId,
            toolName: event.toolName,
            requestId: decided.requestId,
            ran: decided.ran,
          }));
        } catch (error) {
          logger.error(`ACS plugin could not record tool-call authorization: ${(error as Error).message}`);
        }
      }
      sendGrants.delete(callId);
    },

    // OpenClaw sends the original reply when this hook throws or runs past its
    // budget, so every path returns, and no path but a decided one returns
    // the original text.
    async messageSending(event, ctx) {
      // A send of an executed `message` call is that call's action: it goes
      // out under the run that made the call, whatever session OpenClaw files
      // it under (the recipient's, for a send to another peer), as the
      // Guardian decided it at the call.
      try {
        const to = typeof event.to === "string" ? event.to.trim() : undefined;
        if (to !== undefined && grantFor(to, ctx, event.content) !== undefined) {
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
        const decided = await decideResponse(
          {
            sessionId: admitted.sessionId,
            userContext: { user_id: event.to, authentication_method: ctx.channelId },
            agentName: admitted.agentName,
            turnId: liveRunOfSession.get(sessionKey),
          },
          event.content,
          () => admittedSessions.get(sessionKey) === admitted,
        );
        if (decided === "stale") {
          return { cancel: true };
        }
        if (decided === undefined) {
          return blockedDelivery(config.blockedReplyText);
        }
        return { content: decided };
      } catch (error) {
        refuse(ctx.sessionKey, METHODS.agentResponse, PLUGIN_FAILED, `the ACS plugin failed: ${error instanceof Error ? error.message : String(error)}`);
        return blockedDelivery(config.blockedReplyText);
      }
    },

    async messageReceived(event, ctx) {
      const person = trimmedString(event.senderId) ?? trimmedString(event.from);
      const name = trimmedString(event.metadata?.senderName);
      if (person === undefined || name === undefined) {
        return;
      }
      const key = personKey(ctx.channelId, ctx.accountId, person);
      senderNames.set(key, truncate(name.replace(/\s+/g, " "), APPROVAL_DESCRIPTION_MAX));
    },

    async agentEnd(event, ctx) {
      const runId = event.runId ?? ctx.runId;
      const pending = runId === undefined ? undefined : pendingAdmissions.get(runId);
      if (pending !== undefined) {
        pending.ended = true;
      }
      const run = runId === undefined ? undefined : runs.get(runId);
      if (runId !== undefined) {
        if (run !== undefined) {
          runs.delete(runId);
          deleteWhere(sendGrants, (grant) => grant.run === run);
          deleteWhere(decidedCalls, (call) => call.run === run);
          if (liveRunOfSession.get(run.sessionKey) === runId) {
            liveRunOfSession.delete(run.sessionKey);
          }
        }
        await revokeRunFacts(runId);
      }
      if (runId === undefined || run === undefined) {
        return;
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
      const admitted = sessionKey === undefined ? undefined : admittedSessions.get(sessionKey);
      // The process ends, the session does not: its runs end with the process,
      // and its admission and ACS session continue after the restart.
      const processEnds = event.reason !== undefined && PROCESS_END_REASONS.has(event.reason);
      if (sessionKey !== undefined) {
        const forget = !processEnds && admitted !== undefined && (sessionId === undefined || admitted.sessionId === sessionId)
          ? forgetAdmission(sessionKey)
          : undefined;
        const endedRunIds: string[] = [];
        for (const [runId, run] of runs) {
          if (run.sessionKey === sessionKey) {
            runs.delete(runId);
            endedRunIds.push(runId);
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
        if (sessionId !== undefined) {
          startedSessions.delete(sessionId);
        }
        await Promise.all(endedRunIds.map((runId) => revokeRunFacts(runId)));
        await forget;
        if (admitted !== undefined) {
          const { user_id: person, authentication_method: channel } = admitted.userContext;
          for (const key of senderNames.keys()) {
            if (key.startsWith(`${channel}\n`) && key.endsWith(`\n${person}`)) {
              senderNames.delete(key);
            }
          }
        }
      }
      if (processEnds) {
        return;
      }
      if (sessionId === undefined) {
        return;
      }
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
export function createBlockingHooks(
  reason: string,
  blockedReplyText: string | undefined,
  audit?: AuditSink,
  reasonCode = "plugin_unconfigured",
): Hooks {
  const refuse = (sessionId: string | undefined, method: string) => {
    if (audit !== undefined) {
      writeRefused(audit, sessionId, method, reasonCode, reason);
    }
  };
  return {
    async beforeAgentRun(_event, ctx) {
      refuse(ctx.sessionId ?? ctx.sessionKey, METHODS.userMessage);
      return blockedRun(reason, blockedReplyText);
    },
    async beforeDispatch(event, ctx) {
      refuse(event.sessionKey ?? ctx.sessionKey, METHODS.userMessage);
      return droppedMessage(blockedReplyText);
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
      return blockedDelivery(blockedReplyText);
    },
    async messageReceived() {},
    async agentEnd() {},
    async sessionEnd() {},
  };
}
