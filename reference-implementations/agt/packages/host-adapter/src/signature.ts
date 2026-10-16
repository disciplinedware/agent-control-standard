/**
 * The §10 baseline signature, for any host: HMAC-SHA256 over the RFC 8785
 * (JCS) canonical form of an envelope with its `signature` member removed,
 * under a per-session key derived with HKDF-SHA256 (RFC 5869) from
 * deployment-provided keying material and the `session_id`.
 *
 * §10 fixes the signed input and the algorithm and leaves the HKDF salt and
 * info open, so two conformant Guardians can derive different keys from the
 * same secret. `HkdfParameters` carries those choices as data, so one host
 * build signs for any Guardian whose parameters it is configured with.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export const HMAC_SHA256 = "HMAC-SHA256";

const SESSION_KEY_BYTES = 32;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Signature = { algorithm: string; value: string; key_id: string };

/**
 * How a Guardian turns its secret and a `session_id` into the session key.
 * HKDF info is `infoPrefix` followed by the session id, encoded as its UTF-8
 * text (`utf8`) or as the 16 bytes the UUID names (`uuid-bytes`). An empty
 * salt is RFC 5869's default salt.
 */
export type HkdfParameters = {
  salt: string;
  infoPrefix: string;
  sessionIdEncoding: "utf8" | "uuid-bytes";
};

export type SigningKey = {
  keyId: string;
  secret: Uint8Array;
  hkdf: HkdfParameters;
};

export class SignatureInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureInvalidError";
  }
}

/**
 * RFC 8785 canonical JSON. RFC 8785 §3.2.2 and §3.2.3 define number and
 * string serialization as ECMAScript's `JSON.stringify`, and §3.2.3 sorts
 * member names by UTF-16 code units, which is what `Array.prototype.sort`
 * compares.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonicalJson: RFC 8785 has no form for a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new Error(`canonicalJson: RFC 8785 has no form for a ${typeof value}`);
  }
  const object = value as Record<string, unknown>;
  const members = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
  return `{${members.join(",")}}`;
}

function sessionIdBytes(sessionId: string, encoding: HkdfParameters["sessionIdEncoding"]): Buffer {
  if (encoding === "utf8") {
    return Buffer.from(sessionId, "utf8");
  }
  if (!UUID_RE.test(sessionId)) {
    throw new Error(`deriveSessionKey: session_id ${JSON.stringify(sessionId)} is not a UUID, so it has no uuid-bytes form`);
  }
  return Buffer.from(sessionId.replace(/-/g, ""), "hex");
}

export function deriveSessionKey(secret: Uint8Array, sessionId: string, hkdf: HkdfParameters): Buffer {
  const info = Buffer.concat([Buffer.from(hkdf.infoPrefix, "utf8"), sessionIdBytes(sessionId, hkdf.sessionIdEncoding)]);
  return Buffer.from(hkdfSync("sha256", secret, Buffer.from(hkdf.salt, "utf8"), info, SESSION_KEY_BYTES));
}

function mac(key: SigningKey, sessionId: string, unsigned: unknown): Buffer {
  return createHmac("sha256", deriveSessionKey(key.secret, sessionId, key.hkdf)).update(canonicalJson(unsigned), "utf8").digest();
}

type SignableRequest = { params: { metadata: { session_id: string } } & Record<string, unknown> } & Record<string, unknown>;

/** Returns a copy of `envelope` carrying `params.signature`. */
export function signRequest<T extends SignableRequest>(envelope: T, key: SigningKey): T {
  const { signature: _discarded, ...params } = envelope.params;
  const unsigned = { ...envelope, params };
  const value = mac(key, envelope.params.metadata.session_id, unsigned).toString("base64");
  return { ...unsigned, params: { ...params, signature: { algorithm: HMAC_SHA256, value, key_id: key.keyId } } } as T;
}

/**
 * Throws `SignatureInvalidError` unless the response carries a signature by
 * `key` over its own canonical form. The signature sits on `error` for an
 * error response and on `result` otherwise.
 */
export function verifyResponse(response: Record<string, unknown>, sessionId: string, key: SigningKey): void {
  const holderName = response.error === undefined ? "result" : "error";
  const holder = response[holderName];
  if (typeof holder !== "object" || holder === null) {
    throw new SignatureInvalidError(`the response carries no ${holderName} object to verify`);
  }
  const { signature, ...unsignedHolder } = holder as Record<string, unknown>;
  const candidate = signature as Partial<Signature> | undefined;
  if (candidate === undefined) {
    throw new SignatureInvalidError(`the response's ${holderName} is not signed`);
  }
  if (candidate.algorithm !== HMAC_SHA256 || candidate.key_id !== key.keyId || typeof candidate.value !== "string") {
    throw new SignatureInvalidError(
      `the response's ${holderName} is signed with ${JSON.stringify(candidate.algorithm)} under key_id ` +
        `${JSON.stringify(candidate.key_id)}, and this host verifies ${HMAC_SHA256} under ${JSON.stringify(key.keyId)}`,
    );
  }
  const expected = mac(key, sessionId, { ...response, [holderName]: unsignedHolder });
  const received = Buffer.from(candidate.value, "base64");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new SignatureInvalidError(`the response's ${holderName} signature does not verify`);
  }
}
