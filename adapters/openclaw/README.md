# OpenClaw plugin

`acs-plugin.ts` is an [OpenClaw](https://github.com/openclaw/openclaw) plugin. It sends the steps of an OpenClaw agent (its session, turns, user messages, tool calls and their results, and replies) to an ACS Guardian as signed steps, and enforces the decision that comes back. A step is sent when the Guardian's ServerHello lists it in `methods_evaluated`; with the TypeScript Guardian that is the tool steps only. It knows no product and one tool: it sends each step with the identity of the person the agent acts for, and the Guardian's policy decides. The one tool is OpenClaw's own built-in `message` tool, and only the parameters that name where it sends (`target`, `to`, `channelId`, `targets`, `channel`, `accountId`): a delivery of a `message` call reaches the plugin with no run of its own, so the plugin ties it to the call the Guardian allowed ([Sends of the `message` tool](#sends-of-the-message-tool)).

It is written against OpenClaw 2026.10.8 and built on the [host adapter](../../reference-implementations/agt/packages/host-adapter/README.md) of the TypeScript reference, which `host-adapter.ts` imports by path. It contains no AGT code. It is a partial Observed Agent and not ACS-Core conformant: [Conformance](#conformance) names what OpenClaw does not let it send.

## Get started

1. Start a Guardian that verifies §10 signatures, for example the [Go Guardian](../../reference-implementations/agt-go/README.md). Note its HMAC key file, its `key_id` and how it derives session keys.

   The plugin governs only the steps the Guardian's ServerHello lists in `methods_evaluated`, and allows the others unsent, as `handshake.json` requires. The Go Guardian evaluates every native hook unless its `protocol.methods_evaluated` names fewer. The TypeScript Guardian evaluates `steps/toolCallRequest` and `steps/toolCallResult` only (`packages/guardian/src/handshake.ts`), so with it the plugin governs tool calls and their results, and no session step, user message or reply; it also does not sign its answers yet, which this plugin requires.

2. Install the plugin from this directory and enable it.

```bash
openclaw plugins install --link /absolute/path/to/agent-control-standard/adapters/openclaw
openclaw plugins enable acs-guardian-client
```

3. Configure it under `plugins.entries.acs-guardian-client` in `openclaw.json`, and meet every row of [Requirements](#requirements): a row that fails makes the plugin block, and its log names the row.

[`openclaw.json.example`](openclaw.json.example) is a complete example; `tests/example-config.test.ts` checks that the plugin accepts it.

4. Restart the gateway. Each step the Guardian evaluates now reaches it before the agent acts on it.

## Requirements

The plugin's guarantees rest on these OpenClaw settings and capabilities, each read where OpenClaw itself reads it. Every row copies a rule of OpenClaw 2026.10.8, so R0 holds the table to that release: moving to another release means verifying every row against its source again and then moving R0. A row that fails at registration blocks every step; one that fails at a run refuses that run; one that fails at a dispatch drops that message. The log names the row, and the audit log records each blocked step as `refused` with `reason_code: requirement:<row>` (`requirements.ts`; `tests/requirements.test.ts` makes each row fail and expects every step blocked, and checks this table equals the code).

| Row | Setting | How OpenClaw reads it (2026.10.8) | Checked | Failure it prevents |
|---|---|---|---|---|
| R0 | `OpenClaw 2026.10.8` | `api.runtime.version` (`src/plugins/runtime/types-core.ts:343`, set at `src/plugins/runtime/index.ts:259`) | registration | A row copying a rule another release changed |
| R1 | `a tool-result middleware registrar` | `api.registerAgentToolResultMiddleware` (`src/plugins/plugin-api.types.ts:384`) | registration | Tool results reaching the model unread |
| R2 | `plugins.entries.acs-guardian-client.enabled: true, or plugins.allow` | middleware only for a plugin enabled by name (`src/plugins/config-activation-shared.ts:34,49`, `src/plugins/registry-registrars-tools-hooks.ts:80,174`) | registration | The middleware silently not registered |
| R3 | `plugins.entries.acs-guardian-client.hooks.allowConversationAccess: true` | an installed plugin needs it (`src/plugins/hook-policy-decisions.ts:10-17`); without it `before_agent_run` and `agent_end` are dropped with a registry warning only (`src/plugins/registry-registrars-tools-hooks.ts:53-63,401-414`) | registration | A message reaching the model with no `steps/userMessage`, a turn with no `steps/turnEnd` |
| R4 | `plugins.entries.acs-guardian-client.hooks.timeoutMs and .timeouts longer than deadlineMs, after_tool_call included` | they outrank the timeout the plugin asks for (`src/plugins/registry-state.ts:70-80`); `after_tool_call`'s is also the tool-result middleware's (`src/plugins/registry-registrars-tools-hooks.ts:188`) | registration | `message_sending` sending the original message on its timeout (`src/plugins/hooks.ts:101-120`); a result replaced by OpenClaw's failure text |
| R5 | `acp.enabled: false` | ACP is on unless disabled (`src/acp/policy.ts:9-11`); `before_agent_run` is called only at `src/agents/cli-runner.ts:633`, `src/agents/embedded-agent-runner/run/attempt-before-agent-run.ts:37` and `src/gateway/worker-environments/worker-turn-user-message.ts:105` | registration, run, dispatch | ACP turns that pass no `before_agent_run` |
| R6 | `commands.allowFrom: the operators only, no wildcard` | directives go to every paired sender unless it is set (`resolveCommandSenderAuthorization`); an entry matches the sender when its letters and digits end with the sender's, so a prefixed or differently written entry is never missed | run, dispatch | A sender changing their own session's runtime settings, which no plugin sees |
| R7 | `agentRuntime: { id: "openclaw" } for every model an agent runs` | per model or provider entry (`src/agents/model-runtime-policy.ts:156-215`), for each agent's model, its fallbacks, `heartbeat.model` and `subagents.model`; an OpenAI model gets Codex otherwise (`src/agents/openai-routing.ts:52`). The run's model is `ctx.modelProviderId` and `ctx.modelId` (`src/plugins/hook-agent-context.types.ts:42-43`) | registration, run, dispatch | A run on the Codex runtime, which calls no `before_agent_run` and whose native tool results no middleware can replace (`src/agents/harness/native-hook-relay-events.ts:260`), or on a CLI runtime, which runs no middleware |
| R8 | `session.dmScope per-channel-peer or per-account-channel-peer, read from each session key` | the key OpenClaw built, since route bindings and channel plugins can override the scope per message | run, dispatch | Another person's identity reaching a run |
| R9 | `api.runtime.state.openKeyedStore` | OpenClaw binds keyed state to the plugin id (`src/plugins/registry-runtime.ts:256-261`) and shares it across plugin registrations | registration | Hook and tool-result middleware registrations failing to share the admitted run and its exact tool-call decision |

One invariant holds whatever the table cannot read: a tool call, a tool result and a reply leave only for a run that passed `before_agent_run` and was admitted there. A step of any other run, in any session, is blocked and audited as `refused` with `reason_code: run_not_admitted`. A reply is also cancelled while its session holds messages no admitted run took in and has no admitted run: some run that skipped `before_agent_run` is answering them. This closes every run that skips the gate: the Codex runtime, a session switched to another runtime or model, and any path not found yet. What remains is that such a run's message reaches its model; it can do nothing with it.

What the table cannot read, with the evidence:
- The hooks the plugin registered: `api.on` returns nothing (`src/plugins/registry-api.ts:261-262`), so R3 is derived from the setting OpenClaw reads.
- A session's own runtime or model. OpenClaw runs a turn on `explicitAgentRuntime ?? harnessPolicy.runtime` (`src/agents/model-fallback-attempt.ts:495`), where `explicitAgentRuntime` is the session entry's `agentRuntimeOverride` (`src/config/sessions/types.ts:506`, written by `src/gateway/sessions-patch.ts:679`), and a session's `providerOverride` or `modelOverride` to an unpinned model picks its runtime the same way. The session facts a plugin may read carry neither (`src/plugins/runtime/types-session-facts.ts:6-24`). R7 checks a run's own model when OpenClaw calls `before_agent_run`; a run that skips it meets the invariant above.
- Who holds gateway access. `chat.send` and the Talk controls need only the `operator.write` scope (`src/gateway/method-scopes.ts:170`), less than changing the config (`operator.admin`), and they put input into a running turn with no hook a plugin can answer ([Messages that join a running turn](#messages-that-join-a-running-turn)). So no one outside the trust the Guardian assumes may hold `operator.write`, a Control UI session or a paired node or mobile client.
- A cron job's model, kept in the cron store and not in the config. Such a run is checked like any other at `before_agent_run`, or meets the invariant.
- Whether the Codex runtime asks about every native tool. OpenClaw relays Codex's `PreToolUse` to `before_tool_call` for every tool while a plugin registers that hook (`nativeHookRelayEventHasLocalWork` and `nativeHookRelayEventToolMatcher`, `src/agents/harness/native-hook-relay-events.ts:75-113`), but whether Codex emits `PreToolUse` for each of its tools is outside OpenClaw's source. R7 refuses the Codex runtime everywhere, and the invariant blocks its calls in any case.

A model fallback calls `before_agent_run` again for the fallback model: each candidate runs the whole attempt (`src/agents/embedded-agent-runner/run-entry.ts:302,364`), and the attempt calls it at `run/attempt-prompt-phase.ts:237`. R7 also requires every configured fallback to be pinned.

[`openclaw.json.example`](openclaw.json.example) meets every row; `tests/example-config.test.ts` checks it.

## Configuration

| Key | Default | What it does |
|---|---|---|
| `guardianUrl` | required | The Guardian's ACS endpoint |
| `keyId` | required | The `key_id` the Guardian knows the shared key by |
| `keyFile` or `keyEnv` | one is required | Where the shared key is: a file or an environment variable holding it in standard base64, surrounding whitespace ignored, as the Go Guardian's `security.hmac_secret_file` does, so one file serves both. The key is never written in the config itself. It decodes to at least 32 bytes, as the Go Guardian requires (RFC 2104 §3) |
| `hkdf` | required | How the Guardian derives each session's key: `salt`, `infoPrefix` and `sessionIdEncoding` (`utf8` or `uuid-bytes`). HKDF info is `infoPrefix` followed by the session id. §10 leaves these open, so they come from the Guardian's documentation. The Go Guardian uses `{"salt": "", "infoPrefix": "", "sessionIdEncoding": "utf8"}` |
| `failurePosture` | `closed` | `closed` blocks every step that gets no decision. `negotiated` applies the Guardian's `on_decision_failure` and, with no ServerHello, the ACS default `proceed` |
| `deadlineMs` | `5000` | The longest one hook waits for the Guardian: every step it sends, handshakes included, share it. Shorter than `hookTimeoutMs` |
| `hookTimeoutMs` | `15000` | The timeout the plugin asks OpenClaw to give each hook that waits for the Guardian. OpenClaw sends the original message when `message_sending` times out, so the plugin must answer first. An operator's `plugins.entries.acs-guardian-client.hooks.timeoutMs` or `.timeouts` outranks it, and one not longer than `deadlineMs` makes the plugin block every step |
| `maxUndecidedMessages` | `20` | The most messages of one session kept for a run not yet admitted ([Messages that join a running turn](#messages-that-join-a-running-turn)). A message beyond it is dropped |
| `approvers` | `[]` | The `ask_details.approver.id` values this host may put to a person |
| `blockedReplyText` | unset | What the person receives in place of a blocked reply, a dropped message or a refused run. Unset, nothing is sent in its place ([Blocked deliveries](#blocked-deliveries)) |
| `auditLog` | `.acs/audit.jsonl` | The host's audit log, relative to the gateway's working directory |

OpenClaw validates the config against `openclaw.plugin.json` before the plugin loads, so a config missing `keyId` or `hkdf` stops at startup. A config that passes the schema and still cannot be used, such as an unreadable key file, makes the plugin block every step and log why.

## What each hook does

[`mapping.md`](mapping.md) maps each OpenClaw hook to the ACS steps it sends and what each answer does.

`metadata.turn_id` is OpenClaw's run id, one per end-to-end turn. It is on every step from `steps/turnStart` to `steps/turnEnd`, and on a reply while its run has not ended. `steps/sessionStart`, `steps/agentTrigger` and `steps/sessionEnd` are outside the turn and carry none (`request-envelope.json`). `agentTrigger.trigger_type` is `user_message` for a user's run and `scheduled` for a cron run. Every step also carries `metadata.agent_name`, the OpenClaw agent that runs the session, so one Guardian can tell the agents of one gateway apart.

**What it costs.** Every step is one Guardian round trip. All the steps of one hook share one `deadlineMs`. Before the model runs, a user message costs up to four in sequence: `sessionStart` once per session, then `agentTrigger`, `turnStart` and `userMessage`. Each tool call, each tool result and each reply costs one more, a spawn one more for `subagentStart`, `turnEnd` one after the run, and `sessionEnd` one when OpenClaw ends the session. A Guardian that leaves a step out of `methods_evaluated` costs nothing for it, so a deployment pays only for the steps its policy reads.

**What OpenClaw cannot carry.** §6.4 makes a step a control point only if the host applies the verdict, and ACS defines no observe-only form of a decision-eligible step. So the plugin sends a decision-eligible step only from a hook that can block. [`mapping.md`](mapping.md) lists the steps that are not sent, with the OpenClaw hook each would need.

The plugin registers every hook at the lowest priority, so it runs after every other plugin. OpenClaw keeps the last `params` a `before_tool_call` handler returns and the last `content` a `message_sending` handler returns. The call and reply preserve the Guardian's parameters, except for the approval-request acknowledgement described under [Approvals](#approvals).

A decision this gate cannot carry out as sent, such as a `modify` of a user message, an `ask` at a reply or any `defer`, is blocked and written to the audit log as `substituted` (§6.5), with the step's `request_id`.

A method the Guardian's ServerHello leaves out of `methods_evaluated` is not sent and is allowed, as `handshake.json` requires of a client ("MUST treat them as ALLOW-by-default").

Another plugin can defeat these answers in one case. OpenClaw keeps the first `requireApproval` any plugin returns and freezes the parameters at that point (`runBeforeToolCall` in OpenClaw's `dist/hooks-*.mjs`). If a plugin that runs earlier asks for approval, this plugin's `modify` parameters and its own approval request are dropped, and a plugin cannot see that this happened. Its `deny` still blocks. Run no other plugin that returns `params` or `requireApproval` from `before_tool_call` beside this one.

The same holds for tool results. OpenClaw runs every plugin's tool-result middleware in turn, in registry order, each on the result the one before it returned (`src/agents/harness/tool-result-middleware.ts`), and a plugin cannot see the others. Another plugin's middleware that runs after this one can rewrite a result the Guardian allowed or withheld. Run no other plugin that registers tool-result middleware beside this one.

## Identity

What the hook contract cannot prove: which person created a scheduled job. A scheduled run acts for the person its session names, so a policy that lets an agent create jobs must allow only jobs aimed at the caller's own session. A reply's `user_context` is its recipient, the session's sender, not an authenticated author; a send to another recipient carries the sender of the run that made the `message` call.

Each step carries `metadata.user_context`. `user_id` is the channel's own id for the sender, and `authentication_method` is the channel's name. On a channel that names people by phone number, such as Signal, the id is the number in E.164 form, such as `+15550100`. The model never supplies it, and the plugin never writes it into a tool parameter: a policy compares the two.

OpenClaw does not give a tool call its sender. Its MCP tool hooks carry no `requester`. So the plugin takes the sender at `before_agent_run` and keeps it with the run, by its run id, until the run ends. A tool call names the sender of its own run. A run is admitted only when the session key OpenClaw built is a direct-message session of exactly its sender, on its channel and, under `per-account-channel-peer`, its account, compared segment by segment. A sender id with an upper-case letter or a `:` is refused: OpenClaw lowercases the peer into the key, so two such ids could share a session, and a `:` lets a key read as two shapes. That leaves out channels whose sender ids have upper-case letters. The plugin keeps a run's sender until the run ends, and a session's sender until OpenClaw ends the session, so its state is as large as OpenClaw's own set of live sessions.

A run with no channel sender acts for the person OpenClaw names, and is governed as that person:
- a scheduled run (`trigger: "cron"`) in a session whose key names one direct sender admitted there, with the same session id, acts for that sender: a job aimed at that session (`sessionTarget: "session:<key>"`). `steps/agentTrigger` and `steps/turnStart` name it `scheduled`;
- a run whose `inputProvenance` is `inter_session` acts for the admitted sender of the session that sent it, while that session has a live run, and only in a direct session of that same person on that channel. `inputProvenance` is set by OpenClaw, never by the model. Its trigger is `external_event`. It admits no send in its own session: a reply there still goes only to that session's own sender.

The plugin blocks:
- a run with no session or run id, and a run with no channel sender that acts for nobody above: a heartbeat, a system event or a hook run in an admitted session, a scheduled run in its own detached session, and a relay into another person's direct session (admitted or not), or between equal ids on two channels;
- a run whose session key names another sender, channel or no single sender, so no run inherits another person's identity;
- a second run of a session while the first has not ended, and a run that OpenClaw ended, or whose session it ended, while its user message was being decided;
- a tool call of a run that was not admitted or has ended, whose session is not its run's session, or whose context and event name different runs;
- a `sessions_send` call, before the Guardian is asked, unless its `sessionKey` (or `session_key`, which OpenClaw reads when `sessionKey` is absent) names a direct session of the run's own sender. OpenClaw queues its message straight into the target session's running turn, with no `before_dispatch` or `before_agent_run` (`src/agents/tools/sessions-send-tool.delivery.ts`), in every `mode`; a target named by `label` or `agentId` cannot be checked;
- a `sessions_spawn` call on any runtime but `subagent`, before the Guardian is asked: an ACP run passes no `before_agent_run`;
- a tool call, a tool result or a reply of a run that never passed `before_agent_run`, and a reply while the session holds messages no admitted run took in ([Requirements](#requirements));
- a tool call or reply whose run ended, or whose session was refused, while the Guardian was deciding it; such a reply is cancelled, not replaced. Every check is repeated after the wait, in the same synchronous step that applies the decision, and the sender the step was sent with is the one captured before it.

The plugin reads OpenClaw's settings where each row of [Requirements](#requirements) says: at registration, at each run, at each dispatch.

The ACS `session_id` is the UUIDv5 of OpenClaw's session id, not of its session key. OpenClaw reuses a session key after it ends a session and gives the new session a new id, and a Guardian refuses every step of an ACS session that has ended; keyed by the session id, `steps/sessionEnd` closes exactly one ACS session and the reused key starts the next. The session id is the same across restarts of either side. `message_sending` carries only the session key, so a reply uses the session id of the session's admitted run. When the Guardian answers a step with `CAPABILITY_NOT_NEGOTIATED` (`-32003`), because it restarted or let the session expire, the plugin sends `handshake/hello` again, once, and resends the step under a new `request_id`. A second failure follows the failure posture.

At OpenClaw's `session_end` the plugin ends the session's runs, sends `steps/sessionEnd` with the reason mapped from OpenClaw's (`new`, `reset`, `deleted`, `compaction` to `completed`; `idle`, `daily` to `timeout`; any other to `abandoned`), and forgets the ServerHello. At `shutdown` and `restart` the process ends and the session does not: the plugin ends the session's runs and keeps its sender, and sends no `steps/sessionEnd`.

The plugin keeps each session's admitted sender in OpenClaw's retained plugin state (`api.runtime.state.openKeyedStore`, namespace `admitted-sessions`) and restores it as a candidate. The row also says whether the session's `sessionStart` was allowed, so a session is started once across restarts. The store is opened, and the rows restored, at OpenClaw's `gateway_start` or at the first run, never at registration: OpenClaw registers a plugin more than once at startup and retires all but the last registration. A run waits for the restore within its `deadlineMs`; a store that does not answer by then refuses the run, so no session is started twice. `message_sending` names no session id, so a restored row cannot prove its session still runs: it admits no send and waits for nothing. It admits a scheduled run whose own session id matches, and that run confirms it; a person's own next message confirms it too. Writes and deletions of one session are applied in order, so a session that ends while its admission is written ends unadmitted. R9 requires this state store; a host without it blocks every step. A run is admitted only with OpenClaw's session id, and a tool call whose context names another session id than its run's is blocked. A different sender can never reach an ACS session, because the session key names its sender.

## Deliveries

The plugin classifies each message OpenClaw delivers by the step it belongs to, and applies that step's decision.

1. A delivery of an executed `message` call is that call's action, decided at `steps/toolCallRequest`, with the approver's answer for an `ask`. It goes out under the call's grant and is not sent to the Guardian again ([Sends of the `message` tool](#sends-of-the-message-tool)). This holds for a send to the session's own sender as for a send to anyone else.
2. Every other delivery to the session's sender is that session's `steps/agentResponse`: the agent's automatic reply, the text OpenClaw writes itself after a `message` call was denied or not approved, OpenClaw's notice of a refused run, and a message another plugin or an operator sends into the session. The step names `to` as the sender. `allow` sends it; `modify` sends the Guardian's rewrite of `content` (each text item one line; a rewrite with any other item is blocked and audited as `modifications_invalid`); any other answer blocks it ([Blocked deliveries](#blocked-deliveries)).
3. Any other delivery is not sent, and the Guardian is not asked: a message outside a session a run of its recipient was admitted to, with no session key, in a runtime that skips `before_agent_run`, or after OpenClaw ended the session. Nobody in that conversation asked for it, so not even `blockedReplyText` goes out.

A deployment that has OpenClaw deliver a person's replies only through the `message` tool (`messages.visibleReplies: "message_tool"`) gets the same rules: what the agent sends with the tool is decided at the call, and anything else OpenClaw delivers to the person reaches the Guardian as `steps/agentResponse`. A policy that decides messages at the tool call denies `agentResponse` to keep the rest from the person.

## Blocked deliveries

`deny` blocks the action (§6.4). So by default a blocked reply is cancelled, a message that would join a running turn is dropped, and a refused run gets no text from the plugin: no message goes in place of the one the Guardian blocked. A text in its place would itself be a message to the person that no step decided, and it tells the person that something was held back.

A deployment that wants the person told sets `blockedReplyText`. The plugin then sends it in place of a blocked reply, as the `text` of a dropped message and as the `message` of a refused run. OpenClaw answers a refused run with its own notice (`resolveBlockMessage` in `src/plugins/hook-decision-types.ts`): `Your message could not be sent: blocked by acs-guardian-client`, with `blockedReplyText` as its detail when set. That notice is a delivery like any other, so it reaches the person only as a `steps/agentResponse` of an admitted session that the Guardian allows.

Every refusal is recorded. An honoured `deny` is the Guardian's decision record, with the step's `request_id`. The plugin's own audit log holds the rest: a decision it could not carry out as sent (`substituted`), a delivery cancelled because the plugin failed while governing it (`refused`, `plugin_failed`), a step of a run never admitted (`refused`, `run_not_admitted`) and a step blocked for want of a decision (`blocked`).

## Messages that join a running turn

Under `steer`, OpenClaw's default queue mode, a message that arrives while its session's run is active is delivered into that run at its next tool boundary, and never passes `before_agent_run`. Which mode applies is OpenClaw's to resolve, from an inline directive, the session entry and the config (`src/auto-reply/reply/queue/settings.ts:18-34`), and a plugin cannot read all of them. So the plugin does not guess: every message that arrives while its session has an admitted run is decided at `before_dispatch`:

1. A run of the session still waiting for its own `userMessage` decision is waited for first, so a message cannot slip into a run admitted after it was looked at.
2. When the session has no admitted run, the plugin asks nothing: the message starts a run of its own, decided at `before_agent_run`, and the plugin keeps it as undecided until a run of the session is admitted. It keeps at most `maxUndecidedMessages` of a session and drops a message beyond them; a session the Guardian refused keeps none. The run admitted next, a user's, a scheduled or an inter-session one, could take it in by steering, so that run sends each undecided message, other than the first one equal to its own prompt compared whole, as its own `steps/userMessage` after its turn starts, and is refused when one is. A refused run leaves them for the next. A message that names no session is dropped.
3. When the session has an admitted run, the message is sent to the Guardian as `steps/userMessage` of that run: its ACS session, its `turn_id`, its sender, whatever the queue mode. On `allow` OpenClaw steers it in, or, under `followup` or `collect`, holds it for a run of its own. On any other answer, a Guardian failure, a sender other than the run's, or a run that ended while the Guardian decided, OpenClaw drops it, and sends `blockedReplyText` when it is set. A message OpenClaw holds for a run of its own is asked about again as that run's prompt, in that run's turn: each turn gets its own decision.

OpenClaw dispatches one message of a session at a time and awaits the hook, so a later message cannot overtake one the Guardian is still deciding. What this does not cover: OpenClaw skips `before_dispatch` for a session whose admitted settings restrict its runtime, and for its fast abort and approval commands; text-only messages that OpenClaw's inbound debounce joins arrive as one message and are decided as one. Three gateway paths put input into a session with no hook a plugin can answer in time:
- `chat.send`, and `sessions.send` through it (`src/gateway/server-methods/sessions-messaging.ts:176`), steers a message into a session's running turn before reply dispatch (`src/gateway/server-methods/chat-send-message-injection.ts:192`, finished at `chat-send-agent-dispatch.ts:281-300`); OpenClaw tells plugins only afterwards, through `message_received` (`chat-send-message-injection.ts:365`). The Control UI, the CLI and the mobile and node clients send through it.
- The Talk voice controls queue text into a running turn (`src/talk/agent-run-control.ts:269`, from `src/gateway/talk/handlers/`).
- `chat.inject` appends an assistant message to a session's transcript (`src/gateway/server-methods/chat.ts:38`), which its next run reads as history.

Every other gateway path that brings input starts a run, which passes `before_agent_run`: `agent`, `sessions.create` with a message, `sessions.steer` (which interrupts the running turn, `sessions-messaging.ts:110`), the OpenAI-compatible HTTP endpoints (`src/gateway/openai-http.ts:503`, `openresponses-http.ts:126`), `cron.run` and `wake`. A run that comes from a gateway client names no channel sender of its session, so the plugin refuses it unless it is a scheduled or inter-session run of an admitted person ([Identity](#identity)).

## Sends of the `message` tool

The agent sends through OpenClaw's `message` tool: to the session's own sender, or to someone else, as when in one sender's session it forwards something to the agent's owner, or in the owner's session it writes into a sender's chat. Who may write to whom, and what, is the Guardian's decision, made at the call. The plugin never decides it by recipient.

1. The call reaches the Guardian as `steps/toolCallRequest`. `user_context` is the run's sender, the actor. The recipient is a tool argument: `arguments.target.value`, or one of its aliases `arguments.to.value` and `arguments.channelId.value`, or each item of `arguments.targets.value` for a call to several. `arguments.channel.value` and `arguments.accountId.value`, when present, name the route, and `arguments.message.value` is the text.
2. When the Guardian allows the call, or a person approves it, and its `action` delivers content (OpenClaw's send actions `send`, `thread-reply`, `sendWithEffect`, `sendAttachment` and `upload-file`, and `broadcast`), the call may deliver to the recipients it names, on its channel (`channel`, or the run's own) and its account (`accountId`, or the account the run came in on). A call that names no recipient on the run's own channel sends to the current conversation (OpenClaw's `message-action-normalization`), so it names the run's sender. Any other action, such as `read`, `react`, `delete` or `poll`, grants nothing. This lasts until the call returns (`after_tool_call`), its run ends or its session ends. A `modify` grants the recipients of the Guardian's parameters. A denied, deferred or unapproved call grants nothing.
3. A delivery to such a recipient goes out only with the words the call carried (`message`, or none for a call without one): the same words in the same order, whatever whitespace separates them. It is not sent to the Guardian again as `steps/agentResponse`: the Guardian, or the person who approved, already decided this recipient and this text at the call, and a second decision of one action would let a policy's two answers disagree. A delivery with other words, or after the call returned or its run or session ended, takes the session's path: to the session's own sender it is a `steps/agentResponse`, and to anyone else it is not sent, not even `blockedReplyText`, because the recipient did not ask for it.

The recipient must match exactly: the delivered `to` must equal a target the Guardian saw, after trimming. OpenClaw gives a plugin no channel's target normalizer, so a target written in another form than the one OpenClaw delivers to (`signal:+15550100` for `+15550100`, a contact name the channel resolves to an id) matches nothing, and its send takes the session's path. A policy that requires the channel's canonical form at the call gives the model a reason to retry instead. The plugin does not decide that two forms name one person; a policy compares them. A call that names no recipient is granted to the run's sender as OpenClaw names them (`senderId`), and its delivery matches only when OpenClaw delivers to that same form. On WhatsApp both are the E.164 number with `+` when OpenClaw knows the sender's number (`getPrimaryIdentityId` in `extensions/whatsapp/src/identity.ts`, `normalizeWhatsAppTarget` in `extensions/whatsapp/src/normalize-target.ts`); a sender OpenClaw names by a JID or LID is delivered to under another form, so the send is cancelled.

OpenClaw files a send to another peer under the recipient's session key, not the sending run's, and gives `message_sending` neither a run id nor the tool call's id (`PluginHookMessageSendingEvent` in `src/plugins/hook-message.types.ts`, and the context `applyMessageSendingHook` builds in `src/infra/outbound/deliver-hooks.ts`). So a delivery is tied to a call by recipient, channel, account and words. OpenClaw trims a call's text and re-spaces its blank lines before `message_sending` (`parseInlineDirectives` in `src/infra/outbound/message-action-send.ts`, the channel's `sanitizeText`), so the plugin compares words, not whitespace. OpenClaw runs `message_sending` once per payload, before it splits a long text into the channel's chunks (`src/infra/outbound/deliver-prepare.ts`, `deliver-core.ts`), so a long text is one delivery. A delivery with a grant's words is that grant's, even when the recipient has an admitted session of their own; any other delivery takes the session's own path and is governed as the recipient's. When two runs' calls send one text to one recipient at once, the delivery cannot be attributed and is cancelled.

An approval of a `message` call shows the recipient, because the prompt shows the call's parameters. OpenClaw runs the call with the parameters the approval froze, and the grant holds only the recipients and the words the approval showed. A send whose words OpenClaw changes after the call is cancelled, approved or not: a text it extends with a fallback for rich content or with `messages.responsePrefix`, a reply directive such as `[[reply_to_current]]` it strips, a literal `\n` it turns into a line break, or a text the model put under an alias of `message` (`content`, `text`).

## Approvals

A channel can expose `message(action=send, requestApproval=true)` for a model to request human approval.
The adapter forwards this argument unchanged to the Guardian. The deployment's policy must return `ask` when it is true.
On `ask`, the adapter freezes the native approval with `requestApproval: false`; only approval resumes that call.
The recipient and message text stay unchanged. The control parameter is omitted from the human-readable message preview.
Other decisions do not clear the request. A channel decides whether to block or send an unhandled request through its own configuration.
The adapter rejects a `modify` that clears a pending request or changes its action or channel, and audits `approval_request_changed`.
The WhatsApp plugin uses `unhandledApprovalPolicy: block | send`, with `block` as the default.

An `ask` whose `ask_details.approver.id` is in `approvers` becomes an OpenClaw approval request: `allow-once` or `deny`. The timeout comes from `ask_details.timeout_seconds`.
OpenClaw does not await `onResolution`; the adapter records an allowed call in OpenClaw's shared keyed state, and the later result middleware reads that record. The native loader check exercises this ordering without awaiting the callback.
For `message` calls, the native approval scope shows the channel the call sends on and the recipients its grant covers: the named ones, or the run's sender when the call leaves the recipient implicit on the run's own channel. Only an action whose delivery a grant covers (`send`, `thread-reply`, `sendWithEffect`, `sendAttachment`, `upload-file`, `broadcast`) gets a scope; any other action, and a call that names no recipient on another channel, shows its recipient line only, and that line says when no recipient is named. The scope is display metadata; the Guardian decision and frozen call parameters remain the authority.

The incoming quote names its sender unless the call goes to that sender alone, on the sender's channel. A call that names `target` and also `to` or `channelId` shows only `target`, because OpenClaw drops the others. A host-originated run quotes the host's instruction; it does not claim to quote the recipient's earlier conversation.

A `message` call requiring approval must include `replyContext`, a nonempty string describing the relevant request and unresolved questions.
Channels using message approval must expose this optional field in the shared tool schema through their schema contributions.
The WhatsApp plugin supplies that contribution. Other channels need the same field before using message `ask` with this adapter.
This is a breaking change to the message-approval contract; an old caller without the summary receives a correction error.
The same model supplies this field and the proposed operation. The adapter reads no history and invokes no model.
On `allow`, no summary is required. On `ask`, a missing, blank or non-string summary blocks the call with a correction error.
The error requests `replyContext` on a repeated call; no approval or send occurs before correction.

A `message` approval shows the recipient, Guardian question and context, a labelled `Context:`, an optional current-input quote under `📥`, and the exact proposed text under `💬`.
The summary is model-written presentation metadata, not an authentic quotation or permission. It never changes the outgoing text.
The adapter reads original input from `ctx.channelContext.chat.receivedText`, not from prompts or session history.
Each summary and quote line starts with `|`, so their content cannot impersonate approval instructions. Every line break OpenClaw's display renders (`\r`, `\r\n`, `\n`, U+2028, U+2029) starts a new quoted line; in a recipient or a JSON parameter line it is written as its `\u` escape.
The complete summary and operation share OpenClaw's 512-character description limit. Oversized descriptions produce a correction error.
Only the optional original quote can shorten, with an ellipsis, or disappear when space is insufficient.
The recipient includes the channel's observed display name when available, in quotes, so a name cannot read as another recipient or id.
Names come from `message_received.metadata.senderName`, scoped by channel, account and sender, and are forgotten at session end.
Names never establish authority. When a channel supplies no current-input text, the approval omits the quote.

The preview shows additional parameters as JSON. It omits `replyContext`, the approval control parameter and the boolean `final` response marker.
Other tools retain their JSON call and approver id and do not require `replyContext`.

OpenClaw bounds the description to 512 characters. The adapter never cuts the proposed call. A call that does not fit is denied with a request for a shorter call. An `ask` naming an unknown approver, or none, is denied.

OpenClaw decides where the prompt goes, not the plugin. A `before_tool_call` hook cannot name a target for one approval: OpenClaw routes every plugin approval by its `approvals.plugin` settings (`mode`, `targets`, `agentFilter`, `sessionFilter`). A deployment whose approvers need different targets cannot express that today; the `approvers` list only says which approver ids this host may put to a person.

Who may resolve a prompt is also OpenClaw's. On a chat channel it is that channel's `channels.<channel>.allowFrom`, not the approval targets. An empty `allowFrom` lets anyone in the chat approve, and `dmPolicy: "open"` requires `allowFrom: ["*"]`, which lets every sender approve. Keep `dmPolicy: "pairing"` and `allowFrom` to the approvers.

ACS v0.1 has no wire method that returns the approver's answer to the Guardian. The plugin enforces the answer itself and writes an `approval` line to its audit log: `requested_approver` (the approver the Guardian named), OpenClaw's resolution, what the step became and the step's `request_id`. OpenClaw does not report who resolved the prompt, so the line cannot name that person.

## What OpenClaw cannot carry

- **`timeout_disposition: allow`.** OpenClaw blocks a call whose approval times out. The plugin cannot turn a timeout into an allow, so an unanswered `ask` is always denied; `timeout_disposition: deny` is honoured as written.
- **A wait longer than 10 minutes.** OpenClaw caps every plugin approval at 600 seconds (`MAX_PLUGIN_APPROVAL_TIMEOUT_MS`), with no setting, so an `ask_details.timeout_seconds` above 600 ends at 600 and the call is denied then.
- **`ask_details.options`.** OpenClaw offers `allow-once`, `allow-always` and `deny` only. The plugin offers `allow-once` and `deny` and lists the options in the prompt text, where the approver can read them but not pick one.
- **Who approved.** OpenClaw reports the decision, not the person, so the audit line names the approver the Guardian asked for.
- **`defer`.** OpenClaw cannot hold a tool call open for a later verdict, so the call is blocked with a reason that starts with `Pending:`.
- **Rewriting a user message.** A `modify` at `steps/userMessage` is blocked.
- **Media.** Only the text of a message or reply is sent to the Guardian. A tool result is sent whole: each text block as its text, each image block as OpenClaw holds it.

## Tool results and sub-agents

A tool's result reaches the model through OpenClaw's tool-result middleware, which OpenClaw awaits before the model reads the result (`src/agents/embedded-agent-runner/extensions.ts:88` in OpenClaw 2026.10.8). The plugin sends it as `steps/toolCallResult`: `tool.name`, `exit_status` (`blocked` for a call the plugin did not let run, `failure` when OpenClaw marks the result an error, else `success`), one `outputs` item per content block, and `request_id_ref`, the `request_id` of the call's `steps/toolCallRequest`. The adapter stores the run admission and each tool-call decision in OpenClaw's retained, plugin-scoped keyed state. OpenClaw binds the store to the plugin id, so hooks and result middleware in separate registrations read the same records. Each record binds the current process identity, exact `runId`, `sessionKey`, `sessionId`, tool-call id and tool name. The result path consumes the call fact once and rechecks the run admission after the Guardian answers. A process identity uses `process.pid` and Node's `performance.timeOrigin`; an old process's records cannot admit a current run. The adapter deletes run facts at `agent_end` or `session_end`, then removes records from older processes at `gateway_start`. The Gateway may deliver messages before `gateway_start`, so the adapter never clears current-process records there. One Gateway must own this plugin-state database. A result without every matching fact is withheld, even when its run id alone matches. A `modify` is applied to that payload, and its `outputs` become the content the model reads; a rewrite that leaves anything but text and images is withheld and audited as `modifications_invalid`. A result of a call the plugin refused or nobody approved is sent too, as `blocked`: whatever reached it, the model reads it only as the Guardian answers. A result outside an admitted run, or after its run ended, is withheld without a step. OpenClaw replaces a result whose middleware throws with its own error text, so no path delivers an ungoverned result. The plugin governs results under OpenClaw's own agent runtime only, which R7 requires of every run.

A call of OpenClaw's `sessions_spawn` tool that the Guardian allowed, rewrote or put to an approver is then sent as `steps/subagentStart`, before the spawn: `subagent_session_id` a new UUID, `parent_session_id` the run's ACS session, `parent_step_id` the call's `request_id`, `intent_derivation: derived_from_parent` with the call's `task` as `subagent_intent.raw`, because the parent's model writes the task, and `subagent_descriptor.agent_name` from `agentId`. The spawn runs only on `allow`. The sub-agent's own runs are still refused ([Conformance](#conformance)).

## Conformance

The plugin is a partial Observed Agent. It is not ACS-Core conformant. Its ClientHello offers exactly the steps it sends: `sessionStart`, `agentTrigger`, `turnStart`, `userMessage`, `toolCallRequest`, `toolCallResult`, `subagentStart`, `agentResponse`, `turnEnd` and `sessionEnd`. What ACS-Core asks and OpenClaw 2026.10.8 does not let a plugin carry:

| ACS-Core requirement | What the plugin does | Why |
|---|---|---|
| A sub-agent's own steps, under the `subagent_session_id` its `subagentStart` named | Refuses every run of a `subagent` sub-agent, and every spawn on another runtime, so a sub-agent the Guardian allowed is created and never runs | OpenClaw mints the child's session key inside the spawn (`src/agents/subagents/spawn/subagent-spawn-child-plan.ts:88`), reports it only after the child's run was accepted (`src/agents/subagents/spawn/subagent-spawn-lifecycle.ts:32`), and gives that run neither a sender nor its parent (`src/plugins/hook-agent-context.types.ts:26`). No child run can be tied to the `subagentStart` that allowed it before the run starts |
| `subagentStop` (SHOULD) | Not sent | No sub-agent acts |
| `protocols/MCP/*` for sessions that involve MCP | Not sent. MCP tool calls are governed as `toolCallRequest` and `toolCallResult`, which ACS-Core permits for `tools/call` | OpenClaw has no plugin hook on MCP protocol messages |
| `system/ping` (SHOULD) | Not sent | Not implemented; each hook's step is the only traffic |

## Failure posture

The plugin never lets a hook fail open. Every path through `message_sending` returns the message as decided, `blockedReplyText` when it is set, or a cancel, because OpenClaw sends the original reply when that hook throws or runs past its budget. A failure of the plugin itself there cancels the delivery and is audited as `plugin_failed`. `before_agent_run` and `before_tool_call` return a block on any error.

Every answer is authenticated before the plugin reads it: it must carry exactly one of `result` and `error`, signed under the session's key and the configured `key_id`, and a decision must name the step's `request_id`. An answer that fails any of these is a Guardian failure, never a decision. An unsigned error is not acted on, not even to handshake again.

With `failurePosture: closed`, a step blocks when the Guardian is unreachable, answers late, answers with an error and no decision, or answers with anything that does not authenticate. The audit line records `posture_source: "host"`. With `negotiated`, a Guardian that declared `on_decision_failure: proceed` lets the step proceed, and the plugin writes the `proceeded` line §6.4 requires. If that line cannot be written, the step is blocked.

## Files

| File | What it holds |
|---|---|
| `acs-plugin.ts` | The entry OpenClaw loads |
| `openclaw-hooks.ts` | The hook handlers, the sender of each session, and the OpenClaw hook types they use |
| `acs-exchange.ts` | The signed exchange for one step: session, deadline, renegotiation, posture |
| `config.ts` | Reading and checking the config, and loading the key |
| `openclaw-settings.ts` | The command-allowlist check and the one-sender check of a session key |
| `openclaw.plugin.json` | The manifest and the config schema OpenClaw validates |
| `host-adapter.ts` | The one import of the TypeScript reference's host adapter |
| `mapping.md` | Each OpenClaw hook and the ACS steps it sends |
| `openclaw.json.example` | An OpenClaw config that runs the plugin |

## Tests

```bash
cd adapters/openclaw
bun install
bun test
bun run typecheck
```

`openclaw-hooks.test.ts` drives each hook against `tests/fake-acs-server.ts`, an ACS endpoint that verifies every signature and signs every answer. It covers `turn_id` only inside the turn, the ClientHello's methods, a tool result allowed, denied, rewritten, of a refused or unapproved call, across separate registrations, without its call decision, with mismatched identity, after cancellation, and during concurrent calls; a spawn allowed and refused at `subagentStart`, the sender reaching a tool step whose parameters name another phone, a tool call of an unknown run, a second sender in a session, concurrent and ended runs, a reply to anyone but the session's sender, a reply allowed, rewritten and blocked with and without `blockedReplyText`, a `message` call's sends to the session's own sender (named or implied, allowed or approved, and the text OpenClaw writes after a denied or unapproved call) and to another recipient (allowed, modified, approved or denied at the call, with another text than the call carried, to several recipients, after the call returned, from two runs at once), methods the Guardian does not evaluate, approvals by a known and an unknown approver, renegotiation, and an unreachable, malformed, unsigned or late Guardian. `openclaw-settings.test.ts` covers the command allowlist, including the entries OpenClaw would read differently, and the session-key shapes. `config.test.ts` covers the config and the plugin entry, `requirements.test.ts` each row of [Requirements](#requirements) and that table itself, `example-config.test.ts` the example config, and `imports.test.ts` that the adapter reaches the TypeScript reference only through `host-adapter.ts`. A handler that throws, a ServerHello with no `methods_evaluated` list and an unsigned, malformed or late answer at the result and spawn steps each end in a block or a withheld result.

`go-guardian.e2e.ts` drives the hooks against a running Go reference Guardian with its stock AGT policy: a run admitted through its four steps, a clean result passed, a secret in a result redacted by the Guardian, a destructive command blocked, the turn and the session ended. It also starts a second Go Guardian that evaluates only `steps/subagentStart` (`ACS__PROTOCOL__METHODS_EVALUATED`), because the stock policy refuses the spawn tool, and drives a spawn that Guardian allows end to end. `make example-check` in `reference-implementations/agt-go` starts that Guardian and runs it; run alone, it fails for want of `ACS_GUARDIAN_URL`, `ACS_HMAC_SECRET_FILE` and `ACS_HMAC_KEY_ID`, which `make` also gives the Guardian as `ACS__SECURITY__HMAC_KEY_ID`. The TypeScript Guardian does not sign answers yet, so the adapter cannot run against it. The signature itself is checked against the Go Guardian's vectors in [`packages/host-adapter/test/signature.test.ts`](../../reference-implementations/agt/packages/host-adapter/test/signature.test.ts).
