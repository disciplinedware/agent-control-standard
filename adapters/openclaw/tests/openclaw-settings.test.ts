import { describe, expect, it } from "bun:test";
import { directivesAllowedBecause, notOneSenderSessionBecause, type OpenClawSettings } from "../openclaw-settings.ts";

const SENDER = "+15550100";
const OPERATORS = { commands: { allowFrom: { telegram: ["+15550111"] } } };

describe("directivesAllowedBecause", () => {
  it.each<[string, OpenClawSettings]>([
    ["operators_listed", OPERATORS],
    ["no_operators_at_all", { commands: { allowFrom: {} } }],
    // OpenClaw reads an empty list for a channel as "no sender of that channel may send commands".
    ["an_empty_list_for_the_channel", { commands: { allowFrom: { telegram: [] } } }],
  ])("lets no sender direct under %s", (_name, settings) => {
    expect(directivesAllowedBecause(settings, SENDER)).toBeUndefined();
  });

  it.each<[string, OpenClawSettings]>([
    // Without commands.allowFrom every paired sender may send directives.
    ["no_command_allowlist", {}],
    ["a_wildcard_command_entry", { commands: { allowFrom: { "*": ["*"] } } }],
    ["the_sender_in_the_command_allowlist", { commands: { allowFrom: { telegram: ["+15550100"] } } }],
    ["the_sender_under_a_channel_prefix", { commands: { allowFrom: { "*": ["telegram:+1 555 0100"] } } }],
    ["a_command_list_that_is_not_a_list", { commands: { allowFrom: { telegram: "+15550111" } } }],
  ])("finds a sender who may direct under %s", (_name, settings) => {
    expect(directivesAllowedBecause(settings, SENDER)).toBeString();
  });
});

describe("notOneSenderSessionBecause", () => {
  it.each<[string, string, string | undefined]>([
    ["per_channel_peer", "agent:main:telegram:direct:+15550100", undefined],
    ["per_account_channel_peer", "agent:main:telegram:default:direct:+15550100", "default"],
  ])("accepts a %s session key", (_name, key, account) => {
    expect(notOneSenderSessionBecause(key, "telegram", "+15550100", account)).toBeUndefined();
  });

  it.each<[string, string, string, string | undefined]>([
    ["the_main_session", "agent:main:main", "+15550100", undefined],
    ["a_per_peer_session", "agent:main:direct:+15550100", "+15550100", undefined],
    ["another_sender's_session", "agent:main:telegram:direct:+15550100", "+15550199", undefined],
    ["another_channel's_session", "agent:main:signal:direct:+15550100", "+15550100", undefined],
    ["a_group", "agent:main:telegram:group:-1001234567890", "+15550100", undefined],
    ["a_thread_below_the_direct_session", "agent:main:telegram:direct:+15550100:thread:1", "+15550100", undefined],
    ["an_extra_segment", "agent:main:telegram:a:b:direct:+15550100", "+15550100", undefined],
    // OpenClaw lowercases the peer, so U0123 and u0123 would share this key.
    ["a_sender_id_OpenClaw_would_lowercase", "agent:main:telegram:direct:u0123", "U0123", undefined],
    // A colon lets the peer read as more segments.
    ["a_sender_id_with_a_colon", "agent:main:telegram:direct:x:direct:y", "x:direct:y", undefined],
    ["a_sender_id_OpenClaw_would_trim", "agent:main:telegram:direct:+15550100", " +15550100", undefined],
    // A group key whose peer reads "direct:<sender>" has the per-account shape.
    ["a_group_key_shaped_like_an_account_key", "agent:main:telegram:group:direct:+15550100", "+15550100", "default"],
    ["an_account_key_of_another_account", "agent:main:telegram:other:direct:+15550100", "+15550100", "default"],
    ["an_account_key_for_a_run_with_no_account", "agent:main:telegram:default:direct:+15550100", "+15550100", undefined],
  ])("refuses %s", (_name, key, sender, account) => {
    expect(notOneSenderSessionBecause(key, "telegram", sender, account)).toBeString();
  });
});
