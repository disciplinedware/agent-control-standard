/**
 * A scripted ACS endpoint for the plugin's tests. It holds a Guardian's side
 * of §10 for real: it refuses a request whose signature does not verify,
 * keeps negotiated sessions, answers a step of an unknown session with
 * CAPABILITY_NOT_NEGOTIATED, and signs every answer to an authenticated
 * request. What it decides is the test's script.
 */
import { canonicalJson, deriveSessionKey, type SigningKey } from "../host-adapter.ts";
import { createHmac, timingSafeEqual } from "node:crypto";

type Json = Record<string, unknown>;

export type ReceivedStep = {
  method: string;
  requestId: unknown;
  sessionId: string;
  userContext: unknown;
  turnId: unknown;
  agentName: unknown;
  payload: Json;
};

/** What the script answers one step with. */
export type Reply =
  | { decision: Json }
  | { error: { code: number; message: string } }
  | { unsignedDecision: Json }
  | { body: string }
  | { hang: true };

export type FakeAcsServer = {
  url: string;
  steps: ReceivedStep[];
  handshakes: number;
  /** The `methods_implemented` of the last ClientHello. */
  methodsImplemented: unknown;
  /** What the next ServerHello says is evaluated, as `StartOptions.methodsEvaluated`. */
  methodsEvaluated: string[] | null | undefined;
  /** Each step waits this long before it is answered. */
  delayMs: number;
  badSignatures: number;
  forgetSessions(): void;
  stop(): void;
};

export type StartOptions = {
  key: SigningKey;
  reply?: (step: ReceivedStep) => Reply | Promise<Reply>;
  onDecisionFailure?: "proceed" | "deny";
  /** The methods the ServerHello says are evaluated; every method the client implements when omitted, no list at all when `null`. */
  methodsEvaluated?: string[] | null;
};

function hmac(key: SigningKey, sessionId: string, unsigned: unknown): Buffer {
  return createHmac("sha256", deriveSessionKey(key.secret, sessionId, key.hkdf)).update(canonicalJson(unsigned)).digest();
}

function verifies(request: Json, key: SigningKey): boolean {
  const params = request.params as Json;
  const { signature, ...unsignedParams } = params;
  const sig = signature as { value?: unknown; key_id?: unknown } | undefined;
  const sessionId = (params.metadata as Json | undefined)?.session_id;
  if (typeof sig?.value !== "string" || sig.key_id !== key.keyId || typeof sessionId !== "string") {
    return false;
  }
  const expected = hmac(key, sessionId, { ...request, params: unsignedParams });
  const received = Buffer.from(sig.value, "base64");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function signed(response: Json, key: SigningKey, sessionId: string): Json {
  const holder = response.error === undefined ? "result" : "error";
  const value = hmac(key, sessionId, response).toString("base64");
  return { ...response, [holder]: { ...(response[holder] as Json), signature: { algorithm: "HMAC-SHA256", value, key_id: key.keyId } } };
}

export function startFakeAcsServer({
  key,
  reply = () => ({ decision: { decision: "allow" } }),
  onDecisionFailure = "deny",
  methodsEvaluated,
}: StartOptions): FakeAcsServer {
  const sessions = new Set<string>();
  const ended = new Set<string>();
  const state: FakeAcsServer = {
    url: "",
    steps: [],
    handshakes: 0,
    methodsImplemented: undefined,
    methodsEvaluated,
    delayMs: 0,
    badSignatures: 0,
    forgetSessions: () => sessions.clear(),
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const request = (await req.json()) as Json;
      const params = request.params as Json;
      const sessionId = (params.metadata as Json).session_id as string;
      if (!verifies(request, key)) {
        state.badSignatures += 1;
        return Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32004, message: "signature_invalid" } });
      }
      const answer = (response: Json): Response => Response.json(signed({ jsonrpc: "2.0", id: request.id, ...response }, key, sessionId));

      if (request.method === "handshake/hello") {
        state.handshakes += 1;
        sessions.add(sessionId);
        const hello = params.payload as Json;
        state.methodsImplemented = hello.methods_implemented;
        return answer({
          result: {
            negotiated_version: "0.1.0",
            ...(state.methodsEvaluated === null ? {} : { methods_evaluated: state.methodsEvaluated ?? hello.methods_implemented }),
            selected_transport: "http",
            signature_algorithms_supported: ["HMAC-SHA256"],
            timeout_config: { default_ms: 5000 },
            skew_window_ms: 300000,
            on_decision_failure: onDecisionFailure,
            policy_requires_provenance: false,
            profiles_accepted: ["acs-core"],
          },
        });
      }
      if (!sessions.has(sessionId)) {
        return answer({ error: { code: -32003, message: "the session has not completed handshake/hello" } });
      }
      const step: ReceivedStep = {
        method: request.method as string,
        requestId: params.request_id,
        sessionId,
        userContext: (params.metadata as Json).user_context,
        turnId: (params.metadata as Json).turn_id,
        agentName: (params.metadata as Json).agent_name,
        payload: params.payload as Json,
      };
      state.steps.push(step);
      // As a Guardian does (§8): no step enters an ended session.
      if (ended.has(sessionId)) {
        return answer({ result: { type: "final", acs_version: "0.1.0", request_id: params.request_id, decision: "deny", reasoning: "session ended" } });
      }
      if (step.method === "steps/sessionEnd") {
        ended.add(sessionId);
      }
      if (state.delayMs > 0) {
        await Bun.sleep(state.delayMs);
      }
      const scripted = await reply(step);
      if ("hang" in scripted) {
        return new Promise<Response>(() => {});
      }
      if ("body" in scripted) {
        return new Response(scripted.body, { headers: { "content-type": "application/json" } });
      }
      if ("unsignedDecision" in scripted) {
        return Response.json({ jsonrpc: "2.0", id: request.id, result: { request_id: params.request_id, ...scripted.unsignedDecision } });
      }
      if ("error" in scripted) {
        return answer({ error: scripted.error });
      }
      return answer({ result: { type: "final", acs_version: "0.1.0", request_id: params.request_id, ...scripted.decision } });
    },
  });
  state.url = `http://127.0.0.1:${server.port}/acs`;
  return state;
}
