package agtbridge_test

import (
	"context"
	"os"
	"testing"

	"github.com/GenAI-Security-Project/agent-control-standard/reference-implementations/agt-go/acs"
	"github.com/GenAI-Security-Project/agent-control-standard/reference-implementations/agt-go/agtbridge"
)

// A host that sends the session, activation and turn steps must not have its
// runs blocked by a Guardian whose mapping routes none of them to a policy:
// a step the mapping does not cover is allowed, on every evaluator, for the
// stock deployment and for one with its own manifest.
func TestStepsTheMappingDoesNotCoverAreAllowed(t *testing.T) {
	steps := map[string]any{
		acs.StepSessionStart: map[string]any{
			"user_identity":    map[string]any{"user_id": "+15550100", "authentication_method": "telegram"},
			"platform_context": map[string]any{"channel": "telegram"},
		},
		acs.StepAgentTrigger: map[string]any{"trigger_type": "user_message", "trigger_source": map[string]any{"channel": "telegram"}},
		acs.StepTurnStart:    map[string]any{"turn_id": "run-1", "triggered_by": "user_message"},
		acs.StepTurnEnd:      map[string]any{"turn_id": "run-1", "outcome": "completed", "tool_call_count": 1},
		acs.StepSessionEnd:   map[string]any{"reason": "completed"},
	}
	deployments := map[string]string{"stock": agtTree, "own_manifest": senderAndReplyDeployment(t)}
	for deploymentName, dir := range deployments {
		for evaluatorName, build := range deploymentEvaluators {
			engine, err := agtbridge.New(os.DirFS(dir), "mapping.yaml", build(t, dir), agtbridge.Options{})
			if err != nil {
				t.Fatalf("%s/%s: %v", deploymentName, evaluatorName, err)
			}
			for method, payload := range steps {
				t.Run(deploymentName+"/"+evaluatorName+"/"+method, func(t *testing.T) {
					d, err := engine.Decide(context.Background(), input(t, method, payload))
					if err != nil {
						t.Fatal(err)
					}
					if d.Disposition != acs.Allow {
						t.Fatalf("got %+v", d.Decision)
					}
				})
			}
		}
	}
}
