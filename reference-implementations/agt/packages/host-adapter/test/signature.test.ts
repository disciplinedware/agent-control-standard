import { afterEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createGuardianClient } from "../src/guardian-client.ts";
import {
  canonicalJson,
  deriveSessionKey,
  signRequest,
  SignatureInvalidError,
  verifyResponse,
  type SigningKey,
} from "../src/signature.ts";

const SESSION_ID = "3f6c2a4e-8b1d-5c7e-9a2f-1b3c4d5e6f70";
const SECRET = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

/** Already in RFC 8785 form, so the bytes the Go signer was given are the bytes canonicalJson must produce. */
const CANONICAL_ENVELOPE =
  '{"id":"1","jsonrpc":"2.0","method":"steps/toolCallRequest","params":{"metadata":{"agent_id":"openclaw",' +
  `"session_id":"${SESSION_ID}","user_context":{"authentication_method":"signal","user_id":"+15550100"}},` +
  '"payload":{"arguments":{"phone":{"value":"+15550199"}},"tool":{"name":"lookup"}},"request_id":"1"}}';

const UTF8_KEY: SigningKey = {
  keyId: "example-key",
  secret: SECRET,
  hkdf: { salt: "", infoPrefix: "", sessionIdEncoding: "utf8" },
};

/**
 * Produced by the Go reference Guardian's own signer over CANONICAL_ENVELOPE:
 * `guardian.NewHMACSigner(guardian.HMACKey{ID: "example-key", Secret: SECRET}).Sign(ctx, SESSION_ID, "example-key", input)`
 * from reference-implementations/agt-go/guardian/hmac_signer.go.
 */
const GO_GUARDIAN_SIGNATURE = "fJ7cCI0qDOql8e53/cCQDDaq/syrk9vQNfP7F4MVpdk=";

/**
 * Produced with Go's crypto/hkdf and crypto/hmac: HKDF-SHA256 with salt
 * "example-salt/v1" and info "example-info/v1" || 0x00 || the 16 bytes of
 * SESSION_ID, then HMAC-SHA256 over CANONICAL_ENVELOPE.
 */
const UUID_BYTES_SIGNATURE = "F/PdeoAd4Zd05w47LSHhl8poFXmZxTKovkez1y+AfUI=";

function signResponse(response: Record<string, unknown>, key: SigningKey): Record<string, unknown> {
  const holder = response.error === undefined ? "result" : "error";
  const value = createHmac("sha256", deriveSessionKey(key.secret, SESSION_ID, key.hkdf))
    .update(canonicalJson(response))
    .digest("base64");
  return {
    ...response,
    [holder]: { ...(response[holder] as object), signature: { algorithm: "HMAC-SHA256", value, key_id: key.keyId } },
  };
}

describe("canonicalJson (RFC 8785)", () => {
  it("serializes the RFC 8785 section 3.2.2 example", () => {
    const input = {
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"/",
      literals: [null, true, false],
    };
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"\u20ac$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("refuses a value JSON has no form for", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow("non-finite");
  });
});

describe("signRequest", () => {
  it("matches the Go Guardian's signer for an empty salt and a UTF-8 session id", () => {
    const signed = signRequest(JSON.parse(CANONICAL_ENVELOPE), UTF8_KEY);
    expect(canonicalJson(JSON.parse(CANONICAL_ENVELOPE))).toBe(CANONICAL_ENVELOPE);
    expect(signed.params.signature).toEqual({ algorithm: "HMAC-SHA256", value: GO_GUARDIAN_SIGNATURE, key_id: "example-key" });
  });

  it("matches an independent derivation with a salt, an info prefix and the UUID's bytes", () => {
    const key: SigningKey = {
      keyId: "example-key",
      secret: SECRET,
      hkdf: { salt: "example-salt/v1", infoPrefix: "example-info/v1\u0000", sessionIdEncoding: "uuid-bytes" },
    };
    expect(signRequest(JSON.parse(CANONICAL_ENVELOPE), key).params.signature).toMatchObject({ value: UUID_BYTES_SIGNATURE });
  });

  it("covers the envelope without its own signature, so signing twice gives the same signature", () => {
    const once = signRequest(JSON.parse(CANONICAL_ENVELOPE), UTF8_KEY);
    expect(signRequest(once, UTF8_KEY)).toEqual(once);
  });

  it("refuses uuid-bytes for a session id that is not a UUID", () => {
    const envelope = JSON.parse(CANONICAL_ENVELOPE);
    envelope.params.metadata.session_id = "not-a-uuid";
    const key: SigningKey = { ...UTF8_KEY, hkdf: { ...UTF8_KEY.hkdf, sessionIdEncoding: "uuid-bytes" } };
    expect(() => signRequest(envelope, key)).toThrow("not a UUID");
  });
});

describe("the Go Guardian's own JCS and HKDF vectors", () => {
  type Vector = { signed: Record<string, unknown> & { params?: { signature: { value: string } } }; signing_input: string };
  const vectors = JSON.parse(
    readFileSync(join(import.meta.dir, "../../../../agt-go/internal/envelope/testdata/vectors.json"), "utf8"),
  ) as { ikm_hex: string; key_id: string; session_id: string; session_key_hex: string; request: Vector; response: Vector };
  const key: SigningKey = {
    keyId: vectors.key_id,
    secret: Buffer.from(vectors.ikm_hex, "hex"),
    hkdf: { salt: "", infoPrefix: "", sessionIdEncoding: "utf8" },
  };

  it("derives the same session key", () => {
    expect(deriveSessionKey(key.secret, vectors.session_id, key.hkdf).toString("hex")).toBe(vectors.session_key_hex);
  });

  it("signs the request vector with the signature the Go Guardian computed", () => {
    const { signature, ...params } = vectors.request.signed.params as Record<string, unknown>;
    const unsigned = { ...vectors.request.signed, params };
    expect(canonicalJson(unsigned)).toBe(vectors.request.signing_input);
    expect(signRequest(unsigned as Parameters<typeof signRequest>[0], key).params.signature).toEqual(signature);
  });

  it("verifies the response vector the Go Guardian signed", () => {
    expect(() => verifyResponse(vectors.response.signed, vectors.session_id, key)).not.toThrow();
  });
});

describe("verifyResponse", () => {
  const response = { jsonrpc: "2.0", id: "1", result: { request_id: "1", decision: "allow" } };

  it("accepts a result signed under the session key", () => {
    expect(() => verifyResponse(signResponse(response, UTF8_KEY), SESSION_ID, UTF8_KEY)).not.toThrow();
  });

  it.each([
    ["a_changed_decision", (r: Record<string, unknown>) => ({ ...r, result: { ...(r.result as object), decision: "deny" } })],
    ["a_changed_id", (r: Record<string, unknown>) => ({ ...r, id: "2" })],
    ["no_signature", () => response],
  ])("rejects %s", (_name, tamper) => {
    expect(() => verifyResponse(tamper(signResponse(response, UTF8_KEY)), SESSION_ID, UTF8_KEY)).toThrow(SignatureInvalidError);
  });

  it("rejects a signature under another key_id", () => {
    const other: SigningKey = { ...UTF8_KEY, keyId: "other-key" };
    expect(() => verifyResponse(signResponse(response, other), SESSION_ID, UTF8_KEY)).toThrow(SignatureInvalidError);
  });

  it("rejects a signature for another session", () => {
    expect(() => verifyResponse(signResponse(response, UTF8_KEY), "6f1a1c2b-0000-4000-8000-000000000000", UTF8_KEY)).toThrow(
      SignatureInvalidError,
    );
  });
});

describe("createGuardianClient with a signing key", () => {
  const servers: { stop(force?: boolean): void }[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.stop(true);
    }
  });

  function serve(answer: (request: Record<string, unknown>) => Record<string, unknown>): string {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        return Response.json(answer((await req.json()) as Record<string, unknown>));
      },
    });
    servers.push(server);
    return `http://127.0.0.1:${server.port}/acs`;
  }

  const envelope = JSON.parse(CANONICAL_ENVELOPE);

  it("sends the request signed and returns a decision whose signature verifies", async () => {
    let received: Record<string, unknown> | undefined;
    const url = serve((request) => {
      received = request;
      return signResponse({ jsonrpc: "2.0", id: request.id, result: { request_id: "1", decision: "allow" } }, UTF8_KEY);
    });
    const answer = await createGuardianClient(url, { signingKey: UTF8_KEY }).requestDecision(envelope, { timeoutMs: 2000 });
    expect(answer).toMatchObject({ decisionArrived: true, decision: { decision: "allow" } });
    expect((received?.params as Record<string, unknown>).signature).toMatchObject({ value: GO_GUARDIAN_SIGNATURE });
  });

  const allow = (request: Record<string, unknown>, requestId: unknown = "1") => ({
    jsonrpc: "2.0",
    id: request.id,
    result: { request_id: requestId, decision: "allow" },
  });

  it.each<[string, (request: Record<string, unknown>) => Record<string, unknown>]>([
    ["unsigned", (request) => allow(request)],
    [
      "signed_with_a_bad_value",
      (request) => {
        const signed = signResponse(allow(request), UTF8_KEY) as { result: { signature: { value: string } } };
        signed.result.signature.value = Buffer.alloc(32).toString("base64");
        return signed;
      },
    ],
    ["signed_under_another_key_id", (request) => signResponse(allow(request), { ...UTF8_KEY, keyId: "other-key" })],
    ["signed_for_another_request_id", (request) => signResponse(allow(request, "2"), UTF8_KEY)],
    ["signed_with_no_request_id", (request) => signResponse({ jsonrpc: "2.0", id: request.id, result: { decision: "allow" } }, UTF8_KEY)],
    [
      "an_unsigned_decision_beside_an_error_with_a_null_id",
      () => ({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "x" }, result: { request_id: "1", decision: "modify" } }),
    ],
    [
      "a_signed_error_beside_an_unsigned_decision",
      (request) => ({
        ...(signResponse({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "x" } }, UTF8_KEY) as object),
        result: { request_id: "1", decision: "allow" },
      }),
    ],
  ])("turns a decision that is %s into a delivery failure", async (_name, answer) => {
    const url = serve(answer);
    const result = await createGuardianClient(url, { signingKey: UTF8_KEY }).requestDecision(envelope, { timeoutMs: 2000 });
    expect(result.decisionArrived).toBe(false);
  });

  it("does not hand on the code of an unsigned error", async () => {
    const url = serve((request) => ({ jsonrpc: "2.0", id: request.id, error: { code: -32003, message: "not negotiated" } }));
    const result = await createGuardianClient(url, { signingKey: UTF8_KEY }).requestDecision(envelope, { timeoutMs: 2000 });
    expect(result.decisionArrived === false && result.failure).toBeInstanceOf(SignatureInvalidError);
  });

  it("hands on the code of a signed error", async () => {
    const url = serve((request) => signResponse({ jsonrpc: "2.0", id: request.id, error: { code: -32003, message: "not negotiated" } }, UTF8_KEY));
    const result = await createGuardianClient(url, { signingKey: UTF8_KEY }).requestDecision(envelope, { timeoutMs: 2000 });
    expect(result.decisionArrived === false && result.failure).toMatchObject({ code: -32003 });
  });

  it("turns a decision that does not verify into a delivery failure", async () => {
    const url = serve((request) => ({ jsonrpc: "2.0", id: request.id, result: { request_id: "1", decision: "allow" } }));
    const answer = await createGuardianClient(url, { signingKey: UTF8_KEY }).requestDecision(envelope, { timeoutMs: 2000 });
    expect(answer.decisionArrived).toBe(false);
    expect(answer.decisionArrived === false && answer.failure).toBeInstanceOf(SignatureInvalidError);
  });
});
