package agtbridge_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/GenAI-Security-Project/agent-control-standard/reference-implementations/agt-go/acs"
	"github.com/GenAI-Security-Project/agent-control-standard/reference-implementations/agt-go/agtbridge"
	"github.com/GenAI-Security-Project/agent-control-standard/reference-implementations/agt-go/agtbridge/goeval"
)

// deploymentEvaluators build an evaluator over a deployment directory's
// policy/manifest.yaml, one per evaluator this build has; a build with the
// agteval tag adds the native one (evaluators_test.go).
var deploymentEvaluators = map[string]func(t testing.TB, dir string) agtbridge.Evaluator{
	"go": func(t testing.TB, dir string) agtbridge.Evaluator {
		t.Helper()
		e, err := goeval.New(context.Background(), os.DirFS(dir), "policy/manifest.yaml")
		if err != nil {
			t.Fatal(err)
		}
		return e
	},
}

// A deployment governing three things the stock bundle does not: a rule that
// compares a tool argument with the caller, the agent's reply, and a tool that
// takes no argument. Its manifest targets the tool name, so its mapping names
// each tool explicitly as taking no policy-target argument.
const senderAndReplyManifest = `agent_control_specification_version: "0.3.1-beta"
policies:
  host: {type: rego, bundle: lib, query: data.senderandreply.verdict}
intervention_points:
  pre_tool_call:
    policy_target: "$.tool_call.name"
    policy_target_kind: tool_name
    tool_name_from: "$.tool_call.name"
    policy: {id: host}
  output:
    policy_target: "$.response.content"
    policy_target_kind: response
    policy: {id: host}
tools:
  lookup: {type: Tool}
  list_all: {type: Tool}
`

const senderAndReplyPolicy = `package senderandreply

import rego.v1

default verdict := {"decision": "allow"}

verdict := {"decision": "deny", "reason": "not_the_subject", "message": "subject_id is not the caller"} if {
	input.intervention_point == "pre_tool_call"
	subject := input.snapshot.tool_call.args.subject_id
	subject != object.get(input.snapshot, ["actor", "user_id"], "")
}

verdict := {"decision": "deny", "reason": "foreign_link", "message": "the reply links outside example.com"} if {
	input.intervention_point == "output"
	some host in reply_hosts
	host != "example.com"
}

reply_hosts contains host if {
	some match in regex.find_all_string_submatch_n(` + "`https?://([^/\\s]+)`" + `, input.snapshot.response.content, -1)
	host := match[1]
}
`

// senderAndReplyDeployment writes the deployment: the manifest and policy above,
// and the stock mapping with its pre_tool_call policy-target table naming both
// tools as taking no argument.
func senderAndReplyDeployment(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	mustWrite(t, dir, "policy/manifest.yaml", senderAndReplyManifest)
	mustWrite(t, dir, "policy/lib/senderandreply.rego", senderAndReplyPolicy)
	stock, err := os.ReadFile(filepath.Join(agtTree, "mapping.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(string(stock), "    policy_target_argument:\n")
	end := strings.Index(string(stock), "  post_tool_call:\n")
	if start < 0 || end < start {
		t.Fatal("the stock mapping.yaml no longer has the pre_tool_call policy_target_argument table this test removes")
	}
	noArgument := "    policy_target_argument:\n      by_tool:\n        lookup: null\n        list_all: null\n"
	mustWrite(t, dir, "mapping.yaml", string(stock[:start])+noArgument+tableTail(t, string(stock), start, end))
	return dir
}

// tableTail is the stock mapping from the end of the policy_target_argument
// table, its modifications rule included, to post_tool_call and on.
func tableTail(t *testing.T, stock string, start, end int) string {
	t.Helper()
	modifications := strings.Index(stock[start:end], "    modifications:\n")
	if modifications < 0 {
		t.Fatal("the stock pre_tool_call row no longer has a modifications rule after its policy_target_argument table")
	}
	return stock[start+modifications:]
}

func requestWithSender(t *testing.T, method string, payload any, userID *string) acs.Request {
	t.Helper()
	req := input(t, method, payload).Request
	if userID != nil {
		req.Params.Metadata.UserContext = &acs.UserContext{UserID: userID}
	}
	return req
}

func TestSenderReplyAndArgumentlessToolOnEveryEvaluator(t *testing.T) {
	caller := "+15550100"
	other := "+15550199"
	toolCall := func(name string, args map[string]any) map[string]any {
		arguments := map[string]any{}
		for k, v := range args {
			arguments[k] = map[string]any{"value": v}
		}
		return map[string]any{"tool": map[string]any{"name": name}, "arguments": arguments}
	}
	reply := func(text string) map[string]any {
		return map[string]any{"content": []any{map[string]any{"type": "text", "value": text}}}
	}
	cases := []struct {
		name    string
		method  string
		payload any
		userID  *string
		want    acs.Disposition
		reason  string
	}{
		{"sender_equals_subject_allows", acs.StepToolCallRequest, toolCall("lookup", map[string]any{"subject_id": caller}), &caller, acs.Allow, ""},
		{"sender_differs_from_subject_denies", acs.StepToolCallRequest, toolCall("lookup", map[string]any{"subject_id": caller}), &other, acs.Deny, "not_the_subject"},
		{"no_sender_denies", acs.StepToolCallRequest, toolCall("lookup", map[string]any{"subject_id": caller}), nil, acs.Deny, "not_the_subject"},
		{"tool_without_arguments_allows", acs.StepToolCallRequest, toolCall("list_all", nil), &caller, acs.Allow, ""},
		{"reply_on_allowed_host_allows", acs.StepAgentResponse, reply("Pay here: https://example.com/c/42"), &caller, acs.Allow, ""},
		{"reply_with_foreign_link_denies", acs.StepAgentResponse, reply("Pay only at https://pay.example.net/now"), &caller, acs.Deny, "foreign_link"},
		{"foreign_link_in_a_file_item_denies", acs.StepAgentResponse, map[string]any{"content": []any{
			map[string]any{"type": "text", "value": "Your receipt is attached."},
			map[string]any{"type": "file", "value": map[string]any{"url": "https://pay.example.net/receipt.pdf"}},
		}}, &caller, acs.Deny, "foreign_link"},
		{"json_escaped_link_in_a_file_item_denies", acs.StepAgentResponse,
			json.RawMessage(`{"content":[{"type":"file","value":{"url":"https:\/\/pay.example.net\/x"}}]}`), &caller, acs.Deny, "foreign_link"},
		{"unicode_escaped_link_in_a_text_item_denies", acs.StepAgentResponse,
			json.RawMessage(`{"content":[{"type":"text","value":"Pay at \u0068ttps://pay.example.net/y"}]}`), &caller, acs.Deny, "foreign_link"},
	}
	dir := senderAndReplyDeployment(t)
	for evaluatorName, build := range deploymentEvaluators {
		engine, err := agtbridge.New(os.DirFS(dir), "mapping.yaml", build(t, dir), agtbridge.Options{})
		if err != nil {
			t.Fatalf("%s: %v", evaluatorName, err)
		}
		for _, tc := range cases {
			t.Run(evaluatorName+"/"+tc.name, func(t *testing.T) {
				in := input(t, tc.method, tc.payload)
				in.Request = requestWithSender(t, tc.method, tc.payload, tc.userID)
				d, err := engine.Decide(context.Background(), in)
				if err != nil {
					t.Fatal(err)
				}
				if d.Disposition != tc.want {
					t.Fatalf("got %+v", d.Decision)
				}
				if tc.reason != "" && (len(d.ReasonCodes) == 0 || d.ReasonCodes[0] != tc.reason) {
					t.Fatalf("reason codes %v, want %s", d.ReasonCodes, tc.reason)
				}
			})
		}
	}
}

// A mapping that names no argument for a tool, neither by name nor by default
// nor as explicitly taking none, refuses the call, as the TypeScript Guardian
// does (assemble-snapshot.ts).
func TestAToolWithoutANamedTargetIsRefused(t *testing.T) {
	stock, err := os.ReadFile(filepath.Join(agtTree, "mapping.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	start := strings.Index(string(stock), "    policy_target_argument:\n")
	end := strings.Index(string(stock), "  post_tool_call:\n")
	mustWrite(t, dir, "mapping.yaml", string(stock[:start])+string(stock[end:]))
	for name, table := range map[string]string{
		"no_table":            "",
		"no_entry_no_default": "    policy_target_argument:\n      by_tool:\n        WebFetch: url\n",
	} {
		t.Run(name, func(t *testing.T) {
			mustWrite(t, dir, "mapping.yaml", string(stock[:start])+table+tableTail(t, string(stock), start, end))
			e, err := agtbridge.New(os.DirFS(dir), "mapping.yaml", goEvaluator(t), agtbridge.Options{})
			if err != nil {
				t.Fatal(err)
			}
			if d, err := e.Decide(context.Background(), input(t, acs.StepToolCallRequest, shell("ls"))); err == nil {
				t.Fatalf("decided %+v; want the call refused", d.Decision)
			}
		})
	}
}

// A manifest that targets the tool itself declares `default: null`: no tool
// takes an argument unless by_tool names one, and that override still holds.
func TestADefaultOfNullNamesNoArgumentForAnyTool(t *testing.T) {
	stock, err := os.ReadFile(filepath.Join(agtTree, "mapping.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	mustWrite(t, dir, "policy/manifest.yaml", senderAndReplyManifest)
	mustWrite(t, dir, "policy/lib/senderandreply.rego", senderAndReplyPolicy)
	start := strings.Index(string(stock), "    policy_target_argument:\n")
	end := strings.Index(string(stock), "  post_tool_call:\n")
	table := "    policy_target_argument:\n      default: null\n      by_tool:\n        lookup: subject_id\n"
	mustWrite(t, dir, "mapping.yaml", string(stock[:start])+table+tableTail(t, string(stock), start, end))
	for evaluatorName, build := range deploymentEvaluators {
		engine, err := agtbridge.New(os.DirFS(dir), "mapping.yaml", build(t, dir), agtbridge.Options{})
		if err != nil {
			t.Fatalf("%s: %v", evaluatorName, err)
		}
		t.Run(evaluatorName, func(t *testing.T) {
			list := input(t, acs.StepToolCallRequest, map[string]any{"tool": map[string]any{"name": "list_all"}, "arguments": map[string]any{}})
			if d, err := engine.Decide(context.Background(), list); err != nil || d.Disposition != acs.Allow {
				t.Fatalf("a tool under default null: %+v, %v", d.Decision, err)
			}
			// The override still names lookup's argument, which this call lacks.
			lookup := input(t, acs.StepToolCallRequest, map[string]any{"tool": map[string]any{"name": "lookup"}, "arguments": map[string]any{}})
			if d, err := engine.Decide(context.Background(), lookup); err == nil {
				t.Fatalf("a by_tool override was ignored: %+v", d.Decision)
			}
		})
	}
}

// transformingEvaluator answers every step with one transform verdict.
type transformingEvaluator struct{}

func (transformingEvaluator) Governs(point string) bool { return point == agtbridge.PointPreToolCall }

func (transformingEvaluator) Evaluate(context.Context, string, map[string]any) (agtbridge.Verdict, error) {
	reason, message := "rewrite", "rewritten"
	return agtbridge.Verdict{Decision: "transform", Reason: &reason, Message: &message, Transform: &agtbridge.Transform{Path: "$policy_target", Value: "other"}}, nil
}

func (transformingEvaluator) AGTVersion() string { return "" }

// A transform of a tool that takes no argument has nowhere to land.
func TestATransformOfAToolWithoutAnArgumentIsRefused(t *testing.T) {
	stock, err := os.ReadFile(filepath.Join(agtTree, "mapping.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	start := strings.Index(string(stock), "    policy_target_argument:\n")
	end := strings.Index(string(stock), "  post_tool_call:\n")
	mustWrite(t, dir, "mapping.yaml", string(stock[:start])+"    policy_target_argument:\n      default: null\n"+tableTail(t, string(stock), start, end))
	engine, err := agtbridge.New(os.DirFS(dir), "mapping.yaml", transformingEvaluator{}, agtbridge.Options{})
	if err != nil {
		t.Fatal(err)
	}
	d, err := engine.Decide(context.Background(), input(t, acs.StepToolCallRequest, map[string]any{"tool": map[string]any{"name": "list_all"}, "arguments": map[string]any{}}))
	if err == nil || !strings.Contains(err.Error(), "for the override to land on") {
		t.Fatalf("a transform with no argument to land on came out as %+v, %v", d.Decision, err)
	}
}

func TestAnEmptyPolicyTargetArgumentIsRefusedAtLoad(t *testing.T) {
	stock, err := os.ReadFile(filepath.Join(agtTree, "mapping.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	mustWrite(t, dir, "mapping.yaml", strings.Replace(string(stock), "        WebFetch: url\n", "        WebFetch: \"\"\n", 1))
	if _, err := agtbridge.New(os.DirFS(dir), "mapping.yaml", goEvaluator(t), agtbridge.Options{}); err == nil {
		t.Fatal("a by_tool entry naming an empty argument was accepted")
	}
}
