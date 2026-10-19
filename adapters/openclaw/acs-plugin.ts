/**
 * The OpenClaw plugin entry. OpenClaw reads the default export's `register`
 * and calls it once, synchronously, with the plugin API.
 *
 * A configuration this plugin cannot use, or an OpenClaw that fails a
 * requirement checked at registration (`requirements.ts`), registers hooks
 * that block every step, so a broken deployment stops the agent instead of
 * leaving it ungoverned; the log names the requirement.
 *
 * Admitted sessions and run facts use OpenClaw's retained plugin state
 * (`api.runtime.state.openKeyedStore`). The plugin blocks all steps when this
 * host capability is absent.
 */
import { createAuditSink, createGuardianClient } from "./host-adapter.ts";
import { performance } from "node:perf_hooks";
import { createAcsExchange } from "./acs-exchange.ts";
import { parseConfig } from "./config.ts";
import {
  createBlockingHooks,
  requirementCode,
  createHooks,
  type Admission,
  type AdmissionStore,
  type Hooks,
  type ToolResultAnswer,
  type ToolResultContext,
  type ToolResultEvent,
  type RunFactsStore,
} from "./openclaw-hooks.ts";
import type { OpenClawSettings } from "./openclaw-settings.ts";
import { failedRequirement, PLUGIN_ID } from "./requirements.ts";

/** The part of OpenClaw's retained keyed stores this plugin uses. */
type RetainedStore<T> = {
  register(key: string, value: T): Promise<unknown>;
  registerIfAbsent(key: string, value: T): Promise<boolean>;
  lookup(key: string): Promise<T | undefined>;
  consume(key: string): Promise<T | undefined>;
  delete(key: string): Promise<unknown>;
  entries(): Promise<Array<{ key: string; value: T }>>;
};

type StoredRunFact = {
  processIdentity: string;
  runId: string;
  namespace: string;
  value: Record<string, unknown>;
};

const PROCESS_IDENTITY = `${process.pid}:${performance.timeOrigin}`;
const RUN_FACTS_NAMESPACE = "run-tool-facts";

type PluginApi = {
  /** `config.current()` is the config the OpenClaw process runs with now, reloads included. */
  runtime?: {
    /** OpenClaw's release (`PluginRuntimeCore.version`, `src/plugins/runtime/types-core.ts`). */
    version?: unknown;
    config?: { current?: () => OpenClawSettings };
    state?: { openKeyedStore?: <T>(options: { namespace: string; retention: "retained" }) => RetainedStore<T> | Promise<RetainedStore<T>> };
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
 * The admitted sessions in OpenClaw's retained plugin state. The store is
 * opened at its first use, by a hook:
 * OpenClaw registers a plugin more than once at startup and retires all but
 * the last registration, so a store opened at registration may belong to a
 * runtime that is no longer active.
 */
function admissionsFor(api: PluginApi): AdmissionStore {
  const open = api.runtime?.state?.openKeyedStore;
  if (open === undefined) {
    throw new Error("OpenClaw has no api.runtime.state.openKeyedStore");
  }
  let store: Promise<RetainedStore<Admission>> | undefined;
  const opened = (): Promise<RetainedStore<Admission>> => (store ??= Promise.resolve().then(() => open({ namespace: "admitted-sessions", retention: "retained" })));
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

function runFactsFor(api: PluginApi): RunFactsStore {
  const open = api.runtime?.state?.openKeyedStore;
  if (open === undefined) {
    throw new Error("OpenClaw has no api.runtime.state.openKeyedStore");
  }
  let store: Promise<RetainedStore<StoredRunFact>> | undefined;
  const opened = (): Promise<RetainedStore<StoredRunFact>> => (store ??= Promise.resolve().then(() => open({ namespace: RUN_FACTS_NAMESPACE, retention: "retained" })));
  const keyFor = (runId: string, namespace: string) => JSON.stringify([PROCESS_IDENTITY, runId, namespace]);
  const isStoredFact = (value: unknown): value is StoredRunFact => {
    if (value === null || typeof value !== "object") {
      return false;
    }
    const fact = value as Partial<StoredRunFact>;
    return typeof fact.processIdentity === "string" && typeof fact.runId === "string" &&
      typeof fact.namespace === "string" && fact.value !== null && typeof fact.value === "object";
  };
  const isFact = (value: unknown, runId: string, namespace: string): value is StoredRunFact => {
    return isStoredFact(value) && value.processIdentity === PROCESS_IDENTITY &&
      value.runId === runId && value.namespace === namespace;
  };
  return {
    async set(runId, namespace, value) {
      await (await opened()).register(keyFor(runId, namespace), { processIdentity: PROCESS_IDENTITY, runId, namespace, value });
    },
    async setIfAbsent(runId, namespace, value) {
      return (await opened()).registerIfAbsent(keyFor(runId, namespace), { processIdentity: PROCESS_IDENTITY, runId, namespace, value });
    },
    async get(runId, namespace) {
      const fact = await (await opened()).lookup(keyFor(runId, namespace));
      return isFact(fact, runId, namespace) ? fact.value : undefined;
    },
    async consume(runId, namespace) {
      const fact = await (await opened()).consume(keyFor(runId, namespace));
      return isFact(fact, runId, namespace) ? fact.value : undefined;
    },
    async clear(runId, namespace) {
      const current = await opened();
      if (namespace !== undefined) {
        await current.delete(keyFor(runId, namespace));
        return;
      }
      for (const entry of await current.entries()) {
        if (isStoredFact(entry.value) && entry.value.processIdentity === PROCESS_IDENTITY && entry.value.runId === runId) {
          await current.delete(entry.key);
        }
      }
    },
    async pruneOtherProcesses() {
      const current = await opened();
      for (const entry of await current.entries()) {
        if (!isStoredFact(entry.value) || entry.value.processIdentity !== PROCESS_IDENTITY) {
          await current.delete(entry.key);
        }
      }
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
      hasRunStateStore: api.runtime?.state?.openKeyedStore !== undefined,
      settings: api.runtime?.config?.current?.(),
      deadlineMs: config.deadlineMs,
    });
    if (failed !== undefined) {
      const reason = `ACS plugin blocks every step: ${failed}`;
      api.logger.error(reason);
      return { hooks: createBlockingHooks(reason, config.blockedReplyText, audit, requirementCode(failed)) };
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
      runFacts: runFactsFor(api),
    });
    return { hooks, hookTimeoutMs: config.hookTimeoutMs };
  } catch (error) {
    const reason = `ACS plugin is not configured, so every step is blocked: ${(error as Error).message}`;
    api.logger.error(reason);
    return { hooks: createBlockingHooks(reason, undefined) };
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
