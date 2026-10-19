import { describe, expect, it } from "bun:test";
import plugin from "../acs-plugin.ts";
import { parseConfig } from "../config.ts";
import { failedRequirement, VERIFIED_OPENCLAW_VERSION } from "../requirements.ts";
import { memoryPluginState } from "./memory-plugin-state.ts";

const example = await Bun.file(new URL("../openclaw.json.example", import.meta.url)).json();
const ENV = { ACS_HMAC_SECRET: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64") };

describe("openclaw.json.example", () => {
  it("holds a plugin config the plugin accepts", () => {
    expect(parseConfig(example.plugins.entries["acs-guardian-client"].config, ENV)).toMatchObject({ approvers: new Set(["approver-1"]) });
  });

  it("meets every requirement for a sender the command list does not name, in that sender's own session", () => {
    const run = { settings: example, senderId: "+15550100", channel: "signal", sessionKey: "agent:main:signal:direct:+15550100" };
    expect(failedRequirement("registration", { settings: example, version: VERIFIED_OPENCLAW_VERSION, hasMiddlewareRegistrar: true, hasRunStateStore: true, deadlineMs: 5000 })).toBeUndefined();
    expect(failedRequirement("dispatch", run)).toBeUndefined();
    expect(failedRequirement("run", { ...run, model: { provider: "openai", id: "gpt-6-astra" } })).toBeUndefined();
    expect(failedRequirement("run", { ...run, senderId: "+15550111", sessionKey: "agent:main:signal:direct:+15550111", model: { provider: "openai", id: "gpt-6-astra" } })).toStartWith("R6:");
    expect(example.session.dmScope).toBe("per-channel-peer");
  });

  it("enables the plugin by name, so OpenClaw runs its tool-result middleware", () => {
    process.env.ACS_HMAC_SECRET = ENV.ACS_HMAC_SECRET;
    const errors: string[] = [];
    const middleware: unknown[] = [];
    plugin.register({
      pluginConfig: example.plugins.entries["acs-guardian-client"].config,
      runtime: { version: VERIFIED_OPENCLAW_VERSION, config: { current: () => example }, state: memoryPluginState() } as never,
      logger: { error: (message: string) => errors.push(message) },
      on: () => {},
      registerAgentToolResultMiddleware: (_handler: unknown, options: unknown) => middleware.push(options),
    });
    expect(errors).toEqual([]);
    expect(middleware).toEqual([{ runtimes: ["openclaw"] }]);
  });
});
