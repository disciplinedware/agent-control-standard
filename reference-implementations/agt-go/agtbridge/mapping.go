package agtbridge

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"

	jsonv2 "github.com/go-json-experiment/json"
	"go.yaml.in/yaml/v3"

	"github.com/GenAI-Security-Project/agent-control-standard/reference-implementations/agt-go/acs"
	"github.com/GenAI-Security-Project/agent-control-standard/reference-implementations/agt-go/internal/schema"
)

// mapping is the TypeScript reference's mapping.yaml, the single source of
// truth for how an AGT verdict becomes an ACS decision. This file reads it
// and implements it as packages/guardian/src/map-verdict.ts does; it
// declares nothing of its own.
type mapping struct {
	ACSVersion         string                  `yaml:"acs_version"`
	AGTVersion         string                  `yaml:"agt_version"`
	InterventionPoints map[string]mappingPoint `yaml:"intervention_points"`
	Verdicts           map[string]verdictRule  `yaml:"verdicts"`
	FieldSynthesis     fieldSynthesis          `yaml:"field_synthesis"`

	detail *regexp.Regexp
}

type mappingPoint struct {
	ACSMethod            *string               `yaml:"acs_method"`
	Note                 string                `yaml:"note"`
	PolicyTargetArgument *policyTargetArgument `yaml:"policy_target_argument"`
	Modifications        *modificationsRule    `yaml:"modifications"`
}

type policyTargetArgument struct {
	// Default names the argument of every tool ByTool does not name; an
	// explicit null names none, for a manifest that targets the tool itself.
	Default optionalArgument `yaml:"default"`
	// ByTool names each tool's argument; an explicit null names a tool that
	// takes none, whose policy target the manifest's own policy_target reads.
	ByTool map[string]*string `yaml:"by_tool"`
}

// optionalArgument tells an absent key from an explicit null: absent, the
// mapping says nothing; null, it says the tool takes no argument.
type optionalArgument struct {
	set   bool
	value *string
}

// UnmarshalYAML reads the table itself, because yaml.v3 decodes a null to a
// field's zero value without asking the field, so `default: null` would read
// as an absent default.
func (p *policyTargetArgument) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind != yaml.MappingNode {
		return fmt.Errorf("policy_target_argument must be a mapping")
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		key, value := node.Content[i], node.Content[i+1]
		switch key.Value {
		case "default":
			p.Default.set = true
			if value.Tag != "!!null" {
				var named string
				if err := value.Decode(&named); err != nil {
					return fmt.Errorf("policy_target_argument.default: %w", err)
				}
				p.Default.value = &named
			}
		case "by_tool":
			if err := value.Decode(&p.ByTool); err != nil {
				return fmt.Errorf("policy_target_argument.by_tool: %w", err)
			}
		default:
			return fmt.Errorf("policy_target_argument has an unknown key %q", key.Value)
		}
	}
	return nil
}

type modificationsRule struct {
	From     string `yaml:"from"`
	WhenPath string `yaml:"when_path"`
	Into     string `yaml:"into"`
	IntoPath string `yaml:"into_path"`
}

type verdictRule struct {
	Decision                acs.Disposition `yaml:"decision"`
	RequirePolicyReferences bool            `yaml:"require_policy_references"`
}

type fieldSynthesis struct {
	Reasoning struct {
		Source    string         `yaml:"source"`
		Template  *string        `yaml:"template"`
		Summaries map[string]any `yaml:"summaries"`
		Detail    *struct {
			WhenMatches string `yaml:"when_matches"`
			Render      string `yaml:"render"`
			Otherwise   string `yaml:"otherwise"`
		} `yaml:"detail"`
	} `yaml:"reasoning"`
	ReasonCodes struct {
		Source string `yaml:"source"`
		Wrap   string `yaml:"wrap"`
	} `yaml:"reason_codes"`
	PolicyReferences struct {
		RuleID struct {
			Source string `yaml:"source"`
		} `yaml:"rule_id"`
		PolicyID struct {
			Literal string `yaml:"literal"`
		} `yaml:"policy_id"`
	} `yaml:"policy_references"`
	AskDetails struct {
		Approver struct {
			ByReason map[string]mappedApprover `yaml:"by_reason"`
		} `yaml:"approver"`
	} `yaml:"ask_details"`
}

// mappedApprover is an approver ask-details.json admits, as the mapping
// names it for one escalate reason.
type mappedApprover struct {
	Type     acs.ApproverType `yaml:"type"`
	ID       string           `yaml:"id"`
	Endpoint *string          `yaml:"endpoint"`
	Auth     *struct {
		Method *string `yaml:"method"`
	} `yaml:"auth"`
}

// approver is the ACS approver; each call returns fresh pointers, so no
// decision shares memory with the mapping.
func (a mappedApprover) approver() acs.Approver {
	out := acs.Approver{Type: a.Type, ID: a.ID}
	if a.Endpoint != nil {
		endpoint := *a.Endpoint
		out.Endpoint = &endpoint
	}
	if a.Auth != nil {
		out.Auth = &acs.ApproverAuth{}
		if a.Auth.Method != nil {
			method := *a.Auth.Method
			out.Auth.Method = &method
		}
	}
	return out
}

var verdictFields = []string{"verdict.decision", "verdict.reason", "verdict.message", "verdict.transform", "verdict.result_labels"}

// parseMapping reads mapping.yaml and checks every rule the translation
// reads, so a broken table stops the Guardian at start rather than denying
// at the first step that reaches it.
func parseMapping(src []byte) (*mapping, error) {
	dec := yaml.NewDecoder(bytes.NewReader(src))
	dec.KnownFields(true)
	var m mapping
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("mapping.yaml: %w", err)
	}
	fs := m.FieldSynthesis
	for _, source := range []string{fs.Reasoning.Source, fs.ReasonCodes.Source, fs.PolicyReferences.RuleID.Source} {
		if !slices.Contains(verdictFields, source) {
			return nil, fmt.Errorf("mapping.yaml: field_synthesis reads %q, which is not a verdict field", source)
		}
	}
	if len(fs.AskDetails.Approver.ByReason) > 0 {
		schemas, err := schema.Load()
		if err != nil {
			return nil, err
		}
		for reason, a := range fs.AskDetails.Approver.ByReason {
			wire, err := jsonv2.Marshal(a.approver())
			if err != nil {
				return nil, err
			}
			if err := schemas.ValidateJSON(schema.AskApprover, wire); err != nil {
				return nil, fmt.Errorf("mapping.yaml: field_synthesis.ask_details.approver.by_reason.%s is not an ask-details.json approver: %w", reason, err)
			}
			if strings.TrimSpace(a.ID) == "" {
				return nil, fmt.Errorf("mapping.yaml: field_synthesis.ask_details.approver.by_reason.%s has no id", reason)
			}
		}
	}
	if fs.ReasonCodes.Wrap != "array" {
		return nil, fmt.Errorf("mapping.yaml: field_synthesis.reason_codes.wrap is %q; only array is expressible", fs.ReasonCodes.Wrap)
	}
	if d := fs.Reasoning.Detail; d != nil {
		re, err := regexp.Compile(d.WhenMatches)
		if err != nil {
			return nil, fmt.Errorf("mapping.yaml: field_synthesis.reasoning.detail.when_matches: %w", err)
		}
		m.detail = re
	}
	for name, rule := range m.Verdicts {
		switch rule.Decision {
		case acs.Allow, acs.Deny, acs.Modify, acs.Ask, acs.Defer:
		default:
			return nil, fmt.Errorf("mapping.yaml: verdict %s maps to %q, which is not an ACS disposition", name, rule.Decision)
		}
	}
	methods := map[string]string{}
	for point, row := range m.InterventionPoints {
		if table := row.PolicyTargetArgument; table != nil {
			for tool, named := range table.ByTool {
				if named != nil && strings.TrimSpace(*named) == "" {
					return nil, fmt.Errorf("mapping.yaml: intervention_points.%s.policy_target_argument.by_tool.%s is empty; write null for a tool that takes no argument", point, tool)
				}
			}
			if v := table.Default.value; v != nil && strings.TrimSpace(*v) == "" {
				return nil, fmt.Errorf("mapping.yaml: intervention_points.%s.policy_target_argument.default is empty; write null for tools that take no argument", point)
			}
		}
		if row.ACSMethod != nil {
			if other, dup := methods[*row.ACSMethod]; dup {
				return nil, fmt.Errorf("mapping.yaml: %s maps to both %s and %s", *row.ACSMethod, other, point)
			}
			methods[*row.ACSMethod] = point
		}
		if r := row.Modifications; r != nil {
			if !slices.Contains(verdictFields, r.From) || (r.Into != "parameter_overrides" && r.Into != "redactions") {
				return nil, fmt.Errorf("mapping.yaml: intervention_points.%s.modifications is not expressible", point)
			}
		}
	}
	return &m, nil
}

// point returns the AGT intervention point an ACS method maps to.
func (m *mapping) point(method string) (string, bool) {
	for point, row := range m.InterventionPoints {
		if row.ACSMethod != nil && *row.ACSMethod == method {
			return point, true
		}
	}
	return "", false
}

// policyTargetArgument is the tool argument a point's policy target is read
// from and an override is written to. It is empty only for a tool the mapping
// names explicitly as taking none (`by_tool: {tool: null}`, or `default:
// null` for every tool by_tool does not name); the manifest's own
// policy_target then decides what AGT reads. A tool the mapping names no
// argument for, by name or by default, is refused, as the TypeScript
// Guardian refuses it (assemble-snapshot.ts, map-verdict.ts).
func (m *mapping) policyTargetArgument(point, tool string) (string, error) {
	table := m.InterventionPoints[point].PolicyTargetArgument
	if table == nil {
		return "", fmt.Errorf("mapping.yaml declares no policy_target_argument for %s, so tool %q's policy target has no argument to be read from", point, tool)
	}
	if named, ok := table.ByTool[tool]; ok {
		if named == nil {
			return "", nil
		}
		return *named, nil
	}
	if !table.Default.set {
		return "", fmt.Errorf("mapping.yaml's intervention_points.%s.policy_target_argument names no argument for tool %q and declares no default", point, tool)
	}
	if table.Default.value == nil {
		return "", nil
	}
	return *table.Default.value, nil
}

// approver is the approver the mapping names for an Ask's reason, the first
// reason code, which field_synthesis.reason_codes reads from the verdict.
func (m *mapping) approver(reasonCodes []string) (acs.Approver, bool) {
	if len(reasonCodes) == 0 {
		return acs.Approver{}, false
	}
	a, ok := m.FieldSynthesis.AskDetails.Approver.ByReason[reasonCodes[0]]
	return a.approver(), ok
}

// approverTypes are the approver types the mapping can route an Ask to, the
// Guardian's approver_types_supported.
func (m *mapping) approverTypes() []acs.ApproverType {
	var types []acs.ApproverType
	for _, a := range m.FieldSynthesis.AskDetails.Approver.ByReason {
		if !slices.Contains(types, a.Type) {
			types = append(types, a.Type)
		}
	}
	slices.Sort(types)
	return types
}

// decision translates a verdict at a point, as mapVerdict does.
func (m *mapping) decision(v Verdict, point, argument string) (acs.Decision, error) {
	rule, ok := m.Verdicts[v.Decision]
	if !ok {
		return acs.Decision{}, fmt.Errorf("mapping.yaml has no verdict rule for AGT decision %q", v.Decision)
	}
	fs := m.FieldSynthesis
	d := acs.Decision{Disposition: rule.Decision}
	ruleID := v.field(fs.PolicyReferences.RuleID.Source)
	if reasoning := m.reasoning(ruleID, v.field(fs.Reasoning.Source), fs.PolicyReferences.PolicyID.Literal, point); reasoning != nil {
		d.Reasoning = *reasoning
	}
	if code := v.field(fs.ReasonCodes.Source); code != nil {
		d.ReasonCodes = []string{*code}
	}
	if ruleID != nil {
		d.PolicyReferences = []acs.PolicyReference{{PolicyID: fs.PolicyReferences.PolicyID.Literal, RuleID: *ruleID}}
	}
	if rule.RequirePolicyReferences && len(d.PolicyReferences) == 0 {
		return acs.Decision{}, fmt.Errorf("mapping.yaml declares require_policy_references for AGT decision %q, but no policy_references could be synthesized (verdict.reason was empty)", v.Decision)
	}
	if rule.Decision == acs.Modify {
		mods, err := m.modifications(v, point, argument)
		if err != nil {
			return acs.Decision{}, err
		}
		d.Modifications = mods
	}
	return d, nil
}

// field reads a string verdict field a mapping source names. An empty string
// is absent: response-envelope.json requires a non-empty rule_id, and Trace
// reads "" in its policy arrays as absent.
func (v Verdict) field(source string) *string {
	var value *string
	switch source {
	case "verdict.reason":
		value = v.Reason
	case "verdict.message":
		value = v.Message
	case "verdict.decision":
		value = &v.Decision
	}
	if value == nil || *value == "" {
		return nil
	}
	return value
}

// reasoning is composeReasoning: the template filled in order, each
// placeholder replaced across the text the previous ones produced.
func (m *mapping) reasoning(ruleID, message *string, policyID, point string) *string {
	rule := m.FieldSynthesis.Reasoning
	if rule.Template == nil {
		return message
	}
	if ruleID == nil {
		return nil
	}
	detail := ""
	if rule.Detail != nil && message != nil {
		if hit := m.detail.FindStringSubmatch(*message); hit != nil {
			group := ""
			if len(hit) > 1 {
				group = hit[1]
			}
			detail = strings.ReplaceAll(rule.Detail.Render, "{1}", group)
		} else {
			detail = strings.ReplaceAll(rule.Detail.Otherwise, "{message}", *message)
		}
	}
	out := *rule.Template
	out = strings.ReplaceAll(out, "{summary}", m.summary(*ruleID, point))
	out = strings.ReplaceAll(out, "{rule_id}", *ruleID)
	out = strings.ReplaceAll(out, "{policy_id}", policyID)
	out = strings.ReplaceAll(out, "{detail}", detail)
	return &out
}

func (m *mapping) summary(ruleID, point string) string {
	summaries := m.FieldSynthesis.Reasoning.Summaries
	switch entry := summaries[ruleID].(type) {
	case string:
		return entry
	case map[string]any:
		if perPoint, ok := entry[point].(string); ok {
			return perPoint
		}
	}
	fallback, _ := summaries["default"].(string)
	return fallback
}

var errModificationUnexpressible = errors.New("the rewrite cannot be expressed as an ACS modification")

// modifications is synthesizeModifications.
func (m *mapping) modifications(v Verdict, point, argument string) (*acs.Modifications, error) {
	rule := m.InterventionPoints[point].Modifications
	if rule == nil {
		return nil, fmt.Errorf("%w: mapping.yaml maps AGT decision %q to ACS modify, but its intervention_points row for %q declares no modifications rule", errModificationUnexpressible, v.Decision, point)
	}
	if v.Transform == nil {
		return nil, fmt.Errorf("%w: %s is absent", errModificationUnexpressible, rule.From)
	}
	if v.Transform.Path != rule.WhenPath {
		return nil, fmt.Errorf("%w: mapping.yaml can express a transform of %q only, but the verdict rewrote %q", errModificationUnexpressible, rule.WhenPath, v.Transform.Path)
	}
	value, err := jsonv2.Marshal(v.Transform.Value)
	if err != nil {
		return nil, err
	}
	switch rule.Into {
	case "parameter_overrides":
		if argument == "" {
			return nil, fmt.Errorf("%w: intervention point %q declares no policy_target_argument for the override to land on", errModificationUnexpressible, point)
		}
		return &acs.Modifications{ParameterOverrides: map[string]json.RawMessage{argument: value}}, nil
	default:
		replacement, ok := v.Transform.Value.(string)
		if !ok {
			return nil, fmt.Errorf("%w: a redaction's replacement is a string, and %s.value is not", errModificationUnexpressible, rule.From)
		}
		return &acs.Modifications{Redactions: []acs.Redaction{{Path: rule.IntoPath, Replacement: &replacement}}}, nil
	}
}
