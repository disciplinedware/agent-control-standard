package agtbridge

import "context"

// The intervention points whose snapshot this bridge assembles: the two tool
// points the TypeScript reference assembles, and output, the agent's reply.
const (
	PointPreToolCall  = "pre_tool_call"
	PointPostToolCall = "post_tool_call"
	PointOutput       = "output"
)

// AssemblesSnapshot reports whether this bridge assembles the snapshot of an
// intervention point.
func AssemblesSnapshot(point string) bool {
	return point == PointPreToolCall || point == PointPostToolCall || point == PointOutput
}

// Evaluator executes AGT's policy for the projection. One exists: the AGT
// evaluator, which calls AGT's own runtime library (package agteval, build
// tag agteval).
type Evaluator interface {
	// Governs reports whether the manifest configures the intervention
	// point.
	Governs(point string) bool

	// Evaluate is AGT's evaluate_intervention_point in enforce mode for a
	// snapshot this bridge assembled. A failure inside AGT's evaluation is
	// a fail-closed deny verdict, never an error. An error means the
	// evaluation could not run, or ctx ended before it returned; the
	// Guardian answers either as an engine failure.
	Evaluate(ctx context.Context, point string, snapshot map[string]any) (Verdict, error)

	// AGTVersion is the AGT commit whose runtime the evaluator executes.
	AGTVersion() string
}

// Verdict is AGT's verdict (policy-engine/core/src/verdict.rs) as its C ABI
// serializes it. AGT omits an empty result_labels, so ResultLabels is
// either absent or non-empty; evidence is not carried onto the wire, as the
// TypeScript reference does not carry it.
type Verdict struct {
	Decision     string     `json:"decision"`
	Reason       *string    `json:"reason,omitempty"`
	Message      *string    `json:"message,omitempty"`
	Transform    *Transform `json:"transform,omitempty"`
	ResultLabels []string   `json:"result_labels,omitempty"`
}

// Transform is a transform verdict's single replacement inside the policy
// target.
type Transform struct {
	Path  string `json:"path"`
	Value any    `json:"value"`
}
