/**
 * The OpenClaw settings and capabilities the plugin's guarantees rest on, as
 * one table. Each row copies a rule of OpenClaw 2026.10.2, read at the point
 * OpenClaw itself reads it; R0 holds the table to that version, because a copy
 * does not notice when OpenClaw changes the rule. A failed row blocks: at
 * registration every step, at a run that run, at a dispatch that message.
 * The README's "Requirements" section is this table.
 */
import { directivesAllowedBecause, notOneSenderSessionBecause, type OpenClawSettings } from "./openclaw-settings.ts";

/** The OpenClaw release every row below was verified against. */
export const VERIFIED_OPENCLAW_VERSION = "2026.10.2";

export const PLUGIN_ID = "acs-guardian-client";

/** The hooks OpenClaw bounds with a timeout and this plugin answers within `deadlineMs`. */
export const TIMED_HOOKS = ["before_agent_run", "before_dispatch", "before_tool_call", "message_sending"] as const;

export type CheckPoint = "registration" | "run" | "dispatch";

/** What a check point knows. A row is checked only where its facts are known. */
export type Facts = {
  settings?: OpenClawSettings;
  /** `api.runtime.version`. */
  version?: unknown;
  hasMiddlewareRegistrar?: boolean;
  deadlineMs?: number;
  /** The person a run acts for or a message comes from, on `channel`. */
  senderId?: string;
  channel?: string;
  accountId?: string;
  sessionKey?: string;
  agentId?: string;
  /** The model a run uses, as OpenClaw names it in the hook context. */
  model?: { provider?: string; id?: string };
};

export type Requirement = {
  id: string;
  /** The OpenClaw setting or capability, as the README names it. */
  setting: string;
  checkedAt: readonly CheckPoint[];
  /** Why it fails, or `undefined`. */
  check(facts: Facts): string | undefined;
};

const NO_CONFIG = "OpenClaw's runtime config is not available to the plugin";

/** `agentRuntime.id` as OpenClaw normalizes it: `pi` is `openclaw` (`normalizeEmbeddedAgentRuntime`, `src/agents/agent-runtime-id.ts`). */
function runtimeId(policy: unknown): string | undefined {
  const id = (policy as { id?: unknown } | undefined)?.id;
  if (typeof id !== "string") {
    return undefined;
  }
  const value = id.trim().toLowerCase();
  return value === "pi" ? "openclaw" : value;
}

/**
 * Why `provider/modelId` is not pinned to OpenClaw's own runtime for `agentId`,
 * or `undefined`. Every runtime policy that could apply must exist and say
 * `openclaw`: the agent's and the defaults' model entries, exact or
 * `<provider>/*`, and the provider's entry and its model list
 * (`resolveModelRuntimePolicy`, `src/agents/model-runtime-policy.ts`). Without
 * one, OpenClaw picks the runtime itself, and an OpenAI model gets Codex
 * (`resolveOpenAIImplicitAgentRuntime`, `src/agents/openai-routing.ts`).
 */
function notPinnedBecause(settings: OpenClawSettings, agentId: string | undefined, provider: string, modelId: string): string | undefined {
  const policies: unknown[] = [];
  const agent = settings.agents?.list?.find((entry) => entry?.id === agentId);
  for (const models of [agent?.models, settings.agents?.defaults?.models]) {
    for (const [key, entry] of Object.entries(models ?? {})) {
      if (key === `${provider}/${modelId}` || key === `${provider}/*` || key === modelId) {
        policies.push(entry?.agentRuntime);
      }
    }
  }
  const providerEntry = settings.models?.providers?.[provider];
  policies.push(providerEntry?.agentRuntime);
  for (const entry of providerEntry?.models ?? []) {
    if (entry?.id === modelId) {
      policies.push(entry.agentRuntime);
    }
  }
  const set = policies.map(runtimeId).filter((id): id is string => id !== undefined);
  if (set.length === 0) {
    return `${provider}/${modelId} has no agentRuntime; pin it with agentRuntime: { id: "openclaw" }`;
  }
  const other = set.find((id) => id !== "openclaw");
  return other === undefined ? undefined : `${provider}/${modelId} runs on the ${other} runtime`;
}

type AgentModels = { model?: unknown; heartbeat?: { model?: unknown }; subagents?: { model?: unknown } };

/** The model refs an agent's config names: `model` as a string or `{ primary, fallbacks }`. */
function modelRefs(model: unknown): string[] {
  if (typeof model === "string") {
    return [model];
  }
  const { primary, fallbacks } = (model ?? {}) as { primary?: unknown; fallbacks?: unknown };
  return [primary, ...(Array.isArray(fallbacks) ? fallbacks : [])].filter((ref): ref is string => typeof ref === "string");
}

function splitRef(ref: string): { provider: string; id: string } | undefined {
  const slash = ref.indexOf("/");
  return slash > 0 && slash < ref.length - 1 ? { provider: ref.slice(0, slash).trim().toLowerCase(), id: ref.slice(slash + 1).trim() } : undefined;
}

export const REQUIREMENTS: readonly Requirement[] = [
  {
    id: "R0",
    setting: `OpenClaw ${VERIFIED_OPENCLAW_VERSION}`,
    checkedAt: ["registration"],
    check: ({ version }) =>
      version === VERIFIED_OPENCLAW_VERSION
        ? undefined
        : `OpenClaw reports version ${JSON.stringify(version)}; this plugin's requirements were verified against ${VERIFIED_OPENCLAW_VERSION} only`,
  },
  {
    id: "R1",
    setting: "a tool-result middleware registrar",
    checkedAt: ["registration"],
    check: ({ hasMiddlewareRegistrar }) =>
      hasMiddlewareRegistrar === true ? undefined : "this OpenClaw offers no api.registerAgentToolResultMiddleware, so tool results cannot be governed",
  },
  {
    id: "R2",
    setting: `plugins.entries.${PLUGIN_ID}.enabled: true, or plugins.allow`,
    checkedAt: ["registration"],
    check: ({ settings }) => {
      if (settings === undefined) {
        return NO_CONFIG;
      }
      const plugins = settings.plugins;
      const allowed = Array.isArray(plugins?.allow) && plugins.allow.includes(PLUGIN_ID);
      return plugins?.entries?.[PLUGIN_ID]?.enabled === true || allowed
        ? undefined
        : `OpenClaw runs tool-result middleware only for a plugin enabled by name; set plugins.entries.${PLUGIN_ID}.enabled to true`;
    },
  },
  {
    id: "R3",
    setting: `plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess: true`,
    checkedAt: ["registration"],
    check: ({ settings }) => {
      if (settings === undefined) {
        return NO_CONFIG;
      }
      return settings.plugins?.entries?.[PLUGIN_ID]?.hooks?.allowConversationAccess === true
        ? undefined
        : "OpenClaw does not register before_agent_run or agent_end for an installed plugin without allowConversationAccess: true";
    },
  },
  {
    id: "R4",
    setting: `plugins.entries.${PLUGIN_ID}.hooks.timeoutMs and .timeouts longer than deadlineMs, after_tool_call included`,
    checkedAt: ["registration"],
    check: ({ settings, deadlineMs }) => {
      if (settings === undefined) {
        return NO_CONFIG;
      }
      const hooks = settings.plugins?.entries?.[PLUGIN_ID]?.hooks;
      // after_tool_call's timeout is also the tool-result middleware's
      // (registry-registrars-tools-hooks.ts:188).
      for (const hook of [...TIMED_HOOKS, "after_tool_call"]) {
        const timeout = hooks?.timeouts?.[hook] ?? hooks?.timeoutMs;
        if (timeout !== undefined && !(typeof timeout === "number" && deadlineMs !== undefined && timeout > deadlineMs)) {
          return `the hook timeout for ${hook} (${String(timeout)} ms) is not longer than deadlineMs (${String(deadlineMs)} ms)`;
        }
      }
      return undefined;
    },
  },
  {
    id: "R5",
    setting: "acp.enabled: false",
    checkedAt: ["registration", "run", "dispatch"],
    check: ({ settings }) =>
      settings === undefined ? NO_CONFIG : settings.acp?.enabled === false ? undefined : "ACP runs pass no before_agent_run, so acp.enabled must be false",
  },
  {
    id: "R6",
    setting: "commands.allowFrom: the operators only, no wildcard",
    checkedAt: ["run", "dispatch"],
    check: ({ settings, senderId }) =>
      settings === undefined ? NO_CONFIG : senderId === undefined ? "the step names no sender" : directivesAllowedBecause(settings, senderId),
  },
  {
    id: "R7",
    setting: 'agentRuntime: { id: "openclaw" } for every model an agent runs',
    checkedAt: ["registration", "run", "dispatch"],
    check: ({ settings, agentId, model }) => {
      if (settings === undefined) {
        return NO_CONFIG;
      }
      if (model !== undefined) {
        const provider = model.provider?.trim().toLowerCase();
        const id = model.id?.trim();
        if (!provider || !id) {
          return "the run names no model, so its runtime cannot be known";
        }
        return notPinnedBecause(settings, agentId, provider, id);
      }
      // Every model the config can start a run on: an agent's own, its
      // heartbeat's and its sub-agents', for the defaults and each agent.
      const modelsOf = (scope: AgentModels | undefined) => [scope?.model, scope?.heartbeat?.model, scope?.subagents?.model].flatMap(modelRefs);
      const configured: Array<{ agentId?: string; ref: string }> = [
        ...modelsOf(settings.agents?.defaults).map((ref) => ({ ref })),
        ...(settings.agents?.list ?? []).flatMap((agent) => modelsOf(agent).map((ref) => ({ agentId: agent?.id, ref }))),
      ];
      if (configured.length === 0) {
        return "no agent names a model, so no runtime can be known";
      }
      for (const { agentId: owner, ref } of configured) {
        const parsed = splitRef(ref);
        const reason = parsed === undefined ? `${ref} names no provider` : notPinnedBecause(settings, owner, parsed.provider, parsed.id);
        if (reason !== undefined) {
          return reason;
        }
      }
      return undefined;
    },
  },
  {
    id: "R8",
    setting: "session.dmScope per-channel-peer or per-account-channel-peer, read from each session key",
    checkedAt: ["run", "dispatch"],
    check: ({ sessionKey, channel, senderId, accountId }) =>
      sessionKey === undefined || channel === undefined || senderId === undefined
        ? "the step names no session, channel or sender"
        : notOneSenderSessionBecause(sessionKey, channel, senderId, accountId),
  },
];

/** The first row checked at `point` that `facts` fail, as `"<id>: <why>"`, or `undefined`. */
export function failedRequirement(point: CheckPoint, facts: Facts): string | undefined {
  for (const requirement of REQUIREMENTS) {
    if (requirement.checkedAt.includes(point)) {
      const reason = requirement.check(facts);
      if (reason !== undefined) {
        return `${requirement.id}: ${reason}`;
      }
    }
  }
  return undefined;
}
