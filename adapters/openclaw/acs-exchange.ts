/**
 * One signed ACS exchange per governed step: negotiate the session when this
 * process has no ServerHello for it, send the step, verify and validate the
 * decision, and answer every failure with the failure posture.
 *
 * Everything a step does is bounded by its hook's deadline, the handshake
 * included: every step one hook sends shares that deadline, so the hook
 * returns before OpenClaw's own budget for it ends.
 */
import {
  applyFailurePosture,
  createMemorySessionConfigStore,
  GuardianTimeoutError,
  negotiateSessionConfig,
  toSessionUuid,
  validateDecision,
  type AcsDecision,
  type AuditSink,
  type FailureResolvedAcsDecision,
  type GuardianClient,
  type JsonRpcRequest,
  type ResolvedSessionConfig,
  type SessionConfig,
  type ValidatedAcsDecision,
} from "./host-adapter.ts";
import { randomUUID } from "node:crypto";
import type { FailurePosture } from "./config.ts";

export const AGENT_ID = "openclaw";
const ACS_VERSION = "0.1.0";
/** §17.1 CAPABILITY_NOT_NEGOTIATED: the Guardian holds no session, or not this method in it. */
const CAPABILITY_NOT_NEGOTIATED = -32003;

export const METHODS = {
  sessionStart: "steps/sessionStart",
  agentTrigger: "steps/agentTrigger",
  turnStart: "steps/turnStart",
  userMessage: "steps/userMessage",
  toolCallRequest: "steps/toolCallRequest",
  toolCallResult: "steps/toolCallResult",
  subagentStart: "steps/subagentStart",
  agentResponse: "steps/agentResponse",
  turnEnd: "steps/turnEnd",
  sessionEnd: "steps/sessionEnd",
} as const;
export type StepMethod = (typeof METHODS)[keyof typeof METHODS];

/** `metadata.user_context`: who the step acts for, as the channel names them. */
export type UserContext = { user_id: string; authentication_method: string };

export type Step = {
  method: StepMethod;
  /**
   * OpenClaw's session id, which is new for each OpenClaw session even when
   * the session key is reused; the ACS session is its UUIDv5.
   */
  sessionId: string;
  userContext: UserContext;
  payload: Record<string, unknown>;
  /** The document a `modify` decision's pointers address (§6.3). */
  modificationDocument: Record<string, unknown>;
  /** `metadata.turn_id`: the turn this step belongs to, absent outside one. */
  turnId?: string;
  /** `metadata.agent_name`: the host's agent that runs the session, when the host names one. */
  agentName?: string;
};

/**
 * What became of a step. `requestId` is the ACS `request_id` the step went
 * out under, or `null` when none was sent. `unevaluated` is a method the
 * Guardian's ServerHello leaves out of `methods_evaluated`, which the
 * handshake schema says a client treats as ALLOW and need not send.
 */
export type StepOutcome = { requestId: string | null } & (
  | { stage: "honoured"; decision: ValidatedAcsDecision }
  | { stage: "delivery"; decision: FailureResolvedAcsDecision }
  | { stage: "unevaluated"; decision: AcsDecision }
);

export type AcsExchange = {
  /** `deadlineAt` (`performance.now()` time) bounds the step; one `deadlineMs` from now when absent. */
  decide(step: Step, deadlineAt?: number): Promise<StepOutcome>;
  /** The deadline of a hook that starts now. */
  deadlineFromNow(): number;
  /** Drops the stored ServerHello of a session OpenClaw ended. */
  forget(sessionId: string): void;
};

export type CreateAcsExchangeOptions = {
  client: GuardianClient;
  audit: AuditSink;
  failurePosture: FailurePosture;
  deadlineMs: number;
};

type Answer =
  | { arrived: true; decision: ValidatedAcsDecision; rpcId: string }
  | { arrived: false; failure: unknown; rpcId: string | null };

function isNotNegotiated(failure: unknown): boolean {
  return typeof failure === "object" && failure !== null && (failure as { code?: unknown }).code === CAPABILITY_NOT_NEGOTIATED;
}

export function createAcsExchange({ client, audit, failurePosture, deadlineMs }: CreateAcsExchangeOptions): AcsExchange {
  /** Negotiated ServerHellos and handshakes in flight, by ACS session id. */
  const sessions = new Map<string, Promise<ResolvedSessionConfig>>();

  function remainingMs(deadlineAt: number): number {
    const remaining = Math.floor(deadlineAt - performance.now());
    if (remaining <= 0) {
      throw new GuardianTimeoutError(deadlineMs);
    }
    return remaining;
  }

  async function negotiate(sessionId: string, deadlineAt: number): Promise<ResolvedSessionConfig> {
    try {
      const config = await negotiateSessionConfig(
        {
          guardian: client,
          agentId: AGENT_ID,
          sessionId,
          timeoutMs: remainingMs(deadlineAt),
          methodsImplemented: Object.values(METHODS),
        },
        createMemorySessionConfigStore(),
      );
      return { config, failure: undefined };
    } catch (failure) {
      return { config: undefined, failure };
    }
  }

  /**
   * The stored ServerHello, or one handshake shared by every step that needs
   * it, waited for no longer than this step's own deadline. A failed
   * handshake is not kept.
   */
  async function resolveSession(sessionId: string, deadlineAt: number): Promise<ResolvedSessionConfig> {
    let pending = sessions.get(sessionId);
    if (pending === undefined) {
      const negotiation: Promise<ResolvedSessionConfig> = negotiate(sessionId, deadlineAt).then((resolved) => {
        if (resolved.config === undefined && sessions.get(sessionId) === negotiation) {
          sessions.delete(sessionId);
        }
        return resolved;
      });
      pending = negotiation;
      sessions.set(sessionId, pending);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<ResolvedSessionConfig>((resolve) => {
      timer = setTimeout(
        () => resolve({ config: undefined, failure: new GuardianTimeoutError(deadlineMs) }),
        Math.max(0, deadlineAt - performance.now()),
      );
    });
    return await Promise.race([pending, late]).finally(() => clearTimeout(timer));
  }

  async function send(step: Step, sessionId: string, config: SessionConfig, startedAt: number, deadlineAt: number): Promise<Answer> {
    const requestId = randomUUID();
    const envelope: JsonRpcRequest = {
      jsonrpc: "2.0",
      method: step.method,
      id: requestId,
      params: {
        acs_version: ACS_VERSION,
        request_id: requestId,
        timestamp: new Date().toISOString(),
        metadata: {
          agent_id: AGENT_ID,
          session_id: sessionId,
          user_context: step.userContext,
          ...(step.turnId === undefined ? {} : { turn_id: step.turnId }),
          ...(step.agentName === undefined ? {} : { agent_name: step.agentName }),
        },
        payload: step.payload,
      },
    };
    let timeoutMs: number;
    try {
      const negotiated = config.timeout_config.per_method_ms?.[step.method] ?? config.timeout_config.default_ms;
      timeoutMs = Math.min(negotiated, remainingMs(deadlineAt));
    } catch (failure) {
      return { arrived: false, failure, rpcId: requestId };
    }
    const answer = await client.requestDecision(envelope, { timeoutMs });
    if (!answer.decisionArrived) {
      return { arrived: false, failure: answer.failure, rpcId: requestId };
    }
    const decision = validateDecision(answer.decision, {
      elapsedMs: performance.now() - startedAt,
      modificationDocument: step.modificationDocument,
    });
    return { arrived: true, decision, rpcId: requestId };
  }

  function resolveByPosture(step: Step, session: ResolvedSessionConfig, failure: unknown, rpcId: string | null): StepOutcome {
    const decision = applyFailurePosture({
      failure,
      session,
      sessionId: step.sessionId,
      method: step.method,
      rpcId,
      audit,
      stage: "delivery",
      ...(failurePosture === "closed" ? { hostPosture: "deny" as const } : {}),
    });
    return { stage: "delivery", decision, requestId: rpcId };
  }

  /** The ServerHello's `methods_evaluated`, or `undefined` when it carries no list to read. */
  function evaluatedMethods(config: SessionConfig): unknown[] | undefined {
    return Array.isArray(config.methods_evaluated) ? config.methods_evaluated : undefined;
  }

  return {
    deadlineFromNow(): number {
      return performance.now() + deadlineMs;
    },

    async decide(step: Step, deadlineAt: number = performance.now() + deadlineMs): Promise<StepOutcome> {
      const startedAt = performance.now();
      const sessionId = toSessionUuid(step.sessionId);

      /** What the ServerHello says of this method, or the posture's outcome when it cannot say. */
      const evaluation = (session: ResolvedSessionConfig): StepOutcome | "evaluated" => {
        if (session.config === undefined) {
          return resolveByPosture(step, session, session.failure, null);
        }
        const evaluated = evaluatedMethods(session.config);
        if (evaluated === undefined) {
          return resolveByPosture(step, session, new Error("the ServerHello carries no methods_evaluated list"), null);
        }
        if (!evaluated.includes(step.method)) {
          return {
            stage: "unevaluated",
            decision: { decision: "allow", reasoning: `the Guardian does not evaluate ${step.method}` },
            requestId: null,
          };
        }
        return "evaluated";
      };

      let session = await resolveSession(sessionId, deadlineAt);
      const first = evaluation(session);
      if (first !== "evaluated") {
        return first;
      }
      let answer = await send(step, sessionId, session.config!, startedAt, deadlineAt);

      // A Guardian that restarted or expired the session no longer knows it:
      // handshake again, once, and resend the step under a new request_id. The
      // new ServerHello is read as the first was.
      if (!answer.arrived && isNotNegotiated(answer.failure)) {
        sessions.delete(sessionId);
        session = await resolveSession(sessionId, deadlineAt);
        const again = evaluation(session);
        if (again !== "evaluated") {
          return again;
        }
        answer = await send(step, sessionId, session.config!, startedAt, deadlineAt);
      }

      if (!answer.arrived) {
        return resolveByPosture(step, session, answer.failure, answer.rpcId);
      }
      return { stage: "honoured", decision: answer.decision, requestId: answer.rpcId };
    },

    forget(sessionId: string): void {
      sessions.delete(toSessionUuid(sessionId));
    },
  };
}
