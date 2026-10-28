# OpenClaw hooks and ACS steps

What each OpenClaw 2026.10.8 hook sends to the Guardian, and what the plugin does with each answer. [README.md](README.md) explains the rules behind each row.

| OpenClaw hook | ACS steps, in order | `allow` | `deny` | Other decisions |
|---|---|---|---|---|
| `before_agent_run` | `steps/sessionStart` (first run of a session only), `steps/agentTrigger`, `steps/turnStart`, `steps/userMessage` | The next step is sent; after the last, the run starts | The run is blocked, with `blockedReplyText` as OpenClaw's block detail when it is set. A refused `sessionStart` refuses every later run of the session until OpenClaw ends it | Blocked |
| `before_dispatch` | `steps/userMessage` of the session's active run, only for a message that would join it | The message joins the run | Dropped; the user receives `blockedReplyText` when it is set | Dropped |
| `before_tool_call` | `steps/toolCallRequest`, then `steps/subagentStart` for a `sessions_spawn` call that may run | The call runs with the parameters the Guardian saw | Blocked; the model sees the Guardian's `reasoning` | `modify` runs with the Guardian's parameters, `ask` becomes an approval, `defer` is blocked as pending. A `subagentStart` answered other than `allow` blocks the spawn |
| Tool-result middleware | `steps/toolCallResult`, for every result in an admitted run; a call the plugin did not let run is `exit_status: blocked` | The model reads the result | The model reads `[OUTPUT WITHHELD BY POLICY]` in its place | `modify` gives the model the Guardian's rewrite; any other answer withholds the result |
| `after_tool_call` | None | A `message` call's grant to deliver ends | | |
| `gateway_start` | None | The plugin restores the admitted sessions it stored | | |
| `message_sending` | None for a delivery of an executed `message` call with the call's words, decided at its `steps/toolCallRequest`; `steps/agentResponse` for any other message to the session's sender; none, and not sent, for any other message | The message is sent as the Guardian saw it, in OpenClaw's spacing for a `message` call's delivery | Cancelled, or replaced by `blockedReplyText` when it is set | `modify` sends the Guardian's text; any other answer is blocked as `deny` is |
| `message_received` | None | What the sender wrote is kept for an approval prompt ([Approvals](README.md#approvals)) | | |
| `agent_end` | `steps/turnEnd` | Recorded | Recorded only: the turn has happened, and hooks.md makes this step not decision-eligible | Written to the audit log as `substituted`, `not_decision_eligible` |
| `session_end` | `steps/sessionEnd`, for a session the plugin admitted a run to | Recorded; the plugin forgets the session's runs and ServerHello | Recorded only: hooks.md makes this step audit only | Written to the audit log as `substituted`, `not_decision_eligible` |

## Steps OpenClaw cannot carry

A decision-eligible step is sent only from a hook that can block (§6.4). These are not sent:

| ACS step | OpenClaw 2026.10.8 | Why not |
|---|---|---|
| `preCompact` | `before_compaction` only observes | Cannot block compaction |
| `postCompact` | `after_compaction` | The event has no summary text, which the step requires |
| `subagentStop` | `subagent_ended` only observes | The plugin refuses every run of a sub-agent and every spawn on another runtime than `subagent` ([Conformance](README.md#conformance)), so no sub-agent acts and none has a stop to report |
| `skillRegister`, `skillLoad`, `skillUnload` | `before_install` gates installs outside any conversation; loading has no hook | No session or sender to send it under |
| `memoryStore`, `memoryContextRetrieval`, `knowledgeRetrieval` | No hooks; these are tool calls | Gated as `toolCallRequest` |

[README.md, Conformance](README.md#conformance) lists what ACS-Core asks and the plugin does not send.
