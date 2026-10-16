/**
 * Readers of OpenClaw settings that `requirements.ts` and the hooks use.
 *
 * - A sender who may send directives can change their own session's runtime
 *   settings (`/queue`, the model, inline directives), which no plugin sees.
 *   OpenClaw gives directives only to a sender `commands.allowFrom` lists
 *   once that key is set
 *   (`resolveCommandSenderAuthorization` and `clearInlineDirectives` in
 *   OpenClaw's `dist/command-auth-*.mjs` and `dist/get-reply-*.mjs`); without
 *   it, every paired sender may. So the key must be set, list no wildcard,
 *   and not list the run's sender.
 * - Whether a session is one sender is read from the session key OpenClaw
 *   built for the run, not from `session.dmScope`: route bindings and
 *   channel plugins can override the scope per message, and only the key
 *   shows the scope that was applied.
 */

type ModelEntries = Record<string, { agentRuntime?: unknown } | undefined>;
type AgentModelSettings = { model?: unknown; models?: ModelEntries; heartbeat?: { model?: unknown }; subagents?: { model?: unknown } };

/** The parts of OpenClaw's config the plugin reads. */
export type OpenClawSettings = {
  commands?: { allowFrom?: unknown };
  acp?: { enabled?: unknown };
  plugins?: {
    allow?: unknown;
    entries?: Record<
      string,
      { enabled?: unknown; hooks?: { allowConversationAccess?: unknown; timeoutMs?: unknown; timeouts?: Record<string, unknown> } } | undefined
    >;
  };
  agents?: {
    defaults?: AgentModelSettings;
    list?: Array<(AgentModelSettings & { id?: string }) | undefined>;
  };
  models?: { providers?: Record<string, { agentRuntime?: unknown; models?: Array<{ id?: string; agentRuntime?: unknown } | undefined> } | undefined> };
};

/** Letters and digits only, lowercased: two spellings of one id compare equal, and an id compares equal to a prefixed one. */
function idCharacters(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Why `senderId` may change their session's runtime settings, or `undefined` when
 * OpenClaw's command settings rule it out. An entry matches the sender when
 * its letters and digits end with the sender's, so a prefixed or differently
 * written entry is never missed; a wider match only blocks more runs.
 */
export function directivesAllowedBecause(settings: OpenClawSettings, senderId: string): string | undefined {
  const allowFrom = settings.commands?.allowFrom;
  if (typeof allowFrom !== "object" || allowFrom === null || Array.isArray(allowFrom)) {
    return "OpenClaw's commands.allowFrom is not set, so every paired sender may send directives; list only the operators there";
  }
  const sender = idCharacters(senderId);
  for (const [channel, entries] of Object.entries(allowFrom)) {
    if (!Array.isArray(entries)) {
      return `OpenClaw's commands.allowFrom.${channel} is not a list`;
    }
    for (const entry of entries) {
      if (typeof entry !== "string" || entry.trim() === "*") {
        return `OpenClaw's commands.allowFrom.${channel} lets everyone send directives`;
      }
      if (sender.length > 0 && idCharacters(entry).endsWith(sender)) {
        return `${senderId} may send directives (commands.allowFrom.${channel}), so their runs cannot be governed`;
      }
    }
  }
  return undefined;
}

/**
 * Why `sessionKey` is not a session of `senderId` alone on `channel`, or
 * `undefined` when it is. OpenClaw builds a direct-message key as
 * `agent:<agent>:<channel>:direct:<peer>` under `per-channel-peer` and
 * `agent:<agent>:<channel>:<account>:direct:<peer>` under
 * `per-account-channel-peer`, the channel and the peer lowercased
 * (`buildAgentPeerSessionKey`, OpenClaw's `dist/session-key-*.mjs`).
 *
 * The match is exact, segment by segment. A sender id with an upper-case
 * letter or a `:` is refused: OpenClaw would lowercase it into a key another
 * id can share, and a `:` lets one key be read as two shapes. The account
 * segment must be the run's own account, so a group or channel key whose
 * peer happens to read `direct:<sender>` is not taken for a direct one.
 * Every other shape (the main session, `per-peer`, a group, a thread) is
 * refused.
 */
export function notOneSenderSessionBecause(
  sessionKey: string,
  channel: string,
  senderId: string,
  accountId: string | undefined,
): string | undefined {
  const refusal =
    `session ${sessionKey} is not a direct-message session of ${senderId} alone on ${channel}; ` +
    `set session.dmScope to "per-channel-peer"`;
  const exactSegment = (value: string) => value.length > 0 && !value.includes(":") && value === value.trim().toLowerCase();
  if (!exactSegment(senderId) || !exactSegment(channel)) {
    return refusal;
  }
  const parts = sessionKey.split(":");
  const [agent, agentId, keyChannel] = parts;
  if (agent !== "agent" || agentId === undefined || agentId.length === 0 || keyChannel !== channel) {
    return refusal;
  }
  const rest = parts.slice(3);
  const accountSegment = accountId === undefined ? undefined : accountId.trim().toLowerCase();
  const perChannel = rest.length === 2 && rest[0] === "direct" && rest[1] === senderId;
  const perAccount =
    rest.length === 3 && accountSegment !== undefined && rest[0] === accountSegment && rest[1] === "direct" && rest[2] === senderId;
  return perChannel || perAccount ? undefined : refusal;
}
