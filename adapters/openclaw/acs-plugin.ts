/**
 * The OpenClaw plugin entry. OpenClaw reads the default export's `register`
 * and calls it once, synchronously, with the plugin API.
 *
 * A configuration this plugin cannot use, or an OpenClaw that fails a
 * requirement checked at registration (`requirements.ts`), registers hooks
 * that block every step, so a broken deployment stops the agent instead of
 * leaving it ungoverned; the log names the requirement.
 *
 * Admitted sessions are kept in OpenClaw's retained plugin state
 * (`api.runtime.state.openKeyedStore`), so a restart does not cut off a person
 * admitted before it. Without that state they last as long as the process,
 * and the plugin says so in its log.
 */
import { createAuditSink, createGuardianClient } from "./host-adapter.ts";
import { createAcsExchange } from "./acs-exchange.ts";
import { DEFAULT_BLOCKED_REPLY_TEXT, parseConfig } from "./config.ts";
import {
  createBlockingHooks,
  requirementCode,
  createHooks,
  memoryOnlyAdmissions,
  type Admission,
  type AdmissionStore,
  type Hooks,
  type ToolResultAnswer,
  type ToolResultContext,
  type ToolResultEvent,
} from "./openclaw-hooks.ts";
import type { OpenClawSettings } from "./openclaw-settings.ts";
import { failedRequirement, PLUGIN_ID } from "./requirements.ts";

/** The part of OpenClaw's retained keyed store this plugin uses. */
type RetainedStore = {
  register(key: string, value: Admission): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  entries(): Promise<Array<{ key: string; value: Admission }>>;
};

type PluginApi = {
  /** `config.current()` is the config the OpenClaw process runs with now, reloads included. */
  runtime?: {
    /** OpenClaw's release (`PluginRuntimeCore.version`, `src/plugins/runtime/types-core.ts`). */
    version?: unknown;
    config?: { current?: () => OpenClawSettings };
    state?: { openKeyedStore?: (options: { namespace: string; retention: "retained" }) => RetainedStore | Promise<RetainedStore> };
  };
  pluginConfig?: Record<string, unknown>;
  logger: { error(message: string): void };
  on(hookName: string, handler: (...args: never[]) => unknown, options?: { priority?: number; timeoutMs?: number }): void;
  registerAgentToolResultMiddleware?(
    handler: (event: ToolResultEvent, ctx: ToolResultContext) => Promise<ToolResultAnswer>,
    options: { runtimes: string[] },
  ): void;
};

/**
 * The admitted sessions in OpenClaw's retained plugin state, or in memory
 * when the runtime has none. The store is opened at its first use, by a hook:
 * OpenClaw registers a plugin more than once at startup and retires all but
 * the last registration, so a store opened at registration may belong to a
 * runtime that is no longer active.
 */
function admissionsFor(api: PluginApi): AdmissionStore {
  const open = api.runtime?.state?.openKeyedStore;
  if (open === undefined) {
    api.logger.error("ACS plugin keeps admitted sessions in memory only: this OpenClaw has no plugin state store");
    return memoryOnlyAdmissions;
  }
  let store: Promise<RetainedStore> | undefined;
  const opened = (): Promise<RetainedStore> => (store ??= Promise.resolve().then(() => open({ namespace: "admitted-sessions", retention: "retained" })));
  return {
    async load() {
      return (await (await opened()).entries()).map(({ key, value }) => [key, value]);
    },
    async put(sessionKey, admission) {
      await (await opened()).register(sessionKey, admission);
    },
    async delete(sessionKey) {
      await (await opened()).delete(sessionKey);
    },
  };
}

/** OpenClaw runs higher priorities first; this plugin runs last, so its answer is the one that stands. */
const RUN_LAST = { priority: Number.MIN_SAFE_INTEGER };

function hooksFor(api: PluginApi): { hooks: Hooks; hookTimeoutMs?: number } {
  try {
    const config = parseConfig(api.pluginConfig ?? {});
    const audit = createAuditSink({ path: config.auditLog });
    const failed = failedRequirement("registration", {
      version: api.runtime?.version,
      hasMiddlewareRegistrar: api.registerAgentToolResultMiddleware !== undefined,
      settings: api.runtime?.config?.current?.(),
      deadlineMs: config.deadlineMs,
    });
    if (failed !== undefined) {
      const reason = `ACS plugin blocks every step: ${failed}`;
      api.logger.error(reason);
      return { hooks: createBlockingHooks(reason, DEFAULT_BLOCKED_REPLY_TEXT, audit, requirementCode(failed)) };
    }
    const exchange = createAcsExchange({
      client: createGuardianClient(config.guardianUrl, { signingKey: config.signingKey }),
      audit,
      failurePosture: config.failurePosture,
      deadlineMs: config.deadlineMs,
    });
    const hooks = createHooks({
      config,
      exchange,
      audit,
      requirementFailure: (point, facts) => failedRequirement(point, { ...facts, settings: api.runtime?.config?.current?.() }),
      logger: api.logger,
      admissions: admissionsFor(api),
    });
    return { hooks, hookTimeoutMs: config.hookTimeoutMs };
  } catch (error) {
    const reason = `ACS plugin is not configured, so every step is blocked: ${(error as Error).message}`;
    api.logger.error(reason);
    return { hooks: createBlockingHooks(reason, DEFAULT_BLOCKED_REPLY_TEXT) };
  }
}

export default {
  id: PLUGIN_ID,
  name: "Agent Control Standard",
  description: "Sends each agent step, signed, to an ACS Guardian and enforces its decision.",
  register(api: PluginApi): void {
    const { hooks, hookTimeoutMs } = hooksFor(api);
    // The timeout of every hook that waits for the Guardian is asked for
    // explicitly, so OpenClaw's own default never ends one before it answers.
    const timed = { ...RUN_LAST, ...(hookTimeoutMs === undefined ? {} : { timeoutMs: hookTimeoutMs }) };
    api.on("before_agent_run", hooks.beforeAgentRun, timed);
    api.on("before_dispatch", hooks.beforeDispatch, timed);
    api.on("before_tool_call", hooks.beforeToolCall, timed);
    api.on("after_tool_call", hooks.afterToolCall, RUN_LAST);
    api.on("message_sending", hooks.messageSending, timed);
    api.on("message_received", hooks.messageReceived, RUN_LAST);
    api.on("agent_end", hooks.agentEnd, RUN_LAST);
    api.on("session_end", hooks.sessionEnd, RUN_LAST);
    api.on("gateway_start", hooks.gatewayStart, RUN_LAST);
    api.registerAgentToolResultMiddleware?.(hooks.toolResult, { runtimes: ["openclaw"] });
  },
};
