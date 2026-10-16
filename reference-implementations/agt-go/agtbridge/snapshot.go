package agtbridge

import (
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strings"

	jsonv2 "github.com/go-json-experiment/json"

	"github.com/GenAI-Security-Project/agent-control-standard/reference-implementations/agt-go/acs"
)

// PolicyTargetLeaf is the argument the snapshot copies a tool's policy
// target into, the leaf the checked-in manifest's pre_tool_call policy_target
// addresses. The TypeScript reference's assemble-snapshot.ts writes the same
// leaf.
const PolicyTargetLeaf = "acs_policy_target"

// The snapshots below have the shape packages/guardian/src/assemble-snapshot.ts
// builds, member for member, so the policy sees the same input.

func budgets() map[string]any {
	return map[string]any{"tool_call_count": 0.0, "token_count": 0.0, "elapsed_seconds": 0.0, "cost_usd": 0.0}
}

func ifcInput(labels []string) map[string]any {
	source := make([]any, len(labels))
	for i, l := range labels {
		source[i] = l
	}
	return map[string]any{"ifc": map[string]any{"source_labels": source}}
}

// withActor adds the step's metadata.user_context, in its wire shape, as the
// snapshot's actor: who the host says the agent acts for. AGT's snapshot has
// no caller identity of its own; its runtime passes the whole snapshot to
// Rego, so a rule reads input.snapshot.actor (docs/conformance.md).
func withActor(snapshot map[string]any, req acs.Request) (map[string]any, error) {
	if req.Params.Metadata.UserContext == nil {
		return snapshot, nil
	}
	raw, err := jsonv2.Marshal(req.Params.Metadata.UserContext)
	if err != nil {
		return nil, err
	}
	var actor map[string]any
	if err := jsonv2.Unmarshal(raw, &actor); err != nil {
		return nil, err
	}
	snapshot["actor"] = actor
	return snapshot, nil
}

// preToolCallSnapshot copies each argument's value into args, and the policy
// target argument's value, when the mapping names one, into the fixed leaf as
// well. With none, the manifest's policy_target addresses the snapshot
// directly, for example $.tool_call.name for a tool that takes no argument.
func preToolCallSnapshot(req acs.Request, labels []string, argument, policyToolName string) (map[string]any, error) {
	var payload acs.ToolCallRequestPayload
	if err := jsonv2.Unmarshal(req.Params.Payload, &payload); err != nil {
		return nil, err
	}
	args := map[string]any{}
	for name, a := range payload.Arguments {
		var v any
		if err := jsonv2.Unmarshal(a.Value, &v); err != nil {
			return nil, err
		}
		args[name] = v
	}
	if _, clash := args[PolicyTargetLeaf]; clash {
		return nil, fmt.Errorf("tool %q sent an argument named %q, which is the leaf this Guardian writes its policy target to", payload.Tool.Name, PolicyTargetLeaf)
	}
	if argument != "" {
		value, ok := args[argument]
		if !ok {
			sent := slices.Sorted(maps.Keys(args))
			return nil, fmt.Errorf("mapping.yaml reads tool %q's policy target from argument %q, but this call sent no such argument (it sent: %v)", payload.Tool.Name, argument, sent)
		}
		// The stock rules guard their targets with is_string; a target of any
		// other JSON type would pass every one of them.
		if _, isString := value.(string); !isString {
			return nil, fmt.Errorf("tool %q sent argument %q as a JSON %s, but its policy target must be a string", payload.Tool.Name, argument, jsonKind(value))
		}
		args[PolicyTargetLeaf] = value
	}
	raw := ""
	if payload.RawCommand != nil {
		raw = *payload.RawCommand
	}
	return withActor(map[string]any{
		"envelope":  map[string]any{"budgets": budgets()},
		"tool_call": map[string]any{"name": policyToolName, "args": args, "id": req.Params.RequestID, "raw_command": raw},
		"input":     ifcInput(labels),
	}, req)
}

func postToolCallSnapshot(req acs.Request, labels []string, policyToolName string) (map[string]any, error) {
	var payload acs.ToolCallResultPayload
	if err := jsonv2.Unmarshal(req.Params.Payload, &payload); err != nil {
		return nil, err
	}
	outputs := make([]any, len(payload.Outputs))
	for i, o := range payload.Outputs {
		var v any
		if err := jsonv2.Unmarshal(o.Value, &v); err != nil {
			return nil, err
		}
		outputs[i] = map[string]any{"value": v}
	}
	return withActor(map[string]any{
		"envelope":    map[string]any{"budgets": budgets()},
		"tool_call":   map[string]any{"name": policyToolName},
		"tool_result": map[string]any{"outputs": outputs},
		"input":       ifcInput(labels),
	}, req)
}

// appendStrings appends every string in a decoded JSON value, in document
// order for arrays and key order for objects.
func appendStrings(lines []string, value any) []string {
	switch v := value.(type) {
	case string:
		return append(lines, v)
	case []any:
		for _, item := range v {
			lines = appendStrings(lines, item)
		}
	case map[string]any:
		for _, key := range slices.Sorted(maps.Keys(v)) {
			lines = appendStrings(lines, v[key])
		}
	}
	return lines
}

// agentResponsePayload is the part of steps/agentResponse (hooks/agent-response.json)
// the output snapshot reads.
type agentResponsePayload struct {
	Content []struct {
		Type  string          `json:"type"`
		Value json.RawMessage `json:"value"`
	} `json:"content"`
}

// outputSnapshot is AGT's output point (AGT-SNAPSHOT-1.0 §2.7): the whole
// reply as response.content, one line per string - a text item's text, and
// every string inside any other item's decoded value, so a link in an image
// or file item reaches the rules as the host will read it, never in an
// escaped JSON form a pattern misses; the session's labels as result_labels;
// an empty message_chain, since ACS carries none.
func outputSnapshot(req acs.Request, labels []string) (map[string]any, error) {
	var payload agentResponsePayload
	if err := jsonv2.Unmarshal(req.Params.Payload, &payload); err != nil {
		return nil, err
	}
	var lines []string
	for _, item := range payload.Content {
		var value any
		if err := jsonv2.Unmarshal(item.Value, &value); err != nil {
			return nil, err
		}
		lines = appendStrings(lines, value)
	}
	resultLabels := make([]any, len(labels))
	for i, l := range labels {
		resultLabels[i] = l
	}
	return withActor(map[string]any{
		"envelope":      map[string]any{"budgets": budgets()},
		"response":      map[string]any{"content": strings.Join(lines, "\n"), "ifc": map[string]any{"result_labels": resultLabels}},
		"message_chain": []any{},
	}, req)
}

// jsonKind names the JSON type of a value that jsonv2 decoded into any.
func jsonKind(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case string:
		return "string"
	case float64:
		return "number"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return fmt.Sprintf("%T", v)
}
